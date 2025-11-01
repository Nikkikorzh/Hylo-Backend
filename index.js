import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pRetry from 'p-retry';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fetch from 'node-fetch';

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

// === Labels ===
const LABELS_EXPONENT = [
  'xSOL', 'PT-xSOL', 'hyUSD', 'PT-hyUSD', 'pt-hyusd',
  'hyloSOL+', 'PT-hyloSOL+', 'hylosolplus',
  'hyloSOL', 'PT-hyloSOL', 'hylosol',
  'sHYUSD', 'shyusd'
];

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

// === fetchApysFromPage (Exponent) ===
async function fetchExponentApys(url, siteKey, tokenHint) {
  const timeout = setTimeout(() => { throw new Error('Timeout'); }, 45000);
  try {
    return await pRetry(
      async () => {
        const browser = await getSharedBrowser();
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          window.chrome = { runtime: {} };
        });

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        // Закрываем модалку
        await page.evaluate(() => {
          document.querySelectorAll('button[aria-label*="close" i], button svg, [role="dialog"] button').forEach(b => b.click());
        });
        await sleep(1500);

        // Ждём APY
        await page.waitForFunction(() => document.body.innerText.includes('Total APY'), { timeout: 10000 }).catch(() => {});

        const found = await page.evaluate((labels, hint) => {
          const results = {};
          const extract = text => (text.match(/(-?[\d,]+(?:\.\d+)?)%/) || [])[1]?.replace(/,/g, '');
          const elements = Array.from(document.querySelectorAll('body *')).filter(el => el.innerText?.length < 1000);

          for (const el of elements) {
            const text = el.innerText;
            const lower = text.toLowerCase();
            for (const label of labels) {
              if (lower.includes(label.toLowerCase()) && !results[label]) {
                const p = extract(text) || extract(el.parentElement?.innerText);
                if (p) results[label] = { percent: parseFloat(p) };
              }
            }
          }
          return results;
        }, LABELS_EXPONENT, tokenHint);

        const map = {
          'xSOL': 'xSOL', 'PT-xSOL': 'PT-xSOL',
          'hyUSD': 'hyUSD', 'PT-hyUSD': 'PT-hyUSD',
          'sHYUSD': 'sHYUSD', 'shyusd': 'sHYUSD',
          'hyloSOL+': 'hyloSOL+', 'PT-hyloSOL+': 'PT-hyloSOL+',
          'hyloSOL': 'hyloSOL', 'PT-hyloSOL': 'PT-hyloSOL'
        };

        const normalized = { 'PT-xSOL': null, 'xSOL': null, 'PT-hyUSD': null, 'hyUSD': null, 'PT-sHYUSD': null, 'sHYUSD': null, 'PT-hyloSOL+': null, 'hyloSOL+': null, 'PT-hyloSOL': null, 'hyloSOL': null };
        for (const [k, v] of Object.entries(found)) {
          const m = map[k] || map[k.toLowerCase()];
          if (m && !normalized[m]) normalized[m] = v;
        }

        await page.close();
        clearTimeout(timeout);
        console.log(`Exponent ${siteKey}:`, normalized);
        return { ok: true, data: normalized };
      },
      { retries: 1 }
    );
  } catch (err) {
    clearTimeout(timeout);
    console.error(`Exponent ${siteKey} failed:`, err.message);
    return { ok: false };
  }
}

// === fetchRateXApy (RateX via fetch) ===
async function fetchRateXApy(url, hint) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*'
      }
    });
    const html = await res.text();

    const fixed = html.match(/Fixed APY[^>]*>[\s]*([\d.]+)%/i);
    const total = html.match(/Total Combined APY[^>]*>[\s]*([\d.]+)%/i) || html.match(/Variable APY[^>]*>[\s]*([\d.]+)%/i);

    const pt = fixed ? parseFloat(fixed[1]) : null;
    const base = total ? parseFloat(total[1]) : null;

    console.log(`RateX ${hint}: PT=${pt}%, Base=${base}%`);
    return {
      ok: true,
      data: {
        [`PT-${hint}`]: { percent: pt },
        [hint]: { percent: base }
      }
    };
  } catch (err) {
    console.error(`RateX ${hint} failed:`, err.message);
    return { ok: false };
  }
}

