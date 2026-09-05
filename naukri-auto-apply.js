/**
 * Naukri Auto-Apply Script
 * ─────────────────────────────────────────────────────────────────────────────
 * Searches Naukri for freshly posted jobs matching your target roles and
 * auto-applies to up to MAX_APPLIES_PER_RUN Easy-Apply listings per run.
 *
 * Run:   node naukri-auto-apply.js
 * CI:    triggered by .github/workflows/naukri_auto_apply.yml (daily 9 AM IST)
 *
 * Reads from .env:
 *   NAUK_RT, NAUK_SID          — session cookies (same as refresh script)
 *   JOB_KEYWORDS               — comma-separated role keywords
 *   JOB_LOCATIONS              — comma-separated cities
 *   JOB_EXPERIENCE_MIN/MAX     — experience range in years
 *   MAX_APPLIES_PER_RUN        — max applications per run (default 25)
 *   NOTICE_PERIOD, CURRENT_CTC, EXPECTED_CTC — form fill values
 *
 * Tracks applied job IDs in applied-jobs.json (committed back to repo by CI).
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Config ────────────────────────────────────────────────────────────────────
const NAUK_RT  = (process.env.NAUK_RT  || '').trim();
const NAUK_SID = (process.env.NAUK_SID || '').trim();

if (!NAUK_RT || !NAUK_SID) {
  console.error('ERROR: NAUK_RT and NAUK_SID are required. Set them in .env or GitHub Secrets.');
  process.exit(1);
}

const KEYWORDS = (process.env.JOB_KEYWORDS || 'React Developer,Full Stack Developer,Software Engineer,AI Engineer,Frontend Engineer')
  .split(',').map(k => k.trim()).filter(Boolean);

const LOCATIONS = (process.env.JOB_LOCATIONS || 'Bangalore,Hyderabad,Remote')
  .split(',').map(l => l.trim()).filter(Boolean);

const EXP_MIN = parseInt(process.env.JOB_EXPERIENCE_MIN || '1', 10);
const EXP_MAX = parseInt(process.env.JOB_EXPERIENCE_MAX || '3', 10);
const MAX_APPLIES = parseInt(process.env.MAX_APPLIES_PER_RUN || '25', 10);

const NOTICE_PERIOD = process.env.NOTICE_PERIOD || '15 days';
const CURRENT_CTC   = process.env.CURRENT_CTC   || '3';
const EXPECTED_CTC  = process.env.EXPECTED_CTC  || '10';

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE     = path.join(__dirname, 'naukri-apply.log');
const ERROR_SHOT   = path.join(__dirname, 'naukri-apply-error.png');

// ── Helpers ───────────────────────────────────────────────────────────────────
const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

function loadApplied() {
  try { return new Set(JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveApplied(set) {
  fs.writeFileSync(APPLIED_FILE, JSON.stringify([...set], null, 2));
}

const cleanVal = (v) => (v ? String(v).replace(/[\r\n"']/g, '').trim() : '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = () => sleep(1500 + Math.random() * 2000); // 1.5–3.5 s between actions

// ── Build Naukri search URL ───────────────────────────────────────────────────
function buildSearchUrl(keyword, location) {
  // Naukri search URL with filters: date posted = last 1 day, experience range
  const kw  = encodeURIComponent(keyword);
  const loc = encodeURIComponent(location);
  // jobAge=1  → posted in last 24 hours
  // expFrom / expTo → experience filter
  return `https://www.naukri.com/${kw.toLowerCase().replace(/%20/g, '-')}-jobs-in-${loc.toLowerCase().replace(/%20/g, '-')}?jobAge=1&expFrom=${EXP_MIN}&expTo=${EXP_MAX}`;
}

// ── Inject Naukri session cookies ─────────────────────────────────────────────
async function injectCookies(context) {
  await context.addCookies([
    { name: 'nauk_rt',  value: cleanVal(NAUK_RT),  url: 'https://www.naukri.com' },
    { name: 'nauk_sid', value: cleanVal(NAUK_SID), url: 'https://www.naukri.com' },
    { name: 'nauk_otl', value: cleanVal(NAUK_SID), url: 'https://www.naukri.com' },
    { name: 'is_login', value: '1',                url: 'https://www.naukri.com' },
    { name: 'persona',  value: 'default',           url: 'https://www.naukri.com' },
  ]);
}

// ── Try to Easy-Apply to a single job page ────────────────────────────────────
async function applyToJob(page, jobId, title, company) {
  try {
    // Look for Easy Apply button (not "Apply on company site" redirect)
    const applyBtn = page.locator('button.apply-button, button[id*="apply"], a.apply-button')
      .filter({ hasText: /^apply$/i })
      .first();

    const isEasyApply = await applyBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isEasyApply) {
      log(`  SKIP (no Easy Apply button): ${title} @ ${company}`);
      return 'skipped';
    }

    await applyBtn.click();
    await humanDelay();

    // Check if an apply modal/form appeared
    const modal = page.locator('.apply-modal, div[class*="applyModal"], div[id*="applyModal"], .chatbot-content').first();
    const modalVisible = await modal.isVisible({ timeout: 8000 }).catch(() => false);

    if (!modalVisible) {
      // Might have been a direct apply with no form — success
      log(`  OK (direct apply): ${title} @ ${company}`);
      return 'applied';
    }

    // ── Fill quick form fields if present ──────────────────────────────────────
    // Notice period
    const noticeField = modal.locator('input[placeholder*="notice"], input[name*="notice"], select[name*="notice"]').first();
    if (await noticeField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const tag = await noticeField.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') {
        await noticeField.selectOption({ label: NOTICE_PERIOD }).catch(() => {});
      } else {
        await noticeField.fill(NOTICE_PERIOD);
      }
      await humanDelay();
    }

    // Current CTC
    const curCTCField = modal.locator('input[placeholder*="current ctc"], input[name*="currentCtc"], input[name*="current_ctc"]').first();
    if (await curCTCField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await curCTCField.fill(CURRENT_CTC);
      await humanDelay();
    }

    // Expected CTC
    const expCTCField = modal.locator('input[placeholder*="expected ctc"], input[name*="expectedCtc"], input[name*="expected_ctc"]').first();
    if (await expCTCField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expCTCField.fill(EXPECTED_CTC);
      await humanDelay();
    }

    // Count total form fields — if more than 5 visible inputs, skip (too complex)
    const allInputs = await modal.locator('input:visible, select:visible, textarea:visible').count().catch(() => 0);
    if (allInputs > 5) {
      log(`  SKIP (complex form, ${allInputs} fields): ${title} @ ${company}`);
      // Close modal
      await page.locator('button[aria-label*="close"], .close-modal, button:has-text("Cancel")').first().click({ timeout: 3000 }).catch(() => {});
      return 'skipped';
    }

    // Submit
    const submitBtn = modal.locator('button[type="submit"], button:has-text("Apply"), button:has-text("Submit")').first();
    const canSubmit = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!canSubmit) {
      log(`  SKIP (no submit button): ${title} @ ${company}`);
      return 'skipped';
    }

    await submitBtn.click();
    await humanDelay();

    // Confirm success — look for success message or modal close
    const successMsg = page.locator('text=/applied successfully|application submitted|thank you for applying/i').first();
    const success = await successMsg.isVisible({ timeout: 5000 }).catch(() => false);

    if (success) {
      log(`  OK (applied): ${title} @ ${company} [${jobId}]`);
      return 'applied';
    } else {
      log(`  WARN (unclear result): ${title} @ ${company} — treating as applied`);
      return 'applied';
    }

  } catch (err) {
    log(`  ERROR on job ${jobId}: ${err.message.split('\n')[0]}`);
    return 'error';
  }
}

// ── Collect job links from a search results page ──────────────────────────────
async function collectJobLinks(page) {
  // Wait for job cards to load
  await page.waitForSelector('.jobTupleHeader, .job-tuple-header, article.jobTuple, .cust-job-tuple', { timeout: 15000 }).catch(() => {});

  const jobs = await page.evaluate(() => {
    const cards = document.querySelectorAll('article.jobTuple, .jobTuple, .cust-job-tuple, [class*="jobTuple"]');
    return [...cards].map(card => {
      const link = card.querySelector('a[href*="/job-listings-"], a[href*="naukri.com/"]');
      const title = card.querySelector('.title, .jobTitle, h2 a')?.textContent?.trim() || '';
      const company = card.querySelector('.comp-name, .companyInfo a, .company')?.textContent?.trim() || '';
      const href = link?.href || '';
      // Extract job ID from URL
      const idMatch = href.match(/-(\d{6,})[\?$]/);
      return { href, title, company, jobId: idMatch?.[1] || href.slice(-12) };
    }).filter(j => j.href && j.jobId);
  });

  return jobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const applied = loadApplied();
  let totalApplied = 0;
  let totalSkipped = 0;

  log(`=== Naukri Auto-Apply started | Keywords: ${KEYWORDS.join(', ')} | Max: ${MAX_APPLIES} ===`);

  const browser = await chromium.launch({
    headless: false,
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 850 },
  });

  await injectCookies(context);

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Verify session is valid
  await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('login')) {
    log('ERROR: Session cookies expired. Update NAUK_RT and NAUK_SID in GitHub Secrets.');
    await browser.close();
    process.exit(1);
  }
  log('Session verified — logged in successfully.');

  outerLoop:
  for (const keyword of KEYWORDS) {
    for (const location of LOCATIONS) {
      if (totalApplied >= MAX_APPLIES) break outerLoop;

      const searchUrl = buildSearchUrl(keyword, location);
      log(`\nSearching: "${keyword}" in ${location}`);
      log(`URL: ${searchUrl}`);

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanDelay();

        if (page.url().includes('login')) {
          log('Session expired mid-run. Stopping.');
          break outerLoop;
        }

        const jobs = await collectJobLinks(page);
        log(`  Found ${jobs.length} job listings`);

        for (const job of jobs) {
          if (totalApplied >= MAX_APPLIES) break;

          // Skip already applied
          if (applied.has(job.jobId)) {
            log(`  SKIP (already applied): ${job.title} @ ${job.company}`);
            continue;
          }

          if (!job.href) continue;

          // Open job in same tab
          await page.goto(job.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await humanDelay();

          const result = await applyToJob(page, job.jobId, job.title, job.company);

          // Mark as seen regardless of result to avoid retrying errored jobs
          applied.add(job.jobId);
          saveApplied(applied);

          if (result === 'applied') {
            totalApplied++;
            log(`  Progress: ${totalApplied}/${MAX_APPLIES} applied`);
          } else {
            totalSkipped++;
          }

          await humanDelay();

          // Go back to search results
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await humanDelay();
        }

      } catch (err) {
        await page.screenshot({ path: ERROR_SHOT }).catch(() => {});
        log(`ERROR on search "${keyword}" in ${location}: ${err.message.split('\n')[0]}`);
      }
    }
  }

  await browser.close();

  log(`\n=== Run complete: ${totalApplied} applied, ${totalSkipped} skipped ===`);

  if (totalApplied === 0 && totalSkipped === 0) {
    log('WARN: No jobs found or processed. Verify cookies and search filters.');
    process.exitCode = 1;
  }
})();
