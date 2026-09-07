/**
 * Naukri Auto-Apply Script (Enhanced & Verified)
 * ─────────────────────────────────────────────────────────────────────────────
 * Searches Naukri for freshly posted jobs matching your target roles and
 * applies to up to MAX_APPLIES_PER_RUN Easy-Apply listings per day.
 *
 * Key features:
 *   - Strictly verifies application success (no false positives)
 *   - Paginates search results (page 1, 2, 3) to reach full daily quota
 *   - Tracks daily count in IST timezone (prevents duplicate runs on same day)
 *   - Handles quick forms and auto-fills notice, CTC, location & Yes/No prompts
 *   - Skips external company redirects and complex multi-page questionnaires
 *   - Idempotent: safe to run multiple times per day (exits if quota already met)
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
const EXPECTED_CTC  = process.env.EXPECTED_CTC  || '6';
const CURRENT_LOC   = process.env.LOCATION      || 'Manipal, Udupi';

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE     = path.join(__dirname, 'naukri-apply.log');
const ERROR_SHOT   = path.join(__dirname, 'naukri-apply-error.png');

// ── Helpers ───────────────────────────────────────────────────────────────────
const getISTDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // "YYYY-MM-DD"
const getISTTime = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

const log = (msg) => {
  const line = `[${getISTDate()} ${getISTTime()} IST] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

function loadAppliedData() {
  try {
    const raw = JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
    return [];
  } catch {
    return [];
  }
}

function saveAppliedData(records) {
  fs.writeFileSync(APPLIED_FILE, JSON.stringify(records, null, 2));
}

const cleanVal = (v) => (v ? String(v).replace(/[\r\n"']/g, '').trim() : '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = () => sleep(1500 + Math.random() * 2000); // 1.5–3.5 s

// ── Build Naukri search URL with pagination ───────────────────────────────────
function buildSearchUrl(keyword, location, pageNo = 1) {
  const kw  = encodeURIComponent(keyword.trim());
  const loc = encodeURIComponent(location.trim());
  const pageSuffix = pageNo > 1 ? `-${pageNo}` : '';
  return `https://www.naukri.com/${kw.toLowerCase().replace(/%20/g, '-')}-jobs-in-${loc.toLowerCase().replace(/%20/g, '-')}${pageSuffix}?jobAge=1&expFrom=${EXP_MIN}&expTo=${EXP_MAX}`;
}

// ── Inject Naukri session cookies ─────────────────────────────────────────────
async function injectCookies(context) {
  await context.addCookies([
    { name: 'nauk_rt',  value: cleanVal(NAUK_RT),  url: 'https://www.naukri.com' },
    { name: 'nauk_sid', value: cleanVal(NAUK_SID), url: 'https://www.naukri.com' },
    { name: 'nauk_otl', value: cleanVal(NAUK_SID), url: 'https://www.naukri.com' },
    { name: 'is_login', value: '1',                url: 'https://www.naukri.com' },
    { name: 'persona',  value: 'default',          url: 'https://www.naukri.com' },
  ]);
}

// ── Try to Apply to a single job with strict verification ─────────────────────
async function applyToJob(page, jobId, title, company) {
  try {
    // 1. Check if page already shows "Applied"
    const alreadyApplied = await page.locator('button:has-text("Applied"), span:has-text("Applied"), .already-applied, .status-applied')
      .first()
      .isVisible({ timeout: 2500 })
      .catch(() => false);

    if (alreadyApplied) {
      log(`  SKIP (already applied on Naukri): ${title} @ ${company}`);
      return { status: 'already_applied' };
    }

    // 2. Look for the apply button
    const applyBtn = page.locator('button.apply-button, button[id*="apply"], a.apply-button, button:has-text("Apply"), a:has-text("Apply")')
      .filter({ hasNotText: /company|employer|external|partner/i })
      .first();

    const isVisible = await applyBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isVisible) {
      log(`  SKIP (no Easy Apply button): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'no_apply_button' };
    }

    // Check if it's an external link
    const href = await applyBtn.getAttribute('href').catch(() => null);
    const target = await applyBtn.getAttribute('target').catch(() => null);
    if (href && !href.includes('naukri.com') && (href.startsWith('http') || target === '_blank')) {
      log(`  SKIP (redirects to external company site): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'external_site' };
    }

    // 3. Click Apply
    await applyBtn.click({ timeout: 5000 }).catch(() => {});
    await humanDelay();

    // 4. Check if an apply modal / chatbot / drawer opened
    const modal = page.locator('.apply-modal, div[class*="applyModal"], div[id*="applyModal"], .chatbot-content, .drawer-wrapper, .apply-drawer').first();
    const modalVisible = await modal.isVisible({ timeout: 4000 }).catch(() => false);

    if (!modalVisible) {
      // Check if 1-click apply succeeded immediately (without modal)
      const confirmedDirect = await page.locator('button:has-text("Applied"), span:has-text("Applied"), text=/applied successfully|application submitted|already applied/i')
        .first()
        .isVisible({ timeout: 4000 })
        .catch(() => false);

      if (confirmedDirect) {
        log(`  SUCCESS (1-click direct apply): ${title} @ ${company} [${jobId}]`);
        return { status: 'applied' };
      } else {
        log(`  SKIP (unconfirmed apply click): ${title} @ ${company}`);
        return { status: 'skipped', reason: 'unconfirmed' };
      }
    }

    // 5. Modal appeared: fill standard fields
    // Notice period
    const noticeField = modal.locator('input[placeholder*="notice" i], input[name*="notice" i], select[name*="notice" i]').first();
    if (await noticeField.isVisible({ timeout: 1500 }).catch(() => false)) {
      const tag = await noticeField.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') {
        await noticeField.selectOption({ label: NOTICE_PERIOD }).catch(() => {});
      } else {
        await noticeField.fill(NOTICE_PERIOD).catch(() => {});
      }
      await sleep(500);
    }

    // Current CTC
    const curCTCField = modal.locator('input[placeholder*="current ctc" i], input[name*="currentCtc" i], input[name*="current_ctc" i]').first();
    if (await curCTCField.isVisible({ timeout: 1500 }).catch(() => false)) {
      await curCTCField.fill(CURRENT_CTC).catch(() => {});
      await sleep(500);
    }

    // Expected CTC
    const expCTCField = modal.locator('input[placeholder*="expected ctc" i], input[name*="expectedCtc" i], input[name*="expected_ctc" i]').first();
    if (await expCTCField.isVisible({ timeout: 1500 }).catch(() => false)) {
      await expCTCField.fill(EXPECTED_CTC).catch(() => {});
      await sleep(500);
    }

    // Current Location
    const locField = modal.locator('input[placeholder*="city" i], input[placeholder*="location" i], input[name*="location" i]').first();
    if (await locField.isVisible({ timeout: 1500 }).catch(() => false)) {
      await locField.fill(CURRENT_LOC).catch(() => {});
      await sleep(500);
    }

    // Handle standard Yes/No radio buttons (e.g. willing to relocate, open for hybrid/remote)
    const yesRadios = modal.locator('input[type="radio"][value*="yes" i], input[type="radio"][value="1"], label:has-text("Yes") input[type="radio"]');
    const radioCount = await yesRadios.count().catch(() => 0);
    for (let r = 0; r < Math.min(radioCount, 3); r++) {
      await yesRadios.nth(r).check().catch(() => {});
      await sleep(300);
    }

    // Check count of unhandled fields — skip if form is too complex (e.g., custom essay questions)
    const allInputs = await modal.locator('input:visible, select:visible, textarea:visible').count().catch(() => 0);
    if (allInputs > 6) {
      log(`  SKIP (complex questionnaire, ${allInputs} fields): ${title} @ ${company}`);
      await page.locator('button[aria-label*="close" i], .close-modal, button:has-text("Cancel"), .crossIcon').first().click({ timeout: 2000 }).catch(() => {});
      return { status: 'skipped', reason: 'complex_form' };
    }

    // 6. Submit the form
    const submitBtn = modal.locator('button[type="submit"], button:has-text("Apply"), button:has-text("Submit"), button:has-text("Save")').first();
    const canSubmit = await submitBtn.isVisible({ timeout: 2500 }).catch(() => false);
    if (!canSubmit) {
      log(`  SKIP (no submit button): ${title} @ ${company}`);
      await page.locator('button[aria-label*="close" i], .close-modal, button:has-text("Cancel"), .crossIcon').first().click({ timeout: 2000 }).catch(() => {});
      return { status: 'skipped', reason: 'no_submit_btn' };
    }

    await submitBtn.click();
    await humanDelay();

    // 7. Verify actual success
    const successMsg = page.locator('text=/applied successfully|application submitted|thank you for applying|already applied/i, button:has-text("Applied")').first();
    const success = await successMsg.isVisible({ timeout: 6000 }).catch(() => false);

    if (success) {
      log(`  SUCCESS (form applied): ${title} @ ${company} [${jobId}]`);
      return { status: 'applied' };
    } else {
      // Close modal to keep browser clean
      await page.locator('button[aria-label*="close" i], .close-modal, button:has-text("Cancel"), .crossIcon').first().click({ timeout: 2000 }).catch(() => {});
      log(`  SKIP (form submission not confirmed): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'form_failed' };
    }

  } catch (err) {
    log(`  ERROR on job ${jobId}: ${err.message.split('\n')[0]}`);
    return { status: 'error', error: err.message.split('\n')[0] };
  }
}

// ── Collect job links from a search results page ──────────────────────────────
async function collectJobLinks(page) {
  await page.waitForSelector('.jobTupleHeader, .job-tuple-header, article.jobTuple, .cust-job-tuple, div[class*="jobTuple"]', { timeout: 15000 }).catch(() => {});

  const jobs = await page.evaluate(() => {
    const cards = document.querySelectorAll('article.jobTuple, .jobTuple, .cust-job-tuple, [class*="jobTuple"]');
    return [...cards].map(card => {
      const link = card.querySelector('a[href*="/job-listings-"], a[href*="naukri.com/"]');
      const title = card.querySelector('.title, .jobTitle, h2 a')?.textContent?.trim() || '';
      const company = card.querySelector('.comp-name, .companyInfo a, .company')?.textContent?.trim() || '';
      const href = link?.href || '';
      const idMatch = href.match(/-(\d{6,})[\?$]/);
      return { href, title, company, jobId: idMatch?.[1] || href.slice(-12) };
    }).filter(j => j.href && j.jobId);
  });

  return jobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const todayIST = getISTDate();
  const rawRecords = loadAppliedData();

  // Parse existing IDs (supports backward compatibility with string array)
  const seenIds = new Set(rawRecords.map(item => (typeof item === 'string' ? item : item.id)));

  // Count confirmed applications already made today
  const appliedTodayCount = rawRecords.filter(item =>
    typeof item === 'object' && item.date === todayIST && item.status === 'applied'
  ).length;

  log(`=== Naukri Auto-Apply started | Date: ${todayIST} | Current Today Count: ${appliedTodayCount}/${MAX_APPLIES} ===`);

  if (appliedTodayCount >= MAX_APPLIES) {
    log(`Daily quota of ${MAX_APPLIES} applications already fulfilled today (${todayIST}). Exiting.`);
    process.exit(0);
  }

  let totalAppliedThisRun = 0;
  let totalSkippedThisRun = 0;
  const remainingQuota = MAX_APPLIES - appliedTodayCount;

  log(`Target applications to make in this run: ${remainingQuota}`);

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
  log('Verifying Naukri session...');
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
      // Search up to 3 pages per keyword/location to find enough real Easy Apply jobs
      for (let pageNo = 1; pageNo <= 3; pageNo++) {
        if (totalAppliedThisRun >= remainingQuota) break outerLoop;

        const searchUrl = buildSearchUrl(keyword, location, pageNo);
        log(`\nSearching: "${keyword}" in ${location} (Page ${pageNo})`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await humanDelay();

          if (page.url().includes('login')) {
            log('Session expired mid-run. Stopping.');
            break outerLoop;
          }

          const jobs = await collectJobLinks(page);
          log(`  Found ${jobs.length} listings on page ${pageNo}`);

          if (jobs.length === 0) {
            // No more jobs for this keyword/location
            break;
          }

          for (const job of jobs) {
            if (totalAppliedThisRun >= remainingQuota) break outerLoop;

            // Skip if already processed in past or today
            if (seenIds.has(job.jobId)) {
              continue;
            }

            if (!job.href) continue;

            // Open job page
            await page.goto(job.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await humanDelay();

            const result = await applyToJob(page, job.jobId, job.title, job.company);

            // Record job in seenIds so we never touch it again
            seenIds.add(job.jobId);

            const record = {
              id: job.jobId,
              date: todayIST,
              time: getISTTime(),
              title: job.title,
              company: job.company,
              status: result.status,
              ...(result.reason ? { reason: result.reason } : {})
            };

            rawRecords.push(record);
            saveAppliedData(rawRecords);

            if (result.status === 'applied') {
              totalAppliedThisRun++;
              log(`  >>> Total Applied Today: ${appliedTodayCount + totalAppliedThisRun}/${MAX_APPLIES}`);
            } else {
              totalSkippedThisRun++;
            }

            await humanDelay();

            // Return to search results
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await humanDelay();
          }

        } catch (err) {
          await page.screenshot({ path: ERROR_SHOT }).catch(() => {});
          log(`ERROR on search "${keyword}" in ${location} (Page ${pageNo}): ${err.message.split('\n')[0]}`);
        }
      }
    }
  }

  await browser.close();

  const finalTodayTotal = appliedTodayCount + totalAppliedThisRun;
  log(`\n=== Run finished: ${totalAppliedThisRun} newly applied, ${totalSkippedThisRun} skipped/seen. Total for ${todayIST}: ${finalTodayTotal}/${MAX_APPLIES} ===`);
})();
