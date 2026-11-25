/**
 * NaukriGulf Auto-Apply Script — Real-Time First Applicant Mode + Recruiter Activity Sync
 * ───────────────────────────────────────────────────────────────────────────────────────
 * Runs hourly during Gulf & Indian business hours (Mon–Fri).
 * Searches for the FRESHEST jobs on NaukriGulf (sorted by ?sort=date),
 * pre-filters for native "Easy Apply" developer roles, applies automatically,
 * and syncs Recruiter Actions & Application Status updates for the dashboard.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Credentials ───────────────────────────────────────────────────────────────
const EMAIL    = (process.env.NAUKRIGULF_EMAIL || '').trim();
const PASSWORD = (process.env.NAUKRIGULF_PASSWORD || '').trim();

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: NAUKRIGULF_EMAIL and NAUKRIGULF_PASSWORD are required in .env or GitHub Secrets.');
  process.exit(1);
}

// ── Job Search Config ─────────────────────────────────────────────────────────
const KEYWORDS = (process.env.GULF_JOB_KEYWORDS || [
  // Tier 1: AI, GenAI, ML & Core Software Engineering roles
  'AI Engineer',
  'Artificial Intelligence',
  'Generative AI',
  'Machine Learning Engineer',
  'Full Stack Developer',
  'Software Engineer',
  'React Developer',
  'Python Developer',
  'Frontend Developer',
  'Backend Developer',
  // Tier 2: Broader Tech, Data, Cloud & Development roles
  'Node.js Developer',
  'Next.js Developer',
  'MERN Stack Developer',
  'JavaScript Developer',
  'TypeScript Developer',
  'Data Scientist',
  'Data Engineer',
  'DevOps Engineer',
  'Cloud Engineer',
  'Mobile App Developer',
  'Flutter Developer',
  'Web Developer',
  'Software Developer',
  'IT Engineer',
].join(','))
  .split(',').map(k => k.trim()).filter(Boolean);

// Gulf Locations priority order:
// UAE (all emirates including Dubai/Abu Dhabi/Sharjah), Saudi Arabia, Qatar, Oman, Kuwait, Bahrain
const LOCATIONS = (process.env.GULF_JOB_LOCATIONS || 'UAE,Dubai,Abu Dhabi,Saudi Arabia,Qatar,Oman,Kuwait,Bahrain')
  .split(',').map(l => l.trim()).filter(Boolean);

const EXP_FILTER_MAX = parseInt(process.env.EXP_FILTER_MAX      || '4',  10);
const MAX_APPLIES    = parseInt(process.env.MAX_APPLIES_PER_RUN || '15', 10); // daily cap (15/day for Gulf)
const BATCH_PER_RUN  = parseInt(process.env.BATCH_SIZE_PER_RUN  || '3',  10); // per peak-hour run

const NOTICE_PERIOD  = process.env.NOTICE_PERIOD || '15 days';
const EXPECTED_AED   = process.env.EXPECTED_SALARY_AED || '6000';

const APPLIED_FILE   = path.join(__dirname, 'applied-jobs-gulf.json');
const ACTIVITY_FILE  = path.join(__dirname, 'recruiter-activity-gulf.json');
const LOG_FILE       = path.join(__dirname, 'naukrigulf-apply.log');
const ERROR_SHOT     = path.join(__dirname, 'naukrigulf-apply-error.png');

// ── Helpers ───────────────────────────────────────────────────────────────────
const getISTDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = () => sleep(800 + Math.random() * 1200);
const shortDelay = () => sleep(400 + Math.random() * 400);

// ── Build NaukriGulf search URL — sorted FRESH first (?sort=date) ───────────
function buildSearchUrl(keyword, location, pageNo = 1) {
  const kwSlug = keyword.trim().toLowerCase()
    .replace(/\.js\b/g, 'js')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const locSlug = location.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const pageSuffix = pageNo > 1 ? `-${pageNo}` : '';

  return `https://www.naukrigulf.com/${kwSlug}-jobs-in-${locSlug}${pageSuffix}?sort=date`;
}

// ── Job Title Relevance Filter (All Tech, Software & AI roles) ────────────────
const RELEVANT_TITLE_RE = /\b(ai\b|a\.i\.|artificial\s+intelligence|machine\s+learning|\bml\b|deep\s+learning|genai|gen\s+ai|generative\s+ai|agentic|llm|nlp|computer\s+vision|data\s+scientist|data\s+science|data\s+engineer|mlops|prompt\s+engineer|developer|engineer|engineering|sde\b|programmer|coder|architect|technical|tech\b|software|full[\s-]?stack|fullstack|frontend|front[\s-]?end|backend|back[\s-]?end|web\b|react|next\.?js|nextjs|node\.?js|nodejs|express|nest\.?js|nestjs|mern|mean|angular|vue|javascript|typescript|python|django|fastapi|flask|java\b|spring|\.net|dotnet|\bc#\b|\bc\+\+|golang|rust|php|laravel|wordpress|shopify|ruby|scala|kotlin|swift|flutter|react\s+native|android|ios\b|mobile|cloud|devops|sre\b|platform|aws|azure|gcp|kubernetes|docker|cyber\s*security|infosec|security\s+engineer|blockchain|web3|automation|rpa|erp|crm|sap\b|salesforce|odoo|servicenow|api\b|database|sql|nosql|it\s+specialist|application|systems?\s+analyst)/i;

const EXCLUDE_TITLE_RE = /(talent\s+acquisition|recruiter|recruitment|\bhr\b|human\s+resource|\bsales\b|tele[\s-]?sales|account\s+executive|account\s+manager|business\s+development|\bbdm\b|\bbde\b|\bbpo\b|call\s+center|customer\s+service|customer\s+care|voice\s+process|receptionist|front\s+desk|secretary|cashier|accountant|auditor|bookkeeper|data\s+entry|office\s+boy|driver|cleaner|nurse|pharmacist|doctor|physician|chef|waiter|barista|real\s+estate|property\s+consultant|civil\s+engineer|mechanical\s+engineer|electrical\s+engineer|chemical\s+engineer|petroleum\s+engineer|drilling|hvac|bim\b|mep\b|structural\s+engineer|quantity\s+surveyor|land\s+surveyor|site\s+engineer|construction|piping\s+engineer|marine\s+engineer|metallurg|geolog|architectural\s+draft|interior\s+design|fashion\s+design|jewellery)/i;

function isRelevantJobTitle(title) {
  if (!title) return false;
  return RELEVANT_TITLE_RE.test(title) && !EXCLUDE_TITLE_RE.test(title);
}

// ── Collect Easy Apply job links from NaukriGulf search page ──────────────────
async function collectJobLinks(page, expFilterMax) {
  await page.waitForSelector('div.ng-box.srp-tuple, a.info-position', { timeout: 15000 }).catch(() => {});

  return page.evaluate((expFilterMax) => {
    const cards = document.querySelectorAll('div.ng-box.srp-tuple');
    return [...cards].map(card => {
      const link    = card.querySelector('a.info-position');
      const title   = card.querySelector('.designation-title')?.textContent?.trim() || link?.textContent?.trim() || '';
      const company = card.querySelector('.info-org')?.textContent?.trim() || '';
      const locText = card.querySelector('li.info-loc')?.textContent?.trim() || '';
      const expText = card.querySelector('li.info-exp')?.textContent?.trim() || '';
      const href    = link?.href || '';

      // Extract NaukriGulf Job ID from "-jid-251126500153"
      const idMatch = href.match(/-jid-(\d+)/i) || href.match(/-(\d{8,})(?:[?]|$)/);
      const jobId   = idMatch?.[1] || '';

      // Parse minimum years of experience required ("0 - 3 Years" -> 0)
      const expNums = expText.match(/(\d+)(?:\s*[-\u2013to]+\s*(\d+))?\s*Year/i);
      const minExp  = expNums ? parseInt(expNums[1], 10) : 0;

      // Pre-filter on search card:
      // Cards with class "web-job" or missing ".easy" are external company site redirects!
      const isWebJob = Boolean(link?.className?.includes('web-job') || card.querySelector('.webjob'));
      const isEasy   = Boolean(card.querySelector('.easy')) && !isWebJob;

      return { href, title, company, location: locText, jobId, minExp, expText, isEasy, isWebJob };
    })
    .filter(j => j.href && j.jobId)
    .filter(j => j.isEasy)
    .filter(j => j.minExp <= expFilterMax);
  }, expFilterMax);
}

// ── Try to Apply to a single NaukriGulf job ───────────────────────────────────
async function applyToJob(page, job) {
  const { jobId, title, company } = job;
  try {
    // A. Check if already applied
    const alreadyApplied = await page.locator(
      'p.applied-text, .jd-button:has-text("Already Applied"), text=/Already Applied/i'
    ).first().isVisible({ timeout: 2000 }).catch(() => false);

    if (alreadyApplied) {
      log(`  SKIP (already applied on NaukriGulf): ${title} @ ${company}`);
      return { status: 'already_applied' };
    }

    // B. Find Easy Apply button
    const applyBtn = page.locator('button.jd-button:has-text("Easy Apply"), button.ng-btn.jd-button.blue').first();
    const isVisible = await applyBtn.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (!isVisible) {
      log(`  SKIP (no Easy Apply button): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'no_apply_button' };
    }

    const btnText = ((await applyBtn.textContent().catch(() => '')) || '').trim();
    if (/company\s*site|external/i.test(btnText)) {
      log(`  SKIP (external company site): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'external_site' };
    }

    const pagesBefore = page.context().pages().length;

    // C. Click Easy Apply
    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    await applyBtn.click({ timeout: 5000 }).catch(() => {});
    await sleep(3000);

    // D. Close any unexpected external popup tab
    const currentPages = page.context().pages();
    if (currentPages.length > pagesBefore) {
      for (const p of currentPages) {
        if (p !== page) await p.close().catch(() => {});
      }
      log(`  SKIP (opened external tab): ${title} @ ${company}`);
      return { status: 'skipped', reason: 'external_site' };
    }

    // E. Check if 1-click Easy Apply succeeded immediately (redirects to /jobseeker/simJobs or shows success banner)
    const immediateSuccess =
      page.url().includes('/jobseeker/simJobs') ||
      (await page.locator('text=/You have successfully applied|Application Submitted|Already Applied/i').first().isVisible({ timeout: 2000 }).catch(() => false));

    if (immediateSuccess) {
      log(`  SUCCESS (1-click Easy Apply): ${title} @ ${company} [${jobId}]`);
      return { status: 'applied' };
    }

    // F. Check if an employer questionnaire / form modal appeared
    const formOrModal = page.locator('form:visible, .modal:visible, [class*="modal" i]:visible, [class*="ques" i]:visible').first();
    if (await formOrModal.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Fill standard radio buttons (select Yes / first option)
      const radios = page.locator('input[type="radio"][value*="yes" i], label:has-text("Yes") input[type="radio"]');
      const rCount = await radios.count().catch(() => 0);
      for (let i = 0; i < Math.min(rCount, 4); i++) {
        await radios.nth(i).check().catch(() => {});
      }

      // Fill notice period or salary if requested
      const noticeInput = page.locator('input[placeholder*="notice" i], input[name*="notice" i]').first();
      if (await noticeInput.isVisible({ timeout: 500 }).catch(() => false)) {
        await noticeInput.fill(NOTICE_PERIOD).catch(() => {});
      }
      const salaryInput = page.locator('input[placeholder*="salary" i], input[name*="salary" i], input[placeholder*="ctc" i]').first();
      if (await salaryInput.isVisible({ timeout: 500 }).catch(() => false)) {
        await salaryInput.fill(EXPECTED_AED).catch(() => {});
      }

      const submitBtn = page.locator('button[type="submit"]:has-text("Apply"), button[type="submit"]:has-text("Submit"), button.ng-btn.blue:has-text("Submit"), button.ng-btn.blue:has-text("Apply")').first();
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click().catch(() => {});
        await sleep(3000);
      }

      const confirmed =
        page.url().includes('/jobseeker/simJobs') ||
        (await page.locator('text=/You have successfully applied|Application Submitted|Already Applied/i').first().isVisible({ timeout: 3000 }).catch(() => false));

      if (confirmed) {
        log(`  SUCCESS (questionnaire applied): ${title} @ ${company} [${jobId}]`);
        return { status: 'applied' };
      }
    }

    log(`  SKIP (application not confirmed): ${title} @ ${company}`);
    return { status: 'skipped', reason: 'unconfirmed' };
  } catch (err) {
    log(`  ERROR on job ${jobId}: ${err.message.split('\n')[0]}`);
    return { status: 'error', error: err.message.split('\n')[0] };
  }
}

// ── Sync Recruiter Activity & Application Status from NaukriGulf ──────────────
async function syncRecruiterActivity(page, rawRecords) {
  try {
    log('\n📊 Syncing NaukriGulf Application Status & Recruiter Actions...');

    // 1. Scrape Application Status Updates (whtma)
    await page.goto('https://www.naukrigulf.com/mnj/userProfile/whtma', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);

    const statusCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('article.ng-card.applied-job');
      return [...cards].map(c => ({
        title: c.querySelector('h2.headline')?.textContent?.trim() || '',
        company: c.querySelector('p.company')?.textContent?.trim() || '',
        location: (c.querySelector('p.location')?.textContent || '').replace(/^R/, '').trim(),
        recruiterStatus: c.querySelector('span.application, p.status')?.textContent?.trim() || 'Application Submitted',
      }));
    });

    // Update matching records in rawRecords with live recruiterStatus
    for (const sc of statusCards) {
      const match = [...rawRecords].reverse().find(r =>
        typeof r === 'object' &&
        r.status === 'applied' &&
        r.title &&
        sc.title &&
        r.title.toLowerCase() === sc.title.toLowerCase() &&
        (!sc.company || !r.company || r.company.toLowerCase() === sc.company.toLowerCase())
      );
      if (match) {
        match.recruiterStatus = sc.recruiterStatus;
        if (!match.location && sc.location) match.location = sc.location;
      }
    }

    // 2. Scrape Employer Actions & Profile Views (whtmcv)
    await page.goto('https://www.naukrigulf.com/mnj/userProfile/whtmcv', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);

    const cvActivity = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const searchAppMatch = text.match(/(\d+)\s*Search Appearances/i);
      const viewsMatch     = text.match(/(\d+)\s*Profile Views/i);
      const downloadsMatch = text.match(/(\d+)\s*Profile Downloads/i);
      const contactedMatch = text.match(/(\d+)\s*Contacted by Email/i);

      return {
        searchAppearances: searchAppMatch ? parseInt(searchAppMatch[1], 10) : 0,
        profileViews: viewsMatch ? parseInt(viewsMatch[1], 10) : 0,
        profileDownloads: downloadsMatch ? parseInt(downloadsMatch[1], 10) : 0,
        contactedByEmail: contactedMatch ? parseInt(contactedMatch[1], 10) : 0,
      };
    });

    const summary = {
      platform: 'naukrigulf',
      lastSyncedAt: `${getISTDate()} ${getISTTime()} IST`,
      metrics: cvActivity,
      recentApplicationStatuses: statusCards,
    };

    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(summary, null, 2));
    saveAppliedData(rawRecords);
    log(`📊 Synced ${statusCards.length} application statuses | Views: ${cvActivity.profileViews}, Downloads: ${cvActivity.profileDownloads}, Search Appearances: ${cvActivity.searchAppearances}`);
  } catch (err) {
    log(`WARN: Could not sync recruiter activity: ${err.message.split('\n')[0]}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const todayIST = getISTDate();
  const rawRecords = loadAppliedData();

  const seenIds = new Set(
    rawRecords
      .filter(item => {
        if (typeof item === 'string') return true;
        if (item.status === 'applied' || item.status === 'already_applied' || item.reason === 'external_site') return true;
        if (item.date === todayIST) return true;
        return false;
      })
      .map(item => (typeof item === 'string' ? item : item.id))
  );

  const appliedTodayCount = rawRecords.filter(item =>
    typeof item === 'object' && item.date === todayIST && item.status === 'applied'
  ).length;

  log(`=== NaukriGulf Auto-Apply | ${todayIST} ${getISTTime()} IST | Today: ${appliedTodayCount}/${MAX_APPLIES} | Batch cap: ${BATCH_PER_RUN} ===`);

  if (appliedTodayCount >= MAX_APPLIES) {
    log(`✅ Daily quota of ${MAX_APPLIES} already fulfilled today on NaukriGulf. Nothing to do.`);
    process.exit(0);
  }

  let totalAppliedThisRun = 0;
  let totalSkippedThisRun = 0;
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
      ...(process.platform === 'win32' ? ['--window-position=-32000,-32000'] : []),
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 850 },
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Login to NaukriGulf
  log('Logging into NaukriGulf...');
  await page.goto('https://www.naukrigulf.com/jobseeker/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const emailInput = page.locator('#loginPageLoginEmail, input[name="username"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 25000 });
  await emailInput.fill(EMAIL);
  await page.locator('#loginPassword, input[name="loginPassword"]').first().fill(PASSWORD);
  await page.locator('#loginPageLoginSubmit, button.login-btn').first().click();
  await sleep(5000);

  if (page.url().includes('/login')) {
    log('ERROR: NaukriGulf login failed. Check NAUKRIGULF_EMAIL and NAUKRIGULF_PASSWORD.');
    await browser.close();
    process.exit(1);
  }
  log('Logged into NaukriGulf successfully.');

  // Loop Location -> Keyword -> Page so each batch of 3 covers AI Engineer, Full Stack,
  // Software Engineer, React, Python, Data/ML, Cloud/DevOps, and all tech roles across UAE & Gulf!
  outerLoop:
  for (const location of LOCATIONS) {
    for (const keyword of KEYWORDS) {
      for (let pageNo = 1; pageNo <= 2; pageNo++) {
        if (totalAppliedThisRun >= batchTarget) break outerLoop;

        const searchUrl = buildSearchUrl(keyword, location, pageNo);
        log(`\n🔍 Searching NaukriGulf: "${keyword}" in ${location} (Page ${pageNo}) → ${searchUrl}`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await humanDelay();

          const jobs = await collectJobLinks(page, EXP_FILTER_MAX);
          const relevant = jobs.filter(j => isRelevantJobTitle(j.title));
          const filtered = relevant.filter(j => !seenIds.has(j.jobId));
          log(`  Found ${jobs.length} Easy Apply listings (${relevant.length} relevant dev roles, ${filtered.length} fresh, ${relevant.length - filtered.length} already seen)`);

          if (filtered.length === 0) {
            if (jobs.length === 0) break;
            continue;
          }

          for (const job of filtered) {
            if (totalAppliedThisRun >= batchTarget) break outerLoop;

            await page.goto(job.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await humanDelay();

            const result = await applyToJob(page, job);

            if (result.status === 'applied') {
              const record = {
                id: job.jobId,
                date: todayIST,
                time: getISTTime(),
                title: job.title,
                company: job.company,
                location: job.location,
                url: job.href,
                status: 'applied',
                recruiterStatus: 'Application Submitted',
              };
              rawRecords.push(record);
              saveAppliedData(rawRecords);
              seenIds.add(job.jobId);
              totalAppliedThisRun++;
              log(`  ✅ Applied ${totalAppliedThisRun}/${batchTarget} this run | Total today: ${appliedTodayCount + totalAppliedThisRun}/${MAX_APPLIES}`);
            } else {
              totalSkippedThisRun++;
              seenIds.add(job.jobId);
              if (result.status !== 'error') {
                rawRecords.push({
                  id: job.jobId,
                  date: todayIST,
                  status: result.status,
                  reason: result.reason || result.status,
                });
                saveAppliedData(rawRecords);
              }
              log(`  SKIP (${result.reason || result.status}): ${job.title} @ ${job.company}`);
            }

            await shortDelay();
          }
        } catch (err) {
          await page.screenshot({ path: ERROR_SHOT }).catch(() => {});
          log(`ERROR on search "${keyword}" in ${location} (Page ${pageNo}): ${err.message.split('\n')[0]}`);
        }
      }
    }
  }

  // Sync recruiter actions & application statuses at the end of the run
  await syncRecruiterActivity(page, rawRecords);

  await browser.close();

  const finalTodayTotal = appliedTodayCount + totalAppliedThisRun;
  const remaining = MAX_APPLIES - finalTodayTotal;
  log(`\n=== NaukriGulf Run done: +${totalAppliedThisRun} applied this run | ${finalTodayTotal}/${MAX_APPLIES} today | ${remaining} remaining for next run ===`);
})();
