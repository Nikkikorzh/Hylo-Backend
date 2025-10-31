import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import pRetry from 'p-retry';
dotenv.config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const NODE_ENV = process.env.NODE_ENV || 'development';

// === URLs (ИСПРАВЛЕНО: 2601 для hyUSD/sHYUSD) ===
const EXPONENT_XSOL_1 = 'https://www.exponent.finance/liquidity/xsol-26Nov25-1';
const EXPONENT_XSOL_2 = 'https://www.exponent.finance/liquidity/xsol-26Nov25';
const EXPONENT_HYUSD = 'https://www.exponent.finance/liquidity/hyusd-15Dec25';
const EXPONENT_HYLOSOL_PLUS = 'https://www.exponent.finance/liquidity/hylosolplus-15Dec25';
const EXPONENT_HYLOSOL = 'https://www.exponent.finance/liquidity/hylosol-10Dec25';
const EXPONENT_SHYUSD = 'https://www.exponent.finance/liquidity/shyusd-18Nov25';

const RATEX_XSOL = 'https://app.rate-x.io/points?symbol=xSOL-2511';
const RATEX_HYUSD = 'https://app.rate-x.io/points?symbol=hyUSD-2601';  // ← ИСПРАВЛЕНО
const RATEX_HYLOSOL_PLUS = 'https://app.rate-x.io/points?symbol=hyloSOL%252B-2511';
const RATEX_HYLOSOL = 'https://app.rate-x.io/points?symbol=hyloSOL-2511';
const RATEX_SHYUSD = 'https://app.rate-x.io/points?symbol=sHYUSD-2601';  // ← ИСПРАВЛЕНО

// === Labels ===
const LABELS_EXPONENT = [
  'xSOL', 'PT-xSOL', 'hyUSD', 'PT-hyUSD', 'pt-hyusd',
  'hyloSOL+', 'PT-hyloSOL+', 'hylosolplus',
  'hyloSOL', 'PT-hyloSOL', 'hylosol',
  'sHYUSD','shyusd'
];

const LABELS_RATEX = [
  'xSOL-2511', 'PT-xSOL-2511', 'xSOL',
  'hyUSD-2601', 'PT-hyUSD-2601', 'hyUSD',  // ← Добавлено 2601
  'sHYUSD-2601', 'PT-sHYUSD-2601', 'sHYUSD',  // ← Добавлено 2601
  'hyloSOL+-2511', 'PT-hyloSOL+-2511', 'hyloSOL+',
  'hyloSOL-2511', 'PT-hyloSOL-2511', 'hyloSOL',
  'Total Combined APY', 'Fixed APY', 'Variable APY', 'Base APY', 'AMM APY'  // ← Улучшено
];

// === Caching ===
let cache = { ts: 0, data: null };
const CACHE_TTL_MS = 60 * 1000;

// === Shared Browser только для Exponent ===
let sharedBrowser = null;
async function getSharedBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled'
      ],
      defaultViewport: null
    });
    console.log('Puppeteer browser launched');
  }
  return sharedBrowser;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// === УЛУЧШЕННЫЙ Поиск APY (с tokenHint внутри evaluate) ===
