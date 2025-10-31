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

const NODE_ENV = process.env.NODE_ENV || 'development';

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
  'sHYUSD','shyusd'
];

const LABELS_RATEX = [
  'xSOL-2511', 'PT-xSOL-2511', 'xSOL',
  'hyUSD-2601', 'PT-hyUSD-2601', 'hyUSD',
  'sHYUSD-2601', 'PT-sHYUSD-2601', 'sHYUSD',
  'hyloSOL+-2511', 'PT-hyloSOL+-2511', 'hyloSOL+',
  'hyloSOL-2511', 'PT-hyloSOL-2511', 'hyloSOL',
  'Total Combined APY', 'Fixed APY', 'Variable APY', 'Base APY', 'AMM APY'
];

// === Caching ===
let cache = { ts: 0, data: null };
const CACHE_TTL_MS = 60 * 1000;

// === Shared Browser (только для Exponent) ===
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

// === Sleep ===
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === Поиск APY (БЕЗОПАСНЫЙ RETRY) ===
async function fetchApysFromPage(url, labels, siteKey, tokenHint, isRateX = false) {
  return pRetry(
    async (attempt) => {
      console.log(`Fetch attempt ${attempt} for ${siteKey}: ${url}`);
      let browser = null;
      let page = null;

      try {
        // === Браузер ===
        if (isRateX) {
          browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
          });
        } else {
          browser = await getSharedBrowser();
        }

        page = await browser.newPage();

        // Обход детекции
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          window.chrome = { runtime: {} };
        });

        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Быстрее: domcontentloaded
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Ожидание APY
        if (isRateX) {
          await Promise.race([
            page.waitForFunction(
              () => document.body.innerText.includes('Fixed APY') || document.body.innerText.includes('Total Combined APY'),
              { timeout: 10000 }
            ).catch(() => {}),
          ]);
        } else {
          await Promise.race([
            page.waitForFunction(
              (labels) => {
                const text = document.body.innerText.toLowerCase();
                return /apy|%/.test(text) || labels.some(l => text.includes(l.toLowerCase()));
              },
              { timeout: 10000 },
              labels
            ).catch(() => {}),
          ]);
        }

        await sleep(1500);
        const pageText = await page.evaluate(() => document.body.innerText);

        // === Парсинг ===
        const found = await page.evaluate((labels, tokenHint) => {
          const results = {};

          function extractPercent(text) {
            if (!text) return null;
            const match = text.match(/(-?[\d,]+(?:\.\d+)?)\s*%/) ||
                          text.match(/(-?[\d,]+(?:\.\d+)?)%/);
            if (!match) return null;
            const num = parseFloat(match[1].replace(/,/g, ''));
            if (isNaN(num)) return null;
            if (num === 100 && !text.toLowerCase().includes('apy')) return null;
            return num;
          }

          const elements = Array.from(document.querySelectorAll('body *'))
            .filter(el => el.innerText && el.innerText.length < 1000);

          for (const el of elements) {
            const text = el.innerText;
            const lowerText = text.toLowerCase();

            if (lowerText.includes('fixed apy') || lowerText.includes('total combined apy')) {
              const percent = extractPercent(text);
              if (percent !== null) {
                let key = lowerText.includes('fixed') ? 'Fixed APY' : 'Total Combined APY';
                if (!results[key]) {
                  results[key] = { percent, context: text.slice(0, 400), source: 'explicit' };
                }
                continue;
              }
            }

            for (const label of labels) {
              const labelLower = label.toLowerCase();
              if (lowerText.includes(labelLower) && !results[label]) {
                const percent = extractPercent(text);
                if (percent !== null) {
                  results[label] = { percent, context: text.slice(0, 400), source: 'same-element' };
                  continue;
                }

                const parent = el.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children);
                  for (const sib of siblings) {
                    if (sib === el) continue;
                    const p = extractPercent(sib.innerText);
                    if (p !== null) {
                      results[label] = { percent: p, context: sib.innerText.slice(0, 400), source: 'sibling' };
                      break;
                    }
                  }
                }
              }
            }
          }

          if (Object.keys(results).length === 0) {
            const text = document.body.innerText;
            const apyMatches = [...text.matchAll(/(?:APY|Total Combined).*?(-?[\d,]+(?:\.\d+)?)\s*%?/gi)] ||
                              [...text.matchAll(/(-?[\d,]+(?:\.\d+)?)%/g)];
            for (const m of apyMatches) {
              const window = m[0].toLowerCase();
              for (const label of labels) {
                if (!results[label] && window.includes(label.toLowerCase())) {
                  const num = parseFloat(m[1]?.replace(/,/g, '') || m[0].match(/[\d.]+/)[0]);
                  if (!isNaN(num)) {
                    results[label] = { percent: num, context: window, source: 'APY-block' };
                  }
                }
              }
            }
          }

          return results;
        }, labels, tokenHint);

        // === Маппинг ===
        const mapLabel = (label, tokenHint) => {
          const l = label.toLowerCase();
          if (l.includes('fixed apy')) {
            const map = { 'xSOL': 'PT-xSOL', 'hyUSD': 'PT-hyUSD', 'sHYUSD': 'PT-sHYUSD', 'hyloSOL+': 'PT-hyloSOL+', 'hyloSOL': 'PT-hyloSOL' };
            return map[tokenHint] || 'PT-' + tokenHint.toUpperCase();
          }
          if (l.includes('total combined apy') || l.includes('variable apy')) {
            const map = { 'xSOL': 'xSOL', 'hyUSD': 'hyUSD', 'sHYUSD': 'sHYUSD', 'hyloSOL+': 'hyloSOL+', 'hyloSOL': 'hyloSOL' };
            return map[tokenHint] || tokenHint.toUpperCase();
          }
          if (l.includes('pt') && l.includes('xsol')) return 'PT-xSOL';
          if (l.includes('pt') && l.includes('hyusd') && !l.includes('shyusd')) return 'PT-hyUSD';
          if (l.includes('pt') && l.includes('shyusd')) return 'PT-sHYUSD';
          if (l.includes('pt') && l.includes('hylosol') && l.includes('+')) return 'PT-hyloSOL+';
          if (l.includes('pt') && l.includes('hylosol') && !l.includes('+')) return 'PT-hyloSOL';
          if (l.includes('xsol') && !l.includes('pt')) return 'xSOL';
          if (l.includes('hyusd') && !l.includes('pt') && !l.includes('shyusd')) return 'hyUSD';
          if (l.includes('shyusd') && !l.includes('pt')) return 'sHYUSD';
          if (l.includes('hylosol') && l.includes('+') && !l.includes('pt')) return 'hyloSOL+';
          if (l.includes('hylosol') && !l.includes('+') && !l.includes('pt')) return 'hyloSOL';
          return null;
        };

        const normalized = {
          'PT-xSOL': null, 'xSOL': null,
          'PT-hyUSD': null, 'hyUSD': null,
          'PT-sHYUSD': null, 'sHYUSD': null,
          'PT-hyloSOL+': null, 'hyloSOL+': null,
          'PT-hyloSOL': null, 'hyloSOL': null
        };

        for (const [key, val] of Object.entries(found)) {
          const mapped = mapLabel(key, tokenHint);
          if (mapped && !normalized[mapped]) {
            normalized[mapped] = val;
          }
        }

        const nonNull = Object.fromEntries(Object.entries(normalized).filter(([_, v]) => v !== null));
        console.log(`Parsed ${siteKey} (${tokenHint}):`, nonNull);

        await page.close();
        if (isRateX) await browser.close();

        return { ok: true, data: normalized, textSnippet: pageText.slice(0, 2000) };

      } catch (err) {
        if (NODE_ENV !== 'production') {
          try {
            await page?.screenshot({ path: `debug-${siteKey}.png`, fullPage: true });
            console.log(`Screenshot saved: debug-${siteKey}.png`);
          } catch (e) {}
        }

        try { await page?.close(); if (isRateX) await browser?.close(); } catch (e) {}

        throw err;
      }
    },
    {
      retries: 2,
      onFailedAttempt: (failure) => {
        const errorMessage = failure.error?.message || 'Unknown error';
        console.warn(`Attempt ${failure.attemptNumber} failed for ${siteKey}:`, errorMessage);

        if (failure.attemptNumber >= 2) {
          const finalError = failure.error || new Error(`Failed after ${failure.attemptNumber} attempts`);
          throw finalError;
        }
      },
    }
  );
}

