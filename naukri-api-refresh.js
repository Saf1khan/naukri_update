/**
 * Naukri Profile Refresh — API-based, no browser required!
 * Toggles a trailing "." on the resume headline via Naukri's own REST API.
 *
 * Required GitHub Secrets (Settings → Secrets → Actions):
 *   NAUK_RT         — Naukri refresh token (nauk_rt cookie value)
 *   NAUK_SID        — Naukri session ID (nauk_sid cookie value)
 *   NAUKRI_PROFILE_ID — Profile hash ID (long hex string)
 *
 * Optional:
 *   NAUK_AT         — Current access token JWT (used first, refreshed automatically if expired)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'naukri-refresh.log');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

// Load from environment (GitHub Secrets) or .env file
const { naukriProfileUrl } = require('./config');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const NAUK_RT       = process.env.NAUK_RT;
const NAUK_SID      = process.env.NAUK_SID;
let   PROFILE_ID    = process.env.NAUKRI_PROFILE_ID;
let   NAUK_AT       = process.env.NAUK_AT || '';

if (!NAUK_RT || !NAUK_SID) {
  log('ERROR: Missing required secrets. Please set NAUK_RT and NAUK_SID in GitHub Repository Secrets.');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, urlStr, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const cookieStr = [
      `nauk_at=${NAUK_AT}`,
      `nauk_rt=${NAUK_RT}`,
      `nauk_sid=${NAUK_SID}`,
      `nauk_otl=${NAUK_SID}`,
      'is_login=1',
    ].filter(Boolean).join('; ');

    const headers = {
      appid: extraHeaders.appid || '135',
      clientid: 'd3skt0p',
      systemid: 'naukriindia',
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: NAUK_AT ? `Bearer ${NAUK_AT}` : undefined,
      cookie: cookieStr,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      origin: 'https://www.naukri.com',
      referer: 'https://www.naukri.com/mnj/fullProfile',
      ...extraHeaders,
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['content-length'] = Buffer.byteLength(bodyStr);

    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Token Refresh ─────────────────────────────────────────────────────────────
async function refreshToken() {
  log('Access token expired — refreshing with nauk_rt...');
  const res = await request('POST',
    'https://www.naukri.com/cloudgateway-mynaukri/mynaukri-api/v1/refreshtoken',
    { refreshToken: NAUK_RT }
  );
  if (res.status === 200) {
    try {
      const parsed = JSON.parse(res.body);
      const newToken = parsed.nauk_at || parsed.accessToken || parsed.token;
      if (newToken) {
        NAUK_AT = newToken;
        log('Token refreshed successfully.');
        return true;
      }
    } catch (_) {}
  }
  log(`WARN: Token refresh returned status ${res.status}. Proceeding with session cookies only.`);
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Step 1: Fetch current profile & headline
    log('Fetching current Naukri profile...');
    let profileRes = await request('GET',
      'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v2/users/self?expand_level=4&skillsView=unified'
    );

    // If unauthorized, refresh the token and retry once
    if (profileRes.status === 401 || profileRes.status === 403) {
      await refreshToken();
      profileRes = await request('GET',
        'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v2/users/self?expand_level=4&skillsView=unified'
      );
    }

    if (profileRes.status !== 200) {
      throw new Error(`Profile fetch failed (${profileRes.status}): ${profileRes.body.slice(0, 300)}`);
    }

    const profile = JSON.parse(profileRes.body);
    const profObj = profile.profile?.[0] || profile.profile || profile;
    if (!PROFILE_ID) {
      PROFILE_ID = profObj.profileId || profObj.id || profObj.resId;
      log(`Auto-detected PROFILE_ID: ${PROFILE_ID}`);
    }
    const current = (profObj.resumeHeadline || profile.resumeHeadline || '').trimEnd();
    if (!current) throw new Error('resumeHeadline is empty in API response. Check NAUK_SID / NAUK_RT secrets.');
    const updated = current.endsWith('.') ? current.slice(0, -1) : current + '.';

    log(`Current headline: "${current.slice(0, 80)}"`);

    // Step 2: Push the toggled headline
    let updateRes = await request('POST',
      `https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/profiles/${PROFILE_ID}`,
      { resumeHeadline: updated },
      { appid: '135' }
    );

    if (updateRes.status !== 200) {
      console.log(`Endpoint 1 returned ${updateRes.status}:`, updateRes.body.slice(0, 150));
      updateRes = await request('POST',
        `https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/profiles/${PROFILE_ID}/resumeHeadline`,
        { resumeHeadline: updated },
        { appid: '135' }
      );
    }

    if (updateRes.status !== 200) {
      console.log(`Endpoint 2 returned ${updateRes.status}:`, updateRes.body.slice(0, 150));
      updateRes = await request('POST',
        'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/fullprofiles',
        { profile: { resumeHeadline: updated }, profileId: PROFILE_ID },
        { appid: '105' }
      );
    }

    if (updateRes.status !== 200) {
      throw new Error(`Headline update failed (${updateRes.status}): ${updateRes.body.slice(0, 300)}`);
    }

    // Step 3: Verify the save stuck by re-fetching
    const verifyRes = await request('GET',
      'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v2/users/self?expand_level=4&skillsView=unified'
    );
    const verified = JSON.parse(verifyRes.body);
    const saved = (verified.resumeHeadline || '').trimEnd();
    if (saved !== updated) {
      throw new Error(`Save did not stick — server has "${saved.slice(0, 60)}", expected "${updated.slice(0, 60)}"`);
    }

    log(`OK: headline ${current.endsWith('.') ? 'dot removed' : 'dot added'} (verified) → "${updated.slice(0, 80)}"`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
  }
})();