async function fetchApysFromPage(url, labels, siteKey, tokenHint, isRateX = false) {
  return pRetry(async (attempt) => {
    console.log(`Fetch attempt ${attempt} for ${siteKey}: ${url}`);
    let browser;
    let page;

    if (isRateX) {
      // Для Rate-X: новый изолированный browser/page (избежать кэша)
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      page = await browser.newPage();
    } else {
      browser = await getSharedBrowser();
      page = await browser.newPage();
    }

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

      // УЛУЧШЕНО: Ожидание конкретных селекторов для Rate-X
      if (isRateX) {
        await Promise.race([
          page.waitForSelector('text/Fixed APY, text/Total Combined APY', { timeout: 15000 }).catch(() => {}),
          page.waitForFunction(() => document.body.innerText.includes('Fixed APY') || document.body.innerText.includes('Total Combined APY'), { timeout: 15000 }).catch(() => {})
        ]);
      } else {
        await Promise.race([
          page.waitForSelector('text/APY, text/%', { timeout: 10000 }).catch(() => {}),
          page.waitForFunction(
            (labels) => {
              const text = document.body.innerText.toLowerCase();
              return /apy|%/.test(text) || labels.some(l => text.includes(l.toLowerCase()));
            },
            { timeout: 10000 },
            labels
          ).catch(() => {})
        ]);
      }

      await sleep(2000);  // Уменьшено до 2s
      const pageText = await page.evaluate(() => document.body.innerText);

      const found = await page.evaluate((labels, tokenHint) => {
        const results = {};

        // УЛУЧШЕНО: Regex без обязательного пробела
        function extractPercent(text) {
          if (!text) return null;
          const match = text.match(/(-?[\d,]+(?:\.\d+)?)\s*%/) ||
                        text.match(/(-?[\d,]+(?:\.\d+)?)%/);  // ← Без \s*
          if (!match) return null;
          const num = parseFloat(match[1].replace(/,/g, ''));
          if (isNaN(num)) return null;
          if (num === 100 && !text.toLowerCase().includes('apy')) return null;
          return num;
        }

        // УЛУЧШЕНО: Поиск по всем элементам + siblings + explicit для Rate-X
        const elements = Array.from(document.querySelectorAll('body *'))
          .filter(el => el.innerText && el.innerText.length < 1000);

        for (const el of elements) {
          const text = el.innerText;
          const lowerText = text.toLowerCase();

          // Explicit поиск Fixed/Total Combined (для Rate-X)
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

              // Siblings
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

        // Fallback: Глобальный поиск APY
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
      }, labels, tokenHint);  // ← tokenHint теперь используется внутри

      // УЛУЧШЕНО: mapLabel с tokenHint (теперь внутри, но для простоты снаружи; интегрировано)
      const mapLabel = (label, tokenHint) => {
        const l = label.toLowerCase();

        // Приоритет: Explicit для Rate-X
        if (l.includes('fixed apy')) {
          const map = {
            'xSOL': 'PT-xSOL',
            'hyUSD': 'PT-hyUSD',
            'sHYUSD': 'PT-sHYUSD',
            'hyloSOL+': 'PT-hyloSOL+',
            'hyloSOL': 'PT-hyloSOL'
          };
          return map[tokenHint] || 'PT-' + tokenHint.toUpperCase();  // Fallback
        }

        if (l.includes('total combined apy') || l.includes('variable apy')) {
          const map = {
            'xSOL': 'xSOL',
            'hyUSD': 'hyUSD',
            'sHYUSD': 'sHYUSD',
            'hyloSOL+': 'hyloSOL+',
            'hyloSOL': 'hyloSOL'
          };
          return map[tokenHint] || tokenHint.toUpperCase();
        }

        // Fallback по тексту
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
        'PT-sHYUSD': null, 'sHYUSD': null,  // ← Добавлено
        'PT-hyloSOL+': null, 'hyloSOL+': null,
        'PT-hyloSOL': null, 'hyloSOL': null
      };

      for (const [key, val] of Object.entries(found)) {
        const mapped = mapLabel(key, tokenHint);
        if (mapped && !normalized[mapped]) {
          normalized[mapped] = val;
        }
      }

      // ← Лог только ненулевые
      const nonNull = Object.fromEntries(Object.entries(normalized).filter(([_, v]) => v !== null));
      console.log(`Parsed ${siteKey} (${tokenHint}):`, nonNull);

      await page.close();
      if (isRateX) await browser.close();  // Закрыть изолированный
      return { ok: true, data: normalized, textSnippet: pageText.slice(0, 2000) };

    } catch (err) {
      if (NODE_ENV !== 'production') {
        try {
          await page.screenshot({ path: `debug-${siteKey}.png`, fullPage: true });
          console.log(`Screenshot saved: debug-${siteKey}.png`);
        } catch (e) {}
      }
      try { await page.close(); if (isRateX) await browser.close(); } catch (e) {}
      throw new pRetry.AbortError(err);  // Для retry
    }
  }, { retries: 2 });
}

