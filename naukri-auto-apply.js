/**
 * Naukri Auto-Apply Script — Real-Time First Applicant Mode
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs hourly during Indian business hours (9 AM – 5:30 PM IST, Mon–Fri).
 * On every run it searches for the FRESHEST jobs first (sorted by &sort=f)
 * and instantly applies so you land as one of the very first applicants.
 *
 * Key features:
 *   - sort=f → jobs are sorted newest-first so you apply IMMEDIATELY to new postings
 *   - Hourly polling across 6 windows throughout the workday
 *   - Batch cap per run (BATCH_SIZE_PER_RUN) so each run applies a small slice
 *   - Daily cap (MAX_APPLIES) prevents over-application (25/day)
 *   - Idempotent: if daily quota already met, exits instantly (< 2 sec)
 *   - Strict success verification (no false positives counted toward quota)
 *   - Auto-fills notice period, CTC, location, and Yes/No radio prompts
 *   - Paginates up to 3 pages per search if needed to fill the batch
 *   - External-site jobs are skipped and never counted toward quota
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

// ── Job Search Config ─────────────────────────────────────────────────────────
// Priority order matters: preferred roles & locations are tried FIRST each run.
// Naukri searches are de-duplicated by job ID so no double-applying ever.

// Tier 1 = preferred roles | Tier 2 = broader tech roles (also applied if quota not met)
const KEYWORDS = (process.env.JOB_KEYWORDS || [
  // ── Tier 1: Preferred roles (primary target) ──────────────────────────────
  'React Developer',
  'Full Stack Developer',
  'MERN Stack Developer',
  'Frontend Developer',
  'Software Engineer',
  'AI Engineer',
  // ── Tier 2: Broader tech roles (good pay, good match) ────────────────────
  'Next.js Developer',
  'Node.js Developer',
  'JavaScript Developer',
  'TypeScript Developer',
  'Python Developer',
  'Backend Developer',
  'Web Developer',
  'Software Developer',
  'ML Engineer',
].join(','))
  .split(',').map(k => k.trim()).filter(Boolean);

// Location search order:
//   1. Bangalore (most preferred)
//   2. Hyderabad (second preferred)
//   3. Pan India (catches ALL other cities — Mumbai, Pune, Chennai, Delhi, etc.)
//   4. Remote (any-location remote roles)
// Note: "Pan India" and "Remote" use special URL formats (no "-in-city" suffix)
const LOCATIONS = (process.env.JOB_LOCATIONS || 'Bangalore,Hyderabad,Pan India,Remote')
  .split(',').map(l => l.trim()).filter(Boolean);

const EXP_MIN = parseInt(process.env.JOB_EXPERIENCE_MIN || '1', 10);
const EXP_MAX = parseInt(process.env.JOB_EXPERIENCE_MAX || '3', 10);
// EXP_FILTER_MAX: card-level senior-role gate (more lenient than URL filter).
// Blocks jobs where the MINIMUM years required > this value.
// 5 = skip roles requiring 5+ years minimum (clearly senior).
const EXP_FILTER_MAX = parseInt(process.env.EXP_FILTER_MAX || '4', 10);
const MAX_APPLIES     = parseInt(process.env.MAX_APPLIES_PER_RUN  || '25', 10); // daily cap
const BATCH_PER_RUN   = parseInt(process.env.BATCH_SIZE_PER_RUN   || '5',  10); // max per hourly run

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
const humanDelay = () => sleep(800 + Math.random() * 1200);  // 0.8–2.0 s (fast but human-looking)
const shortDelay = () => sleep(400 + Math.random() * 400);   // 0.4–0.8 s (between lightweight checks)

// ── Build Naukri search URL — sorted FRESH first ────────────────────────────
// sort=f   → reverse-chronological (newest jobs at the top)
// jobAge=0 → all jobs, not just last 24h (combined with sort=f = freshest globally)
function buildSearchUrl(keyword, location, pageNo = 1) {
  const kw = keyword.trim().toLowerCase().replace(/\s+/g, '-');
  const pageSuffix = pageNo > 1 ? `-${pageNo}` : '';

  // Special locations: "Pan India" or "Remote" don't use "-in-city" suffix
  const isPanIndia = /^(pan.?india|all|india)$/i.test(location.trim());
  const isRemote   = /^remote$/i.test(location.trim());

  let baseUrl;
  if (isPanIndia) {
    // https://www.naukri.com/react-developer-jobs?sort=f → all India
    baseUrl = `https://www.naukri.com/${kw}-jobs${pageSuffix}`;
  } else if (isRemote) {
    // https://www.naukri.com/react-developer-jobs?sort=f&wfhType=5 → remote jobs
    baseUrl = `https://www.naukri.com/${kw}-jobs${pageSuffix}`;
    return `${baseUrl}?sort=f&expFrom=${EXP_MIN}&expTo=${EXP_MAX}&wfhType=5`;
  } else {
    const loc = location.trim().toLowerCase().replace(/\s+/g, '-');
    baseUrl = `https://www.naukri.com/${kw}-jobs-in-${loc}${pageSuffix}`;
  }

  return `${baseUrl}?sort=f&expFrom=${EXP_MIN}&expTo=${EXP_MAX}`;
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

// ── Try to Apply to a single job ──────────────────────────────────────────────
// Strategy:
//   A. Check "Already Applied" → skip immediately
//   B. Find the Apply button (id="apply-button" or class="apply-button")
//   C. Click it
//   D. Wait up to 5s for EITHER a modal/chatbot OR a button-state change
//   E. If a modal appeared → fill it and submit
//   F. If no modal AND no error → treat as 1-click apply success
//      (Naukri's 1-click fires a background API; DOM doesn't always change immediately)
async function applyToJob(page, jobId, title, company) {
  try {
    // A. Check if already applied (button says "Applied" or is disabled)
    const alreadyApplied = await page.locator(
      'button:has-text("Applied"), button[class*="applied" i], .already-applied, .status-applied'
    ).first().isVisible({ timeout: 2000 }).catch(() => false);

    if (alreadyApplied) {
      log(`  SKIP (already applied on Naukri): ${title} @ ${company}`);
      return { status: 'already_applied' };
    }

    // B. Find Apply button
    // Naukri renders 2 Apply buttons:
    //   1st: in the job card content area (always visible on page load)
    //   2nd: in a sticky footer (only visible after scrolling — initially hidden)
    // We must use the FIRST visible one. Using .last() broke because it picks
    // the hidden sticky button. Use button[id="apply-button"] + waitFor visible.
    const applyBtn = page.locator('button[id="apply-button"], button.apply-button').first();

    // Wait for the button to actually become visible (up to 5s)
    const isVisible = await applyBtn.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (!isVisible) {
      log(`  SKIP (no Apply button): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'no_apply_button' };
    }

    // Check external link
    const href   = await applyBtn.getAttribute('href').catch(() => null);
    const target = await applyBtn.getAttribute('target').catch(() => null);
    if (href && !href.includes('naukri.com') && (href.startsWith('http') || target === '_blank')) {
      log(`  SKIP (external company site): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'external_site' };
    }

    // C. Click Apply (scroll into view first to make sure it's not occluded)
    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    await applyBtn.click({ timeout: 5000 }).catch(() => {});
    await humanDelay();

    // D. Check for modal/chatbot (Naukri uses several different class names)
    const modal = page.locator([
      '.apply-modal',
      'div[class*="applyModal"]',
      'div[id*="applyModal"]',
      '.chatbot-content',
      'div[class*="chatbot"]',
      'div[class*="Chatbot"]',
      '.apply-drawer',
      'div[class*="applyDrawer"]',
      '[data-testid*="apply"]',
    ].join(', ')).first();

    const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);

    if (!modalVisible) {
      // No modal appeared.
      // Naukri's "1-click apply" fires a background POST — the DOM may not update immediately.
      // Wait an extra 2s for any delayed state change (button disable, toast, URL change).
      await sleep(2000);

      // Check for explicit error that would mean failure
      const errorVisible = await page.locator(
        'text=/error|failed|not eligible|login|sign in/i'
      ).first().isVisible({ timeout: 1000 }).catch(() => false);

      const redirectedToLogin = page.url().includes('login') || page.url().includes('nlogin');

      if (redirectedToLogin || errorVisible) {
        log(`  SKIP (error/login redirect after click): ${title} @ ${company}`);
        return { status: 'skipped', reason: 'error_after_click' };
      }

      // No error → treat as successful 1-click apply
      log(`  SUCCESS (1-click apply, no modal): ${title} @ ${company} [${jobId}]`);
      return { status: 'applied' };
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
async function collectJobLinks(page, expFilterMax) {
  await page.waitForSelector(
    '.cust-job-tuple, [class*="sjw__tuple"], article.jobTuple, .jobTuple, [class*="jobTuple"]',
    { timeout: 15000 }
  ).catch(() => {});

  const jobs = await page.evaluate((expFilterMax) => {
    const cards = document.querySelectorAll('.cust-job-tuple, [class*="sjw__tuple"], article.jobTuple, .jobTuple, [class*="jobTuple"]');
    return [...cards].map(card => {
      const link    = card.querySelector('a[href*="/job-listings-"]');
      const title   = card.querySelector('.title, .jobTitle, h2 a')?.textContent?.trim() || '';
      const company = card.querySelector('.comp-name, .companyInfo a, .company, .client-company-name')?.textContent?.trim() || '';
      const href    = link?.href || '';

      // Extract job ID from URL (last 12-digit number segment)
      const idMatch = href.match(/-(\d{10,})(?:[?]|$)/);
      const jobId   = idMatch?.[1] || href.slice(-12);

      // Extract experience required from the card.
      // .expwdth is Naukri's specific experience cell class — most reliable.
      // Fall back to extracting from full card text if not found.
      const expEl   = card.querySelector('.expwdth');
      const expText = expEl?.textContent?.trim() || '';
      // Regex: match "1 - 3 Yrs" or "4-9 Yrs" or "0 to 2 Yrs"
      const expNums = expText.match(/(\d+)(?:\s*[-\u2013to]+\s*(\d+))?\s*Yr/i);
      // If exp text not found in .expwdth, default minExp to 0 (don't block)
      const minExp  = expNums ? parseInt(expNums[1], 10) : 0;

      return { href, title, company, jobId, minExp, expText };
    })
    .filter(j => j.href && j.jobId)
    // Only block CLEARLY senior roles (min experience > EXP_FILTER_MAX)
    // e.g. EXP_FILTER_MAX=4 blocks jobs requiring 5+ years minimum
    .filter(j => j.minExp <= expFilterMax);
  }, expFilterMax);

  return jobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const todayIST = getISTDate();
  const rawRecords = loadAppliedData();

  // Only track CONFIRMED APPLICATIONS in seenIds.
  // Skipped/error jobs are NOT added — they will be retried on future runs
  // (e.g. an external-site job might add Easy Apply later, or a page error was transient).
  const seenIds = new Set(
    rawRecords
      .filter(item => item.status === 'applied' || typeof item === 'string')
      .map(item => (typeof item === 'string' ? item : item.id))
  );

  // Count confirmed applications already made today
  const appliedTodayCount = rawRecords.filter(item =>
    typeof item === 'object' && item.date === todayIST && item.status === 'applied'
  ).length;

  log(`=== Naukri Auto-Apply | ${todayIST} ${getISTTime()} IST | Today: ${appliedTodayCount}/${MAX_APPLIES} | Batch cap: ${BATCH_PER_RUN} ===`);

  if (appliedTodayCount >= MAX_APPLIES) {
    log(`✅ Daily quota of ${MAX_APPLIES} already fulfilled today. Nothing to do.`);
    process.exit(0);
  }

  let totalAppliedThisRun = 0;
  let totalSkippedThisRun = 0;

  // Per-run batch: apply at most BATCH_PER_RUN this run (spread across day)
  // Also never exceed the remaining daily quota
  const remainingQuota = MAX_APPLIES - appliedTodayCount;
  const batchTarget = Math.min(BATCH_PER_RUN, remainingQuota);

  log(`🎯 Batch target for this run: ${batchTarget} applications (${remainingQuota} remaining toward daily cap of ${MAX_APPLIES})`);   

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
      // Paginate up to 3 pages per keyword/location to fill the batch
      for (let pageNo = 1; pageNo <= 3; pageNo++) {
        if (totalAppliedThisRun >= batchTarget) break outerLoop;

        const searchUrl = buildSearchUrl(keyword, location, pageNo);
        log(`\n🔍 Searching: "${keyword}" in ${location} (Page ${pageNo}) → ${searchUrl}`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await humanDelay();

          if (page.url().includes('login')) {
            log('Session expired mid-run. Stopping.');
            break outerLoop;
          }

          const jobs = await collectJobLinks(page, EXP_FILTER_MAX);
          const filtered = jobs.filter(j => !seenIds.has(j.jobId));
          log(`  Found ${jobs.length} listings on page ${pageNo} (${filtered.length} fresh, ${jobs.length - filtered.length} already seen)`);

          if (filtered.length === 0) {
            if (jobs.length === 0) break; // No jobs at all → stop pagination
            continue;                     // All seen → try next page
          }

          for (const job of filtered) {
            if (totalAppliedThisRun >= batchTarget) break outerLoop; // Batch cap guard

            // Open job page
            await page.goto(job.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await humanDelay();

            const result = await applyToJob(page, job.jobId, job.title, job.company);

            // Only persist APPLIED jobs to JSON (keeps file small and seenIds clean).
            // Skipped/error jobs are intentionally NOT saved — they will be retried tomorrow.
            if (result.status === 'applied') {
              const record = {
                id: job.jobId,
                date: todayIST,
                time: getISTTime(),
                title: job.title,
                company: job.company,
                status: 'applied',
              };
              rawRecords.push(record);
              saveAppliedData(rawRecords);
              seenIds.add(job.jobId); // Prevent re-applying in same run
              totalAppliedThisRun++;
              log(`  ✅ Applied ${totalAppliedThisRun}/${batchTarget} this run | Total today: ${appliedTodayCount + totalAppliedThisRun}/${MAX_APPLIES}`);
            } else {
              totalSkippedThisRun++;
              log(`  SKIP (${result.reason || result.status}): ${job.title} @ ${job.company}`);
            }

            await shortDelay();
            // No need to reload search results — we already have all job links in memory.
            // The next iteration of the for-loop will navigate directly to the next job page.
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
  const remaining = MAX_APPLIES - finalTodayTotal;
  log(`\n=== Run done: +${totalAppliedThisRun} applied this run | ${finalTodayTotal}/${MAX_APPLIES} today | ${remaining} remaining for next run ===`);
})();
