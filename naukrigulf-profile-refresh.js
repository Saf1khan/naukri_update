/**
 * NaukriGulf Profile Refresh — toggles a trailing "." on the CV Headline
 * so your NaukriGulf profile counts as "Updated Today" every run.
 *
 * Uses NAUKRIGULF_EMAIL and NAUKRIGULF_PASSWORD from .env or GitHub Secrets.
 * Respects NaukriGulf's 80-character limit on CV Headline.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PROFILE_URL = 'https://www.naukrigulf.com/mnj/userProfile/myCV';
const LOGIN_URL   = 'https://www.naukrigulf.com/jobseeker/login';
const LOG_FILE    = path.join(__dirname, 'naukrigulf-refresh.log');
const ERROR_SHOT  = path.join(__dirname, 'naukrigulf-refresh-error.png');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

const EMAIL    = (process.env.NAUKRIGULF_EMAIL || '').trim();
const PASSWORD = (process.env.NAUKRIGULF_PASSWORD || '').trim();

console.log('NaukriGulf credential check:');
console.log(' - NAUKRIGULF_EMAIL:', EMAIL ? `Present (${EMAIL.length} chars)` : 'MISSING');
console.log(' - NAUKRIGULF_PASSWORD:', PASSWORD ? `Present (${PASSWORD.length} chars)` : 'MISSING');

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: NAUKRIGULF_EMAIL and NAUKRIGULF_PASSWORD are required in .env or GitHub Secrets!');
  process.exit(1);
}

(async () => {
  const launchOptions = {
    headless: false,
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...(process.platform === 'win32' ? ['--window-position=-32000,-32000'] : []),
    ],
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 850 },
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    log('Logging into NaukriGulf...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const emailInput = page.locator('#loginPageLoginEmail, input[name="username"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 25000 });
    await emailInput.fill(EMAIL);

    const passInput = page.locator('#loginPassword, input[name="loginPassword"]').first();
    await passInput.fill(PASSWORD);

    await page.locator('#loginPageLoginSubmit, button.login-btn').first().click();
    await page.waitForTimeout(5000);

    if (page.url().includes('/login')) {
      throw new Error('NaukriGulf login failed — still on login page. Please verify NAUKRIGULF_EMAIL and NAUKRIGULF_PASSWORD.');
    }

    log('Navigating to NaukriGulf Profile (myCV) page...');
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Click Edit button inside #cvHeadline section
    const editBtn = page.locator('#cvHeadline button.edit-cta, #cvHeadline .edit-cta').first();
    await editBtn.waitFor({ state: 'visible', timeout: 30000 });
    await editBtn.click();

    const textarea = page.locator('#cvHeadlineForm textarea[name="cvHeadline"], textarea#cvHeadline').first();
    await textarea.waitFor({ state: 'visible', timeout: 20000 });

    const current = (await textarea.inputValue()).trimEnd();
    if (!current) {
      throw new Error('CV Headline textarea is empty.');
    }

    // NaukriGulf enforces maxlength="80" on CV Headline
    let updated;
    if (current.endsWith('.')) {
      updated = current.slice(0, -1);
    } else if (current.length < 80) {
      updated = current + '.';
    } else {
      updated = current.slice(0, 79) + '.';
    }

    await textarea.fill(updated);

    const saveBtn = page.locator('#cvHeadlineForm button[type="submit"], #cvHeadlineForm button.ng-btn.blue').first();
    await saveBtn.waitFor({ state: 'visible', timeout: 15000 });
    await saveBtn.click();

    // Wait for inline form to close / save to complete
    await textarea.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    log(`OK: NaukriGulf headline ${current.endsWith('.') ? 'dot removed' : 'dot added'} (verified) → "${updated}"`);
  } catch (err) {
    await page.screenshot({ path: ERROR_SHOT }).catch(() => {});
    log(`ERROR: ${err.message}`);
    console.error('Stack trace:', err.stack);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