// === API: /api/apy ===
app.get('/api/apy', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === '1';

    if (!force && cache.data && (now - cache.ts) < CACHE_TTL_MS) {
      return res.json({ ok: true, source: 'cache', data: cache.data, cached_at: cache.ts });
    }

    // Exponent (shared, parallel)
    const expPromises = [
      fetchApysFromPage(EXPONENT_XSOL_1, LABELS_EXPONENT, 'exponent-xsol-1', 'xSOL', false),
      fetchApysFromPage(EXPONENT_XSOL_2, LABELS_EXPONENT, 'exponent-xsol-2', 'xSOL', false),
      fetchApysFromPage(EXPONENT_HYUSD, LABELS_EXPONENT, 'exponent-hyusd', 'hyUSD', false),
      fetchApysFromPage(EXPONENT_HYLOSOL_PLUS, LABELS_EXPONENT, 'exponent-hylosolplus', 'hyloSOL+', false),
      fetchApysFromPage(EXPONENT_HYLOSOL, LABELS_EXPONENT, 'exponent-hylosol', 'hyloSOL', false),
      fetchApysFromPage(EXPONENT_SHYUSD, LABELS_EXPONENT, 'exponent-shyusd', 'sHYUSD', false),
    ];
    const [expXsol1, expXsol2, expHyusd, expHylosolPlus, expHylosol, expSHYUSD] = await Promise.all(expPromises);

    // Rate-X (sequential to avoid OOM)
    const ratexPromises = [
      { url: RATEX_XSOL, key: 'ratex-xsol', hint: 'xSOL' },
      { url: RATEX_HYUSD, key: 'ratex-hyusd', hint: 'hyUSD' },
      { url: RATEX_HYLOSOL_PLUS, key: 'ratex-hylosolplus', hint: 'hyloSOL+' },
      { url: RATEX_HYLOSOL, key: 'ratex-hylosol', hint: 'hyloSOL' },
      { url: RATEX_SHYUSD, key: 'ratex-shyusd', hint: 'sHYUSD' }
    ];
    const ratexResults = [];
    for (const { url, key, hint } of ratexPromises) {
      const result = await fetchApysFromPage(url, LABELS_RATEX, key, hint, true);
      ratexResults.push(result);
    }
    const [ratexXsol, ratexHyusd, ratexHylosolPlus, ratexHylosol, ratexSHyusd] = ratexResults;

    const get = (res, key) => res.ok && res.data[key] ? res.data[key].percent : null;

    const data = {
      // Exponent
      exponent_xSOL_1: get(expXsol1, 'xSOL'),
      exponent_PT_xSOL_1: get(expXsol1, 'PT-xSOL'),
      exponent_xSOL_2: get(expXsol2, 'xSOL'),
      exponent_PT_xSOL_2: get(expXsol2, 'PT-xSOL'),
      exponent_hyUSD: get(expHyusd, 'hyUSD'),
      exponent_PT_hyUSD: get(expHyusd, 'PT-hyUSD'),
      exponent_hylosolplus: get(expHylosolPlus, 'PT-hyloSOL+'),
      exponent_hylosol: get(expHylosol, 'PT-hyloSOL'),
      exponent_sHYUSD: get(expSHYUSD, 'sHYUSD'),  // ← Fix: no space

      // Rate-X: xSOL
      ratex_xSOL: get(ratexXsol, 'xSOL'),
      ratex_PT_xSOL: get(ratexXsol, 'PT-xSOL'),

      // Rate-X: hyUSD (теперь правильно)
      ratex_hyUSD: get(ratexHyusd, 'hyUSD'),
      ratex_PT_hyUSD: get(ratexHyusd, 'PT-hyUSD'),

      // Rate-X: hyloSOL+
      ratex_hylosolplus: get(ratexHylosolPlus, 'hyloSOL+'),
      ratex_PT_hylosolplus: get(ratexHylosolPlus, 'PT-hyloSOL+'),

      // Rate-X: hyloSOL
      ratex_hylosol: get(ratexHylosol, 'hyloSOL'),
      ratex_PT_hylosol: get(ratexHylosol, 'PT-hyloSOL'),

      // Rate-X: sHYUSD (теперь правильно)
      ratex_sHYUSD: get(ratexSHyusd, 'sHYUSD'),
      ratex_PT_sHYUSD: get(ratexSHyusd, 'PT-sHYUSD'),

      fetched_at: new Date().toISOString()
    };

    cache = { ts: now, data };
    res.json({ ok: true, source: 'live', data });

  } catch (e) {
    console.error('API /api/apy error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === /api/calc ===
app.post('/api/calc', (req, res) => {
  try {
    const { principal, rate, rateType = 'APY', days, compoundingPerYear = 365 } = req.body;  // ← APY по умолчанию
    const P = Number(principal || 0);
    const r = Number(rate || 0) / 100;
    const d = Number(days || 0);
    const n = Number(compoundingPerYear);

    if (!P || !d) return res.status(400).json({ ok: false, error: 'principal and days required' });

    let final = 0;
    if (rateType.toUpperCase() === 'APY') {
      final = P * Math.pow(1 + r, d / 365);  // ← Для APY: direct compound
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

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch (e) {}
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));