// === /api/apy ===
app.get('/api/apy', async (req, res) => {
  const globalTimeout = setTimeout(() => res.status(504).json({ ok: false, error: 'Timeout' }), 180000);
  try {
    const now = Date.now();
    const force = req.query.force === '1';

    if (!force && cache.data && now - cache.ts < CACHE_TTL_MS) {
      clearTimeout(globalTimeout);
      return res.json({ ok: true, source: 'cache', data: cache.data });
    }

    const results = {};

    // === Exponent (последовательно) ===
    const expTasks = [
      { key: 'exponent-xsol-1', url: EXPONENT_XSOL_1, hint: 'xSOL' },
      { key: 'exponent-xsol-2', url: EXPONENT_XSOL_2, hint: 'xSOL' },
      { key: 'exponent-hyusd', url: EXPONENT_HYUSD, hint: 'hyUSD' },
      { key: 'exponent-hylosolplus', url: EXPONENT_HYLOSOL_PLUS, hint: 'hyloSOL+' },
      { key: 'exponent-hylosol', url: EXPONENT_HYLOSOL, hint: 'hyloSOL' },
      { key: 'exponent-shyusd', url: EXPONENT_SHYUSD, hint: 'sHYUSD' },
    ];

    for (const task of expTasks) {
      const data = await Promise.race([
        fetchExponentApys(task.url, task.key, task.hint),
        new Promise((_, r) => setTimeout(() => r({ ok: false }), 45000))
      ]);
      results[task.key] = data.ok ? data.data : null;
    }

    // === RateX (параллельно, fetch) ===
    const ratexResults = await Promise.allSettled([
      fetchRateXApy(RATEX_XSOL, 'xSOL'),
      fetchRateXApy(RATEX_HYUSD, 'hyUSD'),
      fetchRateXApy(RATEX_HYLOSOL_PLUS, 'hyloSOL+'),
      fetchRateXApy(RATEX_HYLOSOL, 'hyloSOL'),
      fetchRateXApy(RATEX_SHYUSD, 'sHYUSD')
    ]);

    const ratexKeys = ['ratex-xsol', 'ratex-hyusd', 'ratex-hylosolplus', 'ratex-hylosol', 'ratex-shyusd'];
    ratexKeys.forEach((key, i) => {
      const res = ratexResults[i];
      results[key] = res.status === 'fulfilled' && res.value.ok ? res.value.data : null;
    });

    // === Ответ ===
    const get = (obj, key) => obj?.[key]?.percent ?? null;
    const data = {
      exponent_xSOL_1: get(results['exponent-xsol-1'], 'xSOL'),
      exponent_PT_xSOL_1: get(results['exponent-xsol-1'], 'PT-xSOL'),
      exponent_xSOL_2: get(results['exponent-xsol-2'], 'xSOL'),
      exponent_PT_xSOL_2: get(results['exponent-xsol-2'], 'PT-xSOL'),
      exponent_hyUSD: get(results['exponent-hyusd'], 'hyUSD'),
      exponent_PT_hyUSD: get(results['exponent-hyusd'], 'PT-hyUSD'),
      exponent_hylosolplus: get(results['exponent-hylosolplus'], 'PT-hyloSOL+'),
      exponent_hylosol: get(results['exponent-hylosol'], 'PT-hyloSOL'),
      exponent_sHYUSD: get(results['exponent-shyusd'], 'sHYUSD'),

      ratex_xSOL: get(results['ratex-xsol'], 'xSOL'),
      ratex_PT_xSOL: get(results['ratex-xsol'], 'PT-xSOL'),
      ratex_hyUSD: get(results['ratex-hyusd'], 'hyUSD'),
      ratex_PT_hyUSD: get(results['ratex-hyusd'], 'PT-hyUSD'),
      ratex_hylosolplus: get(results['ratex-hylosolplus'], 'hyloSOL+'),
      ratex_PT_hylosolplus: get(results['ratex-hylosolplus'], 'PT-hyloSOL+'),
      ratex_hylosol: get(results['ratex-hylosol'], 'hyloSOL'),
      ratex_PT_hylosol: get(results['ratex-hylosol'], 'PT-hyloSOL'),
      ratex_sHYUSD: get(results['ratex-shyusd'], 'sHYUSD'),
      ratex_PT_sHYUSD: get(results['ratex-shyusd'], 'PT-sHYUSD'),

      fetched_at: new Date().toISOString(),
      partial: Object.values(results).some(v => v === null)
    };

    cache = { ts: now, data };
    clearTimeout(globalTimeout);
    res.json({ ok: true, source: 'live', data });
  } catch (e) {
    clearTimeout(globalTimeout);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// === /health ===
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on ${PORT}`));
