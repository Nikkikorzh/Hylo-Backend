import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pRetry from 'p-retry';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { createClient } from 'redis';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// === Redis ===
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis error:', err));
(async () => { await redisClient.connect(); console.log('Redis connected'); })();

// === URLs ===
const EXPONENT_URLS = {
  'exponent-xsol-1': 'https://www.exponent.finance/liquidity/xsol-26Nov25-1',
  'exponent-xsol-2': 'https://www.exponent.finance/liquidity/xsol-26Nov25',
  'exponent-hyusd': 'https://www.exponent.finance/liquidity/hyusd-15Dec25',
  'exponent-hylosolplus': 'https://www.exponent.finance/liquidity/hylosolplus-15Dec25',
  'exponent-hylosol': 'https://www.exponent.finance/liquidity/hylosol-10Dec25',
  'exponent-shyusd': 'https://www.exponent.finance/liquidity/shyusd-18Nov25',
};

const RATEX_URLS = {
  'ratex-xsol': 'https://app.rate-x.io/points?symbol=xSOL-2511',
  'ratex-hyusd': 'https://app.rate-x.io/points?symbol=hyUSD-2601',
  'ratex-hylosolplus': 'https://app.rate-x.io/points?symbol=hyloSOL%252B-2511',
  'ratex-hylosol': 'https://app.rate-x.io/points?symbol=hyloSOL-2511',
  'ratex-shyusd': 'https://app.rate-x.io/points?symbol=sHYUSD-2601',
};

const LOOPSCALE_VAULTS = {
  'loopscale-hyusd-one': 'https://app.loopscale.com/vault/hyusd_one',
  'loopscale-xsol-one': 'https://app.loopscale.com/vault/xsol_one',
};

const LOOPSCALE_LOOPS = {
  'loopscale-hyusd-15dec25': 'https://app.loopscale.com/loops/hyusd-15dec25-hyusd',
  'loopscale-shyusd-18nov25': 'https://app.loopscale.com/loops/shyusd-18nov25-hyusd',
  'loopscale-shyusd-hyusd': 'https://app.loopscale.com/loops/shyusd-hyusd',
  'loopscale-shyusd-2601': 'https://app.loopscale.com/loops/shyusd-2601-hyusd',
};

// === Shared Browser ===
let sharedBrowser = null;
let isLaunching = false;

async function getSharedBrowser() {
  if (sharedBrowser) return sharedBrowser;
  if (isLaunching) {
    while (!sharedBrowser) await new Promise(r => setTimeout(r, 100));
    return sharedBrowser;
  }
  isLaunching = true;
  console.log('Puppeteer launching...');
  try {
    sharedBrowser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('Puppeteer launched');
  } catch (e) { console.error('Puppeteer error:', e); throw e; }
  finally { isLaunching = false; }
  return sharedBrowser;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Парсинг (безопасный) ===
async function fetchApys(url, siteKey, tokenHint, isRateX = false, isLoopscale = false) {
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; }, isRateX ? 90000 : 60000);

  try {
    return await pRetry(async () => {
      if (timedOut) throw new Error('Timeout');
      const browser = await getSharedBrowser();
      const page = await browser.newPage();

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        window.chrome = { runtime: {} };
      });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

      if (!isRateX && !isLoopscale) {
        await page.evaluate(() => {
          document.querySelectorAll('button[aria-label*="close" i], button svg, [role="dialog"] button')
            .forEach(b => b.click());
        });
        await sleep(1500);
        await page.waitForFunction(() => document.body.innerText.includes('Total APY'), { timeout: 15000 }).catch(() => {});
      } else if (isRateX) {
        await page.waitForFunction(() => document.body.innerText.includes('Fixed APY'), { timeout: 30000 }).catch(() => {});
        await sleep(3000);
      } else if (isLoopscale) {
        await page.waitForFunction(() => document.body.innerText.includes('APY'), { timeout: 30000 }).catch(() => {});
        await sleep(2000);
      }

      const data = await page.evaluate((isRateX, isLoopscale, hint) => {
        const text = document.body.innerText;
        const extract = regex => (text.match(regex) || [])[1]?.replace(/,/g, '');

        if (isRateX) {
          const pt = extract(/Fixed APY[^0-9]*([\d.]+)%/i);
          const base = extract(/Total Combined APY[^0-9]*([\d.]+)%/i) || extract(/Variable APY[^0-9]*([\d.]+)%/i);
          return { pt: pt ? parseFloat(pt) : null, base: base ? parseFloat(base) : null };
        } else if (isLoopscale) {
          const apy = extract(/APY[^0-9]*([\d.]+)%/i);
          const tvl = extract(/\$[\d,]+\.?\d*[^<]*$/i);
          return { apy: apy ? parseFloat(apy) : null, tvl: tvl ? parseFloat(tvl.replace(/[^\d.]/g, '')) : null };
        }

        const apy = extract(/Total APY[^0-9]*([\d.]+)%/i);
        return { apy: apy ? parseFloat(apy) : null };
      }, isRateX, isLoopscale, tokenHint);

      await page.close();
      clearTimeout(timeout);
      console.log(`${isRateX ? 'RateX' : isLoopscale ? 'Loopscale' : 'Exponent'} ${siteKey}:`, data);
      return { ok: true, data };
    }, { retries: 1 });
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`${isRateX ? 'RateX' : isLoopscale ? 'Loopscale' : 'Exponent'} ${siteKey} error:`, err.message);
    return { ok: false };
  }
}

