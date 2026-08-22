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

const NAUK_AT = process.env.NAUK_AT;
const NAUK_RT = process.env.NAUK_RT;
const NAUK_SID = process.env.NAUK_SID;

(async () => {
  const launchOptions = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  if (process.platform === 'win32') {
    launchOptions.channel = 'chrome';
  }

  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 850 },
  });

  // Inject session cookies directly
  const cookiesToSet = [
    { name: 'nauk_at', value: NAUK_AT, domain: '.naukri.com', path: '/' },
    { name: 'nauk_rt', value: NAUK_RT, domain: '.naukri.com', path: '/' },
    { name: 'nauk_sid', value: NAUK_SID, domain: '.naukri.com', path: '/' },
    { name: 'nauk_otl', value: NAUK_SID, domain: '.naukri.com', path: '/' },
    { name: 'is_login', value: '1', domain: '.naukri.com', path: '/' },
    { name: 'persona', value: 'default', domain: '.naukri.com', path: '/' },
  ].filter(c => Boolean(c.value));

  await context.addCookies(cookiesToSet);

  const page = await context.newPage();

  try {
    log('Navigating to Naukri Profile page with authenticated cookies...');
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the page or check if redirected to login
    if (page.url().includes('nlogin')) {
      throw new Error('Redirected to login — session cookies expired. Please update NAUK_AT in secrets.');
    }

    // Look for resume headline edit widget
    const editIcon = page.locator('#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit, a[href*="resumeHeadline/edit"], .widgetHead .edit, svg[data-icon="pencil"]');
    await editIcon.first().waitFor({ timeout: 30000 });
    await editIcon.first().click();

    // The textarea on new UI can be inside modal or page
    const textarea = page.locator('#resumeHeadlineTxt, textarea[name="resumeHeadline"], textarea.resumeHeadlineTxt, textarea');
    await textarea.first().waitFor({ timeout: 20000 });
    const current = (await textarea.first().inputValue()).trimEnd();
    const updated = current.endsWith('.') ? current.slice(0, -1) : current + '.';

    await textarea.first().fill(updated);
    const saveBtn = page.locator('button:has-text("Save"), button[type="submit"], .btn-save, [data-ga-track*="save"]');
    await saveBtn.first().click();
    await page.waitForTimeout(3000);

    // Verify change
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await editIcon.first().waitFor({ timeout: 30000 });
    await editIcon.first().click();
    await textarea.first().waitFor({ timeout: 20000 });
    const saved = (await textarea.first().inputValue()).trimEnd();

    if (saved !== updated) {
      throw new Error(`Save did not stick — server headline is "${saved.slice(0, 60)}", expected "${updated.slice(0, 60)}"`);
    }

    log(`OK: headline ${current.endsWith('.') ? 'dot removed' : 'dot added'} (verified) → "${updated.slice(0, 60)}"`);
  } catch (err) {
    await page.screenshot({ path: ERROR_SHOT }).catch(() => {});
    log(`ERROR: ${err.message.split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