// === API: /api/apy (ПОСЛЕДОВАТЕЛЬНЫЙ + БЕЗОПАСНЫЙ) ===
app.get('/api/apy', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === '1';

    if (!force && cache.data && (now - cache.ts) < CACHE_TTL_MS) {
      return res.json({ ok: true, source: 'cache', data: cache.data, cached_at: new Date(cache.ts).toISOString() });
    }

    const results = {};

    // === Exponent: ПОСЛЕДОВАТЕЛЬНО ===
    const expTasks = [
      { key: 'exponent-xsol-1', url: EXPONENT_XSOL_1, hint: 'xSOL' },
      { key: 'exponent-xsol-2', url: EXPONENT_XSOL_2, hint: 'xSOL' },
      { key: 'exponent-hyusd', url: EXPONENT_HYUSD, hint: 'hyUSD' },
      { key: 'exponent-hylosolplus', url: EXPONENT_HYLOSOL_PLUS, hint: 'hyloSOL+' },
      { key: 'exponent-hylosol', url: EXPONENT_HYLOSOL, hint: 'hyloSOL' },
      { key: 'exponent-shyusd', url: EXPONENT_SHYUSD, hint: 'sHYUSD' },
    ];

    for (const task of expTasks) {
      try {
        const data = await fetchApysFromPage(task.url, LABELS_EXPONENT, task.key, task.hint, false);
        results[task.key] = data.ok ? data.data : null;
        console.log(`Success: ${task.key}`);
      } catch (err) {
        console.error(`Failed: ${task.key} — ${err.message}`);
        results[task.key] = null;
      }
    }

    // === RateX: ПАРАЛЛЕЛЬНО ===
    const ratexTasks = [
      { key: 'ratex-xsol', url: RATEX_XSOL, hint: 'xSOL' },
      { key: 'ratex-hyusd', url: RATEX_HYUSD, hint: 'hyUSD' },
      { key: 'ratex-hylosolplus', url: RATEX_HYLOSOL_PLUS, hint: 'hyloSOL+' },
      { key: 'ratex-hylosol', url: RATEX_HYLOSOL, hint: 'hyloSOL' },
      { key: 'ratex-shyusd', url: RATEX_SHYUSD, hint: 'sHYUSD' },
    ];

    const ratexSettled = await Promise.allSettled(
      ratexTasks.map(t => fetchApysFromPage(t.url, LABELS_RATEX, t.key, t.hint, true))
    );

    ratexTasks.forEach((t, i) => {
      const res = ratexSettled[i];
      results[t.key] = res.status === 'fulfilled' && res.value.ok ? res.value.data : null;
    });

    // === Формируем ответ ===
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
    res.json({ ok: true, source: 'live', data });

  } catch (e) {
    console.error('API /api/apy fatal error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// === /api/calc ===
app.post('/api/calc', (req, res) => {
  try {
    const { principal, rate, rateType = 'APY', days, compoundingPerYear = 365 } = req.body;
    const P = Number(principal || 0);
    const r = Number(rate || 0) / 100;
    const d = Number(days || 0);
    const n = Number(compoundingPerYear);

    if (!P || !d) return res.status(400).json({ ok: false, error: 'principal and days required' });

    let final = 0;
    if (rateType.toUpperCase() === 'APY') {
      final = P * Math.pow(1 + r, d / 365);
    } else {
      const apy = Math.pow(1 + r / n, n) - 1;
      final = P * Math.pow(1 + apy, d / 365);
    }

    const profit = final - P;
    res.json({ ok: true, principal: P, final, profit, days: d });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === /health ===
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// === Shutdown ===
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch (e) {}
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on http://localhost:${PORT}`));