// === Калькулятор ===
app.post('/api/calc', (req, res) => {
  try {
    const { principal, rate, rateType = 'APY', days, compoundingPerYear = 365 } = req.body;
    const P = Number(principal);
    const r = Number(rate) / 100;
    const d = Number(days);
    const n = Number(compoundingPerYear);

    if (!P || !r || !d) return res.status(400).json({ ok: false, error: 'principal, rate, days required' });

    let final = rateType.toUpperCase() === 'APY'
      ? P * Math.pow(1 + r, d / 365)
      : P * Math.pow(1 + Math.pow(1 + r / n, n) - 1, d / 365);

    const profit = final - P;

    res.json({
      ok: true,
      principal: P,
      final: final.toFixed(2),
      profit: profit.toFixed(2),
      days: d,
      rateType,
    });
  } catch (e) {
    console.error('Calc error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// === /api/apy ===
app.get('/api/apy', async (req, res) => {
  const globalTimeout = setTimeout(() => res.status(504).json({ ok: false, error: 'Global timeout' }), 600000);
  try {
    const force = req.query.force === '1';
    console.log('API /apy called, force:', force);

    // === КЭШ ===
    if (!force) {
      console.log('Checking Redis cache...');
      const cached = await redisClient.get('apy_cache');
      if (cached) {
        console.log('Cache HIT! Returning from Redis');
        clearTimeout(globalTimeout);
        return res.json({ ok: true, source: 'redis', data: JSON.parse(cached) });
      }
      console.log('Cache MISS! Fetching live...');
    } else {
      console.log('Force refresh — skipping cache');
    }

    const results = {};

    // === RateX ===
    console.log('Starting RateX parsing...');
    for (const [key, url] of Object.entries(RATEX_URLS)) {
      const hint = key.split('-')[1].toUpperCase().replace('SHYUSD', 'sHYUSD');
      const data = await fetchApys(url, key, hint, true);
      results[key] = data.ok ? { pt: data.data.pt, base: data.data.base } : { pt: null, base: null };
    }

    // === Exponent ===
    console.log('Starting Exponent parsing...');
    for (const [key, url] of Object.entries(EXPONENT_URLS)) {
      const data = await fetchApys(url, key, null, false);
      results[key] = data.ok ? { apy: data.data.apy } : { apy: null };
    }

    // === Loopscale ===
    console.log('Starting Loopscale parsing...');
    for (const [key, url] of Object.entries(LOOPSCALE_VAULTS)) {
      const data = await fetchApys(url, key, null, false, true);
      results[key] = data.ok ? { apy: data.data.apy, tvl: data.data.tvl } : { apy: null, tvl: null };
    }
    for (const [key, url] of Object.entries(LOOPSCALE_LOOPS)) {
      const data = await fetchApys(url, key, null, false, true);
      results[key] = data.ok ? { apy: data.data.apy, tvl: data.data.tvl } : { apy: null, tvl: null };
    }

    // === ОТВЕТ ===
    const get = (obj, key) => obj?.[key] ?? null;
    const data = {
      // Exponent
      exponent_xSOL_1: get(results['exponent-xsol-1'], 'apy'),
      exponent_PT_xSOL_1: get(results['exponent-xsol-1'], 'apy'),
      exponent_xSOL_2: get(results['exponent-xsol-2'], 'apy'),
      exponent_PT_xSOL_2: get(results['exponent-xsol-2'], 'apy'),
      exponent_hyUSD: get(results['exponent-hyusd'], 'apy'),
      exponent_PT_hyUSD: get(results['exponent-hyusd'], 'apy'),
      exponent_hylosolplus: get(results['exponent-hylosolplus'], 'apy'),
      exponent_hylosol: get(results['exponent-hylosol'], 'apy'),
      exponent_sHYUSD: get(results['exponent-shyusd'], 'apy'),

      // RateX
      ratex_xSOL: get(results['ratex-xsol'], 'base'),
      ratex_PT_xSOL: get(results['ratex-xsol'], 'pt'),
      ratex_hyUSD: get(results['ratex-hyusd'], 'base'),
      ratex_PT_hyUSD: get(results['ratex-hyusd'], 'pt'),
      ratex_hylosolplus: get(results['ratex-hylosolplus'], 'base'),
      ratex_PT_hylosolplus: get(results['ratex-hylosolplus'], 'pt'),
      ratex_hylosol: get(results['ratex-hylosol'], 'base'),
      ratex_PT_hylosol: get(results['ratex-hylosol'], 'pt'),
      ratex_sHYUSD: get(results['ratex-shyusd'], 'base'),
      ratex_PT_sHYUSD: get(results['ratex-shyusd'], 'pt'),

      // Loopscale
      loopscale_hyusd_one: get(results['loopscale-hyusd-one'], 'apy'),
      loopscale_xsOL_one: get(results['loopscale-xsol-one'], 'apy'),
      loopscale_hyusd_15dec25: get(results['loopscale-hyusd-15dec25'], 'apy'),
      loopscale_shYUSD_18nov25: get(results['loopscale-shyusd-18nov25'], 'apy'),
      loopscale_shYUSD_hyusd: get(results['loopscale-shyusd-hyusd'], 'apy'),
      loopscale_shYUSD_2601: get(results['loopscale-shyusd-2601'], 'apy'),

      fetched_at: new Date().toISOString(),
      partial: true
    };

    // === СОХРАНЯЕМ В REDIS НА 15 МИНУТ ===
    await redisClient.setEx('apy_cache', 900, JSON.stringify(data));
    console.log('Data saved to Redis cache for 15 minutes');

    clearTimeout(globalTimeout);
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=180');
    res.json({ ok: true, source: 'live', data });
  } catch (e) {
    clearTimeout(globalTimeout);
    console.error('API error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ==================== АВТО-ОБНОВЛЕНИЕ КАЖДЫЕ 15 МИНУТ ====================
setInterval(async () => {
  console.log('Auto-refresh (every 15 min) triggered...');
  try {
    await fetch(`http://localhost:${process.env.PORT || 10000}/api/apy?force=1`);
    console.log('Auto-refresh completed — data fresh for next 15 min');
  } catch (e) {
    console.error('Auto-refresh failed:', e.message);
  }
}, 15 * 60 * 1000); // 15 минут

// ==================== HEALTH ====================
app.get('/health', (req, res) => res.json({ ok: true }));

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Visit: https://hylo-apy-simulator.onrender.com`);
});
