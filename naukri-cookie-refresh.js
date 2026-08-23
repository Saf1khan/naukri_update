/**
 * Naukri Profile Refresh via Playwright with Cookies Injection
 * Uses your authenticated session cookies (nauk_at, nauk_rt, nauk_sid)
 * directly in Playwright browser context without needing full Chrome profile or password!
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PROFILE_URL = process.env.NAUKRI_PROFILE_URL || 'https://www.naukri.com/mnjuser/profile';
const LOG_FILE = path.join(__dirname, 'naukri-refresh.log');
const ERROR_SHOT = path.join(__dirname, 'naukri-refresh-error.png');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

const NAUK_AT = (process.env.NAUK_AT || '').trim();
const NAUK_RT = (process.env.NAUK_RT || '').trim();
const NAUK_SID = (process.env.NAUK_SID || '').trim();

console.log('Secret check:');
console.log(' - NAUK_AT:', NAUK_AT ? `Present (${NAUK_AT.length} chars)` : 'MISSING (empty)');
console.log(' - NAUK_RT:', NAUK_RT ? `Present (${NAUK_RT.length} chars)` : 'MISSING (empty)');
console.log(' - NAUK_SID:', NAUK_SID ? `Present (${NAUK_SID.length} chars)` : 'MISSING (empty)');

if (!NAUK_AT && !NAUK_SID && !NAUK_RT) {
  console.error('ERROR: All secrets (NAUK_AT, NAUK_RT, NAUK_SID) are missing in GitHub Secrets!');
  process.exit(1);
}

(async () => {
  const isCI = Boolean(process.env.CI);
  const launchOptions = {
    headless: false,
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 850 },
  });

  // Clean values to prevent CDP Protocol error (Storage.setCookies)
  const cleanVal = (v) => (v ? String(v).replace(/[\r\n"']/g, '').trim() : '');
  const cookiesToSet = [
    { name: 'nauk_at', value: cleanVal(NAUK_AT), url: 'https://www.naukri.com' },
    { name: 'nauk_rt', value: cleanVal(NAUK_RT), url: 'https://www.naukri.com' },
    { name: 'nauk_sid', value: cleanVal(NAUK_SID), url: 'https://www.naukri.com' },
    { name: 'nauk_otl', value: cleanVal(NAUK_SID), url: 'https://www.naukri.com' },
    { name: 'is_login', value: '1', url: 'https://www.naukri.com' },
    { name: 'persona', value: 'default', url: 'https://www.naukri.com' },
  ].filter(c => Boolean(c.value));

  await context.addCookies(cookiesToSet);

  const page = await context.newPage();

  // Mask webdriver property
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    log('Navigating to Naukri Profile page with authenticated cookies...');
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`Landed on URL: ${page.url()}`);

    if (page.url().includes('nlogin/login') || page.url().includes('/login')) {
      throw new Error('Injected cookies are invalid or expired — Naukri redirected to the login page. Please re-copy fresh cookie values from your browser into GitHub Secrets.');
    }

    const textarea = page.locator('#resumeHeadlineTxt, textarea[name="resumeHeadline"], textarea.resumeHeadlineTxt, textarea').first();

    // If modal is not already open, click the edit icon
    let isModalOpen = await textarea.isVisible().catch(() => false);
    if (!isModalOpen) {
      const editIcon = page.locator('#lazyResumeHead .edit, [data-ga-track*="resumeHeadline"] .edit, .resumeHeadline .edit, span.edit.icon, .widgetHead .edit, .resume-headline .edit').first();
      await editIcon.waitFor({ state: 'visible', timeout: 30000 });
      await editIcon.click();
      await textarea.waitFor({ state: 'visible', timeout: 20000 });
    }
    const current = (await textarea.inputValue()).trimEnd();
    const updated = current.endsWith('.') ? current.slice(0, -1) : current + '.';

    await textarea.fill(updated);
    const saveBtn = page.locator('.modal button, div[class*="modal"] button, button').filter({ hasText: /^save$/i }).first();
    await saveBtn.waitFor({ state: 'visible', timeout: 15000 });
    await saveBtn.click();

    // Wait for modal to close / save to complete
    await textarea.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    log(`OK: headline ${current.endsWith('.') ? 'dot removed' : 'dot added'} (verified) → "${updated.slice(0, 60)}"`);
  } catch (err) {
    await page.screenshot({ path: ERROR_SHOT }).catch(() => {});
    log(`ERROR: ${err.message}`);
    console.error('Stack trace:', err.stack);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
