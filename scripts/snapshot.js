/*
 Fetch friend links JSON and take full-page WebP snapshots.
 Saves images into the `snapshots/` directory, with filenames derived from friend names.
*/

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

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
  const safeWidth = Number.isFinite(VIEWPORT_WIDTH) && VIEWPORT_WIDTH > 0 ? Math.floor(VIEWPORT_WIDTH) : 1366;
  const safeHeight = Number.isFinite(VIEWPORT_HEIGHT) && VIEWPORT_HEIGHT > 0 ? Math.floor(VIEWPORT_HEIGHT) : 768;
  await page.setViewport({ width: safeWidth, height: safeHeight, deviceScaleFactor: 1 });
  const filename = `${sanitizeFileName(friend.name)}.webp`;
  const filepath = path.join(OUTPUT_DIR, filename);

  try {
    await page.goto(friend.url, {
      waitUntil: ['load', 'domcontentloaded', 'networkidle2'],
      timeout: 60000,
    });
    // Small extra wait for lazy content
    await page.waitForTimeout(2000);

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

(async () => {
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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: null,
    });

    let successCount = 0;
    let failCount = 0;
    for (const friend of friends) {
      console.log(`Snapshotting: ${friend.name} -> ${friend.url}`);
      const result = await takeSnapshot(browser, friend);
      if (result.ok) {
        successCount += 1;
        console.log(`Saved: ${path.relative(process.cwd(), result.filepath)}`);
      } else {
        failCount += 1;
        console.warn(`Failed: ${friend.name} (${friend.url})`);
        console.warn(String(result.error?.message || result.error));
      }
    }

    console.log(`Done. Success: ${successCount}, Failed: ${failCount}`);
    // Exit non-zero if all failed
    if (successCount === 0) process.exit(2);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();


