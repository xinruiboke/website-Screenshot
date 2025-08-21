/*
 Fetch friend links JSON and take full-page WebP snapshots.
 Saves images into the `snapshots/` directory, with filenames derived from friend names.
*/

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const puppeteerPkg = require('puppeteer/package.json');

const CONFIG_PATH = path.join(process.cwd(), 'snapshot.config.json');
let userConfig = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {};
  }
} catch (e) {
  console.warn('Failed to read snapshot.config.json:', e.message);
  userConfig = {};
}

const FRIENDS_URL = process.env.FRIENDS_URL || userConfig.url || 'https://www.xrbk.cn/api/links.json';
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || (userConfig.viewport && userConfig.viewport.width) || 1366);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || (userConfig.viewport && userConfig.viewport.height) || 768);
const RAW_CONCURRENCY = Number(process.env.CONCURRENCY || userConfig.concurrency || 4);
const CONCURRENCY = Math.max(1, Math.min(Number.isFinite(RAW_CONCURRENCY) ? Math.floor(RAW_CONCURRENCY) : 4, 10));
const DEVICE_SCALE = Number(process.env.DEVICE_SCALE || (userConfig.deviceScaleFactor ?? 1));
const LANG = String(process.env.BROWSER_LANG || userConfig.lang || 'zh-CN,zh;q=0.9,en;q=0.8');
const EXTRA_WAIT_MS = Number(process.env.EXTRA_WAIT_MS || userConfig.extraWaitMs || 5000);
const SCROLL_ENABLED = (userConfig.scroll && typeof userConfig.scroll.enabled === 'boolean') ? userConfig.scroll.enabled : true;
const SCROLL_STEP_PX = Number((userConfig.scroll && userConfig.scroll.stepPx) || 800);
const SCROLL_DELAY_MS = Number((userConfig.scroll && userConfig.scroll.delayMs) || 200);
const SCROLL_MAX_MS = Number((userConfig.scroll && userConfig.scroll.maxMs) || 15000);
const OUTPUT_DIR = path.join(process.cwd(), 'snapshots');

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function sanitizeFileName(name) {
  // Replace characters that are problematic across OSes, and trim length
  const replaced = name
    .replace(/[\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // Limit to a reasonable length to avoid filesystem issues
  const maxBaseLength = 120;
  const base = replaced.slice(0, maxBaseLength);
  // If name becomes empty, fallback
  return base || 'snapshot';
}

async function fetchFriends() {
  const res = await fetch(FRIENDS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch friends JSON: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.friends)) {
    throw new Error('Invalid friends JSON shape: missing `friends` array');
  }
  // Each friend item is [name, url, icon]
  return data.friends
    .filter((entry) => Array.isArray(entry) && entry.length >= 2)
    .map((entry) => ({
      name: String(entry[0] ?? '').trim(),
      url: String(entry[1] ?? '').trim(),
      icon: String(entry[2] ?? '').trim(),
    }))
    .filter((f) => f.name && /^https?:\/\//i.test(f.url));
}

async function takeSnapshot(browser, friend) {
  const page = await browser.newPage();
  // Set a realistic user agent and viewport
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': LANG });
  const safeWidth = Number.isFinite(VIEWPORT_WIDTH) && VIEWPORT_WIDTH > 0 ? Math.floor(VIEWPORT_WIDTH) : 1366;
  const safeHeight = Number.isFinite(VIEWPORT_HEIGHT) && VIEWPORT_HEIGHT > 0 ? Math.floor(VIEWPORT_HEIGHT) : 768;
  const safeScale = Number.isFinite(DEVICE_SCALE) && DEVICE_SCALE > 0 ? Math.min(Math.max(DEVICE_SCALE, 1), 3) : 1;
  await page.setViewport({ width: safeWidth, height: safeHeight, deviceScaleFactor: safeScale });
  const filename = `${sanitizeFileName(friend.name)}.webp`;
  const filepath = path.join(OUTPUT_DIR, filename);

  try {
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);
    await page.goto(friend.url, {
      waitUntil: ['domcontentloaded', 'networkidle2'],
      timeout: 120000,
    });
    if (SCROLL_ENABLED) {
      await autoScroll(page, { stepPx: SCROLL_STEP_PX, delayMs: SCROLL_DELAY_MS, maxMs: SCROLL_MAX_MS });
    }
    // Extra wait for dynamically injected content
    if (EXTRA_WAIT_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, EXTRA_WAIT_MS));
    }

    await page.emulateMediaType('screen');

    await page.screenshot({
      path: filepath,
      type: 'webp',
      fullPage: true,
      quality: 80,
      captureBeyondViewport: true,
    });

    return { ok: true, filepath };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await page.close().catch(() => {});
  }
}

