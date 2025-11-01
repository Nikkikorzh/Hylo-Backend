import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pRetry from 'p-retry';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// === URLs ===
const EXPONENT_XSOL_1 = 'https://www.exponent.finance/liquidity/xsol-26Nov25-1';
const EXPONENT_XSOL_2 = 'https://www.exponent.finance/liquidity/xsol-26Nov25';
const EXPONENT_HYUSD = 'https://www.exponent.finance/liquidity/hyusd-15Dec25';
const EXPONENT_HYLOSOL_PLUS = 'https://www.exponent.finance/liquidity/hylosolplus-15Dec25';
const EXPONENT_HYLOSOL = 'https://www.exponent.finance/liquidity/hylosol-10Dec25';
const EXPONENT_SHYUSD = 'https://www.exponent.finance/liquidity/shyusd-18Nov25';

const RATEX_XSOL = 'https://app.rate-x.io/points?symbol=xSOL-2511';
const RATEX_HYUSD = 'https://app.rate-x.io/points?symbol=hyUSD-2601';
const RATEX_HYLOSOL_PLUS = 'https://app.rate-x.io/points?symbol=hyloSOL%252B-2511';
const RATEX_HYLOSOL = 'https://app.rate-x.io/points?symbol=hyloSOL-2511';
const RATEX_SHYUSD = 'https://app.rate-x.io/points?symbol=sHYUSD-2601';

// === Caching ===
let cache = { ts: 0, data: null };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === fetchApys (универсальная) ===
async function fetchApys(url, siteKey, tokenHint, isRateX = false) {
  const timeout = setTimeout(() => { throw new Error('Timeout'); }, isRateX ? 60000 : 45000);
  try {
    return await pRetry(
      async () => {
        const browser = isRateX 
          ? await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: chromium.headless })
          : await getSharedBrowser();
        const page = await browser.newPage();

        // Анти-детект
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
          window.chrome = { runtime: {} };
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

        if (isRateX) {
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,*/*'
          });
        }

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        if (!isRateX) {
          // Закрываем модалку
          await page.evaluate(() => {
            document.querySelectorAll('button[aria-label*="close" i], button svg, [role="dialog"] button').forEach(b => b.click());
          });
          await sleep(1500);
          await page.waitForFunction(() => document.body.innerText.includes('Total APY'), { timeout: 10000 }).catch(() => {});
        } else {
          await page.waitForFunction(() => document.body.innerText.includes('Fixed APY'), { timeout: 20000 }).catch(() => {});
          await sleep(2000);
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
        if (isRateX) await browser.close();

        clearTimeout(timeout);
        console.log(`${isRateX ? 'RateX' : 'Exponent'} ${siteKey}:`, data);
        return { ok: true, data };
      },
      { retries: 1 }
    );
  } catch (err) {
    clearTimeout(timeout);
    console.error(`${isRateX ? 'RateX' : 'Exponent'} ${siteKey} failed:`, err.message);
    return { ok: false };
  }
}

// === /api/apy ===
// === /api/apy (RateX ПЕРВЫМ!) ===
app.get('/api/apy', async (req, res) => {
  const globalTimeout = setTimeout(() => res.status(504).json({ ok: false, error: 'Timeout' }), 300000);
  try {
    const now = Date.now();
    const force = req.query.force === '1';

    if (!force && cache.data && now - cache.ts < CACHE_TTL_MS) {
      clearTimeout(globalTimeout);
      return res.json({ ok: true, source: 'cache', data: cache.data });
    }

    const results = {};

    // === 1. RATEX ПЕРВЫМ (параллельно) ===
    console.log('Starting RateX (first)...');
    const ratexResults = await Promise.allSettled([
      fetchApys(RATEX_XSOL, 'ratex-xsol', 'xSOL', true),
      fetchApys(RATEX_HYUSD, 'ratex-hyusd', 'hyUSD', true),
      fetchApys(RATEX_HYLOSOL_PLUS, 'ratex-hylosolplus', 'hyloSOL+', true),
      fetchApys(RATEX_HYLOSOL, 'ratex-hylosol', 'hyloSOL', true),
      fetchApys(RATEX_SHYUSD, 'ratex-shyusd', 'sHYUSD', true)
    ]);

    ratexResults.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value.ok) {
        const key = ['ratex-xsol', 'ratex-hyusd', 'ratex-hylosolplus', 'ratex-hylosol', 'ratex-shyusd'][i];
        results[key] = { pt: res.value.data.pt, base: res.value.data.base };
      }
    });

    // === 2. Exponent ПОСЛЕ (последовательно) ===
    console.log('Starting Exponent (after RateX)...');
    for (const [key, url] of Object.entries(EXPONENT_URLS)) {
      const data = await fetchApys(url, key, null, false);
      if (data.ok) {
        results[key] = { apy: data.data.apy };
      }
    }

    // === Ответ ===
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
      partial: false
    };

    cache = { ts: now, data };
    clearTimeout(globalTimeout);
    res.json({ ok: true, source: 'live', data });
  } catch (e) {
    clearTimeout(globalTimeout);
    console.error('API error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// === /health ===
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on ${PORT}`));
