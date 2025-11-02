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

// ==================== REDIS ====================
const redisClient = createClient({
  url: process.env.REDIS_URL // redis://red-xxx.onrender.com:6379
});

redisClient.on('error', (err) => console.error('Redis error:', err));

(async () => {
  try {
    await redisClient.connect();
    console.log('Redis connected successfully');
  } catch (err) {
    console.error('Redis connection failed:', err);
  }
})();

// ==================== URLS ====================
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

// ==================== PUPPETEER ====================
let sharedBrowser = null;
let isLaunching = false;

async function getSharedBrowser() {
  if (sharedBrowser) return sharedBrowser;
  if (isLaunching) {
    while (!sharedBrowser) await new Promise(r => setTimeout(r, 100));
    return sharedBrowser;
  }
  isLaunching = true;
  console.log('Puppeteer browser launching...');
  try {
    sharedBrowser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('Puppeteer browser launched');
  } catch (err) {
    console.error('Failed to launch browser:', err);
    throw err;
  } finally {
    isLaunching = false;
  }
  return sharedBrowser;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ==================== ПАРСИНГ ====================
async function fetchApys(url, siteKey, tokenHint, isRateX = false) {
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

      if (!isRateX) {
        await page.evaluate(() => {
          document.querySelectorAll('button[aria-label*="close" i], button svg, [role="dialog"] button')
            .forEach(b => b.click());
        });
        await sleep(1500);
        await page.waitForFunction(() => document.body.innerText.includes('Total APY'), { timeout: 15000 }).catch(() => {});
      } else {
        await page.waitForFunction(() => document.body.innerText.includes('Fixed APY'), { timeout: 30000 }).catch(() => {});
        await sleep(3000);
      }

      const data = await page.evaluate((isRateX, hint) => {
        const text = document.body.innerText;
        const extract = regex => (text.match(regex) || [])[1]?.replace(/,/g, '');

        if (isRateX) {
          const pt = extract(/Fixed APY[^0-9]*([\d.]+)%/i);
          const base = extract(/Total Combined APY[^0-9]*([\d.]+)%/i) || extract(/Variable APY[^0-9]*([\d.]+)%/i);
          return { pt: pt ? parseFloat(pt) : null, base: base ? parseFloat(base) : null };
        }
        const apy = extract(/Total APY[^0-9]*([\d.]+)%/i);
        return { apy: apy ? parseFloat(apy) : null };
      }, isRateX, tokenHint);

      await page.close();
      clearTimeout(timeout);
      console.log(`${isRateX ? 'RateX' : 'Exponent'} ${siteKey}:`, data);
      return { ok: true, data };
    }, { retries: 1 });
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`${isRateX ? 'RateX' : 'Exponent'} ${siteKey} error:`, err.message);
    return { ok: false };
  }
}

// ==================== КАЛЬКУЛЯТОР ====================
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

// ==================== /api/apy ====================
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

    // === ПАРСИНГ ===
    const results = {};

    console.log('Starting RateX parsing...');
    for (const [key, url] of Object.entries(RATEX_URLS)) {
      const hint = key.split('-')[1].toUpperCase().replace('SHYUSD', 'sHYUSD');
      const data = await fetchApys(url, key, hint, true);
      results[key] = data.ok ? { pt: data.data.pt, base: data.data.base } : { pt: null, base: null };
    }

    console.log('Starting Exponent parsing...');
    for (const [key, url] of Object.entries(EXPONENT_URLS)) {
      const data = await fetchApys(url, key, null, false);
      results[key] = data.ok ? { apy: data.data.apy } : { apy: null };
    }

    // === ФОРМИРУЕМ ОТВЕТ ===
    const get = (obj, key) => obj?.[key] ?? null;
    const data = {
      exponent_xSOL_1: get(results['exponent-xsol-1'], 'apy'),
      exponent_PT_xSOL_1: get(results['exponent-xsol-1'], 'apy'),
      exponent_xSOL_2: get(results['exponent-xsol-2'], 'apy'),
      exponent_PT_xSOL_2: get(results['exponent-xsol-2'], 'apy'),
      exponent_hyUSD: get(results['exponent-hyusd'], 'apy'),
      exponent_PT_hyUSD: get(results['exponent-hyusd'], 'apy'),
      exponent_hylosolplus: get(results['exponent-hylosolplus'], 'apy'),
      exponent_hylosol: get(results['exponent-hylosol'], 'apy'),
      exponent_sHYUSD: get(results['exponent-shyusd'], 'apy'),

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

      fetched_at: new Date().toISOString(),
      partial: true
    };

    // === СОХРАНЯЕМ В REDIS НА 10 МИНУТ ===
    await redisClient.setEx('apy_cache', 900, JSON.stringify(data));
    console.log('Data saved to Redis cache for 15 minutes');

    clearTimeout(globalTimeout);
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=120');
    res.json({ ok: true, source: 'live', data });
  } catch (e) {
    clearTimeout(globalTimeout);
    console.error('API error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ==================== АВТО-ОБНОВЛЕНИЕ КАЖДЫЕ 10 МИНУТ ====================
setInterval(async () => {
  console.log('Auto-refresh cache triggered (15 minutes)...');
  try {
    // Дёргаем свой API с force=1
    await fetch(`http://localhost:${process.env.PORT || 10000}/api/apy?force=1`);
    console.log('Auto-refresh completed successfully (next 15 minutes)');
  } catch (e) {
    console.error('Auto-refresh failed:', e.message);
  }
}, 15 * 60 * 1000); // каждые 10 минут

// ==================== HEALTH ====================
app.get('/health', (req, res) => res.json({ ok: true }));

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Visit: https://hylo-apy-simulator.onrender.com`);
});