(async function autoScroll(page, opts) {
  // no-op placeholder to allow function hoisting
})();

async function autoScroll(page, { stepPx = 800, delayMs = 200, maxMs = 15000 } = {}) {
  const start = Date.now();
  let previousScrollTop = -1;
  while (Date.now() - start < maxMs) {
    await page.evaluate((step) => {
      window.scrollBy(0, step);
    }, Math.max(100, stepPx));
    await new Promise((r) => setTimeout(r, Math.max(50, delayMs)));
    const { scrollTop, scrollHeight, clientHeight } = await page.evaluate(() => ({
      scrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : window.scrollY,
      scrollHeight: document.scrollingElement ? document.scrollingElement.scrollHeight : document.body.scrollHeight,
      clientHeight: document.scrollingElement ? document.scrollingElement.clientHeight : window.innerHeight,
    }));
    if (scrollTop === previousScrollTop) break;
    previousScrollTop = scrollTop;
    if (scrollTop + clientHeight >= scrollHeight) break;
  }
  // Scroll back to top for consistent screenshots
  await page.evaluate(() => window.scrollTo(0, 0));
}

(async function processWithConcurrency() {
  console.log(`Snapshot script build: 2025-08-21-01`);
  console.log(`Using Puppeteer version: ${puppeteerPkg.version}`);
  console.log(`Config -> URL: ${FRIENDS_URL}, viewport: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}@${DEVICE_SCALE}x, concurrency: ${CONCURRENCY}, lang: ${LANG}`);
  ensureDirectoryExists(OUTPUT_DIR);

  let browser;
  try {
    const friends = await fetchFriends();
    if (friends.length === 0) {
      console.log('No valid friends found to snapshot.');
      process.exit(0);
    }

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--lang=zh-CN',
      ],
      defaultViewport: null,
    });

    let successCount = 0;
    let failCount = 0;
    const jsonItems = [];

    let index = 0;
    async function worker(workerId) {
      while (true) {
        const currentIndex = index++;
        if (currentIndex >= friends.length) break;
        const friend = friends[currentIndex];
        console.log(`[W${workerId}] Snapshotting: ${friend.name} -> ${friend.url}`);
        const result = await takeSnapshot(browser, friend);
        if (result.ok) {
          successCount += 1;
          console.log(`[W${workerId}] Saved: ${path.relative(process.cwd(), result.filepath)}`);
          jsonItems.push({
            name: friend.name,
            url: friend.url,
            image: `${sanitizeFileName(friend.name)}.webp`,
          });
        } else {
          failCount += 1;
          console.warn(`[W${workerId}] Failed: ${friend.name} (${friend.url})`);
          if (result.error) {
            console.warn(String(result.error.message || result.error));
            if (result.error.stack) console.warn(result.error.stack);
          }
        }
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
    await Promise.all(workers);

    // Write JSON manifest
    const manifest = {
      generatedAt: new Date().toISOString(),
      total: jsonItems.length,
      items: jsonItems,
    };
    const manifestPath = path.join(OUTPUT_DIR, 'friends.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`Wrote manifest: ${path.relative(process.cwd(), manifestPath)} (${jsonItems.length} items)`);

    console.log(`Done. Success: ${successCount}, Failed: ${failCount}`);
    if (successCount === 0) process.exit(2);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();


