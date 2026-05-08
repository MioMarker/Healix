// ── SUPABASE ──
// SUPABASE_URL and SUPABASE_ANON_KEY are set by config.js (loaded before this file)

// ── CLIENT VIEW (account-based sharing) ──
var _viewingUserId = null;   // set when a coach switches to a client's dashboard
var _viewingUserName = null;
var _origSupabaseRequest = null;

var currentUser = null, currentSession = null, currentTimeframe = 7;
var HEALTHBITE_APP_URL = 'https://apps.apple.com/app/healthbite/id6738970819';
var _storageQuotaWarned = false;
function safeLSSet(key, val) {
  try { localStorage.setItem(key, val); }
  catch(e) {
    if (!_storageQuotaWarned) {
      _storageQuotaWarned = true;
      console.warn('[Healix] localStorage quota exceeded — some data will not persist across sessions.');
    }
  }
}
var _hbConnectPollInterval = null;
var _hbConnected = false;

function getSession() {
  try { var s = localStorage.getItem('healix_session'); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}
function getToken() {
  var s = getSession();
  return s ? s.access_token : (currentSession ? currentSession.access_token : null);
}

// ── LOGOUT ──
function logout() {
  var session = getSession();
  if (session && session.access_token) {
    fetch(SUPABASE_URL + '/auth/v1/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token
      }
    }).catch(function() {});
  }
  localStorage.removeItem('healix_session');
  localStorage.removeItem('healix_last_activity');
  window.location.href = 'login.html';
}

// ── TOKEN REFRESH ──
function refreshSession() {
  var session = getSession();
  if (!session || !session.refresh_token) return Promise.reject('No refresh token');
  return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY
    },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.access_token) {
      localStorage.setItem('healix_session', JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        user: data.user || session.user
      }));
      if (currentSession) currentSession.access_token = data.access_token;
      return data.access_token;
    }
    throw new Error('Refresh failed');
  });
}

// Proactively refresh token every 50 minutes (Supabase tokens expire in 60 min)
setInterval(function() {
  var session = getSession();
  if (session && session.refresh_token) {
    refreshSession().catch(function() { logout(); });
  }
}, 50 * 60 * 1000);

// ── SESSION INACTIVITY TIMEOUT (30 min) ──
var INACTIVITY_TIMEOUT = 30 * 60 * 1000;
function resetActivityTimer() {
  localStorage.setItem('healix_last_activity', Date.now().toString());
}
function checkInactivity() {
  var last = parseInt(localStorage.getItem('healix_last_activity') || '0', 10);
  if (last && (Date.now() - last > INACTIVITY_TIMEOUT)) {
    logout();
  }
}
['click', 'keydown', 'scroll', 'mousemove', 'touchstart'].forEach(function(evt) {
  document.addEventListener(evt, resetActivityTimer, { passive: true });
});
resetActivityTimer();
setInterval(checkInactivity, 60 * 1000);

function supabaseRequest(endpoint, method, body, token, extraHeaders) {
  var headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + (token || SUPABASE_ANON_KEY)
  };
  if (extraHeaders) { Object.keys(extraHeaders).forEach(function(k) { headers[k] = extraHeaders[k]; }); }
  return fetch(SUPABASE_URL + endpoint, {
    method: method || 'GET',
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  }).then(function(r) {
    if (r.status === 401 || r.status === 403) {
      console.warn('[Healix] Got ' + r.status + ' from ' + endpoint + ' — session expired');
      handleAuthFailure();
      return Promise.reject(new Error('auth_failure'));
    }
    if (!r.ok) return r.text().then(function(t) { throw new Error(r.status + ': ' + t); });
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('json') === -1) return null;
    return r.text().then(function(t) { return t ? JSON.parse(t) : null; });
  });
}


// ── AUTH ──
var _authRedirecting = false;
function handleAuthFailure() {
  if (_authRedirecting) return;
  _authRedirecting = true;
  console.warn('[Healix] Auth failure — clearing session and redirecting');
  localStorage.removeItem('healix_session');
  localStorage.removeItem('healix_dashboard_cache');
  window.location.href = 'login.html';
}

async function ensureFreshToken() {
  var session = getSession();
  if (!session || !session.access_token) return null;
  // If token expires within 5 minutes, proactively refresh
  if (session.expires_at && session.expires_at < Date.now() + 5 * 60 * 1000) {
    console.log('[Healix] Token expiring soon, refreshing...');
    try {
      await refreshSession();
      return getSession();
    } catch(e) {
      console.warn('[Healix] Token refresh failed:', e);
      return null;
    }
  }
  return session;
}

async function init() {
  var session = await ensureFreshToken();
  if (!session || !session.access_token) { handleAuthFailure(); return; }
  currentSession = session;
  // Clean up legacy localStorage flags — profile existence is now the onboarding gate
  localStorage.removeItem('healix_onboarding_done');
  localStorage.removeItem('healix_firstrun_done');
  try {
    var user = await supabaseRequest('/auth/v1/user', 'GET', null, session.access_token);
    if (!user || !user.id || user.error) { handleAuthFailure(); return; }
    currentUser = user;
    // Set initial name from auth metadata, will be overwritten by profile data if available
    var name = (user.user_metadata && user.user_metadata.full_name) || '';
    var firstName = name ? name.split(' ')[0] : '';
    // Skip single-character initials — wait for profile to provide real name
    if (firstName.length <= 1) firstName = '';
    document.getElementById('sb-name').textContent = name.length > 1 ? name : 'Healix User';
    document.getElementById('sb-avatar').textContent = firstName ? firstName.charAt(0).toUpperCase() : 'H';
    document.getElementById('page-title').textContent = greet() + ', ' + (firstName || 'there');

    // Fetch profile from Supabase before loading dashboard so DOB/weight are available
    try {
      var profileData = await supabaseRequest(
        '/rest/v1/profiles?auth_user_id=eq.' + user.id + '&limit=1',
        'GET', null, session.access_token
      );
      if (profileData && Array.isArray(profileData) && profileData.length > 0) {
        window.userProfileData = profileData[0];
        console.log('[Healix] profile loaded:', Object.keys(window.userProfileData), 'birth_date:', window.userProfileData.birth_date);
        populateProfileForm(profileData[0]);
        // Update sidebar and greeting with profile name
        // Try first_name, then full_name from profile, then full_name from auth metadata
        var profileFirst = profileData[0].first_name
          || (profileData[0].full_name ? profileData[0].full_name.split(' ')[0] : '')
          || (user.user_metadata && user.user_metadata.full_name ? user.user_metadata.full_name.split(' ')[0] : '');
        var profileLast = profileData[0].last_name || '';
        var profileName = [profileFirst, profileLast].filter(Boolean).join(' ');
        if (profileFirst && profileFirst.length > 1) {
          document.getElementById('sb-name').textContent = profileName || profileFirst;
          document.getElementById('sb-avatar').textContent = profileFirst.charAt(0).toUpperCase();
          document.getElementById('page-title').textContent = greet() + ', ' + profileFirst;
        }
        // Dynamic plan label
        var planEl = document.querySelector('.user-plan');
        if (planEl) {
          var tier = profileData[0].subscription_tier || 'free';
          planEl.textContent = tier === 'premium' ? 'Premium' : tier === 'clinical' ? 'Clinical' : 'Free';
        }
        renderSubscriptionCard();
      } else {
        // No profile row — onboarding will handle creation
        window.userProfileData = null;
        console.log('[Healix] No profile found — onboarding required');
      }
    } catch(e) { console.warn('Profile fetch error:', e); }

    // Load sharing state (always — even without profile, coach accounts need sidebar)
    loadShareDetails();

    // Render preset buttons BEFORE populateProfileForm restores saved selections
    // (was previously after populateProfileForm, so saved allergies/conditions couldn't find buttons)
    loadMedicalProfileUI();

    // Re-populate saved conditions/allergies now that preset buttons exist
    if (window.userProfileData) {
      medicalProfile.conditions = [];
      medicalProfile.allergies = [];
      if (window.userProfileData.health_conditions) {
        var conds = window.userProfileData.health_conditions.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        conds.forEach(function(c) {
          var matched = false;
          conditionPresets.forEach(function(p) {
            if (c.toLowerCase().indexOf(p.toLowerCase()) === 0 || p.toLowerCase().indexOf(c.toLowerCase()) === 0) {
              var preset = document.querySelector('#condition-presets [data-val="' + p + '"]');
              if (preset) { preset.classList.add('active'); medicalProfile.conditions.push(p); matched = true; }
            }
          });
          if (!matched) medicalProfile.conditions.push(c);
        });
        renderCustomTags('custom-condition-tags', medicalProfile.conditions.filter(function(c) { return conditionPresets.indexOf(c) === -1; }), 'condition');
      }
      if (window.userProfileData.dietary_restrictions) {
        var allergies = window.userProfileData.dietary_restrictions.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        allergies.forEach(function(a) {
          var matched = false;
          allergyPresets.forEach(function(p) {
            if (a.toLowerCase().indexOf(p.toLowerCase()) === 0 || p.toLowerCase().indexOf(a.toLowerCase()) === 0) {
              var preset = document.querySelector('#allergy-presets [data-val="' + p + '"]');
              if (preset) { preset.classList.add('active'); medicalProfile.allergies.push(p); matched = true; }
            }
          });
          if (!matched) medicalProfile.allergies.push(a);
        });
        renderCustomTags('custom-allergy-tags', medicalProfile.allergies.filter(function(a) { return allergyPresets.indexOf(a) === -1; }), 'allergy');
      }
    }

    // Check onboarding before loading dashboard data — wizard blocks until completed
    checkOnboarding();

    // Render from cache instantly, then refresh from server
    try {
      var cached = localStorage.getItem('healix_dashboard_cache');
      if (cached) {
        var c = JSON.parse(cached);
        // Use cache if less than 10 minutes old
        if (c.cachedAt && (Date.now() - c.cachedAt < 10 * 60 * 1000)) {
          renderVitalityAge(c.result, c.realAge);
          renderVitalityTimeline();
          renderDriverCards(c.metrics, c.result);
          if (c.timestamps) {
            renderFreshnessIndicator('drv-heart-freshness', 'heart_rate', c.timestamps.heart_rate);
            renderFreshnessIndicator('drv-weight-freshness', 'weight', c.timestamps.weight);
            renderFreshnessIndicator('drv-strength-freshness', 'strength', c.timestamps.strength);
            renderFreshnessIndicator('drv-aerobic-freshness', 'vo2max', c.timestamps.vo2max);
            renderFreshnessIndicator('drv-bloodwork-freshness', 'bloodwork', c.timestamps.bloodwork);
          }
        }
      }
    } catch(e) { /* cache parse error, ignore */ }

    loadDashboardData().then(async function() {
      renderVitalityUnlockState();
      renderOnboardingChecklist();
      renderSmartEmptyStates(window._lastVitalityResult);
      loadBossInsight();
      // Run deterministic insight engine
      var insightCtx = buildInsightContext();
      var insights = runInsightRules(insightCtx);
      window._lastInsights = insights;
      renderInsightFeed(insights);
      // Show upgrade modal if redirected from chat.html
      if (window.location.search.indexOf('upgrade=1') !== -1) {
        showUpgradeModal();
        history.replaceState(null, '', window.location.pathname);
      }
      // Handle post-upgrade redirect from Stripe
      if (new URLSearchParams(window.location.search).get('upgraded') === '1') {
        history.replaceState(null, '', window.location.pathname);
        // Refresh profile to get updated tier
        try {
          var freshProfile = await supabaseRequest(
            '/rest/v1/profiles?auth_user_id=eq.' + currentUser.id + '&limit=1',
            'GET', null, getToken()
          );
          if (freshProfile && Array.isArray(freshProfile) && freshProfile.length > 0) {
            window.userProfileData = freshProfile[0];
            populateProfileForm(freshProfile[0]);
            renderSubscriptionCard();
            var planEl = document.querySelector('.user-plan');
            if (planEl) {
              var newTier = freshProfile[0].subscription_tier || 'free';
              planEl.textContent = newTier === 'premium' ? 'Premium' : newTier === 'clinical' ? 'Clinical' : 'Free';
            }
          }
        } catch(e) { console.warn('[Upgrade] Profile refresh error:', e); }
        // Show success banner
        var errEl = document.getElementById('profile-errors');
        if (errEl) {
          errEl.textContent = 'Welcome to Premium! You now have full access to Healix AI.';
          errEl.style.display = 'block';
          errEl.style.color = 'var(--up)';
          errEl.style.borderColor = 'var(--success-border)';
          errEl.style.background = 'var(--success-bg)';
        }
      }
    });
    initSectionIntros();
    loadFamilyHistoryForm();
    setWeightDateDefault();
  } catch(e) {
    console.error('[Healix] Init error:', e);
  }
}

function greet() {
  var h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ── PAGE NAV ──
var pageTitles = { dashboard: 'Dashboard', meals: 'Intake', sleep: 'Sleep', bloodwork: 'Bloodwork', documents: 'Documents', strength: 'Strength Log', profile: 'Profile & Settings' };
function showPage(id, btn) {
  // Exit client view only when navigating to profile (owner-only page)
  if (_viewingUserId && id === 'profile') {
    switchToOwnView();
    return;
  }
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-' + id).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  // Set page title — respect client view mode
  if (_viewingUserId && _viewingUserName) {
    var clientFirst = _viewingUserName.split(' ')[0];
    var pageLabel = pageTitles[id] || id;
    document.getElementById('page-title').textContent = id === 'dashboard'
      ? escapeHtml(_viewingUserName) + "'s Dashboard"
      : escapeHtml(clientFirst) + "'s " + pageLabel;
  } else if (currentUser) {
    var profileFirst = window.userProfileData && window.userProfileData.first_name;
    var profileFull = window.userProfileData && window.userProfileData.full_name;
    var metaName = currentUser.user_metadata && currentUser.user_metadata.full_name;
    var firstName = profileFirst
      || (profileFull ? profileFull.split(' ')[0] : '')
      || (metaName && metaName.length > 1 ? metaName.split(' ')[0] : '')
      || 'there';
    document.getElementById('page-title').textContent = id === 'dashboard' ? greet() + ', ' + firstName : pageTitles[id] || id;
  }

  // Load page data
  if (id === 'meals') { loadMealsPage(); }
  if (id === 'sleep') { loadSleepPage(); }
  if (id === 'bloodwork') loadBloodworkPage();
  if (id === 'documents') loadDocumentsPage();
  if (id === 'strength') renderStrengthPage();
}

// ── DATA FRESHNESS ──
var FRESHNESS_THRESHOLDS = {
  heart_rate:  { fresh: 24, warning: 48, stale: 72 },
  sleep:       { fresh: 36, warning: 60, stale: 96 },
  steps:       { fresh: 18, warning: 36, stale: 72 },
  weight:      { fresh: 168, warning: 504, stale: 720 },
  strength:    { fresh: 720, warning: 2160, stale: 4320 },
  vo2max:      { fresh: 720, warning: 2160, stale: 4320 },
  bloodwork:   { fresh: 2160, warning: 4320, stale: 8760 }
};

var FRESHNESS_CTA = {
  heart_rate: { text: 'Open Healix app to sync', href: null },
  sleep:      { text: 'Open Healix app to sync', href: null },
  steps:      { text: 'Open Healix app to sync', href: null },
  weight:     { text: 'Log new weight', action: function() { openModal('weight-modal'); } },
  strength:   { text: 'Log a new test', action: function() { showPage('strength', null); } },
  vo2max:     { text: 'Log a new test', action: function() { showPage('strength', null); } },
  bloodwork:  { text: 'Upload new labs', action: function() { showPage('documents', null); } }
};

function getFreshnessLevel(metricKey, timestamp) {
  if (!timestamp) return null;
  var thresholds = FRESHNESS_THRESHOLDS[metricKey];
  if (!thresholds) return null;
  var hoursAgo = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
  if (hoursAgo <= thresholds.fresh) return 'fresh';
  if (hoursAgo <= thresholds.warning) return 'warning';
  return 'stale';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  var ms = Date.now() - new Date(timestamp).getTime();
  var mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 14) return days + 'd ago';
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderFreshnessIndicator(elementId, metricKey, timestamp) {
  var el = document.getElementById(elementId);
  if (!el) return;
  if (!timestamp) { el.innerHTML = ''; return; }
  var level = getFreshnessLevel(metricKey, timestamp);
  if (!level || level === 'fresh') {
    el.innerHTML = '<span class="freshness-dot fresh"></span><span class="freshness-text">' + formatRelativeTime(timestamp) + '</span>';
    return;
  }
  var timeText = formatRelativeTime(timestamp);
  var html = '<span class="freshness-dot ' + level + '"></span><span class="freshness-text">' + timeText;
  if (level === 'stale') {
    var cta = FRESHNESS_CTA[metricKey];
    if (cta) {
      html += ' · <span class="freshness-cta" onclick="event.stopPropagation()">' + cta.text + '</span>';
    }
  }
  html += '</span>';
  el.innerHTML = html;

  // Attach CTA click handler
  if (level === 'stale') {
    var ctaEl = el.querySelector('.freshness-cta');
    var ctaDef = FRESHNESS_CTA[metricKey];
    if (ctaEl && ctaDef && ctaDef.action) {
      ctaEl.onclick = function(e) { e.stopPropagation(); ctaDef.action(); };
    }
  }

  // Add stale card treatment
  var card = el.closest('.driver-card');
  if (card) {
    card.classList.toggle('data-stale', level === 'stale');
  }
}

function renderSyncBanner(timestamps) {
  var banner = document.getElementById('sync-banner');
  if (!banner) return;
  var hkMetrics = ['heart_rate', 'sleep', 'steps'];
  var allStale = hkMetrics.every(function(key) {
    var ts = timestamps[key];
    if (!ts) return true;
    var level = getFreshnessLevel(key, ts);
    return level === 'warning' || level === 'stale';
  });
  banner.classList.toggle('visible', allStale);
  if (allStale) {
    var textEl = document.getElementById('sync-banner-text');
    if (textEl) {
      // Query health_sync_log for last sync info
      supabaseRequest(
        '/rest/v1/health_sync_log?select=sync_completed_at,device_name&user_id=eq.' + currentUser.id
        + '&sync_status=eq.completed&order=sync_completed_at.desc&limit=1',
        'GET', null, getToken()
      ).then(function(rows) {
        if (rows && rows.length > 0 && rows[0].sync_completed_at) {
          var ago = formatRelativeTime(rows[0].sync_completed_at);
          var device = rows[0].device_name ? ' from ' + rows[0].device_name : '';
          textEl.textContent = 'Last sync ' + ago + device + '. Open Healix app to refresh your data.';
        }
      }).catch(function() {});
    }
  }
}

function renderVitalityConfidence(timestamps) {
  var el = document.getElementById('va-confidence');
  if (!el) return;
  var keys = ['heart_rate', 'sleep', 'steps', 'weight', 'strength', 'vo2max', 'bloodwork'];
  var maxHours = 0;
  var staleCount = 0;
  keys.forEach(function(key) {
    if (!timestamps[key]) return;
    var hours = (Date.now() - new Date(timestamps[key]).getTime()) / (1000 * 60 * 60);
    if (hours > maxHours) maxHours = hours;
    var level = getFreshnessLevel(key, timestamps[key]);
    if (level === 'warning' || level === 'stale') staleCount++;
  });
  if (staleCount === 0) {
    el.textContent = '';
    el.className = 'vitality-confidence';
    return;
  }
  if (maxHours > 168) {
    el.textContent = 'Some data is over a week old \u2014 scores may not reflect current health';
    el.className = 'vitality-confidence amber';
  } else {
    var daysOld = Math.ceil(maxHours / 24);
    el.textContent = 'Based on data up to ' + daysOld + ' day' + (daysOld > 1 ? 's' : '') + ' old';
    el.className = 'vitality-confidence';
  }
}

// ── LOAD DASHBOARD DATA ──
// ── VITALITY AGE CALCULATION ──
// Clinical model based on PhenoAge / cardiology research
// Biomarkers only — habits are inputs, not outputs
//
// Weights (when all data present):
//   Blood work:   40%  — most objective biological age signal
//   Resting HR:   25%  — strongest single cardio mortality predictor
//   Weight (BMI): 20%  — metabolic health proxy
//   Strength:     10%  — functional capacity / muscle mass
//   Aerobic:       5%  — VO2 max from fitness test
//
// Until blood work connected, HR/weight/strength/aerobic redistribute proportionally.

function scoreHR(hr) {
  // Mortality-calibrated Gaussian curve (Copenhagen Heart Study, UK Biobank, HUNT)
  // Optimal zone 50-62 bpm; σ ≈ 15 bpm outside optimal band
  if (hr === null || hr === undefined || isNaN(hr)) return null;
  if (hr < 40) return 65; // extreme bradycardia — uncertainty flag
  if (hr >= 50 && hr <= 62) return 100; // optimal zone
  var center = hr < 50 ? 50 : 62;
  var sigma = 15;
  var z = (hr - center) / sigma;
  return Math.max(5, Math.round(100 * Math.exp(-0.5 * z * z)));
}

function scoreWeight(weightKg, heightCm) {
  // BMI-based J-shaped mortality scoring (Global BMI Mortality Collaboration)
  if (!weightKg || !heightCm) return null;
  var bmi = weightKg / Math.pow(heightCm / 100, 2);
  if (bmi < 16.5) return 10;
  if (bmi < 18.5) return 45;
  if (bmi < 20)   return 80;
  if (bmi <= 25)   return 95;  // optimal
  if (bmi <= 27.5) return 78;
  if (bmi <= 30)   return 60;
  if (bmi <= 35)   return 38;
  if (bmi <= 40)   return 20;
  return 10;
}

// 5 fitness domains — at least one test from each domain required for a confirmed score
var FITNESS_DOMAINS = [
  { key: 'upper_push', label: 'Upper Push', tests: ['bench_1rm', 'pushup'] },
  { key: 'upper_pull', label: 'Upper Pull', tests: ['pullup', 'dead_hang'] },
  { key: 'lower',      label: 'Lower Body', tests: ['squat_1rm', 'chair_stand'] },
  { key: 'core',       label: 'Core',       tests: ['plank'] },
  { key: 'carry_grip', label: 'Carry/Grip', tests: ['farmers_walk', 'grip_strength'] }
];

function getCompletedDomains(strengthData) {
  if (!strengthData || !strengthData.tests) return { completed: [], missing: FITNESS_DOMAINS.slice() };
  var testedKeys = {};
  strengthData.tests.forEach(function(t) { testedKeys[t.test_key] = true; });
  var completed = [];
  var missing = [];
  FITNESS_DOMAINS.forEach(function(d) {
    var hasDomain = d.tests.some(function(k) { return testedKeys[k]; });
    if (hasDomain) completed.push(d);
    else missing.push(d);
  });
  return { completed: completed, missing: missing };
}

function scoreStrength(strengthData) {
  // Fitness test percentile average — percentile maps directly to 0-100 score
  if (!strengthData) return null;
  return strengthData.avgPercentile || 50;
}

function scoreVO2(vo2, profile) {
  // Score VO2 max using fitness test percentile norms
  // Returns 0-100 based on age/sex percentile
  if (!vo2 || vo2 <= 0) return null;
  var norm = FITNESS_NORMS && FITNESS_NORMS.vo2max;
  if (!norm) return Math.min(100, Math.max(10, Math.round(vo2 * 2)));
  var sex = (profile && profile.sex) || 'male';
  var age = (profile && profile.age) || 35;
  var bracket = age < 30 ? '18-29' : age < 40 ? '30-39' : age < 50 ? '40-49' : age < 60 ? '50-59' : '60+';
  var table = (norm.norms[sex] || norm.norms.male || {})[bracket];
  if (!table) return Math.min(100, Math.max(10, Math.round(vo2 * 2)));
  // table is [[threshold, percentile], ...] sorted desc by threshold
  for (var i = 0; i < table.length; i++) {
    if (vo2 >= table[i][0]) return table[i][1];
  }
  return 5;
}

function scoreSleep(sleepData) {
  // Reweighted sleep scoring with asymmetric duration curve (Windred et al. 2023)
  // Oversleeping penalized more than undersleeping (9h RR 1.21 vs 5h RR 1.04)
  if (!sleepData || !sleepData.nights) return null;

  // Duration score (0-35): Asymmetric curve, nadir at 6.5-7.5h
  var dur = sleepData.avg;
  var durScore;
  if (dur >= 6.5 && dur <= 7.5) durScore = 35;       // optimal nadir
  else if (dur >= 6 && dur < 6.5) durScore = 28;      // slightly short
  else if (dur > 7.5 && dur <= 8) durScore = 30;      // slightly long
  else if (dur >= 5.5 && dur < 6) durScore = 20;      // short
  else if (dur > 8 && dur <= 8.5) durScore = 22;      // long
  else if (dur >= 5 && dur < 5.5) durScore = 12;      // very short
  else if (dur > 8.5 && dur <= 9) durScore = 14;      // very long — penalized more
  else if (dur > 9) durScore = 5;                      // extreme long — highest risk
  else durScore = 5;                                   // extreme short (<5h)

  // Debt score (0-30): Accumulated sleep debt
  var debt = sleepData.debt || 0;
  var debtScore;
  if (debt <= 1) debtScore = 30;
  else if (debt <= 3) debtScore = 22;
  else if (debt <= 7) debtScore = 13;
  else if (debt <= 14) debtScore = 5;
  else debtScore = 0;

  // Consistency score (0-35): Major weight increase per Windred et al. 2023
  var consScore = Math.min(35, Math.round((sleepData.nights / 7) * 35));

  return durScore + debtScore + consScore;
}

function scoreBP(systolic, diastolic) {
  if (!systolic || !diastolic || systolic <= 0 || diastolic <= 0) return null;
  var sysScore;
  if (systolic < 110) sysScore = 90;
  else if (systolic < 120) sysScore = 100;
  else if (systolic < 130) sysScore = 75;
  else if (systolic < 140) sysScore = 45;
  else if (systolic < 160) sysScore = 20;
  else sysScore = 5;
  var diaScore;
  if (diastolic < 70) diaScore = 90;
  else if (diastolic < 80) diaScore = 100;
  else if (diastolic < 90) diaScore = 45;
  else if (diastolic < 100) diaScore = 20;
  else diaScore = 5;
  return Math.min(sysScore, diaScore);
}

function calcPhenoAge(bw, chronologicalAge) {
  if (!bw) return null;
  var albumin = bw.albumin;
  var creatinine = bw.creatinine;
  var glucose = bw.glucose;
  var crp = bw.crp;
  var lymphPct = bw.lymphocyte_pct || bw.lymphocytes;
  var mcv = bw.mcv;
  var rdw = bw.rdw;
  var alp = bw.alp || bw.alkaline_phosphatase;
  var wbc = bw.wbc;
  if (albumin == null || creatinine == null || glucose == null ||
      crp == null || lymphPct == null || mcv == null ||
      rdw == null || alp == null || wbc == null) return null;
  var albumin_gL = albumin * 10;
  var creatinine_umolL = creatinine * 88.4;
  var glucose_mmolL = glucose / 18.016;
  var lnCrp = Math.log(Math.max(0.01, crp));
  var xb = -19.9067
    + (-0.0336 * albumin_gL)
    + (0.0095 * creatinine_umolL)
    + (0.1953 * glucose_mmolL)
    + (0.0954 * lnCrp)
    + (-0.0120 * lymphPct)
    + (0.0268 * mcv)
    + (0.3306 * rdw)
    + (0.00188 * alp)
    + (0.0554 * wbc)
    + (0.0804 * chronologicalAge);
  var gamma = 0.0076927;
  var mortScore = 1 - Math.exp(-Math.exp(xb) * (Math.exp(120 * gamma) - 1) / gamma);
  var phenoAge = 141.50225 + Math.log(-0.00553 * Math.log(1 - mortScore)) / 0.090165;
  if (!isFinite(phenoAge) || phenoAge < 0 || phenoAge > 150) return null;
  return Math.round(phenoAge * 10) / 10;
}

function scoreBloodwork(bw, chronologicalAge) {
  if (!bw || Object.keys(bw).length === 0) return null;
  if (chronologicalAge != null) {
    var phenoAge = calcPhenoAge(bw, chronologicalAge);
    if (phenoAge !== null) {
      var delta = chronologicalAge - phenoAge;
      return Math.max(0, Math.min(100, Math.round(50 + (delta * 5))));
    }
  }
  var pts = [];
  if (bw.glucose != null) {
    if (bw.glucose < 70) pts.push(65);
    else if (bw.glucose < 85) pts.push(100);
    else if (bw.glucose < 100) pts.push(78);
    else if (bw.glucose < 126) pts.push(40);
    else pts.push(10);
  }
  if (bw.hba1c != null) {
    if (bw.hba1c < 4.6) pts.push(85);
    else if (bw.hba1c < 5.4) pts.push(100);
    else if (bw.hba1c < 5.7) pts.push(75);
    else if (bw.hba1c < 6.5) pts.push(40);
    else pts.push(10);
  }
  if (bw.ldl != null) {
    if (bw.ldl < 70) pts.push(100);
    else if (bw.ldl < 100) pts.push(90);
    else if (bw.ldl < 130) pts.push(70);
    else if (bw.ldl < 160) pts.push(45);
    else if (bw.ldl < 190) pts.push(25);
    else pts.push(10);
  }
  if (bw.hdl != null) {
    if (bw.hdl > 90) pts.push(78);
    else if (bw.hdl >= 60) pts.push(100);
    else if (bw.hdl >= 40) pts.push(70);
    else pts.push(30);
  }
  if (bw.crp != null) {
    if (bw.crp < 0.5) pts.push(100);
    else if (bw.crp < 1.0) pts.push(85);
    else if (bw.crp < 2.0) pts.push(65);
    else if (bw.crp < 3.0) pts.push(40);
    else pts.push(15);
  }
  if (bw.triglycerides != null) {
    if (bw.triglycerides < 100) pts.push(100);
    else if (bw.triglycerides < 150) pts.push(80);
    else if (bw.triglycerides < 200) pts.push(55);
    else if (bw.triglycerides < 500) pts.push(25);
    else pts.push(10);
  }
  if (pts.length === 0) return null;
  return Math.round(pts.reduce(function(a, b) { return a + b; }, 0) / pts.length);
}

function calcVitalityAge(metrics) {
  var realAge = metrics.realAge || 35;
  var scores = [];

  // Weights match the mobile app (vitalityAge.ts):
  //   Blood Work: 35%  — PhenoAge when all 9 biomarkers, fallback scoring otherwise
  //   VO2 Max:    20%  — Strongest single mortality predictor (Cooper Institute)
  //   Blood Pressure: 15% — Top cardiovascular predictor (AHA 2017, Framingham)
  //   Resting HR: 15%  — Cardiovascular efficiency (Copenhagen Male Study)
  //   Strength:   15%  — Grip/muscle strength (Lancet 140k study)
  //   Weight: EXCLUDED — input that drives HR, BP, bloodwork, VO2
  //   Sleep:  EXCLUDED — lifestyle behavior that modulates other metrics

  // Blood work — 35%
  var bwScore = scoreBloodwork(metrics.bloodwork, realAge);
  if (bwScore !== null) {
    scores.push({ name: 'bloodwork', label: 'Blood Work', score: bwScore, weight: 0.35 });
  }

  // VO2 Max — 20%
  if (metrics.vo2max !== null) {
    var vo2Score = scoreVO2(metrics.vo2max, { sex: metrics.sex, age: metrics.realAge });
    if (vo2Score !== null) {
      scores.push({ name: 'aerobic', label: 'Aerobic', score: vo2Score, weight: 0.20 });
    }
  }

  // Blood Pressure — 15%
  var bpScore = scoreBP(metrics.systolic, metrics.diastolic);
  if (bpScore !== null) {
    scores.push({ name: 'bp', label: 'Blood Pressure', score: bpScore, weight: 0.15 });
  }

  // Resting HR — 15%
  if (metrics.hr != null) {
    var hrScore = scoreHR(metrics.hr);
    if (hrScore !== null) {
      scores.push({ name: 'hr', label: 'Heart Rate', score: hrScore, weight: 0.15 });
    }
  }

  // Strength — 15%
  var strScore = scoreStrength(metrics.strengthData);
  if (strScore !== null) {
    scores.push({ name: 'strength', label: 'Strength', score: strScore, weight: 0.15 });
  }

  if (scores.length === 0) return null;

  // Normalise weights for missing dimensions
  var totalW = scores.reduce(function(s, d) { return s + d.weight; }, 0);
  var compositeRaw = scores.reduce(function(s, d) { return s + (d.score * d.weight / totalW); }, 0);
  var composite = Math.round(compositeRaw);

  // Clinical mapping: composite 70 = real age baseline
  // Each 5 points = ~1 year. Range ±15 years max.
  // Use raw composite (not rounded) to avoid staircase jumps where
  // vitality age changes by a year without visible driver score changes
  var baseAdjustment = (compositeRaw - 50) / 3.5;
  var adjustment = Math.round(baseAdjustment * (realAge / 60));
  var vAge = Math.max(18, Math.min(realAge + 15, realAge - adjustment));

  return {
    vAge: vAge,
    composite: composite,
    scores: scores,
    bloodworkConnected: bwScore !== null
  };
}

// ── VITALITY AGE UNLOCK MECHANIC ──
function renderVitalityUnlockState() {
  var state = getDataConnectivityState();
  var ageEl = document.getElementById('va-age');
  var ringWrap = document.getElementById('va-unlock-ring');
  var ringFill = document.getElementById('va-ring-fill');
  var ringLabel = document.getElementById('va-ring-label');
  var UNLOCK_THRESHOLD = 40;
  var isLocked = state.progressPct < UNLOCK_THRESHOLD;

  var unlockKey = 'healix_va_unlocked_' + (currentUser ? currentUser.id : '');
  var wasUnlocked = localStorage.getItem(unlockKey) === '1';

  if (wasUnlocked) isLocked = false;

  if (!isLocked && !wasUnlocked && state.progressPct >= UNLOCK_THRESHOLD) {
    if (!_viewingUserId) localStorage.setItem(unlockKey, '1');
    if (ageEl) {
      ageEl.classList.remove('va-locked');
      ageEl.classList.add('va-unlock-reveal');
    }
    if (ringWrap) ringWrap.style.display = 'none';
    return true;
  }

  if (isLocked) {
    if (ageEl) ageEl.classList.add('va-locked');
    if (ringWrap) {
      ringWrap.style.display = '';
      var circumference = 2 * Math.PI * 54;
      if (ringFill) {
        setTimeout(function() {
          ringFill.style.strokeDashoffset = circumference * (1 - state.progressPct / 100);
        }, 100);
      }
      if (ringLabel) {
        ringLabel.textContent = state.progressPct + '% — Connect more data to unlock your Vitality Age';
      }
    }
    return false;
  }

  if (ageEl) ageEl.classList.remove('va-locked');
  if (ringWrap) ringWrap.style.display = 'none';
  return true;
}

// ── SECTION INTROS ──
function dismissIntro(section) {
  var el = document.getElementById('intro-' + section);
  if (el) el.style.display = 'none';
  try { localStorage.setItem('healix_intro_dismissed_' + section, '1'); } catch(e) {}
}
function initSectionIntros() {
  ['meals', 'sleep', 'bloodwork', 'strength'].forEach(function(s) {
    try {
      if (localStorage.getItem('healix_intro_dismissed_' + s) === '1') {
        var el = document.getElementById('intro-' + s);
        if (el) el.style.display = 'none';
      }
    } catch(e) {}
  });
}

function toggleDriverExplainer(key) {
  var el = document.getElementById('drv-' + key + '-explainer');
  if (!el) return;
  var show = el.style.display === 'none';
  // Close all other explainers
  document.querySelectorAll('.driver-explainer').forEach(function(e) { e.style.display = 'none'; });
  if (show) {
    // Try dynamic explainer first, fall back to static
    var ctx = buildInsightContext();
    var dynamic = computeDriverExplainer(key, ctx);
    el.textContent = dynamic || DRIVER_EXPLAINERS[key] || '';
    if (el.textContent) el.style.display = 'block';
  }
}

function toggleSleepDebtExplainer() {
  var el = document.getElementById('sleep-debt-explainer');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function toggleVaExplainer() {
  var el = document.getElementById('va-explainer');
  var btn = document.getElementById('va-explainer-toggle');
  if (!el) return;
  var show = el.style.display === 'none';
  el.style.display = show ? 'block' : 'none';
  if (btn) btn.textContent = show ? 'How this works ▴' : 'How this works ▾';
}

function renderVitalityAge(result, realAge) {
  var unlocked = renderVitalityUnlockState();

  var ageEl = document.getElementById('va-age');
  var deltaEl = document.getElementById('va-delta');
  var realEl = document.getElementById('va-real-age');
  var arcEl = document.getElementById('va-arc-fill');
  var dateEl = document.getElementById('va-date');

  if (realEl) realEl.textContent = realAge;
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  if (!unlocked) {
    if (ageEl) ageEl.textContent = '??';
    if (deltaEl) { deltaEl.textContent = ''; deltaEl.className = 'vitality-delta'; }
    return;
  }

  if (!result) {
    if (ageEl) ageEl.textContent = '—';
    return;
  }

  // Animate count-up
  if (ageEl) {
    var target = result.vAge;
    var start = realAge;
    var duration = 1000;
    var startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      ageEl.textContent = Math.round(start + (target - start) * ease);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Delta label
  if (deltaEl) {
    var diff = realAge - result.vAge;
    if (Math.abs(diff) < 1) {
      deltaEl.textContent = 'on par with your age';
      deltaEl.className = 'vitality-delta same';
    } else if (diff > 0) {
      deltaEl.textContent = diff + ' years younger ↑';
      deltaEl.className = 'vitality-delta younger';
    } else {
      deltaEl.textContent = Math.abs(diff) + ' years to improve';
      deltaEl.className = 'vitality-delta older';
    }
  }

  // Arc fill — composite score drives the arc (0-100 → 0-100% of arc length 283)
  if (arcEl) {
    setTimeout(function() {
      var offset = 283 - (result.composite / 100) * 283;
      arcEl.style.strokeDashoffset = offset;
    }, 100);
  }
}

// ── VITALITY CELEBRATION ──
function checkVitalityCelebration(result) {
  if (!result || !result.vAge || !currentUser || _viewingUserId) return;
  var key = 'healix_va_prev_' + currentUser.id;
  var prev = null;
  try { prev = JSON.parse(localStorage.getItem(key)); } catch(e) {}

  var ageEl = document.getElementById('va-age');
  var msgEl = document.getElementById('va-celebration-msg');

  if (prev && prev.vAge && prev.vAge - result.vAge >= 1) {
    var improvement = Math.round(prev.vAge - result.vAge);
    if (!prev.celebratedVAge || prev.celebratedVAge !== result.vAge) {
      // Trigger celebration
      if (ageEl) ageEl.classList.add('va-celebration');
      if (msgEl) {
        msgEl.textContent = 'Your Vitality Age improved ' + improvement + (improvement === 1 ? ' year' : ' years') + '!';
        msgEl.style.display = '';
      }
      try { localStorage.setItem(key, JSON.stringify({ vAge: result.vAge, celebratedVAge: result.vAge })); } catch(e) {}
      return;
    }
  }

  // No celebration — just update cached vAge
  var obj = prev ? { vAge: result.vAge, celebratedVAge: prev.celebratedVAge || null } : { vAge: result.vAge, celebratedVAge: null };
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch(e) {}
  if (msgEl) msgEl.style.display = 'none';
  if (ageEl) ageEl.classList.remove('va-celebration');
}

// ── VITALITY AGE TIMELINE ──
function saveVitalityHistory(result, realAge) {
  if (!result || !result.vAge || _viewingUserId) return;
  var today = localDateStr(new Date());
  var history = [];
  try { history = JSON.parse(localStorage.getItem('healix_va_history_' + currentUser.id) || '[]'); } catch(e) { history = []; }
  // Build per-driver score map
  var driverScores = {};
  if (result.scores) {
    result.scores.forEach(function(s) { driverScores[s.name] = s.score; });
  }
  var entry = { date: today, vAge: result.vAge, composite: result.composite, realAge: realAge, drivers: driverScores };
  // Update today's entry or add new one
  var found = false;
  for (var i = 0; i < history.length; i++) {
    if (history[i].date === today) { history[i] = entry; found = true; break; }
  }
  if (!found) history.push(entry);
  // Keep last 365 days
  history.sort(function(a, b) { return a.date < b.date ? -1 : 1; });
  if (history.length > 365) history = history.slice(-365);
  safeLSSet('healix_va_history_' + currentUser.id, JSON.stringify(history));
}

function renderVitalityTimeline() {
  var container = document.getElementById('va-timeline');
  var chartEl = document.getElementById('va-tl-chart');
  var rangeEl = document.getElementById('va-tl-range');
  if (!container || !chartEl) return;

  var history = [];
  try { history = JSON.parse(localStorage.getItem(currentUser ? 'healix_va_history_' + currentUser.id : 'healix_va_history') || '[]'); } catch(e) {}
  if (history.length < 2) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  var pts = history.slice(-90); // Last 90 days
  var firstDate = new Date(pts[0].date + 'T12:00:00');
  var lastDate = new Date(pts[pts.length - 1].date + 'T12:00:00');
  if (rangeEl) {
    rangeEl.textContent = firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' — ' + lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Chart dimensions
  var W = 812, H = 80, padX = 30, padY = 12;
  var ages = pts.map(function(p) { return p.vAge; });
  var minAge = Math.min.apply(null, ages) - 1;
  var maxAge = Math.max.apply(null, ages) + 1;
  if (maxAge - minAge < 4) { minAge -= 1; maxAge += 1; }
  var rangeAge = maxAge - minAge || 1;

  // Build points
  var points = pts.map(function(p, i) {
    var x = pts.length === 1 ? W / 2 : padX + (i / (pts.length - 1)) * (W - 2 * padX);
    var y = padY + (1 - (p.vAge - minAge) / rangeAge) * (H - 2 * padY);
    return { x: x, y: y, vAge: p.vAge, date: p.date };
  });

  var polyline = points.map(function(p) { return p.x + ',' + p.y; }).join(' ');
  // Area fill (close path at bottom)
  var areaPath = 'M' + points[0].x + ',' + points[0].y;
  for (var i = 1; i < points.length; i++) areaPath += ' L' + points[i].x + ',' + points[i].y;
  areaPath += ' L' + points[points.length - 1].x + ',' + (H - padY) + ' L' + points[0].x + ',' + (H - padY) + ' Z';

  // Real age reference line
  var realAge = pts[pts.length - 1].realAge;
  var realY = null;
  if (realAge >= minAge && realAge <= maxAge) {
    realY = padY + (1 - (realAge - minAge) / rangeAge) * (H - 2 * padY);
  }

  var svg = '<svg class="va-timeline-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  svg += '<defs><linearGradient id="vaTimelineGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#B8975A" stop-opacity=".3"/><stop offset="100%" stop-color="#B8975A" stop-opacity="0"/></linearGradient>';
  svg += '<linearGradient id="vaTimelineLineGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#B8975A"/><stop offset="100%" stop-color="#F5D89A"/></linearGradient></defs>';

  // Grid lines
  var gridSteps = 3;
  for (var g = 0; g <= gridSteps; g++) {
    var gy = padY + (g / gridSteps) * (H - 2 * padY);
    svg += '<line x1="' + padX + '" y1="' + gy + '" x2="' + (W - padX) + '" y2="' + gy + '" class="va-tl-grid" stroke-width="1"/>';
  }

  // Real age dashed line
  if (realY !== null) {
    svg += '<line x1="' + padX + '" y1="' + realY + '" x2="' + (W - padX) + '" y2="' + realY + '" stroke="rgba(245,240,232,.1)" stroke-width="1" stroke-dasharray="4,4"/>';
    svg += '<text x="' + (W - padX + 6) + '" y="' + (realY + 3) + '" class="va-tl-label" style="font-size:8px;fill:var(--muted)">Age ' + realAge + '</text>';
  }

  // Area + line
  svg += '<path d="' + areaPath + '" class="va-tl-area"/>';
  svg += '<polyline points="' + polyline + '" class="va-tl-line"/>';

  // Dots — first, last, and any local min/max
  var last = points[points.length - 1];
  svg += '<circle cx="' + last.x + '" cy="' + last.y + '" r="4" class="va-tl-dot-latest"/>';
  if (points.length > 2) {
    svg += '<circle cx="' + points[0].x + '" cy="' + points[0].y + '" r="3" class="va-tl-dot"/>';
  }

  // Y-axis labels
  svg += '<text x="' + (padX - 6) + '" y="' + (padY + 3) + '" class="va-tl-label" text-anchor="end">' + Math.round(maxAge) + '</text>';
  svg += '<text x="' + (padX - 6) + '" y="' + (H - padY + 3) + '" class="va-tl-label" text-anchor="end">' + Math.round(minAge) + '</text>';

  // Latest value label
  svg += '<text x="' + (last.x + 8) + '" y="' + (last.y + 4) + '" style="font-family:var(--F);font-size:13px;fill:var(--gold-light);font-weight:300">' + last.vAge + '</text>';

  svg += '</svg>';
  chartEl.innerHTML = svg;
}

// ── DATA CONNECTIVITY STATE ──
// Weights reflect Vitality Age scoring — meals excluded (not part of score)
var CONNECTIVITY_WEIGHTS = { profile: 0.10, wearable: 0.35, fitness: 0.20, bloodwork: 0.35 };

function getDataConnectivityState() {
  var profile = window.userProfileData || {};
  var profileFields = [
    { key: 'birth_date', has: !!(profile.birth_date || profile.dob) },
    { key: 'gender', has: !!(profile.gender || profile.sex) },
    { key: 'height_cm', has: !!profile.height_cm },
    { key: 'current_weight_kg', has: !!profile.current_weight_kg }
  ];
  var profileFilled = profileFields.filter(function(f) { return f.has; }).length;
  var profilePct = Math.round((profileFilled / profileFields.length) * 100);
  var profileMissing = profileFields.filter(function(f) { return !f.has; }).map(function(f) { return f.key; });
  var profileConnected = profilePct >= 75;

  var dashMetrics = window._lastDashboardMetrics || {};
  var wearableConnected = (dashMetrics.hr !== null && dashMetrics.hr !== undefined)
    || !!window._healthSyncDetected
    || !!window._healthSamplesExist;
  var fitnessTested = (dashMetrics.strengthData !== null && dashMetrics.strengthData !== undefined)
    || (dashMetrics.vo2max !== null && dashMetrics.vo2max !== undefined);
  // Check dashboard bloodwork data (always loaded), fall back to bloodwork page data or raw count
  var bloodworkUploaded = (dashMetrics.bloodwork !== null && dashMetrics.bloodwork !== undefined)
    || (allBloodworkSamples && allBloodworkSamples.length > 0)
    || (window._bloodworkRawCount && window._bloodworkRawCount > 0);

  var totalConnected = 0;
  if (profileConnected) totalConnected++;
  if (wearableConnected) totalConnected++;
  if (fitnessTested) totalConnected++;
  if (bloodworkUploaded) totalConnected++;

  var progressPct = 0;
  if (profileConnected) progressPct += CONNECTIVITY_WEIGHTS.profile * 100;
  if (wearableConnected) progressPct += CONNECTIVITY_WEIGHTS.wearable * 100;
  if (fitnessTested) progressPct += CONNECTIVITY_WEIGHTS.fitness * 100;
  if (bloodworkUploaded) progressPct += CONNECTIVITY_WEIGHTS.bloodwork * 100;
  progressPct = Math.round(progressPct);

  var isFirstRun = totalConnected === 0 && profilePct < 50;
  var allComplete = totalConnected === 4;

  return {
    profile: { filled: profileFilled, pct: profilePct, missing: profileMissing, connected: profileConnected },
    wearable: { connected: wearableConnected },
    fitness: { tested: fitnessTested },
    bloodwork: { uploaded: bloodworkUploaded },
    totalConnected: totalConnected,
    progressPct: progressPct,
    isFirstRun: isFirstRun,
    allComplete: allComplete
  };
}

var DRIVER_EXPLAINERS = {
  heart: 'Your resting heart rate reflects cardiovascular fitness. Lower is generally better — elite athletes are often 50-60 bpm. This metric carries 30% of your Vitality Age score.',
  weight: 'Based on your BMI (height + weight). The optimal range is BMI 20-25. Both under and overweight are penalized, with obesity weighted more heavily. Worth 20% of your score.',
  strength: 'Average percentile across your fitness test results, compared to others your age and sex. Covers 5 domains: upper push, upper pull, lower body, core, and carry/grip. Worth 10%.',
  aerobic: 'VO2 max measures how efficiently your body uses oxygen during exercise. It\'s the single strongest predictor of all-cause mortality. Worth 5% of your score.',
  bloodwork: 'Scored from your latest lab results — glucose, cholesterol, HbA1c, and other biomarkers each compared to optimal ranges. This is the most objective measure and carries 35% of your score.'
};

var GOAL_GHOST_TEXT = {
  heart: {
    sleep_better: 'Your resting HR directly correlates with sleep quality — lower is better.',
    longevity: 'Resting HR is the #2 predictor of biological age.',
    improve_endurance: 'Track how your resting HR drops as your cardio fitness improves.',
    default: 'Heart rate reveals your cardiovascular fitness and recovery capacity.'
  },
  weight: {
    lose_weight: 'Track your weight trend and see how it affects your Vitality Age score.',
    sleep_better: 'Body composition affects sleep apnea risk and sleep quality.',
    longevity: 'Optimal BMI is associated with 3-5 years of additional lifespan.',
    default: 'Weight + height unlocks your BMI, worth 20% of your Vitality Age.'
  },
  strength: {
    gain_strength: 'See where you rank for your age and track your progress over time.',
    sleep_better: 'Strength training improves sleep onset — you fall asleep 13% faster.',
    longevity: 'Grip strength is the #1 predictor of all-cause mortality.',
    default: 'Strength benchmarks show where you stand compared to your age group.'
  },
  aerobic: {
    improve_endurance: 'VO2 max is your cardio scorecard — track it and watch it climb.',
    longevity: 'VO2 max is the single strongest predictor of how long you\'ll live.',
    sleep_better: 'Higher cardio fitness improves deep sleep duration and quality.',
    default: 'VO2 max is the #1 longevity predictor. Add yours to unlock this metric.'
  },
  bloodwork: {
    sleep_better: 'Magnesium & Vitamin D in your bloodwork directly affect sleep quality.',
    longevity: 'Blood biomarkers are worth 35% of your Vitality Age — the biggest single factor.',
    lose_weight: 'Bloodwork reveals metabolic markers that affect weight management.',
    default: 'Blood biomarkers carry the most weight in your Vitality Age calculation (35%).'
  }
};

function getGoalGhostText(driverKey) {
  var userGoal = (window.userProfileData && window.userProfileData.primary_goal) ? window.userProfileData.primary_goal.split(',')[0].trim() : '';
  var texts = GOAL_GHOST_TEXT[driverKey];
  if (!texts) return '';
  return texts[userGoal] || texts.default || '';
}

var GHOST_CTAS = {
  heart: { text: 'Heart rate reveals your cardiovascular fitness — the #2 predictor in your score.', cta: 'Connect Healix App →', action: function() { openConnectHealthBiteModal(); }, chatQ: 'Why is resting heart rate important for longevity?' },
  bp: { text: 'Blood pressure is a top cardiovascular predictor — 15% of your Vitality Age.', cta: 'Add blood pressure →', action: function() { showPage('profile', null); }, chatQ: 'Why is blood pressure important for longevity?' },
  strength: { text: 'Strength benchmarks show where you stand for your age and sex.', cta: 'Log fitness test →', action: function() { showPage('strength', null); }, chatQ: 'Why does strength matter for healthy aging?' },
  aerobic: { text: 'VO2 max is the single best predictor of longevity.', cta: 'Add VO2 max →', action: function() { showPage('strength', 'vo2max'); }, chatQ: 'What is VO2 max and why does it predict longevity?' },
  bloodwork: { text: 'Blood biomarkers are worth 35% of your score — the most impactful data you can add.', cta: 'Upload labs →', action: function() { showPage('documents', null); }, chatQ: 'What bloodwork should I get to track my health?' }
};

// Contextual chat prompts for driver cards with data
var DRIVER_CHAT_PROMPTS = {
  heart:     { low: 'How can I lower my resting heart rate?', fair: 'What can I do to improve my heart rate score?', good: 'How do I maintain a healthy resting heart rate?' },
  bp:        { low: 'What can I do to lower my blood pressure naturally?', fair: 'How can I improve my blood pressure?', good: 'How do I maintain healthy blood pressure as I age?' },
  strength:  { low: 'What strength exercises should I start with?', fair: 'How can I improve my strength percentile?', good: 'How do I keep building strength as I age?' },
  aerobic:   { low: 'How can I improve my VO2 max?', fair: 'What exercises will boost my VO2 max the most?', good: 'How do I maintain a high VO2 max?' },
  bloodwork: { low: 'Which of my blood biomarkers should I focus on improving?', fair: 'How can I improve my bloodwork results?', good: 'What do my blood results say about my overall health?' }
};

function renderDriverCards(metrics, result) {
  // Weights match mobile app (vitalityAge.ts)
  var rawWeights = { bloodwork: 0.35, aerobic: 0.20, bp: 0.15, heart: 0.15, strength: 0.15 };
  var bwPresent = scoreBloodwork(metrics.bloodwork, metrics.realAge) !== null;
  var hrPresent = metrics.hr !== null;
  var bpPresent = scoreBP(metrics.systolic, metrics.diastolic) !== null;
  var strPresent = metrics.strengthData !== null;
  var aerPresent = metrics.vo2max !== null;
  var totalAvail = (bwPresent ? rawWeights.bloodwork : 0) + (hrPresent ? rawWeights.heart : 0)
    + (bpPresent ? rawWeights.bp : 0)
    + (strPresent ? rawWeights.strength : 0) + (aerPresent ? rawWeights.aerobic : 0);
  function pctLabel(key, present) {
    if (totalAvail === 0) return Math.round(rawWeights[key] * 100) + '%';
    return present ? Math.round((rawWeights[key] / totalAvail) * 100) + '%' : Math.round(rawWeights[key] * 100) + '%';
  }

  function setDriver(key, val, score, unit, percentile) {
    var cls = score >= 70 ? 'good' : score >= 40 ? 'fair' : score > 0 ? 'low' : 'none';
    var label = score >= 70 ? 'Good' : score >= 40 ? 'Fair' : score > 0 ? 'Needs work' : 'No data';
    var card = document.getElementById('drv-' + key);
    var valEl = document.getElementById('drv-' + key + '-val');
    var barEl = document.getElementById('drv-' + key + '-bar');
    var stEl = document.getElementById('drv-' + key + '-status');
    var pctEl = document.getElementById('drv-' + key + '-pct');

    var chatEl = document.getElementById('drv-' + key + '-chat');

    // Ghost card for missing data
    if (val === null && score === 0 && GHOST_CTAS[key]) {
      var ghost = GHOST_CTAS[key];
      // If HealthBite has synced but this metric is missing, show a "waiting" state
      var wearableSynced = !!window._healthSyncDetected || !!window._healthSamplesExist;
      var ghostText = getGoalGhostText(key) || ghost.text;
      var ghostCta = ghost.cta;
      var ghostAction = ghost.action;
      if (key === 'heart' && wearableSynced) {
        ghostText = 'Healix app is connected. Heart rate data will appear here once your Apple Watch syncs resting HR.';
        ghostCta = 'View connection status →';
        ghostAction = function() { openConnectHealthBiteModal(); };
      }
      if (card) {
        card.className = 'driver-card driver-card-ghost';
        card.onclick = ghostAction;
      }
      if (valEl) {
        valEl.innerHTML = '<span class="ghost-cta-text">' + escapeHtml(ghostText) + '</span>';
        valEl.style.fontSize = '12px'; valEl.style.color = '';
      }
      if (barEl) { barEl.style.width = '0%'; barEl.className = 'driver-bar-fill'; }
      if (stEl) {
        stEl.innerHTML = '<span class="ghost-cta-link">' + escapeHtml(ghostCta) + '</span>';
        stEl.className = 'driver-status ghost';
      }
      if (pctEl) pctEl.style.display = 'none';
      // Show chat link on ghost cards too
      if (chatEl && ghost.chatQ) {
        chatEl.href = '#';
        chatEl.onclick = function(e) { e.preventDefault(); e.stopPropagation(); HealixChat.openWithQuestion(ghost.chatQ); };
        chatEl.textContent = '';
        chatEl.innerHTML = '<span class="chat-ask-arrow">→</span> Learn why';
        chatEl.className = 'chat-ask ghost-chat-ask';
        chatEl.style.display = 'inline-flex';
      }
      return;
    }

    if (valEl) {
      if (val !== null) {
        valEl.textContent = val + (unit||'');
        valEl.style.fontSize = ''; valEl.style.color = '';
      } else {
        valEl.textContent = '—';
      }
    }
    if (barEl) { barEl.style.width = score + '%'; barEl.className = 'driver-bar-fill ' + (score > 0 ? cls : ''); }
    if (stEl) { stEl.textContent = label; stEl.className = 'driver-status ' + cls; }
    if (card) {
      var extraCls = card.classList.contains('driver-hero') ? ' driver-hero' : '';
      card.className = 'driver-card' + extraCls + ' ' + (score >= 70 ? 'good' : score > 0 && score < 40 ? 'low' : '');
    }
    if (pctEl) {
      if (percentile && percentile > 0) {
        pctEl.textContent = 'Better than ' + percentile + '% of your age group';
        pctEl.style.display = '';
      } else {
        pctEl.style.display = 'none';
      }
    }
    // Contextual chat link
    if (chatEl && score > 0 && DRIVER_CHAT_PROMPTS[key]) {
      var tier = score >= 70 ? 'good' : score >= 40 ? 'fair' : 'low';
      var prompt = DRIVER_CHAT_PROMPTS[key][tier];
      chatEl.href = '#';
      chatEl.onclick = function(e) { e.preventDefault(); e.stopPropagation(); HealixChat.openWithQuestion(prompt); };
      chatEl.className = 'chat-ask driver-chat-ask';
      chatEl.style.display = '';
    } else if (chatEl) {
      chatEl.style.display = 'none';
    }
  }

  var hrScore  = metrics.hr !== null ? scoreHR(metrics.hr) : 0;
  var bpScoreVal = scoreBP(metrics.systolic, metrics.diastolic) || 0;
  var strScore = metrics.strengthData !== null ? (scoreStrength(metrics.strengthData) || 0) : 0;
  var aerScore = metrics.vo2max !== null ? (scoreVO2(metrics.vo2max, { sex: metrics.sex, age: metrics.realAge }) || 0) : 0;

  var hrVal  = metrics.hr !== null ? metrics.hr : null;
  var bpVal  = (metrics.systolic && metrics.diastolic) ? metrics.systolic + '/' + metrics.diastolic : null;
  var strVal = null;
  var strDomains = null;
  if (metrics.strengthData !== null) {
    strDomains = getCompletedDomains(metrics.strengthData);
    var allComplete = strDomains.missing.length === 0;
    var ord = metrics.strengthData.avgPercentile === 1 ? 'st' : metrics.strengthData.avgPercentile === 2 ? 'nd' : metrics.strengthData.avgPercentile === 3 ? 'rd' : 'th';
    strVal = (allComplete ? '' : '~') + metrics.strengthData.avgPercentile + ord + ' pctl';
    if (!allComplete) strVal += ' · ' + strDomains.completed.length + '/5 domains';
  }
  var aerVal = metrics.vo2max !== null
    ? metrics.vo2max + ' ml/kg/min'
    : null;

  // Build profile object for percentile lookups
  var pctProfile = {
    age: metrics.realAge || 35,
    sex: metrics.sex || 'male',
    heightCm: window.userProfileData && window.userProfileData.height_cm,
    weightKg: window.userProfileData && window.userProfileData.current_weight_kg
  };

  var hrPct = getPopulationPercentile('heart', metrics.hr, pctProfile);
  var strPct = metrics.strengthData ? (metrics.strengthData.avgPercentile || null) : null;
  var aerPct = metrics.vo2max !== null ? (scoreVO2(metrics.vo2max, { sex: metrics.sex, age: metrics.realAge }) || null) : null;

  setDriver('heart',     hrVal,  hrScore,  ' bpm', hrPct);
  setDriver('bp',        bpVal,  bpScoreVal, ' mmHg', null);
  setDriver('strength',  strVal, strScore, '', strPct);
  setDriver('aerobic',   aerVal, aerScore, '', aerPct);

  // Blood work — show connected state or ghost card
  var bwScore = scoreBloodwork(metrics.bloodwork, metrics.realAge);
  if (bwScore !== null) {
    var bwPct = getPopulationPercentile('bloodwork', bwScore, pctProfile);
    setDriver('bloodwork', bwScore + '%', bwScore, '', bwPct);
  } else {
    setDriver('bloodwork', null, 0, '', null);
  }
}

function buildInsightSentence(metrics, result) {
  if (!result) return null;
  var diff = (metrics.realAge || 35) - result.vAge;
  var primary = '';

  // Lead with the highest-weighted signal that has data
  if (metrics.hr !== null) {
    var hs = scoreHR(metrics.hr);
    if (hs >= 78)      primary = 'Resting HR of ' + metrics.hr + ' bpm reflects strong cardiovascular fitness.';
    else if (hs >= 50) primary = 'Resting HR of ' + metrics.hr + ' bpm is average — consistent aerobic training will move this needle.';
    else               primary = 'Resting HR of ' + metrics.hr + ' bpm is elevated and is the biggest drag on your score.';
  }

  // Add secondary signal
  var secondary = '';
  if (!result.bloodworkConnected) {
    secondary = ' Uploading blood work will unlock the highest-weighted signal (40%).';
  } else if (!metrics.strengthData) {
    secondary = ' Log fitness tests to unlock your strength score.';
  }

  if (!primary) return null;
  return primary + secondary;
}

// ── Sleep processing functions (session-based) ──
function mapSleepStage(value) {
  if (!value) return null;
  var stage = (typeof value === 'number') ? '' : value.toLowerCase();
  if (stage.includes('deep')) return 'deep';
  if (stage.includes('rem')) return 'rem';
  if (stage.includes('core')) return 'core';
  if (stage.includes('awake') || stage.includes('in_bed') || stage.includes('inbed')) return 'awake';
  if (stage.includes('asleep') || stage === 'sleeping') return 'core';
  return null;
}

function identifySleepSessions(samples) {
  var sorted = samples.slice().sort(function(a, b) { return new Date(a.start_date) - new Date(b.start_date); });
  var sessions = [];
  var currentSession = [];
  var lastEndMs = null;
  for (var i = 0; i < sorted.length; i++) {
    var sample = sorted[i];
    var startMs = new Date(sample.start_date).getTime();
    var endMs = new Date(sample.end_date).getTime();
    var gapMinutes = lastEndMs != null ? (startMs - lastEndMs) / (1000 * 60) : 0;
    if (lastEndMs == null || gapMinutes > 45) {
      if (currentSession.length > 0) {
        var sessStart = new Date(currentSession[0].start_date).getTime();
        var sessEnd = new Date(currentSession[currentSession.length - 1].end_date).getTime();
        if ((sessEnd - sessStart) / (1000 * 60 * 60) >= 2) {
          sessions.push({ startTime: sessStart, endTime: sessEnd, samples: currentSession.slice() });
        }
      }
      currentSession = [sample];
    } else {
      currentSession.push(sample);
    }
    lastEndMs = endMs;
  }
  if (currentSession.length > 0) {
    var sessStart = new Date(currentSession[0].start_date).getTime();
    var sessEnd = new Date(currentSession[currentSession.length - 1].end_date).getTime();
    if ((sessEnd - sessStart) / (1000 * 60 * 60) >= 2) {
      sessions.push({ startTime: sessStart, endTime: sessEnd, samples: currentSession.slice() });
    }
  }
  return sessions.sort(function(a, b) { return b.startTime - a.startTime; });
}

function computeSessionMinutes(session) {
  var stages = { deep: 0, rem: 0, core: 0, awake: 0 };
  var total = 0;
  for (var i = 0; i < session.samples.length; i++) {
    var s = session.samples[i];
    var stage = mapSleepStage(s.value || s.text_value);
    if (stage === null) continue;
    var duration = (new Date(s.end_date) - new Date(s.start_date)) / (1000 * 60);
    stages[stage] += duration;
    total += duration;
  }
  var actualSleep = stages.deep + stages.rem + stages.core;
  return { totalMinutes: total, actualSleepMinutes: actualSleep, stages: stages };
}

function calculateSleepTrend(sessions) {
  var now = Date.now();
  var msPerDay = 24 * 60 * 60 * 1000;
  var thisWeek = [];
  var lastWeek = [];
  for (var i = 0; i < sessions.length; i++) {
    var daysAgo = (now - sessions[i].startTime) / msPerDay;
    if (daysAgo <= 7) {
      thisWeek.push(computeSessionMinutes(sessions[i]).actualSleepMinutes / 60);
    } else if (daysAgo <= 14) {
      lastWeek.push(computeSessionMinutes(sessions[i]).actualSleepMinutes / 60);
    }
  }
  if (thisWeek.length === 0 || lastWeek.length === 0) return null;
  var thisWeekAvg = thisWeek.reduce(function(s, h) { return s + h; }, 0) / thisWeek.length;
  var lastWeekAvg = lastWeek.reduce(function(s, h) { return s + h; }, 0) / lastWeek.length;
  var deltaHours = Math.round((thisWeekAvg - lastWeekAvg) * 10) / 10;
  var direction = deltaHours >= 0.25 ? 'improving' : deltaHours <= -0.25 ? 'declining' : 'stable';
  return { thisWeekAvg: Math.round(thisWeekAvg * 10) / 10, lastWeekAvg: Math.round(lastWeekAvg * 10) / 10, deltaHours: deltaHours, direction: direction };
}

// ── SLEEP PAGE ──
var sleepPageRange = 14;
var sleepPageSessions = [];

function setSleepRange(days, btn) {
  sleepPageRange = days;
  var btns = document.querySelectorAll('#page-sleep .tf-btn');
  btns.forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  loadSleepPage();
}

async function loadSleepPage() {
  if (!currentUser) return;
  var s = getSession(); if (!s) return;
  var token = s.access_token;
  // Fetch range + 7-day buffer for sessions spanning midnight
  var daysAgo = new Date();
  daysAgo.setDate(daysAgo.getDate() - sleepPageRange - 7);

  try {
    var data = await supabaseRequest(
      '/rest/v1/apple_health_samples?select=metric_type,start_date,end_date,value,text_value,recorded_at' +
      '&user_id=eq.' + currentUser.id +
      '&metric_type=eq.sleep_analysis&recorded_at=gte.' + daysAgo.toISOString() +
      '&order=recorded_at.desc&limit=1000',
      'GET', null, token
    );
    if (!data || data.error || !Array.isArray(data) || data.length === 0) {
      showSleepEmpty(true);
      return;
    }
    sleepPageSessions = identifySleepSessions(data);
    if (sleepPageSessions.length === 0) { showSleepEmpty(true); return; }
    showSleepEmpty(false);
    renderSleepPageData();
  } catch(e) {
    console.error('[Healix] Sleep page load error:', e);
    showSleepEmpty(true);
  }
}

function showSleepEmpty(show) {
  var empty = document.getElementById('sleep-empty');
  var scores = document.getElementById('sleep-scores');
  var cta = document.getElementById('sleep-chat-cta');
  if (empty) empty.style.display = show ? 'block' : 'none';
  if (scores) scores.style.display = show ? 'none' : '';
  if (cta) cta.style.display = show ? 'none' : '';
  // Hide the cards too
  var cards = document.querySelectorAll('#page-sleep > .card');
  cards.forEach(function(c) { c.style.display = show ? 'none' : ''; });
}

function renderSleepPageData() {
  var now = Date.now();
  var msPerDay = 24 * 60 * 60 * 1000;
  var cutoff = now - sleepPageRange * msPerDay;

  // Filter sessions to range
  var sessions = sleepPageSessions.filter(function(s) { return s.startTime >= cutoff; });
  if (sessions.length === 0) { showSleepEmpty(true); return; }
  showSleepEmpty(false);

  // Compute per-session data
  var sessionData = sessions.map(function(sess) {
    var computed = computeSessionMinutes(sess);
    // Attribute sessions starting before noon to the previous calendar day
    // so a 3am fragment is grouped with the night it belongs to
    var sleepDate = new Date(sess.startTime);
    if (sleepDate.getHours() < 12) {
      sleepDate.setDate(sleepDate.getDate() - 1);
    }
    var dateStr = localDateStr(sleepDate);
    return {
      date: dateStr,
      startTime: sess.startTime,
      endTime: sess.endTime,
      totalHours: Math.round(computed.actualSleepMinutes / 60 * 10) / 10,
      stages: computed.stages,
      totalMinutes: computed.totalMinutes,
      actualMinutes: computed.actualSleepMinutes,
      efficiency: computed.totalMinutes > 0 ? Math.round(computed.actualSleepMinutes / computed.totalMinutes * 100) : 0
    };
  }).sort(function(a, b) { return b.startTime - a.startTime; });

  // Merge sessions that share the same sleep-night date
  var mergedMap = {};
  sessionData.forEach(function(d) {
    if (!mergedMap[d.date]) {
      mergedMap[d.date] = { date: d.date, startTime: d.startTime, endTime: d.endTime, totalHours: 0, stages: { deep: 0, rem: 0, core: 0, awake: 0 }, totalMinutes: 0, actualMinutes: 0, efficiency: 0 };
    }
    var m = mergedMap[d.date];
    m.totalMinutes += d.totalMinutes;
    m.actualMinutes += d.actualMinutes;
    m.stages.deep += d.stages.deep;
    m.stages.rem += d.stages.rem;
    m.stages.core += d.stages.core;
    m.stages.awake += d.stages.awake;
    if (d.startTime < m.startTime) m.startTime = d.startTime;
    if (d.endTime > m.endTime) m.endTime = d.endTime;
  });
  sessionData = Object.keys(mergedMap).map(function(k) {
    var m = mergedMap[k];
    m.totalHours = Math.round(m.actualMinutes / 60 * 10) / 10;
    m.efficiency = m.totalMinutes > 0 ? Math.round(m.actualMinutes / m.totalMinutes * 100) : 0;
    return m;
  }).sort(function(a, b) { return b.date > a.date ? -1 : a.date > b.date ? 1 : 0; }).reverse();

  // Score cards
  var latest = sessionData[0];
  var avgHours = Math.round(sessionData.reduce(function(s, d) { return s + d.totalHours; }, 0) / sessionData.length * 10) / 10;

  // Sleep debt (last 7 nights) — net deficit so a great night offsets a bad one.
  // Floor at 0 once at the end (no negative debt).
  var TARGET = 7;
  var recentSessions = sessionData.slice(0, 7);
  var totalRecentHours = recentSessions.reduce(function(s, n) { return s + n.totalHours; }, 0);
  var netDeficit = TARGET * recentSessions.length - totalRecentHours;
  var debt = Math.round(Math.max(0, netDeficit) * 10) / 10;

  // Sleep score
  // Cap nights to 21 for score consistency with the dashboard's 21-day window
  var sleepScore = scoreSleep({ avg: avgHours, nights: Math.min(sessionData.length, 21), debt: debt });

  var safeSet = function(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
  // "7h 53m" — floor hours so a 7h53m night doesn't read 7.9h.
  var formatHm = function(mins) {
    var m = Math.max(0, Math.round(mins || 0));
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  };
  var formatClock = function(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  safeSet('slp-last', formatHm(latest.actualMinutes));
  safeSet('slp-last-sub', formatClock(latest.startTime) + ' → ' + formatClock(latest.endTime) + ' · ' + Math.round(latest.efficiency) + '% efficiency');
  safeSet('slp-avg', avgHours);
  // Append trend direction when computable (≥2 nights in each of this/last week).
  var trend = calculateSleepTrend(sessions);
  var avgSubBase = 'hours/night · ' + sessionData.length + ' nights';
  if (trend && trend.direction !== 'stable') {
    var arrow = trend.direction === 'improving' ? '↑' : '↓';
    avgSubBase += ' · ' + arrow + ' ' + Math.abs(trend.deltaHours).toFixed(1) + 'h vs last week';
  }
  safeSet('slp-avg-sub', avgSubBase);

  // Sleep debt: needs at least 2 nights to be meaningful (matches mobile's
  // 721ca5a fix). Show informational subtext otherwise.
  var debtEl = document.getElementById('slp-debt');
  if (recentSessions.length >= 2) {
    safeSet('slp-debt', debt);
    if (debtEl) debtEl.style.color = debt > 7 ? 'var(--down)' : debt > 3 ? 'var(--warn)' : 'var(--cream)';
    safeSet('slp-debt-sub', debt <= 1 ? 'well rested' : debt <= 3 ? 'mild deficit' : debt <= 7 ? 'moderate deficit' : 'high deficit');
  } else {
    safeSet('slp-debt', '—');
    if (debtEl) debtEl.style.color = 'var(--cream)';
    safeSet('slp-debt-sub', 'need 2+ nights of data');
  }
  safeSet('slp-score', sleepScore !== null ? sleepScore : '—');
  var scoreEl = document.getElementById('slp-score');
  if (scoreEl && sleepScore !== null) scoreEl.style.color = sleepScore >= 70 ? 'var(--up)' : sleepScore >= 50 ? 'var(--gold)' : 'var(--down)';
  safeSet('slp-score-sub', 'out of 100');

  // HRV card — show if we have HRV data
  var hrvCard = document.getElementById('slp-hrv-card');
  if (hrvCard) {
    var byType = window._lastHealthByType || {};
    var hrvRows = byType['heart_rate_variability_sdnn'] || [];
    if (hrvRows.length > 0) {
      var latestHrv = Math.round(parseFloat(hrvRows[0].value));
      hrvCard.style.display = '';
      safeSet('slp-hrv', latestHrv);
      // 7-day average for context
      var recentHrv = hrvRows.slice(0, 7);
      var hrvAvg = Math.round(recentHrv.reduce(function(s, r) { return s + parseFloat(r.value || 0); }, 0) / Math.max(recentHrv.length, 1));
      var hrvDelta = latestHrv - hrvAvg;
      var hrvEl = document.getElementById('slp-hrv');
      if (hrvEl) hrvEl.style.color = latestHrv >= 50 ? 'var(--up)' : latestHrv >= 30 ? 'var(--gold)' : 'var(--down)';
      safeSet('slp-hrv-sub', 'ms SDNN' + (recentHrv.length > 1 ? ' · avg ' + hrvAvg + 'ms' : ''));
      // Update sleep-scores grid to 5 columns
      var grid = document.getElementById('sleep-scores');
      if (grid) grid.style.gridTemplateColumns = 'repeat(5, 1fr)';
    }
  }

  // Stage breakdown chart — stacked bars
  renderSleepStageChart(sessionData);

  // Bedtime consistency (matches mobile 60892e9)
  renderBedtimeConsistency(sessionData);

  // Sleep insights — filter the cached dashboard rule run to sleep-relevant cards
  renderSleepInsights();

  // Calendar
  renderSleepCalendar(sessionData);

  // Show chat CTA
  var cta = document.getElementById('sleep-chat-cta');
  if (cta) cta.style.display = 'block';
}

// Convert any timestamp to minutes since 6pm so bedtimes wrap around midnight
// in a single linear axis (6pm = 0, midnight = 360, 6am = 720).
function minutesSince6pm(ts) {
  var d = new Date(ts);
  var h = d.getHours();
  var m = d.getMinutes();
  return (h >= 18 ? h - 18 : h + 6) * 60 + m;
}

function formatMinutesSince6pm(mins) {
  var hourSince6 = Math.floor(mins / 60);
  var min = Math.floor(mins % 60);
  var hour24 = (18 + hourSince6) % 24;
  var period = hour24 < 12 ? 'AM' : 'PM';
  var hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return hour12 + ':' + (min < 10 ? '0' : '') + min + ' ' + period;
}

function renderBedtimeConsistency(sessionData) {
  var container = document.getElementById('sleep-bedtime-consistency');
  if (!container) return;

  if (sessionData.length < 3) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px">Need at least 3 nights of data to compute bedtime consistency.</div>';
    return;
  }

  var mins = sessionData.map(function(s) { return minutesSince6pm(s.startTime); });
  var avg = mins.reduce(function(a, b) { return a + b; }, 0) / mins.length;
  var variance = mins.reduce(function(s, v) { return s + (v - avg) * (v - avg); }, 0) / mins.length;
  var stddev = Math.sqrt(variance);
  var stddevMin = Math.round(stddev);

  var status = stddev <= 30 ? 'consistent' : stddev <= 60 ? 'variable' : 'irregular';
  var statusColor = stddev <= 30 ? 'var(--up)' : stddev <= 60 ? 'var(--warn)' : 'var(--down)';

  var html = '';
  html += '<div style="display:flex;gap:24px;margin-bottom:16px">';
  html += '<div style="flex:1"><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Avg Bedtime</div>';
  html += '<div style="font-family:var(--F);font-size:24px;color:var(--cream)">' + formatMinutesSince6pm(avg) + '</div></div>';
  html += '<div style="flex:1"><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Variance</div>';
  html += '<div style="font-family:var(--F);font-size:24px;color:var(--cream)">±' + stddevMin + ' min</div></div>';
  html += '<div style="flex:1"><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Status</div>';
  html += '<div style="font-family:var(--F);font-size:24px;color:' + statusColor + ';text-transform:capitalize">' + status + '</div></div>';
  html += '</div>';

  html += '<div style="border-top:1px solid var(--gold-border);padding-top:12px">';
  sessionData.slice(0, 7).forEach(function(s) {
    var bm = minutesSince6pm(s.startTime);
    var dev = Math.round(bm - avg);
    var devSign = dev > 0 ? '+' : '';
    var devColor = Math.abs(dev) <= 30 ? 'var(--up)' : Math.abs(dev) <= 60 ? 'var(--warn)' : 'var(--down)';
    var dt = new Date(s.date + 'T12:00:00');
    var dateLabel = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    var bedtime = new Date(s.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px">';
    html += '<span style="color:var(--cream-dim);flex:1">' + dateLabel + '</span>';
    html += '<span style="color:var(--cream);font-family:var(--F);flex:1;text-align:center">' + bedtime + '</span>';
    html += '<span style="color:' + devColor + ';flex:1;text-align:right">' + devSign + dev + ' min</span>';
    html += '</div>';
  });
  html += '</div>';

  container.innerHTML = html;
}

function renderSleepInsights() {
  var card = document.getElementById('sleep-insights-card');
  var list = document.getElementById('sleep-insights-list');
  if (!card || !list) return;

  var all = window._lastInsights || [];
  // Match mobile's filter: sleep-domain rules plus cross-domain rules whose
  // text mentions sleep/bedtime.
  var sleepRelated = all.filter(function(ins) {
    if (!ins) return false;
    if (ins.domain === 'sleep') return true;
    var text = ((ins.headline || '') + ' ' + (ins.body || '')).toLowerCase();
    return /sleep|bedtime|rem|deep stage/.test(text);
  });

  if (sleepRelated.length === 0) {
    card.style.display = 'none';
    return;
  }

  var html = sleepRelated.slice(0, 6).map(function(ins) {
    var sev = ins.severity || ins._severity || 'neutral';
    var sevColor = sev === 'alert' ? 'var(--down)' : sev === 'attention' ? 'var(--warn)' : sev === 'positive' ? 'var(--up)' : 'var(--cream)';
    return '<div style="padding:12px 0;border-bottom:1px solid var(--gold-border)">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
      + '<span style="width:6px;height:6px;border-radius:50%;background:' + sevColor + ';display:inline-block"></span>'
      + '<span style="font-family:var(--F);font-size:16px;color:var(--cream)">' + escapeHtml(ins.headline || '') + '</span>'
      + '</div>'
      + '<div style="font-size:13px;color:var(--cream-dim);line-height:1.5">' + escapeHtml(ins.body || '') + '</div>'
      + '</div>';
  }).join('');

  list.innerHTML = html;
  card.style.display = '';
}

function renderSleepStageChart(sessionData) {
  var container = document.getElementById('sleep-stage-chart');
  if (!container) return;

  // <2 nights of data isn't meaningful as a chart (matches mobile 922c762).
  if (sessionData.length < 2) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Need at least 2 nights of data to show the stage chart.</div>';
    return;
  }

  // Show most recent N sessions (reverse to chronological order)
  var maxBars = Math.min(sessionData.length, sleepPageRange);
  var data = sessionData.slice(0, maxBars).reverse();

  // Find max total for scaling
  var maxMinutes = data.length > 0 ? Math.max.apply(null, data.map(function(d) { return d.totalMinutes; })) : 0;
  if (maxMinutes <= 0) maxMinutes = 480;

  var html = '<div style="display:flex;gap:3px;align-items:flex-end;height:140px">';
  data.forEach(function(d) {
    var deepH = (d.stages.deep / maxMinutes * 120);
    var remH = (d.stages.rem / maxMinutes * 120);
    var coreH = (d.stages.core / maxMinutes * 120);
    var awakeH = (d.stages.awake / maxMinutes * 120);
    var dt = new Date(d.date + 'T12:00:00');
    var dayLabel = (dt.getMonth() + 1) + '/' + dt.getDate();
    var dayOfWeek = dt.toLocaleDateString('en-US', { weekday: 'short' });

    html += '<div class="sleep-stage-bar">';
    html += '<div class="sleep-stage-hours">' + d.totalHours + 'h</div>';
    // Stack order matches industry convention: awake on top, deep at bottom.
    html += '<div class="sleep-stage-stack">';
    html += '<div class="sleep-stage-seg" style="height:' + awakeH + 'px;background:rgba(245,240,232,0.15)"></div>';
    html += '<div class="sleep-stage-seg" style="height:' + remH + 'px;background:var(--sleep-rem)"></div>';
    html += '<div class="sleep-stage-seg" style="height:' + coreH + 'px;background:var(--sleep-core)"></div>';
    html += '<div class="sleep-stage-seg" style="height:' + deepH + 'px;background:var(--sleep-deep)"></div>';
    html += '</div>';
    html += '<div class="sleep-stage-date">' + dayOfWeek + '<br>' + dayLabel + '</div>';
    html += '</div>';
  });
  html += '</div>';

  // Stage averages summary
  var avgDeep = Math.round(data.reduce(function(s, d) { return s + d.stages.deep; }, 0) / data.length);
  var avgRem = Math.round(data.reduce(function(s, d) { return s + d.stages.rem; }, 0) / data.length);
  var avgCore = Math.round(data.reduce(function(s, d) { return s + d.stages.core; }, 0) / data.length);
  html += '<div style="display:flex;gap:20px;margin-top:16px;padding-top:12px;border-top:1px solid var(--gold-border)">';
  html += '<div style="flex:1"><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--sleep-deep);margin-bottom:4px">Avg Deep</div><div style="font-family:var(--F);font-size:20px;color:var(--cream)">' + Math.floor(avgDeep / 60) + 'h ' + (avgDeep % 60) + 'm</div></div>';
  html += '<div style="flex:1"><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--sleep-rem);margin-bottom:4px">Avg REM</div><div style="font-family:var(--F);font-size:20px;color:var(--cream)">' + Math.floor(avgRem / 60) + 'h ' + (avgRem % 60) + 'm</div></div>';
  html += '<div style="flex:1"><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--sleep-core);margin-bottom:4px">Avg Core</div><div style="font-family:var(--F);font-size:20px;color:var(--cream)">' + Math.floor(avgCore / 60) + 'h ' + (avgCore % 60) + 'm</div></div>';
  html += '</div>';

  container.innerHTML = html;
}

function renderSleepCalendar(sessionData) {
  var container = document.getElementById('sleep-calendar');
  if (!container) return;

  // Build lookup: date string → session data
  var byDate = {};
  sessionData.forEach(function(d) { byDate[d.date] = d; });

  // Determine calendar range
  var today = new Date();
  var startDate = new Date(today);
  startDate.setDate(startDate.getDate() - sleepPageRange + 1);

  // Align to start of week (Sunday)
  var calStart = new Date(startDate);
  calStart.setDate(calStart.getDate() - calStart.getDay());

  // Align end to end of week (Saturday)
  var calEnd = new Date(today);
  calEnd.setDate(calEnd.getDate() + (6 - calEnd.getDay()));

  var html = '';
  // Day headers
  var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  dayNames.forEach(function(d) { html += '<div class="sleep-cal-header">' + d + '</div>'; });

  // Day cells
  var cursor = new Date(calStart);
  while (cursor <= calEnd) {
    var dateStr = localDateStr(cursor);
    var inRange = cursor >= startDate && cursor <= today;
    var data = byDate[dateStr];

    if (!inRange) {
      html += '<div class="sleep-cal-day empty"></div>';
    } else if (!data) {
      html += '<div class="sleep-cal-day no-data"><div class="sleep-cal-date">' + cursor.getDate() + '</div></div>';
    } else {
      var cls = data.totalHours >= 7 ? 'great' : data.totalHours >= 6 ? 'good' : data.totalHours >= 5 ? 'fair' : 'poor';
      html += '<div class="sleep-cal-day ' + cls + '">';
      html += '<div class="sleep-cal-hours">' + data.totalHours + '</div>';
      html += '<div class="sleep-cal-date">' + cursor.getDate() + '</div>';
      html += '</div>';
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  container.innerHTML = html;
}

async function loadDashboardData() {
  if (!currentUser) return;
  var freshSession = await ensureFreshToken();
  if (!freshSession) { handleAuthFailure(); return; }
  currentSession = freshSession;
  var token = freshSession.access_token;
  var today = localDateStr(new Date());

  // Real age from profile — try birth_date first, then dob
  var realAge = 35;
  var dobStr = (window.userProfileData && (window.userProfileData.birth_date || window.userProfileData.dob)) || null;
  if (dobStr) {
    var dob = new Date(dobStr);
    if (!isNaN(dob)) realAge = Math.floor((new Date() - dob) / (365.25 * 24 * 3600 * 1000));
  }
  console.log('[Healix] Dashboard loading — realAge:', realAge, 'profile:', window.userProfileData ? Object.keys(window.userProfileData) : 'null');

  var sex = (window.userProfileData && window.userProfileData.sex) || 'male';
  var metrics = { hr: null, hrv: null, vo2max: null, sex: sex, weightScore: null, weightVal: null, strengthData: null, bloodwork: null, sleep: null, sleepData: null, steps: null, nutritionScore: null, realAge: realAge, systolic: null, diastolic: null };
  var timestamps = {};

  // 1. Health data (last 14 days for context)
  try {
    var daysAgo = new Date(); daysAgo.setDate(daysAgo.getDate() - 21);
    var healthData = await supabaseRequest(
      '/rest/v1/apple_health_samples?select=metric_type,start_date,end_date,value,text_value,recorded_at&user_id=eq.' + currentUser.id + '&recorded_at=gte.' + daysAgo.toISOString() + '&order=recorded_at.desc',
      'GET', null, token
    );
    console.log('[Healix] healthData rows:', healthData ? (healthData.error ? 'ERROR:'+JSON.stringify(healthData.error) : healthData.length) : 'null');
    window._healthSamplesExist = healthData && !healthData.error && healthData.length > 0;
    if (healthData && !healthData.error) {
      var byType = {};
      healthData.forEach(function(r) {
        if (!byType[r.metric_type]) byType[r.metric_type] = [];
        byType[r.metric_type].push(r);
      });
      window._lastHealthByType = byType;
      console.log('[Healix] health metric types:', Object.keys(byType));

      // Sleep — session-based processing per CTO spec
      var sleepRows = byType['sleep_analysis'] || [];
      if (sleepRows.length > 0) {
        var sessions = identifySleepSessions(sleepRows);
        if (sessions.length > 0) {
          var mostRecent = computeSessionMinutes(sessions[0]);
          var latestSleep = Math.round((mostRecent.actualSleepMinutes / 60) * 10) / 10;
          // Compute per-session actual sleep hours for averages and debt
          var sessionSleepHours = sessions.map(function(sess) {
            return computeSessionMinutes(sess).actualSleepMinutes / 60;
          });
          var avgSleep = Math.round(sessionSleepHours.reduce(function(s, h) { return s + h; }, 0) / sessionSleepHours.length * 10) / 10;
          // Sleep debt: net deficit across the last 7 nights, floor at 0 once at the end.
          var TARGET_SLEEP = 7;
          var recentSessions = sessionSleepHours.slice(0, 7);
          var totalRecentSleep = recentSessions.reduce(function(s, h) { return s + h; }, 0);
          var sleepDebtNet = TARGET_SLEEP * recentSessions.length - totalRecentSleep;
          var sleepDebt = Math.round(Math.max(0, sleepDebtNet) * 10) / 10;
          var totalHours = Math.round((mostRecent.actualSleepMinutes / 60) * 10) / 10;
          var totalMinutes = Math.round(mostRecent.actualSleepMinutes);
          var stageBreakdown = {};
          var stageKeys = ['deep', 'rem', 'core', 'awake'];
          for (var si = 0; si < stageKeys.length; si++) {
            var sk = stageKeys[si];
            var mins = Math.round(mostRecent.stages[sk]);
            stageBreakdown[sk] = { minutes: mins, pct: mostRecent.totalMinutes > 0 ? Math.round((mostRecent.stages[sk] / mostRecent.totalMinutes) * 100) : 0 };
          }
          var efficiency = mostRecent.totalMinutes > 0 ? Math.round((mostRecent.actualSleepMinutes / mostRecent.totalMinutes) * 100) : 0;
          var bedtime = new Date(sessions[0].startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          var wakeTime = new Date(sessions[0].endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          var trend = calculateSleepTrend(sessions);
          metrics.sleep = latestSleep;
          metrics.sleepData = { latest: latestSleep, avg: avgSleep, nights: sessions.length, debt: sleepDebt, totalHours: totalHours, totalMinutes: totalMinutes, stages: stageBreakdown, efficiency: efficiency, bedtime: bedtime, wakeTime: wakeTime, trend: trend };
        }
      }

      // Steps — source-deduped to avoid iPhone+Apple Watch double-count.
      var stepsRows = byType['step_count'] || [];
      var todaySteps = dedupedDailyTotal(stepsRows, today);
      if (todaySteps === 0 && stepsRows.length > 0) todaySteps = parseFloat(stepsRows[0].value || 0);
      if (todaySteps > 0) metrics.steps = Math.round(todaySteps);

      // HR — prefer Apple's resting_heart_rate when present (Apple Watch only).
      // For 3rd-party wearables (Garmin/Oura/etc.) only raw heart_rate is written,
      // so estimate resting from the 10th percentile of recent readings — a
      // standard clinical approximation when no dedicated resting measurement exists.
      var restingHrRows = byType['resting_heart_rate'] || [];
      var instantHrRows = byType['heart_rate'] || [];
      if (restingHrRows.length > 0) {
        metrics.hr = Math.round(parseFloat(restingHrRows[0].value));
        timestamps.heart_rate = restingHrRows[0].recorded_at;
      } else if (instantHrRows.length > 0) {
        var bpms = [];
        for (var hi = 0; hi < Math.min(instantHrRows.length, 100); hi++) {
          var bpm = parseFloat(instantHrRows[hi].value);
          if (isFinite(bpm) && bpm >= 30 && bpm <= 200) bpms.push(bpm);
        }
        if (bpms.length > 0) {
          bpms.sort(function(a, b) { return a - b; });
          var p10Idx = Math.max(0, Math.floor(bpms.length * 0.1));
          metrics.hr = Math.round(bpms[p10Idx]);
          timestamps.heart_rate = instantHrRows[0].recorded_at;
        }
      }

      // HRV — SDNN from Apple Watch (ms)
      var hrvRows = byType['heart_rate_variability_sdnn'] || [];
      if (hrvRows.length > 0) {
        metrics.hrv = Math.round(parseFloat(hrvRows[0].value));
        timestamps.hrv = hrvRows[0].recorded_at;
      }

      // Timestamps for sleep and steps
      if (sleepRows.length > 0 && sessions && sessions.length > 0) {
        timestamps.sleep = new Date(sessions[0].endTime).toISOString();
      }
      if (stepsRows.length > 0) {
        timestamps.steps = stepsRows[0].start_date || stepsRows[0].recorded_at;
      }

    }
  } catch(e) { console.error('Health error:', e); }

  // 1b. Pre-fetch weight logs so getMacroTargets() can use them as fallback
  try {
    var wlData = await supabaseRequest(
      '/rest/v1/weight_logs?user_id=eq.' + currentUser.id + '&order=logged_at.desc&limit=14',
      'GET', null, token
    ).catch(function() { return []; });
    if (wlData && !wlData.error && wlData.length > 0) {
      weightEntries = wlData;
    }
  } catch(e) { /* weight_logs table may not exist yet */ }

  // 2. Meals / nutrition score
  try {
    var mealLogs = await supabaseRequest(
      '/rest/v1/meal_log?select=id,meal_type,meal_time,meal_description,created_at,data&user_id=eq.' + currentUser.id + '&order=created_at.desc&limit=100',
      'GET', null, token
    );
    console.log('[Healix] mealLogs:', mealLogs ? (mealLogs.error ? 'ERROR' : mealLogs.length) : 'null');
    if (mealLogs && !mealLogs.error && Array.isArray(mealLogs)) {
      window._lastDashboardMeals = mealLogs;
    }
    if (mealLogs && !mealLogs.error && mealLogs.length > 0) {
      var todayMeals = mealLogs.filter(function(m) {
        return localDateStr(new Date(m.meal_time || m.created_at)) === today;
      });
      console.log('[Healix] todayMeals:', todayMeals.length, 'today=', today);
      if (todayMeals.length > 0) {
        var totals = { cal: 0, prot: 0, carb: 0, fat: 0 };
        todayMeals.forEach(function(m) {
          var mac = getMacrosFromMeal(m);
          totals.cal  += mac.cal  || 0;
          totals.prot += mac.prot || 0;
          totals.carb += mac.carb || 0;
          totals.fat  += mac.fat  || 0;
        });
        // Score: calories within goal = 40pts, protein >= 80% goal = 30pts, logged at least 2 meals = 30pts
        var macroGoals = getMacroTargets();
        var calScore  = totals.cal  > 0 ? Math.min(40, Math.round(40 * Math.min(1, 1 - Math.abs(totals.cal - macroGoals.cal) / macroGoals.cal))) : 0;
        var protScore = totals.prot > 0 ? Math.min(30, Math.round(30 * Math.min(1, totals.prot / macroGoals.prot))) : 0;
        var mealScore = Math.min(30, todayMeals.length * 15);
        metrics.nutritionScore = calScore + protScore + mealScore;
        // Also update macro display elements used by dashboard
        renderMacrosFromMealData(todayMeals);
      } else {
        metrics.nutritionScore = 0;
      }
    }
  } catch(e) { console.error('Meal error:', e); }

  // 3. Strength — fitness test percentile average (latest per test type, all test types)
  try {
    var strengthTests = await supabaseRequest(
      '/rest/v1/fitness_tests?user_id=eq.' + currentUser.id + '&order=tested_at.desc&limit=200',
      'GET', null, token
    );
    if (strengthTests && !strengthTests.error && strengthTests.length > 0) {
      // Deduplicate: keep only the latest result per test_key
      var latestByKey = {};
      strengthTests.forEach(function(t) {
        if (!latestByKey[t.test_key]) latestByKey[t.test_key] = t;
      });
      var percentiles = [];
      Object.keys(latestByKey).forEach(function(k) {
        var t = latestByKey[k];
        if (t.percentile != null) percentiles.push(parseFloat(t.percentile));
      });
      var uniqueTestTypes = Object.keys(latestByKey).length;
      var avgPctl = percentiles.length > 0 ? Math.round(percentiles.reduce(function(s, p) { return s + p; }, 0) / percentiles.length) : 50;
      metrics.strengthData = { testCount: strengthTests.length, avgPercentile: avgPctl, uniqueTestTypes: uniqueTestTypes, tests: strengthTests };
      timestamps.strength = strengthTests[0].tested_at;
    } else {
      metrics.strengthData = null;
    }
  } catch(e) { metrics.strengthData = null; }

  // 4. Weight — BMI-based scoring from user profile
  try {
    var weightKg = window.userProfileData && window.userProfileData.current_weight_kg;
    var heightCm = window.userProfileData && window.userProfileData.height_cm;
    if (weightKg) {
      metrics.weightVal = Math.round(weightKg * 2.205);
      metrics.weightScore = scoreWeight(weightKg, heightCm);
    }
    // Get weight timestamp from latest weight log
    var weightLogs = await supabaseRequest(
      '/rest/v1/weight_logs?user_id=eq.' + currentUser.id + '&order=logged_at.desc&limit=1',
      'GET', null, token
    ).catch(function() { return []; });
    if (weightLogs && !weightLogs.error && weightLogs.length > 0) {
      timestamps.weight = weightLogs[0].logged_at;
    }
  } catch(e) { /* weight/height not available */ }

  // 4b. Blood Pressure — from user profile
  try {
    var systolicBp = window.userProfileData && window.userProfileData.systolic_bp;
    var diastolicBp = window.userProfileData && window.userProfileData.diastolic_bp;
    if (systolicBp && diastolicBp) {
      metrics.systolic = parseFloat(systolicBp);
      metrics.diastolic = parseFloat(diastolicBp);
    }
  } catch(e) { /* BP not available */ }

  // 5. VO2 Max — latest fitness test result
  try {
    var vo2Tests = await supabaseRequest(
      '/rest/v1/fitness_tests?user_id=eq.' + currentUser.id + '&test_key=eq.vo2max&order=tested_at.desc&limit=1',
      'GET', null, token
    );
    if (vo2Tests && !vo2Tests.error && vo2Tests.length > 0) {
      metrics.vo2max = parseFloat(vo2Tests[0].raw_value);
      timestamps.vo2max = vo2Tests[0].tested_at;
    }
  } catch(e) { console.error('VO2 fetch error:', e); }

  // 6. Bloodwork — fetch from blood_work_samples table
  try {
    var bwData = await supabaseRequest(
      '/rest/v1/blood_work_samples?user_id=eq.' + currentUser.id + '&order=test_date.desc,created_at.desc&limit=100',
      'GET', null, token
    );
    console.log('[Healix] blood_work_samples:', bwData ? (bwData.error ? 'ERROR:'+JSON.stringify(bwData.error) : bwData.length + ' rows') : 'null');
    if (bwData && !bwData.error && bwData.length > 0) {
      var BIOMARKER_MAP = {
        'Glucose': 'glucose', 'Fasting Glucose': 'glucose', 'Glucose, Fasting': 'glucose',
        'Glucose, Serum': 'glucose', 'Blood Glucose': 'glucose', 'Glucose Fasting': 'glucose',
        'Glucose,Serum': 'glucose', 'GLUCOSE': 'glucose', 'Glucose (Fasting)': 'glucose',
        'Hemoglobin A1c': 'hba1c', 'HbA1c': 'hba1c', 'A1C': 'hba1c', 'Hemoglobin A1C': 'hba1c',
        'A1c': 'hba1c', 'HgbA1c': 'hba1c', 'Hgb A1c': 'hba1c', 'HBA1C': 'hba1c',
        'Glycated Hemoglobin': 'hba1c', 'Hemoglobin A1c (HbA1c)': 'hba1c',
        'LDL Chol Calc (NIH)': 'ldl', 'LDL Cholesterol': 'ldl', 'LDL-C': 'ldl',
        'LDL Cholesterol Calc': 'ldl', 'LDL-Cholesterol': 'ldl', 'LDL': 'ldl',
        'Low Density Lipoprotein': 'ldl', 'LDL CHOL': 'ldl', 'LDL Chol Calc': 'ldl',
        'HDL Cholesterol': 'hdl', 'HDL-C': 'hdl', 'HDL': 'hdl', 'HDL-Cholesterol': 'hdl',
        'High Density Lipoprotein': 'hdl', 'HDL CHOL': 'hdl',
        'hs-CRP': 'crp', 'CRP': 'crp', 'C-Reactive Protein': 'crp',
        'hsCRP': 'crp', 'C-Reactive Protein, Cardiac': 'crp', 'HS-CRP': 'crp',
        'C Reactive Protein': 'crp', 'High Sensitivity CRP': 'crp',
        'Triglycerides': 'triglycerides', 'Triglyceride': 'triglycerides', 'TG': 'triglycerides',
        'TRIGLYCERIDES': 'triglycerides', 'Trigs': 'triglycerides',
        'Creatinine': 'creatinine', 'Creatinine, Serum': 'creatinine',
        'CREATININE': 'creatinine', 'Creatinine,Serum': 'creatinine'
      };
      // Use only the most recent test date
      var latestDate = bwData[0].test_date;
      var latestSamples = bwData.filter(function(s) { return s.test_date === latestDate; });
      var bw = {};
      var unmapped = [];
      latestSamples.forEach(function(sample) {
        var key = BIOMARKER_MAP[sample.biomarker_name];
        if (!key) {
          var lowerName = (sample.biomarker_name || '').toLowerCase().trim();
          var mapKeys = Object.keys(BIOMARKER_MAP);
          for (var i = 0; i < mapKeys.length; i++) {
            if (mapKeys[i].toLowerCase() === lowerName) { key = BIOMARKER_MAP[mapKeys[i]]; break; }
          }
          // Partial match fallback: check if biomarker name starts with a map key
          if (!key) {
            for (var j = 0; j < mapKeys.length; j++) {
              var mapKeyLower = mapKeys[j].toLowerCase();
              if (lowerName === mapKeyLower || lowerName.indexOf(mapKeyLower + ' ') === 0 || lowerName.indexOf(mapKeyLower + '/') === 0) { key = BIOMARKER_MAP[mapKeys[j]]; break; }
            }
          }
          if (!key) unmapped.push(sample.biomarker_name);
        }
        var val = sample.value !== null && sample.value !== undefined ? parseFloat(sample.value) : NaN;
        if (key && !isNaN(val) && val > 0) bw[key] = val;
      });
      if (unmapped.length > 0) console.log('[Healix] unmapped biomarkers:', unmapped.join(', '));
      metrics.bloodwork = Object.keys(bw).length > 0 ? bw : null;
      if (metrics.bloodwork) timestamps.bloodwork = bwData[0].test_date;
      // Store raw sample count so connectivity state can detect bloodwork even if mapping fails
      window._bloodworkRawCount = bwData.length;
      console.log('[Healix] bloodwork mapped:', JSON.stringify(bw));
    } else {
      window._bloodworkRawCount = 0;
    }
  } catch(e) { console.error('Bloodwork fetch error:', e); metrics.bloodwork = null; window._bloodworkRawCount = 0; }

  // 7. Check if HealthBite has ever synced (wearable connectivity signal)
  try {
    var syncLog = await supabaseRequest(
      '/rest/v1/health_sync_log?user_id=eq.' + currentUser.id
      + '&sync_status=eq.completed&order=sync_completed_at.desc&limit=1',
      'GET', null, token
    );
    window._healthSyncDetected = syncLog && !syncLog.error && syncLog.length > 0;
  } catch(e) { window._healthSyncDetected = false; }

  // Render everything
  console.log('[Healix] metrics:', JSON.stringify(metrics));
  window._lastDashboardMetrics = metrics;
  window._lastDashboardTimestamps = timestamps;
  var result = calcVitalityAge(metrics);
  window._lastVitalityResult = result;
  console.log('[Healix] vitalityResult:', result);
  renderVitalityAge(result, realAge);
  checkVitalityCelebration(result);
  var shareBtn = document.getElementById('va-share-btn');
  if (shareBtn) shareBtn.style.display = result && result.vAge ? 'flex' : 'none';
  saveVitalityHistory(result, realAge);
  renderVitalityTimeline();
  renderDriverCards(metrics, result);

  // Activity cards (informational, not part of Vitality Age)
  if (window._lastHealthByType) {
    renderActivityCards(window._lastHealthByType, today);
  }

  // AI insight sentence
  var sentence = buildInsightSentence(metrics, result);
  var bar = document.getElementById('va-insight-bar');
  var txt = document.getElementById('va-insight-text');
  if (sentence && bar && txt) {
    txt.textContent = sentence;
    bar.style.display = 'flex';
  }

  // Freshness indicators
  renderFreshnessIndicator('drv-heart-freshness', 'heart_rate', timestamps.heart_rate);
  renderFreshnessIndicator('drv-bp-freshness', 'weight', null);
  renderFreshnessIndicator('drv-strength-freshness', 'strength', timestamps.strength);
  renderFreshnessIndicator('drv-aerobic-freshness', 'vo2max', timestamps.vo2max);
  renderFreshnessIndicator('drv-bloodwork-freshness', 'bloodwork', timestamps.bloodwork);
  renderSyncBanner(timestamps);
  renderVitalityConfidence(timestamps);

  // Load weekly insights and health summary (non-blocking)
  loadWeeklyInsights();
  loadHealthSummary();

  // Cache dashboard data in localStorage for instant render on next visit
  // Skip caching when viewing a client's dashboard (don't corrupt the coach's own cache)
  if (!_viewingUserId) {
    safeLSSet('healix_dashboard_cache', JSON.stringify({
      metrics: metrics, timestamps: timestamps, result: result, realAge: realAge, cachedAt: Date.now()
    }));
  }
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
function setEl(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; }
function setHTML(id, val) { var e = document.getElementById(id); if (e) e.innerHTML = val; }
function setClass(id, cls) { var e = document.getElementById(id); if (e) e.className = cls; }

function renderHealthStats(byType, today) {
  // Sleep is now handled by the driver card in renderDriverCards — no separate stat display needed

  // Steps - unit: steps, sum all entries for today
  var stepsKeys = ['step_count'];
  var stepsData = [];
  stepsKeys.forEach(function(k) { if (byType[k]) stepsData = stepsData.concat(byType[k]); });
  if (stepsData.length > 0) {
    var todaySteps = dedupedDailyTotal(stepsData, today);
    if (todaySteps === 0) todaySteps = stepsData
      .filter(function(r) { return r.start_date; })
      .slice(0, 3)
      .reduce(function(s, r) { return s + parseFloat(r.value || 0); }, 0);
    setHTML('d-steps', todaySteps >= 1000
      ? (Math.round(todaySteps / 100) / 10) + '<span class="stat-item-unit">k</span>'
      : Math.round(todaySteps).toString());
    var stepsAvg = stepsData.reduce(function(s, r) { return s + parseFloat(r.value || 0); }, 0) / Math.max(stepsData.length, 1);
    var sd = Math.round(((todaySteps - stepsAvg) / Math.max(stepsAvg, 1)) * 100);
    setEl('d-steps-d', sd > 5 ? '↑ +' + sd + '% vs avg' : sd < -5 ? '↓ ' + sd + '% vs avg' : '— avg pace');
    setClass('d-steps-d', 'stat-item-delta ' + (sd > 5 ? 'delta-up' : sd < -5 ? 'delta-down' : 'delta-neutral'));
    updateMiniChart('d-chart', stepsData, today);
  }

  // HR
  var hrKeys = ['resting_heart_rate', 'walking_heart_rate_average', 'heart_rate'];
  var hrData = [];
  hrKeys.forEach(function(k) { if (byType[k]) hrData = hrData.concat(byType[k]); });
  if (hrData.length > 0) {
    var hr = Math.round(parseFloat(hrData[0].value));
    var hrAvg = Math.round(hrData.reduce(function(s, r) { return s + parseFloat(r.value || 0); }, 0) / Math.max(hrData.length, 1));
    setHTML('d-hr', hr + '<span class="stat-item-unit">bpm</span>');
    var hd = hr - hrAvg;
    setEl('d-hr-d', Math.abs(hd) <= 2 ? '— avg ' + hrAvg : hd > 0 ? '↑ +' + hd + ' vs avg' : '↓ ' + hd + ' vs avg');
    setClass('d-hr-d', 'stat-item-delta ' + (Math.abs(hd) <= 2 ? 'delta-neutral' : hd > 0 ? 'delta-down' : 'delta-up'));
  }

  // Active calories - unit: kcal, sum today entries
  var calKeys = ['active_energy_burned'];
  var calData = [];
  calKeys.forEach(function(k) { if (byType[k]) calData = calData.concat(byType[k]); });
  if (calData.length > 0) {
    var tc = dedupedDailyTotal(calData, today);
    if (tc === 0) tc = calData
      .filter(function(r) { return r.start_date; })
      .slice(0, 3)
      .reduce(function(s, r) { return s + parseFloat(r.value || 0); }, 0);
    tc = Math.round(tc);
    setHTML('d-cal', tc + '<span class="stat-item-unit">kcal</span>');
    var ca = Math.round(calData.reduce(function(s, r) { return s + parseFloat(r.value || 0); }, 0) / Math.max(calData.length, 1));
    var cd = Math.round(((tc - ca) / Math.max(ca, 1)) * 100);
    setEl('d-cal-d', Math.abs(cd) < 5 ? '— avg ' + ca : cd > 0 ? '↑ +' + cd + '% vs avg' : '↓ ' + cd + '% vs avg');
    setClass('d-cal-d', 'stat-item-delta ' + (Math.abs(cd) < 5 ? 'delta-neutral' : cd > 0 ? 'delta-up' : 'delta-down'));
  }
}

// ── Activity Cards ─────────────────────────────────────────────────────
function scoreSteps(todaySteps) {
  if (!todaySteps || todaySteps <= 0) return 0;
  if (todaySteps >= 10000) return 90;
  if (todaySteps >= 7500) return 70;
  if (todaySteps >= 5000) return 50;
  if (todaySteps >= 2500) return 30;
  return 15;
}
function scoreExercise(todayMin) {
  if (!todayMin || todayMin <= 0) return 0;
  if (todayMin >= 30) return 90;
  if (todayMin >= 20) return 70;
  if (todayMin >= 10) return 50;
  return 25;
}
function scoreEnergy(todayKcal) {
  if (!todayKcal || todayKcal <= 0) return 0;
  if (todayKcal >= 500) return 85;
  if (todayKcal >= 300) return 70;
  if (todayKcal >= 150) return 50;
  return 25;
}
function scoreRespiratory(rate) {
  if (!rate || rate <= 0) return 0;
  if (rate >= 12 && rate <= 20) return 85;
  if (rate >= 10 && rate <= 24) return 55;
  return 25;
}
function scoreDistance(todayMiles) {
  if (!todayMiles || todayMiles <= 0) return 0;
  if (todayMiles >= 4) return 90;
  if (todayMiles >= 3) return 70;
  if (todayMiles >= 1.5) return 50;
  return 25;
}

function renderActivityCards(byType, today) {
  var section = document.getElementById('activity-cards-section');
  if (!section) return;

  var anyData = false;

  // Weight (informational — no longer in VA score, still useful to track)
  var weightKg = window.userProfileData && window.userProfileData.current_weight_kg;
  var heightCm = window.userProfileData && window.userProfileData.height_cm;
  if (weightKg) {
    anyData = true;
    var wtLbs = Math.round(weightKg * 2.205);
    var wtScore = scoreWeight(weightKg, heightCm) || 0;
    document.getElementById('drv-weight-val').textContent = wtLbs + ' lbs';
    var bmi = heightCm ? Math.round(weightKg / Math.pow(heightCm / 100, 2) * 10) / 10 : null;
    document.getElementById('drv-weight-status').textContent = bmi ? 'BMI ' + bmi : '';
    document.getElementById('drv-weight-status').className = 'driver-status ' + (wtScore >= 70 ? 'good' : wtScore >= 40 ? 'fair' : wtScore > 0 ? 'low' : '');
    var wb = document.getElementById('drv-weight-bar');
    if (wb) { wb.style.width = wtScore + '%'; wb.className = 'driver-bar-fill ' + (wtScore >= 70 ? 'good' : wtScore >= 40 ? 'fair' : wtScore > 0 ? 'low' : ''); }
  } else {
    document.getElementById('drv-weight').style.display = 'none';
  }

  function getDailyTotal(rows, dateStr) {
    return dedupedDailyTotal(rows, dateStr);
  }

  function getWeeklyAvg(rows) {
    var now = new Date();
    // Source-deduped per-day totals: max(value) per (day, source), then max
    // across sources per day. Matches dedupedDailyTotal's logic.
    var perDayPerSource = {};
    (rows || []).forEach(function(r) {
      var day = localDateStrOf(r);
      if (!day) return;
      var val = parseFloat(r.value || 0);
      if (!isFinite(val)) return;
      var src = r.source_id || r.source_name || 'unknown';
      if (!perDayPerSource[day]) perDayPerSource[day] = {};
      if (perDayPerSource[day][src] == null || val > perDayPerSource[day][src]) {
        perDayPerSource[day][src] = val;
      }
    });
    var dayTotals = {};
    Object.keys(perDayPerSource).forEach(function(day) {
      var maxVal = 0;
      var sources = perDayPerSource[day];
      for (var s in sources) { if (sources[s] > maxVal) maxVal = sources[s]; }
      dayTotals[day] = maxVal;
    });
    var sum = 0, count = 0;
    for (var d = 0; d < 7; d++) {
      var dt = new Date(now); dt.setDate(dt.getDate() - d);
      var ds = localDateStr(dt);
      if (dayTotals[ds] !== undefined) { sum += dayTotals[ds]; count++; }
    }
    return count > 0 ? Math.round(sum / count) : 0;
  }

  function getLatestValue(rows) {
    for (var i = 0; i < (rows || []).length; i++) {
      var v = parseFloat(rows[i].value || 0);
      if (isFinite(v) && v > 0) return Math.round(v * 10) / 10;
    }
    return 0;
  }

  // Steps
  var stepsRows = byType['step_count'] || [];
  var stepsToday = Math.round(getDailyTotal(stepsRows, today));
  if (stepsToday > 0 || stepsRows.length > 0) {
    anyData = true;
    var stepsAvg = getWeeklyAvg(stepsRows);
    var stepsScore = scoreSteps(stepsToday);
    document.getElementById('drv-steps-val').textContent = (stepsToday > 0 ? stepsToday.toLocaleString() : stepsAvg.toLocaleString());
    document.getElementById('drv-steps-status').textContent = stepsToday > 0 ? '7-day avg: ' + stepsAvg.toLocaleString() : 'Weekly avg (no data today)';
    document.getElementById('drv-steps-status').className = 'driver-status';
    var sb = document.getElementById('drv-steps-bar');
    if (sb) { sb.style.width = stepsScore + '%'; sb.className = 'driver-bar-fill ' + (stepsScore >= 70 ? 'good' : stepsScore >= 40 ? 'fair' : stepsScore > 0 ? 'low' : ''); }
  } else {
    document.getElementById('drv-steps').style.display = 'none';
  }

  // Exercise time
  var exRows = byType['apple_exercise_time'] || [];
  var exToday = Math.round(getDailyTotal(exRows, today));
  if (exToday > 0 || exRows.length > 0) {
    anyData = true;
    var exAvg = getWeeklyAvg(exRows);
    var exScore = scoreExercise(exToday || exAvg);
    document.getElementById('drv-exercise-val').textContent = (exToday > 0 ? exToday : exAvg) + ' min';
    document.getElementById('drv-exercise-status').textContent = exToday > 0 ? '7-day avg: ' + exAvg + ' min/day' : 'Weekly avg (no data today)';
    document.getElementById('drv-exercise-status').className = 'driver-status';
    var eb = document.getElementById('drv-exercise-bar');
    if (eb) { eb.style.width = exScore + '%'; eb.className = 'driver-bar-fill ' + (exScore >= 70 ? 'good' : exScore >= 40 ? 'fair' : exScore > 0 ? 'low' : ''); }
  } else {
    document.getElementById('drv-exercise').style.display = 'none';
  }

  // Active energy
  var enRows = byType['active_energy_burned'] || [];
  var enToday = Math.round(getDailyTotal(enRows, today));
  if (enToday > 0 || enRows.length > 0) {
    anyData = true;
    var enAvg = getWeeklyAvg(enRows);
    var enScore = scoreEnergy(enToday || enAvg);
    document.getElementById('drv-energy-val').textContent = (enToday > 0 ? enToday.toLocaleString() : enAvg.toLocaleString()) + ' kcal';
    document.getElementById('drv-energy-status').textContent = enToday > 0 ? '7-day avg: ' + enAvg.toLocaleString() + ' kcal/day' : 'Weekly avg (no data today)';
    document.getElementById('drv-energy-status').className = 'driver-status';
    var nb = document.getElementById('drv-energy-bar');
    if (nb) { nb.style.width = enScore + '%'; nb.className = 'driver-bar-fill ' + (enScore >= 70 ? 'good' : enScore >= 40 ? 'fair' : enScore > 0 ? 'low' : ''); }
  } else {
    document.getElementById('drv-energy').style.display = 'none';
  }

  // Respiratory rate
  var respRows = byType['respiratory_rate'] || [];
  var respLatest = getLatestValue(respRows);
  if (respLatest > 0) {
    anyData = true;
    var respScore = scoreRespiratory(respLatest);
    document.getElementById('drv-respiratory-val').textContent = respLatest + ' breaths/min';
    var respStatus = (respLatest >= 12 && respLatest <= 20) ? 'Normal range' : 'Outside normal range';
    document.getElementById('drv-respiratory-status').textContent = respStatus;
    document.getElementById('drv-respiratory-status').className = 'driver-status ' + (respScore >= 70 ? 'good' : respScore >= 40 ? 'fair' : 'low');
    var rb = document.getElementById('drv-respiratory-bar');
    if (rb) { rb.style.width = respScore + '%'; rb.className = 'driver-bar-fill ' + (respScore >= 70 ? 'good' : respScore >= 40 ? 'fair' : 'low'); }
  } else {
    document.getElementById('drv-respiratory').style.display = 'none';
  }

  // Walking distance is intentionally NOT shown on the dashboard — matches
  // the mobile app, which only surfaces Sleep/Activity/Nutrition tiles plus
  // an HR/HRV inline row. Distance is still source-deduped via getDailyTotal
  // and remains available for chat tools and insight rules.

  // When no activity data is present, replace the grid with actionable
  // guidance instead of hiding the section silently. Matches mobile 4ef79a5.
  var grid = document.getElementById('activity-cards-grid');
  if (!anyData && grid) {
    section.style.display = '';
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:40px">'
      + '<div class="empty-state-icon">⌚️</div>'
      + '<div class="empty-state-text">No activity data yet</div>'
      + '<div style="font-size:12px;color:var(--cream-dim);margin-top:8px;line-height:1.6;max-width:380px;margin-left:auto;margin-right:auto">Sync your Apple Watch through the Healix mobile app and steps, distance, calories, and exercise minutes show up here automatically.</div>'
      + '<button class="upload-btn" onclick="openConnectHealthBiteModal()" style="margin:16px auto 0;display:flex">Connect Healix App →</button>'
      + '</div>';
  } else {
    section.style.display = anyData ? '' : 'none';
  }
}

function updateMiniChart(id, data, today) {
  // Source-deduped per-day totals so iPhone+Watch overlap doesn't inflate bars.
  var perDayPerSource = {};
  data.forEach(function(r) {
    var day = localDateStrOf(r);
    if (!day) return;
    var v = parseFloat(r.value || 0);
    if (!isFinite(v)) return;
    var src = r.source_id || r.source_name || 'unknown';
    if (!perDayPerSource[day]) perDayPerSource[day] = {};
    if (perDayPerSource[day][src] == null || v > perDayPerSource[day][src]) {
      perDayPerSource[day][src] = v;
    }
  });
  var dayMap = {};
  Object.keys(perDayPerSource).forEach(function(day) {
    var maxV = 0;
    var srcs = perDayPerSource[day];
    for (var s in srcs) { if (srcs[s] > maxV) maxV = srcs[s]; }
    dayMap[day] = maxV;
  });
  var days = Object.keys(dayMap).sort().slice(-7);
  var vals = days.map(function(d) { return dayMap[d]; });
  var maxV = vals.length > 0 ? (Math.max.apply(null, vals) || 1) : 1;
  var bars = document.querySelectorAll('#' + id + ' .mini-bar');
  bars.forEach(function(bar, i) {
    bar.style.height = Math.max(8, Math.round((vals[i] || 0) / maxV * 100)) + '%';
    bar.classList.toggle('today', days[i] === today);
  });
}

function renderDashMeals(meals, today) {
  var el = document.getElementById('d-meals');
  if (!el) return;
  var todayMeals = meals;
  var el = document.getElementById('d-meals');
  var emojis = { breakfast:'🍳', lunch:'🥗', dinner:'🍽', snack:'🍎', cooked:'🍳', drink:'🥤', dessert:'🍰', 'ate out':'🍽', beverage:'🥤', supplement:'💊', medication:'💊', alcohol:'🍷', other:'📦' };
  if (todayMeals.length === 0) {
    el.innerHTML = '<div class="empty-state">'
      + '<div class="empty-state-icon">🍽</div>'
      + '<div class="empty-state-text">No intake logged today</div>'
      + '<div style="font-size:12px;color:var(--cream-dim);margin-top:6px">Logging meals powers your protein, fiber, and micronutrient insights.</div>'
      + '<button class="upload-btn" onclick="showPage(\'meals\', null);setTimeout(function(){setMealDateTimeDefault();openModal(\'meal-modal\')},50)" style="margin:14px auto 0;display:flex">+ Log Intake</button>'
      + '</div>';
    return;
  }
  el.innerHTML = todayMeals.slice(0, 4).map(function(m) {
    var t = new Date(m.meal_time || m.created_at);
    var mealType = (m.meal_type || '').toLowerCase();
    return '<div class="meal-row">'
      + '<div class="meal-emoji">' + (emojis[mealType] || '🥘') + '</div>'
      + '<div class="meal-info"><div class="meal-name">' + escapeHtml(m.meal_description || 'Intake') + '</div>'
      + '<div class="meal-meta">' + (m.meal_type || '') + ' · ' + t.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) + '</div></div>'
      + '<div class="meal-cals">—</div>'
      + '</div>';
  }).join('');
}

function renderMacrosFromMealData(meals) {
  var cal = 0, prot = 0, carbs = 0, fat = 0;
  meals.forEach(function(m) {
    var macros = getMacrosFromMeal(m);
    cal   += macros.cal  || 0;
    prot  += macros.prot || 0;
    carbs += macros.carb || 0;
    fat   += macros.fat  || 0;
  });
  renderDayMacroUI(Math.round(cal), Math.round(prot), Math.round(carbs), Math.round(fat));
}

function renderMacrosFromNutrients(nutrients) {
  var macroByMeal = {};
  nutrients.forEach(function(n) {
    if (!macroByMeal[n.meal_log_id]) macroByMeal[n.meal_log_id] = {};
    var key = n.name, val = parseFloat(n.value || 0);
    if (n.category === 'Macronutrients' || !macroByMeal[n.meal_log_id][key]) {
      macroByMeal[n.meal_log_id][key] = val;
    }
  });
  var totals = {};
  Object.values(macroByMeal).forEach(function(m) {
    Object.keys(m).forEach(function(k) { totals[k] = (totals[k] || 0) + m[k]; });
  });
  renderDayMacroUI(
    Math.round(totals['Calories'] || totals['Energy'] || 0),
    Math.round(totals['Protein'] || totals['Proteins'] || 0),
    Math.round(totals['Carbohydrates'] || totals['Total Carbohydrates'] || 0),
    Math.round(totals['Total Fat'] || totals['Fat'] || totals['Fats'] || 0)
  );
}

function getMacroTargets() {
  var p = window.userProfileData || {};
  var weightKg = p.current_weight_kg;
  var heightCm = p.height_cm;
  var sex = (p.gender || p.sex || '').toLowerCase();
  var goal = (p.primary_goal || '').toLowerCase();
  var dobStr = p.birth_date || p.dob;
  var age = 30;
  if (dobStr) { var d = new Date(dobStr); if (!isNaN(d)) age = Math.floor((Date.now() - d) / (365.25 * 24 * 3600 * 1000)); }

  // Try weight from weight logs if not in profile
  if (!weightKg && window.weightEntries && weightEntries.length > 0) {
    var latestWeight = parseFloat(weightEntries[0].value);
    var unit = (weightEntries[0].unit || 'lbs').toLowerCase();
    weightKg = unit === 'kg' ? latestWeight : latestWeight / 2.205;
  }

  // Sex-based defaults if still missing
  if (!weightKg) weightKg = sex.includes('f') ? 63.5 : 81.6; // US avg
  if (!heightCm) heightCm = sex.includes('f') ? 162 : 177; // US avg

  // Mifflin-St Jeor BMR
  var bmr = sex.includes('f')
    ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
    : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;

  // Default moderate activity (1.55) — no activity_level field yet
  var tdee = Math.round(bmr * 1.55);

  // Adjust for goal
  var calTarget = tdee;
  if (goal === 'lose_weight') calTarget = Math.round(tdee * 0.8);
  else if (goal === 'gain_strength') calTarget = Math.round(tdee + 300);

  // Custom targets (mobile commit 8d8e870): if the user has set target_*_pct
  // and/or target_calories on their profile, those override the goal-based
  // calculation. Targets are stored as percentages and converted to grams
  // here using the (optionally overridden) calorie target.
  var hasCustomMacros = p.target_protein_pct != null
    && p.target_carbs_pct != null
    && p.target_fat_pct != null;
  if (hasCustomMacros || p.target_calories != null) {
    if (p.target_calories != null) calTarget = Math.round(parseFloat(p.target_calories));
    if (hasCustomMacros) {
      var pPct = parseFloat(p.target_protein_pct) / 100;
      var cPct = parseFloat(p.target_carbs_pct) / 100;
      var fPct = parseFloat(p.target_fat_pct) / 100;
      return {
        cal: calTarget,
        prot: Math.round(calTarget * pPct / 4),
        carbs: Math.round(calTarget * cPct / 4),
        fat: Math.round(calTarget * fPct / 9),
        isCustom: true
      };
    }
    // Calorie override only; macros still goal-based, recomputed against the
    // overridden calorie total below.
  }

  // Protein: 1g/lb for weight loss and strength, 0.8g/lb otherwise
  var weightLbs = weightKg * 2.205;
  var protTarget = (goal === 'lose_weight' || goal === 'gain_strength')
    ? Math.round(weightLbs * 1.0)
    : Math.round(weightLbs * 0.8);

  // Fat: 28% of calories
  var fatTarget = Math.round(calTarget * 0.28 / 9);

  // Carbs: remainder
  var carbTarget = Math.round((calTarget - protTarget * 4 - fatTarget * 9) / 4);
  if (carbTarget < 50) carbTarget = 50;

  return { cal: calTarget, prot: protTarget, fat: fatTarget, carbs: carbTarget, isCustom: false };
}

// ── Macro target editing ──
function openMacroTargetModal() {
  var p = window.userProfileData || {};
  var pEl = document.getElementById('mt-prot');
  var cEl = document.getElementById('mt-carbs');
  var fEl = document.getElementById('mt-fat');
  var calEl = document.getElementById('mt-cal');
  var warn = document.getElementById('mt-pct-warn');
  if (warn) warn.style.display = 'none';
  if (pEl) pEl.value = p.target_protein_pct != null ? p.target_protein_pct : '';
  if (cEl) cEl.value = p.target_carbs_pct != null ? p.target_carbs_pct : '';
  if (fEl) fEl.value = p.target_fat_pct != null ? p.target_fat_pct : '';
  if (calEl) calEl.value = p.target_calories != null ? p.target_calories : '';
  openModal('macro-target-modal');
}

async function saveMacroTargets() {
  var session = getSession(); if (!session || !currentUser) return;
  var pEl = document.getElementById('mt-prot');
  var cEl = document.getElementById('mt-carbs');
  var fEl = document.getElementById('mt-fat');
  var calEl = document.getElementById('mt-cal');
  var warn = document.getElementById('mt-pct-warn');

  var pVal = pEl && pEl.value !== '' ? parseInt(pEl.value, 10) : null;
  var cVal = cEl && cEl.value !== '' ? parseInt(cEl.value, 10) : null;
  var fVal = fEl && fEl.value !== '' ? parseInt(fEl.value, 10) : null;
  var calVal = calEl && calEl.value !== '' ? parseInt(calEl.value, 10) : null;

  // If any macro pct is set, all three must be set and sum to 100 (±1 for rounding).
  var anyMacro = pVal != null || cVal != null || fVal != null;
  if (anyMacro) {
    if (pVal == null || cVal == null || fVal == null) {
      if (warn) { warn.textContent = 'Set all three percentages, or leave all three blank.'; warn.style.display = 'block'; }
      return;
    }
    var sum = pVal + cVal + fVal;
    if (Math.abs(sum - 100) > 1) {
      if (warn) { warn.textContent = 'Percentages must add up to 100% (you have ' + sum + '%).'; warn.style.display = 'block'; }
      return;
    }
  }

  var patch = {
    target_protein_pct: pVal,
    target_carbs_pct: cVal,
    target_fat_pct: fVal,
    target_calories: calVal
  };

  try {
    var resp = await supabaseRequest(
      '/rest/v1/profiles?auth_user_id=eq.' + currentUser.id,
      'PATCH', patch, session.access_token
    );
    if (resp && resp.error) {
      if (warn) { warn.textContent = 'Save failed: ' + resp.error.message; warn.style.display = 'block'; }
      return;
    }
    // Update local profile cache so renderMacroSplit picks up the change immediately.
    if (window.userProfileData) {
      window.userProfileData.target_protein_pct = pVal;
      window.userProfileData.target_carbs_pct = cVal;
      window.userProfileData.target_fat_pct = fVal;
      window.userProfileData.target_calories = calVal;
    }
    closeModal('macro-target-modal');
    // Re-render meals page so the new targets show up.
    if (typeof loadMealsPage === 'function') loadMealsPage();
  } catch (e) {
    if (warn) { warn.textContent = 'Save failed: ' + (e && e.message || 'unknown error'); warn.style.display = 'block'; }
  }
}

function resetMacroTargets() {
  var pEl = document.getElementById('mt-prot');
  var cEl = document.getElementById('mt-carbs');
  var fEl = document.getElementById('mt-fat');
  var calEl = document.getElementById('mt-cal');
  if (pEl) pEl.value = '';
  if (cEl) cEl.value = '';
  if (fEl) fEl.value = '';
  if (calEl) calEl.value = '';
  // Hitting Save with all blanks clears the custom targets.
  saveMacroTargets();
}

// Render the P/C/F macro split (stacked bar + per-macro rows with grams,
// percentage, and target deviation). Used on the meals page aggregate view.
// Mirrors mobile commit ad5be2e.
function renderMacroSplit(prot, carbs, fat, targets) {
  var card = document.getElementById('agg-macro-split-card');
  var bar = document.getElementById('agg-macro-bar');
  var rows = document.getElementById('agg-macro-rows');
  var note = document.getElementById('agg-macro-target-note');
  if (!card || !bar || !rows) return;

  var pCal = (prot || 0) * 4;
  var cCal = (carbs || 0) * 4;
  var fCal = (fat || 0) * 9;
  var totalCal = pCal + cCal + fCal;
  if (totalCal <= 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  var pPct = Math.round(pCal / totalCal * 100);
  var cPct = Math.round(cCal / totalCal * 100);
  var fPct = 100 - pPct - cPct;

  // Stacked bar — colors mirror the mobile palette
  bar.innerHTML = ''
    + '<div style="width:' + pPct + '%;background:#6fcf8a"></div>'
    + '<div style="width:' + cPct + '%;background:#B8975A"></div>'
    + '<div style="width:' + fPct + '%;background:#e0a070"></div>';

  // Compute target percentages for the comparison rows
  var tCal = (targets.prot || 0) * 4 + (targets.carbs || 0) * 4 + (targets.fat || 0) * 9;
  var tProtPct = tCal > 0 ? Math.round((targets.prot || 0) * 4 / tCal * 100) : 0;
  var tCarbPct = tCal > 0 ? Math.round((targets.carbs || 0) * 4 / tCal * 100) : 0;
  var tFatPct = 100 - tProtPct - tCarbPct;

  // Amber when actual is more than 10 percentage points off the target
  var deviationColor = function(actual, target) {
    return Math.abs(actual - target) > 10 ? 'var(--warn)' : 'var(--cream-dim)';
  };

  var rowHtml = function(label, color, actualPct, actualG, targetPct) {
    return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--gold-border);font-size:13px">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0"></span>'
      + '<span style="flex:1;color:var(--cream)">' + label + '</span>'
      + '<span style="color:var(--cream);font-family:var(--F);min-width:60px;text-align:right">' + actualG + 'g</span>'
      + '<span style="color:' + deviationColor(actualPct, targetPct) + ';min-width:80px;text-align:right">' + actualPct + '% <span style="color:var(--muted);font-size:11px">/ ' + targetPct + '% target</span></span>'
      + '</div>';
  };

  rows.innerHTML = ''
    + rowHtml('Protein', '#6fcf8a', pPct, prot || 0, tProtPct)
    + rowHtml('Carbs', '#B8975A', cPct, carbs || 0, tCarbPct)
    + rowHtml('Fat', '#e0a070', fPct, fat || 0, tFatPct);

  note.textContent = targets.isCustom ? '· using your custom targets' : '';
}

function animateMacroRings(prot, carbs, fat, targets) {
  var rings = [
    { id: 'ring-prot', value: prot || 0, target: targets.prot, circ: 314.2 },
    { id: 'ring-carbs', value: carbs || 0, target: targets.carbs, circ: 314.2 },
    { id: 'ring-fat', value: fat || 0, target: targets.fat, circ: 314.2 }
  ];
  setTimeout(function() {
    rings.forEach(function(r) {
      var el = document.getElementById(r.id);
      if (!el) return;
      var pct = Math.min(r.value / r.target, 1.15); // Allow slight overflow visual
      var offset = r.circ * (1 - pct);
      el.style.strokeDashoffset = Math.max(0, offset);
    });
  }, 100);
}

function renderDayMacroUI(cal, prot, carbs, fat) {
  var targets = getMacroTargets();
  var setEl = function(id,v) { var e=document.getElementById(id); if(e) e.textContent=v; };
  var setHTML = function(id,v) { var e=document.getElementById(id); if(e) e.innerHTML=v; };

  // Center calorie display
  setEl('mp-cal', cal || '—');

  // Legend values
  setHTML('mp-protein', (prot||'—') + '<span>g</span>');
  setEl('mp-prot-sub', 'of ' + targets.prot + 'g goal');
  setHTML('mp-carbs', (carbs||'—') + '<span>g</span>');
  setEl('mp-carb-sub', 'of ' + targets.carbs + 'g goal');
  setHTML('mp-fat', (fat||'—') + '<span>g</span>');
  setEl('mp-fat-sub', 'of ' + targets.fat + 'g goal');

  // Animate rings
  animateMacroRings(prot, carbs, fat, targets);
}


// Canonical nutrient definitions — field names match actual API output from meal_log.data.total_nutrition
// Categories in API: Macronutrients, Fats, Minerals, Vitamins, AminoAcids, SugarsAndFibers, OtherCompounds
var MICRO_DEFS = {
  vitamins: [
    // Vitamin A comes as IU from API; convert to mcg RAE (1 mcg RAE = 3.33 IU retinol)
    { key: 'Vitamin A',   aliases: ['Vitamin A'],           rda: 900,  unit: 'mcg', display: 'Vitamin A',  iuToMcg: 3.33 },
    { key: 'Vitamin C',   aliases: ['Vitamin C'],           rda: 90,   unit: 'mg',  display: 'Vitamin C'      },
    { key: 'Vitamin D',   aliases: ['Vitamin D'],           rda: 20,   unit: 'mcg', display: 'Vitamin D'      },
    { key: 'Vitamin E',   aliases: ['Vitamin E'],           rda: 15,   unit: 'mg',  display: 'Vitamin E'      },
    { key: 'Vitamin K',   aliases: ['Vitamin K'],           rda: 120,  unit: 'mcg', display: 'Vitamin K'      },
    { key: 'Thiamin',     aliases: ['Thiamin','Thiamine'],  rda: 1.2,  unit: 'mg',  display: 'B1 Thiamin'     },
    { key: 'Riboflavin',  aliases: ['Riboflavin'],          rda: 1.3,  unit: 'mg',  display: 'B2 Riboflavin'  },
    { key: 'Niacin',      aliases: ['Niacin'],              rda: 16,   unit: 'mg',  display: 'B3 Niacin'      },
    { key: 'Vitamin B6',  aliases: ['Vitamin B6'],          rda: 1.7,  unit: 'mg',  display: 'B6'             },
    { key: 'Folate',      aliases: ['Folate','Folic Acid'], rda: 400,  unit: 'mcg', display: 'B9 Folate'      },
    { key: 'Vitamin B12', aliases: ['Vitamin B12'],         rda: 2.4,  unit: 'mcg', display: 'B12'            },
    { key: 'Biotin',      aliases: ['Biotin'],              rda: 30,   unit: 'mcg', display: 'Biotin'         },
    { key: 'Choline',     aliases: ['Choline'],             rda: 550,  unit: 'mg',  display: 'Choline'        },
  ],
  minerals: [
    { key: 'Calcium',     aliases: ['Calcium'],             rda: 1000, unit: 'mg',  display: 'Calcium'        },
    { key: 'Iron',        aliases: ['Iron'],                rda: 18,   unit: 'mg',  display: 'Iron'           },
    { key: 'Magnesium',   aliases: ['Magnesium'],           rda: 400,  unit: 'mg',  display: 'Magnesium'      },
    { key: 'Phosphorus',  aliases: ['Phosphorus'],          rda: 700,  unit: 'mg',  display: 'Phosphorus'     },
    { key: 'Potassium',   aliases: ['Potassium'],           rda: 4700, unit: 'mg',  display: 'Potassium'      },
    { key: 'Sodium',      aliases: ['Sodium'],              rda: 2300, unit: 'mg',  display: 'Sodium'         },
    { key: 'Zinc',        aliases: ['Zinc'],                rda: 11,   unit: 'mg',  display: 'Zinc'           },
    { key: 'Selenium',    aliases: ['Selenium'],            rda: 55,   unit: 'mcg', display: 'Selenium'       },
    { key: 'Copper',      aliases: ['Copper'],              rda: 0.9,  unit: 'mg',  display: 'Copper'         },
    { key: 'Manganese',   aliases: ['Manganese'],           rda: 2.3,  unit: 'mg',  display: 'Manganese'      },
    { key: 'Iodine',      aliases: ['Iodine'],              rda: 150,  unit: 'mcg', display: 'Iodine'         },
  ],
  other: [
    // SugarsAndFibers category
    { key: 'Fiber',          aliases: ['Fiber','Dietary Fiber','Total Fiber'],    rda: 28,  unit: 'g',  display: 'Fiber'          },
    // Fats category
    { key: 'Saturated Fat',  aliases: ['Saturated Fat','Saturated Fats'],         rda: 20,  unit: 'g',  display: 'Saturated Fat'  },
    // AminoAcids category
    { key: 'Leucine',        aliases: ['Leucine'],                                rda: 2.7, unit: 'g',  display: 'Leucine'        },
    { key: 'Lysine',         aliases: ['Lysine'],                                 rda: 2.1, unit: 'g',  display: 'Lysine'         },
    // OtherCompounds category
    { key: 'Cholesterol',    aliases: ['Cholesterol'],                            rda: 300, unit: 'mg', display: 'Cholesterol'    },
    { key: 'Omega-3',        aliases: ['Omega-3','Omega 3','ALA'],                rda: 1.6, unit: 'g',  display: 'Omega-3'        },
    { key: 'Caffeine',       aliases: ['Caffeine'],                               rda: 400, unit: 'mg', display: 'Caffeine'       },
    { key: 'Alcohol',        aliases: ['Alcohol','Ethanol'],                      rda: 14,  unit: 'g',  display: 'Alcohol'        },
  ]
};

// Build alias -> def map for fast lookup
var MICRO_ALIAS_MAP = (function() {
  var map = {};
  Object.values(MICRO_DEFS).forEach(function(group) {
    group.forEach(function(def) {
      def.aliases.forEach(function(a) { map[a] = def; });
    });
  });
  return map;
})();

function getMicroTotalsFromMeals(meals) {
  var totals = {};
  meals.forEach(function(m) {
    var data = null;
    try { data = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) {}
    if (!data || !data.total_nutrition) return;
    var seenThisMeal = {};
    Object.values(data.total_nutrition).forEach(function(cat) {
      if (!Array.isArray(cat)) return;
      cat.forEach(function(item) {
        var def = MICRO_ALIAS_MAP[item.name];
        if (!def) return;
        var val = parseFloat(item.value || 0);
        if (!val) return;
        // Convert Vitamin A from IU to mcg RAE if needed
        if (def.iuToMcg && item.unit && item.unit.toLowerCase().indexOf('iu') !== -1) {
          val = val / def.iuToMcg;
        }
        if (!seenThisMeal[def.key] || val > seenThisMeal[def.key]) {
          seenThisMeal[def.key] = val;
        }
      });
    });
    Object.keys(seenThisMeal).forEach(function(key) {
      totals[key] = (totals[key] || 0) + seenThisMeal[key];
    });
  });
  return totals;
}

var KEY_MICROS = ['Vitamin D', 'Vitamin B12', 'Iron', 'Magnesium', 'Calcium', 'Omega-3'];

function renderMicroPanel(totals, containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;

  function microItem(def) {
    var val = totals[def.key] || 0;
    var pct = Math.min(120, Math.round((val / def.rda) * 100)); // cap bar at 120% but show real %
    var barPct = Math.min(100, pct);
    var cls = pct === 0 ? 'low' : pct < 33 ? 'low' : pct >= 80 ? 'good' : '';
    var pctCls = pct === 0 ? 'low' : pct < 33 ? 'low' : pct >= 80 ? 'good' : 'mid';
    var valStr = val > 0
      ? (val >= 100 ? Math.round(val) : val >= 10 ? Math.round(val*10)/10 : Math.round(val*100)/100) + def.unit
      : '—';
    return '<div class="micro-item">'
      + '<div class="micro-label">'
      + '<span class="micro-name">' + def.display + '</span>'
      + '<span class="micro-pct ' + pctCls + '">' + (val > 0 ? pct + '%' : '—') + '</span>'
      + '</div>'
      + '<div class="micro-track"><div class="micro-fill ' + cls + '" style="width:' + barPct + '%"></div></div>'
      + '<div class="micro-val">' + valStr + ' / ' + def.rda + def.unit + ' RDA</div>'
      + '</div>';
  }

  // Collect key and remaining nutrients
  var allDefs = MICRO_DEFS.vitamins.concat(MICRO_DEFS.minerals).concat(MICRO_DEFS.other);
  var keyDefs = [];
  var restDefs = [];
  allDefs.forEach(function(d) {
    if (KEY_MICROS.indexOf(d.key) !== -1) keyDefs.push(d);
    else restDefs.push(d);
  });
  // Sort key defs by KEY_MICROS order
  keyDefs.sort(function(a, b) { return KEY_MICROS.indexOf(a.key) - KEY_MICROS.indexOf(b.key); });

  var panelId = containerId + '-expand';
  var html = '<div class="micro-section-title">Key Nutrients</div>'
    + '<div class="micro-grid">' + keyDefs.map(microItem).join('') + '</div>'
    + '<button class="micro-expand-btn" onclick="var el=document.getElementById(\'' + panelId + '\');var show=el.style.display===\'none\';el.style.display=show?\'block\':\'none\';this.textContent=show?\'Hide details ▲\':\'Show all nutrients ▼\'"'
    + ' style="display:block;width:100%;background:none;border:1px solid var(--gold-border);color:var(--muted);font-size:11px;letter-spacing:.1em;padding:10px;cursor:pointer;margin:16px 0 0;font-family:var(--B);transition:color .2s"'
    + ' onmouseover="this.style.color=\'var(--gold)\'" onmouseout="this.style.color=\'var(--muted)\'">'
    + 'Show all nutrients ▼</button>'
    + '<div id="' + panelId + '" style="display:none;margin-top:16px">'
    + '<div class="micro-section-title">All Nutrients</div>'
    + '<div class="micro-grid">' + restDefs.map(microItem).join('') + '</div>'
    + '</div>';

  container.innerHTML = html;
}

function renderMicronutrientsFromMealData(meals) {
  var panel = document.getElementById('meals-micro-panel');
  if (!panel) return;
  var totals = getMicroTotalsFromMeals(meals);
  var hasAny = Object.keys(totals).length > 0;
  panel.style.display = hasAny ? 'block' : 'none';
  if (hasAny) renderMicroPanel(totals, 'meals-micro-content');
}

function renderMicronutrientsFromNutrients(nutrients) {
  // Legacy path: reads from meal_nutrient table rows (may be empty)
  // Converts to same totals format and delegates to renderMicroPanel
  if (!nutrients || nutrients.length === 0) return;
  var totals = {};
  var seenPerMeal = {};
  nutrients.forEach(function(n) {
    var def = MICRO_ALIAS_MAP[n.name];
    if (!def) return;
    var val = parseFloat(n.value || 0);
    if (!val) return;
    if (!seenPerMeal[n.meal_log_id]) seenPerMeal[n.meal_log_id] = {};
    if (!seenPerMeal[n.meal_log_id][def.key] || val > seenPerMeal[n.meal_log_id][def.key]) {
      seenPerMeal[n.meal_log_id][def.key] = val;
    }
  });
  Object.values(seenPerMeal).forEach(function(meal) {
    Object.keys(meal).forEach(function(k) { totals[k] = (totals[k] || 0) + meal[k]; });
  });
  // Also update the dashboard micro-grid if it exists
  var grid = document.getElementById('micro-grid');
  if (grid) renderMicroPanel(totals, 'micro-grid');
}

function renderInsights(insights) {
  var el = document.getElementById('d-insights');
  if (!el) return;
  el.innerHTML = insights.map(function(ins) {
    var riskClass = 'risk-' + (ins.risk_level || 'low');
    return '<div class="insight-item">'
      + '<div class="insight-top">'
      + '<span class="insight-risk ' + riskClass + '">' + (ins.risk_level || 'low') + '</span>'
      + '<span class="insight-title">' + ins.title + '</span>'
      + '</div>'
      + '<div class="insight-body">' + (ins.summary || '').substring(0, 120) + (ins.summary && ins.summary.length > 120 ? '...' : '') + '</div>'
      + '</div>';
  }).join('');
}

// ── WEIGHT ──
var weightEntries = [];

async function loadWeightHistory() {
  if (!currentUser) return;
  try {
    var data = await supabaseRequest(
      '/rest/v1/weight_logs?user_id=eq.' + currentUser.id + '&order=logged_at.desc&limit=14',
      'GET', null, getToken()
    );
    if (data && !data.error && data.length > 0) {
      weightEntries = data;
      var latest = data[0];
      setHTML('d-weight', parseFloat(latest.value).toFixed(1) + '<span class="weight-unit">' + (latest.unit || 'lbs') + '</span>');
      if (data.length > 1) {
        var prev = parseFloat(data[1].value), cur = parseFloat(latest.value);
        var diff = Math.round((cur - prev) * 10) / 10;
        var el = document.getElementById('d-weight-d');
        el.textContent = diff > 0 ? '↑ +' + diff + ' since last entry' : diff < 0 ? '↓ ' + diff + ' since last entry' : '— unchanged';
        el.className = 'weight-delta ' + (diff > 0 ? 'delta-up' : diff < 0 ? 'delta-down' : 'delta-neutral');
      }
      renderWeightHistory(data);
    }
  } catch(e) { console.error('Weight load error:', e); }
}

function renderWeightHistory(entries) {
  var list = document.getElementById('weight-history-list');
  if (!list) return;
  list.innerHTML = entries.slice(0, 8).map(function(e, i) {
    var diff = i < entries.length - 1 && entries[i+1].value != null ? parseFloat(e.value) - parseFloat(entries[i+1].value) : 0;
    diff = Math.round(diff * 10) / 10;
    var dt = new Date(e.logged_at || e.created_at);
    return '<div class="weight-entry">'
      + '<div class="weight-entry-date">' + dt.toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) + '</div>'
      + '<div class="weight-entry-val">' + parseFloat(e.value).toFixed(1) + ' <span style="font-size:12px;color:var(--muted)">' + (e.unit || 'lbs') + '</span></div>'
      + (diff !== 0 ? '<div class="weight-entry-delta ' + (diff > 0 ? 'delta-up' : 'delta-down') + '">' + (diff > 0 ? '+' : '') + diff + '</div>' : '<div class="weight-entry-delta delta-neutral">—</div>')
      + '</div>';
  }).join('');
}

function setWeightDateDefault() {
  var d = document.getElementById('w-date');
  if (d) d.value = new Date().toISOString().split('T')[0];
}

async function saveWeight() {
  var val = document.getElementById('w-value').value;
  var unit = document.getElementById('w-unit').value;
  var date = document.getElementById('w-date').value;
  var notes = document.getElementById('w-notes').value;
  if (!val) { alert('Please enter a weight value.'); return; }
  try {
    await supabaseRequest('/rest/v1/weight_logs', 'POST', {
      user_id: currentUser.id, value: parseFloat(val), unit: unit,
      logged_at: date + 'T12:00:00Z', notes: notes
    }, getToken());
    closeModal('weight-modal');
    document.getElementById('w-value').value = '';
    document.getElementById('w-notes').value = '';
    loadWeightHistory();
  } catch(e) { alert('Could not save weight. Please try again.'); }
}

// ── MEALS ──
var mealsView = 'day';
var mealsDate = new Date();

function setMealsView(view, btn) {
  mealsView = view;
  document.querySelectorAll('#page-meals .tf-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  document.getElementById('meals-day-view').style.display = view === 'day' ? 'block' : 'none';
  document.getElementById('meals-aggregate-view').style.display = view !== 'day' ? 'block' : 'none';
  updateMealsDateLabel();
  loadMealsPage();
}

function stepMealsDate(dir) {
  if (mealsView === 'day') mealsDate.setDate(mealsDate.getDate() + dir);
  else if (mealsView === 'week') mealsDate.setDate(mealsDate.getDate() + dir * 7);
  else if (mealsView === 'month') mealsDate.setMonth(mealsDate.getMonth() + dir);
  var now = new Date();
  if (mealsDate > now) mealsDate = new Date(now);
  updateMealsDateLabel();
  loadMealsPage();
}

function resetMealsDate() {
  mealsDate = new Date();
  updateMealsDateLabel();
  loadMealsPage();
}

function getMealsDateRange() {
  var end = new Date(mealsDate);
  end.setHours(23,59,59,999);
  var start = new Date(mealsDate);
  if (mealsView === 'day') {
    start.setHours(0,0,0,0);
  } else if (mealsView === 'week') {
    start.setDate(start.getDate() - 6);
    start.setHours(0,0,0,0);
  } else {
    start.setDate(1);
    start.setHours(0,0,0,0);
  }
  return { start: start, end: end };
}

function localDateStr(date) {
  return date.getFullYear() + '-'
    + String(date.getMonth()+1).padStart(2,'0') + '-'
    + String(date.getDate()).padStart(2,'0');
}

// Local-date key for a sample row. Comparing r.start_date.startsWith(YYYY-MM-DD)
// matches the UTC prefix, which silently shifts evening samples for users east
// of UTC into the wrong day. Always derive the local date from the parsed
// timestamp instead.
function localDateStrOf(row) {
  var iso = row && (row.start_date || row.recorded_at);
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return localDateStr(d);
}

// Source-deduped daily total for cumulative metrics (steps, distance, active
// energy, exercise minutes). Mobile's get_health_cumulative_aggregates RPC
// (mobile commit 333d2a6) does the same logic in Postgres: take MAX(value)
// per (day, source_id) to fold same-source re-syncs, then MAX across sources
// so iPhone + Apple Watch reporting the same daily total don't double up.
function dedupedDailyTotal(rows, dateStr) {
  if (!rows) return 0;
  var perSource = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (localDateStrOf(r) !== dateStr) continue;
    var v = parseFloat(r.value || 0);
    if (!isFinite(v)) continue;
    var src = r.source_id || r.source_name || 'unknown';
    if (perSource[src] == null || v > perSource[src]) perSource[src] = v;
  }
  var max = 0;
  for (var k in perSource) { if (perSource[k] > max) max = perSource[k]; }
  return max;
}

function updateMealsDateLabel() {
  var label = document.getElementById('meals-date-label');
  var todayBtn = document.getElementById('meals-today-btn');
  var nextBtn = document.getElementById('meals-next-btn');
  var today = new Date();
  var isToday = localDateStr(mealsDate) === localDateStr(today);

  if (mealsView === 'day') {
    if (isToday) label.innerHTML = '<em>Today</em>';
    else if (localDateStr(mealsDate) === localDateStr(new Date(today.getTime() - 86400000))) label.innerHTML = 'Yesterday';
    else label.innerHTML = mealsDate.toLocaleDateString('en-US', {weekday:'short', month:'long', day:'numeric'});
  } else if (mealsView === 'week') {
    var range = getMealsDateRange();
    label.innerHTML = range.start.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + range.end.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  } else {
    label.innerHTML = mealsDate.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  }

  if (nextBtn) nextBtn.disabled = isToday;
  if (todayBtn) todayBtn.classList.toggle('active', isToday);
  var aggLabel = document.getElementById('agg-period-label');
  if (aggLabel) aggLabel.textContent = mealsView === 'week' ? 'This week' : 'This month';
}

var _mealsLoadTimer = null;
async function loadMealsPage() {
  if (!currentUser) return;
  // Debounce: cancel any pending load triggered within 50ms
  if (_mealsLoadTimer) { clearTimeout(_mealsLoadTimer); _mealsLoadTimer = null; }
  updateMealsDateLabel();
  var range = getMealsDateRange();
  var today = localDateStr(mealsDate);

  try {
    // Ensure we have a valid session token
    var token = getToken();
    if (!token) {
      document.getElementById('meals-list').innerHTML = '<div class="empty-state" style="padding:40px"><div class="empty-state-icon">🍽</div><div class="empty-state-text">Session expired. Please refresh.</div></div>';
      return;
    }
    // Fetch meals for the selected date range (with buffer for timezone shifts)
    // Use meal_time (user-set) instead of created_at (server-set) so meals logged for
    // a specific date always appear on that date, even when logged later
    var fetchStart = new Date(range.start); fetchStart.setDate(fetchStart.getDate() - 1);
    var fetchEnd   = new Date(range.end);   fetchEnd.setDate(fetchEnd.getDate() + 1);
    var meals = await supabaseRequest(
      '/rest/v1/meal_log?select=id,meal_type,meal_time,meal_description,created_at,data&user_id=eq.' + currentUser.id
        + '&or=(and(meal_time.gte.' + fetchStart.toISOString() + ',meal_time.lte.' + fetchEnd.toISOString() + '),and(meal_time.is.null,created_at.gte.' + fetchStart.toISOString() + ',created_at.lte.' + fetchEnd.toISOString() + '))'
        + '&order=meal_time.desc.nullslast,created_at.desc&limit=500',
      'GET', null, token
    );
    if (!meals || meals.error || !Array.isArray(meals)) {
      console.log('[Healix] meals fetch failed or empty:', meals);
      document.getElementById('meals-list').innerHTML = '<div class="empty-state" style="padding:40px">'
        + '<div class="empty-state-icon">🍽</div>'
        + '<div class="empty-state-text">No intake logged yet.</div>'
        + '<div style="font-size:12px;color:var(--cream-dim);margin-top:8px;line-height:1.6">Tracking what you consume powers your nutrition insights and helps Healix give personalized advice.</div>'
        + '<button class="upload-btn" onclick="setMealDateTimeDefault();openModal(\'meal-modal\')" style="margin:16px auto 0;display:flex">+ Log Intake</button>'
        + '</div>';
      return;
    }
    console.log('[Healix] meals fetched:', meals.length, 'mealsDate=', localDateStr(mealsDate));
    window._healixMeals = meals;

    // Auto-reanalyze meals with empty nutrition data (non-blocking)
    reanalyzeMealsWithEmptyData(meals, token);

    // Auto-log ALL nutrition fields from first meal that has data
    var sampleMeal = meals.find(function(m) { return m.data; });
    if (sampleMeal) {
      var d = null;
      try { d = typeof sampleMeal.data === 'string' ? JSON.parse(sampleMeal.data) : sampleMeal.data; } catch(e) {}
      if (d && d.total_nutrition) {
        Object.keys(d.total_nutrition).forEach(function(cat) {
          var items = d.total_nutrition[cat];
          if (Array.isArray(items)) {
            console.log('[Healix] ' + cat + ':', items.map(function(x){ return x.name + '=' + x.value + (x.unit||''); }).join(', '));
          }
        });
      } else {
        console.log('[Healix] meal.data keys:', d ? Object.keys(d) : 'null');
      }
    }

    // Fetch nutrients
    var nutrients = [];
    if (meals.length > 0) {
      var ids = meals.map(function(m) { return m.id; }).join(',');
      var nutrientData = await supabaseRequest(
        '/rest/v1/meal_nutrient?meal_log_id=in.(' + ids + ')&select=meal_log_id,category,name,value',
        'GET', null, getToken()
      ).catch(function() { return []; });
      if (Array.isArray(nutrientData)) nutrients = nutrientData;
    }

    if (mealsView === 'day') {
      renderMealsDayView(meals, nutrients, today);
      loadSupplements();
    } else {
      renderMealsAggregateView(meals, nutrients, range);
    }
  } catch(e) { console.error('Meals page error:', e); }
}

function getNutrientFromData(mealData, name) {
  if (!mealData || !mealData.total_nutrition) return null;
  var nameLower = name.toLowerCase();
  var categories = Object.values(mealData.total_nutrition);
  // First pass: exact match
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    if (!Array.isArray(cat)) continue;
    for (var j = 0; j < cat.length; j++) {
      if (cat[j].name === name) return parseFloat(cat[j].value || 0);
    }
  }
  // Second pass: case-insensitive
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    if (!Array.isArray(cat)) continue;
    for (var j = 0; j < cat.length; j++) {
      if (cat[j].name && cat[j].name.toLowerCase() === nameLower) return parseFloat(cat[j].value || 0);
    }
  }
  return null;
}

function debugMealData(meal) {
  // Call this from console: debugMealData(meals[0])
  var data = null;
  try { data = typeof meal.data === 'string' ? JSON.parse(meal.data) : meal.data; } catch(e) {}
  if (!data || !data.total_nutrition) { console.log('No total_nutrition in data'); return; }
  Object.keys(data.total_nutrition).forEach(function(cat) {
    var items = data.total_nutrition[cat];
    if (Array.isArray(items)) {
      console.log('Category:', cat);
      items.forEach(function(i) { console.log('  ', i.name, '=', i.value, i.unit); });
    }
  });
}

function getNutrientFirstMatch(mealData, names) {
  // Try multiple possible field names, return first match
  for (var i = 0; i < names.length; i++) {
    var v = getNutrientFromData(mealData, names[i]);
    if (v !== null && v > 0) return v;
  }
  // Last resort: try first match that returns non-null even if 0
  for (var i = 0; i < names.length; i++) {
    var v = getNutrientFromData(mealData, names[i]);
    if (v !== null) return v;
  }
  return null;
}

function getMacrosFromMeal(m) {
  var data = null;
  try { data = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) {}
  return {
    cal:  getNutrientFirstMatch(data, ['Calories','Energy','Calorie','Total Calories']),
    prot: getNutrientFirstMatch(data, ['Protein','Proteins','Total Protein']),
    carb: getNutrientFirstMatch(data, ['Carbohydrates','Total Carbohydrate','Total Carbohydrates','Carbohydrate','Carbs','Net Carbs']),
    fat:  getNutrientFirstMatch(data, ['Fat','Total Fat','Fats','Total Fats'])
  };
}

function renderMealsDayView(meals, nutrients, today) {
  // Filter using localDateStr string comparison - robust against UTC/local timezone issues
  // "today" = localDateStr(mealsDate) passed in from loadMealsPage
  var selectedDateStr = today;
  console.log("[Healix] renderMealsDayView: date=", selectedDateStr, "total meals=", meals.length);

  var dayMeals = meals.filter(function(m) {
    var raw = (m.meal_time && m.meal_time !== null) ? m.meal_time : m.created_at;
    var dt = new Date(raw);
    var ds = localDateStr(dt);
    return ds === selectedDateStr;
  });

  console.log("[Healix] dayMeals after filter:", dayMeals.length);
  if (meals.length > 0) { console.log("[Healix] sample:", meals.slice(0,3).map(function(m){ return (m.meal_time||m.created_at) + " -> " + localDateStr(new Date(m.meal_time||m.created_at)); })); }

  var emojis = { breakfast:'🍳', lunch:'🥗', dinner:'🍽', snack:'🍎', cooked:'🍳', drink:'🥤', dessert:'🍰', supplement:'💊', 'ate out':'🍽', beverage:'🥤', medication:'💊', alcohol:'🍷', other:'📦' };
  var list = document.getElementById('meals-list');

  if (dayMeals.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:40px">'
      + '<div class="empty-state-icon">🍽</div>'
      + '<div class="empty-state-text">No intake logged on this day.</div>'
      + '<div style="font-size:12px;color:var(--cream-dim);margin-top:8px;line-height:1.6">Tracking what you consume powers your nutrition insights and helps Healix give personalized advice.</div>'
      + '<button class="upload-btn" onclick="setMealDateTimeDefault();openModal(\'meal-modal\')" style="margin:16px auto 0;display:flex">+ Log Intake</button>'
      + '</div>';
  } else {
    // Group nutrients by meal
    var nutrientsByMeal = {};
    nutrients.forEach(function(n) {
      if (!nutrientsByMeal[n.meal_log_id]) nutrientsByMeal[n.meal_log_id] = {};
      var existing = nutrientsByMeal[n.meal_log_id][n.name] || 0;
      if (parseFloat(n.value || 0) > existing) nutrientsByMeal[n.meal_log_id][n.name] = parseFloat(n.value || 0);
    });

    list.innerHTML = dayMeals.map(function(m) {
      var dt = new Date(m.meal_time || m.created_at);
      var mealType = (m.meal_type || '').toLowerCase();
      // Always read from meal_log.data for consistency with macro totals
      var macros = getMacrosFromMeal(m);
      var cal  = macros.cal  !== null ? Math.round(macros.cal)  : null;
      var prot = macros.prot !== null ? Math.round(macros.prot) : null;
      var carb = macros.carb !== null ? Math.round(macros.carb) : null;
      var fat  = macros.fat  !== null ? Math.round(macros.fat)  : null;
      return '<div class="meal-card" style="position:relative">'
        + '<div class="meal-card-emoji">' + (emojis[mealType] || '🥘') + '</div>'
        + '<div class="meal-card-info">'
        + '<div class="meal-card-name">' + escapeHtml(m.meal_description || 'Intake') + '</div>'
        + '<div class="meal-card-time">' + (m.meal_type ? escapeHtml(m.meal_type.charAt(0).toUpperCase()+m.meal_type.slice(1)) : '') + ' · ' + dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) + '</div>'
        + '<div class="meal-card-macros">'
        + (prot !== null ? '<div class="meal-card-macro">P <span>' + prot + 'g</span></div>' : '')
        + (carb !== null ? '<div class="meal-card-macro">C <span>' + carb + 'g</span></div>' : '')
        + (fat  !== null ? '<div class="meal-card-macro">F <span>' + fat  + 'g</span></div>' : '')
        + '</div></div>'
        + '<div style="display:flex;align-items:center;gap:12px">'
        + '<div class="meal-card-cals">' + (cal || '—') + '</div>'
        + '<div style="display:flex;gap:4px" class="meal-actions">'
        + '<button onclick="event.stopPropagation();openEditMeal(\'' + m.id + '\')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:6px 8px" title="Edit">✎</button>'
        + '<button onclick="event.stopPropagation();deleteMeal(\'' + m.id + '\')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:6px 8px" title="Delete">✕</button>'
        + '</div></div>'
        + '</div>';
    }).join('');
  }

  // Day totals — always use meal_log.data as source of truth for macros.
  // meal_nutrient table may have stale or partial data so we skip it for macro totals.
  renderMacrosFromMealData(dayMeals);

  // Micronutrients — includes supplement contributions when available
  renderMicronutrientsWithSupplements(dayMeals);
}

function renderMealsAggregateView(meals, nutrients, range) {
  // Group meals by local date
  var byDay = {};
  meals.forEach(function(m) {
    var d = localDateStr(new Date(m.meal_time || m.created_at));
    if (!byDay[d]) byDay[d] = { meals: [] };
    byDay[d].meals.push(m);
  });

  // Only show days within the selected range
  var rangeStart = localDateStr(range.start);
  var rangeEnd   = localDateStr(range.end);
  var days = Object.keys(byDay).filter(function(d) { return d >= rangeStart && d <= rangeEnd; }).sort();
  var numDays = Math.max(days.length, 1);

  function dayMacroTotal(d, macroKey) {
    var total = 0;
    (byDay[d] ? byDay[d].meals : []).forEach(function(m) {
      var macros = getMacrosFromMeal(m);
      total += macros[macroKey] || 0;
    });
    return Math.round(total);
  }

  var calsByDay  = days.map(function(d) { return dayMacroTotal(d, 'cal'); });
  var protByDay  = days.map(function(d) { return dayMacroTotal(d, 'prot'); });
  var carbsByDay = days.map(function(d) { return dayMacroTotal(d, 'carb'); });
  var fatsByDay  = days.map(function(d) { return dayMacroTotal(d, 'fat'); });

  var avgCal  = Math.round(calsByDay.reduce(function(s,v){return s+v;},0) / numDays);
  var avgProt = Math.round(protByDay.reduce(function(s,v){return s+v;},0) / numDays);
  var avgCarb = Math.round(carbsByDay.reduce(function(s,v){return s+v;},0) / numDays);
  var avgFat  = Math.round(fatsByDay.reduce(function(s,v){return s+v;},0) / numDays);

  // Update macro rings with avg values
  var periodLabel = mealsView === 'week' ? 'this week' : 'this month';
  var safeSet = function(id,v) { var e=document.getElementById(id); if(e) e.textContent=v; };
  var safeHTML = function(id,v) { var e=document.getElementById(id); if(e) e.innerHTML=v; };
  safeSet('mp-cal', avgCal || '—');
  safeSet('mp-cal-sub', 'avg/day calories ' + periodLabel);
  safeHTML('mp-protein', (avgProt || '—') + '<span>g</span>');
  safeSet('mp-prot-sub', 'avg/day protein');
  safeHTML('mp-carbs', (avgCarb || '—') + '<span>g</span>');
  safeSet('mp-carb-sub', 'avg/day carbs');
  safeHTML('mp-fat', (avgFat || '—') + '<span>g</span>');
  safeSet('mp-fat-sub', 'avg/day fat');

  // Animate rings for avg values
  var targets = getMacroTargets();
  animateMacroRings(avgProt, avgCarb, avgFat, targets);

  // Avg macro cards
  document.getElementById('agg-cal').textContent     = avgCal || '—';
  document.getElementById('agg-protein').innerHTML   = (avgProt || '—') + '<span style="font-size:14px;color:var(--muted)">g</span>';
  document.getElementById('agg-carbs').innerHTML     = (avgCarb || '—') + '<span style="font-size:14px;color:var(--muted)">g</span>';
  document.getElementById('agg-fat').innerHTML       = (avgFat || '—') + '<span style="font-size:14px;color:var(--muted)">g</span>';

  // Macro split breakdown (mobile ad5be2e). Show only when meal data exists.
  renderMacroSplit(avgProt, avgCarb, avgFat, targets);



  // Calorie bar chart with date labels
  var calChart = document.getElementById('agg-cal-chart');
  var calDates = document.getElementById('agg-cal-dates');
  if (calChart) {
    var maxCal = Math.max.apply(null, calsByDay.concat([1]));
    var calGoal = targets.cal;
    calChart.style.display = 'flex';
    calChart.style.alignItems = 'flex-end';
    calChart.style.gap = '3px';
    calChart.innerHTML = calsByDay.map(function(v, i) {
      var pct = Math.max(4, Math.round(v / Math.max(maxCal, calGoal) * 100));
      var overGoal = v > calGoal;
      var color = overGoal ? 'var(--down)' : 'var(--gold)';
      var dt = new Date(days[i] + 'T12:00:00');
      var label = mealsView === 'month'
        ? dt.toLocaleDateString('en-US',{day:'numeric'})
        : dt.toLocaleDateString('en-US',{weekday:'short'});
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer" title="' + v + ' cal" onclick="drillToDay(\'' + days[i] + '\')">'
        + '<div style="width:100%;background:' + color + ';height:' + pct + '%;min-height:3px;border-radius:2px 2px 0 0;transition:height .4s"></div>'
        + '</div>';
    }).join('');
    if (calDates) {
      // Show first, middle, last labels only (avoid crowding)
      calDates.style.display = 'flex';
      calDates.style.justifyContent = 'space-between';
      calDates.innerHTML = days.map(function(d, i) {
        var dt = new Date(d + 'T12:00:00');
        var showLabel = (i === 0 || i === days.length - 1 || (days.length <= 14 && mealsView === 'week') || i % 7 === 0);
        return '<span style="font-size:9px;color:' + (showLabel ? 'var(--muted)' : 'transparent') + ';flex:1;text-align:' + (i===0?'left':i===days.length-1?'right':'center') + '">'
          + (showLabel ? dt.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '·') + '</span>';
      }).join('');
    }
  }

  // Period label
  var aggLabel = document.getElementById('agg-period-label');
  if (aggLabel) aggLabel.textContent = mealsView === 'week' ? '· this week' : '· this month';

  // Daily breakdown table
  var breakdown = document.getElementById('agg-daily-breakdown');
  if (!breakdown) return;
  if (days.length === 0) {
    breakdown.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">No intake logged in this period.</div>';
    return;
  }
  breakdown.innerHTML = '<table style="width:100%;border-collapse:collapse">'
    + '<thead><tr style="border-bottom:1px solid var(--gold-border)">'
    + ['Date','Calories','Protein','Carbs','Fat','Meals'].map(function(h) {
        return '<th style="text-align:left;padding:10px 0;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);font-weight:400">' + h + '</th>';
      }).join('')
    + '</tr></thead><tbody>'
    + days.slice().reverse().map(function(d, i) {
        var ri = days.length - 1 - i;
        var dt = new Date(d + 'T12:00:00');
        var isToday = d === localDateStr(new Date());
        var overGoal = calsByDay[ri] > targets.cal;
        return '<tr style="border-bottom:1px solid rgba(184,151,90,.06);cursor:pointer" onclick="drillToDay(\'' + d + '\')" onmouseover="this.style.background=\'var(--gold-faint)\'" onmouseout="this.style.background=\'\'">'

          + '<td style="padding:11px 0;font-size:13px;color:' + (isToday ? 'var(--gold)' : 'var(--cream)') + '">' + dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) + '</td>'
          + '<td style="padding:11px 0;font-family:var(--F);font-size:18px;font-weight:300;color:' + (overGoal ? 'var(--down)' : 'var(--cream)') + '">' + (calsByDay[ri] || '—') + '</td>'
          + '<td style="padding:11px 0;font-size:13px;color:var(--cream-dim)">' + (protByDay[ri] || '—') + 'g</td>'
          + '<td style="padding:11px 0;font-size:13px;color:var(--cream-dim)">' + (carbsByDay[ri] || '—') + 'g</td>'
          + '<td style="padding:11px 0;font-size:13px;color:var(--cream-dim)">' + (fatsByDay[ri] || '—') + 'g</td>'
          + '<td style="padding:11px 0;font-size:13px;color:var(--muted)">' + (byDay[d] ? byDay[d].meals.length : 0) + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table>';

  // Micronutrients — sum across all meals in range, show avg % of RDA
  var rangeMeals = days.reduce(function(acc, d) {
    return acc.concat(byDay[d] ? byDay[d].meals : []);
  }, []);
  var aggMicroPanel = document.getElementById('agg-micro-panel');
  if (rangeMeals.length > 0) {
    var microTotals = getMicroTotalsFromMeals(rangeMeals);
    var hasAny = Object.keys(microTotals).length > 0;
    if (aggMicroPanel) aggMicroPanel.style.display = hasAny ? 'block' : 'none';
    if (hasAny) {
      // Average each nutrient across the number of days that had meals
      var daysWithMeals = days.filter(function(d) { return byDay[d] && byDay[d].meals.length > 0; }).length || 1;
      var avgTotals = {};
      Object.keys(microTotals).forEach(function(k) {
        avgTotals[k] = microTotals[k] / daysWithMeals;
      });
      renderMicroPanel(avgTotals, 'agg-micro-content');
    }
  } else {
    if (aggMicroPanel) aggMicroPanel.style.display = 'none';
  }
}

async function renderWeightTrendChart(range) {
  if (!currentUser) return;
  try {
    var weightData = await supabaseRequest(
      '/rest/v1/weight_logs?user_id=eq.' + currentUser.id + '&logged_at=gte.' + range.start.toISOString() + '&logged_at=lte.' + range.end.toISOString() + '&order=logged_at.asc',
      'GET', null, getToken()
    );
    var chart = document.getElementById('agg-weight-chart');
    var dates = document.getElementById('agg-weight-dates');
    if (!weightData || weightData.error || weightData.length === 0) {
      chart.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:16px">No weight entries logged in this period.</div>';
      return;
    }
    var vals = weightData.map(function(w) { return parseFloat(w.value); });
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    var range2 = max - min || 1;
    chart.innerHTML = vals.map(function(v) {
      var pct = Math.max(10, Math.round(((v - min) / range2) * 80) + 10);
      return '<div style="flex:1;background:var(--gold);height:' + pct + '%;min-height:4px"></div>';
    }).join('');
    chart.style.display = 'flex';
    chart.style.alignItems = 'flex-end';
    chart.style.gap = '4px';
    dates.innerHTML = weightData.map(function(w) {
      var dt = new Date(w.logged_at || w.created_at);
      return '<span style="font-size:9px;color:var(--muted)">' + dt.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</span>';
    }).join('');
  } catch(e) {}
}

function drillToDay(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  mealsDate = d;
  pageSelectedDate['meals'] = d;
  setMealsView('day', document.getElementById('meals-view-day'));
  updateDateNav('meals');
}


function toggleMealNutrition() {
  var fields = document.getElementById('ml-nutrition-fields');
  var arrow = document.getElementById('ml-nutrition-arrow');
  if (fields.style.display === 'none') {
    fields.style.display = 'block';
    arrow.style.transform = 'rotate(90deg)';
  } else {
    fields.style.display = 'none';
    arrow.style.transform = '';
  }
}

function setMealDateTimeDefault() {
  var now = new Date();
  // Format as YYYY-MM-DDTHH:MM for datetime-local input
  var y = now.getFullYear();
  var mo = String(now.getMonth() + 1).padStart(2, '0');
  var d = String(now.getDate()).padStart(2, '0');
  var h = String(now.getHours()).padStart(2, '0');
  var mi = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('ml-datetime').value = y + '-' + mo + '-' + d + 'T' + h + ':' + mi;
}

async function saveMeal() {
  var name = document.getElementById('ml-name').value;
  var type = document.getElementById('ml-type').value;
  var dt = document.getElementById('ml-datetime').value;
  var cals = document.getElementById('ml-cals').value;
  var prot = document.getElementById('ml-protein').value;
  var carbs = document.getElementById('ml-carbs').value;
  var fat = document.getElementById('ml-fat').value;
  if (!name && !_intakePhotoMealData) { alert('Please enter a description.'); return; }
  // Capitalize meal type to match DB convention (e.g. 'lunch' → 'Lunch')
  type = type.charAt(0).toUpperCase() + type.slice(1);
  var mealTime = dt ? new Date(dt).toISOString() : new Date().toISOString();

  var hasManualMacros = cals || prot || carbs || fat;

  var mealData = null;
  var mealDescription = null;

  if (_intakePhotoMealData) {
    mealData = _intakePhotoMealData;
    mealDescription = mealData.meal_description || name || 'Photo intake';
  } else if (hasManualMacros) {
    var manualMacros = [
      { name: 'Calories', value: parseFloat(cals) || 0, unit: 'kcal' },
      { name: 'Protein', value: parseFloat(prot) || 0, unit: 'g' },
      { name: 'Total Carbohydrates', value: parseFloat(carbs) || 0, unit: 'g' },
      { name: 'Total Fat', value: parseFloat(fat) || 0, unit: 'g' }
    ];
    var manualMicros = collectManualMicros();
    var totalNutrition = { Macronutrients: manualMacros };
    if (manualMicros.Vitamins.length > 0) totalNutrition.Vitamins = manualMicros.Vitamins;
    if (manualMicros.Minerals.length > 0) totalNutrition.Minerals = manualMicros.Minerals;
    mealData = {
      total_nutrition: totalNutrition,
      nutrition_breakdown: { mealName: name, components: [{ name: name, serving_size: '', Macronutrients: manualMacros }] },
      meal_description: name,
      meal_analysis: '',
      dev_feedback: '',
      data_source: { source: 'manual', confidence: 'low' }
    };
    mealDescription = name;
  }

  if (editingMealId) {
    // Update existing meal — PATCH first, then re-analyze with AI
    try {
      var patchPayload = {
        meal_type: type, meal_description: name, raw_input: name, meal_time: mealTime
      };
      if (mealData) patchPayload.data = mealData;
      await supabaseRequest('/rest/v1/meal_log?id=eq.' + editingMealId, 'PATCH',
        patchPayload, getToken());

      // Re-analyze with AI if description changed or no nutrition data
      var mealId = editingMealId;
      editingMealId = null;
      resetMealModal();

      // Show processing state
      var processingId = 'intake-processing-' + Date.now();
      showIntakeProcessing(processingId, name, type, true);

      try {
        var aiRes = await fetch(SUPABASE_URL + '/functions/v1/analyze-meal-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
          body: JSON.stringify({ mealLog: name, meal_type: type })
        });
        if (aiRes.ok) {
          var aiResult = await aiRes.json();
          if (aiResult && aiResult.total_nutrition) {
            await supabaseRequest('/rest/v1/meal_log?id=eq.' + mealId, 'PATCH', {
              data: aiResult,
              meal_description: aiResult.meal_description || name,
              meal_analysis: aiResult.meal_analysis || '',
              dev_feedback: aiResult.dev_feedback || ''
            }, getToken());
          }
        } else {
          console.warn('[Meals] Re-analysis returned ' + aiRes.status);
        }
      } catch(aiErr) {
        console.warn('[Meals] Re-analysis failed:', aiErr);
      }

      // Remove processing card and reload
      var procEl = document.getElementById(processingId);
      if (procEl) procEl.remove();
      loadMealsPage();
      loadDashboardData();
    } catch(e) {
      var statusEl = document.getElementById('ml-status');
      statusEl.style.display = 'block';
      statusEl.style.color = 'var(--down)';
      statusEl.textContent = 'Error: ' + e.message;
    }
    return;
  }

  // New meal — close modal immediately, process in background
  var needsAI = !hasManualMacros && !_intakePhotoMealData;
  resetMealModal();

  // Show processing card in meals list
  var processingId = 'intake-processing-' + Date.now();
  showIntakeProcessing(processingId, name, type, needsAI);

  // Run analysis + save in background
  saveMealBackground(processingId, name, type, mealTime, mealData, mealDescription, needsAI);
}

function showIntakeProcessing(id, name, type, needsAI) {
  var emojis = { cooked:'🍳', 'ate out':'🍽', breakfast:'🍳', lunch:'🥗', dinner:'🍽', snack:'🍎', beverage:'🥤', supplement:'💊', medication:'💊', alcohol:'🍷', other:'📦' };
  var emoji = emojis[type.toLowerCase()] || '🥘';
  var card = document.createElement('div');
  card.id = id;
  card.className = 'meal-card intake-processing';
  card.innerHTML = '<div class="meal-card-emoji">' + emoji + '</div>'
    + '<div class="meal-card-info">'
    + '<div class="meal-card-name">' + escapeHtml(name) + '</div>'
    + '<div class="meal-card-time" style="color:var(--gold)">'
    + (needsAI ? 'Analyzing with AI...' : 'Saving...') + '</div>'
    + '<div class="intake-progress-bar"><div class="intake-progress-fill"></div></div>'
    + '</div>';
  var list = document.getElementById('meals-list');
  if (list) {
    // Remove empty state if present
    var empty = list.querySelector('.empty-state');
    if (empty) empty.remove();
    list.insertBefore(card, list.firstChild);
  }
}

function updateIntakeProcessing(id, status, isError) {
  var card = document.getElementById(id);
  if (!card) return;
  var timeEl = card.querySelector('.meal-card-time');
  if (timeEl) {
    timeEl.textContent = status;
    timeEl.style.color = isError ? 'var(--down)' : 'var(--gold)';
  }
  if (isError) {
    var bar = card.querySelector('.intake-progress-bar');
    if (bar) bar.style.display = 'none';
  }
}

// Auto-reanalyze meals that have no nutrition data
var _reanalyzeInProgress = false;
async function reanalyzeMealsWithEmptyData(meals, token) {
  // Guard against infinite loop: loadMealsPage -> reanalyze -> loadMealsPage -> reanalyze
  if (_reanalyzeInProgress) return;

  var emptyMeals = meals.filter(function(m) {
    if (!m.data || !m.meal_description) return false;
    var d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    if (!d || !d.total_nutrition) return true;
    var macros = d.total_nutrition.Macronutrients;
    return !macros || !Array.isArray(macros) || macros.length === 0;
  });
  if (emptyMeals.length === 0) return;

  _reanalyzeInProgress = true;
  console.log('[Healix] Re-analyzing ' + emptyMeals.length + ' meals with empty nutrition data');

  var successCount = 0;
  for (var i = 0; i < emptyMeals.length; i++) {
    var meal = emptyMeals[i];
    try {
      var aiRes = await fetch(SUPABASE_URL + '/functions/v1/analyze-meal-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ mealLog: meal.meal_description, meal_type: meal.meal_type || 'Cooked' })
      });
      if (aiRes.ok) {
        var aiData = await aiRes.json();
        if (aiData && aiData.total_nutrition && aiData.total_nutrition.Macronutrients && aiData.total_nutrition.Macronutrients.length > 0) {
          await supabaseRequest('/rest/v1/meal_log?id=eq.' + meal.id, 'PATCH', {
            data: aiData,
            meal_description: aiData.meal_description || meal.meal_description,
            meal_analysis: aiData.meal_analysis || '',
            dev_feedback: aiData.dev_feedback || ''
          }, token);
          successCount++;
          console.log('[Healix] Re-analyzed: ' + meal.meal_description.slice(0, 40));
        }
      }
    } catch(e) {
      console.warn('[Healix] Re-analysis failed for meal ' + meal.id + ':', e);
    }
  }
  _reanalyzeInProgress = false;
  // Only reload if at least one meal was successfully re-analyzed
  if (successCount > 0) loadMealsPage();
}

function removeIntakeProcessing(id) {
  var card = document.getElementById(id);
  if (card) card.remove();
}

async function saveMealBackground(processingId, name, type, mealTime, mealData, mealDescription, needsAI) {
  var mealAnalysis = null;
  var devFeedback = null;
  var aiNutritionBreakdown = null;

  try {
    // AI analysis if needed
    if (needsAI) {
      try {
        var aiRes = await fetch(SUPABASE_URL + '/functions/v1/analyze-meal-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
          body: JSON.stringify({ mealLog: name, meal_type: type })
        });
        console.log('[Healix] analyze-meal-ai status:', aiRes.status);
        if (aiRes.ok) {
          var aiData = await aiRes.json();
          console.log('[Healix] AI response keys:', aiData ? Object.keys(aiData) : 'null');
          console.log('[Healix] AI Macronutrients count:', aiData && aiData.total_nutrition && aiData.total_nutrition.Macronutrients ? aiData.total_nutrition.Macronutrients.length : 'none');
          if (aiData) {
            mealData = aiData;
            mealDescription = aiData.meal_description || null;
            mealAnalysis = aiData.meal_analysis || null;
            devFeedback = aiData.dev_feedback || null;
            aiNutritionBreakdown = aiData.nutrition_breakdown || null;
          }
        } else {
          console.warn('[Healix] analyze-meal-ai returned ' + aiRes.status);
        }
      } catch(e) {
        console.warn('[Healix] analyze-meal-ai failed:', e);
      }
      updateIntakeProcessing(processingId, 'Saving...', false);
    }

    // Ensure mealData is always HealthBite-compatible NutrientResponse shape
    if (!mealData || !mealData.total_nutrition) {
      mealData = {
        total_nutrition: { Macronutrients: [] },
        nutrition_breakdown: { mealName: name, components: [] },
        meal_description: name,
        meal_analysis: '',
        dev_feedback: '',
        data_source: { source: 'manual', confidence: 'low' }
      };
      mealDescription = name;
    }

    // Insert meal_log
    var insertPayload = {
      user_id: currentUser.id, meal_type: type,
      raw_input: name, meal_time: mealTime,
      data: mealData
    };
    insertPayload.meal_description = mealDescription || name;
    if (mealAnalysis) insertPayload.meal_analysis = mealAnalysis;
    if (devFeedback) insertPayload.dev_feedback = devFeedback;

    var inserted = await supabaseRequest('/rest/v1/meal_log', 'POST', insertPayload,
      getToken(), { 'Prefer': 'return=representation' });

    // Insert meal_nutrient rows
    var mealLogId = inserted && inserted[0] && inserted[0].id;
    if (mealLogId && mealData && mealData.total_nutrition) {
      var nutrientRows = [];
      var totalCats = mealData.total_nutrition;
      Object.keys(totalCats).forEach(function(category) {
        var items = totalCats[category];
        if (!Array.isArray(items)) return;
        items.forEach(function(item) {
          nutrientRows.push({
            meal_log_id: mealLogId, category: category, component_name: null,
            name: item.name, unit: item.unit || null, value: parseFloat(item.value) || 0
          });
        });
      });
      if (aiNutritionBreakdown && Array.isArray(aiNutritionBreakdown.components)) {
        aiNutritionBreakdown.components.forEach(function(comp) {
          if (!comp.nutrition) return;
          Object.keys(comp.nutrition).forEach(function(category) {
            var items = comp.nutrition[category];
            if (!Array.isArray(items)) return;
            items.forEach(function(item) {
              nutrientRows.push({
                meal_log_id: mealLogId, category: category, component_name: comp.name || null,
                name: item.name, unit: item.unit || null, value: parseFloat(item.value) || 0
              });
            });
          });
        });
      }
      if (nutrientRows.length > 0) {
        try {
          await supabaseRequest('/rest/v1/meal_nutrient', 'POST', nutrientRows, getToken());
        } catch(e) {
          console.warn('[Healix] Failed to insert meal_nutrient rows:', e);
        }
      }
    }

    // Success — refresh the list (replaces processing card with real data)
    removeIntakeProcessing(processingId);
    loadMealsPage();
    loadDashboardData();
  } catch(e) {
    console.error('[Healix] Background meal save error:', e);
    updateIntakeProcessing(processingId, 'Failed to save — tap to retry', true);
    var card = document.getElementById(processingId);
    if (card) {
      card.style.cursor = 'pointer';
      card.onclick = function() {
        removeIntakeProcessing(processingId);
        showIntakeProcessing(processingId, name, type, needsAI);
        saveMealBackground(processingId, name, type, mealTime, mealData, mealDescription, needsAI);
      };
    }
  }
}

function resetMealModal() {
  closeModal('meal-modal');
  document.querySelector('#meal-modal .modal-title').innerHTML = 'Log an <em>Intake</em>';
  document.querySelector('#meal-modal .modal-btn-primary').textContent = 'Log Intake';
  document.getElementById('ml-save-btn').disabled = false;
  ['ml-name','ml-cals','ml-protein','ml-carbs','ml-fat'].forEach(function(id) { document.getElementById(id).value = ''; });
  var nf = document.getElementById('ml-nutrition-fields');
  var na = document.getElementById('ml-nutrition-arrow');
  if (nf) nf.style.display = 'none';
  if (na) na.style.transform = '';
  var statusEl = document.getElementById('ml-status');
  if (statusEl) statusEl.style.display = 'none';
  clearIntakePhoto();
  clearIntakeMicros();
  editingMealId = null;
}

// ── INTAKE PHOTO & MICRONUTRIENTS ──
var _intakePhotoBase64 = null;
var _intakePhotoMealData = null;
var _intakePhotoDetectedItems = null;
var _intakePhotoAnalyzing = false;

var MICRO_INPUT_DEFS = {
  vitamins: [
    { name: 'Vitamin A', unit: 'mcg' },
    { name: 'Vitamin B6', unit: 'mg' },
    { name: 'Vitamin B12', unit: 'mcg' },
    { name: 'Vitamin C', unit: 'mg' },
    { name: 'Vitamin D', unit: 'mcg' },
    { name: 'Vitamin E', unit: 'mg' },
    { name: 'Vitamin K', unit: 'mcg' },
    { name: 'Folate', unit: 'mcg' }
  ],
  minerals: [
    { name: 'Calcium', unit: 'mg' },
    { name: 'Iron', unit: 'mg' },
    { name: 'Magnesium', unit: 'mg' },
    { name: 'Potassium', unit: 'mg' },
    { name: 'Sodium', unit: 'mg' },
    { name: 'Zinc', unit: 'mg' }
  ]
};

function initIntakeMicroGrids() {
  var vitGrid = document.getElementById('ml-vitamins-grid');
  var minGrid = document.getElementById('ml-minerals-grid');
  if (vitGrid && !vitGrid.innerHTML) {
    vitGrid.innerHTML = MICRO_INPUT_DEFS.vitamins.map(function(v) {
      return '<div class="modal-field"><label class="modal-label">' + v.name + ' (' + v.unit + ')</label>'
        + '<input class="modal-input" type="number" data-micro="' + v.name + '" data-unit="' + v.unit + '" placeholder="' + v.unit + '"></div>';
    }).join('');
  }
  if (minGrid && !minGrid.innerHTML) {
    minGrid.innerHTML = MICRO_INPUT_DEFS.minerals.map(function(m) {
      return '<div class="modal-field"><label class="modal-label">' + m.name + ' (' + m.unit + ')</label>'
        + '<input class="modal-input" type="number" data-micro="' + m.name + '" data-unit="' + m.unit + '" placeholder="' + m.unit + '"></div>';
    }).join('');
  }
}

function toggleIntakeVitamins() {
  initIntakeMicroGrids();
  var grid = document.getElementById('ml-vitamins-grid');
  var arrow = document.getElementById('ml-vitamins-arrow');
  if (!grid) return;
  var show = grid.style.display === 'none';
  grid.style.display = show ? 'grid' : 'none';
  if (arrow) arrow.style.transform = show ? 'rotate(90deg)' : '';
}

function toggleIntakeMinerals() {
  initIntakeMicroGrids();
  var grid = document.getElementById('ml-minerals-grid');
  var arrow = document.getElementById('ml-minerals-arrow');
  if (!grid) return;
  var show = grid.style.display === 'none';
  grid.style.display = show ? 'grid' : 'none';
  if (arrow) arrow.style.transform = show ? 'rotate(90deg)' : '';
}

function collectManualMicros() {
  var result = { Vitamins: [], Minerals: [] };
  var inputs = document.querySelectorAll('#ml-vitamins-grid input[data-micro], #ml-minerals-grid input[data-micro]');
  inputs.forEach(function(inp) {
    var val = parseFloat(inp.value);
    if (!val) return;
    var name = inp.getAttribute('data-micro');
    var unit = inp.getAttribute('data-unit');
    var isVitamin = MICRO_INPUT_DEFS.vitamins.some(function(v) { return v.name === name; });
    var arr = isVitamin ? result.Vitamins : result.Minerals;
    arr.push({ name: name, value: val, unit: unit });
  });
  return result;
}

function clearIntakeMicros() {
  var inputs = document.querySelectorAll('#ml-vitamins-grid input, #ml-minerals-grid input');
  inputs.forEach(function(inp) { inp.value = ''; });
  var vg = document.getElementById('ml-vitamins-grid');
  var mg = document.getElementById('ml-minerals-grid');
  var va = document.getElementById('ml-vitamins-arrow');
  var ma = document.getElementById('ml-minerals-arrow');
  if (vg) vg.style.display = 'none';
  if (mg) mg.style.display = 'none';
  if (va) va.style.transform = '';
  if (ma) ma.style.transform = '';
}

function handleIntakePhoto(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result;
    _intakePhotoBase64 = base64;
    document.getElementById('ml-photo-img').src = base64;
    document.getElementById('ml-photo-preview').style.display = 'block';
    document.getElementById('ml-photo-zone').style.display = 'none';
    analyzeIntakePhoto(base64);
  };
  reader.readAsDataURL(file);
}

function clearIntakePhoto() {
  _intakePhotoBase64 = null;
  _intakePhotoMealData = null;
  _intakePhotoDetectedItems = null;
  _intakePhotoAnalyzing = false;
  var preview = document.getElementById('ml-photo-preview');
  var zone = document.getElementById('ml-photo-zone');
  var input = document.getElementById('ml-photo-input');
  var status = document.getElementById('ml-photo-status');
  var panel = document.getElementById('ml-detected-panel');
  if (preview) preview.style.display = 'none';
  if (zone) zone.style.display = 'flex';
  if (input) input.value = '';
  if (status) status.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

async function analyzeIntakePhoto(base64) {
  var s = getSession(); if (!s) return;
  var token = s.access_token;
  var statusEl = document.getElementById('ml-photo-status');
  var descEl = document.getElementById('ml-name');
  _intakePhotoAnalyzing = true;
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--gold)';
  statusEl.textContent = 'Analyzing photo...';

  try {
    var hint = descEl ? descEl.value : '';
    var res = await fetch(SUPABASE_URL + '/functions/v1/analyze-meal-from-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        image: base64,
        context: hint ? 'User hint: ' + hint : ''
      })
    });
    if (!res.ok) throw new Error('Analysis failed');
    var data = await res.json();

    _intakePhotoMealData = data;

    // Populate description if empty
    if (descEl && !descEl.value && (data.meal_description || data.description)) {
      descEl.value = data.meal_description || data.description;
    }

    // Show detected items if available
    if (data.nutrition_breakdown && data.nutrition_breakdown.components) {
      _intakePhotoDetectedItems = data.nutrition_breakdown.components;
      renderDetectedItems(_intakePhotoDetectedItems);
    }

    statusEl.style.color = 'var(--up)';
    statusEl.textContent = 'Photo analyzed — review below.';
    _intakePhotoAnalyzing = false;
  } catch(e) {
    console.error('[Healix] Intake photo analysis error:', e);
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = 'Could not analyze photo. Enter details manually.';
    _intakePhotoAnalyzing = false;
  }
}

function renderDetectedItems(items) {
  var panel = document.getElementById('ml-detected-panel');
  var container = document.getElementById('ml-detected-items');
  if (!panel || !container || !items || items.length === 0) return;

  container.innerHTML = items.map(function(item, i) {
    return '<div class="intake-detected-item">'
      + '<span class="detected-name">' + escapeHtml(item.name || 'Item ' + (i + 1)) + '</span>'
      + '<input class="detected-serving" type="text" value="' + escapeHtml(item.serving_size || '').replace(/"/g, '&quot;') + '" placeholder="serving" data-idx="' + i + '">'
      + '<button class="detected-remove" onclick="removeDetectedItem(' + i + ')" title="Remove">✕</button>'
      + '</div>';
  }).join('');
  panel.style.display = 'block';
}

function removeDetectedItem(index) {
  if (!_intakePhotoDetectedItems) return;
  _intakePhotoDetectedItems.splice(index, 1);
  if (_intakePhotoDetectedItems.length === 0) {
    _intakePhotoMealData = null;
    _intakePhotoDetectedItems = null;
    document.getElementById('ml-detected-panel').style.display = 'none';
    var statusEl = document.getElementById('ml-photo-status');
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = 'All items removed. Enter details manually or retake photo.';
    return;
  }
  renderDetectedItems(_intakePhotoDetectedItems);
}

function confirmDetectedItems() {
  var panel = document.getElementById('ml-detected-panel');
  var statusEl = document.getElementById('ml-photo-status');
  if (panel) panel.style.display = 'none';
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--up)';
    statusEl.textContent = 'Photo results confirmed.';
  }
}

// ── SUPPLEMENTS ──
var userSupplements = [];
var supplementLogsToday = {}; // { supplementId: true }

async function loadSupplements() {
  if (!currentUser || !currentSession) return;
  var token = getToken();
  var today = localDateStr(mealsDate);
  try {
    var supps = await supabaseRequest(
      '/rest/v1/user_supplements?user_id=eq.' + currentUser.id + '&is_active=eq.true&order=sort_order,created_at',
      'GET', null, token
    );
    userSupplements = Array.isArray(supps) ? supps : [];

    // Fetch today's logs
    supplementLogsToday = {};
    if (userSupplements.length > 0) {
      var logs = await supabaseRequest(
        '/rest/v1/supplement_logs?user_id=eq.' + currentUser.id + '&logged_date=eq.' + today,
        'GET', null, token
      );
      if (Array.isArray(logs)) {
        logs.forEach(function(l) { supplementLogsToday[l.supplement_id] = l.id; });
      }
    }
    renderSupplements();

    // Auto-detect from meal history if no supplements defined
    if (userSupplements.length === 0 && window._healixMeals && window._healixMeals.length > 0) {
      detectSupplementsFromHistory(window._healixMeals);
    }
  } catch(e) { console.error('[Healix] loadSupplements error:', e); }
}

function renderSupplements() {
  var container = document.getElementById('supplements-stack');
  if (!container) return;
  if (userSupplements.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--muted)">No supplements added yet. Tap + ADD to define your stack.</div>';
    return;
  }
  container.innerHTML = userSupplements.map(function(s) {
    var taken = !!supplementLogsToday[s.id];
    var dosageText = s.dosage ? ' <span style="font-size:11px;color:var(--muted)">(' + escapeHtml(s.dosage) + ')</span>' : '';
    return '<button class="supp-pill' + (taken ? ' taken' : '') + '" onclick="toggleSupplement(\'' + s.id + '\')">'
      + '<span class="supp-check">' + (taken ? '✓' : '○') + '</span>'
      + '<span>' + escapeHtml(s.name) + dosageText + '</span>'
      + '<span class="supp-remove" onclick="event.stopPropagation(); removeSupplement(\'' + s.id + '\')">✕</span>'
      + '</button>';
  }).join('');
}

async function toggleSupplement(suppId) {
  if (!currentUser || !currentSession) return;
  var token = getToken();
  var today = localDateStr(mealsDate);
  try {
    if (supplementLogsToday[suppId]) {
      // Remove log
      await supabaseRequest(
        '/rest/v1/supplement_logs?id=eq.' + supplementLogsToday[suppId],
        'DELETE', null, token
      );
      delete supplementLogsToday[suppId];
    } else {
      // Add log
      var result = await supabaseRequest('/rest/v1/supplement_logs', 'POST', {
        user_id: currentUser.id,
        supplement_id: suppId,
        logged_date: today
      }, token);
      // Fetch the created ID
      var logs = await supabaseRequest(
        '/rest/v1/supplement_logs?user_id=eq.' + currentUser.id + '&supplement_id=eq.' + suppId + '&logged_date=eq.' + today,
        'GET', null, token
      );
      if (Array.isArray(logs) && logs.length > 0) {
        supplementLogsToday[suppId] = logs[0].id;
      }
    }
    renderSupplements();
    // Re-render micronutrients to include/exclude supplement contributions
    if (window._healixMeals) {
      renderMicronutrientsWithSupplements(window._healixMeals);
    }
  } catch(e) { console.error('[Healix] toggleSupplement error:', e); }
}

async function saveSupplement() {
  var nameEl = document.getElementById('supp-name');
  var dosageEl = document.getElementById('supp-dosage');
  var statusEl = document.getElementById('supp-status');
  var saveBtn = document.getElementById('supp-save-btn');
  var name = nameEl.value.trim();
  var dosage = dosageEl.value.trim();
  if (!name) { alert('Please enter a supplement name.'); return; }
  if (_suppPhotoAnalyzing) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--gold)';
    statusEl.textContent = 'Photo still analyzing, please wait...';
    return;
  }

  statusEl.style.display = 'block';
  statusEl.textContent = 'Looking up nutrient profile...';
  saveBtn.disabled = true;

  try {
    // Use photo-extracted nutrients if available. No text-based fallback —
    // estimating nutrients from a name alone is unreliable (app removed this
    // for the same reason). User can scan the label later.
    var nutrientProfile = _suppPhotoNutrients || null;

    statusEl.textContent = 'Saving supplement...';

    await supabaseRequest('/rest/v1/user_supplements', 'POST', {
      user_id: currentUser.id,
      name: name,
      dosage: dosage || null,
      nutrient_profile: nutrientProfile,
      is_active: true,
      sort_order: userSupplements.length
    }, getToken());

    closeModal('supplement-modal');
    nameEl.value = '';
    dosageEl.value = '';
    statusEl.style.display = 'none';
    saveBtn.disabled = false;
    _suppPhotoNutrients = null;
    document.getElementById('supp-photo-preview').style.display = 'none';
    document.getElementById('supp-photo-input').value = '';
    await loadSupplements();
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
    saveBtn.disabled = false;
  }
}

// ── SUPPLEMENT PHOTO ──
var _suppPhotoNutrients = null;
var _suppPhotoAnalyzing = false;

function handleSupplementPhoto(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result;
    document.getElementById('supp-photo-img').src = base64;
    document.getElementById('supp-photo-preview').style.display = 'block';
    analyzeSupplementPhoto(base64);
  };
  reader.readAsDataURL(file);
}

function clearSupplementPhoto() {
  _suppPhotoNutrients = null;
  _suppPhotoAnalyzing = false;
  document.getElementById('supp-photo-preview').style.display = 'none';
  document.getElementById('supp-photo-input').value = '';
  var statusEl = document.getElementById('supp-status');
  statusEl.style.display = 'none';
}

async function analyzeSupplementPhoto(base64) {
  var s = getSession(); if (!s) return;
  var token = s.access_token;
  var statusEl = document.getElementById('supp-status');
  var nameEl = document.getElementById('supp-name');
  var dosageEl = document.getElementById('supp-dosage');
  _suppPhotoAnalyzing = true;
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--gold)';
  statusEl.textContent = 'Reading supplement label...';

  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/analyze-supplement-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        imageUrl: base64,
        name: nameEl.value.trim() || undefined
      })
    });
    if (!res.ok) throw new Error('Analysis failed');
    var data = await res.json();

    if (data.name && data.name.trim()) {
      nameEl.value = data.name.trim();
    }
    if (data.serving_size && data.serving_size.trim()) {
      dosageEl.value = data.serving_size.trim();
    }
    if (data.nutrient_profile) {
      _suppPhotoNutrients = data.nutrient_profile;
    }

    statusEl.style.color = 'var(--up)';
    statusEl.textContent = 'Label read — review and save.';
    _suppPhotoAnalyzing = false;
  } catch(e) {
    console.error('[Healix] Supplement photo analysis error:', e);
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = 'Could not read label. Enter details manually.';
    _suppPhotoAnalyzing = false;
  }
}

async function removeSupplement(suppId) {
  var confirmed = await confirmModal('Remove this supplement from your stack?', { title: 'Remove Supplement', confirmText: 'Remove', danger: true });
  if (!confirmed) return;
  try {
    await supabaseRequest(
      '/rest/v1/user_supplements?id=eq.' + suppId,
      'PATCH', { is_active: false }, getToken()
    );
    await loadSupplements();
    if (window._healixMeals) renderMicronutrientsWithSupplements(window._healixMeals);
  } catch(e) { console.error('[Healix] removeSupplement error:', e); }
}

function getSupplementMicroTotals() {
  var totals = {};
  userSupplements.forEach(function(s) {
    if (!supplementLogsToday[s.id]) return; // not taken today
    if (!s.nutrient_profile) return;
    Object.values(s.nutrient_profile).forEach(function(cat) {
      if (!Array.isArray(cat)) return;
      cat.forEach(function(item) {
        var def = MICRO_ALIAS_MAP[item.name];
        if (!def) return;
        var val = parseFloat(item.value || 0);
        if (!val) return;
        if (def.iuToMcg && item.unit && item.unit.toLowerCase().indexOf('iu') !== -1) {
          val = val / def.iuToMcg;
        }
        totals[def.key] = (totals[def.key] || 0) + val;
      });
    });
  });
  return totals;
}

function renderMicronutrientsWithSupplements(meals) {
  var panel = document.getElementById('meals-micro-panel');
  if (!panel) return;
  var mealTotals = getMicroTotalsFromMeals(meals);
  var suppTotals = getSupplementMicroTotals();
  // Merge supplement totals into meal totals
  Object.keys(suppTotals).forEach(function(k) {
    mealTotals[k] = (mealTotals[k] || 0) + suppTotals[k];
  });
  var hasAny = Object.keys(mealTotals).length > 0;
  panel.style.display = hasAny ? 'block' : 'none';
  if (hasAny) renderMicroPanel(mealTotals, 'meals-micro-content');
}

function detectSupplementsFromHistory(meals) {
  var keywords = ['supplement', 'vitamin', 'gummy', 'gummies', 'capsule', 'tablet',
    'creatine', 'fish oil', 'omega', 'multivitamin', 'probiotic', 'magnesium supplement',
    'zinc supplement', 'emergen-c', 'collagen', 'centrum', 'melatonin', 'ashwagandha',
    'protein powder', 'whey protein'];
  var found = {};
  meals.forEach(function(m) {
    if (!m.meal_description) return;
    var desc = m.meal_description.toLowerCase();
    keywords.forEach(function(kw) {
      if (desc.indexOf(kw) !== -1 && !found[kw]) {
        // Extract a meaningful name from the description
        found[kw] = m.meal_description.length > 60 ? m.meal_description.substring(0, 57) + '...' : m.meal_description;
      }
    });
  });
  var suggestions = Object.values(found);
  if (suggestions.length === 0) return;

  var sugSection = document.getElementById('supplements-suggestions');
  var sugList = document.getElementById('supp-suggestions-list');
  if (!sugSection || !sugList) return;
  sugSection.style.display = 'block';
  sugList.innerHTML = suggestions.slice(0, 5).map(function(s) {
    return '<button class="supp-suggestion" onclick="prefillSupplement(this)" data-desc="' + s.replace(/"/g, '&quot;') + '">'
      + '<span>+</span> ' + s + '</button>';
  }).join('');
}

function prefillSupplement(el) {
  var desc = el.getAttribute('data-desc');
  document.getElementById('supp-name').value = desc;
  openModal('supplement-modal');
}

// ── BLOODWORK ──
var allBloodworkSamples = [];
var bloodworkByDate = {};
var selectedBloodworkDate = null;

// Optimal ranges for biomarkers — extracted from scoreBloodwork logic + clinical refs
// Sex-specific markers use { male: {...}, female: {...}, unit, category } format
var BIOMARKER_RANGES = {
  // ── Metabolic ──
  'Glucose':           { low: 70, optLow: 70, optHigh: 99,  high: 126, unit: 'mg/dL', category: 'Metabolic' },
  'Hemoglobin A1c':    { low: 4.0, optLow: 4.6, optHigh: 5.6, high: 6.5, unit: '%', category: 'Metabolic' },
  'HbA1c':             { low: 4.0, optLow: 4.6, optHigh: 5.6, high: 6.5, unit: '%', category: 'Metabolic' },
  'Insulin':           { low: 0, optLow: 2,   optHigh: 19,  high: 25, unit: 'uIU/mL', category: 'Metabolic' },
  'Uric Acid':         { low: 2.0, optLow: 3.0, optHigh: 7.0, high: 8.0, unit: 'mg/dL', category: 'Metabolic' },
  'Homocysteine':      { male: { low: 4, optLow: 5, optHigh: 15, high: 20 }, female: { low: 4, optLow: 5, optHigh: 8, high: 15 }, unit: 'umol/L', category: 'Metabolic' },
  // ── Lipid Panel ──
  'LDL Cholesterol':   { low: 0,  optLow: 0,   optHigh: 99,  high: 160, unit: 'mg/dL', category: 'Lipid Panel' },
  'HDL Cholesterol':   { low: 40, optLow: 60,  optHigh: 90,  high: 100, unit: 'mg/dL', category: 'Lipid Panel' },
  'Triglycerides':     { low: 0,  optLow: 0,   optHigh: 149, high: 200, unit: 'mg/dL', category: 'Lipid Panel' },
  'Total Cholesterol': { low: 0,  optLow: 0,   optHigh: 199, high: 240, unit: 'mg/dL', category: 'Lipid Panel' },
  // ── Inflammation ──
  'hs-CRP':            { low: 0,  optLow: 0,   optHigh: 1.0, high: 3.0, unit: 'mg/L', category: 'Inflammation' },
  'CRP':               { low: 0,  optLow: 0,   optHigh: 1.0, high: 3.0, unit: 'mg/L', category: 'Inflammation' },
  // ── Kidney ──
  'Creatinine':        { male: { low: 0.6, optLow: 0.7, optHigh: 1.3, high: 1.5 }, female: { low: 0.4, optLow: 0.5, optHigh: 1.0, high: 1.3 }, unit: 'mg/dL', category: 'Kidney' },
  'BUN':               { low: 7,  optLow: 7,   optHigh: 20,  high: 25, unit: 'mg/dL', category: 'Kidney' },
  'eGFR':              { low: 60, optLow: 90,  optHigh: 999, high: 999, unit: 'mL/min', category: 'Kidney' },
  // ── Liver ──
  'AST':               { low: 0,  optLow: 10,  optHigh: 34,  high: 50, unit: 'U/L', category: 'Liver' },
  'ALT':               { low: 0,  optLow: 7,   optHigh: 35,  high: 50, unit: 'U/L', category: 'Liver' },
  // ── Thyroid ──
  'TSH':               { low: 0.4, optLow: 0.5, optHigh: 4.0, high: 5.0, unit: 'mIU/L', category: 'Thyroid' },
  'Free T3':           { low: 2.0, optLow: 3.0, optHigh: 4.4, high: 4.8, unit: 'pg/mL', category: 'Thyroid' },
  'Free T4':           { low: 0.8, optLow: 1.0, optHigh: 1.77, high: 2.0, unit: 'ng/dL', category: 'Thyroid' },
  'TPO Antibodies':    { low: 0, optLow: 0, optHigh: 34, high: 100, unit: 'IU/mL', category: 'Thyroid' },
  // ── Vitamins ──
  'Vitamin D':         { low: 20, optLow: 30,  optHigh: 80,  high: 100, unit: 'ng/mL', category: 'Vitamins' },
  'Vitamin B12':       { low: 200, optLow: 300, optHigh: 900, high: 1100, unit: 'pg/mL', category: 'Vitamins' },
  'Folate':            { low: 3, optLow: 10, optHigh: 20, high: 27, unit: 'ng/mL', category: 'Vitamins' },
  // ── Blood / Iron ──
  'Iron':              { male: { low: 40, optLow: 60, optHigh: 170, high: 200 }, female: { low: 40, optLow: 50, optHigh: 170, high: 200 }, unit: 'mcg/dL', category: 'Blood' },
  'Ferritin':          { male: { low: 20, optLow: 30, optHigh: 300, high: 400 }, female: { low: 15, optLow: 50, optHigh: 150, high: 250 }, unit: 'ng/mL', category: 'Blood' },
  'TIBC':              { low: 250, optLow: 250, optHigh: 370, high: 450, unit: 'mcg/dL', category: 'Blood' },
  'Transferrin Saturation': { low: 15, optLow: 20, optHigh: 50, high: 60, unit: '%', category: 'Blood' },
  // ── CBC ──
  'Hemoglobin':        { male: { low: 12, optLow: 13.5, optHigh: 17.5, high: 18.5 }, female: { low: 10, optLow: 12.0, optHigh: 15.5, high: 17.0 }, unit: 'g/dL', category: 'CBC' },
  'WBC':               { low: 3.5, optLow: 4.5, optHigh: 10.5, high: 12.0, unit: 'K/uL', category: 'CBC' },
  'RBC':               { male: { low: 3.8, optLow: 4.5, optHigh: 5.9, high: 6.2 }, female: { low: 3.5, optLow: 3.9, optHigh: 5.0, high: 5.5 }, unit: 'M/uL', category: 'CBC' },
  'Platelets':         { low: 140, optLow: 150, optHigh: 400, high: 450, unit: 'K/uL', category: 'CBC' },
  // ── Hormones ──
  'Testosterone':      { male: { low: 250, optLow: 300, optHigh: 1000, high: 1200 }, female: { low: 10, optLow: 15, optHigh: 70, high: 100 }, unit: 'ng/dL', category: 'Hormones' },
  'Free Testosterone': { male: { low: 3, optLow: 5, optHigh: 21, high: 30 }, female: { low: 0.2, optLow: 0.5, optHigh: 3.5, high: 6.5 }, unit: 'pg/mL', category: 'Hormones' },
  'Estradiol':         { male: { low: 5, optLow: 10, optHigh: 40, high: 60 }, female: { low: 15, optLow: 20, optHigh: 350, high: 500 }, unit: 'pg/mL', category: 'Hormones' },
  'Progesterone':      { male: { low: 0, optLow: 0.1, optHigh: 0.5, high: 1.0 }, female: { low: 0, optLow: 0.1, optHigh: 25, high: 35 }, unit: 'ng/mL', category: 'Hormones' },
  'FSH':               { male: { low: 1, optLow: 1.5, optHigh: 12, high: 20 }, female: { low: 1, optLow: 1.5, optHigh: 12, high: 25 }, unit: 'mIU/mL', category: 'Hormones' },
  'LH':                { male: { low: 1, optLow: 1.5, optHigh: 9, high: 15 }, female: { low: 1, optLow: 1, optHigh: 20, high: 40 }, unit: 'mIU/mL', category: 'Hormones' },
  'DHEA-S':            { male: { low: 50, optLow: 80, optHigh: 560, high: 700 }, female: { low: 25, optLow: 35, optHigh: 430, high: 550 }, unit: 'mcg/dL', category: 'Hormones' },
  'SHBG':              { male: { low: 8, optLow: 10, optHigh: 57, high: 80 }, female: { low: 15, optLow: 18, optHigh: 144, high: 180 }, unit: 'nmol/L', category: 'Hormones' }
};

// Population norms for percentile context on driver cards (NHANES / clinical sources)
var POPULATION_NORMS = {
  heart_rate: {
    male: {
      '18-29': [[52,95],[56,90],[60,80],[64,70],[68,60],[72,50],[76,40],[80,30],[86,20],[92,10]],
      '30-39': [[54,95],[58,90],[62,80],[66,70],[70,60],[74,50],[78,40],[82,30],[88,20],[94,10]],
      '40-49': [[56,95],[60,90],[64,80],[68,70],[72,60],[76,50],[80,40],[84,30],[90,20],[96,10]],
      '50-59': [[58,95],[62,90],[66,80],[70,70],[74,60],[78,50],[82,40],[86,30],[92,20],[98,10]],
      '60+':   [[60,95],[64,90],[68,80],[72,70],[76,60],[80,50],[84,40],[88,30],[94,20],[100,10]]
    },
    female: {
      '18-29': [[56,95],[60,90],[64,80],[68,70],[72,60],[76,50],[80,40],[84,30],[90,20],[96,10]],
      '30-39': [[58,95],[62,90],[66,80],[70,70],[74,60],[78,50],[82,40],[86,30],[92,20],[98,10]],
      '40-49': [[60,95],[64,90],[68,80],[72,70],[76,60],[80,50],[84,40],[88,30],[94,20],[100,10]],
      '50-59': [[62,95],[66,90],[70,80],[74,70],[78,60],[82,50],[86,40],[90,30],[96,20],[102,10]],
      '60+':   [[64,95],[68,90],[72,80],[76,70],[80,60],[84,50],[88,40],[92,30],[98,20],[104,10]]
    }
  },
  weight_bmi: {
    male: {
      '18-29': [[19.5,95],[20.5,90],[22.0,80],[23.5,70],[25.0,60],[27.0,50],[29.0,40],[31.5,30],[34.0,20],[38.0,10]],
      '30-39': [[20.0,95],[21.0,90],[22.5,80],[24.0,70],[25.5,60],[27.5,50],[30.0,40],[32.5,30],[35.5,20],[40.0,10]],
      '40-49': [[20.5,95],[21.5,90],[23.0,80],[24.5,70],[26.0,60],[28.0,50],[30.5,40],[33.0,30],[36.0,20],[41.0,10]],
      '50-59': [[21.0,95],[22.0,90],[23.5,80],[25.0,70],[26.5,60],[28.5,50],[31.0,40],[33.5,30],[36.5,20],[41.0,10]],
      '60+':   [[21.0,95],[22.0,90],[23.5,80],[25.0,70],[26.5,60],[28.5,50],[31.0,40],[33.0,30],[36.0,20],[40.0,10]]
    },
    female: {
      '18-29': [[18.5,95],[19.5,90],[21.0,80],[22.5,70],[24.0,60],[26.5,50],[29.0,40],[32.0,30],[36.0,20],[41.0,10]],
      '30-39': [[19.0,95],[20.0,90],[21.5,80],[23.0,70],[25.0,60],[27.5,50],[30.5,40],[33.5,30],[37.5,20],[43.0,10]],
      '40-49': [[19.5,95],[20.5,90],[22.0,80],[24.0,70],[26.0,60],[28.5,50],[31.5,40],[34.5,30],[38.5,20],[44.0,10]],
      '50-59': [[20.0,95],[21.0,90],[23.0,80],[25.0,70],[27.0,60],[29.5,50],[32.5,40],[35.5,30],[39.0,20],[44.0,10]],
      '60+':   [[20.5,95],[21.5,90],[23.5,80],[25.5,70],[27.5,60],[30.0,50],[33.0,40],[36.0,30],[39.5,20],[44.0,10]]
    }
  },
  bloodwork: [[90,95],[80,85],[70,70],[60,50],[50,35],[40,20],[30,10]]
};

function getPopulationPercentile(driverKey, rawValue, profile) {
  if ((rawValue === null || rawValue === undefined) && driverKey !== 'weight') return null;
  var age = (profile && profile.age) || 35;
  var sex = (profile && profile.sex) || 'male';
  var sexKey = sex.toLowerCase().indexOf('f') !== -1 ? 'female' : 'male';
  var agKey = age < 30 ? '18-29' : age < 40 ? '30-39' : age < 50 ? '40-49' : age < 60 ? '50-59' : '60+';

  if (driverKey === 'heart' && POPULATION_NORMS.heart_rate[sexKey]) {
    var table = POPULATION_NORMS.heart_rate[sexKey][agKey];
    if (!table) return null;
    // Lower HR = higher percentile
    for (var i = 0; i < table.length; i++) {
      if (rawValue <= table[i][0]) return table[i][1];
    }
    return 5;
  }

  if (driverKey === 'weight') {
    var p = profile || {};
    var hCm = p.heightCm || (window.userProfileData && window.userProfileData.height_cm);
    var wKg = p.weightKg || (window.userProfileData && window.userProfileData.current_weight_kg);
    if (!hCm || !wKg) return null;
    var bmi = wKg / Math.pow(hCm / 100, 2);
    var table = POPULATION_NORMS.weight_bmi[sexKey] && POPULATION_NORMS.weight_bmi[sexKey][agKey];
    if (!table) return null;
    // Lower BMI = higher percentile (healthier than X%)
    for (var i = 0; i < table.length; i++) {
      if (bmi <= table[i][0]) return table[i][1];
    }
    return 5;
  }

  if (driverKey === 'bloodwork') {
    var table = POPULATION_NORMS.bloodwork;
    for (var i = 0; i < table.length; i++) {
      if (rawValue >= table[i][0]) return table[i][1];
    }
    return 5;
  }

  return null;
}

function getUserSex() {
  var p = window.userProfileData;
  return (p && (p.gender || p.sex)) || 'male';
}

function getRange(name, sex) {
  var r = BIOMARKER_RANGES[name];
  if (!r) {
    // Case-insensitive exact match only — avoids false positives from substring matching
    var lower = name.toLowerCase();
    for (var key in BIOMARKER_RANGES) {
      if (key.toLowerCase() === lower) { r = BIOMARKER_RANGES[key]; break; }
    }
  }
  if (!r) return null;
  // Resolve sex-specific ranges
  if (r.male && r.female) {
    var resolved = (sex && sex.toLowerCase().indexOf('f') !== -1) ? r.female : r.male;
    return { low: resolved.low, optLow: resolved.optLow, optHigh: resolved.optHigh, high: resolved.high, unit: r.unit, category: r.category };
  }
  return r;
}

async function loadBloodworkPage() {
  if (!currentUser) return;
  var token = getToken();
  try {
    var bw = await supabaseRequest(
      '/rest/v1/blood_work_samples?user_id=eq.' + currentUser.id + '&order=test_date.desc,created_at.desc&limit=500',
      'GET', null, token
    );
    console.log('[Healix] loadBloodworkPage result:', bw ? (bw.error ? 'ERROR:' + JSON.stringify(bw.error) : (Array.isArray(bw) ? bw.length + ' rows' : typeof bw)) : 'null');
    if (bw && Array.isArray(bw) && bw.length > 0) { console.log('[Healix] bloodwork sample[0]:', JSON.stringify(bw[0])); }
    if (!bw || bw.error || !Array.isArray(bw) || bw.length === 0) {
      renderBloodworkEmpty();
      return;
    }
    allBloodworkSamples = bw;
    // Group by test_date
    bloodworkByDate = {};
    bw.forEach(function(s) {
      var d = s.test_date || 'unknown';
      if (!bloodworkByDate[d]) bloodworkByDate[d] = [];
      bloodworkByDate[d].push(s);
    });
    // Populate date selector — include unknown-dated samples at the end
    var knownDates = Object.keys(bloodworkByDate).filter(function(d) { return d !== 'unknown'; }).sort().reverse();
    var dates = knownDates.slice();
    if (bloodworkByDate['unknown'] && bloodworkByDate['unknown'].length > 0) {
      dates.push('unknown');
    }
    if (dates.length === 0) { renderBloodworkEmpty(); return; }
    var select = document.getElementById('bw-date-select');
    if (!select) return;
    select.innerHTML = dates.map(function(d) {
      if (d === 'unknown') return '<option value="unknown">Date not specified (' + bloodworkByDate['unknown'].length + ' biomarkers)</option>';
      var dt = new Date(d + 'T12:00:00');
      var label = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      return '<option value="' + d + '">' + label + '</option>';
    }).join('');
    // Select last viewed date or most recent
    selectedBloodworkDate = dates[0];
    select.value = selectedBloodworkDate;
    renderBloodworkDate(selectedBloodworkDate);
  } catch(e) {
    console.error('[Healix] Bloodwork load error:', e);
    renderBloodworkEmpty();
  }
}

function onBloodworkDateChange() {
  var select = document.getElementById('bw-date-select');
  selectedBloodworkDate = select.value;
  renderBloodworkDate(selectedBloodworkDate);
}

function renderBloodworkEmpty() {
  document.getElementById('bw-summary').innerHTML = '';
  document.getElementById('bw-biomarkers').innerHTML =
    '<div class="empty-state" style="padding:60px">'
    + '<div class="empty-state-icon">🧬</div>'
    + '<div class="empty-state-text">No bloodwork uploaded yet.<br>Upload lab results to see your biomarkers here.</div>'
    + '<button class="upload-btn" onclick="document.getElementById(\'doc-input-full\').click()" style="margin:16px auto 0;display:flex">+ Upload Lab Results</button>'
    + '</div>';
  document.getElementById('bw-chat-cta').style.display = 'none';
  document.getElementById('bw-date-select').innerHTML = '';
}

function renderBloodworkDate(dateStr) {
  var samples = bloodworkByDate[dateStr];
  if (!samples || samples.length === 0) { renderBloodworkEmpty(); return; }

  // Find previous date for trending
  var allDates = Object.keys(bloodworkByDate).filter(function(d) { return d !== 'unknown'; }).sort().reverse();
  var prevDate = null;
  for (var i = 0; i < allDates.length; i++) {
    if (allDates[i] < dateStr) { prevDate = allDates[i]; break; }
  }
  var prevSamples = prevDate ? bloodworkByDate[prevDate] : [];
  var prevByName = {};
  prevSamples.forEach(function(s) { prevByName[s.biomarker_name] = s; });

  // Summary bar
  var flaggedCount = samples.filter(function(s) { return s.flag === 'H' || s.flag === 'L' || s.flag === 'A'; }).length;
  var normalCount = samples.filter(function(s) { return s.value !== null && !s.flag; }).length;
  var summaryEl = document.getElementById('bw-summary');
  summaryEl.innerHTML = '<div class="bw-score-bar">'
    + '<div style="flex:1">'
    + '<div class="bw-score-label">Biomarkers extracted</div>'
    + '<div class="bw-score-val">' + samples.length + '</div>'
    + '<div class="bw-score-meta">' + normalCount + ' in range' + (flaggedCount > 0 ? ' · <span style="color:var(--down)">' + flaggedCount + ' flagged</span>' : '') + '</div>'
    + '</div>'
    + (prevDate ? '<div style="text-align:right"><div class="bw-score-label">Previous labs</div><div style="font-size:14px;color:var(--cream-dim);margin-top:4px">' + new Date(prevDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</div><div style="font-size:11px;color:var(--muted);margin-top:2px">' + allDates.length + ' total reports</div></div>' : '')
    + '</div>';

  // Comparison highlight — show biggest changes when previous labs exist
  var compareHtml = '';
  if (prevDate && prevSamples.length > 0) {
    var deltas = [];
    samples.forEach(function(s) {
      var prev = prevByName[s.biomarker_name];
      if (!prev || prev.value === null || s.value === null) return;
      var diff = s.value - prev.value;
      if (Math.abs(diff) < 0.01) return;
      var pctChange = prev.value !== 0 ? Math.round((diff / prev.value) * 100) : 0;
      var name = s.biomarker_name.toLowerCase();
      var range = getRange(s.biomarker_name, getUserSex());
      var improved = false;
      if (name.indexOf('hdl') !== -1) improved = diff > 0;
      else if (s.flag === 'H' || (!s.flag && range && s.value > range.optHigh)) improved = diff < 0;
      else if (s.flag === 'L' || (!s.flag && range && s.value < range.optLow)) improved = diff > 0;
      else improved = true;
      deltas.push({ name: s.biomarker_name, oldVal: prev.value, newVal: s.value, diff: diff, pct: pctChange, improved: improved, unit: s.unit || '' });
    });
    // Sort by absolute pct change, take top 6
    deltas.sort(function(a, b) { return Math.abs(b.pct) - Math.abs(a.pct); });
    var topChanges = deltas.slice(0, 6);
    if (topChanges.length > 0) {
      var prevLabel = new Date(prevDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      var curLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      compareHtml = '<div class="bw-compare">';
      compareHtml += '<div class="bw-compare-header"><div class="bw-compare-label">Biggest Changes</div>';
      compareHtml += '<div class="bw-compare-dates">' + prevLabel + ' → ' + curLabel + '</div></div>';
      compareHtml += '<div class="bw-compare-grid">';
      topChanges.forEach(function(d) {
        var round = function(v) { return v % 1 === 0 ? v : Math.round(v * 10) / 10; };
        var arrowDir = d.diff > 0 ? 'up' : 'down';
        var arrowChar = d.diff > 0 ? '↑' : '↓';
        var pctCls = d.improved ? 'improved' : (Math.abs(d.pct) <= 5 ? 'same' : 'worsened');
        compareHtml += '<div class="bw-compare-item">';
        compareHtml += '<div class="bw-compare-name">' + escapeHtml(d.name) + '</div>';
        compareHtml += '<div class="bw-compare-values">';
        compareHtml += '<span class="bw-compare-old">' + round(d.oldVal) + '</span>';
        compareHtml += '<span class="bw-compare-arrow ' + arrowDir + '">' + arrowChar + '</span>';
        compareHtml += '<span class="bw-compare-new">' + round(d.newVal) + '</span>';
        compareHtml += '</div>';
        compareHtml += '<div class="bw-compare-pct ' + pctCls + '">' + (d.pct > 0 ? '+' : '') + d.pct + '%</div>';
        compareHtml += '</div>';
      });
      compareHtml += '</div></div>';
    }
  }

  // Group by category
  var byCategory = {};
  samples.forEach(function(s) {
    var range = getRange(s.biomarker_name, getUserSex());
    var cat = (range && range.category) || s.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(s);
  });

  // Retest wins
  var wins = detectRetestWins(samples, prevByName, getUserSex());
  var winsHtml = renderRetestWinsCard(wins);

  // Render biomarker cards
  var html = winsHtml + compareHtml;
  var categoryOrder = ['Lipid Panel', 'Metabolic', 'CBC', 'Liver', 'Kidney', 'Thyroid', 'Hormones', 'Inflammation', 'Vitamins', 'Blood', 'Other'];
  categoryOrder.forEach(function(cat) {
    var catSamples = byCategory[cat];
    if (!catSamples) return;
    html += '<div class="bw-section-title">' + escapeHtml(cat) + '</div>';
    html += '<div class="bw-grid">';
    catSamples.forEach(function(s) {
      html += renderBiomarkerCard(s, prevByName[s.biomarker_name]);
    });
    html += '</div>';
  });
  // Any remaining categories not in the order
  Object.keys(byCategory).forEach(function(cat) {
    if (categoryOrder.indexOf(cat) === -1) {
      html += '<div class="bw-section-title">' + escapeHtml(cat) + '</div>';
      html += '<div class="bw-grid">';
      byCategory[cat].forEach(function(s) {
        html += renderBiomarkerCard(s, prevByName[s.biomarker_name]);
      });
      html += '</div>';
    }
  });

  document.getElementById('bw-biomarkers').innerHTML = html;
  renderBiomarkerCollectionGrid(samples);
  document.getElementById('bw-chat-cta').style.display = 'block';
  var shareBtn = document.getElementById('bw-share-btn');
  if (shareBtn) shareBtn.style.display = 'flex';
}

function renderBiomarkerCard(sample, prevSample) {
  var range = getRange(sample.biomarker_name, getUserSex());
  var val = sample.value;
  var unit = sample.unit || (range ? range.unit : '');
  var refRange = sample.reference_range || '';
  var flag = sample.flag;

  // Determine flag if not set but range is known
  if (!flag && range && val !== null) {
    if (val < range.low) flag = 'L';
    else if (val > range.high) flag = 'H';
  }

  var flagHtml = '';
  if (flag === 'H') flagHtml = '<span class="bw-card-flag bw-flag-h">High</span>';
  else if (flag === 'L') flagHtml = '<span class="bw-card-flag bw-flag-l">Low</span>';
  else if (flag === 'A') flagHtml = '<span class="bw-card-flag bw-flag-a">Abnormal</span>';
  else if (val !== null && range) flagHtml = '<span class="bw-card-flag bw-flag-normal">Normal</span>';

  // Range visualization
  var rangeHtml = '';
  if (range && val !== null) {
    var trackMin = Math.min(range.low * 0.5, val * 0.8);
    var trackMax = Math.max(range.high * 1.3, val * 1.2);
    var trackSpan = trackMax - trackMin || 1;
    var optLeft = ((range.optLow - trackMin) / trackSpan) * 100;
    var optWidth = ((range.optHigh - range.optLow) / trackSpan) * 100;
    var markerPos = Math.max(2, Math.min(98, ((val - trackMin) / trackSpan) * 100));
    var markerCls = (val >= range.optLow && val <= range.optHigh) ? 'good' : (val >= range.low && val <= range.high) ? 'warn' : 'bad';
    rangeHtml = '<div class="bw-range-track">'
      + '<div class="bw-range-optimal" style="left:' + Math.max(0, optLeft) + '%;width:' + Math.min(100, optWidth) + '%"></div>'
      + '<div class="bw-range-marker ' + markerCls + '" style="left:' + markerPos + '%"></div>'
      + '</div>'
      + '<div class="bw-range-labels"><span>' + range.low + '</span><span>Optimal: ' + range.optLow + '–' + range.optHigh + '</span><span>' + range.high + '</span></div>';
  }

  // Delta from previous
  var deltaHtml = '';
  if (prevSample && prevSample.value !== null && val !== null) {
    var diff = val - prevSample.value;
    var pctChange = prevSample.value !== 0 ? Math.round((diff / prevSample.value) * 100) : 0;
    if (Math.abs(diff) > 0.01) {
      var improved = false;
      // For most markers, lower is better if flagged high; for HDL, higher is better
      var name = sample.biomarker_name.toLowerCase();
      if (name.indexOf('hdl') !== -1) improved = diff > 0;
      else if (flag === 'H' || (!flag && range && val > range.optHigh)) improved = diff < 0;
      else if (flag === 'L' || (!flag && range && val < range.optLow)) improved = diff > 0;
      else improved = Math.abs(diff) < Math.abs(val * 0.05);
      var arrow = diff > 0 ? '↑' : '↓';
      var cls = improved ? 'improved' : (Math.abs(pctChange) <= 5 ? 'same' : 'worsened');
      deltaHtml = '<div class="bw-card-delta ' + cls + '">' + arrow + ' ' + Math.abs(Math.round(diff * 10) / 10) + ' ' + unit + ' (' + (pctChange > 0 ? '+' : '') + pctChange + '%) from previous</div>';
    }
  }

  var displayVal = val !== null ? (val % 1 === 0 ? val : Math.round(val * 10) / 10) : escapeHtml(sample.value_text || '—');

  // Contextual chat link for flagged or out-of-range biomarkers
  var chatHtml = '';
  if (flag === 'H' || flag === 'L' || flag === 'A') {
    var chatQ = flag === 'H'
      ? 'My ' + sample.biomarker_name + ' is high at ' + displayVal + ' ' + unit + '. What does this mean and how can I improve it?'
      : flag === 'L'
      ? 'My ' + sample.biomarker_name + ' is low at ' + displayVal + ' ' + unit + '. What does this mean and how can I improve it?'
      : 'My ' + sample.biomarker_name + ' is ' + displayVal + ' ' + unit + ' which is flagged as abnormal. What should I know?';
    chatHtml = '<div class="bw-card-chat"><a class="chat-ask" href="#" onclick="event.preventDefault();event.stopPropagation();HealixChat.openWithQuestion(decodeURIComponent(\'' + encodeURIComponent(chatQ) + '\'))"><span class="chat-ask-arrow">→</span> Ask Healix about this</a></div>';
  }

  return '<div class="bw-card">'
    + '<div class="bw-card-name">' + escapeHtml(sample.biomarker_name) + '</div>'
    + '<div class="bw-card-value-row">'
    + '<div class="bw-card-value">' + displayVal + '</div>'
    + '<div class="bw-card-unit">' + escapeHtml(unit) + '</div>'
    + flagHtml
    + '</div>'
    + rangeHtml
    + (refRange ? '<div class="bw-card-ref">Ref: ' + escapeHtml(refRange) + '</div>' : '')
    + deltaHtml
    + chatHtml
    + '</div>';
}

// ── RETEST WINS ──
function detectRetestWins(samples, prevByName, bwSex) {
  var wins = [];
  samples.forEach(function(s) {
    if (s.value === null) return;
    var prev = prevByName[s.biomarker_name];
    if (!prev || prev.value === null) return;
    var range = getRange(s.biomarker_name, bwSex);
    if (!range) return;
    // Was previous outside optimal range?
    var prevOutside = prev.value < range.optLow || prev.value > range.optHigh;
    // Is current inside optimal range?
    var nowInside = s.value >= range.optLow && s.value <= range.optHigh;
    if (prevOutside && nowInside) {
      wins.push({ name: s.biomarker_name, prevVal: prev.value, newVal: s.value, unit: s.unit || range.unit || '' });
    }
  });
  return wins;
}

function renderRetestWinsCard(wins) {
  if (!wins || wins.length === 0) return '';
  var html = '<div class="bw-retest-wins">';
  html += '<div class="bw-retest-wins-title">Biomarker Wins</div>';
  wins.forEach(function(w) {
    var round = function(v) { return v % 1 === 0 ? v : Math.round(v * 10) / 10; };
    html += '<div class="bw-retest-win-item">';
    html += '<span class="bw-win-icon">&#10003;</span>';
    html += '<span class="bw-win-name">' + escapeHtml(w.name) + '</span>';
    html += '<span class="bw-win-values">';
    html += '<span class="bw-win-old">' + round(w.prevVal) + '</span>';
    html += '<span class="bw-win-arrow">&rarr;</span>';
    html += '<span class="bw-win-new">' + round(w.newVal) + '</span>';
    html += '</span>';
    html += '<span class="bw-win-label">Now optimal</span>';
    html += '</div>';
  });
  var winNames = wins.map(function(w) { return w.name; }).join(', ');
  var chatQ = 'My ' + winNames + ' improved to optimal range. What else can I do to keep improving my bloodwork?';
  html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(111,207,138,0.15)">';
  html += '<a class="chat-ask" href="#" onclick="event.preventDefault();event.stopPropagation();HealixChat.openWithQuestion(decodeURIComponent(\'' + encodeURIComponent(chatQ) + '\'))"><span class="chat-ask-arrow">→</span> What else can I improve?</a>';
  html += '</div>';
  html += '</div>';
  return html;
}

// ── BIOMARKER COLLECTION GRID ──
function renderBiomarkerCollectionGrid(samples) {
  var container = document.getElementById('bw-collection-grid');
  if (!container) return;
  if (!samples || samples.length === 0) { container.style.display = 'none'; return; }

  // Build canonical list from BIOMARKER_RANGES (dedupe aliases)
  var seen = {};
  var canonicalList = [];
  for (var key in BIOMARKER_RANGES) {
    var r = BIOMARKER_RANGES[key];
    var cat = r.category || 'Other';
    var unit = r.unit || '';
    // Build dedup key from category + unit + optLow/optHigh (handles sex-specific by using male defaults)
    var optLow = r.optLow !== undefined ? r.optLow : (r.male ? r.male.optLow : 0);
    var optHigh = r.optHigh !== undefined ? r.optHigh : (r.male ? r.male.optHigh : 0);
    var dedupKey = cat + '|' + unit + '|' + optLow + '|' + optHigh;
    if (!seen[dedupKey]) {
      seen[dedupKey] = true;
      canonicalList.push({ name: key, category: cat });
    }
  }

  // Match user's tested biomarkers
  var testedNames = {};
  samples.forEach(function(s) {
    var lower = s.biomarker_name.toLowerCase();
    testedNames[lower] = true;
  });

  var testedCount = 0;
  canonicalList.forEach(function(b) {
    if (testedNames[b.name.toLowerCase()]) testedCount++;
  });
  var total = canonicalList.length;

  // Build HTML
  var html = '<div class="bw-collection">';
  html += '<div class="bw-collection-header">';
  html += '<div class="bw-collection-title">Biomarker Collection</div>';
  html += '<div class="bw-collection-count">' + testedCount + ' of ' + total + ' collected</div>';
  html += '</div>';
  html += '<div class="bw-collection-bar"><div class="bw-collection-bar-fill" style="width:' + Math.round((testedCount / total) * 100) + '%"></div></div>';
  html += '<div class="bw-collection-grid">';
  canonicalList.forEach(function(b) {
    var filled = testedNames[b.name.toLowerCase()] ? ' filled' : '';
    html += '<div class="bw-collection-dot' + filled + '">';
    html += '<div class="bw-collection-tooltip">' + escapeHtml(b.name) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  if (testedCount === total) {
    html += '<div class="bw-collection-complete">All biomarkers collected!</div>';
  }
  html += '</div>';

  container.innerHTML = html;
  container.style.display = 'block';
}

// ── DOCUMENTS ──
var uploadedDocs = [];

async function loadDocumentsPage() {
  var grid = document.getElementById('docs-grid');
  if (!currentUser) return;
  grid.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:24px 0">Loading…</div>';
  try {
    var docs = await supabaseRequest(
      '/rest/v1/uploads?user_id=eq.' + currentUser.id + '&order=created_at.desc',
      'GET', null, getToken()
    );
    console.log('[Healix] uploads fetch:', docs ? (docs.error ? 'ERROR:'+JSON.stringify(docs.error) : docs.length + ' docs') : 'null');
    if (!docs || docs.error || docs.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:span 3;padding:40px"><div class="empty-state-icon">📄</div><div class="empty-state-text">No documents uploaded yet.<br>Upload bloodwork or lab results for AI analysis.</div></div>';
      return;
    }
    grid.innerHTML = docs.map(function(doc) {
      var icon = doc.file_type === 'application/pdf' ? '📄' : '🖼';
      var sizeStr = doc.file_size > 1024*1024 ? (doc.file_size/(1024*1024)).toFixed(1) + ' MB' : (doc.file_size/1024).toFixed(0) + ' KB';
      var dateStr = new Date(doc.created_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
      var tag = doc.document_type === 'blood_work' ? 'Bloodwork' : doc.file_type === 'application/pdf' ? 'PDF' : 'Image';
      var statusStyle = doc.status === 'error' ? 'background:var(--error-bg);color:var(--error)' : doc.status === 'processing' ? 'background:rgba(184,151,90,0.12);color:var(--gold-light)' : '';
      var statusLabel = doc.status === 'error' ? '<div style="font-size:10px;color:var(--error);margin-top:4px">Processing error</div>' : doc.status === 'processing' ? '<div style="font-size:10px;color:var(--gold);margin-top:4px">Processing…</div>' : '';
      return '<div class="doc-card" style="position:relative;' + statusStyle + '">'
        + '<button class="doc-card-delete" onclick="event.stopPropagation();deleteDocument(\'' + doc.id + '\',\'' + (doc.file_url || '').replace(/'/g, "\\'") + '\')" title="Delete document">&times;</button>'
        + '<div class="doc-card-icon">' + icon + '</div>'
        + '<div class="doc-card-name">' + escapeHtml(doc.title || 'Untitled') + '</div>'
        + '<div class="doc-card-meta">' + sizeStr + ' · ' + dateStr + '</div>'
        + '<div class="doc-card-tag">' + tag + '</div>'
        + statusLabel
        + '</div>';
    }).join('');
  } catch(e) {
    console.error('Documents load error:', e);
    grid.innerHTML = '<div class="empty-state" style="grid-column:span 3;padding:40px"><div class="empty-state-icon">📄</div><div class="empty-state-text">No documents uploaded yet.<br>Upload bloodwork or lab results for AI analysis.</div></div>';
  }
}

var DOC_BUCKET = 'documents';

async function handleDocUpload(input) {
  var files = Array.from(input.files);
  if (!files.length || !currentUser) return;
  var grid = document.getElementById('docs-grid');

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    var path = currentUser.id + '/' + Date.now() + '_' + safeName;

    // Optimistic UI — show uploading card
    var tempId = 'upload-temp-' + Date.now() + i;
    var emptyState = grid.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    grid.insertAdjacentHTML('afterbegin',
      '<div class="doc-card" id="' + tempId + '" style="opacity:0.6">'
      + '<div class="doc-card-icon">⏳</div>'
      + '<div class="doc-card-name">' + escapeHtml(file.name) + '</div>'
      + '<div class="doc-card-meta">Uploading…</div>'
      + '</div>'
    );

    try {
      // Upload file to Supabase Storage
      var uploadRes = await fetch(SUPABASE_URL + '/storage/v1/object/' + DOC_BUCKET + '/' + path, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + getToken(),
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': file.type,
          'x-upsert': 'true'
        },
        body: file
      });
      if (!uploadRes.ok) {
        var errText = await uploadRes.text();
        throw new Error('Storage: ' + uploadRes.status + ' ' + errText);
      }

      // Insert metadata row in uploads table (status: processing)
      var inserted = await supabaseRequest('/rest/v1/uploads', 'POST', {
        user_id: currentUser.id,
        title: file.name.replace(/\.[^.]+$/, ''),
        file_url: path,
        file_type: file.type,
        file_size: file.size,
        status: 'processing',
        metadata: { original_filename: file.name }
      }, getToken(), { 'Prefer': 'return=representation' });

      var upload_id = inserted && inserted[0] && inserted[0].id;

      // Update temp card to processing
      var tempCard = document.getElementById(tempId);
      if (tempCard) {
        var icon = file.type === 'application/pdf' ? '📄' : '🖼';
        tempCard.style.opacity = '0.8';
        tempCard.querySelector('.doc-card-icon').textContent = icon;
        tempCard.querySelector('.doc-card-meta').textContent = 'Processing…';
      }

      // Call process-document edge function
      if (upload_id) {
        try {
          await supabaseRequest('/functions/v1/process-document', 'POST', { upload_id: upload_id }, getToken());
        } catch(procErr) {
          console.error('process-document error:', procErr);
        }
      }

      // Update temp card to success
      if (tempCard) {
        tempCard.style.opacity = '1';
        tempCard.querySelector('.doc-card-meta').textContent = 'Uploaded just now';
      }

      // Check if this was detected as blood_work and redirect
      // Poll for processing completion since process-document runs async
      if (upload_id) {
        try {
          var pollAttempts = 0;
          var maxPollAttempts = 10;
          var updatedDoc = null;
          while (pollAttempts < maxPollAttempts) {
            updatedDoc = await supabaseRequest(
              '/rest/v1/uploads?id=eq.' + upload_id + '&select=document_type,status',
              'GET', null, getToken()
            );
            if (updatedDoc && updatedDoc[0] && updatedDoc[0].status !== 'processing') break;
            await new Promise(function(resolve) { setTimeout(resolve, 1500); });
            pollAttempts++;
          }
          var docType = updatedDoc && updatedDoc[0] && updatedDoc[0].document_type;
          var docStatus = updatedDoc && updatedDoc[0] && updatedDoc[0].status;
          if (docType === 'blood_work') {
            // Count extracted biomarkers
            var extracted = await supabaseRequest(
              '/rest/v1/blood_work_samples?upload_id=eq.' + upload_id + '&select=id',
              'GET', null, getToken()
            );
            var count = (extracted && Array.isArray(extracted)) ? extracted.length : 0;
            if (count > 0) {
              // Show inline success on the temp card
              if (tempCard) {
                tempCard.style.opacity = '1';
                tempCard.style.background = 'var(--success-bg)';
                tempCard.style.border = '1px solid var(--success-border)';
                tempCard.querySelector('.doc-card-meta').innerHTML = '<span style="color:var(--up)">✓ Extracted ' + count + ' biomarkers</span>';
              }
              // Invalidate dashboard cache and refresh dashboard data in background
              localStorage.removeItem('healix_dashboard_cache');
              loadDashboardData().then(function() {
                renderOnboardingChecklist();
                renderVitalityUnlockState();
                renderSmartEmptyStates(window._lastVitalityResult);
              });
              // Navigate to bloodwork page with success message
              showPage('bloodwork', null);
              setTimeout(function() {
                var summary = document.getElementById('bw-summary');
                if (summary) {
                  summary.insertAdjacentHTML('afterbegin',
                    '<div style="background:var(--success-bg);border:1px solid var(--success-border);padding:12px 18px;margin-bottom:16px;font-size:13px;color:var(--up);display:flex;align-items:center;gap:10px;animation:fade-in .3s ease">'
                    + '<span style="font-size:16px">✓</span> Extracted ' + count + ' biomarkers from your lab results.'
                    + '</div>'
                  );
                }
              }, 500);
              continue; // skip loadDocumentsPage for this file
            }
          } else if (docStatus === 'completed' || docStatus === 'failed') {
            // Not detected as lab report — show specific feedback inline
            if (tempCard) {
              tempCard.style.opacity = '1';
              tempCard.style.background = 'var(--error-bg)';
              tempCard.style.border = '1px solid var(--error-border)';
              tempCard.querySelector('.doc-card-icon').textContent = '⚠';
              tempCard.querySelector('.doc-card-meta').innerHTML = '<span style="color:var(--error)">Not a lab report. Please upload a valid bloodwork document.</span>';
            }
          }
        } catch(e2) { /* non-critical, just skip redirect */ }
      }
    } catch(e) {
      console.error('Upload error:', e);
      var tempCard = document.getElementById(tempId);
      if (tempCard) {
        tempCard.style.opacity = '1';
        tempCard.style.background = 'var(--error-bg)';
        tempCard.style.border = '1px solid var(--error-border)';
        tempCard.querySelector('.doc-card-icon').textContent = '⚠';
        tempCard.querySelector('.doc-card-meta').innerHTML = '<span style="color:var(--error)">Upload failed. Please try again.</span>';
      }
    }
  }
  input.value = '';
  // Refresh from server
  loadDocumentsPage();
}

async function deleteDocument(uploadId, filePath) {
  var confirmed = await confirmModal('This document and its extracted data will be permanently deleted.', { title: 'Delete Document', confirmText: 'Delete', danger: true });
  if (!confirmed) return;
  try {
    // Delete file from storage bucket
    if (filePath) {
      await fetch(SUPABASE_URL + '/storage/v1/object/' + DOC_BUCKET + '/' + filePath, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer ' + getToken(),
          'apikey': SUPABASE_ANON_KEY
        }
      });
    }
    // Delete row from uploads table
    await supabaseRequest(
      '/rest/v1/uploads?id=eq.' + uploadId,
      'DELETE', null, getToken()
    );
    // Refresh the documents list
    loadDocumentsPage();
  } catch(e) {
    console.error('Delete document error:', e);
    confirmModal('Failed to delete document. Please try again.', { title: 'Error', confirmText: 'OK', cancelText: '' });
  }
}

// ── FAMILY HISTORY ──
var familyHistory = {};

var conditions = [
  'Heart disease', 'High blood pressure', 'High cholesterol', 'Stroke',
  'Type 2 Diabetes', 'Type 1 Diabetes',
  'Cancer — Breast', 'Cancer — Colon', 'Cancer — Lung', 'Cancer — Prostate', 'Cancer — Other',
  'Alzheimer\'s / Dementia', 'Parkinson\'s disease',
  'Asthma', 'COPD / Emphysema',
  'Depression', 'Bipolar disorder', 'Schizophrenia', 'Anxiety disorder', 'Substance abuse / Alcoholism',
  'Autoimmune disorder (Lupus, RA, MS)',
  'Thyroid disorders', 'Osteoporosis', 'Arthritis',
  'Kidney disease', 'Liver disease',
  'Sickle cell disease', 'Blood clotting disorder',
  'Epilepsy / Seizure disorder',
  'Obesity', 'Eating disorder',
  'Glaucoma', 'Macular degeneration',
  'Congenital heart defect', 'Sudden cardiac death'
];
var members = ['Parent', 'Sibling', 'Grandparent'];

function loadFamilyHistoryForm() {
  var form = document.getElementById('fh-form');
  form.innerHTML = conditions.map(function(cond) {
    return '<div class="fh-item">'
      + '<div class="fh-condition">' + cond + '</div>'
      + '<div class="fh-members">'
      + members.map(function(m) {
          return '<div class="fh-tag" data-cond="' + cond + '" data-member="' + m + '" onclick="toggleFH(this)">' + m + '</div>';
        }).join('')
      + '</div></div>';
  }).join('');

  // Restore saved family history from profile
  try {
    var saved = window.userProfileData && window.userProfileData.family_history;
    if (saved) {
      var parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
      familyHistory = parsed || {};
      Object.keys(familyHistory).forEach(function(cond) {
        (familyHistory[cond] || []).forEach(function(member) {
          var tag = form.querySelector('[data-cond="' + cond + '"][data-member="' + member + '"]');
          if (tag) tag.classList.add('active');
        });
      });
    }
  } catch(e) { console.warn('[Healix] Could not restore family history:', e); }
}

function toggleFH(el) {
  el.classList.toggle('active');
  var cond = el.getAttribute('data-cond');
  var member = el.getAttribute('data-member');
  if (!familyHistory[cond]) familyHistory[cond] = [];
  var idx = familyHistory[cond].indexOf(member);
  if (idx > -1) familyHistory[cond].splice(idx, 1);
  else familyHistory[cond].push(member);
}

async function saveFamilyHistory() {
  if (!currentUser) return;
  try {
    await supabaseRequest('/rest/v1/profiles?auth_user_id=eq.' + currentUser.id, 'PATCH', {
      family_history: JSON.stringify(familyHistory)
    }, getToken());
    alert('Family history saved.');
  } catch(e) { alert('Could not save family history: ' + e.message); console.error(e); }
}

var profileHeightUnit = 'imperial'; // 'imperial' or 'metric'
var profileWeightUnit = 'lbs';      // 'lbs' or 'kg'
var PROFILE_GOAL_OPTIONS = [
  { val: 'lose_weight', label: 'Lose weight' },
  { val: 'gain_strength', label: 'Gain strength' },
  { val: 'sleep_better', label: 'Sleep better' },
  { val: 'feel_better', label: 'Feel better' }
];
var profileSelectedGoals = [];

function renderProfileGoalPills(goalStr) {
  profileSelectedGoals = goalStr ? goalStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  var el = document.getElementById('p-goals');
  if (!el) return;
  el.innerHTML = PROFILE_GOAL_OPTIONS.map(function(g) {
    var sel = profileSelectedGoals.indexOf(g.val) !== -1 ? ' selected' : '';
    return '<div class="goal-pill' + sel + '" onclick="toggleProfileGoal(\'' + g.val + '\')">' + g.label + '</div>';
  }).join('');
}

function toggleProfileGoal(val) {
  var idx = profileSelectedGoals.indexOf(val);
  if (idx === -1) { profileSelectedGoals.push(val); } else { profileSelectedGoals.splice(idx, 1); }
  renderProfileGoalPills(profileSelectedGoals.join(', '));
}

function populateProfileForm(profile) {
  var fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
  if (fullName) document.getElementById('p-name').value = fullName;
  if (profile.birth_date) document.getElementById('p-dob').value = profile.birth_date;
  if (profile.gender) document.getElementById('p-sex').value = profile.gender;
  renderProfileGoalPills(profile.primary_goal || '');
  // Restore unit preferences from localStorage
  var savedHeightUnit = localStorage.getItem('healix_height_unit_' + currentUser.id);
  var savedWeightUnit = localStorage.getItem('healix_weight_unit_' + currentUser.id);
  if (savedHeightUnit) toggleHeightUnit(savedHeightUnit);
  if (savedWeightUnit) toggleWeightUnit(savedWeightUnit);

  // Height: stored as cm, display in user's preferred unit
  if (profile.height_cm) {
    if (profileHeightUnit === 'metric') {
      document.getElementById('p-height').value = Math.round(profile.height_cm);
    } else {
      var totalInches = profile.height_cm / 2.54;
      var feet = Math.floor(totalInches / 12);
      var inches = Math.round(totalInches % 12);
      document.getElementById('p-height').value = feet + "'" + inches + '"';
    }
  }
  // Weight: stored as kg, display in user's preferred unit
  if (profile.current_weight_kg) {
    if (profileWeightUnit === 'kg') {
      document.getElementById('p-weight').value = Math.round(profile.current_weight_kg * 10) / 10;
    } else {
      document.getElementById('p-weight').value = Math.round(profile.current_weight_kg * 2.205);
    }
  }
  // Body & Vitals fields
  if (profile.systolic_bp) document.getElementById('p-systolic').value = profile.systolic_bp;
  if (profile.diastolic_bp) document.getElementById('p-diastolic').value = profile.diastolic_bp;
  if (profile.target_weight_kg) document.getElementById('p-target-weight').value = Math.round(profile.target_weight_kg * 2.205);
  if (profile.body_fat_percentage) document.getElementById('p-bodyfat').value = profile.body_fat_percentage;
  if (profile.lean_body_mass_kg) document.getElementById('p-lbm').value = Math.round(profile.lean_body_mass_kg * 2.205);
  if (profile.waist_circumference_cm) document.getElementById('p-waist').value = Math.round(profile.waist_circumference_cm / 2.54 * 10) / 10;
  if (profile.fitness_level) document.getElementById('p-fitness-level').value = profile.fitness_level;
  if (profile.activity_level) document.getElementById('p-activity-level').value = profile.activity_level;
  if (profile.custom_goal_description) document.getElementById('p-goal-desc').value = profile.custom_goal_description;
  // Compute BMI display
  if (profile.height_cm && profile.current_weight_kg) {
    var bmi = profile.current_weight_kg / Math.pow(profile.height_cm / 100, 2);
    document.getElementById('p-bmi').value = Math.round(bmi * 10) / 10;
  }

  // Load health conditions
  if (profile.health_conditions) {
    var conds = profile.health_conditions.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    conds.forEach(function(c) {
      // Fuzzy match: check if stored value starts with a preset name
      var matched = false;
      conditionPresets.forEach(function(p) {
        if (c.toLowerCase().indexOf(p.toLowerCase()) === 0 || p.toLowerCase().indexOf(c.toLowerCase()) === 0) {
          var preset = document.querySelector('#condition-presets [data-val="' + p + '"]');
          if (preset) { preset.classList.add('active'); medicalProfile.conditions.push(p); matched = true; }
        }
      });
      if (!matched) medicalProfile.conditions.push(c);
    });
    renderCustomTags('custom-condition-tags', medicalProfile.conditions.filter(function(c) {
      return conditionPresets.indexOf(c) === -1;
    }), 'condition');
  }
  // Load dietary restrictions / allergies
  if (profile.dietary_restrictions) {
    var allergies = profile.dietary_restrictions.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    allergies.forEach(function(a) {
      var matched = false;
      allergyPresets.forEach(function(p) {
        if (a.toLowerCase().indexOf(p.toLowerCase()) === 0 || p.toLowerCase().indexOf(a.toLowerCase()) === 0) {
          var preset = document.querySelector('#allergy-presets [data-val="' + p + '"]');
          if (preset) { preset.classList.add('active'); medicalProfile.allergies.push(p); matched = true; }
        }
      });
      if (!matched) medicalProfile.allergies.push(a);
    });
    renderCustomTags('custom-allergy-tags', medicalProfile.allergies.filter(function(a) {
      return allergyPresets.indexOf(a) === -1;
    }), 'allergy');
  }
}

// profileHeightUnit and profileWeightUnit moved before populateProfileForm

function toggleHeightUnit(unit) {
  var input = document.getElementById('p-height');
  if (!input) { profileHeightUnit = unit; return; }
  var oldUnit = profileHeightUnit;
  profileHeightUnit = unit;
  try { localStorage.setItem(currentUser ? 'healix_height_unit_' + currentUser.id : 'healix_height_unit', unit); } catch(e) {}
  // Update toggle buttons
  var toggle = document.getElementById('height-unit-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.unit-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-unit') === unit);
  });
  // Convert current value
  var currentVal = input.value.trim();
  if (currentVal && oldUnit !== unit) {
    var cm = parseHeight(currentVal, oldUnit);
    if (cm) {
      if (unit === 'metric') {
        input.value = Math.round(cm);
        input.placeholder = 'e.g. 180';
      } else {
        var totalInches = cm / 2.54;
        var feet = Math.floor(totalInches / 12);
        var inches = Math.round(totalInches % 12);
        input.value = feet + "'" + inches + '"';
        input.placeholder = 'e.g. 5\'11"';
      }
    }
  } else {
    input.placeholder = unit === 'metric' ? 'e.g. 180' : 'e.g. 5\'11"';
  }
}

function toggleWeightUnit(unit) {
  var input = document.getElementById('p-weight');
  if (!input) { profileWeightUnit = unit; return; }
  var oldUnit = profileWeightUnit;
  profileWeightUnit = unit;
  try { localStorage.setItem(currentUser ? 'healix_weight_unit_' + currentUser.id : 'healix_weight_unit', unit); } catch(e) {}
  // Update toggle buttons
  var toggle = document.getElementById('weight-unit-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.unit-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-unit') === unit);
  });
  // Convert current value
  var currentVal = input.value.trim();
  if (currentVal && oldUnit !== unit) {
    var kg = parseWeight(currentVal, oldUnit);
    if (kg) {
      if (unit === 'kg') {
        input.value = Math.round(kg * 10) / 10;
        input.placeholder = 'kg';
      } else {
        input.value = Math.round(kg * 2.205);
        input.placeholder = 'lbs';
      }
    }
  } else {
    input.placeholder = unit === 'kg' ? 'kg' : 'lbs';
  }
}

function parseHeight(val, unit) {
  // Parse height and return cm
  if (!val) return null;
  val = (val + '').trim();
  unit = unit || profileHeightUnit;
  if (unit === 'metric') {
    var num = parseFloat(val);
    return !isNaN(num) ? num : null;
  }
  // Imperial: try ft'in" formats
  var cmMatch = val.match(/(\d+)\s*cm/i);
  if (cmMatch) return parseFloat(cmMatch[1]);
  var ftInMatch = val.match(/(\d+)\s*[''′]\s*(\d+)/);
  if (ftInMatch) return (parseInt(ftInMatch[1]) * 12 + parseInt(ftInMatch[2])) * 2.54;
  var ftOnly = val.match(/^(\d+)\s*[''′]$/);
  if (ftOnly) return parseInt(ftOnly[1]) * 12 * 2.54;
  var num = parseFloat(val);
  if (!isNaN(num)) {
    if (num > 100) return num; // Already cm
    return num * 2.54; // Assume inches
  }
  return null;
}

function parseWeight(val, unit) {
  // Parse weight and return kg
  if (!val) return null;
  val = (val + '').trim();
  unit = unit || profileWeightUnit;
  if (unit === 'kg') {
    var num = parseFloat(val);
    return !isNaN(num) ? num : null;
  }
  // Imperial: assume lbs
  var kgMatch = val.match(/(\d+\.?\d*)\s*kg/i);
  if (kgMatch) return parseFloat(kgMatch[1]);
  var num = parseFloat(val);
  if (!isNaN(num)) return num / 2.205; // lbs to kg
  return null;
}

async function saveProfile() {
  if (!currentUser) return;
  var heightCm = parseHeight(document.getElementById('p-height').value);
  var weightKg = parseWeight(document.getElementById('p-weight').value);
  var nameParts = document.getElementById('p-name').value.trim().split(/\s+/);
  var firstName = nameParts[0] || '';
  var lastName = nameParts.slice(1).join(' ') || '';
  var dob = document.getElementById('p-dob').value;
  var sex = document.getElementById('p-sex').value;

  // Validate required fields
  var errors = [];
  if (!firstName) errors.push('Full Name is required');
  if (!dob) errors.push('Date of Birth is required');
  if (!sex) errors.push('Biological Sex is required');
  if (!heightCm || heightCm <= 0) errors.push('Height is required');
  if (!weightKg || weightKg <= 0) errors.push('Weight is required');

  var errEl = document.getElementById('profile-errors');
  if (errors.length > 0) {
    if (errEl) {
      errEl.textContent = errors.join('. ') + '.';
      errEl.style.display = 'block';
    }
    return;
  }
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  // Build data — only include fields that have values to avoid nullifying existing data
  var data = {
    first_name: firstName,
    last_name: lastName
  };
  data.primary_goal = profileSelectedGoals.length > 0 ? profileSelectedGoals.join(', ') : null;
  data.birth_date = dob;
  data.gender = sex;
  data.height_cm = heightCm;
  data.current_weight_kg = weightKg;

  // Also save medical profile (clearable)
  data.health_conditions = medicalProfile.conditions.length > 0 ? medicalProfile.conditions.join(', ') : null;
  data.dietary_restrictions = medicalProfile.allergies.length > 0 ? medicalProfile.allergies.join(', ') : null;

  console.log('[Healix] Saving profile:', JSON.stringify(data));
  var saveBtn = document.querySelector('.save-btn');
  if (saveBtn) { saveBtn.textContent = 'Saving...'; saveBtn.disabled = true; }

  try {
    // PATCH with return=representation so we can verify it actually updated
    var patchResult = await supabaseRequest('/rest/v1/profiles?auth_user_id=eq.' + currentUser.id, 'PATCH', data,
      getToken(), { 'Prefer': 'return=representation' });
    if (!patchResult || !Array.isArray(patchResult) || patchResult.length === 0) {
      console.error('[Healix] PATCH returned no rows — profile missing after onboarding');
      var errEl = document.getElementById('profile-error');
      if (errEl) { errEl.textContent = 'Profile not found. Please reload the page.'; errEl.style.display = 'block'; }
      if (saveBtn) { saveBtn.textContent = 'Save Changes'; saveBtn.disabled = false; }
      return;
    }
    window.userProfileData = patchResult[0];
    if (saveBtn) { saveBtn.textContent = 'Saved ✓'; setTimeout(function() { saveBtn.textContent = 'Save Changes'; saveBtn.disabled = false; }, 2000); }
    // Update sidebar name
    var profileName = [firstName, lastName].filter(Boolean).join(' ');
    if (profileName) {
      document.getElementById('sb-name').textContent = profileName;
      document.getElementById('sb-avatar').textContent = firstName.charAt(0).toUpperCase();
    }
  } catch(e) {
    console.error('[Healix] Profile save error:', e);
    if (saveBtn) { saveBtn.textContent = 'Save Changes'; saveBtn.disabled = false; }
    if (errEl) { errEl.textContent = 'Could not save profile. Please try again.'; errEl.style.display = 'block'; }
  }
}

async function saveBodyVitals() {
  if (!currentUser) return;
  var data = {};
  var sys = parseFloat(document.getElementById('p-systolic').value);
  var dia = parseFloat(document.getElementById('p-diastolic').value);
  if (sys > 0) data.systolic_bp = sys;
  if (dia > 0) data.diastolic_bp = dia;
  var tw = parseFloat(document.getElementById('p-target-weight').value);
  if (tw > 0) data.target_weight_kg = tw / 2.205;
  var bf = parseFloat(document.getElementById('p-bodyfat').value);
  if (bf > 0) data.body_fat_percentage = bf;
  var lbm = parseFloat(document.getElementById('p-lbm').value);
  if (lbm > 0) data.lean_body_mass_kg = lbm / 2.205;
  var waist = parseFloat(document.getElementById('p-waist').value);
  if (waist > 0) data.waist_circumference_cm = waist * 2.54;
  var fl = document.getElementById('p-fitness-level').value;
  if (fl) data.fitness_level = fl;
  var al = document.getElementById('p-activity-level').value;
  if (al) data.activity_level = al;
  var gd = document.getElementById('p-goal-desc').value.trim();
  if (gd) data.custom_goal_description = gd;

  if (Object.keys(data).length === 0) return;

  var saveBtn = document.querySelector('#page-profile .card:nth-child(2) .save-btn');
  if (saveBtn) { saveBtn.textContent = 'Saving...'; saveBtn.disabled = true; }
  try {
    var result = await supabaseRequest('/rest/v1/profiles?auth_user_id=eq.' + currentUser.id, 'PATCH', data, getToken(), { 'Prefer': 'return=representation' });
    if (result && Array.isArray(result) && result.length > 0) {
      window.userProfileData = result[0];
    }
    if (saveBtn) { saveBtn.textContent = 'Saved ✓'; setTimeout(function() { saveBtn.textContent = 'Save Body & Vitals'; saveBtn.disabled = false; }, 2000); }
  } catch(e) {
    console.error('[Healix] Body & Vitals save error:', e);
    if (saveBtn) { saveBtn.textContent = 'Save Body & Vitals'; saveBtn.disabled = false; }
  }
}

// ── MODALS ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function closeModalOutside(e, id) { if (e.target === document.getElementById(id)) closeModal(id); }
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (window.HealixChat && HealixChat.isOpen()) return;
    stopHealthBitePolling();
    document.querySelectorAll('.modal-overlay.open').forEach(function(m) { m.classList.remove('open'); });
  }
});

// ── HEALTHBITE CONNECT MODAL ──
function openConnectHealthBiteModal() {
  _hbConnected = !!window._healthSyncDetected || !!window._healthSamplesExist;
  renderConnectHealthBiteContent(_hbConnected ? 'connected' : 'not_detected');
  openModal('healthbite-connect-modal');
  if (!_hbConnected) startHealthBitePolling();
}

function closeConnectHealthBiteModal() {
  stopHealthBitePolling();
  closeModal('healthbite-connect-modal');
  if (_hbConnected) {
    loadDashboardData();
  }
}

function renderConnectHealthBiteContent(state) {
  var el = document.getElementById('hb-connect-content');
  if (!el) return;

  var step1Done = state === 'waiting' || state === 'connected';
  var step2Done = state === 'connected';
  var step3Done = state === 'connected';
  var step1Active = state === 'not_detected';
  var step3Active = state === 'waiting';

  var checkmark = '&#10003;';

  var html = '<div class="hb-connect-title">Connect <em>Healix App</em></div>'
    + '<div class="hb-connect-sub">The Healix app syncs Apple Health data from your iPhone and Apple Watch to Healix automatically.</div>'
    + '<div class="hb-steps">';

  // Step 1
  html += '<div class="hb-step' + (step1Done ? ' done' : '') + (step1Active ? ' active' : '') + '">'
    + '<div class="hb-step-indicator"><div class="hb-step-num">' + (step1Done ? checkmark : '1') + '</div><div class="hb-step-line"></div></div>'
    + '<div class="hb-step-content">'
    + '<div class="hb-step-label">Install Healix</div>'
    + '<div class="hb-step-desc">Search &ldquo;Healix&rdquo; in the App Store on your iPhone.</div>';
  if (step1Active) {
    html += '<div class="hb-step-actions">'
      + '<a href="' + HEALTHBITE_APP_URL + '" target="_blank" class="hb-btn-primary">Open App Store</a>'
      + '<button class="hb-text-link" onclick="renderConnectHealthBiteContent(\'waiting\')">I already have it</button>'
      + '</div>';
  }
  html += '</div></div>';

  // Step 2
  html += '<div class="hb-step' + (step2Done ? ' done' : '') + (step3Active ? ' active' : '') + '">'
    + '<div class="hb-step-indicator"><div class="hb-step-num">' + (step2Done ? checkmark : '2') + '</div><div class="hb-step-line"></div></div>'
    + '<div class="hb-step-content">'
    + '<div class="hb-step-label">Sign in &amp; allow Apple Health</div>'
    + '<div class="hb-step-desc">Use the same email and password you use for Healix. When prompted, grant Healix access to Apple Health.</div>'
    + '</div></div>';

  // Step 3
  html += '<div class="hb-step' + (step3Done ? ' done' : '') + (step3Active ? ' active' : '') + '">'
    + '<div class="hb-step-indicator"><div class="hb-step-num">' + (step3Done ? checkmark : '3') + '</div></div>'
    + '<div class="hb-step-content">'
    + '<div class="hb-step-label">Wait for sync</div>'
    + '<div class="hb-step-desc">The Healix app syncs your data automatically in the background. This usually takes under a minute.</div>'
    + '</div></div>';

  html += '</div>';

  // Status bar
  if (state === 'connected') {
    html += '<div class="hb-status connected">'
      + '<div class="hb-status-dot"></div>'
      + '<div class="hb-status-text">Connected — health data detected</div>'
      + '</div>'
      + '<button class="hb-btn-primary hb-done-btn" onclick="closeConnectHealthBiteModal()">DONE</button>';
  } else {
    html += '<div class="hb-status">'
      + '<div class="hb-status-dot"></div>'
      + '<div class="hb-status-text">Checking for Healix app&hellip;</div>'
      + '</div>';
  }

  el.innerHTML = html;
}

function startHealthBitePolling() {
  stopHealthBitePolling();
  _hbConnectPollInterval = setInterval(async function() {
    try {
      var session = getSession();
      if (!session || !session.access_token || !currentUser) { stopHealthBitePolling(); return; }
      var token = session.access_token;
      var syncLog = await supabaseRequest(
        '/rest/v1/health_sync_log?user_id=eq.' + currentUser.id
        + '&sync_status=eq.completed&order=sync_completed_at.desc&limit=1',
        'GET', null, token
      );
      if (syncLog && !syncLog.error && syncLog.length > 0) {
        _hbConnected = true;
        window._healthSyncDetected = true;
        stopHealthBitePolling();
        renderConnectHealthBiteContent('connected');
      }
    } catch(e) { console.error('[HealthBite Connect] poll error:', e); }
  }, 12000);
}

function stopHealthBitePolling() {
  if (_hbConnectPollInterval) {
    clearInterval(_hbConnectPollInterval);
    _hbConnectPollInterval = null;
  }
}

// ── MEDICAL PROFILE ──
var medicalProfile = { allergies: [], conditions: [], medications: [] };

var allergyPresets = ['Gluten','Dairy','Nuts','Peanuts','Shellfish','Eggs','Soy','Fish','Wheat','Sesame'];
var conditionPresets = ['Type 2 Diabetes','Hypertension','Asthma','Hypothyroidism','IBS','PCOS','Anxiety','Depression','Sleep Apnea','Arthritis'];

function loadMedicalProfileUI() {
  renderPresets('allergy-presets', allergyPresets, 'allergy');
  renderPresets('condition-presets', conditionPresets, 'condition');
}

function renderPresets(containerId, presets, type) {
  var el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = presets.map(function(p) {
    return '<div class="fh-tag" data-type="' + type + '" data-val="' + p + '" onclick="togglePreset(this)">' + p + '</div>';
  }).join('');
}

function togglePreset(el) {
  el.classList.toggle('active');
  var type = el.getAttribute('data-type');
  var val = el.getAttribute('data-val');
  var arr = type === 'allergy' ? medicalProfile.allergies : medicalProfile.conditions;
  var idx = arr.indexOf(val);
  if (idx > -1) arr.splice(idx, 1);
  else arr.push(val);
}

function addCustomTag(inputId, tagsId, type) {
  var input = document.getElementById(inputId);
  var val = input.value.trim();
  if (!val) return;
  var arr = type === 'allergy' ? medicalProfile.allergies : type === 'condition' ? medicalProfile.conditions : medicalProfile.medications;
  if (arr.indexOf(val) === -1) arr.push(val);
  renderCustomTags(tagsId, arr, type);
  input.value = '';
}

function renderCustomTags(containerId, arr, type) {
  var el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = arr.map(function(v, i) {
    return '<div style="display:flex;align-items:center;gap:6px;background:var(--gold-faint);border:1px solid var(--gold-border);padding:4px 10px">'
      + '<span style="font-size:11px;color:var(--cream-dim)">' + escapeHtml(v) + '</span>'
      + '<span style="font-size:10px;color:var(--muted);cursor:pointer" data-container="' + containerId + '" data-type="' + type + '" data-idx="' + i + '" onclick="removeTagByIdx(this)">✕</span>'
      + '</div>';
  }).join('');
}

function removeTagByIdx(el) {
  var containerId = el.getAttribute("data-container");
  var type = el.getAttribute("data-type");
  var idx = parseInt(el.getAttribute("data-idx"));
  var arr = type === "allergy" ? medicalProfile.allergies : type === "condition" ? medicalProfile.conditions : medicalProfile.medications;
  var val = arr[idx];
  arr.splice(idx, 1);
  renderCustomTags(containerId, arr, type);
  document.querySelectorAll("[data-val=\"" + val + "\"]").forEach(function(e) { e.classList.remove("active"); });
}

function removeTag(containerId, val, type) {
  var arr = type === 'allergy' ? medicalProfile.allergies : type === 'condition' ? medicalProfile.conditions : medicalProfile.medications;
  var idx = arr.indexOf(val);
  if (idx > -1) arr.splice(idx, 1);
  renderCustomTags(containerId, arr, type);
  // Also deactivate preset if it exists
  document.querySelectorAll('[data-val="' + val + '"]').forEach(function(el) { el.classList.remove('active'); });
}

async function saveMedicalProfile() {
  if (!currentUser) return;
  try {
    await supabaseRequest('/rest/v1/profiles?auth_user_id=eq.' + currentUser.id, 'PATCH', {
      health_conditions: medicalProfile.conditions.join(', '),
      dietary_restrictions: medicalProfile.allergies.join(', ')
    }, getToken());
    alert('Saved.');
  } catch(e) { alert('Could not save: ' + e.message); console.error(e); }
}

// ── FITNESS ASSESSMENT ──

// Published norm tables (NSCA / Cooper Institute / ACSM)
// Each entry: [threshold, percentile_label]
// Sorted best→worst for strength (higher=better), worst→best for time (lower=better)
var FITNESS_NORMS = {
  // Bench Press 1RM relative to bodyweight — male norms by age (NSCA)
  bench_1rm: {
    label: 'Bench Press', unit: 'lbs', higherBetter: true,
    hint: 'Load a weight you can lift 3-10 times. Go to failure — we calculate your estimated max.',
    norms: {
      male: {
        '18-29': [[1.76,99],[1.34,90],[1.19,80],[1.07,70],[0.99,60],[0.93,50],[0.86,40],[0.79,30],[0.72,20],[0.63,10]],
        '30-39': [[1.54,99],[1.19,90],[1.07,80],[0.99,70],[0.93,60],[0.88,50],[0.81,40],[0.75,30],[0.68,20],[0.60,10]],
        '40-49': [[1.35,99],[1.05,90],[0.96,80],[0.88,70],[0.81,60],[0.76,50],[0.70,40],[0.64,30],[0.58,20],[0.51,10]],
        '50-59': [[1.20,99],[0.93,90],[0.84,80],[0.77,70],[0.72,60],[0.68,50],[0.63,40],[0.57,30],[0.52,20],[0.46,10]],
        '60+':   [[1.10,99],[0.84,90],[0.77,80],[0.70,70],[0.65,60],[0.61,50],[0.57,40],[0.52,30],[0.46,20],[0.40,10]]
      },
      female: {
        '18-29': [[1.01,99],[0.80,90],[0.70,80],[0.63,70],[0.57,60],[0.53,50],[0.49,40],[0.44,30],[0.39,20],[0.33,10]],
        '30-39': [[0.82,99],[0.65,90],[0.58,80],[0.53,70],[0.49,60],[0.45,50],[0.41,40],[0.38,30],[0.34,20],[0.28,10]],
        '40-49': [[0.77,99],[0.61,90],[0.54,80],[0.50,70],[0.45,60],[0.42,50],[0.38,40],[0.35,30],[0.31,20],[0.25,10]],
        '50-59': [[0.68,99],[0.54,90],[0.48,80],[0.44,70],[0.40,60],[0.37,50],[0.33,40],[0.30,30],[0.27,20],[0.21,10]],
        '60+':   [[0.60,99],[0.47,90],[0.43,80],[0.39,70],[0.35,60],[0.33,50],[0.30,40],[0.27,30],[0.24,20],[0.19,10]]
      }
    },
    relativeToWeight: true
  },
  squat_1rm: {
    label: 'Squat', unit: 'lbs', higherBetter: true,
    hint: 'Load a weight you can squat 3-10 times. Go to failure — we estimate your max from that.',
    norms: {
      male: {
        '18-29': [[2.27,99],[1.91,90],[1.74,80],[1.59,70],[1.50,60],[1.42,50],[1.33,40],[1.24,30],[1.14,20],[0.97,10]],
        '30-39': [[2.07,99],[1.71,90],[1.57,80],[1.46,70],[1.38,60],[1.32,50],[1.24,40],[1.16,30],[1.06,20],[0.91,10]],
        '40-49': [[1.92,99],[1.57,90],[1.44,80],[1.35,70],[1.26,60],[1.20,50],[1.13,40],[1.06,30],[0.97,20],[0.83,10]],
        '50-59': [[1.75,99],[1.43,90],[1.32,80],[1.22,70],[1.15,60],[1.09,50],[1.02,40],[0.95,30],[0.87,20],[0.74,10]],
        '60+':   [[1.55,99],[1.26,90],[1.16,80],[1.07,70],[1.00,60],[0.94,50],[0.88,40],[0.82,30],[0.74,20],[0.63,10]]
      },
      female: {
        '18-29': [[1.71,99],[1.37,90],[1.24,80],[1.14,70],[1.06,60],[0.99,50],[0.93,40],[0.86,30],[0.76,20],[0.64,10]],
        '30-39': [[1.49,99],[1.21,90],[1.10,80],[1.01,70],[0.94,60],[0.88,50],[0.82,40],[0.75,30],[0.67,20],[0.55,10]],
        '40-49': [[1.37,99],[1.10,90],[1.00,80],[0.92,70],[0.86,60],[0.80,50],[0.74,40],[0.68,30],[0.60,20],[0.50,10]],
        '50-59': [[1.22,99],[0.98,90],[0.89,80],[0.82,70],[0.76,60],[0.71,50],[0.66,40],[0.61,30],[0.54,20],[0.44,10]],
        '60+':   [[1.07,99],[0.85,90],[0.77,80],[0.71,70],[0.66,60],[0.61,50],[0.57,40],[0.53,30],[0.47,20],[0.38,10]]
      }
    },
    relativeToWeight: true
  },
  deadlift_1rm: {
    label: 'Deadlift', unit: 'lbs', higherBetter: true,
    hint: 'Load a weight you can pull 3-10 times. Go to failure — we estimate your max from that.',
    norms: {
      male: {
        '18-29': [[2.96,99],[2.35,90],[2.11,80],[1.95,70],[1.83,60],[1.74,50],[1.64,40],[1.53,30],[1.41,20],[1.19,10]],
        '30-39': [[2.63,99],[2.09,90],[1.90,80],[1.76,70],[1.66,60],[1.58,50],[1.49,40],[1.40,30],[1.29,20],[1.09,10]],
        '40-49': [[2.33,99],[1.88,90],[1.72,80],[1.60,70],[1.51,60],[1.44,50],[1.36,40],[1.27,30],[1.17,20],[0.99,10]],
        '50-59': [[2.08,99],[1.69,90],[1.55,80],[1.44,70],[1.36,60],[1.29,50],[1.22,40],[1.14,30],[1.05,20],[0.88,10]],
        '60+':   [[1.83,99],[1.49,90],[1.37,80],[1.27,70],[1.19,60],[1.13,50],[1.06,40],[0.99,30],[0.91,20],[0.76,10]]
      },
      female: {
        '18-29': [[2.05,99],[1.63,90],[1.48,80],[1.37,70],[1.28,60],[1.21,50],[1.14,40],[1.06,30],[0.96,20],[0.81,10]],
        '30-39': [[1.83,99],[1.47,90],[1.34,80],[1.24,70],[1.16,60],[1.10,50],[1.03,40],[0.96,30],[0.87,20],[0.73,10]],
        '40-49': [[1.66,99],[1.34,90],[1.22,80],[1.13,70],[1.06,60],[1.00,50],[0.94,40],[0.88,30],[0.79,20],[0.67,10]],
        '50-59': [[1.48,99],[1.20,90],[1.09,80],[1.01,70],[0.95,60],[0.90,50],[0.84,40],[0.79,30],[0.71,20],[0.59,10]],
        '60+':   [[1.28,99],[1.04,90],[0.94,80],[0.87,70],[0.82,60],[0.77,50],[0.72,40],[0.67,30],[0.61,20],[0.51,10]]
      }
    },
    relativeToWeight: true
  },
  mile_time: {
    label: 'Mile Time', unit: 'min', higherBetter: false,
    hint: 'Run 1 mile at maximum effort on a track or flat surface.',
    norms: {
      male: {
        '18-29': [[5.5,99],[6.2,90],[6.8,80],[7.4,70],[8.0,60],[8.8,50],[9.6,40],[10.5,30],[12.0,20],[14.0,10]],
        '30-39': [[5.8,99],[6.6,90],[7.2,80],[7.9,70],[8.5,60],[9.3,50],[10.2,40],[11.2,30],[12.8,20],[15.0,10]],
        '40-49': [[6.2,99],[7.0,90],[7.7,80],[8.4,70],[9.1,60],[9.9,50],[10.9,40],[12.0,30],[13.7,20],[16.0,10]],
        '50-59': [[6.8,99],[7.7,90],[8.4,80],[9.2,70],[10.0,60],[10.9,50],[12.0,40],[13.2,30],[15.1,20],[17.5,10]],
        '60+':   [[7.5,99],[8.5,90],[9.3,80],[10.2,70],[11.1,60],[12.1,50],[13.3,40],[14.6,30],[16.7,20],[19.5,10]]
      },
      female: {
        '18-29': [[6.5,99],[7.5,90],[8.2,80],[9.0,70],[9.8,60],[10.8,50],[11.8,40],[13.0,30],[14.8,20],[17.0,10]],
        '30-39': [[6.9,99],[7.9,90],[8.7,80],[9.5,70],[10.4,60],[11.4,50],[12.5,40],[13.8,30],[15.7,20],[18.0,10]],
        '40-49': [[7.5,99],[8.5,90],[9.4,80],[10.3,70],[11.2,60],[12.3,50],[13.5,40],[14.9,30],[17.0,20],[19.5,10]],
        '50-59': [[8.2,99],[9.3,90],[10.3,80],[11.3,70],[12.3,60],[13.5,50],[14.8,40],[16.3,30],[18.6,20],[21.4,10]],
        '60+':   [[9.2,99],[10.4,90],[11.5,80],[12.6,70],[13.8,60],[15.2,50],[16.7,40],[18.4,30],[21.0,20],[24.2,10]]
      }
    }
  },
  vo2max: {
    label: 'VO2 Max', unit: 'ml/kg/min', higherBetter: true,
    hint: 'Use the calculator below to estimate from an at-home test, or enter a value from Apple Watch, Garmin, or a lab test.',
    norms: {
      male: {
        '18-29': [[60,99],[52,90],[48,80],[45,70],[43,60],[41,50],[39,40],[37,30],[34,20],[29,10]],
        '30-39': [[57,99],[50,90],[46,80],[43,70],[41,60],[39,50],[37,40],[35,30],[32,20],[28,10]],
        '40-49': [[53,99],[46,90],[42,80],[40,70],[38,60],[36,50],[34,40],[32,30],[30,20],[26,10]],
        '50-59': [[49,99],[43,90],[39,80],[36,70],[34,60],[33,50],[31,40],[29,30],[27,20],[23,10]],
        '60+':   [[45,99],[39,90],[35,80],[32,70],[31,60],[29,50],[28,40],[26,30],[24,20],[20,10]]
      },
      female: {
        '18-29': [[54,99],[47,90],[43,80],[40,70],[38,60],[36,50],[34,40],[31,30],[28,20],[24,10]],
        '30-39': [[51,99],[44,90],[40,80],[37,70],[35,60],[33,50],[31,40],[29,30],[26,20],[22,10]],
        '40-49': [[47,99],[40,90],[36,80],[34,70],[32,60],[30,50],[28,40],[26,30],[24,20],[20,10]],
        '50-59': [[42,99],[36,90],[32,80],[30,70],[28,60],[27,50],[25,40],[23,30],[21,20],[17,10]],
        '60+':   [[38,99],[33,90],[29,80],[27,70],[25,60],[24,50],[22,40],[21,30],[19,20],[15,10]]
      }
    }
  },
  toe_touch: {
    label: 'Toe Touch', unit: '/5', higherBetter: true, selfRated: true,
    hint: 'Stand with feet together and bend forward to touch your toes. Keep your knees straight.',
    scaleLabels: ['Can\'t reach past knees', 'Fingertips reach mid-shin', 'Fingertips reach ankles', 'Fingertips touch toes', 'Palms flat on the floor'],
    norms: {
      male: {
        '18-29': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '30-39': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '40-49': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '50-59': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '60+':   [[5,95],[4,75],[3,50],[2,25],[1,5]]
      },
      female: {
        '18-29': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '30-39': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '40-49': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '50-59': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '60+':   [[5,95],[4,75],[3,50],[2,25],[1,5]]
      }
    }
  },
  shoulder_reach: {
    label: 'Shoulder Reach', unit: '/5', higherBetter: true, selfRated: true,
    hint: 'Reach one hand over your shoulder and the other behind your lower back. Try to touch your fingers together. Test both sides, rate your better side.',
    scaleLabels: ['Hands are more than a fist apart', 'Hands within a fist-width', 'Fingertips just touching', 'Fingers overlap slightly', 'Hands clasp easily'],
    norms: {
      male: {
        '18-29': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '30-39': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '40-49': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '50-59': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '60+':   [[5,95],[4,75],[3,50],[2,25],[1,5]]
      },
      female: {
        '18-29': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '30-39': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '40-49': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '50-59': [[5,95],[4,75],[3,50],[2,25],[1,5]],
        '60+':   [[5,95],[4,75],[3,50],[2,25],[1,5]]
      }
    }
  },
  pushup: {
    label: 'Push-up Test', unit: 'reps', higherBetter: true,
    hint: 'Max push-ups to failure with good form. No rest at the top.',
    amrap: false,
    norms: {
      male: {
        '18-29': [[56,99],[47,90],[41,80],[36,70],[32,60],[29,50],[25,40],[21,30],[16,20],[10,10]],
        '30-39': [[47,99],[39,90],[34,80],[30,70],[27,60],[24,50],[21,40],[17,30],[13,20],[8,10]],
        '40-49': [[38,99],[31,90],[27,80],[23,70],[20,60],[18,50],[16,40],[13,30],[9,20],[5,10]],
        '50-59': [[30,99],[25,90],[21,80],[18,70],[15,60],[13,50],[11,40],[9,30],[6,20],[3,10]],
        '60+':   [[24,99],[19,90],[16,80],[13,70],[11,60],[10,50],[8,40],[6,30],[4,20],[2,10]]
      },
      female: {
        '18-29': [[35,99],[30,90],[26,80],[23,70],[20,60],[17,50],[14,40],[11,30],[8,20],[4,10]],
        '30-39': [[29,99],[24,90],[21,80],[18,70],[15,60],[13,50],[10,40],[8,30],[5,20],[2,10]],
        '40-49': [[24,99],[19,90],[16,80],[13,70],[11,60],[9,50],[7,40],[5,30],[3,20],[1,10]],
        '50-59': [[20,99],[15,90],[13,80],[10,70],[8,60],[7,50],[5,40],[3,30],[2,20],[1,10]],
        '60+':   [[17,99],[12,90],[10,80],[8,70],[6,60],[5,50],[3,40],[2,30],[1,20],[0,10]]
      }
    }
  },
  pullup: {
    label: 'Pull-up Test', unit: 'reps', higherBetter: true,
    hint: 'Dead hang, chin over bar. Max reps to failure. Use bodyweight only.',
    amrap: false,
    norms: {
      male: {
        '18-29': [[22,99],[16,90],[13,80],[11,70],[9,60],[8,50],[6,40],[4,30],[2,20],[1,10]],
        '30-39': [[20,99],[14,90],[11,80],[9,70],[8,60],[6,50],[5,40],[3,30],[2,20],[1,10]],
        '40-49': [[16,99],[11,90],[9,80],[7,70],[6,60],[5,50],[4,40],[2,30],[1,20],[0,10]],
        '50-59': [[12,99],[8,90],[6,80],[5,70],[4,60],[3,50],[2,40],[1,30],[0,20],[0,10]],
        '60+':   [[8,99],[5,90],[4,80],[3,70],[2,60],[2,50],[1,40],[0,30],[0,20],[0,10]]
      },
      female: {
        '18-29': [[9,99],[6,90],[5,80],[4,70],[3,60],[2,50],[1,40],[1,30],[0,20],[0,10]],
        '30-39': [[7,99],[5,90],[4,80],[3,70],[2,60],[2,50],[1,40],[0,30],[0,20],[0,10]],
        '40-49': [[6,99],[4,90],[3,80],[2,70],[2,60],[1,50],[1,40],[0,30],[0,20],[0,10]],
        '50-59': [[4,99],[3,90],[2,80],[1,70],[1,60],[1,50],[0,40],[0,30],[0,20],[0,10]],
        '60+':   [[3,99],[2,90],[1,80],[1,70],[0,60],[0,50],[0,40],[0,30],[0,20],[0,10]]
      }
    }
  },
  grip_strength: {
    label: 'Grip Strength', unit: 'kg', higherBetter: true,
    hint: 'Dominant hand, using a hand dynamometer. Squeeze maximally for 3 seconds. Best of 3 attempts.',
    norms: {
      male: {
        '18-29': [[65,99],[57,90],[52,80],[48,70],[45,60],[43,50],[40,40],[37,30],[33,20],[28,10]],
        '30-39': [[63,99],[56,90],[51,80],[47,70],[44,60],[42,50],[39,40],[36,30],[32,20],[27,10]],
        '40-49': [[59,99],[52,90],[47,80],[44,70],[41,60],[39,50],[36,40],[33,30],[29,20],[24,10]],
        '50-59': [[55,99],[48,90],[43,80],[40,70],[37,60],[35,50],[32,40],[29,30],[26,20],[21,10]],
        '60+':   [[49,99],[42,90],[38,80],[35,70],[32,60],[30,50],[28,40],[25,30],[22,20],[17,10]]
      },
      female: {
        '18-29': [[40,99],[35,90],[31,80],[28,70],[26,60],[24,50],[22,40],[20,30],[17,20],[13,10]],
        '30-39': [[39,99],[34,90],[30,80],[27,70],[25,60],[23,50],[21,40],[19,30],[16,20],[12,10]],
        '40-49': [[36,99],[31,90],[28,80],[25,70],[23,60],[21,50],[19,40],[17,30],[14,20],[11,10]],
        '50-59': [[33,99],[28,90],[25,80],[22,70],[20,60],[19,50],[17,40],[15,30],[13,20],[9,10]],
        '60+':   [[29,99],[25,90],[22,80],[19,70],[17,60],[16,50],[14,40],[12,30],[10,20],[7,10]]
      }
    }
  },
  chair_stand: {
    label: '30-sec Chair Stand', unit: 'reps', higherBetter: true,
    hint: 'Sit in a chair, arms crossed. Stand fully then sit. Count reps in 30 seconds.',
    norms: {
      male: {
        '18-29': [[25,99],[22,90],[20,80],[18,70],[17,60],[16,50],[14,40],[13,30],[11,20],[9,10]],
        '30-39': [[24,99],[21,90],[19,80],[17,70],[16,60],[15,50],[13,40],[12,30],[10,20],[8,10]],
        '40-49': [[22,99],[19,90],[17,80],[16,70],[14,60],[13,50],[12,40],[10,30],[9,20],[7,10]],
        '50-59': [[19,99],[17,90],[15,80],[14,70],[12,60],[12,50],[10,40],[9,30],[7,20],[5,10]],
        '60+':   [[17,99],[15,90],[14,80],[12,70],[11,60],[10,50],[9,40],[7,30],[6,20],[4,10]]
      },
      female: {
        '18-29': [[23,99],[20,90],[18,80],[17,70],[15,60],[14,50],[13,40],[11,30],[10,20],[8,10]],
        '30-39': [[22,99],[19,90],[17,80],[16,70],[14,60],[13,50],[12,40],[10,30],[9,20],[7,10]],
        '40-49': [[20,99],[18,90],[16,80],[14,70],[13,60],[12,50],[11,40],[9,30],[8,20],[6,10]],
        '50-59': [[18,99],[16,90],[14,80],[13,70],[11,60],[11,50],[9,40],[8,30],[6,20],[5,10]],
        '60+':   [[16,99],[14,90],[13,80],[11,70],[10,60],[9,50],[8,40],[6,30],[5,20],[3,10]]
      }
    }
  },
  balance: {
    label: 'Single-leg Balance', unit: 'sec', higherBetter: true,
    hint: 'Stand on one foot with your eyes closed and start a timer. Stop when your other foot touches down or you open your eyes. Do 2 attempts on each leg and enter your best time in seconds.',
    norms: {
      male: {
        '18-29': [[45,99],[35,90],[28,80],[22,70],[17,60],[13,50],[9,40],[6,30],[3,20],[1,10]],
        '30-39': [[40,99],[30,90],[24,80],[18,70],[14,60],[10,50],[7,40],[4,30],[2,20],[1,10]],
        '40-49': [[30,99],[22,90],[17,80],[13,70],[9,60],[7,50],[4,40],[3,30],[1,20],[0,10]],
        '50-59': [[20,99],[14,90],[10,80],[7,70],[5,60],[3,50],[2,40],[1,30],[0,20],[0,10]],
        '60+':   [[12,99],[8,90],[5,80],[3,70],[2,60],[1,50],[1,40],[0,30],[0,20],[0,10]]
      },
      female: {
        '18-29': [[43,99],[33,90],[26,80],[20,70],[15,60],[11,50],[8,40],[5,30],[2,20],[1,10]],
        '30-39': [[37,99],[28,90],[21,80],[16,70],[12,60],[8,50],[5,40],[3,30],[1,20],[0,10]],
        '40-49': [[28,99],[20,90],[15,80],[11,70],[7,60],[5,50],[3,40],[2,30],[1,20],[0,10]],
        '50-59': [[18,99],[12,90],[8,80],[5,70],[3,60],[2,50],[1,40],[0,30],[0,20],[0,10]],
        '60+':   [[10,99],[6,90],[4,80],[2,70],[1,60],[1,50],[0,40],[0,30],[0,20],[0,10]]
      }
    }
  },
  walk_6min: {
    label: '6-Minute Walk', unit: 'm', higherBetter: true,
    hint: 'Walk as far as possible in 6 minutes on a flat surface. Measure distance in metres.',
    norms: {
      male: {
        '18-29': [[780,99],[720,90],[685,80],[655,70],[630,60],[608,50],[583,40],[554,30],[516,20],[460,10]],
        '30-39': [[760,99],[700,90],[665,80],[635,70],[610,60],[588,50],[563,40],[534,30],[496,20],[440,10]],
        '40-49': [[730,99],[670,90],[635,80],[605,70],[580,60],[558,50],[533,40],[504,30],[466,20],[410,10]],
        '50-59': [[690,99],[630,90],[595,80],[565,70],[540,60],[518,50],[493,40],[464,30],[426,20],[370,10]],
        '60+':   [[630,99],[570,90],[535,80],[505,70],[480,60],[458,50],[433,40],[404,30],[366,20],[310,10]]
      },
      female: {
        '18-29': [[740,99],[680,90],[645,80],[615,70],[590,60],[568,50],[543,40],[514,30],[476,20],[420,10]],
        '30-39': [[720,99],[660,90],[625,80],[595,70],[570,60],[548,50],[523,40],[494,30],[456,20],[400,10]],
        '40-49': [[695,99],[635,90],[600,80],[570,70],[545,60],[523,50],[498,40],[469,30],[431,20],[375,10]],
        '50-59': [[655,99],[595,90],[560,80],[530,70],[505,60],[483,50],[458,40],[429,30],[391,20],[335,10]],
        '60+':   [[595,99],[535,90],[500,80],[470,70],[445,60],[423,50],[398,40],[369,30],[331,20],[275,10]]
      }
    }
  },
  dead_hang: {
    label: 'Dead Hang', unit: 'sec', higherBetter: true,
    hint: 'Hang from a pull-up bar with an overhand grip, arms fully extended, feet off the ground. Time until you let go. Tests grip endurance and shoulder health under your own bodyweight.',
    norms: {
      male: {
        '18-29': [[120,99],[90,90],[75,80],[62,70],[52,60],[44,50],[36,40],[28,30],[18,20],[8,10]],
        '30-39': [[110,99],[82,90],[68,80],[57,70],[48,60],[40,50],[33,40],[25,30],[16,20],[7,10]],
        '40-49': [[95,99],[72,90],[60,80],[50,70],[42,60],[35,50],[28,40],[22,30],[14,20],[6,10]],
        '50-59': [[80,99],[60,90],[50,80],[42,70],[35,60],[29,50],[23,40],[18,30],[11,20],[5,10]],
        '60+':   [[65,99],[48,90],[40,80],[33,70],[28,60],[23,50],[18,40],[14,30],[8,20],[3,10]]
      },
      female: {
        '18-29': [[90,99],[68,90],[56,80],[47,70],[39,60],[33,50],[27,40],[20,30],[13,20],[6,10]],
        '30-39': [[80,99],[60,90],[50,80],[42,70],[35,60],[29,50],[23,40],[17,30],[11,20],[5,10]],
        '40-49': [[68,99],[51,90],[42,80],[35,70],[29,60],[24,50],[19,40],[14,30],[9,20],[4,10]],
        '50-59': [[55,99],[41,90],[34,80],[28,70],[23,60],[19,50],[15,40],[11,30],[7,20],[3,10]],
        '60+':   [[42,99],[32,90],[26,80],[22,70],[18,60],[15,50],[12,40],[8,30],[5,20],[2,10]]
      }
    }
  },
  farmers_walk: {
    label: 'Farmers Walk', unit: 'm', higherBetter: true,
    hint: 'Carry heavy weights in each hand — target 50% of your bodyweight per hand. Walk as far as possible without setting them down.',
    relativeToWeight: false,
    norms: {
      male: {
        '18-29': [[120,99],[95,90],[80,80],[70,70],[60,60],[52,50],[44,40],[36,30],[26,20],[15,10]],
        '30-39': [[110,99],[88,90],[75,80],[65,70],[56,60],[48,50],[40,40],[33,30],[24,20],[14,10]],
        '40-49': [[100,99],[80,90],[68,80],[58,70],[50,60],[43,50],[36,40],[29,30],[21,20],[12,10]],
        '50-59': [[85,99],[68,90],[58,80],[50,70],[43,60],[37,50],[31,40],[25,30],[18,20],[10,10]],
        '60+':   [[70,99],[56,90],[47,80],[40,70],[34,60],[29,50],[24,40],[19,30],[13,20],[7,10]]
      },
      female: {
        '18-29': [[95,99],[76,90],[64,80],[55,70],[47,60],[40,50],[34,40],[27,30],[19,20],[10,10]],
        '30-39': [[85,99],[68,90],[58,80],[50,70],[43,60],[36,50],[30,40],[24,30],[17,20],[9,10]],
        '40-49': [[75,99],[60,90],[51,80],[44,70],[37,60],[32,50],[26,40],[21,30],[15,20],[8,10]],
        '50-59': [[63,99],[50,90],[42,80],[36,70],[31,60],[26,50],[22,40],[17,30],[12,20],[6,10]],
        '60+':   [[50,99],[40,90],[34,80],[29,70],[24,60],[20,50],[16,40],[13,30],[9,20],[4,10]]
      }
    }
  },
  plank: {
    label: 'Plank', unit: 'sec', higherBetter: true,
    hint: 'Hold a forearm plank with hips level and core braced. Time stops when form breaks or knees touch down.',
    norms: {
      male: {
        '18-29': [[240,99],[180,90],[150,80],[120,70],[100,60],[80,50],[65,40],[50,30],[35,20],[20,10]],
        '30-39': [[210,99],[160,90],[130,80],[105,70],[90,60],[72,50],[58,40],[45,30],[30,20],[18,10]],
        '40-49': [[180,99],[135,90],[110,80],[90,70],[75,60],[60,50],[48,40],[37,30],[25,20],[15,10]],
        '50-59': [[150,99],[110,90],[90,80],[73,70],[60,60],[48,50],[38,40],[29,30],[20,20],[12,10]],
        '60+':   [[120,99],[85,90],[70,80],[56,70],[45,60],[36,50],[28,40],[21,30],[14,20],[8,10]]
      },
      female: {
        '18-29': [[210,99],[160,90],[130,80],[105,70],[85,60],[68,50],[55,40],[42,30],[28,20],[15,10]],
        '30-39': [[180,99],[138,90],[112,80],[90,70],[73,60],[58,50],[47,40],[36,30],[24,20],[13,10]],
        '40-49': [[150,99],[115,90],[93,80],[75,70],[60,60],[48,50],[38,40],[29,30],[20,20],[11,10]],
        '50-59': [[120,99],[90,90],[73,80],[58,70],[47,60],[37,50],[30,40],[22,30],[15,20],[8,10]],
        '60+':   [[90,99],[65,90],[52,80],[42,70],[33,60],[26,50],[20,40],[15,30],[10,20],[5,10]]
      }
    }
  }
};

var FITNESS_CATEGORIES = [
  { key: 'strength',    label: 'Strength',    tests: ['bench_1rm','squat_1rm','deadlift_1rm','pushup','pullup'] },
  { key: 'cardio',      label: 'Cardio',      tests: ['mile_time','vo2max','walk_6min'] },
  { key: 'functional',  label: 'Functional',  tests: ['grip_strength','dead_hang','farmers_walk','plank','chair_stand','balance'] },
  { key: 'flexibility', label: 'Flexibility', tests: ['toe_touch','shoulder_reach'] }
];

// Recommendation engine — returns ordered list of test keys for this user
function getRecommendedTests(profile, byKey) {
  var age = profile.age;
  var goal = ((window.userProfileData || {}).primary_goal || '').toLowerCase();
  var scored = [];

  Object.keys(FITNESS_NORMS).forEach(function(key) {
    var score = 0;
    var history = byKey[key] || [];
    var latest = history[0];
    var daysSince = latest ? (Date.now() - new Date(latest.tested_at)) / 86400000 : 999;

    // Staleness — not tested in 60+ days gets priority
    if (daysSince > 90) score += 30;
    else if (daysSince > 60) score += 15;
    else if (daysSince < 14) score -= 20; // recently done, deprioritise

    // Never tested
    if (!latest) score += 25;

    // Age suitability
    if (age >= 60) {
      if (['chair_stand','balance','walk_6min','grip_strength','plank','toe_touch'].includes(key)) score += 30;
      if (['bench_1rm','squat_1rm','deadlift_1rm'].includes(key)) score -= 15;
    } else if (age >= 50) {
      if (['chair_stand','balance','grip_strength','walk_6min','plank'].includes(key)) score += 20;
      if (['bench_1rm','squat_1rm','deadlift_1rm'].includes(key)) score -= 5;
    } else if (age < 35) {
      if (['bench_1rm','squat_1rm','deadlift_1rm','pullup','vo2max'].includes(key)) score += 15;
    }

    // Goal alignment
    if (goal.includes('weight') || goal.includes('fat')) {
      if (['walk_6min','mile_time','vo2max','chair_stand'].includes(key)) score += 20;
    }
    if (goal.includes('muscle') || goal.includes('strength')) {
      if (['bench_1rm','squat_1rm','deadlift_1rm','pushup','pullup','grip_strength','dead_hang','farmers_walk','plank'].includes(key)) score += 20;
    }
    if (goal.includes('longevity') || goal.includes('health')) {
      if (['grip_strength','dead_hang','balance','vo2max','chair_stand','plank','toe_touch'].includes(key)) score += 20;
    }

    // Low percentile = needs attention
    if (latest && latest.percentile && latest.percentile < 30) score += 20;

    scored.push({ key: key, score: score });
  });

  return scored.sort(function(a,b){ return b.score - a.score; }).slice(0,6).map(function(x){ return x.key; });
}

function getUserProfile() {
  var p = window.userProfileData || {};
  var age = 35;
  var dobStr = p.birth_date || p.dob;
  if (dobStr) { var d = new Date(dobStr); if (!isNaN(d)) age = Math.floor((Date.now()-d)/(365.25*24*3600*1000)); }
  var sex = (p.gender || p.sex || 'male').toLowerCase().includes('f') ? 'female' : 'male';
  var weightKg = p.current_weight_kg || 80;
  var weightLbs = weightKg * 2.205;
  return { age: age, sex: sex, weightLbs: weightLbs };
}

function getAgeGroup(age) {
  if (age < 30) return '18-29';
  if (age < 40) return '30-39';
  if (age < 50) return '40-49';
  if (age < 60) return '50-59';
  return '60+';
}

function calcPercentile(testKey, rawValue, profile) {
  var norm = FITNESS_NORMS[testKey];
  if (!norm) return null;
  var ag = getAgeGroup(profile.age);
  var table = norm.norms[profile.sex][ag];
  var val = norm.relativeToWeight ? rawValue / profile.weightLbs : rawValue;
  if (norm.higherBetter) {
    for (var i = 0; i < table.length; i++) {
      if (val >= table[i][0]) return table[i][1];
    }
    return 1;
  } else {
    for (var i = 0; i < table.length; i++) {
      if (val <= table[i][0]) return table[i][1];
    }
    return 1;
  }
}

function percentileLabel(p) {
  if (p >= 90) return { text: 'Elite', cls: 'pct-elite' };
  if (p >= 70) return { text: 'Good', cls: 'pct-good' };
  if (p >= 40) return { text: 'Average', cls: 'pct-avg' };
  if (p >= 20) return { text: 'Below avg', cls: 'pct-low' };
  return { text: 'Poor', cls: 'pct-poor' };
}

var AMRAP_TESTS = ['bench_1rm','squat_1rm','deadlift_1rm'];
var REPS_ONLY_TESTS = ['pushup','pullup'];

function epley1RM(weight, reps) {
  // Epley formula: 1RM = weight × (1 + reps/30)
  return Math.round(weight * (1 + reps / 30));
}

function selectVO2Method(method) {
  var rockport = document.getElementById('vo2-rockport');
  var cooper = document.getElementById('vo2-cooper');
  var btnR = document.getElementById('vo2-pick-rockport');
  var btnC = document.getElementById('vo2-pick-cooper');
  if (method === 'cooper') {
    rockport.style.display = 'none';
    cooper.style.display = 'block';
    btnR.style.background = 'transparent';
    btnR.style.borderColor = 'var(--gold-border)';
    btnC.style.background = 'var(--gold-faint)';
    btnC.style.borderColor = 'var(--gold)';
  } else {
    rockport.style.display = 'block';
    cooper.style.display = 'none';
    btnR.style.background = 'var(--gold-faint)';
    btnR.style.borderColor = 'var(--gold)';
    btnC.style.background = 'transparent';
    btnC.style.borderColor = 'var(--gold-border)';
  }
}

function calcVO2() {
  var w = parseFloat(document.getElementById('vo2-weight').value);
  var age = parseFloat(document.getElementById('vo2-age').value);
  var sex = parseFloat(document.getElementById('vo2-sex').value);
  var time = parseFloat(document.getElementById('vo2-time').value);
  var hr = parseFloat(document.getElementById('vo2-hr').value);
  var result = document.getElementById('vo2-result');
  if (!w || !age || !time || !hr) { result.textContent = ''; return; }
  var vo2 = 132.853 - (0.0769 * w) - (0.3877 * age) + (6.315 * sex) - (3.2649 * time) - (0.1565 * hr);
  vo2 = Math.round(vo2 * 10) / 10;
  if (vo2 > 0) {
    result.textContent = 'Estimated VO2 Max: ' + vo2 + ' ml/kg/min';
    document.getElementById('ft-value').value = vo2;
  } else {
    result.textContent = 'Check your values — result seems too low.';
  }
}

function calcVO2Cooper() {
  var dist = parseFloat(document.getElementById('vo2-cooper-dist').value);
  var unit = document.getElementById('vo2-cooper-unit').value;
  var result = document.getElementById('vo2-cooper-result');
  if (!dist || dist <= 0) { result.textContent = ''; return; }
  var metres = unit === 'miles' ? dist * 1609.34 : dist;
  var vo2 = (metres - 504.9) / 44.73;
  vo2 = Math.round(vo2 * 10) / 10;
  if (vo2 > 0) {
    result.textContent = 'Estimated VO2 Max: ' + vo2 + ' ml/kg/min';
    document.getElementById('ft-value').value = vo2;
  } else {
    result.textContent = 'Check your values — result seems too low.';
  }
}

function onFitnessTestChange() {
  var key = document.getElementById('ft-test').value;
  var norm = FITNESS_NORMS[key];
  var isMileTime = key === 'mile_time';
  var isAMRAP = AMRAP_TESTS.includes(key);
  var isRepsOnly = REPS_ONLY_TESTS.includes(key);
  var isVO2 = key === 'vo2max';
  var isSelfRated = norm && norm.selfRated;

  document.getElementById('ft-time-fields').style.display = isMileTime ? 'block' : 'none';
  document.getElementById('ft-amrap-fields').style.display = (isAMRAP || isRepsOnly) ? 'block' : 'none';
  document.getElementById('ft-value-row').style.display = (!isMileTime && !isAMRAP && !isRepsOnly && !isSelfRated) ? 'flex' : 'none';
  var scaleFields = document.getElementById('ft-scale-fields');
  if (scaleFields) {
    scaleFields.style.display = isSelfRated ? 'block' : 'none';
    if (isSelfRated && norm.scaleLabels) {
      var group = document.getElementById('ft-scale-group');
      group.innerHTML = norm.scaleLabels.map(function(label, i) {
        return '<button type="button" class="opt-btn" data-value="' + (i + 1) + '" onclick="selectOptionBtn(\'ft-scale-group\',this)">' + (i + 1) + ' — ' + escapeHtml(label) + '</button>';
      }).join('');
      document.getElementById('ft-scale-label').textContent = norm.hint || 'How would you rate yourself?';
    }
  }
  // Farmer's walk weight input
  var fwFields = document.getElementById('ft-fw-weight-fields');
  if (fwFields) {
    fwFields.style.display = key === 'farmers_walk' ? 'block' : 'none';
    if (key === 'farmers_walk') {
      var p = getUserProfile();
      var targetLbs = Math.round(p.weightLbs * 0.5);
      var targetEl = document.getElementById('ft-fw-target');
      if (targetEl) targetEl.textContent = 'Target: ' + targetLbs + ' lbs per hand (50% BW)';
    }
  }

  var vo2Calc = document.getElementById('vo2-calculator');
  if (vo2Calc) vo2Calc.style.display = isVO2 ? 'block' : 'none';

  // Configure AMRAP fields for reps-only (bodyweight) tests
  var amrapLabel = document.getElementById('ft-amrap-label');
  var weightField = document.getElementById('ft-amrap-weight').parentElement;
  var unitField = document.getElementById('ft-amrap-unit').parentElement;
  if (isRepsOnly) {
    amrapLabel.textContent = 'Reps to failure';
    weightField.style.display = 'none';
    unitField.style.display = 'none';
    document.getElementById('ft-amrap-weight').value = '0';
    document.getElementById('ft-amrap-weight').required = false;
    document.getElementById('ft-amrap-reps').placeholder = 'max reps';
    document.getElementById('ft-amrap-reps').style.flex = '1';
    document.getElementById('ft-amrap-1rm-preview').textContent = '';
  } else if (isAMRAP) {
    amrapLabel.textContent = 'Weight used & reps completed to failure';
    weightField.style.display = '';
    unitField.style.display = '';
    document.getElementById('ft-amrap-weight').value = '';
    document.getElementById('ft-amrap-weight').placeholder = 'e.g. 185';
    document.getElementById('ft-amrap-weight').required = true;
    document.getElementById('ft-amrap-reps').style.flex = '';
    document.getElementById('ft-amrap-wunit').textContent = 'lbs';
  }

  if (norm) {
    document.getElementById('ft-val-label').textContent = norm.label;
    document.getElementById('ft-unit-display').textContent = norm.unit;
    var sub = document.getElementById('ft-modal-sub');
    if (isAMRAP) sub.textContent = 'Use a weight you can lift for 3-10 reps and go to failure. We calculate your estimated 1RM automatically.';
    else if (isRepsOnly) sub.textContent = 'Max reps to failure with good form. Add weight if using a belt or vest.';
    else sub.textContent = norm.hint || 'Record a benchmark result. Be consistent — same time of day, rested state.';
  }

  // Live 1RM preview for AMRAP tests
  if (isAMRAP) {
    ['ft-amrap-weight','ft-amrap-reps'].forEach(function(id) {
      document.getElementById(id).oninput = function() {
        var w = parseFloat(document.getElementById('ft-amrap-weight').value);
        var r = parseInt(document.getElementById('ft-amrap-reps').value);
        var preview = document.getElementById('ft-amrap-1rm-preview');
        if (w > 0 && r > 0 && r <= 30) {
          preview.textContent = 'Estimated 1RM: ' + epley1RM(w, r) + ' ' + document.getElementById('ft-amrap-unit').value;
        } else {
          preview.textContent = '';
        }
      };
    });
  }
}

function openLogTestModal(preselect) {
  editingTestId = null;
  // Remove delete button if present (from previous edit mode)
  var delBtn = document.getElementById('ft-delete-btn');
  if (delBtn) delBtn.remove();
  document.getElementById('ft-date').value = localDateStr(new Date());
  document.getElementById('ft-value').value = '';
  document.getElementById('ft-mins').value = '';
  document.getElementById('ft-secs').value = '';
  document.getElementById('ft-amrap-weight').value = '';
  document.getElementById('ft-amrap-reps').value = '';
  document.getElementById('ft-amrap-1rm-preview').textContent = '';
  document.getElementById('ft-notes').value = '';
  // Reset VO2 calculators
  document.getElementById('vo2-result').textContent = '';
  document.getElementById('vo2-time').value = '';
  document.getElementById('vo2-hr').value = '';
  document.getElementById('vo2-cooper-dist').value = '';
  document.getElementById('vo2-cooper-result').textContent = '';
  selectVO2Method('rockport');
  // Pre-fill VO2 calculator from profile
  var p = window.userProfileData || {};
  if (p.current_weight_kg) document.getElementById('vo2-weight').value = Math.round(p.current_weight_kg * 2.205);
  var dobStr = p.birth_date || p.dob;
  if (dobStr) {
    var dob = new Date(dobStr);
    if (!isNaN(dob)) document.getElementById('vo2-age').value = Math.floor((new Date() - dob) / (365.25 * 24 * 3600 * 1000));
  }
  if (p.sex === 'female') document.getElementById('vo2-sex').value = '0';
  else document.getElementById('vo2-sex').value = '1';
  if (preselect) document.getElementById('ft-test').value = preselect;
  onFitnessTestChange();
  openModal('fitness-modal');
}

var editingTestId = null;

async function openEditTestModal(testKey, testId) {
  editingTestId = testId;
  openLogTestModal(testKey);
  // Update modal title and button for edit mode
  document.querySelector('#fitness-modal .modal-title').innerHTML = 'Edit <em>Test</em>';
  document.querySelector('#fitness-modal .modal-btn-primary').textContent = 'Save Changes';
  // Add delete button if not already present
  var actions = document.querySelector('#fitness-modal .modal-actions');
  var existingDel = document.getElementById('ft-delete-btn');
  if (!existingDel && actions) {
    var delBtn = document.createElement('button');
    delBtn.id = 'ft-delete-btn';
    delBtn.className = 'modal-btn-secondary';
    delBtn.style.cssText = 'color:var(--error);border-color:var(--error-border);margin-right:auto';
    delBtn.textContent = 'Delete';
    delBtn.onclick = function() { deleteFitnessTest(testId); };
    actions.insertBefore(delBtn, actions.firstChild);
  } else if (existingDel) {
    existingDel.onclick = function() { deleteFitnessTest(testId); };
  }
  // Fetch test data and pre-populate
  try {
    var data = await supabaseRequest('/rest/v1/fitness_tests?id=eq.' + testId + '&limit=1', 'GET', null, getToken());
    if (!data || !data[0]) return;
    var test = data[0];
    var dateStr = test.tested_at ? test.tested_at.split('T')[0] : '';
    if (dateStr) document.getElementById('ft-date').value = dateStr;
    if (test.notes) document.getElementById('ft-notes').value = test.notes;
    var key = test.test_key;
    if (key === 'mile_time') {
      var totalMins = parseFloat(test.raw_value);
      document.getElementById('ft-mins').value = Math.floor(totalMins);
      document.getElementById('ft-secs').value = Math.round((totalMins - Math.floor(totalMins)) * 60);
    } else if (AMRAP_TESTS.includes(key)) {
      // Can't reverse 1RM to weight+reps, show 1RM as info
      document.getElementById('ft-amrap-1rm-preview').textContent = 'Current 1RM: ' + Math.round(test.raw_value) + ' ' + (test.unit || 'lbs');
    } else if (REPS_ONLY_TESTS.includes(key)) {
      document.getElementById('ft-amrap-reps').value = Math.round(test.raw_value);
    } else {
      document.getElementById('ft-value').value = test.raw_value;
    }
  } catch(e) {
    console.error('[Fitness] Error loading test data:', e);
  }
}

async function saveFitnessTest() {
  var key = document.getElementById('ft-test').value;
  var norm = FITNESS_NORMS[key];
  var date = document.getElementById('ft-date').value;
  var notes = document.getElementById('ft-notes').value.trim();
  var rawValue;

  if (norm && norm.selfRated) {
    rawValue = parseInt(getOptionBtnValue('ft-scale-group'));
    if (!rawValue || rawValue < 1 || rawValue > 5) { alert('Select a rating.'); return; }
  } else if (key === 'mile_time') {
    var mins = parseFloat(document.getElementById('ft-mins').value) || 0;
    var secs = parseFloat(document.getElementById('ft-secs').value) || 0;
    rawValue = mins + secs / 60;
    if (rawValue <= 0) { alert('Enter a mile time.'); return; }
  } else if (AMRAP_TESTS.includes(key)) {
    var w = parseFloat(document.getElementById('ft-amrap-weight').value);
    var r = parseInt(document.getElementById('ft-amrap-reps').value);
    var amrapUnit = document.getElementById('ft-amrap-unit').value;
    if (!w || !r || r > 30) { alert('Enter weight and reps (max 30 for accuracy).'); return; }
    // Convert kg to lbs since norms are in lbs
    var wLbs = amrapUnit === 'kg' ? w * 2.205 : w;
    rawValue = epley1RM(wLbs, r);
  } else if (REPS_ONLY_TESTS.includes(key)) {
    var r = parseInt(document.getElementById('ft-amrap-reps').value);
    if (!r || r <= 0) { alert('Enter reps completed.'); return; }
    rawValue = r;
  } else {
    rawValue = parseFloat(document.getElementById('ft-value').value);
    if (isNaN(rawValue)) { alert('Enter a value.'); return; }
  }

  var profile = getUserProfile();
  var percentile = calcPercentile(key, rawValue, profile);

  // Farmer's walk: prepend weight to notes
  if (key === 'farmers_walk') {
    var fwWeight = document.getElementById('ft-fw-weight');
    var fwUnit = document.getElementById('ft-fw-wunit');
    if (fwWeight && fwWeight.value) {
      var weightStr = fwWeight.value + ' ' + (fwUnit ? fwUnit.value : 'lbs') + '/hand';
      notes = '[' + weightStr + ']' + (notes ? ' ' + notes : '');
    }
  }

  var payload = {
    user_id: currentUser.id,
    test_key: key,
    raw_value: rawValue,
    unit: norm.unit,
    percentile: percentile,
    notes: notes,
    tested_at: date + 'T12:00:00',
    created_at: new Date().toISOString()
  };

  try {
    var btn = document.querySelector('#fitness-modal .modal-btn-primary');
    btn.textContent = 'Saving…'; btn.disabled = true;
    if (editingTestId) {
      // Update existing test
      delete payload.user_id;
      delete payload.created_at;
      await supabaseRequest('/rest/v1/fitness_tests?id=eq.' + editingTestId, 'PATCH', payload, getToken());
      editingTestId = null;
    } else {
      await supabaseRequest('/rest/v1/fitness_tests', 'POST', payload, getToken());
    }
    closeModal('fitness-modal');
    // Reset modal title
    document.querySelector('#fitness-modal .modal-title').innerHTML = 'Log a <em>Test</em>';
    document.querySelector('#fitness-modal .modal-btn-primary').textContent = 'Save Result';
    renderStrengthPage();
  } catch(e) {
    console.error(e);
    alert('Could not save. Create the fitness_tests table in Supabase:\n\nCREATE TABLE fitness_tests (\n  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,\n  user_id uuid REFERENCES auth.users(id),\n  test_key text,\n  raw_value numeric,\n  unit text,\n  percentile integer,\n  notes text,\n  tested_at timestamptz,\n  created_at timestamptz DEFAULT now()\n);\n\nALTER TABLE fitness_tests ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "own" ON fitness_tests FOR ALL USING (auth.uid() = user_id);');
  } finally {
    var b = document.querySelector('#fitness-modal .modal-btn-primary');
    if (b) { b.textContent = 'Save Result'; b.disabled = false; }
  }
}

async function deleteFitnessTest(testId) {
  var confirmed = await confirmModal('This test result will be permanently deleted.', { title: 'Delete Test', confirmText: 'Delete', danger: true });
  if (!confirmed) return;
  try {
    await supabaseRequest('/rest/v1/fitness_tests?id=eq.' + testId, 'DELETE', null, getToken());
    closeModal('fitness-modal');
    document.querySelector('#fitness-modal .modal-title').innerHTML = 'Log a <em>Test</em>';
    document.querySelector('#fitness-modal .modal-btn-primary').textContent = 'Save Result';
    editingTestId = null;
    renderStrengthPage();
  } catch(e) {
    console.error('[Fitness] Delete test error:', e);
  }
}

function orderTestsByRelevance(testKeys, profile, byKey) {
  var age = profile.age;
  return testKeys.slice().sort(function(a, b) {
    var scoreA = 0, scoreB = 0;
    // Age suitability
    var seniorTests = ['chair_stand','balance','walk_6min','plank','toe_touch','shoulder_reach'];
    var youngTests = ['bench_1rm','squat_1rm','deadlift_1rm','pullup','dead_hang','farmers_walk'];
    if (age >= 60) {
      if (seniorTests.includes(a)) scoreA += 20;
      if (seniorTests.includes(b)) scoreB += 20;
      if (youngTests.includes(a)) scoreA -= 10;
      if (youngTests.includes(b)) scoreB -= 10;
    } else if (age < 35) {
      if (youngTests.includes(a)) scoreA += 10;
      if (youngTests.includes(b)) scoreB += 10;
    }
    // Staleness: untested or stale tests first
    var histA = byKey[a] || [], histB = byKey[b] || [];
    if (!histA.length) scoreA += 10;
    if (!histB.length) scoreB += 10;
    return scoreB - scoreA;
  });
}

async function renderStrengthPage() {
  if (!currentUser) return;
  var container = document.getElementById('fitness-categories');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:24px 0">Loading…</div>';

  try {
    var tests = await supabaseRequest(
      '/rest/v1/fitness_tests?user_id=eq.' + currentUser.id + '&order=tested_at.desc&limit=200',
      'GET', null, getToken()
    );
    if (!tests || tests.error) tests = [];

    // Group by test_key, most recent first
    var byKey = {};
    tests.forEach(function(t) {
      if (!byKey[t.test_key]) byKey[t.test_key] = [];
      byKey[t.test_key].push(t);
    });

    var profile = getUserProfile();
    var html = '';

    var recommended = getRecommendedTests(profile, byKey);

    // ── Recommended for You section (only show if user has some test history) ──
    var testedKeys = Object.keys(byKey);
    if (testedKeys.length > 0) {
      // Filter: prioritize stale tests and low-percentile tests the user has done,
      // then add up to 2 untested tests that match their profile
      var testedRecs = recommended.filter(function(k) { return byKey[k] && byKey[k].length > 0; });
      var untestedRecs = recommended.filter(function(k) { return !byKey[k] || byKey[k].length === 0; }).slice(0, 2);
      var filteredRecs = testedRecs.concat(untestedRecs).slice(0, 6);

      if (filteredRecs.length > 0) {
        html += '<div style="margin-bottom:28px">'
          + '<div style="font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:var(--gold);margin-bottom:4px">Recommended for You</div>'
          + '<div style="font-size:11px;color:var(--muted);margin-bottom:12px">Based on your age, goals, and test history</div>'
          + '<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:4px">';
        filteredRecs.forEach(function(recKey) {
          var norm = FITNESS_NORMS[recKey];
          if (!norm) return;
          var history = byKey[recKey] || [];
          var latest = history[0];
          var valText = '—';
          var subText = 'Not tested';
          if (latest) {
            if (recKey === 'mile_time') {
              var m = Math.floor(latest.raw_value);
              var s = Math.round((latest.raw_value - m) * 60);
              valText = m + ':' + (s < 10 ? '0' : '') + s;
            } else if (norm.selfRated) {
              valText = parseInt(latest.raw_value) + '/5';
            } else {
              valText = latest.raw_value % 1 === 0 ? latest.raw_value : parseFloat(latest.raw_value).toFixed(1);
            }
            // Show why it's recommended
            var daysSince = Math.round((Date.now() - new Date(latest.tested_at)) / 86400000);
            if (latest.percentile && latest.percentile < 30) subText = 'Room to improve';
            else if (daysSince > 90) subText = 'Last tested ' + daysSince + 'd ago';
            else subText = escapeHtml(norm.unit);
          }
          html += '<div class="fitness-rec-card" onclick="openLogTestModal(\'' + recKey + '\')" style="min-width:140px;flex:0 0 auto;padding:14px 16px;background:var(--dark-3);border:1px solid var(--gold-border);cursor:pointer;transition:border-color .2s" onmouseover="this.style.borderColor=\'var(--gold)\'" onmouseout="this.style.borderColor=\'\'">'
            + '<div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--gold);margin-bottom:6px">' + escapeHtml(norm.label) + '</div>'
            + '<div style="font-family:var(--F);font-size:24px;font-weight:300">' + valText + '</div>'
            + '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + subText + '</div>'
            + '<div style="margin-top:8px;font-size:10px;color:var(--gold);cursor:pointer">+ Log</div>'
            + '</div>';
        });
        html += '</div></div>';
      }
    }

    // ── Domain progress card ──
    var domainStatus = getCompletedDomains({ tests: tests });
    html += '<div class="card" style="padding:20px;margin-bottom:24px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'
      + '<div>'
      + '<div style="font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:var(--gold);margin-bottom:4px">Fitness Score</div>'
      + '<div style="font-size:13px;color:var(--cream-dim)">' + (domainStatus.missing.length === 0 ? 'All domains complete' : domainStatus.completed.length + ' of 5 domains tested') + '</div>'
      + '</div>'
      + (domainStatus.missing.length > 0 ? '<div style="font-size:11px;color:var(--muted)">Complete all 5 for a confirmed score</div>' : '<div style="font-size:11px;color:var(--up)">Score confirmed</div>')
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    FITNESS_DOMAINS.forEach(function(d) {
      var done = d.tests.some(function(k) { return byKey[k] && byKey[k].length > 0; });
      var testOptions = d.tests.map(function(k) { return FITNESS_NORMS[k] ? FITNESS_NORMS[k].label : k; }).join(' or ');
      html += '<div style="flex:1;min-width:100px;padding:10px 12px;background:' + (done ? 'var(--gold-faint)' : 'var(--dark-3)') + ';border:1px solid ' + (done ? 'var(--gold-border)' : 'rgba(245,240,232,0.06)') + ';cursor:' + (done ? 'default' : 'pointer') + '"'
        + (!done ? ' onclick="openLogTestModal(\'' + d.tests[0] + '\')"' : '') + '>'
        + '<div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:' + (done ? 'var(--gold)' : 'var(--muted)') + ';margin-bottom:3px">' + (done ? '&#10003; ' : '') + escapeHtml(d.label) + '</div>'
        + '<div style="font-size:10px;color:var(--muted)">' + escapeHtml(testOptions) + '</div>'
        + '</div>';
    });
    html += '</div></div>';

    FITNESS_CATEGORIES.forEach(function(cat) {
      var hasAny = cat.tests.some(function(k) { return byKey[k] && byKey[k].length > 0; });
      // Smart ordering: sort tests within category by relevance to user
      var orderedTests = orderTestsByRelevance(cat.tests, profile, byKey);
      html += '<div style="margin-bottom:28px">'
        + '<div style="font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:var(--gold);margin-bottom:12px">' + cat.label + '</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';

      orderedTests.forEach(function(key) {
        var norm = FITNESS_NORMS[key];
        var history = byKey[key] || [];
        var latest = history[0];

        var valueDisplay = '—';
        var percentileDisplay = '';
        var pctClass = '';
        var historyBars = '';

        if (latest) {
          if (norm.selfRated) {
            var scaleVal = parseInt(latest.raw_value);
            valueDisplay = scaleVal + '/5';
            if (norm.scaleLabels && norm.scaleLabels[scaleVal - 1]) {
              valueDisplay += '<div style="font-size:11px;color:var(--cream-dim);margin-top:4px;font-family:var(--B);font-weight:300">' + escapeHtml(norm.scaleLabels[scaleVal - 1]) + '</div>';
            }
          } else if (key === 'mile_time') {
            var totalMins = latest.raw_value;
            var m = Math.floor(totalMins);
            var s = Math.round((totalMins - m) * 60);
            valueDisplay = m + ':' + (s < 10 ? '0' : '') + s;
          } else {
            valueDisplay = latest.raw_value % 1 === 0 ? latest.raw_value : parseFloat(latest.raw_value).toFixed(1);
            // Farmer's walk: show weight from notes if stored
            if (key === 'farmers_walk' && latest.notes) {
              var fwMatch = latest.notes.match(/^\[([^\]]+)\]/);
              if (fwMatch) valueDisplay += '<div style="font-size:11px;color:var(--cream-dim);margin-top:2px;font-family:var(--B);font-weight:300">@ ' + escapeHtml(fwMatch[1]) + '</div>';
            }
          }
          var p = latest.percentile || calcPercentile(key, parseFloat(latest.raw_value), profile);
          var pl = percentileLabel(p);
          var ord = p === 1 ? 'st' : p === 2 ? 'nd' : p === 3 ? 'rd' : 'th';
          percentileDisplay = p + ord + ' percentile';
          pctClass = pl.cls;

          // Sparkline from history (last 6)
          var spark = history.slice(0,6).reverse();
          var vals = spark.map(function(t) { return parseFloat(t.raw_value); });
          var minV = Math.min.apply(null,vals), maxV = Math.max.apply(null,vals);
          var range = maxV - minV || 1;
          historyBars = spark.map(function(t,i) {
            var pct = ((parseFloat(t.raw_value) - minV) / range) * 70 + 15;
            if (!norm.higherBetter) pct = 100 - pct;
            var isLatest = i === spark.length - 1;
            return '<div style="flex:1;background:' + (isLatest?'var(--gold)':'rgba(184,151,90,.3)') + ';height:' + Math.round(pct) + '%;min-height:3px;border-radius:1px"></div>';
          }).join('');
        }

        var dateStr = latest ? new Date(latest.tested_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';

        var isRec = recommended.indexOf(key) !== -1;
        var latestId = latest ? latest.id : '';
        html += '<div class="card fitness-test-card" data-key="' + key + '" data-test-id="' + latestId + '" style="padding:20px;position:relative;cursor:pointer' + (isRec ? ';border-color:rgba(184,151,90,.5)' : '') + '">'
          + (isRec ? '<div style="position:absolute;top:12px;right:12px;font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--gold);background:rgba(184,151,90,.12);border:1px solid var(--gold-border);padding:2px 8px">Recommended</div>' : '')
          + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">'
          + '<div>'
          + '<div style="font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">' + norm.label + '</div>'
          + '<div style="display:flex;align-items:baseline;gap:6px">'
          + '<div style="font-family:var(--F);font-size:36px;font-weight:300;line-height:1">' + valueDisplay + '</div>'
          + (latest ? '<div style="font-size:12px;color:var(--muted)">' + norm.unit + '</div>' : '')
          + '</div>'
          + (percentileDisplay ? '<div class="pct-badge ' + pctClass + '" style="margin-top:6px">' + percentileDisplay + '</div>' : '')
          + (dateStr ? '<div style="font-size:10px;color:var(--muted);margin-top:4px">' + dateStr + '</div>' : '')
          + '</div>'
          + '<div style="display:flex;align-items:flex-end;gap:3px;height:48px;width:60px">' + historyBars + '</div>'
          + '</div>'
          + '<div style="font-size:11px;color:var(--muted);line-height:1.5;border-top:1px solid var(--gold-border);padding-top:10px;display:flex;justify-content:space-between;align-items:center">'
          + '<span>' + norm.hint + '</span>'
          + '<span class="log-test-btn" data-key="' + key + '" style="cursor:pointer;color:var(--gold);white-space:nowrap;margin-left:12px">+ Log</span>'
          + '</div>'
          + '</div>';
      });

      html += '</div></div>';
    });

    container.innerHTML = html;

    // Delegated listener for log buttons and card clicks (remove previous to avoid stacking)
    if (container._fitnessClickHandler) container.removeEventListener('click', container._fitnessClickHandler);
    container._fitnessClickHandler = function(e) {
      var logBtn = e.target.closest('.log-test-btn');
      if (logBtn) {
        e.stopPropagation();
        openLogTestModal(logBtn.getAttribute('data-key'));
        return;
      }
      var card = e.target.closest('.fitness-test-card');
      if (card) {
        var testKey = card.getAttribute('data-key');
        var testId = card.getAttribute('data-test-id');
        if (testId) {
          openEditTestModal(testKey, testId);
        } else {
          openLogTestModal(testKey);
        }
      }
    };
    container.addEventListener('click', container._fitnessClickHandler);

  } catch(e) {
    console.error('Fitness page error:', e);
    var c = document.getElementById('fitness-categories');
    if (c) c.innerHTML = '<div class="empty-state" style="padding:40px"><div class="empty-state-icon">🏋️</div><div class="empty-state-text">No tests logged yet.<br>Hit "+ Log a Test" to start.</div></div>';
  }
}

// ── DID YOU KNOW ── 
var insightLibrary = {
  longevity: [
    {
      icon: '🧬',
      hook: 'Normal bloodwork ranges are not the same as optimal ranges.',
      body: 'Lab reference ranges are built from population averages — including sick people. A result flagged as "normal" can still be far from the level associated with long-term health. Optimal ranges for longevity are often much narrower.',
      tag: 'Bloodwork'
    },
    {
      icon: '🔥',
      hook: 'Chronic low-grade inflammation is the underlying driver of most age-related disease.',
      body: 'Conditions like heart disease, Alzheimers, and type 2 diabetes all share a common thread — inflammation that builds silently over years. Markers like hsCRP and homocysteine can detect this long before symptoms appear.',
      tag: 'Longevity'
    },
    {
      icon: '💧',
      hook: 'Reverse osmosis water removes the minerals your body needs most.',
      body: 'RO filtration removes fluoride and contaminants but also strips magnesium, calcium, and potassium. If you drink RO water exclusively, you may be quietly depleting minerals critical for heart rhythm, sleep quality, and muscle function.',
      tag: 'Hydration'
    },
    {
      icon: '🫀',
      hook: 'Your resting heart rate trend matters more than any single reading.',
      body: 'A one-off resting HR means little. But a resting HR that has been climbing over weeks is an early signal of accumulated stress, illness, or overtraining — often before you feel it.',
      tag: 'Cardiovascular'
    }
  ],
  energy: [
    {
      icon: '😴',
      hook: 'Sleep debt is real — and you cannot fully pay it back on weekends.',
      body: 'Research shows that recovering from accumulated sleep deprivation takes far longer than the lost sleep itself. Consistent 6-hour nights create cognitive and metabolic deficits that a weekend lie-in will not fix.',
      tag: 'Sleep'
    },
    {
      icon: '⚡',
      hook: 'Iron deficiency can cause exhaustion long before anaemia shows up on a blood test.',
      body: 'Ferritin — your iron storage protein — can be depleted for months before haemoglobin drops enough to be flagged. Low ferritin alone causes fatigue, brain fog, and poor exercise recovery, even with a "normal" iron panel.',
      tag: 'Nutrition'
    },
    {
      icon: '🍬',
      hook: 'Energy crashes after meals are a sign of glucose instability, not just sugar intake.',
      body: 'Post-meal fatigue is often driven by a rapid glucose spike followed by a crash — triggered not just by sweets but by refined carbs, large portions, or eating carbs in isolation. Pairing carbs with protein or fat dramatically smooths this curve.',
      tag: 'Nutrition'
    },
    {
      icon: '☕',
      hook: 'Caffeine does not create energy — it masks the signal that tells you you are tired.',
      body: 'Caffeine works by blocking adenosine receptors, not by generating energy. The adenosine keeps building while you feel alert, then crashes when the caffeine clears — which is why the 3pm slump hits harder when you have had a lot of coffee.',
      tag: 'Hydration'
    }
  ],
  sleep: [
    {
      icon: '🍷',
      hook: 'Alcohol makes you fall asleep faster but destroys your sleep quality.',
      body: 'Even moderate alcohol suppresses REM sleep — the stage responsible for memory consolidation and emotional regulation. You may sleep 8 hours and wake feeling unrested — HRV is one of the clearest ways to see this effect.',
      tag: 'Sleep'
    },
    {
      icon: '🧠',
      hook: 'Your brain physically cleans itself during deep sleep.',
      body: 'The glymphatic system — essentially your brain waste disposal — is almost exclusively active during deep sleep. It flushes out metabolic waste including amyloid-beta, the protein associated with Alzheimers. Poor sleep means poor clearance.',
      tag: 'Sleep'
    },
    {
      icon: '🌡️',
      hook: 'Your body temperature needs to drop 1-2°C to initiate sleep.',
      body: 'Core body cooling is a key trigger for sleep onset. A warm shower or bath 1-2 hours before bed actually helps — the subsequent cooling accelerates the drop. Keeping your room cold (16-19°C / 60-67°F) is one of the most evidence-backed sleep improvements.',
      tag: 'Sleep'
    },
    {
      icon: '💊',
      hook: 'Magnesium deficiency is one of the most common and overlooked causes of poor sleep.',
      body: 'Magnesium activates the parasympathetic nervous system and regulates GABA — the neurotransmitter that quiets the brain for sleep. Deficiency is extremely common, partly because modern soils are depleted and RO water removes what is left.',
      tag: 'Nutrition'
    }
  ],
  fitness: [
    {
      icon: '💪',
      hook: 'Muscle is built during rest, not during training.',
      body: 'Training creates the stimulus — microscopic muscle damage that signals adaptation. The actual growth happens in the 24-72 hours after, during recovery. Insufficient sleep or back-to-back training sessions actively prevent the gains you worked for.',
      tag: 'Recovery'
    },
    {
      icon: '🥩',
      hook: 'When you eat protein matters almost as much as how much you eat.',
      body: 'Muscle protein synthesis peaks when protein is spread across meals rather than concentrated in one. Your body can only utilise roughly 20-40g per sitting for muscle building. Spreading intake across 3-4 meals is significantly more effective than one large protein meal.',
      tag: 'Nutrition'
    },
    {
      icon: '📉',
      hook: 'Overtraining looks identical to undertraining from the outside.',
      body: 'A plateau in performance, persistent fatigue, and mood changes can all be caused by doing too much, not too little. HRV declining week over week is one of the clearest early signals that your body is under more stress than it can adapt to.',
      tag: 'Recovery'
    },
    {
      icon: '🦴',
      hook: 'Strength training is the most powerful intervention for long-term metabolic health.',
      body: 'Muscle tissue is metabolically active — the more you have, the more glucose you clear from the bloodstream at rest. Higher muscle mass is strongly correlated with insulin sensitivity, lower visceral fat, and reduced all-cause mortality.',
      tag: 'Fitness'
    }
  ],
  focus: [
    {
      icon: '🐟',
      hook: 'Omega-3 deficiency is one of the most common nutritional gaps in the developed world.',
      body: 'DHA — found almost exclusively in fatty fish and algae — is a structural component of brain cell membranes. Low DHA is associated with slower cognition, mood instability, and higher inflammation. Most people get a fraction of what research suggests is optimal.',
      tag: 'Nutrition'
    },
    {
      icon: '🩸',
      hook: 'Blood glucose swings are a leading cause of brain fog and poor focus.',
      body: 'Your brain runs almost exclusively on glucose. Rapid spikes and crashes — from refined carbs, skipped meals, or high-sugar snacks — create the cognitive equivalent of flickering lights. Stable glucose means stable attention.',
      tag: 'Nutrition'
    },
    {
      icon: '💧',
      hook: 'Even mild dehydration measurably reduces cognitive performance.',
      body: 'Studies show that a 1-2% reduction in body water — before you even feel thirsty — impairs working memory, attention, and reaction time. Thirst is a lagging indicator. By the time you feel it, performance is already affected.',
      tag: 'Hydration'
    },
    {
      icon: '😴',
      hook: 'One bad night of sleep impairs cognition as much as being legally drunk.',
      body: '17-19 hours of wakefulness produces cognitive impairment equivalent to a 0.05% blood alcohol level. Yet most people in this state feel fine — the same way people underestimate their impairment when drunk.',
      tag: 'Sleep'
    }
  ],
  mood: [
    {
      icon: '🦠',
      hook: 'About 90% of your serotonin is made in your gut, not your brain.',
      body: 'The gut-brain axis means your microbiome directly influences mood, anxiety, and emotional regulation. Dietary diversity, fibre, and fermented foods feed the bacteria that produce the neurotransmitters affecting how you feel.',
      tag: 'Nutrition'
    },
    {
      icon: '☀️',
      hook: 'Vitamin D deficiency is strongly associated with depression — and most people are deficient.',
      body: 'Vitamin D acts more like a hormone than a vitamin, with receptors throughout the brain. Deficiency is linked to higher rates of depression, anxiety, and seasonal mood changes. Optimal levels (60-80 ng/mL) are well above what most labs flag as sufficient.',
      tag: 'Nutrition'
    },
    {
      icon: '🧘',
      hook: 'HRV is one of the best objective measures of your stress resilience.',
      body: 'Heart rate variability reflects the balance between your sympathetic (fight-or-flight) and parasympathetic (rest) nervous systems. A declining HRV trend — even before you feel stressed — is your body signalling that its capacity to handle load is shrinking.',
      tag: 'Recovery'
    },
    {
      icon: '🏃',
      hook: 'Exercise is as effective as antidepressants for mild to moderate depression.',
      body: 'Multiple large-scale studies show that regular aerobic exercise produces antidepressant effects comparable to medication — with the added benefits of improved sleep, cognition, and cardiovascular health. The dose that matters most is consistency, not intensity.',
      tag: 'Fitness'
    }
  ],
  weight: [
    {
      icon: '⚖️',
      hook: 'Daily weight fluctuations of 1-3kg are normal and tell you almost nothing.',
      body: 'Water retention, food volume, hormonal shifts, and glycogen storage all move the scale dramatically day to day. The only meaningful signal is the trend over 2-4 weeks — which is why logging consistently matters more than any single reading.',
      tag: 'Body Composition'
    },
    {
      icon: '🥩',
      hook: 'High protein intake is the single most evidence-backed strategy for fat loss.',
      body: 'Protein has the highest thermic effect of any macronutrient — your body burns roughly 25-30% of protein calories just digesting it. It also preserves muscle during a calorie deficit and reduces hunger more than carbs or fat.',
      tag: 'Nutrition'
    },
    {
      icon: '😴',
      hook: 'Sleep deprivation makes fat loss almost impossible.',
      body: 'Poor sleep elevates ghrelin (hunger hormone) and suppresses leptin (satiety hormone) — dramatically increasing appetite and cravings for calorie-dense food. Studies show sleep-deprived dieters lose 55% less fat and more muscle than those who sleep adequately.',
      tag: 'Sleep'
    },
    {
      icon: '💪',
      hook: 'Muscle burns more calories at rest than fat — but probably less than you think.',
      body: 'A kg of muscle burns roughly 13 kcal/day at rest vs 4.5 for fat. The metabolic advantage of muscle is real but modest — the bigger benefit is that more muscle means better glucose disposal, improved body composition, and sustainable long-term leanness.',
      tag: 'Fitness'
    }
  ]
};

// Goal key mapping from profile values
var goalKeyMap = {
  longevity: 'longevity',
  energy: 'energy',
  sleep: 'sleep',
  fitness: 'fitness',
  gain_strength: 'fitness',
  stress: 'mood',
  feel_better: 'mood',
  sleep_better: 'sleep',
  weight: 'weight',
  lose_weight: 'weight',
  focus: 'focus'
};

function loadDidYouKnow() {
  if (!currentUser) return;

  // Get goals from profiles table (may be comma-separated)
  var goalStr = (window.userProfileData && window.userProfileData.primary_goal) || '';

  // Collect insights from all selected goals
  var goalParts = goalStr.split(',').map(function(g) { return g.trim(); }).filter(Boolean);
  var allInsights = [];
  var firstKey = 'longevity';
  goalParts.forEach(function(g) {
    var key = goalKeyMap[g] || 'longevity';
    if (allInsights.length === 0) firstKey = key;
    var lib = insightLibrary[key] || [];
    lib.forEach(function(ins) { if (allInsights.indexOf(ins) === -1) allInsights.push(ins); });
  });
  if (allInsights.length === 0) allInsights = insightLibrary.longevity || [];
  var key = firstKey;

  // Show top 2 insights
  var toShow = allInsights.slice(0, 2);
  var goalLabels = {
    longevity: 'Longevity', energy: 'Energy', sleep: 'Sleep',
    fitness: 'Fitness', mood: 'Mood', weight: 'Weight management', focus: 'Focus'
  };

  document.getElementById('dyk-goal-label').textContent = goalLabels[key] || 'Your goals';
  document.getElementById('dyk-insights').innerHTML = toShow.map(function(ins) {
    return '<div class="dyk-card">'
      + '<div class="dyk-icon">' + ins.icon + '</div>'
      + '<div class="dyk-content">'
      + '<div class="dyk-hook">' + ins.hook + '</div>'
      + '<div class="dyk-body">' + ins.body + '</div>'
      + '<div class="dyk-tag">' + ins.tag + '</div>'
      + '</div></div>';
  }).join('');
}

// ── BENCHMARK DATA ──
// Benchmarks sourced from peer-reviewed population studies
// Tiers: low / below-average / average / good / optimal
var benchmarks = {
  sleep: {
    title: 'Sleep Duration',
    unit: 'h', 
    higherIsBetter: true,
    ticks: ['< 5h', '6h', '7h', '8h', '9h+'],
    tiers: [
      { name: 'Below recommended', range: 'Under 6h', max: 6, color: '#e07070' },
      { name: 'Below average', range: '6 – 6.9h', max: 6.9, color: '#e0a070' },
      { name: 'Average', range: '7 – 7.4h', max: 7.4, color: '#B8975A' },
      { name: 'Good', range: '7.5 – 8.5h', max: 8.5, color: '#a0c870' },
      { name: 'Optimal', range: '8.5h+', max: 99, color: '#6fcf8a' }
    ],
    getContext: function(val, age, sex) {
      var peer = sex === 'female' ? 7.2 : 6.9;
      var diff = Math.round((val - peer) * 10) / 10;
      var peerDesc = 'Adults aged ' + (age ? Math.floor(age/10)*10 + 's' : 'your age');
      return '<p>' + peerDesc + ' average ' + peer + ' hours of sleep per night. '
        + (diff >= 0 ? 'You are sleeping ' + diff + 'h more than your peer group average.' 
           : 'You are sleeping ' + Math.abs(diff) + 'h less than your peer group average.')
        + '</p><p>The research consensus points to 7-9 hours as the range associated with the best cognitive performance, metabolic health, and longevity outcomes. Below 6 hours consistently, the effects compound week over week in ways most people do not notice until they get a full recovery period.</p>';
    }
  },
  steps: {
    title: 'Daily Steps',
    unit: 'k steps',
    higherIsBetter: true,
    ticks: ['< 2k', '4k', '7k', '10k', '15k+'],
    tiers: [
      { name: 'Sedentary', range: 'Under 4,000', max: 4000, color: '#e07070' },
      { name: 'Low active', range: '4,000 – 6,999', max: 6999, color: '#e0a070' },
      { name: 'Somewhat active', range: '7,000 – 9,999', max: 9999, color: '#B8975A' },
      { name: 'Active', range: '10,000 – 12,499', max: 12499, color: '#a0c870' },
      { name: 'Highly active', range: '12,500+', max: 99999, color: '#6fcf8a' }
    ],
    getContext: function(val, age, sex) {
      var peer = age && age > 50 ? 6800 : 7500;
      var peerK = (peer/1000).toFixed(1);
      return '<p>The average adult in your demographic walks roughly ' + peerK + 'k steps per day. '
        + (val >= peer ? 'You are above that benchmark.' : 'You are currently below that benchmark.')
        + '</p><p>A large 2022 meta-analysis found that mortality risk decreases meaningfully up to around 8,000-10,000 steps per day, with diminishing returns beyond that. The biggest jump in benefit is going from under 4,000 to 7,000 — the move from sedentary to moderately active.</p>';
    }
  },
  heart_rate: {
    title: 'Resting Heart Rate',
    unit: 'bpm',
    higherIsBetter: false,
    ticks: ['< 50', '55', '65', '75', '85+'],
    tiers: [
      { name: 'Athlete', range: 'Under 55 bpm', max: 55, color: '#6fcf8a' },
      { name: 'Excellent', range: '55 – 61 bpm', max: 61, color: '#a0c870' },
      { name: 'Good', range: '62 – 67 bpm', max: 67, color: '#B8975A' },
      { name: 'Average', range: '68 – 75 bpm', max: 75, color: '#e0a070' },
      { name: 'Above average', range: '76 bpm+', max: 999, color: '#e07070' }
    ],
    getContext: function(val, age, sex) {
      var peer = sex === 'female' ? 72 : 69;
      var ageAdj = age && age > 50 ? peer + 3 : peer;
      return '<p>The average resting heart rate for ' + (sex || 'adults') + ' in your age group is around ' + ageAdj + ' bpm. '
        + (val < ageAdj ? 'Your resting heart rate is below that average, which generally reflects a more efficient cardiovascular system.' 
           : 'Your resting heart rate is above the average for your peer group.')
        + '</p><p>Resting heart rate is one of the simplest long-term cardiovascular markers. A rate that trends downward over months typically reflects improving aerobic fitness. A rate that is quietly climbing week over week — even staying in a normal range — can be an early signal of accumulated stress, poor sleep, or an oncoming illness before other symptoms appear.</p>';
    }
  },
  active_cal: {
    title: 'Active Calories',
    unit: 'kcal',
    higherIsBetter: true,
    ticks: ['< 100', '200', '400', '600', '800+'],
    tiers: [
      { name: 'Minimal activity', range: 'Under 200 kcal', max: 200, color: '#e07070' },
      { name: 'Light activity', range: '200 – 399 kcal', max: 399, color: '#e0a070' },
      { name: 'Moderate activity', range: '400 – 599 kcal', max: 599, color: '#B8975A' },
      { name: 'Active', range: '600 – 799 kcal', max: 799, color: '#a0c870' },
      { name: 'Highly active', range: '800+ kcal', max: 99999, color: '#6fcf8a' }
    ],
    getContext: function(val, age, sex) {
      var peer = sex === 'female' ? 350 : 450;
      return '<p>The average active calorie burn for ' + (sex || 'adults') + ' in your peer group is around ' + peer + ' kcal per day. '
        + (val >= peer ? 'You are above that average.' : 'You are currently below that average.')
        + '</p><p>Active calories reflect the energy expended through movement beyond your baseline metabolic rate. Higher daily active burn is consistently associated with improved insulin sensitivity, lower visceral fat accumulation, and better cardiovascular markers — independent of formal exercise sessions.</p>';
    }
  },
  weight: {
    title: 'Weight Trend',
    unit: '',
    tiers: [],
    getContext: function(val, age, sex) {
      return '<p>Weight in isolation is one of the least informative health metrics. The same number on the scale looks very different depending on muscle mass, bone density, hydration, and body composition.</p><p>What matters more than where the number sits today is the direction it is trending over 4-8 weeks, and how it correlates with your other markers — particularly energy levels, sleep quality, and how you feel in daily life. Log consistently and the trend will tell you more than any single reading.</p>';
    }
  }
};

// Strength benchmarks by exercise
var strengthBenchmarks = {
  'Bench Press': {
    tiers: [
      { name: 'Beginner', range: '< 0.75x bodyweight', multiplier: 0.75, color: '#e07070' },
      { name: 'Novice', range: '0.75 – 1.0x bodyweight', multiplier: 1.0, color: '#e0a070' },
      { name: 'Intermediate', range: '1.0 – 1.25x bodyweight', multiplier: 1.25, color: '#B8975A' },
      { name: 'Advanced', range: '1.25 – 1.5x bodyweight', multiplier: 1.5, color: '#a0c870' },
      { name: 'Elite', range: '1.5x+ bodyweight', multiplier: 99, color: '#6fcf8a' }
    ],
    context: 'Bench press strength standards are typically expressed relative to bodyweight to account for size differences. These tiers reflect natural lifters with at least 6 months of consistent training. Progress from novice to intermediate typically takes 1-2 years of consistent work.'
  },
  'Squat': {
    tiers: [
      { name: 'Beginner', range: '< 1.0x bodyweight', multiplier: 1.0, color: '#e07070' },
      { name: 'Novice', range: '1.0 – 1.25x bodyweight', multiplier: 1.25, color: '#e0a070' },
      { name: 'Intermediate', range: '1.25 – 1.5x bodyweight', multiplier: 1.5, color: '#B8975A' },
      { name: 'Advanced', range: '1.5 – 2.0x bodyweight', multiplier: 2.0, color: '#a0c870' },
      { name: 'Elite', range: '2.0x+ bodyweight', multiplier: 99, color: '#6fcf8a' }
    ],
    context: 'The squat is the most comprehensive lower body strength movement. Standards are relative to bodyweight. Most people who train consistently for 2+ years land in the intermediate range. Hip mobility and ankle flexibility are common limiters independent of raw strength.'
  },
  'Deadlift': {
    tiers: [
      { name: 'Beginner', range: '< 1.0x bodyweight', multiplier: 1.0, color: '#e07070' },
      { name: 'Novice', range: '1.0 – 1.5x bodyweight', multiplier: 1.5, color: '#e0a070' },
      { name: 'Intermediate', range: '1.5 – 2.0x bodyweight', multiplier: 2.0, color: '#B8975A' },
      { name: 'Advanced', range: '2.0 – 2.5x bodyweight', multiplier: 2.5, color: '#a0c870' },
      { name: 'Elite', range: '2.5x+ bodyweight', multiplier: 99, color: '#6fcf8a' }
    ],
    context: 'The deadlift tends to have higher absolute numbers than other lifts since it uses the entire posterior chain. Standards are relative to bodyweight. The deadlift is also a strong predictor of all-cause mortality in older adults — grip strength and hip hinge strength correlate strongly with longevity.'
  },
  'Overhead Press': {
    tiers: [
      { name: 'Beginner', range: '< 0.5x bodyweight', multiplier: 0.5, color: '#e07070' },
      { name: 'Novice', range: '0.5 – 0.65x bodyweight', multiplier: 0.65, color: '#e0a070' },
      { name: 'Intermediate', range: '0.65 – 0.8x bodyweight', multiplier: 0.8, color: '#B8975A' },
      { name: 'Advanced', range: '0.8 – 1.0x bodyweight', multiplier: 1.0, color: '#a0c870' },
      { name: 'Elite', range: '1.0x+ bodyweight', multiplier: 99, color: '#6fcf8a' }
    ],
    context: 'The overhead press is one of the most technically demanding lifts and tends to progress more slowly than lower body movements. Shoulder mobility and thoracic spine extension are often the limiting factors. A bodyweight press is genuinely elite for most natural lifters.'
  }
};

function openBenchmark(metric) {
  var b = benchmarks[metric];
  if (!b) return;

  // Get user data
  var valEl = document.getElementById('d-' + (metric === 'heart_rate' ? 'hr' : metric === 'active_cal' ? 'cal' : metric));
  var rawVal = valEl ? parseFloat(valEl.textContent) : null;
  if (!rawVal) { rawVal = 0; }
  if (metric === 'steps' && rawVal < 500) rawVal = rawVal * 1000; // convert k display back to steps

  var age = null, sex = null;
  if (window.userProfileData) {
    if (window.userProfileData.birth_date) {
      age = Math.floor((Date.now() - new Date(window.userProfileData.birth_date)) / (365.25 * 24 * 3600 * 1000));
    }
    sex = window.userProfileData.gender || null;
  } else {
    var dobEl = document.getElementById('p-dob');
    var sexEl = document.getElementById('p-sex');
    if (dobEl && dobEl.value) age = Math.floor((Date.now() - new Date(dobEl.value)) / (365.25 * 24 * 3600 * 1000));
    if (sexEl) sex = sexEl.value;
  }

  // Set panel content
  document.getElementById('bench-eyebrow').textContent = 'How you compare · ' + (age ? age + ' · ' : '') + (sex || 'your peer group');
  document.getElementById('bench-title').innerHTML = b.title.replace(' ', ' <em>') + '</em>';
  document.getElementById('bench-val').textContent = metric === 'steps' ? (Math.round(rawVal/100)/10) : rawVal;
  document.getElementById('bench-unit').textContent = b.unit;
  document.getElementById('bench-val-label').textContent = 'your reading';

  // Spectrum marker position
  if (b.tiers.length > 0) {
    var allMaxes = b.tiers.map(function(t) { return t.max === 999 || t.max === 99999 ? null : t.max; }).filter(Boolean);
    var minVal = b.tiers[0].max * 0.5;
    var maxVal = allMaxes[allMaxes.length - 1] * 1.2;
    var pct = Math.min(95, Math.max(5, ((rawVal - minVal) / (maxVal - minVal)) * 100));
    if (!b.higherIsBetter) pct = 100 - pct;
    setTimeout(function() {
      document.getElementById('bench-marker').style.left = pct + '%';
    }, 100);
    document.getElementById('bench-ticks').innerHTML = b.ticks.map(function(t) {
      return '<span>' + t + '</span>';
    }).join('');
  }

  // Tiers
  var currentTierIdx = 0;
  for (var i = 0; i < b.tiers.length; i++) {
    if (rawVal <= b.tiers[i].max) { currentTierIdx = i; break; }
    if (i === b.tiers.length - 1) currentTierIdx = i;
  }
  document.getElementById('bench-tiers').innerHTML = b.tiers.map(function(tier, i) {
    var isCurrent = i === currentTierIdx;
    return '<div class="benchmark-tier ' + (isCurrent ? 'current' : '') + '">'
      + '<div class="benchmark-tier-dot" style="background:' + tier.color + '"></div>'
      + '<div class="benchmark-tier-info">'
      + '<div class="benchmark-tier-name">' + tier.name + '</div>'
      + '<div class="benchmark-tier-range">' + tier.range + '</div>'
      + '</div>'
      + (isCurrent ? '<div class="benchmark-tier-you">You are here</div>' : '')
      + '</div>';
  }).join('');

  // Context
  document.getElementById('bench-context').innerHTML = b.getContext(rawVal, age, sex);

  // Open panel
  document.getElementById('bench-panel').classList.add('open');
  document.getElementById('bench-overlay').classList.add('open');
}

function openStrengthBenchmark(exercise, weight, unit, bodyweight) {
  var b = strengthBenchmarks[exercise];
  if (!b) {
    // Generic context for exercises without specific benchmarks
    openGenericStrengthBenchmark(exercise, weight, unit);
    return;
  }

  var bw = bodyweight || 170; // fallback bodyweight in lbs
  var ratio = weight / bw;

  document.getElementById('bench-eyebrow').textContent = 'Strength benchmark';
  document.getElementById('bench-title').innerHTML = exercise.replace(' ', ' <em>') + '</em>';
  document.getElementById('bench-val').textContent = weight;
  document.getElementById('bench-unit').textContent = unit;
  document.getElementById('bench-val-label').textContent = 'your best set';

  // Spectrum
  var pct = Math.min(95, Math.max(5, (ratio / 2.5) * 100));
  setTimeout(function() {
    document.getElementById('bench-marker').style.left = pct + '%';
  }, 100);
  document.getElementById('bench-ticks').innerHTML = ['Beginner', 'Novice', 'Intermediate', 'Advanced', 'Elite'].map(function(t) {
    return '<span>' + t + '</span>';
  }).join('');

  var currentTierIdx = 0;
  for (var i = 0; i < b.tiers.length; i++) {
    if (ratio < b.tiers[i].multiplier) { currentTierIdx = i; break; }
    if (i === b.tiers.length - 1) currentTierIdx = i;
  }

  document.getElementById('bench-tiers').innerHTML = b.tiers.map(function(tier, i) {
    var isCurrent = i === currentTierIdx;
    var actualRange = tier.multiplier < 99 ? tier.range + ' (' + Math.round(tier.multiplier * bw) + ' ' + unit + ' at your weight)' : tier.range;
    return '<div class="benchmark-tier ' + (isCurrent ? 'current' : '') + '">'
      + '<div class="benchmark-tier-dot" style="background:' + tier.color + '"></div>'
      + '<div class="benchmark-tier-info">'
      + '<div class="benchmark-tier-name">' + tier.name + '</div>'
      + '<div class="benchmark-tier-range">' + actualRange + '</div>'
      + '</div>'
      + (isCurrent ? '<div class="benchmark-tier-you">You are here</div>' : '')
      + '</div>';
  }).join('');

  document.getElementById('bench-context').innerHTML = '<p>' + b.context + '</p>';

  document.getElementById('bench-panel').classList.add('open');
  document.getElementById('bench-overlay').classList.add('open');
}

function openGenericStrengthBenchmark(exercise, weight, unit) {
  document.getElementById('bench-eyebrow').textContent = 'Strength benchmark';
  document.getElementById('bench-title').innerHTML = exercise;
  document.getElementById('bench-val').textContent = weight || '—';
  document.getElementById('bench-unit').textContent = unit || '';
  document.getElementById('bench-val-label').textContent = 'your best set';
  document.getElementById('bench-tiers').innerHTML = '';
  document.getElementById('bench-ticks').innerHTML = '';
  document.getElementById('bench-context').innerHTML = '<p>Keep logging this exercise consistently. After a few sessions you will be able to see your progression trend — the most meaningful signal is not where you start but the direction and rate you are moving.</p>';
  document.getElementById('bench-panel').classList.add('open');
  document.getElementById('bench-overlay').classList.add('open');
}

function closeBenchmark() {
  document.getElementById('bench-panel').classList.remove('open');
  document.getElementById('bench-overlay').classList.remove('open');
}

// ── DATE NAVIGATION ──
var pageSelectedDate = {
  dashboard: new Date(),
  meals: new Date(),
  strength: null // null = all time
};

function formatDateLabel(date, page) {
  if (page === 'strength' && !date) return '<em>All Time</em>';
  var today = new Date();
  var yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  var todayStr = today.toDateString();
  var yesterdayStr = yesterday.toDateString();
  if (date.toDateString() === todayStr) return '<em>Today</em>';
  if (date.toDateString() === yesterdayStr) return 'Yesterday';
  // Same year - omit year
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function getSelectedDateStr(page) {
  var d = pageSelectedDate[page];
  if (!d) return null;
  return localDateStr(d);
}

function stepDate(page, dir) {
  var current = pageSelectedDate[page] || new Date();
  var next = new Date(current);
  // Step by appropriate unit based on view
  if (page === 'meals' && mealsView === 'week') {
    next.setDate(next.getDate() + dir * 7);
  } else if (page === 'meals' && mealsView === 'month') {
    next.setMonth(next.getMonth() + dir);
  } else {
    next.setDate(next.getDate() + dir);
  }
  // Don't go into future
  var today = new Date();
  today.setHours(23,59,59,999);
  if (next > today) return;
  pageSelectedDate[page] = next;
  updateDateNav(page);
  reloadPageData(page);
}

function goToday(page) {
  if (page === 'strength') {
    pageSelectedDate[page] = null;
  } else {
    pageSelectedDate[page] = new Date();
  }
  updateDateNav(page);
  reloadPageData(page);
}

function updateDateNav(page) {
  var date = pageSelectedDate[page];
  var labelEl = document.getElementById(page + '-date-label');
  var nextBtn = document.getElementById(page + '-next-btn');
  var todayBtn = document.getElementById(page + '-today-btn');
  if (labelEl) labelEl.innerHTML = formatDateLabel(date, page);
  
  // Disable next button if on today
  if (nextBtn) {
    var isToday = !date || date.toDateString() === new Date().toDateString();
    nextBtn.disabled = isToday;
  }
  // Highlight today button if on today/all-time
  if (todayBtn) {
    var isDefault = page === 'strength' ? !date : (!date || date.toDateString() === new Date().toDateString());
    todayBtn.classList.toggle('active', isDefault);
  }
}

function reloadPageData(page) {
  if (page === 'dashboard') loadDashboardData();
  if (page === 'strength') renderStrengthPage();
  if (page === 'meals') {
    // Sync mealsDate from the shared pageSelectedDate system, then reload
    mealsDate = pageSelectedDate['meals'] || new Date();
    updateMealsDateLabel();
    loadMealsPage();
  }
}

// ── WEEKLY INSIGHTS ──
async function loadWeeklyInsights() {
  if (!currentUser) return;
  var token = getToken();
  try {
    // Get insights from current week
    var weekStart = new Date();
    var dayOfWeek = weekStart.getDay();
    var daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(weekStart.getDate() - daysBack); // Monday
    var weekStartStr = localDateStr(weekStart);
    var insights = await supabaseRequest(
      '/rest/v1/weekly_insights?user_id=eq.' + currentUser.id + '&week_start=gte.' + weekStartStr + '&order=created_at.desc&limit=5',
      'GET', null, token
    ).catch(function() { return []; });
    if (!insights || insights.error || !Array.isArray(insights) || insights.length === 0) {
      // Try last week
      var lastWeek = new Date(weekStart);
      lastWeek.setDate(lastWeek.getDate() - 7);
      insights = await supabaseRequest(
        '/rest/v1/weekly_insights?user_id=eq.' + currentUser.id + '&week_start=gte.' + localDateStr(lastWeek) + '&order=created_at.desc&limit=5',
        'GET', null, token
      ).catch(function() { return []; });
    }
    if (!insights || insights.error || !Array.isArray(insights) || insights.length === 0) return;
    renderWeeklyInsights(insights);
  } catch(e) { /* weekly_insights table may not exist yet */ }
}

function renderWeeklyInsights(insights) {
  var section = document.getElementById('weekly-insights-section');
  var list = document.getElementById('weekly-insights-list');
  if (!section || !list) return;
  section.style.display = 'block';
  var riskColors = { low: 'risk-low', moderate: 'risk-moderate', high: 'risk-high' };
  list.innerHTML = insights.map(function(ins) {
    var riskCls = riskColors[ins.risk_level] || 'risk-low';
    var encoded = encodeURIComponent(ins.insight_text.substring(0, 100));
    return '<div class="insight-card">'
      + '<div class="insight-card-risk ' + riskCls + '">' + escapeHtml(ins.risk_level || 'low') + '</div>'
      + '<div class="insight-card-content">'
      + '<div class="insight-card-text">' + escapeHtml(ins.insight_text) + '</div>'
      + '<a href="#" onclick="event.preventDefault();HealixChat.openWithQuestion(decodeURIComponent(\'' + encoded + '\'))" class="insight-card-discuss">Discuss with Healix →</a>'
      + '</div></div>';
  }).join('');
}

// ── HEALTH SUMMARIES ──
async function loadHealthSummary() {
  if (!currentUser) return;
  var token = getToken();
  try {
    var summaries = await supabaseRequest(
      '/rest/v1/user_health_summaries?user_id=eq.' + currentUser.id + '&summary_type=eq.weekly&order=created_at.desc&limit=1',
      'GET', null, token
    ).catch(function() { return []; });
    if (!summaries || summaries.error || !Array.isArray(summaries) || summaries.length === 0) return;
    renderHealthSummaryCard(summaries[0]);
  } catch(e) { /* user_health_summaries table may not exist yet */ }
}

function renderHealthSummaryCard(summary) {
  var section = document.getElementById('health-summary-section');
  var content = document.getElementById('health-summary-content');
  if (!section || !content) return;
  var text = summary.summary_text || summary.content || '';
  if (!text) return;
  section.style.display = 'block';
  content.innerHTML = safeMarkdownDashboard(text);
}

function safeMarkdownDashboard(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--cream)">$1</strong>')
    .replace(/\n/g, '<br>');
}

// ── ACCOUNT-BASED SHARING ──
// Users grant access by email to coaches who have Healix accounts.
// Coaches see a "Shared with Me" section in the sidebar to switch to client views.

var _shareDetails = { myShares: [], sharedWithMe: [] };

async function loadShareDetails() {
  var session = getSession();
  if (!session || !session.access_token) return;

  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/get-share-details', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token
      },
      body: '{}'
    });
    if (!res.ok) return;
    _shareDetails = await res.json();

    renderSharePeople(_shareDetails.myShares);
    renderSharedWithMe(_shareDetails.sharedWithMe);
  } catch (e) {
    console.error('[Share] Error loading details:', e);
  }
}

async function grantShareAccess() {
  var input = document.getElementById('share-email-input');
  var alertEl = document.getElementById('share-alert');
  var email = (input.value || '').trim();
  if (!email) return;

  alertEl.style.display = 'none';
  var session = getSession();
  if (!session || !session.access_token) return;

  try {
    // 1. Look up user by email
    var lookupRes = await fetch(SUPABASE_URL + '/functions/v1/lookup-user-by-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ email: email })
    });

    if (!lookupRes.ok) {
      var err = await lookupRes.json().catch(function() { return {}; });
      if (err.error === 'not_found') {
        showShareAlert('No Healix account found for this email.', 'error');
      } else if (err.error === 'cannot_share_self') {
        showShareAlert('You cannot share your dashboard with yourself.', 'error');
      } else {
        showShareAlert('Something went wrong. Please try again.', 'error');
      }
      return;
    }

    var target = await lookupRes.json();

    // 2. Insert dashboard_permissions row via PostgREST
    await supabaseRequest('/rest/v1/dashboard_permissions', 'POST', {
      owner_id: session.user.id,
      viewer_id: target.userId
    }, session.access_token, { 'Prefer': 'return=minimal' });

    input.value = '';
    var name = [target.firstName, target.lastName].filter(Boolean).join(' ') || email;
    showShareAlert('Access granted to ' + name + '.', 'success');
    loadShareDetails();
  } catch (e) {
    console.error('[Share] Error granting access:', e);
    // Duplicate key means already shared
    if (e.message && e.message.indexOf('409') !== -1) {
      showShareAlert('This person already has access.', 'error');
    } else {
      showShareAlert('Something went wrong. Please try again.', 'error');
    }
  }
}

function showShareAlert(msg, type) {
  var alertEl = document.getElementById('share-alert');
  if (!alertEl) return;
  alertEl.textContent = msg;
  alertEl.style.display = 'block';
  alertEl.style.color = type === 'error' ? 'var(--down)' : 'var(--up)';
}

async function revokeShareAccess(permId) {
  var session = getSession();
  if (!session || !session.access_token) return;

  try {
    await supabaseRequest(
      '/rest/v1/dashboard_permissions?id=eq.' + permId,
      'DELETE', null, session.access_token
    );
    loadShareDetails();
  } catch (e) {
    console.error('[Share] Error revoking:', e);
  }
}

function renderSharePeople(shares) {
  var container = document.getElementById('share-people');
  if (!container) return;

  if (!shares || shares.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0">No one has access yet.</div>';
    return;
  }

  var html = '';
  shares.forEach(function(s) {
    var name = [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email || 'Unknown';
    var sub = s.email || '';

    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--dark-3);border:1px solid var(--gold-border)">';
    html += '<div style="display:flex;align-items:center;gap:10px">';
    html += '<div style="width:28px;height:28px;border:1px solid var(--gold-border);display:grid;place-items:center;font-size:11px;color:var(--gold);font-family:var(--F)">' + escapeHtml(name.charAt(0).toUpperCase()) + '</div>';
    html += '<div>';
    html += '<div style="font-size:13px;color:var(--cream)">' + escapeHtml(name) + '</div>';
    if (sub) html += '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + escapeHtml(sub) + '</div>';
    html += '</div>';
    html += '</div>';
    html += '<button onclick="revokeShareAccess(\'' + s.id + '\')" style="background:none;border:1px solid var(--error-border);color:var(--down);font-family:var(--B);font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:6px 12px;cursor:pointer;transition:all .2s">Revoke</button>';
    html += '</div>';
  });
  container.innerHTML = html;
}

// ── SHARED WITH ME (coach sidebar) ──

function renderSharedWithMe(clients) {
  var container = document.getElementById('shared-with-me-list');
  var section = document.getElementById('shared-with-me-section');
  if (!container || !section) return;

  if (!clients || clients.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  var html = '';
  clients.forEach(function(c) {
    var name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Client';
    var initial = name.charAt(0).toUpperCase();
    html += '<button class="nav-item client-nav-item" data-owner-id="' + escapeHtml(c.ownerId) + '" onclick="switchToClientView(\'' + c.ownerId + '\', \'' + escapeHtml(name).replace(/'/g, "\\'") + '\')">';
    html += '<span class="client-avatar">' + escapeHtml(initial) + '</span> ' + escapeHtml(name);
    html += '</button>';
  });
  container.innerHTML = html;
}

// ── CLIENT VIEW SWITCHER ──

var _ownProfileData = null; // stash viewer's own profile when switching to client

var _clientSwitchId = 0; // incremented on each switch to cancel stale loads

async function switchToClientView(ownerId, name) {
  var session = getSession();
  if (!session || !session.access_token) return;

  // Cancel any in-flight client load from a previous switch
  var switchId = ++_clientSwitchId;

  _viewingUserId = ownerId;
  _viewingUserName = name;

  // Save viewer's own profile so we can restore it later
  if (!_ownProfileData) {
    _ownProfileData = window.userProfileData;
  }

  // Override supabaseRequest to proxy through the edge function
  if (!_origSupabaseRequest) {
    _origSupabaseRequest = supabaseRequest;
  }
  supabaseRequest = function(endpoint, method, body, token, extraHeaders) {
    // Block mutations in client view
    if (method && method !== 'GET') {
      return Promise.resolve(null);
    }
    var sess = getSession();
    return fetch(SUPABASE_URL + '/functions/v1/proxy-shared-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + (sess ? sess.access_token : SUPABASE_ANON_KEY)
      },
      body: JSON.stringify({ viewUserId: ownerId, endpoint: endpoint })
    }).then(function(r) {
      if (r.status === 401 || r.status === 403) {
        console.warn('[Share] Auth failure from proxy — session expired');
        handleAuthFailure();
        return Promise.reject(new Error('auth_failure'));
      }
      if (!r.ok) return null;
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') === -1) return null;
      return r.text().then(function(t) { return t ? JSON.parse(t) : null; });
    }).catch(function(e) {
      if (e && e.message === 'auth_failure') return null;
      console.error('[Share] Proxy error:', e);
      return null;
    });
  };

  // Fetch the client's profile via proxy (needed for vitality age, BMI, etc.)
  try {
    var clientProfile = await supabaseRequest(
      '/rest/v1/profiles?auth_user_id=eq.' + ownerId + '&limit=1', 'GET'
    );
    if (clientProfile && Array.isArray(clientProfile) && clientProfile.length > 0) {
      window.userProfileData = clientProfile[0];
    }
  } catch (e) {
    console.warn('[Share] Could not load client profile:', e);
  }

  // Visual: add shared-mode class, show back button, update header
  document.body.classList.add('shared-mode');
  var backBtn = document.getElementById('back-to-my-dashboard');
  if (backBtn) backBtn.style.display = 'flex';
  document.getElementById('page-title').textContent = escapeHtml(name) + "'s Dashboard";
  var eyebrow = document.getElementById('va-eyebrow');
  if (eyebrow) eyebrow.textContent = escapeHtml(name).toUpperCase() + "'S VITALITY AGE";

  // Clear stale values so the coach's own data doesn't flash
  var clearIds = ['va-age', 'va-delta', 'va-composite', 'drv-heart-val', 'drv-weight-val',
    'drv-strength-val', 'drv-aerobic-val', 'drv-bloodwork-val', 'drv-sleep-val',
    'drv-heart-status', 'drv-weight-status', 'drv-strength-status', 'drv-aerobic-status',
    'drv-bloodwork-status', 'drv-sleep-status'];
  clearIds.forEach(function(cid) {
    var el = document.getElementById(cid);
    if (el) el.textContent = '—';
  });

  // Highlight the active client in sidebar
  var items = document.querySelectorAll('.client-nav-item');
  items.forEach(function(el) { el.classList.remove('active'); });
  items.forEach(function(el) {
    if (el.getAttribute('data-owner-id') === ownerId) el.classList.add('active');
  });

  // Bail if user already clicked a different client while profile was loading
  if (switchId !== _clientSwitchId) return;

  // Navigate to dashboard page and reload data with client's profile
  showPage('dashboard', document.querySelector('.nav-item'));
  loadDashboardData();
}

function switchToOwnView() {
  // Restore original supabaseRequest
  if (_origSupabaseRequest) {
    supabaseRequest = _origSupabaseRequest;
    _origSupabaseRequest = null;
  }

  _viewingUserId = null;
  _viewingUserName = null;

  // Restore viewer's own profile data
  if (_ownProfileData) {
    window.userProfileData = _ownProfileData;
    _ownProfileData = null;
  }

  document.body.classList.remove('shared-mode');
  var backBtn = document.getElementById('back-to-my-dashboard');
  if (backBtn) backBtn.style.display = 'none';
  var eyebrow = document.getElementById('va-eyebrow');
  if (eyebrow) eyebrow.textContent = 'YOUR VITALITY AGE';

  // Clear active state on client nav items
  var items = document.querySelectorAll('.client-nav-item');
  items.forEach(function(el) { el.classList.remove('active'); });

  // Restore own name in header
  var profile = window.userProfileData;
  var firstName = profile ? (profile.first_name || '') : '';
  document.getElementById('page-title').textContent = greet() + ', ' + (firstName || 'there');

  // Reload own data
  showPage('dashboard', document.querySelector('.nav-item'));
  loadDashboardData();
}

// ── SHARE/EXPORT ──
function shareBloodwork() {
  // Generate a printable bloodwork summary
  var el = document.getElementById('bw-biomarkers');
  if (!el || !selectedBloodworkDate) return;
  var printWin = window.open('', '_blank');
  if (!printWin) { alert('Please allow pop-ups to generate the report.'); return; }
  var samples = bloodworkByDate[selectedBloodworkDate] || [];
  var dateLabel = new Date(selectedBloodworkDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  var profileName = '';
  if (window.userProfileData) {
    profileName = [window.userProfileData.first_name, window.userProfileData.last_name].filter(Boolean).join(' ');
  }
  var html = '<!DOCTYPE html><html><head><title>Healix Bloodwork Report</title>'
    + '<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a}'
    + 'h1{font-size:24px;font-weight:300;margin-bottom:4px}h2{font-size:14px;color:#666;font-weight:400;margin-bottom:32px}'
    + 'table{width:100%;border-collapse:collapse;margin-bottom:24px}'
    + 'th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#999;padding:8px 0;border-bottom:2px solid #eee}'
    + 'td{padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}'
    + '.flag-h{color:#e55;font-weight:600}.flag-l{color:#2a7;font-weight:600}.flag-normal{color:#555}'
    + '.footer{margin-top:40px;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:16px}'
    + '@media print{body{margin:0}}</style></head><body>'
    + '<h1>Bloodwork Report' + (profileName ? ' — ' + escapeHtml(profileName) : '') + '</h1>'
    + '<h2>Lab results from ' + escapeHtml(dateLabel) + '</h2>'
    + '<table><thead><tr><th>Biomarker</th><th>Value</th><th>Unit</th><th>Reference</th><th>Flag</th></tr></thead><tbody>';
  samples.forEach(function(s) {
    var flagCls = s.flag === 'H' ? 'flag-h' : s.flag === 'L' ? 'flag-l' : 'flag-normal';
    var flagLabel = s.flag === 'H' ? 'HIGH' : s.flag === 'L' ? 'LOW' : s.flag === 'A' ? 'ABN' : 'Normal';
    html += '<tr><td>' + escapeHtml(s.biomarker_name) + '</td>'
      + '<td><strong>' + (s.value !== null ? s.value : escapeHtml(s.value_text || '—')) + '</strong></td>'
      + '<td>' + escapeHtml(s.unit || '') + '</td>'
      + '<td>' + escapeHtml(s.reference_range || '') + '</td>'
      + '<td class="' + flagCls + '">' + flagLabel + '</td></tr>';
  });
  html += '</tbody></table>'
    + '<div class="footer">Generated by Healix · usehealix.com · ' + new Date().toLocaleDateString() + '</div>'
    + '</body></html>';
  printWin.document.write(html);
  printWin.document.close();
  printWin.print();
}

// ── SHAREABLE SCORE CARD ──
function generateShareCard() {
  var result = window._lastVitalityResult;
  if (!result || !result.vAge) { alert('Load your dashboard first to generate a card.'); return; }
  var realAge = window.userProfileData ? (window.userProfileData.age || calcAge(window.userProfileData.birth_date)) : null;
  var diff = realAge ? realAge - result.vAge : 0;

  document.fonts.ready.then(function() {
    var canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 630;
    var ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0B0B0B';
    ctx.fillRect(0, 0, 1200, 630);

    // Gold radial accent
    var grad = ctx.createRadialGradient(900, -50, 0, 900, -50, 500);
    grad.addColorStop(0, 'rgba(184,151,90,0.12)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1200, 630);

    // Eyebrow
    ctx.font = '500 11px "DM Sans", sans-serif';
    ctx.letterSpacing = '3px';
    ctx.fillStyle = 'rgba(184,151,90,0.6)';
    ctx.fillText('YOUR VITALITY AGE', 80, 80);

    // Vitality age number
    ctx.font = '300 120px "Cormorant Garamond", serif';
    ctx.fillStyle = '#F5F0E8';
    ctx.fillText(String(result.vAge), 80, 200);

    // Delta
    if (diff > 0) {
      ctx.font = '500 22px "DM Sans", sans-serif';
      ctx.fillStyle = '#6fcf8a';
      ctx.fillText(diff + ' years younger', 80, 240);
    } else if (diff < 0) {
      ctx.font = '500 22px "DM Sans", sans-serif';
      ctx.fillStyle = '#e07070';
      ctx.fillText(Math.abs(diff) + ' years to improve', 80, 240);
    }

    // Composite score arc placeholder
    ctx.font = '400 14px "DM Sans", sans-serif';
    ctx.fillStyle = 'rgba(245,240,232,0.35)';
    ctx.fillText('Composite Score: ' + result.composite + '/100', 80, 280);

    // Driver scores
    var drivers = [
      { label: 'Heart Rate', name: 'hr', id: 'drv-heart-val' },
      { label: 'Weight', name: 'weight', id: 'drv-weight-val' },
      { label: 'Strength', name: 'strength', id: 'drv-strength-val' },
      { label: 'VO2 Max', name: 'aerobic', id: 'drv-aerobic-val' },
      { label: 'Blood Work', name: 'bloodwork', id: 'drv-bloodwork-val' }
    ];
    var drvY = 340;
    var drvX = 80;
    var scores = result.scores || [];

    drivers.forEach(function(d, i) {
      var el = document.getElementById(d.id);
      var displayVal = el ? el.textContent.trim() : '—';
      var scoreObj = scores.find(function(s) { return s.name === d.name; });
      var score = scoreObj ? scoreObj.score : 0;
      var barColor = score >= 70 ? '#6fcf8a' : score >= 40 ? '#B8975A' : score > 0 ? '#e07070' : 'rgba(245,240,232,0.1)';

      // Label
      ctx.font = '400 11px "DM Sans", sans-serif';
      ctx.fillStyle = 'rgba(245,240,232,0.4)';
      ctx.fillText(d.label.toUpperCase(), drvX, drvY + i * 50);

      // Value
      ctx.font = '300 22px "Cormorant Garamond", serif';
      ctx.fillStyle = '#F5F0E8';
      ctx.fillText(displayVal, drvX, drvY + i * 50 + 24);

      // Bar background
      ctx.fillStyle = 'rgba(245,240,232,0.08)';
      ctx.fillRect(drvX + 240, drvY + i * 50 + 10, 300, 4);

      // Bar fill
      ctx.fillStyle = barColor;
      ctx.fillRect(drvX + 240, drvY + i * 50 + 10, score * 3, 4);
    });

    // Branding
    ctx.font = '400 24px "Cormorant Garamond", serif';
    ctx.fillStyle = '#B8975A';
    ctx.fillText('HEALIX', 1020, 580);
    ctx.font = '400 11px "DM Sans", sans-serif';
    ctx.fillStyle = 'rgba(184,151,90,0.5)';
    ctx.fillText('usehealix.com', 1020, 600);

    // Decorative border line
    ctx.strokeStyle = 'rgba(184,151,90,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(20, 20, 1160, 590);

    // Export
    canvas.toBlob(function(blob) {
      if (navigator.share && navigator.canShare) {
        var file = new File([blob], 'healix-vitality-age.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'My Healix Vitality Age' }).catch(function() {
            downloadShareBlob(blob);
          });
          return;
        }
      }
      downloadShareBlob(blob);
    }, 'image/png');
  });
}

function downloadShareBlob(blob) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'healix-vitality-age.png';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function calcAge(birthDate) {
  if (!birthDate) return 35;
  var bd = new Date(birthDate);
  var now = new Date();
  var age = now.getFullYear() - bd.getFullYear();
  if (now.getMonth() < bd.getMonth() || (now.getMonth() === bd.getMonth() && now.getDate() < bd.getDate())) age--;
  return age;
}

// ── PREMIUM GATES ──
function getUserTier() {
  var profile = window.userProfileData || {};
  return profile.subscription_tier || 'free';
}

function isPremium() {
  var tier = getUserTier();
  return tier === 'premium' || tier === 'clinical';
}

function renderPremiumGate(containerId, featureName) {
  var container = document.getElementById(containerId);
  if (!container) return;
  if (isPremium()) return; // No gate for premium users
  container.classList.add('premium-gate');
  container.insertAdjacentHTML('beforeend',
    '<div class="premium-cta">'
    + '<div class="premium-cta-text">Upgrade to unlock ' + escapeHtml(featureName) + '</div>'
    + '<button class="premium-cta-btn" onclick="showPage(\'profile\',null)">Upgrade</button>'
    + '</div>'
  );
}

// ── HEALTH MILESTONES TIMELINE ──
var MILESTONE_DEFINITIONS = [
  { id: 'first_bloodwork', label: 'First bloodwork uploaded', icon: '&#9733;',
    detect: function(ctx) {
      if (ctx.bloodworkDates && ctx.bloodworkDates.length > 0) {
        return { date: ctx.bloodworkDates[ctx.bloodworkDates.length - 1] };
      }
      // Fallback: dashboard data loaded bloodwork but bloodwork page hasn't been visited yet
      if (ctx.metrics && ctx.metrics.bloodwork) {
        return { date: ctx.bloodworkTimestamp || null };
      }
      if (window._bloodworkRawCount > 0) {
        return { date: null };
      }
      return null;
    }
  },
  { id: 'hr_below_60', label: 'Resting HR dropped below 60 bpm', icon: '&#9829;',
    detect: function(ctx) {
      if (ctx.metrics && ctx.metrics.hr && ctx.metrics.hr < 60) return { date: null };
      return null;
    }
  },
  { id: 'all_drivers', label: 'All 5 data sources connected', icon: '&#9670;',
    detect: function(ctx) {
      if (ctx.result && ctx.result.scores) {
        var connected = ctx.result.scores.filter(function(s) { return s.score > 0; }).length;
        if (connected >= 5) return { date: null };
      }
      return null;
    }
  },
  { id: 'va_improved_2', label: 'Vitality Age improved 2+ years', icon: '&#9650;',
    detect: function(ctx) {
      if (ctx.vaHistory && ctx.vaHistory.length >= 2) {
        var first = ctx.vaHistory[0];
        var last = ctx.vaHistory[ctx.vaHistory.length - 1];
        if (first.vAge - last.vAge >= 2) return { date: last.date };
      }
      return null;
    }
  },
  { id: 'first_strength', label: 'First strength test logged', icon: '&#9679;',
    detect: function(ctx) {
      if (ctx.metrics && ctx.metrics.strengthData && ctx.metrics.strengthData.testCount > 0) return { date: null };
      return null;
    }
  },
  { id: 'composite_80', label: 'Composite score reached 80+', icon: '&#9733;',
    detect: function(ctx) {
      if (ctx.result && ctx.result.composite >= 80) return { date: null };
      return null;
    }
  }
];

function renderMilestones() {
  var container = document.getElementById('milestones-section');
  if (!container) return;

  // Build context from existing globals
  var vaHistory = [];
  try { vaHistory = JSON.parse(localStorage.getItem('healix_va_history_' + currentUser.id) || '[]'); } catch(e) {}
  var bwDates = Object.keys(bloodworkByDate || {}).filter(function(d) { return d !== 'unknown'; }).sort();
  var ctx = {
    metrics: window._lastDashboardMetrics || null,
    result: window._lastVitalityResult || null,
    vaHistory: vaHistory,
    bloodworkDates: bwDates,
    bloodworkTimestamp: window._lastDashboardTimestamps && window._lastDashboardTimestamps.bloodwork || null
  };

  var achieved = [];
  var pending = [];
  MILESTONE_DEFINITIONS.forEach(function(m) {
    var result = m.detect(ctx);
    if (result) {
      achieved.push({ id: m.id, label: m.label, icon: m.icon, date: result.date });
    } else {
      pending.push({ id: m.id, label: m.label, icon: m.icon });
    }
  });

  // Show section only if at least 1 achieved
  if (achieved.length === 0) { container.style.display = 'none'; return; }

  var html = '<div class="milestones-card">';
  html += '<div class="milestones-header">Health Milestones</div>';
  html += '<div class="milestone-list">';

  // Achieved milestones
  achieved.forEach(function(m, i) {
    var dateText = m.date ? new Date(m.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Achieved';
    html += '<div class="milestone-item">';
    html += '<div class="milestone-dot-wrap"><div class="milestone-dot"></div>';
    if (i < achieved.length - 1 || pending.length > 0) html += '<div class="milestone-line"></div>';
    html += '</div>';
    html += '<div class="milestone-content"><div class="milestone-label">' + m.icon + ' ' + escapeHtml(m.label) + '</div><div class="milestone-date">' + dateText + '</div></div>';
    html += '</div>';
  });

  // Show up to 2 pending milestones as "up next"
  var nextGoals = pending.slice(0, 2);
  nextGoals.forEach(function(m, i) {
    html += '<div class="milestone-item pending">';
    html += '<div class="milestone-dot-wrap"><div class="milestone-dot pending"></div>';
    if (i < nextGoals.length - 1) html += '<div class="milestone-line"></div>';
    html += '</div>';
    html += '<div class="milestone-content"><div class="milestone-label">' + m.icon + ' ' + escapeHtml(m.label) + '</div><div class="milestone-date">Up next</div></div>';
    html += '</div>';
  });

  html += '</div></div>';
  container.innerHTML = html;
  container.style.display = 'block';
}

// ── ONBOARDING CHECKLIST ──
function getChecklistLabel(itemKey, goal) {
  var labels = {
    wearable: {
      sleep_better: 'Connect Healix app to start tracking your sleep patterns',
      improve_endurance: 'Connect Healix app to track your heart rate and activity',
      default: 'Connect Healix app to sync your health data'
    },
    bloodwork: {
      sleep_better: 'Upload labs to check magnesium & vitamin D for sleep',
      longevity: 'Upload labs — they\'re worth 35% of your Vitality Age',
      default: 'Upload bloodwork to unlock biomarker scoring'
    },
    fitness: {
      gain_strength: 'Log a fitness test to see where you rank',
      longevity: 'Log a fitness test — strength predicts longevity',
      default: 'Log a fitness test for percentile benchmarks'
    },
    profile: { default: 'Complete your profile' }
  };
  var itemLabels = labels[itemKey] || { default: itemKey };
  return itemLabels[goal] || itemLabels.default;
}

function renderOnboardingChecklist() {
  var state = getDataConnectivityState();
  var container = document.getElementById('onboarding-checklist');
  if (!container) return;

  if (state.allComplete) {
    container.style.display = 'none';
    return;
  }

  var prevCount = parseInt(localStorage.getItem('healix_checklist_count_' + currentUser.id) || '0');
  var currentCount = state.totalConnected;
  var newlyCompleted = currentCount > prevCount;
  if (!_viewingUserId) localStorage.setItem('healix_checklist_count_' + currentUser.id, currentCount.toString());

  var userGoal = (window.userProfileData && window.userProfileData.primary_goal) ? window.userProfileData.primary_goal.split(',')[0].trim() : '';
  var items = [
    { key: 'profile', label: getChecklistLabel('profile', userGoal), time: '2 min', done: state.profile.connected, action: 'showPage(\'profile\', null)' },
    { key: 'wearable', label: getChecklistLabel('wearable', userGoal), time: '1 min', done: state.wearable.connected, action: 'openConnectHealthBiteModal()' },
    { key: 'fitness', label: getChecklistLabel('fitness', userGoal), time: '3 min', done: state.fitness.tested, action: 'showPage(\'strength\', null)' },
    { key: 'bloodwork', label: getChecklistLabel('bloodwork', userGoal), time: '2 min', done: state.bloodwork.uploaded, action: 'showPage(\'documents\', null)' }
  ];

  var squaresHtml = '';
  for (var i = 0; i < 4; i++) {
    var filled = i < currentCount;
    squaresHtml += '<div class="checklist-square' + (filled ? ' filled' : '') + (filled && newlyCompleted && i === currentCount - 1 ? ' flash' : '') + '"></div>';
  }

  var itemsHtml = '';
  items.forEach(function(item) {
    itemsHtml += '<div class="checklist-item' + (item.done ? ' done' : '') + '" onclick="' + item.action + '">'
      + '<div class="checklist-check">' + (item.done ? '&#10003;' : '&#9675;') + '</div>'
      + '<div class="checklist-label">' + escapeHtml(item.label) + '</div>'
      + '<div class="checklist-time">' + escapeHtml(item.time) + '</div>'
      + '</div>';
  });

  container.style.display = '';
  container.innerHTML = '<div class="checklist-card">'
    + '<div class="checklist-header">'
    + '<div class="checklist-title">Your Healix Score</div>'
    + '<div class="checklist-count">' + currentCount + ' of 4 connected</div>'
    + '</div>'
    + '<div class="checklist-squares">' + squaresHtml + '</div>'
    + '<div class="checklist-items">' + itemsHtml + '</div>'
    + '</div>';
}

// ── SMART EMPTY STATES ──
function renderSmartEmptyStates(vitalityResult) {
  // Vitality Age — show guidance only when no result was calculated
  if (!vitalityResult) {
    var confidence = document.getElementById('va-confidence');
    if (confidence) {
      confidence.innerHTML = 'Upload bloodwork (35% of your score) or add your height and weight to unlock your Vitality Age.';
      confidence.className = 'vitality-confidence amber';
    }
  }
}

// ── ONBOARDING WIZARD ──
var quizData = null;
try {
  var _rawQuiz = localStorage.getItem('healix_quiz_data');
  if (_rawQuiz) quizData = JSON.parse(_rawQuiz);
} catch(e) {}
var hasQuizData = !!(quizData && quizData.goals && quizData.goals.length > 0);

var onboardingState = {
  firstName: '', lastName: '',
  birthYear: null, gender: 'prefer-not-to-say',
  measurementSystem: 'imperial', height: '', weight: '',
  primaryGoals: [], targetWeight: '',
  activityLevel: 'moderately_active', fitnessLevel: 'beginner',
  healthConditions: [], dietaryRestrictions: [],
  hasAppleWatch: true,
  quizWearable: '', quizMotivation: ''
};
var onboardingStep = 1;
// Non-quiz users get 2 extra steps (wearable + motivation) after step 7
var ONBOARDING_TOTAL_STEPS = hasQuizData ? 7 : 9;

function checkOnboarding() {
  // An empty profile row is auto-created for every auth user by the
  // on_auth_user_created DB trigger. Presence of first_name (filled by
  // either Healix web or HealthBite mobile onboarding) is the signal
  // that onboarding was actually completed.
  var p = window.userProfileData;
  if (p && p.first_name && String(p.first_name).trim() !== '') return;
  showOnboardingWizard();
}

function showOnboardingWizard() {
  // Pre-fill from profile / auth metadata
  var profile = window.userProfileData || {};
  var user = currentUser || {};
  var meta = user.user_metadata || {};
  var fullName = meta.full_name || '';
  onboardingState.firstName = profile.first_name || (fullName ? fullName.split(' ')[0] : '');
  onboardingState.lastName = profile.last_name || (fullName ? fullName.split(' ').slice(1).join(' ') : '');
  onboardingStep = 1;

  // Pre-fill from quiz data if available
  if (hasQuizData) {
    var goalMap = {
      'goal-energy': 'feel_better',
      'goal-sleep': 'sleep_better',
      'goal-workout': 'improve_endurance',
      'goal-focus': 'feel_better',
      'goal-mood': 'feel_better',
      'goal-longevity': 'longevity'
    };
    var mappedGoals = [];
    quizData.goals.forEach(function(g) {
      var mapped = goalMap[g];
      if (mapped && mappedGoals.indexOf(mapped) === -1) mappedGoals.push(mapped);
    });
    if (mappedGoals.length > 0) onboardingState.primaryGoals = mappedGoals;
    if (quizData.wearable === 'wearable-apple') onboardingState.hasAppleWatch = true;
    else if (quizData.wearable === 'wearable-none') onboardingState.hasAppleWatch = false;
  }

  var overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.id = 'onboarding-overlay';
  overlay.innerHTML = '<div class="onboarding-card" id="ob-card">' + renderOnboardingStep(1) + '</div>';
  document.body.appendChild(overlay);
}

function renderOnboardingStep(step) {
  var dots = '<div class="ob-dots">';
  for (var i = 1; i <= ONBOARDING_TOTAL_STEPS; i++) {
    var cls = i === step ? 'active' : (i < step ? 'done' : '');
    dots += '<div class="ob-dot ' + cls + '"></div>';
  }
  dots += '</div>';

  var backBtn = step > 1 ? '<button class="ob-btn ob-btn-back" onclick="onboardingBack()">Back</button>' : '<div class="ob-nav-spacer"></div>';
  var obStepTotal = ONBOARDING_TOTAL_STEPS - 1; // Exclude welcome screen from count

  if (step === 1) {
    return '<div class="ob-title">Hey there! I\'m <em>Healix</em></div>'
      + '<div class="ob-subtitle">Your personal health intelligence dashboard. Let\'s get your profile set up so I can give you the most accurate insights.</div>'
      + '<div class="ob-subtitle" style="color:var(--muted);font-size:12px;margin-bottom:0">This takes about 2 minutes. You can always update these later in your profile.</div>'
      + '<div class="ob-nav">' + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Get Started</button></div>';
  }

  if (step === 2) {
    return '<div class="ob-step-indicator">Step 1 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">What\'s your name?</div>'
      + '<div class="ob-subtitle">We\'ll use this to personalize your experience.</div>'
      + '<div class="ob-row">'
      + '<div class="ob-field"><div class="ob-label">First Name</div>'
      + '<input class="ob-input" id="ob-first-name" type="text" placeholder="First name" value="' + escapeHtml(onboardingState.firstName) + '" onkeydown="if(event.key===\'Enter\')onboardingNext()"></div>'
      + '<div class="ob-field"><div class="ob-label">Last Name</div>'
      + '<input class="ob-input" id="ob-last-name" type="text" placeholder="Last name" value="' + escapeHtml(onboardingState.lastName) + '" onkeydown="if(event.key===\'Enter\')onboardingNext()"></div>'
      + '</div>'
      + '<div class="ob-error" id="ob-error">Please enter your first and last name.</div>'
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button></div>';
  }

  if (step === 3) {
    var currentYear = new Date().getFullYear();
    var yearVal = onboardingState.birthYear || '';
    var genderOptions = [
      { val: 'male', label: 'Male' },
      { val: 'female', label: 'Female' },
      { val: 'non-binary', label: 'Non-Binary' },
      { val: 'prefer-not-to-say', label: 'Prefer not to say' }
    ];
    var genderHtml = '<div class="ob-gender-row">';
    genderOptions.forEach(function(g) {
      var sel = onboardingState.gender === g.val ? ' selected' : '';
      genderHtml += '<div class="ob-card' + sel + '" onclick="onboardingSelectGender(\'' + g.val + '\')">'
        + '<div class="ob-card-label">' + g.label + '</div></div>';
    });
    genderHtml += '</div>';

    return '<div class="ob-step-indicator">Step 2 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">About You</div>'
      + '<div class="ob-subtitle">This helps us calculate age-adjusted health scores.</div>'
      + '<div class="ob-field"><div class="ob-label">Birth Year</div>'
      + '<input class="ob-input" id="ob-birth-year" type="number" min="1920" max="' + currentYear + '" placeholder="e.g. 1990" value="' + yearVal + '" onkeydown="if(event.key===\'Enter\')onboardingNext()"></div>'
      + '<div class="ob-error" id="ob-error">Please enter a valid birth year.</div>'
      + '<div class="ob-field"><div class="ob-label">Biological Sex</div>' + genderHtml + '</div>'
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button></div>';
  }

  if (step === 4) {
    var sys = onboardingState.measurementSystem;
    var wPlaceholder = sys === 'imperial' ? 'e.g. 170' : 'e.g. 77';
    var wLabel = sys === 'imperial' ? 'Weight (lbs)' : 'Weight (kg)';

    // Parse stored height back into components for pre-fill
    var obFt = '', obIn = '', obM = '', obCm = '';
    if (sys === 'imperial' && onboardingState.height) {
      var ftInParts = (onboardingState.height + '').match(/(\d+)\s*[''′]\s*(\d+)/);
      if (ftInParts) { obFt = ftInParts[1]; obIn = ftInParts[2]; }
    } else if (sys === 'metric' && onboardingState.height) {
      var totalCm = parseInt(onboardingState.height);
      if (totalCm) { obM = Math.floor(totalCm / 100); obCm = totalCm % 100; }
    }

    var heightHtml;
    if (sys === 'imperial') {
      heightHtml = '<div class="ob-field"><div class="ob-label">Height</div>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + '<input class="ob-input" id="ob-height-ft" type="number" min="3" max="8" placeholder="ft" value="' + obFt + '" style="flex:1;text-align:center" onkeydown="if(event.key===\'Enter\')document.getElementById(\'ob-height-in\').focus()">'
        + '<span style="color:var(--muted);font-size:13px">ft</span>'
        + '<input class="ob-input" id="ob-height-in" type="number" min="0" max="11" placeholder="in" value="' + obIn + '" style="flex:1;text-align:center" onkeydown="if(event.key===\'Enter\')document.getElementById(\'ob-weight\').focus()">'
        + '<span style="color:var(--muted);font-size:13px">in</span>'
        + '</div></div>';
    } else {
      heightHtml = '<div class="ob-field"><div class="ob-label">Height</div>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + '<input class="ob-input" id="ob-height-m" type="number" min="1" max="2" placeholder="m" value="' + obM + '" style="flex:1;text-align:center" onkeydown="if(event.key===\'Enter\')document.getElementById(\'ob-height-cm\').focus()">'
        + '<span style="color:var(--muted);font-size:13px">m</span>'
        + '<input class="ob-input" id="ob-height-cm" type="number" min="0" max="99" placeholder="cm" value="' + obCm + '" style="flex:1;text-align:center" onkeydown="if(event.key===\'Enter\')document.getElementById(\'ob-weight\').focus()">'
        + '<span style="color:var(--muted);font-size:13px">cm</span>'
        + '</div></div>';
    }

    return '<div class="ob-step-indicator">Step 3 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">Body Metrics</div>'
      + '<div class="ob-subtitle">Used for BMI and vitality age calculations.</div>'
      + '<div class="ob-unit-toggle">'
      + '<div class="ob-unit-btn' + (sys === 'imperial' ? ' active' : '') + '" onclick="onboardingToggleUnit(\'imperial\')">Imperial</div>'
      + '<div class="ob-unit-btn' + (sys === 'metric' ? ' active' : '') + '" onclick="onboardingToggleUnit(\'metric\')">Metric</div>'
      + '</div>'
      + '<div class="ob-row">'
      + heightHtml
      + '<div class="ob-field"><div class="ob-label">' + wLabel + '</div>'
      + '<input class="ob-input" id="ob-weight" type="number" placeholder="' + wPlaceholder + '" value="' + escapeHtml(onboardingState.weight) + '" onkeydown="if(event.key===\'Enter\')onboardingNext()"></div>'
      + '</div>'
      + '<div class="ob-error" id="ob-error">Please enter your height and weight.</div>'
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button></div>';
  }

  if (step === 5) {
    var goals = [
      { val: 'lose_weight', icon: '\u2696\uFE0F', label: 'Lose Weight' },
      { val: 'gain_strength', icon: '\uD83D\uDCAA', label: 'Build Muscle' },
      { val: 'improve_endurance', icon: '\uD83C\uDFC3', label: 'Improve Endurance' },
      { val: 'feel_better', icon: '\u2728', label: 'Feel Better' },
      { val: 'sleep_better', icon: '\uD83D\uDE34', label: 'Sleep Better' },
      { val: 'longevity', icon: '\uD83C\uDF31', label: 'Longevity' }
    ];
    var goalsHtml = '<div class="ob-cards">';
    goals.forEach(function(g) {
      var sel = onboardingState.primaryGoals.indexOf(g.val) !== -1 ? ' selected' : '';
      goalsHtml += '<div class="ob-card' + sel + '" onclick="onboardingToggleGoal(\'' + g.val + '\')">'
        + '<div class="ob-card-icon">' + g.icon + '</div>'
        + '<div class="ob-card-label">' + g.label + '</div></div>';
    });
    goalsHtml += '</div>';

    var showTarget = onboardingState.primaryGoals.indexOf('lose_weight') !== -1 || onboardingState.primaryGoals.indexOf('gain_strength') !== -1;
    var twLabel = onboardingState.measurementSystem === 'imperial' ? 'Target Weight (lbs)' : 'Target Weight (kg)';

    return '<div class="ob-step-indicator">Step 4 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">What\'s your goal?</div>'
      + '<div class="ob-subtitle">We\'ll tailor your dashboard and insights accordingly.</div>'
      + goalsHtml
      + '<div class="ob-target-weight' + (showTarget ? ' visible' : '') + '" id="ob-target-weight-wrap">'
      + '<div class="ob-field" style="margin-top:12px"><div class="ob-label">' + twLabel + '</div>'
      + '<input class="ob-input" id="ob-target-weight" type="number" placeholder="Optional" value="' + escapeHtml(onboardingState.targetWeight) + '"></div>'
      + '</div>'
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button></div>';
  }

  if (step === 6) {
    var activities = [
      { val: 'sedentary', icon: '\uD83D\uDCBB', label: 'Sedentary', desc: 'Mostly sitting' },
      { val: 'lightly_active', icon: '\uD83D\uDEB6', label: 'Lightly Active', desc: '1\u20132 days/week' },
      { val: 'moderately_active', icon: '\uD83C\uDFC3', label: 'Moderately Active', desc: '3\u20135 days/week' },
      { val: 'very_active', icon: '\uD83D\uDD25', label: 'Very Active', desc: '6\u20137 days/week' }
    ];
    var fitnessLevels = [
      { val: 'beginner', label: 'Beginner', desc: 'New to fitness' },
      { val: 'intermediate', label: 'Intermediate', desc: 'Regular exerciser' },
      { val: 'advanced', label: 'Advanced', desc: 'Experienced athlete' }
    ];
    var actHtml = '<div class="ob-cards">';
    activities.forEach(function(a) {
      var sel = onboardingState.activityLevel === a.val ? ' selected' : '';
      actHtml += '<div class="ob-card' + sel + '" onclick="onboardingSelectActivity(\'' + a.val + '\')">'
        + '<div class="ob-card-icon">' + a.icon + '</div>'
        + '<div class="ob-card-label">' + a.label + '</div>'
        + '<div class="ob-card-desc">' + a.desc + '</div></div>';
    });
    actHtml += '</div>';

    var fitHtml = '<div class="ob-cards" style="grid-template-columns:1fr 1fr 1fr">';
    fitnessLevels.forEach(function(f) {
      var sel = onboardingState.fitnessLevel === f.val ? ' selected' : '';
      fitHtml += '<div class="ob-card' + sel + '" onclick="onboardingSelectFitness(\'' + f.val + '\')">'
        + '<div class="ob-card-label">' + f.label + '</div>'
        + '<div class="ob-card-desc">' + f.desc + '</div></div>';
    });
    fitHtml += '</div>';

    return '<div class="ob-step-indicator">Step 5 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">Activity Level</div>'
      + '<div class="ob-subtitle">Helps us set realistic baselines for your metrics.</div>'
      + '<div class="ob-field"><div class="ob-label">How active are you?</div>' + actHtml + '</div>'
      + '<div class="ob-field"><div class="ob-label">Fitness Level</div>' + fitHtml + '</div>'
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button></div>';
  }

  if (step === 7) {
    var conditions = ['Diabetes', 'Hypertension', 'Heart Disease', 'Asthma', 'Thyroid', 'High Cholesterol', 'Arthritis', 'Anxiety/Depression'];
    var restrictions = ['Vegetarian', 'Vegan', 'Gluten-Free', 'Dairy-Free', 'Keto', 'Paleo', 'Halal', 'Kosher'];

    var condHtml = '<div class="ob-pills">';
    condHtml += '<div class="ob-pill' + (onboardingState.healthConditions.length === 0 ? ' selected' : '') + '" onclick="onboardingToggleNone(\'conditions\')">None</div>';
    conditions.forEach(function(c) {
      var sel = onboardingState.healthConditions.indexOf(c) > -1 ? ' selected' : '';
      condHtml += '<div class="ob-pill' + sel + '" onclick="onboardingTogglePill(this,\'conditions\',\'' + escapeHtml(c) + '\')">' + escapeHtml(c) + '</div>';
    });
    condHtml += '</div>';

    var restHtml = '<div class="ob-pills">';
    restHtml += '<div class="ob-pill' + (onboardingState.dietaryRestrictions.length === 0 ? ' selected' : '') + '" onclick="onboardingToggleNone(\'restrictions\')">None</div>';
    restrictions.forEach(function(r) {
      var sel = onboardingState.dietaryRestrictions.indexOf(r) > -1 ? ' selected' : '';
      restHtml += '<div class="ob-pill' + sel + '" onclick="onboardingTogglePill(this,\'restrictions\',\'' + escapeHtml(r) + '\')">' + escapeHtml(r) + '</div>';
    });
    restHtml += '</div>';

    var watchOn = onboardingState.hasAppleWatch;

    var step7Cta = hasQuizData
      ? '<button class="ob-btn ob-btn-primary" onclick="completeOnboarding()">Complete Setup</button>'
      : '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button>';

    return '<div class="ob-step-indicator">Step 6 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">Health & Device</div>'
      + '<div class="ob-subtitle">Optional info to refine your insights.</div>'
      + '<div class="ob-field"><div class="ob-label">Health Conditions</div>' + condHtml + '</div>'
      + '<div class="ob-field"><div class="ob-label">Dietary Restrictions</div>' + restHtml + '</div>'
      + '<div class="ob-toggle-row">'
      + '<div><div class="ob-toggle-label">Apple Watch</div><div class="ob-toggle-sub">Enables heart rate and activity tracking</div></div>'
      + '<div class="ob-switch' + (watchOn ? ' on' : '') + '" id="ob-watch-toggle" onclick="onboardingToggleWatch()"></div>'
      + '</div>'
      + '<div class="ob-nav">' + backBtn + dots + step7Cta + '</div>';
  }

  // Steps 8 & 9 — only for non-quiz users
  if (step === 8 && !hasQuizData) {
    var wearables = [
      { val: 'wearable-apple', label: 'Apple Watch' },
      { val: 'wearable-oura', label: 'Oura Ring' },
      { val: 'wearable-whoop', label: 'Whoop' },
      { val: 'wearable-fitbit', label: 'Fitbit' },
      { val: 'wearable-none', label: 'Nothing yet' }
    ];
    var wearHtml = '<div class="ob-cards">';
    wearables.forEach(function(w) {
      var sel = onboardingState.quizWearable === w.val ? ' selected' : '';
      wearHtml += '<div class="ob-card' + sel + '" onclick="onboardingSelectWearable(\'' + w.val + '\')">'
        + '<div class="ob-card-label">' + w.label + '</div></div>';
    });
    wearHtml += '</div>';

    return '<div class="ob-step-indicator">Step 7 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">What do you track with?</div>'
      + '<div class="ob-subtitle">Helps us personalize your setup experience.</div>'
      + wearHtml
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="onboardingNext()">Continue</button></div>';
  }

  if (step === 9 && !hasQuizData) {
    var motivations = [
      { val: 'why-wall', label: 'Hit a wall' },
      { val: 'why-diagnosis', label: 'Recent diagnosis' },
      { val: 'why-proactive', label: 'Getting ahead' },
      { val: 'why-better', label: 'Want to feel better' },
      { val: 'why-curious', label: 'Just curious' }
    ];
    var motHtml = '<div class="ob-cards">';
    motivations.forEach(function(m) {
      var sel = onboardingState.quizMotivation === m.val ? ' selected' : '';
      motHtml += '<div class="ob-card' + sel + '" onclick="onboardingSelectMotivation(\'' + m.val + '\')">'
        + '<div class="ob-card-label">' + m.label + '</div></div>';
    });
    motHtml += '</div>';

    return '<div class="ob-step-indicator">Step 8 of ' + obStepTotal + '</div>'
      + '<div class="ob-title">What brought you to Healix?</div>'
      + '<div class="ob-subtitle">This helps us understand what matters most to you.</div>'
      + motHtml
      + '<div class="ob-nav">' + backBtn + dots + '<button class="ob-btn ob-btn-primary" onclick="completeOnboarding()">Complete Setup</button></div>';
  }

  return '';
}

function onboardingNext() {
  var valid = validateOnboardingStep(onboardingStep);
  if (!valid) return;
  saveOnboardingStepData(onboardingStep);
  onboardingStep++;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
  var firstInput = document.querySelector('#ob-card .ob-input');
  if (firstInput) firstInput.focus();
}

function onboardingBack() {
  saveOnboardingStepData(onboardingStep);
  onboardingStep--;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function validateOnboardingStep(step) {
  if (step === 2) {
    var fn = (document.getElementById('ob-first-name') || {}).value || '';
    var ln = (document.getElementById('ob-last-name') || {}).value || '';
    if (!fn.trim() || !ln.trim()) {
      var err = document.getElementById('ob-error');
      if (err) err.classList.add('visible');
      return false;
    }
  }
  if (step === 3) {
    var year = parseInt((document.getElementById('ob-birth-year') || {}).value);
    var now = new Date().getFullYear();
    if (!year || year < 1920 || year > now) {
      var err = document.getElementById('ob-error');
      if (err) err.classList.add('visible');
      return false;
    }
  }
  if (step === 4) {
    var unit = onboardingState.measurementSystem;
    var hCm = null;
    if (unit === 'imperial') {
      var ft = parseInt((document.getElementById('ob-height-ft') || {}).value) || 0;
      var inches = parseInt((document.getElementById('ob-height-in') || {}).value) || 0;
      if (ft >= 3 && ft <= 8) hCm = (ft * 12 + inches) * 2.54;
    } else {
      var m = parseInt((document.getElementById('ob-height-m') || {}).value) || 0;
      var cm = parseInt((document.getElementById('ob-height-cm') || {}).value) || 0;
      if (m >= 1 && m <= 2) hCm = m * 100 + cm;
    }
    var wKg = parseWeight((document.getElementById('ob-weight') || {}).value || '', unit === 'imperial' ? 'lbs' : 'kg');
    if (!hCm || !wKg) {
      var err = document.getElementById('ob-error');
      if (err) err.classList.add('visible');
      return false;
    }
  }
  return true;
}

function saveOnboardingStepData(step) {
  if (step === 2) {
    onboardingState.firstName = ((document.getElementById('ob-first-name') || {}).value || '').trim();
    onboardingState.lastName = ((document.getElementById('ob-last-name') || {}).value || '').trim();
  }
  if (step === 3) {
    onboardingState.birthYear = parseInt((document.getElementById('ob-birth-year') || {}).value) || null;
  }
  if (step === 4) {
    if (onboardingState.measurementSystem === 'imperial') {
      var ft = (document.getElementById('ob-height-ft') || {}).value || '';
      var inches = (document.getElementById('ob-height-in') || {}).value || '0';
      onboardingState.height = ft + '\'' + inches + '"';
    } else {
      var m = (document.getElementById('ob-height-m') || {}).value || '0';
      var cm = (document.getElementById('ob-height-cm') || {}).value || '0';
      onboardingState.height = '' + (parseInt(m) * 100 + parseInt(cm));
    }
    onboardingState.weight = ((document.getElementById('ob-weight') || {}).value || '').trim();
  }
  if (step === 5) {
    onboardingState.targetWeight = ((document.getElementById('ob-target-weight') || {}).value || '').trim();
  }
}

function onboardingSelectGender(val) {
  // Save birth year before re-render so typed value isn't lost
  var yearEl = document.getElementById('ob-birth-year');
  if (yearEl) onboardingState.birthYear = parseInt(yearEl.value) || null;
  onboardingState.gender = val;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingToggleGoal(val) {
  var idx = onboardingState.primaryGoals.indexOf(val);
  if (idx === -1) {
    onboardingState.primaryGoals.push(val);
  } else {
    onboardingState.primaryGoals.splice(idx, 1);
  }
  var tw = document.getElementById('ob-target-weight');
  if (tw) onboardingState.targetWeight = tw.value.trim();
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingSelectActivity(val) {
  onboardingState.activityLevel = val;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingSelectFitness(val) {
  onboardingState.fitnessLevel = val;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingToggleUnit(sys) {
  onboardingState.height = ((document.getElementById('ob-height') || {}).value || '').trim();
  onboardingState.weight = ((document.getElementById('ob-weight') || {}).value || '').trim();
  onboardingState.measurementSystem = sys;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingTogglePill(el, listKey, val) {
  var arr = listKey === 'conditions' ? onboardingState.healthConditions : onboardingState.dietaryRestrictions;
  var idx = arr.indexOf(val);
  if (idx > -1) { arr.splice(idx, 1); } else { arr.push(val); }
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingToggleNone(listKey) {
  if (listKey === 'conditions') { onboardingState.healthConditions = []; }
  else { onboardingState.dietaryRestrictions = []; }
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingToggleWatch() {
  onboardingState.hasAppleWatch = !onboardingState.hasAppleWatch;
  var toggle = document.getElementById('ob-watch-toggle');
  if (toggle) toggle.classList.toggle('on');
}

function onboardingSelectWearable(val) {
  onboardingState.quizWearable = val;
  if (val === 'wearable-apple') onboardingState.hasAppleWatch = true;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

function onboardingSelectMotivation(val) {
  onboardingState.quizMotivation = val;
  var card = document.getElementById('ob-card');
  if (card) card.innerHTML = renderOnboardingStep(onboardingStep);
}

async function completeOnboarding() {
  var session = getSession();
  if (!session || !currentUser) return;

  var unit = onboardingState.measurementSystem;
  var heightCm = parseHeight(onboardingState.height, unit === 'imperial' ? 'imperial' : 'metric');
  var weightKg = parseWeight(onboardingState.weight, unit === 'imperial' ? 'lbs' : 'kg');
  var bmi = (heightCm && weightKg) ? weightKg / Math.pow(heightCm / 100, 2) : null;
  var targetWeightKg = null;
  if (onboardingState.targetWeight) {
    targetWeightKg = unit === 'imperial' ? parseFloat(onboardingState.targetWeight) / 2.205 : parseFloat(onboardingState.targetWeight);
    if (isNaN(targetWeightKg)) targetWeightKg = null;
  }
  var birthDate = onboardingState.birthYear ? onboardingState.birthYear + '-01-01' : null;

  var profileData = {
    auth_user_id: currentUser.id,
    email: currentUser.email || '',
    first_name: onboardingState.firstName,
    last_name: onboardingState.lastName,
    gender: onboardingState.gender,
    height_cm: heightCm ? Math.round(heightCm * 10) / 10 : null,
    current_weight_kg: weightKg ? Math.round(weightKg * 10) / 10 : null,
    body_mass_index: bmi ? Math.round(bmi * 10) / 10 : null,
    primary_goal: onboardingState.primaryGoals.join(', ') || null,
    activity_level: onboardingState.activityLevel,
    fitness_level: onboardingState.fitnessLevel,
    has_apple_watch: onboardingState.hasAppleWatch,
    health_conditions: onboardingState.healthConditions.join(', ') || null,
    dietary_restrictions: onboardingState.dietaryRestrictions.join(', ') || null
  };

  // Add quiz fields from quiz data (quiz users) or from onboarding extra steps (non-quiz users)
  if (hasQuizData && quizData) {
    profileData.quiz_motivation = quizData.motivation || null;
    profileData.quiz_wearable = quizData.wearable || null;
    profileData.quiz_engagement_level = quizData.engagementLevel || null;
    profileData.quiz_knowledge_level = quizData.knowledgeLevel || null;
    profileData.quiz_constraints = quizData.constraints ? quizData.constraints.join(', ') : null;
    try { localStorage.removeItem('healix_quiz_data'); } catch(e) {}
  } else {
    profileData.quiz_wearable = onboardingState.quizWearable || null;
    profileData.quiz_motivation = onboardingState.quizMotivation || null;
  }

  if (birthDate) profileData.birth_date = birthDate;
  if (targetWeightKg) profileData.target_weight_kg = targetWeightKg;

  var btn = document.querySelector('#ob-card .ob-btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    // Upsert on auth_user_id because the on_auth_user_created DB trigger
    // pre-creates an empty profile row at signup. Without merge-duplicates,
    // this POST would fail with a 23505 unique-constraint violation.
    var insertResult = await supabaseRequest(
      '/rest/v1/profiles?on_conflict=auth_user_id', 'POST', profileData, getToken(),
      { 'Prefer': 'return=representation,resolution=merge-duplicates' }
    );
    console.log('[Healix] Onboarding UPSERT result:', JSON.stringify(insertResult));

    if (insertResult && insertResult.code) {
      // PostgREST error (e.g. constraint violation other than duplicate key)
      throw new Error(insertResult.message || insertResult.code);
    }

    if (insertResult && Array.isArray(insertResult) && insertResult.length > 0) {
      window.userProfileData = insertResult[0];
      populateProfileForm(insertResult[0]);
    } else {
      // INSERT succeeded but no representation — fetch it
      var newProfile = await supabaseRequest(
        '/rest/v1/profiles?auth_user_id=eq.' + currentUser.id + '&limit=1',
        'GET', null, getToken()
      );
      if (newProfile && newProfile.length > 0) {
        window.userProfileData = newProfile[0];
        populateProfileForm(newProfile[0]);
      }
    }

    // Update sidebar
    var name = [onboardingState.firstName, onboardingState.lastName].filter(Boolean).join(' ');
    if (onboardingState.firstName) {
      document.getElementById('sb-name').textContent = name;
      document.getElementById('sb-avatar').textContent = onboardingState.firstName.charAt(0).toUpperCase();
      document.getElementById('page-title').textContent = greet() + ', ' + onboardingState.firstName;
    }
    var overlay = document.getElementById('onboarding-overlay');
    if (overlay) overlay.remove();

    // Reload dashboard data with real profile
    loadDashboardData().then(function() {
      renderVitalityUnlockState();
      renderOnboardingChecklist();
      renderSmartEmptyStates(window._lastVitalityResult);
      // Show personalized "Your Plan" modal after onboarding (once only)
      if (!localStorage.getItem('healix_your_plan_shown')) {
        showYourPlan();
      }
    });
  } catch(e) {
    console.error('[Healix] Onboarding profile creation error:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Complete Setup'; }
    alert('Could not save your profile. Please try again.');
  }
}

// ── YOUR PLAN MODAL ──
var yourPlanStep = 1;

function showYourPlan() {
  var profile = window.userProfileData || {};
  var goals = (profile.primary_goal || '').split(',').map(function(g) { return g.trim(); });
  var mainGoal = goals[0] || 'feel_better';
  var wearable = profile.quiz_wearable || (profile.has_apple_watch ? 'wearable-apple' : '');
  var motivation = profile.quiz_motivation || '';

  // Card 1: Value prop based on goal
  var goalMessages = {
    'feel_better': 'We\'ll track your energy patterns across sleep, nutrition, and activity — showing you exactly what\'s draining you and what helps.',
    'lose_weight': 'We\'ll track your nutrition with AI-powered meal analysis, monitor your weight trends, and show how body composition affects your biological age.',
    'improve_endurance': 'We\'ll build your cardio profile from heart rate and VO2 max data, showing you how your fitness compares to others your age.',
    'gain_strength': 'We\'ll benchmark your strength against age-adjusted norms and track your progress over time. Every test feeds into your Vitality Age.',
    'sleep_better': 'We\'ll track your sleep stages, calculate sleep debt, and show you how sleep quality directly affects your biological age.',
    'healthier_diet': 'We\'ll analyze every meal with AI — breaking down macros, micronutrients, and dietary gaps. You\'ll see exactly where your nutrition stands.',
    'longevity': 'We\'ll calculate your Vitality Age from heart rate, bloodwork, fitness, and more — showing you exactly how to move the needle on biological aging.'
  };
  var body1El = document.getElementById('yp-body-1');
  if (body1El) body1El.textContent = goalMessages[mainGoal] || goalMessages['feel_better'];

  // Card 2: Easiest first win based on context
  var body2El = document.getElementById('yp-body-2');
  var cta2El = document.getElementById('yp-cta-2');
  var ctaHTML = '';
  if (wearable === 'wearable-apple' || profile.has_apple_watch) {
    if (body2El) body2El.textContent = 'Connect the Healix app to pull your Apple Watch data. This takes 2 minutes and immediately unlocks heart rate, sleep, and activity tracking.';
    ctaHTML = '<button class="yp-cta-btn" onclick="closeYourPlan(); openConnectHealthBiteModal();">Connect Healix App</button>';
  } else if (motivation === 'why-diagnosis') {
    if (body2El) body2El.textContent = 'Upload your lab results — we\'ll extract every biomarker and show where you stand. This is the single biggest input to your Vitality Age (35% of the score).';
    ctaHTML = '<button class="yp-cta-btn" onclick="closeYourPlan(); showPage(\'documents\', null);">Upload Lab Results</button>';
  } else {
    if (body2El) body2El.textContent = 'Log your first meal — describe what you ate and our AI will break down the full nutrition. Takes 30 seconds.';
    ctaHTML = '<button class="yp-cta-btn" onclick="closeYourPlan(); showPage(\'intake\', null); setMealDateTimeDefault(); openModal(\'meal-modal\');">Log a Meal</button>';
  }
  if (cta2El) cta2El.innerHTML = ctaHTML;

  var modal = document.getElementById('your-plan-modal');
  if (modal) modal.style.display = 'flex';
  yourPlanStep = 1;
  updateYourPlanDots();
}

function nextYourPlanStep() {
  var curStep = document.getElementById('yp-step-' + yourPlanStep);
  if (curStep) curStep.style.display = 'none';
  yourPlanStep++;
  var nextStep = document.getElementById('yp-step-' + yourPlanStep);
  if (nextStep) nextStep.style.display = 'block';
  updateYourPlanDots();
}

function updateYourPlanDots() {
  for (var i = 1; i <= 3; i++) {
    var dot = document.getElementById('yp-dot-' + i);
    if (dot) {
      if (i === yourPlanStep) { dot.classList.add('active'); }
      else { dot.classList.remove('active'); }
    }
  }
}

function closeYourPlan() {
  var modal = document.getElementById('your-plan-modal');
  if (modal) modal.style.display = 'none';
  try { localStorage.setItem('healix_your_plan_shown', 'true'); } catch(e) {}
}

// ── MEAL EDIT/DELETE ──
var editingMealId = null;

function openEditMeal(mealId) {
  editingMealId = mealId;
  // Re-read meals from the latest data to avoid stale cache
  var meals = window._healixMeals || [];
  var meal = meals.find(function(m) { return m.id === mealId; });
  if (!meal) return;
  var macros = getMacrosFromMeal(meal);
  document.getElementById('ml-name').value = meal.meal_description || meal.description || '';
  document.getElementById('ml-type').value = (meal.meal_type || 'cooked').toLowerCase();
  if (meal.meal_time) {
    var dt = new Date(meal.meal_time);
    var y = dt.getFullYear();
    var mo = String(dt.getMonth() + 1).padStart(2, '0');
    var d = String(dt.getDate()).padStart(2, '0');
    var h = String(dt.getHours()).padStart(2, '0');
    var mi = String(dt.getMinutes()).padStart(2, '0');
    document.getElementById('ml-datetime').value = y + '-' + mo + '-' + d + 'T' + h + ':' + mi;
  }
  document.getElementById('ml-cals').value = macros.cal ? Math.round(macros.cal) : '';
  document.getElementById('ml-protein').value = macros.prot ? Math.round(macros.prot) : '';
  document.getElementById('ml-carbs').value = macros.carb ? Math.round(macros.carb) : '';
  document.getElementById('ml-fat').value = macros.fat ? Math.round(macros.fat) : '';
  // Show nutrition fields if meal has macro data
  var hasNutrition = macros.cal || macros.prot || macros.carb || macros.fat;
  var nutritionFields = document.getElementById('ml-nutrition-fields');
  var nutritionArrow = document.getElementById('ml-nutrition-arrow');
  if (hasNutrition && nutritionFields) {
    nutritionFields.style.display = 'block';
    if (nutritionArrow) nutritionArrow.style.transform = 'rotate(90deg)';
  }
  // Update modal title and button
  document.querySelector('#meal-modal .modal-title').innerHTML = 'Edit <em>Intake</em>';
  document.querySelector('#meal-modal .modal-btn-primary').textContent = 'Save Changes';
  openModal('meal-modal');
}

async function deleteMeal(mealId) {
  var confirmed = await confirmModal('This entry will be permanently deleted.', { title: 'Delete Entry', confirmText: 'Delete', danger: true });
  if (!confirmed) return;
  try {
    await supabaseRequest('/rest/v1/meal_log?id=eq.' + mealId, 'DELETE', null, getToken());
    loadMealsPage();
    loadDashboardData();
  } catch(e) {
    console.error('Delete meal error:', e);
  }
}

// ── OPTION BUTTON HELPERS (used by fitness test scale) ──

function selectOptionBtn(groupId, btn) {
  var group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.opt-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
}

function selectOptionBtnByValue(groupId, value) {
  var group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.opt-btn').forEach(function(b) {
    b.classList.remove('active');
    if (b.getAttribute('data-value') === value) b.classList.add('active');
  });
}

function getOptionBtnValue(groupId) {
  var group = document.getElementById(groupId);
  if (!group) return 'none';
  var active = group.querySelector('.opt-btn.active');
  return active ? active.getAttribute('data-value') : 'none';
}

// ── GOAL HELPERS ──

function getUserGoal() {
  var g = (window.userProfileData && window.userProfileData.primary_goal) || '';
  return g.toLowerCase().trim();
}

function goalIncludes(keyword) {
  return getUserGoal().indexOf(keyword) !== -1;
}

// ── ENERGY BALANCE ──

function computeEnergyBalance(ctx, days) {
  if (!ctx.meals || ctx.meals.length === 0) return null;
  var byType = ctx.healthData;
  if (!byType) return null;
  var activeRows = byType['active_energy_burned'] || [];
  var basalRows = byType['basal_energy_burned'] || [];
  if (activeRows.length === 0 && basalRows.length === 0) return null;

  var now = new Date();
  var results = [];

  for (var d = 0; d < days; d++) {
    var checkDate = new Date(now);
    checkDate.setDate(checkDate.getDate() - d);
    var dateStr = localDateStr(checkDate);

    // Calories in (from meals)
    var calIn = 0;
    ctx.meals.forEach(function(m) {
      if (localDateStr(new Date(m.meal_time || m.created_at)) === dateStr) {
        var mac = getMacrosFromMeal(m);
        calIn += mac.cal || 0;
      }
    });

    // Calories out (from HealthKit) — source-deduped to handle iPhone+Watch overlap.
    var active = dedupedDailyTotal(activeRows, dateStr);
    var basal = dedupedDailyTotal(basalRows, dateStr);

    var calOut = Math.round(active + basal);
    if (calIn > 0 && calOut > 0) {
      results.push({ date: dateStr, calIn: Math.round(calIn), calOut: calOut, active: Math.round(active), basal: Math.round(basal), balance: Math.round(calIn - calOut) });
    }
  }

  if (results.length === 0) return null;

  var avgBalance = Math.round(results.reduce(function(s, r) { return s + r.balance; }, 0) / results.length);
  var avgIn = Math.round(results.reduce(function(s, r) { return s + r.calIn; }, 0) / results.length);
  var avgOut = Math.round(results.reduce(function(s, r) { return s + r.calOut; }, 0) / results.length);
  var avgActive = Math.round(results.reduce(function(s, r) { return s + r.active; }, 0) / results.length);
  // Predict weekly weight change: ~7700 cal = 1 kg
  var predictedWeeklyKg = Math.round((avgBalance * 7 / 7700) * 10) / 10;

  return {
    days: results,
    daysTracked: results.length,
    avgBalance: avgBalance,
    avgIn: avgIn,
    avgOut: avgOut,
    avgActive: avgActive,
    predictedWeeklyKg: predictedWeeklyKg,
    inDeficit: avgBalance < -100,
    inSurplus: avgBalance > 100
  };
}

// ── CHAT PAYWALL GATE ──

function isChatAllowed() {
  var tier = getUserTier();
  return tier === 'premium' || tier === 'clinical';
}

function showUpgradeModal() {
  var modal = document.getElementById('upgrade-modal');
  if (modal) modal.classList.add('open');
}

function closeUpgradeModal() {
  var modal = document.getElementById('upgrade-modal');
  if (modal) modal.classList.remove('open');
}

// ── STRIPE CHECKOUT & BILLING ──

var selectedPlan = 'monthly';

function selectPlan(plan) {
  selectedPlan = plan;
  document.getElementById('toggle-monthly').classList.toggle('active', plan === 'monthly');
  document.getElementById('toggle-annual').classList.toggle('active', plan === 'annual');

  if (plan === 'monthly') {
    document.getElementById('upgrade-price').innerHTML = '<span class="upgrade-price-amount">$14.99</span><span class="upgrade-price-period">/month</span>';
    document.getElementById('upgrade-save').style.display = 'none';
  } else {
    document.getElementById('upgrade-price').innerHTML = '<span class="upgrade-price-amount">$100</span><span class="upgrade-price-period">/year</span>';
    document.getElementById('upgrade-save').style.display = 'block';
  }
}

async function startCheckout() {
  var btn = document.getElementById('upgrade-cta-btn');
  btn.disabled = true;
  btn.textContent = 'Redirecting...';

  try {
    var session = getSession();
    if (!session || !session.access_token) { handleAuthFailure(); return; }
    var resp = await fetch(SUPABASE_URL + '/functions/v1/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ plan: selectedPlan })
    });

    var data = await resp.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'Failed to create checkout session');
    }
  } catch (err) {
    console.error('[Upgrade] Checkout error:', err);
    alert('Failed to start checkout. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Subscribe Now';
  }
}

async function openBillingPortal() {
  try {
    var session = getSession();
    if (!session || !session.access_token) { handleAuthFailure(); return; }
    var resp = await fetch(SUPABASE_URL + '/functions/v1/create-billing-portal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      }
    });
    var data = await resp.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'Failed to open billing portal');
    }
  } catch (err) {
    console.error('[Billing] Portal error:', err);
    alert('Failed to open billing portal.');
  }
}

function renderSubscriptionCard() {
  var el = document.getElementById('subscription-card-content');
  if (!el) return;
  var premium = isPremium();
  var tier = getUserTier();
  var tierLabel = tier === 'clinical' ? 'Clinical' : tier === 'premium' ? 'Premium' : 'Free';
  var badgeClass = premium ? 'premium' : 'free';

  var html = '<div class="subscription-status">';
  html += '<span class="subscription-badge ' + badgeClass + '">' + escapeHtml(tierLabel) + '</span>';
  html += '</div>';

  if (premium) {
    html += '<p style="font-size:12px;color:var(--cream-dim);line-height:1.6;margin-bottom:16px">You have full access to Healix AI and all premium features.</p>';
    html += '<button class="subscription-manage-btn" onclick="openBillingPortal()">Manage Subscription</button>';
  } else {
    html += '<p style="font-size:12px;color:var(--cream-dim);line-height:1.6;margin-bottom:16px">Upgrade to Premium for unlimited AI health chat. $14.99/month or $100/year.</p>';
    html += '<button class="subscription-upgrade-btn" onclick="showUpgradeModal()">Upgrade to Premium</button>';
  }

  el.innerHTML = html;
}

// ── INSIGHT ENGINE (DETERMINISTIC, NO LLM) ──

function computeMetricTrend(samples, days) {
  if (!samples || samples.length < 2) return null;
  var now = Date.now();
  var cutoff = now - days * 24 * 60 * 60 * 1000;
  var points = [];
  for (var i = 0; i < samples.length; i++) {
    var ts = new Date(samples[i].recorded_at || samples[i].start_date).getTime();
    var val = parseFloat(samples[i].value);
    if (ts >= cutoff && !isNaN(val)) {
      points.push({ t: ts, v: val });
    }
  }
  if (points.length < 2) return null;
  // Linear regression
  var n = points.length;
  var sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
  for (var j = 0; j < n; j++) {
    sumT += points[j].t; sumV += points[j].v;
    sumTV += points[j].t * points[j].v;
    sumTT += points[j].t * points[j].t;
  }
  var denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null;
  var slope = (n * sumTV - sumT * sumV) / denom;
  var avg = sumV / n;
  // Normalize slope to per-day
  var slopePerDay = slope * 86400000;
  var direction = Math.abs(slopePerDay) < 0.01 * avg ? 'stable' : slopePerDay > 0 ? 'up' : 'down';
  return { avg: Math.round(avg * 10) / 10, slope: slopePerDay, direction: direction, count: n };
}

var INSIGHT_RULES = [
  // ── Tier 1: Threshold Crossings ──
  {
    id: 'hr_threshold_crossed',
    domain: 'heart',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      var score = typeof scoreHR === 'function' ? scoreHR(ctx.metrics.hr) : null;
      if (score === null) return null;
      var tier = score >= 70 ? 'good' : score >= 40 ? 'fair' : 'low';
      // Check previous VA history for tier change
      var prevTier = null;
      if (ctx.vaHistory && ctx.vaHistory.length > 1) {
        var prev = ctx.vaHistory[ctx.vaHistory.length - 2];
        if (prev && prev.drivers && prev.drivers.hr !== undefined) {
          prevTier = prev.drivers.hr >= 70 ? 'good' : prev.drivers.hr >= 40 ? 'fair' : 'low';
        }
      }
      if (!prevTier || prevTier === tier) return null;
      return { hr: ctx.metrics.hr, score: score, tier: tier, prevTier: prevTier };
    },
    template: function(data) {
      var dir = data.tier === 'good' ? 'improved to' : 'dropped to';
      return {
        headline: 'Resting HR ' + dir + ' ' + data.tier,
        body: 'Your resting heart rate of ' + data.hr + ' bpm moved from ' + data.prevTier + ' to ' + data.tier + ' zone.',
        action: 'How can I improve my resting heart rate?'
      };
    }
  },
  {
    id: 'weight_threshold_crossed',
    domain: 'weight',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.weightScore === null || !ctx.metrics.weightScore) return null;
      var score = ctx.metrics.weightScore;
      var tier = score >= 70 ? 'good' : score >= 40 ? 'fair' : 'low';
      var prevTier = null;
      if (ctx.vaHistory && ctx.vaHistory.length > 1) {
        var prev = ctx.vaHistory[ctx.vaHistory.length - 2];
        if (prev && prev.drivers && prev.drivers.weight !== undefined) {
          prevTier = prev.drivers.weight >= 70 ? 'good' : prev.drivers.weight >= 40 ? 'fair' : 'low';
        }
      }
      if (!prevTier || prevTier === tier) return null;
      return { score: score, tier: tier, prevTier: prevTier };
    },
    template: function(data) {
      var dir = data.tier === 'good' ? 'improved to' : 'dropped to';
      return {
        headline: 'Weight score ' + dir + ' ' + data.tier,
        body: 'Your BMI-based weight score moved from ' + data.prevTier + ' to ' + data.tier + ' range.',
        action: 'What should I do about my weight trend?'
      };
    }
  },
  {
    id: 'bloodwork_flagged',
    domain: 'bloodwork',
    severity: 'alert',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.bloodwork) return null;
      var flagged = [];
      var bw = ctx.metrics.bloodwork;
      // Check individual biomarker scores
      var OPTIMAL = {
        glucose: { min: 70, max: 100, label: 'Glucose' },
        hba1c: { min: 4.0, max: 5.6, label: 'HbA1c' },
        ldl: { min: 0, max: 100, label: 'LDL' },
        hdl: { min: 40, max: 999, label: 'HDL' },
        triglycerides: { min: 0, max: 150, label: 'Triglycerides' },
        crp: { min: 0, max: 1, label: 'hs-CRP' }
      };
      for (var key in bw) {
        if (OPTIMAL[key]) {
          var val = bw[key];
          var opt = OPTIMAL[key];
          // Simple out-of-range check
          if (val < opt.min * 0.7 || val > opt.max * 1.5) {
            flagged.push({ name: opt.label, value: val });
          }
        }
      }
      if (flagged.length === 0) return null;
      return { flagged: flagged };
    },
    template: function(data) {
      var names = data.flagged.map(function(f) { return f.name; }).join(', ');
      return {
        headline: data.flagged.length + ' biomarker' + (data.flagged.length > 1 ? 's' : '') + ' flagged',
        body: names + ' ' + (data.flagged.length > 1 ? 'are' : 'is') + ' outside optimal range. Review your latest bloodwork results.',
        action: 'Which of my blood biomarkers should I focus on?'
      };
    }
  },
  {
    id: 'sleep_debt_high',
    domain: 'sleep',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var debt = ctx.metrics.sleepData.debt;
      if (debt === undefined || debt <= 7) return null;
      var goal = (ctx.profile && ctx.profile.primary_goal || '').toLowerCase();
      return { debt: debt, goal: goal };
    },
    template: function(data) {
      var extra = '';
      if (data.goal.indexOf('strength') !== -1) extra = ' Sleep debt impairs muscle recovery and strength gains.';
      else if (data.goal.indexOf('weight') !== -1) extra = ' Poor sleep increases hunger hormones and makes fat loss harder.';
      else if (data.goal.indexOf('sleep') !== -1) extra = ' This is your primary goal — prioritize consistent bedtimes.';
      else if (data.goal.indexOf('feel') !== -1) extra = ' Sleep debt directly impacts energy, mood, and how you feel day-to-day.';
      return {
        headline: 'Sleep debt is high',
        body: 'You\'ve accumulated ' + data.debt + ' hours of sleep debt over the past week.' + extra,
        action: 'How can I reduce my sleep debt?'
      };
    }
  },

  // ── Tier 2: Trends ──
  {
    id: 'hr_trend',
    domain: 'heart',
    severity: 'positive',
    detect: function(ctx) {
      var byType = ctx.healthData;
      if (!byType) return null;
      var hrSamples = byType['resting_heart_rate'] || byType['heart_rate'];
      if (!hrSamples) return null;
      var trend = computeMetricTrend(hrSamples, 7);
      if (!trend || trend.direction === 'stable') return null;
      // For HR, down is improving
      var improving = trend.direction === 'down';
      return { avg: trend.avg, slope: Math.abs(Math.round(trend.slope * 7 * 10) / 10), improving: improving, direction: trend.direction };
    },
    template: function(data) {
      var sev = data.improving ? 'positive' : 'attention';
      var word = data.improving ? 'down' : 'up';
      return {
        headline: 'Resting HR trending ' + word,
        body: (data.improving ? 'Down' : 'Up') + ' ~' + data.slope + ' bpm over 7 days — ' + (data.improving ? 'a sign of improving cardiovascular recovery.' : 'elevated stress or reduced recovery may be contributing.'),
        action: data.improving ? 'What\'s driving my heart rate improvement?' : 'Why is my resting heart rate going up?',
        _severity: sev
      };
    }
  },
  {
    id: 'hrv_trend',
    domain: 'heart',
    severity: 'positive',
    detect: function(ctx) {
      var byType = ctx.healthData;
      if (!byType) return null;
      var hrvSamples = byType['heart_rate_variability_sdnn'];
      if (!hrvSamples || hrvSamples.length < 3) return null;
      var trend = computeMetricTrend(hrvSamples, 7);
      if (!trend || trend.direction === 'stable') return null;
      // For HRV, up is improving (more variability = better recovery)
      var improving = trend.direction === 'up';
      return { avg: Math.round(trend.avg), slope: Math.abs(Math.round(trend.slope * 7 * 10) / 10), improving: improving };
    },
    template: function(data) {
      var sev = data.improving ? 'positive' : 'attention';
      var word = data.improving ? 'up' : 'down';
      return {
        headline: 'HRV trending ' + word,
        body: 'HRV averaging ' + data.avg + 'ms, ' + (data.improving ? 'up' : 'down') + ' ~' + data.slope + 'ms over 7 days. ' + (data.improving ? 'Rising HRV signals improving autonomic recovery \u2014 your body is adapting well to its current stress load.' : 'Declining HRV can signal overtraining, poor sleep, illness onset, or accumulated stress. Consider reducing training intensity or prioritizing recovery.'),
        action: data.improving ? 'What\'s driving my HRV improvement?' : 'Why is my HRV declining and what should I do?',
        _severity: sev
      };
    }
  },
  {
    id: 'hrv_low_baseline',
    domain: 'heart',
    severity: 'attention',
    detect: function(ctx) {
      var byType = ctx.healthData;
      if (!byType) return null;
      var hrvSamples = byType['heart_rate_variability_sdnn'];
      if (!hrvSamples || hrvSamples.length < 5) return null;
      var sum = 0;
      var count = Math.min(hrvSamples.length, 7);
      for (var i = 0; i < count; i++) sum += parseFloat(hrvSamples[i].value || 0);
      var avg = sum / count;
      if (avg >= 30) return null; // Only flag if consistently low
      var age = ctx.metrics && ctx.metrics.realAge || 40;
      return { avg: Math.round(avg), age: age };
    },
    template: function(data) {
      return {
        headline: 'HRV is consistently low',
        body: 'Your 7-day HRV average is ' + data.avg + 'ms. While HRV is individual and age-dependent, a sustained low baseline often reflects chronic stress, poor sleep quality, or deconditioning. The most effective levers: consistent sleep schedule, regular aerobic exercise, and stress management.',
        action: 'What can I do to improve my HRV?'
      };
    }
  },
  {
    id: 'sleep_trend',
    domain: 'sleep',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.sleepData || !ctx.metrics.sleepData.trend) return null;
      var trend = ctx.metrics.sleepData.trend;
      if (trend.direction === 'stable') return null;
      return { direction: trend.direction, thisWeek: trend.thisWeekAvg, lastWeek: trend.lastWeekAvg, delta: Math.abs(trend.deltaHours) };
    },
    template: function(data) {
      var improving = data.direction === 'improving';
      var sev = improving ? 'positive' : 'attention';
      var extra = '';
      if (goalIncludes('sleep')) {
        extra = improving ? ' Sleep duration is your primary goal metric — this improvement is encouraging.' : ' Sleep duration is your primary goal metric — this decline is concerning.';
      }
      return {
        headline: 'Sleep duration ' + (improving ? 'improving' : 'declining'),
        body: 'Averaging ' + data.thisWeek + 'h this week vs ' + data.lastWeek + 'h last week (' + (improving ? '+' : '-') + data.delta + 'h).' + extra,
        action: improving ? 'What\'s helping my sleep improve?' : 'Why is my sleep getting worse?',
        _severity: sev
      };
    }
  },
  {
    id: 'weight_trend',
    domain: 'weight',
    severity: 'neutral',
    detect: function(ctx) {
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      var points = weightEntries.map(function(w) {
        var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 };
      });
      var trend = computeMetricTrend(points, 14);
      if (!trend || trend.direction === 'stable') return null;
      var weeklyChange = Math.abs(Math.round(trend.slope * 7 * 10) / 10);
      if (weeklyChange < 0.2) return null;
      return { avg: trend.avg, weeklyChange: weeklyChange, direction: trend.direction };
    },
    template: function(data) {
      var dir = data.direction === 'down' ? 'down' : 'up';
      return {
        headline: 'Weight trending ' + dir,
        body: (dir === 'down' ? 'Down' : 'Up') + ' ~' + data.weeklyChange + ' kg/week. Current average: ' + data.avg + ' kg.',
        action: 'What\'s driving my weight ' + (dir === 'down' ? 'loss' : 'gain') + '?'
      };
    }
  },
  {
    id: 'steps_trend',
    domain: 'heart',
    severity: 'positive',
    detect: function(ctx) {
      var byType = ctx.healthData;
      if (!byType || !byType['step_count']) return null;
      var steps = byType['step_count'];
      var now = Date.now();
      var msPerDay = 86400000;
      var thisWeek = [], lastWeek = [];
      for (var i = 0; i < steps.length; i++) {
        var ts = new Date(steps[i].start_date || steps[i].recorded_at).getTime();
        var val = parseFloat(steps[i].value || 0);
        var daysAgo = (now - ts) / msPerDay;
        if (daysAgo <= 7) thisWeek.push(val);
        else if (daysAgo <= 14) lastWeek.push(val);
      }
      if (thisWeek.length === 0 || lastWeek.length === 0) return null;
      var thisAvg = thisWeek.reduce(function(s, v) { return s + v; }, 0) / thisWeek.length;
      var lastAvg = lastWeek.reduce(function(s, v) { return s + v; }, 0) / lastWeek.length;
      if (lastAvg === 0) return null;
      var pctChange = Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
      if (Math.abs(pctChange) < 10) return null;
      return { thisAvg: Math.round(thisAvg), lastAvg: Math.round(lastAvg), pctChange: pctChange };
    },
    template: function(data) {
      var improving = data.pctChange > 0;
      var sev = improving ? 'positive' : 'attention';
      return {
        headline: 'Steps ' + (improving ? 'up' : 'down') + ' ' + Math.abs(data.pctChange) + '% vs last week',
        body: 'Averaging ' + data.thisAvg.toLocaleString() + ' steps/day this week vs ' + data.lastAvg.toLocaleString() + ' last week.',
        action: improving ? 'How does my step count affect my vitality age?' : 'How can I increase my daily step count?',
        _severity: sev
      };
    }
  },

  // ── Goal-Aware Rules ──

  {
    id: 'protein_deficit',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      var goal = (ctx.profile && ctx.profile.primary_goal || '').toLowerCase();
      if (goal.indexOf('strength') === -1 && goal.indexOf('weight') === -1) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      try {
        var targets = getMacroTargets();
        if (!targets || !targets.prot || targets.prot <= 0) return null;
        var now = new Date();
        var daysHit = 0;
        var daysChecked = 0;
        for (var d = 0; d < 7; d++) {
          var checkDate = new Date(now);
          checkDate.setDate(checkDate.getDate() - d);
          var dateStr = localDateStr(checkDate);
          var dayProt = 0;
          ctx.meals.forEach(function(m) {
            var mDate = localDateStr(new Date(m.meal_time || m.created_at));
            if (mDate === dateStr) {
              var mac = getMacrosFromMeal(m);
              dayProt += mac.prot || 0;
            }
          });
          if (dayProt > 0) { daysChecked++; if (dayProt >= targets.prot * 0.8) daysHit++; }
        }
        if (daysChecked < 3) return null;
        if (daysHit >= daysChecked - 1) return null; // On track, skip deficit rule
        return { daysHit: daysHit, daysChecked: daysChecked, target: targets.prot, goal: goal };
      } catch(e) { return null; }
    },
    template: function(data) {
      var goalFrame = data.goal.indexOf('strength') !== -1
        ? 'Consistent protein intake is critical for strength gains and recovery.'
        : 'Adequate protein preserves muscle mass during a calorie deficit.';
      return {
        headline: 'Protein target hit ' + data.daysHit + ' of ' + data.daysChecked + ' days',
        body: goalFrame + ' Target: ' + data.target + 'g/day.',
        action: 'How can I hit my protein goal more consistently?'
      };
    }
  },
  {
    id: 'protein_on_track',
    domain: 'nutrition',
    severity: 'positive',
    detect: function(ctx) {
      var goal = (ctx.profile && ctx.profile.primary_goal || '').toLowerCase();
      if (goal.indexOf('strength') === -1 && goal.indexOf('weight') === -1) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      try {
        var targets = getMacroTargets();
        if (!targets || !targets.prot || targets.prot <= 0) return null;
        var now = new Date();
        var daysHit = 0;
        var daysChecked = 0;
        for (var d = 0; d < 7; d++) {
          var checkDate = new Date(now);
          checkDate.setDate(checkDate.getDate() - d);
          var dateStr = localDateStr(checkDate);
          var dayProt = 0;
          ctx.meals.forEach(function(m) {
            var mDate = localDateStr(new Date(m.meal_time || m.created_at));
            if (mDate === dateStr) {
              var mac = getMacrosFromMeal(m);
              dayProt += mac.prot || 0;
            }
          });
          if (dayProt > 0) { daysChecked++; if (dayProt >= targets.prot * 0.8) daysHit++; }
        }
        if (daysChecked < 3 || daysHit < daysChecked - 1) return null;
        return { daysHit: daysHit, daysChecked: daysChecked };
      } catch(e) { return null; }
    },
    template: function(data) {
      return {
        headline: 'Protein on target ' + data.daysHit + ' of ' + data.daysChecked + ' days',
        body: 'Keep it up — consistent protein fuels recovery and adaptation.',
        action: 'What else can I do to optimize my nutrition?'
      };
    }
  },
  {
    id: 'lift_pr',
    domain: 'strength',
    severity: 'positive',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      var tests = ctx.metrics.strengthData.tests;
      var byKey = {};
      tests.forEach(function(t) {
        if (!byKey[t.test_key]) byKey[t.test_key] = [];
        byKey[t.test_key].push(t);
      });
      var prs = [];
      var liftKeys = ['bench_1rm', 'squat_1rm', 'deadlift_1rm', 'pullup', 'pushup'];
      for (var i = 0; i < liftKeys.length; i++) {
        var k = liftKeys[i];
        var history = byKey[k];
        if (!history || history.length < 2) continue;
        var latest = parseFloat(history[0].raw_value);
        var previous = parseFloat(history[1].raw_value);
        var norm = (typeof FITNESS_NORMS !== 'undefined' && FITNESS_NORMS[k]) || {};
        var higher = norm.higherBetter !== false;
        if (higher && latest > previous) {
          var delta = Math.round((latest - previous) * 10) / 10;
          var label = norm.label || k;
          var unit = norm.unit || '';
          prs.push({ key: k, label: label, latest: latest, delta: delta, unit: unit, pctl: history[0].percentile });
        }
      }
      if (prs.length === 0) return null;
      return { prs: prs };
    },
    template: function(data) {
      var best = data.prs[0];
      var headline = 'New PR: ' + best.label + ' ' + best.latest + ' ' + best.unit;
      var body = 'Up ' + best.delta + ' ' + best.unit + ' from your previous test.';
      if (best.pctl) body += ' ' + best.pctl + 'th percentile for your age group.';
      if (data.prs.length > 1) body += ' Plus ' + (data.prs.length - 1) + ' other PR' + (data.prs.length > 2 ? 's' : '') + '.';
      return {
        headline: headline,
        body: body,
        action: 'How can I keep progressing on my lifts?'
      };
    }
  },
  {
    id: 'lift_stall',
    domain: 'strength',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      var tests = ctx.metrics.strengthData.tests;
      var byKey = {};
      tests.forEach(function(t) {
        if (!byKey[t.test_key]) byKey[t.test_key] = [];
        byKey[t.test_key].push(t);
      });
      var stalls = [];
      var liftKeys = ['bench_1rm', 'squat_1rm', 'deadlift_1rm'];
      for (var i = 0; i < liftKeys.length; i++) {
        var k = liftKeys[i];
        var history = byKey[k];
        if (!history || history.length < 2) continue;
        var latest = parseFloat(history[0].raw_value);
        var previous = parseFloat(history[1].raw_value);
        var daysBetween = (new Date(history[0].tested_at) - new Date(history[1].tested_at)) / 86400000;
        if (latest <= previous && daysBetween >= 28) {
          var norm = (typeof FITNESS_NORMS !== 'undefined' && FITNESS_NORMS[k]) || {};
          stalls.push({ key: k, label: norm.label || k, latest: latest, unit: norm.unit || 'lbs', weeks: Math.round(daysBetween / 7) });
        }
      }
      if (stalls.length === 0) return null;
      // Check protein context
      var proteinLow = false;
      try {
        var targets = getMacroTargets();
        if (targets && targets.prot > 0 && ctx.meals && ctx.meals.length > 0) {
          var now = new Date();
          var daysHit = 0;
          var daysChecked = 0;
          for (var d = 0; d < 7; d++) {
            var checkDate = new Date(now);
            checkDate.setDate(checkDate.getDate() - d);
            var dateStr = localDateStr(checkDate);
            var dayProt = 0;
            ctx.meals.forEach(function(m) {
              var mDate = localDateStr(new Date(m.meal_time || m.created_at));
              if (mDate === dateStr) { var mac = getMacrosFromMeal(m); dayProt += mac.prot || 0; }
            });
            if (dayProt > 0) { daysChecked++; if (dayProt >= targets.prot * 0.8) daysHit++; }
          }
          if (daysChecked >= 3 && daysHit < daysChecked * 0.5) proteinLow = true;
        }
      } catch(e) {}
      return { stalls: stalls, proteinLow: proteinLow };
    },
    template: function(data) {
      var s = data.stalls[0];
      var body = s.label + ' has been flat at ' + s.latest + ' ' + s.unit + ' for ' + s.weeks + '+ weeks.';
      if (data.proteinLow) body += ' Your protein intake has been under target — that may be limiting recovery.';
      return {
        headline: s.label + ' hasn\'t improved in ' + s.weeks + '+ weeks',
        body: body,
        action: 'Why are my lifts stalling and how do I break through?'
      };
    }
  },
  {
    id: 'recovery_readiness',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      var goal = (ctx.profile && ctx.profile.primary_goal || '').toLowerCase();
      if (goal.indexOf('strength') === -1 && goal.indexOf('cardio') === -1) return null;
      var sleepBad = false, hrBad = false, sleepGood = false, hrGood = false;
      if (ctx.metrics && ctx.metrics.sleepData) {
        var debt = ctx.metrics.sleepData.debt || 0;
        if (debt > 7) sleepBad = true;
        if (debt <= 3) sleepGood = true;
      }
      if (ctx.healthData) {
        var hrSamples = ctx.healthData['resting_heart_rate'] || ctx.healthData['heart_rate'];
        if (hrSamples) {
          var trend = computeMetricTrend(hrSamples, 7);
          if (trend && trend.direction === 'up') hrBad = true;
          if (trend && trend.direction === 'down') hrGood = true;
        }
      }
      if (!sleepBad && !hrBad && !sleepGood && !hrGood) return null;
      var bad = sleepBad || hrBad;
      var good = sleepGood || hrGood;
      if (!bad && !good) return null;
      return { sleepBad: sleepBad, hrBad: hrBad, sleepGood: sleepGood, hrGood: hrGood, bad: bad && !good, good: good && !bad };
    },
    template: function(data) {
      if (data.bad) {
        var reasons = [];
        if (data.sleepBad) reasons.push('sleep debt is high');
        if (data.hrBad) reasons.push('resting HR is trending up');
        return {
          headline: 'Recovery may be compromised',
          body: 'Your ' + reasons.join(' and ') + '. Consider a lighter session or active recovery today.',
          action: 'How does recovery affect my training performance?',
          _severity: 'attention'
        };
      }
      var signals = [];
      if (data.sleepGood) signals.push('sleep debt is low');
      if (data.hrGood) signals.push('resting HR is trending down');
      return {
        headline: 'Recovery looks solid',
        body: 'Your ' + signals.join(' and ') + '. Good day to push hard.',
        action: 'How can I maximize my training when recovery is good?',
        _severity: 'positive'
      };
    }
  },
  {
    id: 'domain_incomplete',
    domain: 'strength',
    severity: 'neutral',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.metrics || !ctx.metrics.strengthData) return null;
      var domains = getCompletedDomains(ctx.metrics.strengthData);
      if (domains.missing.length === 0) return null;
      if (domains.completed.length === 0) return null; // Don't nag if they haven't started
      return { completed: domains.completed.length, missing: domains.missing.map(function(d) { return d.label; }) };
    },
    template: function(data) {
      return {
        headline: data.completed + ' of 5 strength domains tested',
        body: 'Complete ' + data.missing.join(' and ') + ' for a confirmed fitness score.',
        action: 'Which fitness tests should I do next?'
      };
    }
  },
  {
    id: 'training_stale',
    domain: 'strength',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.timestamps || !ctx.timestamps.strength) return null;
      var daysSince = (Date.now() - new Date(ctx.timestamps.strength).getTime()) / 86400000;
      if (daysSince < 21) return null;
      return { weeks: Math.round(daysSince / 7) };
    },
    template: function(data) {
      return {
        headline: 'No fitness tests logged in ' + data.weeks + '+ weeks',
        body: 'Track a session to keep your strength progress visible.',
        action: 'What should I test to track my strength progress?'
      };
    }
  },
  {
    id: 'calorie_surplus',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('weight')) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      try {
        var targets = getMacroTargets();
        if (!targets || !targets.cal || targets.cal <= 0) return null;
        var now = new Date();
        var daysOver = 0;
        var daysChecked = 0;
        for (var d = 0; d < 7; d++) {
          var checkDate = new Date(now);
          checkDate.setDate(checkDate.getDate() - d);
          var dateStr = localDateStr(checkDate);
          var dayCal = 0;
          ctx.meals.forEach(function(m) {
            var mDate = localDateStr(new Date(m.meal_time || m.created_at));
            if (mDate === dateStr) { var mac = getMacrosFromMeal(m); dayCal += mac.cal || 0; }
          });
          if (dayCal > 0) { daysChecked++; if (dayCal > targets.cal * 1.1) daysOver++; }
        }
        if (daysChecked < 3 || daysOver < 3) return null;
        return { daysOver: daysOver, daysChecked: daysChecked, target: targets.cal };
      } catch(e) { return null; }
    },
    template: function(data) {
      return {
        headline: 'Calories over target ' + data.daysOver + ' of ' + data.daysChecked + ' days',
        body: 'Your calorie target is ' + data.target + ' kcal/day for weight loss. Consistent surplus will slow progress.',
        action: 'How can I manage my calorie intake better?'
      };
    }
  },

  // ── Cross-Domain Correlations (Research-Backed) ──

  {
    id: 'vo2_deep_sleep',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.vo2max === null) return null;
      if (!ctx.metrics.sleepData || !ctx.metrics.sleepData.stages) return null;
      var stages = ctx.metrics.sleepData.stages;
      var deepPct = stages.deep ? stages.deep.pct : null;
      if (deepPct === null) return null;
      return { vo2: Math.round(ctx.metrics.vo2max * 10) / 10, deepPct: deepPct, good: deepPct >= 15 };
    },
    template: function(data) {
      if (data.good) {
        return {
          headline: 'Aerobic fitness supporting deep sleep',
          body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min and ' + data.deepPct + '% deep sleep are consistent with research showing higher aerobic fitness is one of the strongest predictors of deep sleep quality.',
          action: 'How does VO2 max affect my sleep quality?',
          _severity: 'positive'
        };
      }
      var extra = goalIncludes('sleep') ? ' Since sleep is your goal, improving aerobic fitness may be one of the most impactful things you can do for deep sleep.' : '';
      return {
        headline: 'Deep sleep below target',
        body: 'Your deep sleep is ' + data.deepPct + '% (target: 15-20%). Research shows aerobic fitness is the strongest behavioral predictor of deep sleep. Your VO2 max of ' + data.vo2 + ' — improving it through cardio could directly boost deep sleep.' + extra,
        action: 'How can I increase my deep sleep percentage?',
        _severity: 'attention'
      };
    }
  },
  {
    id: 'sleep_rhr_correlation',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      if (!ctx.metrics.sleepData) return null;
      var avgSleep = ctx.metrics.sleepData.avg || ctx.metrics.sleepData.latest;
      if (!avgSleep) return null;
      var shortSleep = avgSleep < 6;
      var elevatedHr = ctx.metrics.hr > 72;
      if (!shortSleep || !elevatedHr) return null;
      return { hr: ctx.metrics.hr, sleep: Math.round(avgSleep * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'Short sleep is elevating your heart rate',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep and your resting HR is ' + data.hr + ' bpm. Research shows sleeping under 6 hours raises resting HR by 4-8 bpm through sympathetic nervous system activation. Improving sleep to 7+ hours could directly lower your resting HR.',
        action: 'How does sleep affect my resting heart rate?'
      };
    }
  },
  {
    id: 'steps_sleep_efficiency',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.steps) return null;
      if (!ctx.metrics.sleepData || !ctx.metrics.sleepData.efficiency) return null;
      var steps = ctx.metrics.steps;
      var eff = ctx.metrics.sleepData.efficiency;
      if (steps < 4000 && eff < 82) return { steps: steps, efficiency: eff, low: true };
      if (steps >= 7000 && eff >= 88) return { steps: steps, efficiency: eff, low: false };
      return null;
    },
    template: function(data) {
      if (data.low) {
        return {
          headline: 'Low activity may be hurting sleep quality',
          body: 'You logged ' + data.steps.toLocaleString() + ' steps today and your sleep efficiency is ' + data.efficiency + '%. Research shows people hitting 7,000+ steps sleep significantly more efficiently. More daytime movement could improve how well you sleep.',
          action: 'How does physical activity affect my sleep?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Activity level supporting sleep quality',
        body: 'Your ' + data.steps.toLocaleString() + ' daily steps and ' + data.efficiency + '% sleep efficiency are consistent with research linking 7,000+ steps to better sleep quality.',
        action: 'What else can I do to optimize my sleep?',
        _severity: 'positive'
      };
    }
  },
  {
    id: 'grip_strength_longevity',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      var tests = ctx.metrics.strengthData.tests;
      var grip = null;
      for (var i = 0; i < tests.length; i++) {
        if (tests[i].test_key === 'grip_strength') { grip = tests[i]; break; }
      }
      if (!grip) return null;
      var pctl = grip.percentile || 50;
      return { value: Math.round(parseFloat(grip.raw_value)), pctl: pctl, unit: 'lbs' };
    },
    template: function(data) {
      var sev = data.pctl >= 50 ? 'positive' : 'attention';
      var body = data.pctl >= 50
        ? 'Your grip strength of ' + data.value + ' ' + data.unit + ' (' + data.pctl + 'th percentile) is a powerful longevity signal. A Lancet study of 140,000 people found grip strength predicts cardiovascular death better than blood pressure.'
        : 'Your grip strength of ' + data.value + ' ' + data.unit + ' (' + data.pctl + 'th percentile) has room to improve. A Lancet study of 140,000 people found each 5 kg decrease in grip strength increases cardiovascular mortality by 17%. Dead hangs and farmer\'s walks are high-ROI exercises.';
      return { headline: 'Grip strength: ' + (data.pctl >= 50 ? 'strong longevity signal' : 'worth improving'), body: body, action: 'Why is grip strength important for longevity?', _severity: sev };
    }
  },
  {
    id: 'pushup_cardiovascular',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      var tests = ctx.metrics.strengthData.tests;
      var pushup = null;
      for (var i = 0; i < tests.length; i++) {
        if (tests[i].test_key === 'pushup') { pushup = tests[i]; break; }
      }
      if (!pushup) return null;
      var reps = Math.round(parseFloat(pushup.raw_value));
      return { reps: reps };
    },
    template: function(data) {
      var sev, body;
      if (data.reps >= 40) {
        sev = 'positive';
        body = 'You logged ' + data.reps + ' pushups. A Harvard-affiliated study found that men completing 40+ pushups had a 96% lower risk of heart events over 10 years. You\'re in the protective zone.';
      } else if (data.reps >= 10) {
        sev = 'neutral';
        body = 'You logged ' + data.reps + ' pushups. Research shows 40+ pushups is associated with 96% lower cardiovascular event risk. Building toward that threshold is a meaningful heart health goal.';
      } else {
        sev = 'attention';
        body = 'You logged ' + data.reps + ' pushups. Research links low pushup capacity (<10) to significantly higher cardiovascular risk. This is one of the simplest, most predictive fitness tests — worth building up.';
      }
      return { headline: 'Pushups: cardiovascular risk indicator', body: body, action: 'How do pushups relate to heart health?', _severity: sev };
    }
  },
  {
    id: 'vo2_rhr_consistency',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.vo2max === null || ctx.metrics.hr === null) return null;
      var vo2 = ctx.metrics.vo2max;
      var rhr = ctx.metrics.hr;
      // High VO2 should correlate with low RHR; flag inconsistency
      var highFit = vo2 >= 40;
      var highHr = rhr > 72;
      var lowFit = vo2 < 30;
      var lowHr = rhr < 60;
      if (highFit && highHr) return { vo2: Math.round(vo2 * 10) / 10, rhr: rhr, inconsistent: true };
      if (lowFit && lowHr) return { vo2: Math.round(vo2 * 10) / 10, rhr: rhr, inconsistent: true };
      if (highFit && lowHr) return { vo2: Math.round(vo2 * 10) / 10, rhr: rhr, inconsistent: false };
      return null;
    },
    template: function(data) {
      if (data.inconsistent) {
        return {
          headline: 'VO2 max and resting HR are misaligned',
          body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min and resting HR of ' + data.rhr + ' bpm don\'t match typical patterns. Research shows each 1-point VO2 increase lowers resting HR by ~0.5 bpm. A mismatch may indicate stress, dehydration, or overtraining.',
          action: 'Why is my resting heart rate higher than expected for my fitness level?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Fitness and heart rate well aligned',
        body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min and resting HR of ' + data.rhr + ' bpm are consistent. Research shows each 1-point VO2 increase lowers resting HR by ~0.5 bpm — your cardiovascular system is adapting to your fitness level.',
        action: 'How can I continue improving my cardiovascular fitness?',
        _severity: 'positive'
      };
    }
  },
  {
    id: 'sleep_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.sleepData || !ctx.metrics.bloodwork) return null;
      var avgSleep = ctx.metrics.sleepData.avg || ctx.metrics.sleepData.latest;
      if (!avgSleep) return null;
      var bw = ctx.metrics.bloodwork;
      var glucose = bw.glucose || null;
      var hba1c = bw.hba1c || null;
      if (!glucose && !hba1c) return null;
      var shortSleep = avgSleep < 6.5;
      var elevatedGlucose = (glucose && glucose > 100) || (hba1c && hba1c > 5.6);
      if (!shortSleep || !elevatedGlucose) return null;
      return { sleep: Math.round(avgSleep * 10) / 10, glucose: glucose, hba1c: hba1c };
    },
    template: function(data) {
      var markers = [];
      if (data.glucose) markers.push('fasting glucose of ' + data.glucose + ' mg/dL');
      if (data.hba1c) markers.push('HbA1c of ' + data.hba1c + '%');
      return {
        headline: 'Short sleep may be affecting blood sugar',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep with ' + markers.join(' and ') + '. Research shows sleeping under 6 hours reduces insulin sensitivity by up to 30%. Improving sleep to 7+ hours could be as impactful as dietary changes for glucose management.',
        action: 'How does sleep affect my blood sugar levels?'
      };
    }
  },
  {
    id: 'sleep_weight_gain',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var avgSleep = ctx.metrics.sleepData.avg || ctx.metrics.sleepData.latest;
      if (!avgSleep || avgSleep >= 6.5) return null;
      // Check weight trend
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      var points = weightEntries.map(function(w) { var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 }; });
      var trend = computeMetricTrend(points, 14);
      if (!trend || trend.direction !== 'up') return null;
      var weeklyGain = Math.round(trend.slope * 7 * 10) / 10;
      if (weeklyGain < 0.2) return null;
      return { sleep: Math.round(avgSleep * 10) / 10, weeklyGain: weeklyGain };
    },
    template: function(data) {
      return {
        headline: 'Short sleep linked to weight gain pattern',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep and your weight is trending up ~' + data.weeklyGain + ' kg/week. Research shows sleeping under 6 hours increases hunger hormones and drives 200-500 extra calories of intake per day. Fixing sleep is one of the most underrated weight management strategies.',
        action: 'How does sleep affect my weight?'
      };
    }
  },
  {
    id: 'activity_triglycerides',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.steps || !ctx.metrics.bloodwork) return null;
      var trig = ctx.metrics.bloodwork.triglycerides;
      if (!trig || trig <= 150) return null;
      var steps = ctx.metrics.steps;
      return { steps: steps, trig: trig, lowActivity: steps < 6000 };
    },
    template: function(data) {
      var body = 'Your triglycerides are ' + data.trig + ' mg/dL (above the 150 optimal threshold) and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day.';
      if (data.lowActivity) {
        body += ' Exercise is one of the most potent triglyceride-lowering interventions — research shows regular activity reduces them by 10-20%. Increasing to 8,000+ steps could meaningfully impact this at your next blood draw.';
      } else {
        body += ' While your activity level is reasonable, research shows exercise reduces triglycerides by 10-20%. Higher-intensity sessions or longer walks may provide additional benefit.';
      }
      return { headline: 'Activity level and triglycerides', body: body, action: 'How can I lower my triglycerides through exercise?' };
    }
  },
  {
    id: 'vo2_hdl',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.vo2max === null || !ctx.metrics.bloodwork) return null;
      var hdl = ctx.metrics.bloodwork.hdl;
      if (!hdl) return null;
      return { vo2: Math.round(ctx.metrics.vo2max * 10) / 10, hdl: hdl, lowHdl: hdl < 40 };
    },
    template: function(data) {
      if (data.lowHdl) {
        return {
          headline: 'Low HDL — aerobic fitness can help',
          body: 'Your HDL is ' + data.hdl + ' mg/dL (below the 40 mg/dL threshold) with a VO2 max of ' + data.vo2 + '. Research shows each 1-point VO2 increase raises HDL by ~0.4 mg/dL. Aerobic exercise is the most effective non-pharmaceutical HDL intervention.',
          action: 'How can I raise my HDL cholesterol?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Aerobic fitness supporting HDL levels',
        body: 'Your VO2 max of ' + data.vo2 + ' and HDL of ' + data.hdl + ' mg/dL are consistent with research showing aerobic fitness is the strongest behavioral predictor of HDL. Each 1-point VO2 increase corresponds to ~0.4 mg/dL higher HDL.',
        action: 'What else affects my HDL cholesterol?',
        _severity: 'positive'
      };
    }
  },
  {
    id: 'strength_crp',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.bloodwork) return null;
      var crp = ctx.metrics.bloodwork.crp;
      if (!crp) return null;
      var pctl = ctx.metrics.strengthData.avgPercentile;
      if (!pctl) return null;
      return { pctl: pctl, crp: crp };
    },
    template: function(data) {
      var sev = data.crp <= 1 ? 'positive' : 'attention';
      var body;
      if (data.crp > 1 && data.pctl < 50) {
        body = 'Your CRP is ' + data.crp + ' mg/L (elevated) and your strength is at the ' + data.pctl + 'th percentile. Research shows people in the top third of strength have 32% lower CRP — muscle secretes anti-inflammatory molecules (myokines) when it contracts. Consistent training may help bring inflammation down.';
      } else if (data.crp <= 1 && data.pctl >= 50) {
        body = 'Your CRP of ' + data.crp + ' mg/L (low inflammation) and ' + data.pctl + 'th percentile strength are aligned. Muscle acts as an anti-inflammatory organ — research shows stronger individuals have 32% lower CRP.';
      } else {
        body = 'Your CRP is ' + data.crp + ' mg/L and strength is at the ' + data.pctl + 'th percentile. Research links higher muscular strength to 32% lower chronic inflammation through anti-inflammatory myokine release during muscle contraction.';
      }
      return { headline: 'Strength and inflammation', body: body, action: 'How does strength training affect inflammation?', _severity: sev };
    }
  },
  {
    id: 'weight_rhr',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      var profile = ctx.profile;
      if (!profile || !profile.current_weight_kg || !profile.height_cm) return null;
      var bmi = profile.current_weight_kg / Math.pow(profile.height_cm / 100, 2);
      if (bmi < 25 || ctx.metrics.hr <= 72) return null;
      return { bmi: Math.round(bmi * 10) / 10, rhr: ctx.metrics.hr };
    },
    template: function(data) {
      return {
        headline: 'Elevated BMI contributing to higher heart rate',
        body: 'Your BMI of ' + data.bmi + ' and resting HR of ' + data.rhr + ' bpm are connected. Research shows each 1-point BMI increase raises resting HR by ~1.3 bpm. A 5-point BMI reduction typically corresponds to a 6-7 bpm drop in resting heart rate.',
        action: 'How does my weight affect my heart health?'
      };
    }
  },
  {
    id: 'protein_sleep_quality',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData || !ctx.metrics.sleepData.stages) return null;
      var deepPct = ctx.metrics.sleepData.stages.deep ? ctx.metrics.sleepData.stages.deep.pct : null;
      if (deepPct === null) return null;
      var profile = ctx.profile;
      var weightKg = profile && profile.current_weight_kg;
      if (!weightKg) return null;
      // Calculate recent avg protein per kg
      var now = new Date();
      var totalProt = 0, mealDays = 0;
      var daysSeen = {};
      ctx.meals.forEach(function(m) {
        var mDate = localDateStr(new Date(m.meal_time || m.created_at));
        var mac = getMacrosFromMeal(m);
        if (mac.prot > 0) {
          totalProt += mac.prot;
          daysSeen[mDate] = true;
        }
      });
      mealDays = Object.keys(daysSeen).length;
      if (mealDays < 3) return null;
      var dailyAvg = totalProt / mealDays;
      var perKg = Math.round((dailyAvg / weightKg) * 10) / 10;
      if (perKg >= 1.2 && deepPct >= 15) return { perKg: perKg, deepPct: deepPct, good: true };
      if (perKg < 1.0 && deepPct < 15) return { perKg: perKg, deepPct: deepPct, good: false };
      return null;
    },
    template: function(data) {
      if (data.good) {
        return {
          headline: 'Protein intake supporting sleep quality',
          body: 'Your ' + data.perKg + ' g/kg daily protein and ' + data.deepPct + '% deep sleep align with research showing higher protein intake (>1.2 g/kg) improves deep sleep through tryptophan pathways.',
          action: 'How does protein affect my sleep quality?',
          _severity: 'positive'
        };
      }
      var extra = goalIncludes('sleep') ? ' Protein affects sleep through tryptophan — especially important for your sleep goal.' : '';
      return {
        headline: 'Low protein may be affecting deep sleep',
        body: 'Your protein intake of ' + data.perKg + ' g/kg and ' + data.deepPct + '% deep sleep (target: 15-20%) are both below ideal. Research shows protein above 1.2 g/kg/day supports better sleep quality through tryptophan — a serotonin/melatonin precursor.' + extra,
        action: 'Can increasing protein improve my sleep?',
        _severity: 'attention'
      };
    }
  },
  {
    id: 'activity_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.steps || !ctx.metrics.bloodwork) return null;
      var glucose = ctx.metrics.bloodwork.glucose;
      if (!glucose || glucose <= 100) return null;
      return { steps: ctx.metrics.steps, glucose: glucose, lowActivity: ctx.metrics.steps < 6000 };
    },
    template: function(data) {
      var body = 'Your fasting glucose is ' + data.glucose + ' mg/dL (above optimal) and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day.';
      if (data.lowActivity) {
        body += ' Research shows each additional 2,000 steps/day lowers fasting glucose by about 1.5 mg/dL. Even a 10-15 minute walk after meals reduces glucose spikes by 20-30%.';
      } else {
        body += ' While your activity level is decent, post-meal walking (even 10-15 minutes) can reduce glucose spikes by 20-30% — one of the most underrated glucose management tools.';
      }
      return { headline: 'Activity and blood sugar', body: body, action: 'How does walking after meals affect my blood sugar?' };
    }
  },
  {
    id: 'overtraining_signal',
    domain: 'cross',
    severity: 'alert',
    detect: function(ctx) {
      if (!ctx.healthData || !ctx.metrics) return null;
      // Check: RHR trending up + high activity + poor sleep = overtraining
      var hrUp = false, highActivity = false, poorSleep = false;
      var byType = ctx.healthData;
      if (byType) {
        var hrSamples = byType['resting_heart_rate'] || byType['heart_rate'];
        if (hrSamples) {
          var trend = computeMetricTrend(hrSamples, 7);
          if (trend && trend.direction === 'up' && Math.abs(trend.slope * 7) >= 3) hrUp = true;
        }
      }
      if (ctx.metrics.steps && ctx.metrics.steps > 10000) highActivity = true;
      if (ctx.metrics.sleepData && ctx.metrics.sleepData.avg && ctx.metrics.sleepData.avg < 6) poorSleep = true;
      // Need at least 2 of 3 signals
      var signals = (hrUp ? 1 : 0) + (highActivity ? 1 : 0) + (poorSleep ? 1 : 0);
      if (signals < 2) return null;
      return { hrUp: hrUp, highActivity: highActivity, poorSleep: poorSleep };
    },
    template: function(data) {
      var reasons = [];
      if (data.hrUp) reasons.push('resting HR is trending up');
      if (data.poorSleep) reasons.push('sleep is under 6 hours');
      if (data.highActivity) reasons.push('activity load is high');
      return {
        headline: 'Overtraining warning',
        body: 'Multiple recovery signals are flagged: ' + reasons.join(', ') + '. This pattern is an early indicator of overtraining — your body isn\'t recovering as fast as you\'re training. Consider 2-3 days of active recovery or deload.',
        action: 'How do I know if I\'m overtraining and what should I do?'
      };
    }
  },
  {
    id: 'sleep_strength_performance',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData || !ctx.metrics.strengthData) return null;
      var avgSleep = ctx.metrics.sleepData.avg || ctx.metrics.sleepData.latest;
      if (!avgSleep || avgSleep >= 6.5) return null;
      // Check if strength is stalling or declining
      var tests = ctx.metrics.strengthData.tests;
      if (!tests || tests.length < 2) return null;
      var byKey = {};
      tests.forEach(function(t) { if (!byKey[t.test_key]) byKey[t.test_key] = []; byKey[t.test_key].push(t); });
      var stalling = false;
      ['bench_1rm', 'squat_1rm', 'deadlift_1rm'].forEach(function(k) {
        var h = byKey[k];
        if (h && h.length >= 2 && parseFloat(h[0].raw_value) <= parseFloat(h[1].raw_value)) stalling = true;
      });
      if (!stalling) return null;
      return { sleep: Math.round(avgSleep * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'Sleep may be limiting your strength gains',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep and your lifts have stalled. Research shows sleeping under 6 hours reduces maximal strength by 5-10% — and testosterone, which drives strength adaptation, is produced primarily during deep sleep. Prioritizing 7+ hours could break the plateau without changing your training.',
        action: 'How does sleep affect my strength and muscle growth?'
      };
    }
  },
  {
    id: 'weight_hba1c',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.bloodwork) return null;
      var hba1c = ctx.metrics.bloodwork.hba1c;
      if (!hba1c || hba1c <= 5.6) return null;
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      var points = weightEntries.map(function(w) { var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 }; });
      var trend = computeMetricTrend(points, 30);
      if (!trend) return null;
      return { hba1c: hba1c, direction: trend.direction, weeklyChange: Math.round(Math.abs(trend.slope * 7) * 10) / 10 };
    },
    template: function(data) {
      var body = 'Your HbA1c of ' + data.hba1c + '% is above the optimal 5.6% threshold.';
      if (data.direction === 'up') {
        body += ' Your weight is also trending up. The Diabetes Prevention Program — one of the most replicated studies in medicine — showed that losing just 5-7% of body weight reduces diabetes risk by 58% and HbA1c by up to 1 full point.';
      } else if (data.direction === 'down') {
        body += ' The good news: your weight is trending down (~' + data.weeklyChange + ' kg/week), which should improve HbA1c at your next blood draw. Losing 5-7% of body weight can reduce HbA1c by up to 1 point.';
      }
      return { headline: 'Weight and blood sugar are connected', body: body, action: 'How does weight loss affect my HbA1c?' };
    }
  },
  {
    id: 'recovery_compound',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics) return null;
      var sleepOk = ctx.metrics.sleepData && ctx.metrics.sleepData.efficiency && ctx.metrics.sleepData.efficiency >= 85;
      var hrOk = ctx.metrics.hr !== null && ctx.metrics.hr <= 65;
      // Protein check
      var protOk = false;
      try {
        var targets = getMacroTargets();
        if (targets && targets.prot > 0 && ctx.meals && ctx.meals.length > 0) {
          var now = new Date();
          var todayStr = localDateStr(now);
          var todayProt = 0;
          ctx.meals.forEach(function(m) {
            if (localDateStr(new Date(m.meal_time || m.created_at)) === todayStr) {
              var mac = getMacrosFromMeal(m);
              todayProt += mac.prot || 0;
            }
          });
          if (todayProt >= targets.prot * 0.8) protOk = true;
        }
      } catch(e) {}
      var pillars = (sleepOk ? 1 : 0) + (hrOk ? 1 : 0) + (protOk ? 1 : 0);
      if (pillars < 2) return null;
      return { sleepOk: sleepOk, hrOk: hrOk, protOk: protOk, allGood: pillars === 3 };
    },
    template: function(data) {
      if (data.allGood) {
        return {
          headline: 'All three recovery pillars in check',
          body: 'Sleep efficiency, resting heart rate, and protein intake are all in good shape. Research from the International Olympic Committee identifies these as the three pillars of recovery — you\'re covering all of them.',
          action: 'How can I maximize my training when recovery is dialed in?',
          _severity: 'positive'
        };
      }
      var weak = [];
      if (!data.sleepOk) weak.push('sleep efficiency');
      if (!data.hrOk) weak.push('resting heart rate');
      if (!data.protOk) weak.push('protein intake');
      return {
        headline: 'Recovery: 2 of 3 pillars in check',
        body: 'Your ' + weak.join(' and ') + ' could use attention. IOC research shows recovery is only as strong as its weakest pillar — focus on ' + weak[0] + ' this week.',
        action: 'What are the three pillars of recovery?',
        _severity: 'neutral'
      };
    }
  },

  // ── Nutrition Correlations ──

  {
    id: 'magnesium_sleep',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.sleepData) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        var d = localDateStr(new Date(m.meal_time || m.created_at));
        return (new Date(todayStr) - new Date(d)) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyMg = (totals['Magnesium'] || 0) / days;
      var rda = 400;
      if (dailyMg >= rda * 0.7) return null;
      var isSleepGoal = goalIncludes('sleep');
      if (!isSleepGoal) {
        var sleepIssue = ctx.metrics.sleepData.efficiency < 85 || (ctx.metrics.sleepData.avg && ctx.metrics.sleepData.avg < 6.5);
        if (!sleepIssue) return null;
      }
      return { dailyMg: Math.round(dailyMg), rda: rda, pctRda: Math.round((dailyMg / rda) * 100) };
    },
    template: function(data) {
      return {
        headline: 'Low magnesium may be affecting sleep',
        body: 'You\'re averaging ' + data.dailyMg + 'mg magnesium/day (' + data.pctRda + '% of RDA) and your sleep quality is below target. Magnesium regulates GABA receptors and melatonin production — a 2012 study in the Journal of Research in Medical Sciences found supplementing 500mg improved sleep quality, onset latency, and duration in elderly adults.',
        action: 'Should I take magnesium for sleep?'
      };
    }
  },
  {
    id: 'fiber_cholesterol',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.bloodwork) return null;
      var ldl = ctx.metrics.bloodwork.ldl;
      if (!ldl || ldl <= 100) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyFiber = (totals['Fiber'] || 0) / days;
      if (dailyFiber >= 25) return null;
      return { fiber: Math.round(dailyFiber), ldl: ldl };
    },
    template: function(data) {
      return {
        headline: 'Low fiber linked to elevated LDL',
        body: 'You\'re averaging ' + data.fiber + 'g fiber/day (target: 25-30g) with LDL at ' + data.ldl + ' mg/dL. Soluble fiber binds bile acids and directly lowers LDL — a meta-analysis in the American Journal of Clinical Nutrition found each 5-10g increase reduces LDL by 5-10 mg/dL.',
        action: 'What foods should I eat to lower my LDL cholesterol?'
      };
    }
  },
  {
    id: 'omega3_triglycerides',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.bloodwork) return null;
      var trig = ctx.metrics.bloodwork.triglycerides;
      if (!trig || trig <= 150) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyOmega = (totals['Omega-3'] || 0) / days;
      if (dailyOmega >= 1.5) return null;
      return { omega3: Math.round(dailyOmega * 10) / 10, trig: trig };
    },
    template: function(data) {
      return {
        headline: 'Low omega-3 with elevated triglycerides',
        body: 'Your triglycerides are ' + data.trig + ' mg/dL and you\'re averaging only ' + data.omega3 + 'g omega-3/day. EPA and DHA from fish oil reduce triglycerides by 15-30% at therapeutic doses (2-4g/day). Even 2-3 servings of fatty fish per week can meaningfully lower triglycerides.',
        action: 'How do omega-3s affect my triglycerides?'
      };
    }
  },
  {
    id: 'omega3_inflammation',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.bloodwork) return null;
      var crp = ctx.metrics.bloodwork.crp;
      if (!crp || crp <= 1) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyOmega = (totals['Omega-3'] || 0) / days;
      if (dailyOmega >= 1.5) return null;
      return { omega3: Math.round(dailyOmega * 10) / 10, crp: crp };
    },
    template: function(data) {
      return {
        headline: 'Low omega-3 with elevated inflammation',
        body: 'Your CRP is ' + data.crp + ' mg/L (elevated) and omega-3 intake is ' + data.omega3 + 'g/day. Omega-3 fatty acids are among the most potent dietary anti-inflammatories — a 2017 meta-analysis showed they reduce CRP by 0.2-0.5 mg/L. Fatty fish, walnuts, and flaxseed are the best food sources.',
        action: 'What anti-inflammatory foods should I eat?'
      };
    }
  },
  {
    id: 'saturated_fat_ldl',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.bloodwork) return null;
      var ldl = ctx.metrics.bloodwork.ldl;
      if (!ldl || ldl <= 100) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailySatFat = (totals['Saturated Fat'] || 0) / days;
      if (dailySatFat <= 15) return null; // Under 15g is reasonable
      return { satFat: Math.round(dailySatFat), ldl: ldl };
    },
    template: function(data) {
      return {
        headline: 'High saturated fat linked to elevated LDL',
        body: 'You\'re averaging ' + data.satFat + 'g saturated fat/day (target: under 15-20g) with LDL at ' + data.ldl + ' mg/dL. A Cochrane review found that replacing saturated fat with unsaturated sources (olive oil, nuts, avocado) reduces cardiovascular events by 17%.',
        action: 'How should I adjust my fat intake to lower LDL?'
      };
    }
  },
  {
    id: 'vitamin_d_status',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyD = (totals['Vitamin D'] || 0) / days;
      if (dailyD >= 15) return null; // 15mcg = 600 IU, getting enough
      var goal = (ctx.profile && ctx.profile.primary_goal || '').toLowerCase();
      var hasStrengthData = ctx.metrics && ctx.metrics.strengthData;
      return { dailyD: Math.round(dailyD * 10) / 10, pctRda: Math.round((dailyD / 20) * 100), goal: goal, hasStrength: !!hasStrengthData };
    },
    template: function(data) {
      var body = 'You\'re averaging ' + data.dailyD + ' mcg vitamin D/day (' + data.pctRda + '% of RDA). Most people are deficient — vitamin D is critical for bone density, immune function, and muscle strength.';
      if (data.goal.indexOf('strength') !== -1) body += ' Low vitamin D is linked to 15-20% lower testosterone and impaired muscle protein synthesis.';
      body += ' Consider supplementing 1000-2000 IU/day, especially in winter months.';
      return {
        headline: 'Vitamin D intake is low',
        body: body,
        action: 'Should I supplement vitamin D?',
        _severity: 'attention'
      };
    }
  },
  {
    id: 'iron_energy',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyIron = (totals['Iron'] || 0) / days;
      var sex = (ctx.profile && ctx.profile.sex) || 'male';
      var rda = sex === 'female' ? 18 : 8;
      if (dailyIron >= rda * 0.6) return null;
      // Check if VO2 or aerobic performance is low
      var lowAerobic = ctx.metrics && ctx.metrics.vo2max !== null && ctx.metrics.vo2max < 35;
      return { dailyIron: Math.round(dailyIron * 10) / 10, rda: rda, pctRda: Math.round((dailyIron / rda) * 100), lowAerobic: lowAerobic };
    },
    template: function(data) {
      var body = 'You\'re averaging ' + data.dailyIron + 'mg iron/day (' + data.pctRda + '% of your ' + data.rda + 'mg RDA). Iron carries oxygen to muscles — deficiency is the most common nutritional deficiency worldwide and directly impairs exercise capacity.';
      if (data.lowAerobic) body += ' Your VO2 max is also below average — iron supplementation or iron-rich foods (red meat, spinach, lentils) could help both.';
      return {
        headline: 'Iron intake below target',
        body: body,
        action: 'How does iron affect my energy and exercise performance?'
      };
    }
  },
  {
    id: 'zinc_recovery',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyZinc = (totals['Zinc'] || 0) / days;
      if (dailyZinc >= 8) return null;
      return { dailyZinc: Math.round(dailyZinc * 10) / 10, pctRda: Math.round((dailyZinc / 11) * 100) };
    },
    template: function(data) {
      return {
        headline: 'Low zinc may limit strength recovery',
        body: 'You\'re averaging ' + data.dailyZinc + 'mg zinc/day (' + data.pctRda + '% of RDA). Zinc is essential for testosterone production and muscle protein synthesis — a 1996 Wayne State study found zinc deficiency reduced testosterone by 75% in young men. Red meat, oysters, pumpkin seeds, and legumes are rich sources.',
        action: 'How does zinc affect testosterone and recovery?'
      };
    }
  },
  {
    id: 'sodium_potassium_ratio',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailySodium = (totals['Sodium'] || 0) / days;
      var dailyPotassium = (totals['Potassium'] || 0) / days;
      if (dailySodium < 2500 || dailyPotassium >= 3500) return null;
      if (dailyPotassium <= 0) return null;
      var ratio = Math.round((dailySodium / dailyPotassium) * 10) / 10;
      if (ratio < 1.5) return null;
      return { sodium: Math.round(dailySodium), potassium: Math.round(dailyPotassium), ratio: ratio };
    },
    template: function(data) {
      return {
        headline: 'Sodium-to-potassium ratio is off',
        body: 'You\'re averaging ' + data.sodium + 'mg sodium vs ' + data.potassium + 'mg potassium/day (ratio: ' + data.ratio + ':1). A 2014 WHO meta-analysis found that improving the sodium:potassium ratio is more predictive of cardiovascular outcomes than reducing sodium alone. Bananas, potatoes, spinach, and avocado are potassium-dense.',
        action: 'How should I balance sodium and potassium in my diet?'
      };
    }
  },
  {
    id: 'leucine_muscle_synthesis',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyLeucine = (totals['Leucine'] || 0) / days;
      if (dailyLeucine <= 0) return null; // No leucine data in meals
      if (dailyLeucine >= 2.5) return { dailyLeucine: Math.round(dailyLeucine * 10) / 10, adequate: true };
      return { dailyLeucine: Math.round(dailyLeucine * 10) / 10, adequate: false };
    },
    template: function(data) {
      if (data.adequate) {
        return {
          headline: 'Leucine intake supporting muscle growth',
          body: 'You\'re averaging ' + data.dailyLeucine + 'g leucine/day. Research shows 2.5g+ per meal triggers maximal muscle protein synthesis — the "leucine threshold." You\'re hitting it.',
          action: 'What else optimizes muscle protein synthesis?',
          _severity: 'positive'
        };
      }
      return {
        headline: 'Leucine may be below the anabolic threshold',
        body: 'You\'re averaging ' + data.dailyLeucine + 'g leucine/day. The "leucine threshold" — the minimum needed to trigger muscle protein synthesis — is about 2.5g per meal. Whey protein, eggs, chicken, and beef are the richest sources.',
        action: 'What is the leucine threshold and why does it matter?',
        _severity: 'attention'
      };
    }
  },
  {
    id: 'late_eating_sleep',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.sleepData) return null;
      var bedtime = ctx.metrics.sleepData.bedtime;
      if (!bedtime) return null;
      // Count meals within 2 hours of bedtime in last 7 days
      var lateDays = {};
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      // Parse bedtime to get approximate hour
      var bedHour = null;
      try {
        var parts = bedtime.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (parts) {
          bedHour = parseInt(parts[1]);
          if (parts[3].toUpperCase() === 'PM' && bedHour !== 12) bedHour += 12;
          if (parts[3].toUpperCase() === 'AM' && bedHour === 12) bedHour = 0;
        }
      } catch(e) {}
      if (bedHour === null) return null;
      var cutoffHour = bedHour - 2;
      if (cutoffHour < 0) cutoffHour += 24;
      recentMeals.forEach(function(m) {
        var mealTime = new Date(m.meal_time || m.created_at);
        var mealHour = mealTime.getHours();
        if (mealHour >= cutoffHour || (cutoffHour > 20 && mealHour < 4)) lateDays[localDateStr(mealTime)] = true;
      });
      var lateMealDays = Object.keys(lateDays).length;
      var threshold = goalIncludes('sleep') ? 2 : 3;
      if (lateMealDays < threshold) return null;
      var eff = ctx.metrics.sleepData.efficiency;
      return { count: lateMealDays, efficiency: eff };
    },
    template: function(data) {
      var body = 'You ate within 2 hours of bedtime on ' + data.count + ' occasions this week.';
      if (data.efficiency && data.efficiency < 85) {
        body += ' Your sleep efficiency of ' + data.efficiency + '% is below the 85% target.';
      }
      body += ' A British Journal of Nutrition study found late meals reduce sleep efficiency by 4-8% and deep sleep by 10-15 minutes due to elevated core body temperature. Try finishing your last meal 3+ hours before bed.';
      return {
        headline: 'Late eating affecting sleep quality',
        body: body,
        action: 'How does meal timing affect my sleep?'
      };
    }
  },
  {
    id: 'high_carb_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0 || !ctx.metrics || !ctx.metrics.bloodwork) return null;
      var glucose = ctx.metrics.bloodwork.glucose;
      var hba1c = ctx.metrics.bloodwork.hba1c;
      if ((!glucose || glucose <= 100) && (!hba1c || hba1c <= 5.6)) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totalCarbs = 0;
      recentMeals.forEach(function(m) { var mac = getMacrosFromMeal(m); totalCarbs += mac.carb || 0; });
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyCarbs = totalCarbs / days;
      if (dailyCarbs < 250) return null; // Not particularly high
      return { carbs: Math.round(dailyCarbs), glucose: glucose, hba1c: hba1c };
    },
    template: function(data) {
      var markers = [];
      if (data.glucose) markers.push('fasting glucose of ' + data.glucose + ' mg/dL');
      if (data.hba1c) markers.push('HbA1c of ' + data.hba1c + '%');
      return {
        headline: 'High carb intake with elevated blood sugar',
        body: 'You\'re averaging ' + data.carbs + 'g carbs/day with ' + markers.join(' and ') + '. A BMJ meta-analysis showed reducing refined carbs by 20-30% can lower HbA1c by 0.3-0.5%. Focus on swapping refined carbs for complex sources — whole grains, vegetables, legumes.',
        action: 'Which carbs should I eat and which should I avoid?'
      };
    }
  },
  {
    id: 'calorie_weight_discrepancy',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      try {
        var targets = getMacroTargets();
        if (!targets || !targets.cal) return null;
        var todayStr = localDateStr(new Date());
        var recentMeals = ctx.meals.filter(function(m) {
          return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 14;
        });
        if (recentMeals.length < 10) return null;
        var totalCal = 0;
        recentMeals.forEach(function(m) { var mac = getMacrosFromMeal(m); totalCal += mac.cal || 0; });
        var days = new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size;
        var dailyCal = totalCal / days;
        var points = weightEntries.map(function(w) { var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 }; });
        var trend = computeMetricTrend(points, 14);
        if (!trend) return null;
        var weeklyKg = trend.slope * 7;
        // Predict: 500 cal/day deficit ≈ 0.45 kg/week loss
        var calorieBalance = dailyCal - targets.cal; // positive = surplus
        var predictedWeeklyKg = calorieBalance / 1100; // ~1100 cal per 0.1kg
        var actualWeeklyKg = weeklyKg;
        var discrepancy = Math.abs(predictedWeeklyKg - actualWeeklyKg);
        if (discrepancy < 0.3) return null;
        var gainingOnDeficit = calorieBalance < -200 && actualWeeklyKg > 0.1;
        var losingOnSurplus = calorieBalance > 200 && actualWeeklyKg < -0.1;
        if (!gainingOnDeficit && !losingOnSurplus) return null;
        return { dailyCal: Math.round(dailyCal), target: targets.cal, gaining: gainingOnDeficit };
      } catch(e) { return null; }
    },
    template: function(data) {
      var body;
      if (data.gaining) {
        body = 'You\'re logging ' + data.dailyCal + ' kcal/day (under your ' + data.target + ' target) but your weight is still trending up. Research shows people underreport intake by 20-40% on average. Some meals may not be logged, or portion estimates may be off. Try logging everything for one strict week to calibrate.';
      } else {
        body = 'You\'re logging ' + data.dailyCal + ' kcal/day (above your ' + data.target + ' target) but losing weight. You may be more active than your calorie target accounts for, or some high-calorie items in your logs may be overestimated. Either way, your body is in a deficit.';
      }
      return {
        headline: 'Logged calories don\'t match weight trend',
        body: body,
        action: 'Why is my weight not matching my calorie intake?'
      };
    }
  },
  {
    id: 'calcium_bone_strength',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyCa = (totals['Calcium'] || 0) / days;
      if (dailyCa >= 800) return null;
      // Also check vitamin D
      var dailyD = (totals['Vitamin D'] || 0) / days;
      var bothLow = dailyD < 15;
      return { calcium: Math.round(dailyCa), pctRda: Math.round((dailyCa / 1000) * 100), bothLow: bothLow };
    },
    template: function(data) {
      var body = 'You\'re averaging ' + data.calcium + 'mg calcium/day (' + data.pctRda + '% of RDA). Calcium is essential for bone density and muscle contraction.';
      if (data.bothLow) body += ' Combined with low vitamin D, calcium absorption is further impaired — vitamin D is required to absorb calcium from the gut.';
      body += ' Dairy, fortified plant milks, sardines, and leafy greens are calcium-rich.';
      return {
        headline: 'Calcium intake below target',
        body: body,
        action: 'How much calcium do I need and what are the best sources?'
      };
    }
  },

  // ── Protein Distribution ──

  {
    id: 'protein_distribution',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('strength') && !goalIncludes('weight')) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var todayMeals = ctx.meals.filter(function(m) {
        return localDateStr(new Date(m.meal_time || m.created_at)) === todayStr;
      });
      if (todayMeals.length < 2) return null;
      var perMeal = todayMeals.map(function(m) {
        var mac = getMacrosFromMeal(m);
        return mac.prot || 0;
      });
      var maxMeal = Math.max.apply(null, perMeal);
      var totalProt = perMeal.reduce(function(s, v) { return s + v; }, 0);
      if (totalProt < 30) return null;
      // Flag if >60% of protein came from a single meal
      if (maxMeal / totalProt < 0.6) return null;
      return { total: Math.round(totalProt), maxMeal: Math.round(maxMeal), meals: todayMeals.length, pct: Math.round((maxMeal / totalProt) * 100) };
    },
    template: function(data) {
      return {
        headline: data.pct + '% of today\'s protein in one meal',
        body: data.maxMeal + 'g of your ' + data.total + 'g protein came from a single meal. Research shows muscle protein synthesis maxes out at ~40-50g per meal — spreading protein across 3-4 meals triggers more total synthesis than one large serving. Aim for 30-50g per meal.',
        action: 'How should I distribute protein across meals?'
      };
    }
  },

  // ── Strength Imbalances ──

  {
    id: 'push_pull_imbalance',
    domain: 'strength',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      var tests = ctx.metrics.strengthData.tests;
      var byKey = {};
      tests.forEach(function(t) { if (!byKey[t.test_key]) byKey[t.test_key] = t; });
      var push = byKey['bench_1rm'] || byKey['pushup'];
      var pull = byKey['pullup'] || byKey['dead_hang'];
      if (!push || !pull) return null;
      var pushPctl = push.percentile || 50;
      var pullPctl = pull.percentile || 50;
      var gap = Math.abs(pushPctl - pullPctl);
      if (gap < 25) return null;
      var pushLabel = push.test_key === 'bench_1rm' ? 'Bench Press' : 'Pushups';
      var pullLabel = pull.test_key === 'pullup' ? 'Pull-ups' : 'Dead Hang';
      return { pushLabel: pushLabel, pushPctl: pushPctl, pullLabel: pullLabel, pullPctl: pullPctl, gap: gap, pushDominant: pushPctl > pullPctl };
    },
    template: function(data) {
      var strong = data.pushDominant ? data.pushLabel : data.pullLabel;
      var weak = data.pushDominant ? data.pullLabel : data.pushLabel;
      var strongPctl = data.pushDominant ? data.pushPctl : data.pullPctl;
      var weakPctl = data.pushDominant ? data.pullPctl : data.pushPctl;
      return {
        headline: 'Push/pull strength imbalance',
        body: strong + ' is at the ' + strongPctl + 'th percentile but ' + weak + ' is only ' + weakPctl + 'th. A ' + data.gap + '-point gap between push and pull increases shoulder injury risk. Prioritize ' + weak.toLowerCase() + ' training to close the gap.',
        action: 'How do I fix a push/pull strength imbalance?'
      };
    }
  },
  {
    id: 'cardio_strength_balance',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.metrics) return null;
      var vo2 = ctx.metrics.vo2max;
      var strength = ctx.metrics.strengthData;
      if (vo2 === null || !strength) return null;
      var vo2Score = typeof scoreVO2 === 'function' ? scoreVO2(vo2, ctx.profile) : null;
      var strScore = strength.avgPercentile;
      if (vo2Score === null || !strScore) return null;
      var gap = Math.abs(vo2Score - strScore);
      if (gap < 25) return null;
      return { vo2Score: vo2Score, strScore: strScore, gap: gap, cardioWeak: vo2Score < strScore };
    },
    template: function(data) {
      var sev = 'attention';
      if (data.cardioWeak) {
        return {
          headline: 'Strong but aerobically underdeveloped',
          body: 'Your strength is at the ' + data.strScore + 'th percentile but VO2 max is only ' + data.vo2Score + 'th — a ' + data.gap + '-point gap. VO2 max is the single strongest predictor of all-cause mortality. Adding 2-3 cardio sessions per week would dramatically improve your longevity profile without sacrificing strength.',
          action: 'How can I improve cardio without losing strength?',
          _severity: sev
        };
      }
      return {
        headline: 'Good cardio but strength lagging',
        body: 'Your VO2 max is at the ' + data.vo2Score + 'th percentile but strength is only ' + data.strScore + 'th — a ' + data.gap + '-point gap. Muscle mass and strength independently predict longevity. Adding 2-3 resistance training sessions per week would balance your fitness profile.',
        action: 'How can I build strength without losing cardio fitness?',
        _severity: sev
      };
    }
  },

  // ── Additional Micronutrient Rules ──

  {
    id: 'b12_deficiency',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyB12 = (totals['Vitamin B12'] || 0) / days;
      if (dailyB12 >= 2.0) return null; // ~83% of 2.4mcg RDA
      return { daily: Math.round(dailyB12 * 10) / 10, pctRda: Math.round((dailyB12 / 2.4) * 100) };
    },
    template: function(data) {
      return {
        headline: 'Vitamin B12 intake is low',
        body: 'You\'re averaging ' + data.daily + ' mcg B12/day (' + data.pctRda + '% of RDA). B12 is essential for energy production, nerve function, and red blood cell formation. Deficiency causes fatigue, weakness, and cognitive issues. Found primarily in animal products — vegetarians and vegans are especially at risk. Supplementation is cheap and effective.',
        action: 'Should I supplement vitamin B12?'
      };
    }
  },
  {
    id: 'iron_vitamin_c_synergy',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyIron = (totals['Iron'] || 0) / days;
      var dailyC = (totals['Vitamin C'] || 0) / days;
      var sex = (ctx.profile && ctx.profile.sex) || 'male';
      var ironRda = sex === 'female' ? 18 : 8;
      // Only fire if iron is low AND vitamin C is also low
      if (dailyIron >= ironRda * 0.7) return null;
      if (dailyC >= 60) return null; // Getting enough C
      return { iron: Math.round(dailyIron * 10) / 10, vitC: Math.round(dailyC), ironRda: ironRda };
    },
    template: function(data) {
      return {
        headline: 'Low iron + low vitamin C impairs absorption',
        body: 'You\'re averaging ' + data.iron + 'mg iron/day (RDA: ' + data.ironRda + 'mg) and only ' + data.vitC + 'mg vitamin C. Vitamin C increases non-heme iron absorption by 2-3x — pairing iron-rich foods with citrus, peppers, or tomatoes is one of the simplest nutritional optimizations you can make.',
        action: 'How can I improve my iron absorption?',
        _severity: 'attention'
      };
    }
  },
  {
    id: 'calcium_iron_conflict',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      // Check if user has both low iron and high calcium in same meals
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailyIron = (totals['Iron'] || 0) / days;
      var dailyCa = (totals['Calcium'] || 0) / days;
      var sex = (ctx.profile && ctx.profile.sex) || 'male';
      var ironRda = sex === 'female' ? 18 : 8;
      // Fire if iron is low but calcium is adequate+ (suggests calcium may be blocking)
      if (dailyIron >= ironRda * 0.6) return null;
      if (dailyCa < 800) return null; // Not enough calcium to be blocking
      return { iron: Math.round(dailyIron * 10) / 10, calcium: Math.round(dailyCa), ironRda: ironRda };
    },
    template: function(data) {
      return {
        headline: 'Calcium may be blocking iron absorption',
        body: 'Your iron intake is only ' + data.iron + 'mg/day (RDA: ' + data.ironRda + 'mg) while calcium is ' + data.calcium + 'mg/day. Calcium inhibits iron absorption when consumed together. Try separating calcium-rich foods (dairy, supplements) from iron-rich meals by 2+ hours.',
        action: 'How do calcium and iron interact in my diet?'
      };
    }
  },

  // ── Doctor-Level Escalation Rules ──

  {
    id: 'see_doctor_crp_weight_loss',
    domain: 'cross',
    severity: 'alert',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.bloodwork) return null;
      var crp = ctx.metrics.bloodwork.crp;
      if (!crp || crp <= 3) return null;
      // Check for unexplained weight loss
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      var points = weightEntries.map(function(w) { var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 }; });
      var trend = computeMetricTrend(points, 30);
      if (!trend || trend.direction !== 'down') return null;
      var monthlyLoss = Math.abs(trend.slope * 30);
      var pctLoss = ctx.profile && ctx.profile.current_weight_kg ? (monthlyLoss / ctx.profile.current_weight_kg) * 100 : 0;
      // Flag if losing >3% body weight/month without a weight loss goal
      if (pctLoss < 3) return null;
      if (goalIncludes('weight')) return null; // Intentional weight loss
      return { crp: crp, monthlyLoss: Math.round(monthlyLoss * 10) / 10, pctLoss: Math.round(pctLoss * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'Talk to your doctor: high inflammation + unexplained weight loss',
        body: 'Your CRP is ' + data.crp + ' mg/L (significantly elevated) and you\'ve lost ~' + data.monthlyLoss + ' kg (' + data.pctLoss + '%) this month without a weight loss goal. This combination warrants medical evaluation — please discuss with your doctor.',
        action: 'What could cause high CRP with unexplained weight loss?'
      };
    }
  },
  {
    id: 'see_doctor_glucose_spike',
    domain: 'cross',
    severity: 'alert',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.bloodwork) return null;
      var glucose = ctx.metrics.bloodwork.glucose;
      var hba1c = ctx.metrics.bloodwork.hba1c;
      if (glucose && glucose >= 126) return { marker: 'fasting glucose', value: glucose + ' mg/dL', threshold: '126 mg/dL (diabetic range)' };
      if (hba1c && hba1c >= 6.5) return { marker: 'HbA1c', value: hba1c + '%', threshold: '6.5% (diabetic range)' };
      return null;
    },
    template: function(data) {
      return {
        headline: 'Talk to your doctor: ' + data.marker + ' in diabetic range',
        body: 'Your ' + data.marker + ' of ' + data.value + ' is at or above ' + data.threshold + '. This needs medical evaluation — schedule an appointment with your doctor to discuss next steps.',
        action: 'What does a diabetic-range blood sugar result mean?'
      };
    }
  },
  {
    id: 'see_doctor_rhr_extreme',
    domain: 'heart',
    severity: 'alert',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      var hr = ctx.metrics.hr;
      if (hr >= 100) return { hr: hr, condition: 'tachycardia (resting HR above 100 bpm)' };
      if (hr <= 40 && !(ctx.metrics.vo2max && ctx.metrics.vo2max >= 50)) return { hr: hr, condition: 'bradycardia (resting HR below 40 bpm)' };
      return null;
    },
    template: function(data) {
      return {
        headline: 'Talk to your doctor: ' + data.condition,
        body: 'Your resting heart rate of ' + data.hr + ' bpm may indicate ' + data.condition + '. While this can have benign causes, it warrants medical evaluation — especially if you experience dizziness, fatigue, or shortness of breath.',
        action: 'What causes an abnormal resting heart rate?'
      };
    }
  },

  // ── Strength-to-Bodyweight Ratios ──

  {
    id: 'strength_bodyweight_ratio',
    domain: 'strength',
    severity: 'positive',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      if (!ctx.profile || !ctx.profile.current_weight_kg) return null;
      var weightLbs = Math.round(ctx.profile.current_weight_kg * 2.205);
      var tests = ctx.metrics.strengthData.tests;
      var byKey = {};
      tests.forEach(function(t) { if (!byKey[t.test_key]) byKey[t.test_key] = t; });
      var ratios = [];
      var lifts = ['bench_1rm', 'squat_1rm', 'deadlift_1rm'];
      var labels = { bench_1rm: 'Bench', squat_1rm: 'Squat', deadlift_1rm: 'Deadlift' };
      var standards = { bench_1rm: [0.75, 1.0, 1.25, 1.5], squat_1rm: [1.0, 1.25, 1.5, 2.0], deadlift_1rm: [1.0, 1.5, 2.0, 2.5] };
      for (var i = 0; i < lifts.length; i++) {
        var k = lifts[i];
        if (!byKey[k]) continue;
        var raw = parseFloat(byKey[k].raw_value);
        var ratio = Math.round((raw / weightLbs) * 100) / 100;
        var std = standards[k];
        var level = ratio >= std[3] ? 'advanced' : ratio >= std[2] ? 'intermediate' : ratio >= std[1] ? 'novice' : 'beginner';
        ratios.push({ label: labels[k], raw: Math.round(raw), ratio: ratio, level: level });
      }
      if (ratios.length === 0) return null;
      return { ratios: ratios, weightLbs: weightLbs };
    },
    template: function(data) {
      var lines = data.ratios.map(function(r) { return r.label + ': ' + r.raw + ' lbs (' + r.ratio + 'x bodyweight, ' + r.level + ')'; });
      var headline = 'Strength-to-bodyweight ratios at ' + data.weightLbs + ' lbs';
      return {
        headline: headline,
        body: lines.join('. ') + '. These ratios are more meaningful than raw numbers — they normalize for body size and are how strength standards are measured.',
        action: 'What are good strength-to-bodyweight ratios for my level?',
        _severity: 'neutral'
      };
    }
  },

  // ── Achievements (replaces milestone timeline) ──

  {
    id: 'achievement_va_improved',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.vaHistory || ctx.vaHistory.length < 7) return null;
      var first = ctx.vaHistory[0];
      var last = ctx.vaHistory[ctx.vaHistory.length - 1];
      if (!first || !last || !first.vAge || !last.vAge) return null;
      var improvement = first.vAge - last.vAge;
      if (improvement < 1) return null;
      return { improvement: Math.round(improvement * 10) / 10, first: first.vAge, current: last.vAge };
    },
    template: function(data) {
      var headline = 'Vitality Age improved ' + data.improvement + ' years';
      var body = 'Your Vitality Age has gone from ' + data.first + ' to ' + data.current + ' since you started tracking. This reflects real, measurable improvements in your health markers — not just noise.';
      if (data.improvement >= 3) body += ' A 3+ year improvement is exceptional.';
      return { headline: headline, body: body, action: 'What\'s driving my vitality age improvement?' };
    }
  },
  {
    id: 'achievement_composite_80',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.result || !ctx.result.composite || ctx.result.composite < 80) return null;
      return { composite: Math.round(ctx.result.composite) };
    },
    template: function(data) {
      return {
        headline: 'Composite health score: ' + data.composite + '/100',
        body: 'Your composite score is in the top tier. This means your combined cardiovascular fitness, body composition, strength, and biomarkers are all performing well. Few people maintain this level — keep doing what you\'re doing.',
        action: 'How do I maintain a high composite score as I age?'
      };
    }
  },
  {
    id: 'achievement_rhr_elite',
    domain: 'heart',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      if (ctx.metrics.hr > 55) return null;
      return { hr: ctx.metrics.hr };
    },
    template: function(data) {
      return {
        headline: 'Resting HR of ' + data.hr + ' bpm — athlete zone',
        body: 'A resting heart rate below 55 bpm puts you in the athletic range. This reflects strong cardiovascular efficiency — your heart pumps more blood per beat, so it doesn\'t need to beat as often. Research links resting HR below 60 to significantly lower all-cause mortality.',
        action: 'What does an athletic resting heart rate mean for my longevity?'
      };
    }
  },
  {
    id: 'achievement_strength_progress',
    domain: 'strength',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.strengthData || !ctx.metrics.strengthData.tests) return null;
      var tests = ctx.metrics.strengthData.tests;
      var byKey = {};
      tests.forEach(function(t) { if (!byKey[t.test_key]) byKey[t.test_key] = []; byKey[t.test_key].push(t); });
      var improvements = [];
      var liftKeys = ['bench_1rm', 'squat_1rm', 'deadlift_1rm'];
      for (var i = 0; i < liftKeys.length; i++) {
        var k = liftKeys[i];
        var history = byKey[k];
        if (!history || history.length < 2) continue;
        var latest = parseFloat(history[0].raw_value);
        var oldest = parseFloat(history[history.length - 1].raw_value);
        if (oldest <= 0) continue;
        var pctGain = Math.round(((latest - oldest) / oldest) * 100);
        if (pctGain >= 10) {
          var norm = (typeof FITNESS_NORMS !== 'undefined' && FITNESS_NORMS[k]) || {};
          improvements.push({ label: norm.label || k, pctGain: pctGain, latest: Math.round(latest), unit: norm.unit || 'lbs' });
        }
      }
      if (improvements.length === 0) return null;
      return { improvements: improvements };
    },
    template: function(data) {
      var best = data.improvements[0];
      var body = best.label + ' up ' + best.pctGain + '% to ' + best.latest + ' ' + best.unit + ' since you started tracking.';
      if (data.improvements.length > 1) {
        body += ' Also: ' + data.improvements.slice(1).map(function(i) { return i.label + ' +' + i.pctGain + '%'; }).join(', ') + '.';
      }
      body += ' Consistent progressive overload is working.';
      return {
        headline: best.label + ' up ' + best.pctGain + '% since you started',
        body: body,
        action: 'How do I keep progressing on my lifts?'
      };
    }
  },
  {
    id: 'achievement_sleep_consistency',
    domain: 'sleep',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var avg = ctx.metrics.sleepData.avg;
      var eff = ctx.metrics.sleepData.efficiency;
      var debt = ctx.metrics.sleepData.debt;
      if (!avg || avg < 7 || !eff || eff < 85 || debt > 3) return null;
      return { avg: Math.round(avg * 10) / 10, efficiency: eff, debt: Math.round(debt * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'Sleep is dialed in',
        body: 'Averaging ' + data.avg + 'h with ' + data.efficiency + '% efficiency and only ' + data.debt + 'h of debt. This supports recovery, cognitive function, and metabolic health. Consistent sleep quality like this is one of the most impactful things you can do for long-term health.',
        action: 'How does consistent sleep affect my other health markers?'
      };
    }
  },
  {
    id: 'achievement_all_domains',
    domain: 'strength',
    severity: 'positive',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      if (!ctx.metrics || !ctx.metrics.strengthData) return null;
      var domains = getCompletedDomains(ctx.metrics.strengthData);
      if (domains.missing.length > 0) return null;
      return { pctl: ctx.metrics.strengthData.avgPercentile };
    },
    template: function(data) {
      return {
        headline: 'All 5 strength domains complete',
        body: 'You\'ve tested Upper Push, Upper Pull, Lower Body, Core, and Carry/Grip — your confirmed fitness percentile is ' + data.pctl + 'th. This is a comprehensive strength profile that most people never build. Keep logging to track progression.',
        action: 'How does my strength compare across domains?'
      };
    }
  },
  {
    id: 'achievement_weight_goal_progress',
    domain: 'weight',
    severity: 'positive',
    detect: function(ctx) {
      if (!goalIncludes('weight')) return null;
      if (!ctx.profile || !ctx.profile.current_weight_kg) return null;
      // Check if target weight exists
      var targetKg = ctx.profile.target_weight_kg;
      if (!targetKg) return null;
      var currentKg = ctx.profile.current_weight_kg;
      // Need to know starting weight — use oldest weight log
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      var oldest = weightEntries[weightEntries.length - 1];
      var startKg = parseFloat(oldest.value);
      if ((oldest.unit || 'lbs').toLowerCase() !== 'kg') startKg = startKg / 2.205;
      var totalToLose = startKg - targetKg;
      if (totalToLose <= 0) return null;
      var lostSoFar = startKg - currentKg;
      if (lostSoFar <= 0) return null;
      var pct = Math.round((lostSoFar / totalToLose) * 100);
      if (pct < 10) return null; // Not enough progress yet
      return { lostKg: Math.round(lostSoFar * 10) / 10, pct: pct, targetKg: Math.round(targetKg * 10) / 10, currentKg: Math.round(currentKg * 10) / 10 };
    },
    template: function(data) {
      var body = 'You\'ve lost ' + data.lostKg + ' kg — ' + data.pct + '% of the way to your ' + data.targetKg + ' kg goal.';
      if (data.pct >= 50) body += ' Over halfway there. The research is clear: people who track consistently are far more likely to reach their target.';
      else body += ' Steady progress. Sustainable weight loss is 0.5-1 kg/week — consistency beats speed.';
      return {
        headline: data.pct + '% toward your weight goal',
        body: body,
        action: 'Am I losing weight at a healthy pace?'
      };
    }
  },

  // ── Additional Win Rules ──

  {
    id: 'win_meal_logging_consistency',
    domain: 'nutrition',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var now = new Date();
      var daysLogged = {};
      ctx.meals.forEach(function(m) {
        var d = localDateStr(new Date(m.meal_time || m.created_at));
        var age = (now - new Date(d)) / 86400000;
        if (age <= 7) daysLogged[d] = (daysLogged[d] || 0) + 1;
      });
      var count = Object.keys(daysLogged).length;
      if (count < 5) return null;
      var totalMeals = Object.values(daysLogged).reduce(function(s, v) { return s + v; }, 0);
      return { days: count, meals: totalMeals };
    },
    template: function(data) {
      return {
        headline: 'Logged meals ' + data.days + ' of 7 days',
        body: data.meals + ' meals tracked this week. Consistent logging is the foundation \u2014 you can\'t optimize what you don\'t measure. This data feeds every nutrition insight Healix generates.',
        action: 'How does meal tracking help my health goals?'
      };
    }
  },
  {
    id: 'win_sleep_efficiency_high',
    domain: 'sleep',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var eff = ctx.metrics.sleepData.efficiency;
      if (eff === undefined || eff < 85) return null;
      var avg = ctx.metrics.sleepData.avg;
      if (!avg || avg < 7) return null;
      return { efficiency: eff, avg: Math.round(avg * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'Sleep quality is strong',
        body: data.efficiency + '% efficiency with ' + data.avg + 'h average. You\'re above the 85% clinical threshold for good sleep quality. Sleep is the single most impactful recovery lever \u2014 maintaining this protects everything else.',
        action: 'What else can I do to maintain great sleep?'
      };
    }
  },
  {
    id: 'win_vitality_improving',
    domain: 'cross',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.vaHistory || ctx.vaHistory.length < 5) return null;
      var sorted = ctx.vaHistory.slice().sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
      var recent = sorted.slice(-7);
      if (recent.length < 3) return null;
      var first = recent[0].age;
      var last = recent[recent.length - 1].age;
      var delta = Math.round((first - last) * 10) / 10;
      if (delta < 0.5) return null; // Need at least 0.5 year improvement
      return { delta: delta, days: recent.length };
    },
    template: function(data) {
      return {
        headline: 'Vitality Age improving',
        body: 'Your Vitality Age has dropped ' + data.delta + ' years over the past week. Every fraction of a year younger reflects real physiological improvement. Whatever you\'re doing \u2014 keep doing it.',
        action: 'What\'s driving my vitality improvement?'
      };
    }
  },

  // ── Unlock Teasers (fire when data is missing) ──

  {
    id: 'unlock_bloodwork',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (ctx.metrics && ctx.metrics.bloodwork) return null;
      // Only show if they have at least some other data
      if (!ctx.metrics || (ctx.metrics.hr === null && !ctx.metrics.sleepData && !ctx.metrics.steps)) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Unlock 15+ insights with bloodwork',
        body: 'Upload a lab report to see how your blood markers connect to your sleep, nutrition, and fitness — like how your fiber intake affects LDL, or how sleep debt impacts blood sugar.',
        action: 'What bloodwork should I get to track my health?'
      };
    }
  },
  {
    id: 'unlock_meals',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (ctx.meals && ctx.meals.length >= 5) return null;
      if (!ctx.metrics || (ctx.metrics.hr === null && !ctx.metrics.sleepData)) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Log meals to unlock nutrition insights',
        body: 'With 5+ meals logged, Healix can detect patterns like magnesium intake affecting your sleep, protein gaps limiting recovery, or omega-3 levels impacting inflammation.',
        action: 'How does meal logging improve my health insights?'
      };
    }
  },
  {
    id: 'unlock_strength',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (ctx.metrics && ctx.metrics.strengthData) return null;
      if (!goalIncludes('strength')) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Log a fitness test to track your progress',
        body: 'Your goal is to gain strength — logging bench, squat, or deadlift lets Healix detect PRs, stalls, push/pull imbalances, and show your strength-to-bodyweight ratios vs age-group norms.',
        action: 'Which fitness tests should I start with?'
      };
    }
  },
  {
    id: 'unlock_sleep',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (ctx.metrics && ctx.metrics.sleepData) return null;
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Connect sleep data for recovery insights',
        body: 'Sleep connects to everything — heart rate, blood sugar, weight, strength gains, and inflammation. Sync via the Healix app to unlock cross-domain insights like how sleep debt elevates your resting HR.',
        action: 'How does sleep affect my other health metrics?'
      };
    }
  },
  {
    id: 'unlock_vo2',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (ctx.metrics && ctx.metrics.vo2max !== null) return null;
      // Only show if they have other fitness data or bloodwork
      if (!ctx.metrics || (!ctx.metrics.strengthData && !ctx.metrics.bloodwork)) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Add VO2 max — the top longevity predictor',
        body: 'VO2 max is the single strongest predictor of all-cause mortality. Adding it unlocks insights connecting your aerobic fitness to deep sleep quality, HDL cholesterol, and resting heart rate.',
        action: 'How do I measure my VO2 max?'
      };
    }
  },
  {
    id: 'unlock_family_history',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var fh = ctx.profile.family_history;
      if (fh) {
        try {
          var parsed = typeof fh === 'string' ? JSON.parse(fh) : fh;
          if (Object.keys(parsed).length > 0) return null;
        } catch(e) {}
      }
      // Only show if they have bloodwork (where family history matters most)
      if (!ctx.metrics || !ctx.metrics.bloodwork) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Add family history for personalized risk signals',
        body: 'Family history of diabetes, heart disease, or high cholesterol changes how your blood markers should be interpreted. Adding it unlocks insights that flag elevated risk before standard thresholds would.',
        action: 'Why does family history matter for my health data?'
      };
    }
  },

  // ── Energy Balance Rules ──

  {
    id: 'energy_balance_daily',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function(ctx) {
      var eb = computeEnergyBalance(ctx, 1);
      if (!eb || eb.daysTracked === 0) return null;
      var today = eb.days[0];
      if (!today) return null;
      return { calIn: today.calIn, calOut: today.calOut, active: today.active, basal: today.basal, balance: today.balance };
    },
    template: function(data) {
      var dir = data.balance < 0 ? 'deficit' : 'surplus';
      var abs = Math.abs(data.balance);
      var goal = getUserGoal();
      var sev = 'neutral';
      var goalFrame = '';
      if (goal.indexOf('weight') !== -1) {
        sev = data.balance < -100 ? 'positive' : data.balance > 100 ? 'attention' : 'neutral';
        goalFrame = data.balance < -100 ? ' On track for weight loss.' : data.balance > 100 ? ' This surplus works against your weight loss goal.' : ' Near maintenance.';
      } else if (goal.indexOf('strength') !== -1) {
        sev = data.balance > -200 ? 'positive' : 'attention';
        goalFrame = data.balance < -300 ? ' This deficit may limit muscle recovery and strength gains.' : data.balance >= 0 ? ' Slight surplus supports muscle growth.' : ' Near maintenance — enough for recovery.';
      }
      return {
        headline: abs + ' cal ' + dir + ' today',
        body: 'You ate ' + data.calIn.toLocaleString() + ' cal and burned ' + data.calOut.toLocaleString() + ' (' + data.basal.toLocaleString() + ' basal + ' + data.active.toLocaleString() + ' active).' + goalFrame,
        action: 'How does my daily energy balance affect my goals?',
        _severity: sev
      };
    }
  },
  {
    id: 'energy_balance_weekly',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function(ctx) {
      var eb = computeEnergyBalance(ctx, 7);
      if (!eb || eb.daysTracked < 3) return null;
      return eb;
    },
    template: function(data) {
      var dir = data.avgBalance < 0 ? 'deficit' : 'surplus';
      var abs = Math.abs(data.avgBalance);
      var goal = getUserGoal();
      var sev = 'neutral';
      var body = 'Over ' + data.daysTracked + ' tracked days: averaging ' + data.avgIn.toLocaleString() + ' cal in vs ' + data.avgOut.toLocaleString() + ' cal burned — a ' + abs + ' cal/day ' + dir + '.';

      if (data.predictedWeeklyKg !== 0) {
        var absKg = Math.abs(data.predictedWeeklyKg);
        body += ' At this pace, you\'d ' + (data.predictedWeeklyKg < 0 ? 'lose' : 'gain') + ' ~' + absKg + ' kg/week.';
      }

      if (goal.indexOf('weight') !== -1) {
        if (data.inDeficit) {
          if (data.avgBalance < -1000) {
            sev = 'attention';
            body += ' A deficit over 1,000 cal/day is aggressive — research shows this accelerates muscle loss. Aim for 500-750 cal/day deficit for sustainable fat loss.';
          } else {
            sev = 'positive';
            body += ' This is a healthy deficit for sustainable weight loss.';
          }
        } else if (data.inSurplus) {
          sev = 'attention';
          body += ' You\'re in surplus despite a weight loss goal. Either reduce intake or increase activity.';
        }
      } else if (goal.indexOf('strength') !== -1) {
        if (data.avgBalance < -300) {
          sev = 'attention';
          body += ' This deficit may impair strength recovery. For muscle gain, aim for maintenance or a small surplus (+200-300 cal).';
        } else if (data.avgBalance >= -100 && data.avgBalance <= 500) {
          sev = 'positive';
          body += ' Good range for strength goals — enough fuel for recovery and adaptation.';
        }
      }

      return {
        headline: abs + ' cal/day average ' + dir + ' this week',
        body: body,
        action: 'Is my calorie balance right for my goals?',
        _severity: sev
      };
    }
  },
  {
    id: 'energy_predicted_vs_actual_weight',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      var eb = computeEnergyBalance(ctx, 14);
      if (!eb || eb.daysTracked < 5) return null;
      if (typeof weightEntries === 'undefined' || !weightEntries || weightEntries.length < 2) return null;
      var points = weightEntries.map(function(w) {
        var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 };
      });
      var trend = computeMetricTrend(points, 14);
      if (!trend) return null;
      var actualWeeklyKg = Math.round(trend.slope * 7 * 10) / 10;
      var predictedWeeklyKg = eb.predictedWeeklyKg;
      var discrepancy = Math.abs(predictedWeeklyKg - actualWeeklyKg);
      if (discrepancy < 0.3) return null;
      return { predicted: predictedWeeklyKg, actual: actualWeeklyKg, avgIn: eb.avgIn, avgOut: eb.avgOut, daysTracked: eb.daysTracked };
    },
    template: function(data) {
      var body = 'Based on ' + data.daysTracked + ' days of data, your energy balance predicts ' + (data.predicted < 0 ? 'losing' : 'gaining') + ' ~' + Math.abs(data.predicted) + ' kg/week. But your actual weight is ' + (data.actual < 0 ? 'down' : 'up') + ' ~' + Math.abs(data.actual) + ' kg/week.';
      if (Math.abs(data.actual) > Math.abs(data.predicted)) {
        body += ' You may be burning more than tracked, or some high-calorie items in your logs are overestimated.';
      } else {
        body += ' Some meals may not be logged — research shows people underreport intake by 20-40% on average. Try logging everything for one strict week to calibrate.';
      }
      return {
        headline: 'Energy balance doesn\'t match weight trend',
        body: body,
        action: 'Why doesn\'t my calorie balance match my weight change?'
      };
    }
  },
  {
    id: 'deficit_too_aggressive',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('weight')) return null;
      var eb = computeEnergyBalance(ctx, 7);
      if (!eb || eb.daysTracked < 3) return null;
      if (eb.avgBalance >= -1000) return null; // Not too aggressive
      return { avgBalance: eb.avgBalance, avgIn: eb.avgIn, avgOut: eb.avgOut, predictedWeeklyKg: eb.predictedWeeklyKg };
    },
    template: function(data) {
      return {
        headline: 'Calorie deficit may be too aggressive',
        body: 'You\'re averaging a ' + Math.abs(data.avgBalance) + ' cal/day deficit (eating ' + data.avgIn.toLocaleString() + ', burning ' + data.avgOut.toLocaleString() + '). Deficits over 1,000 cal/day accelerate muscle loss and trigger metabolic adaptation — your body fights back by reducing energy expenditure. A 500-750 cal/day deficit preserves muscle and is more sustainable long-term.',
        action: 'What happens when my calorie deficit is too large?'
      };
    }
  },
  {
    id: 'strength_in_deficit_warning',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('strength')) return null;
      var eb = computeEnergyBalance(ctx, 7);
      if (!eb || eb.daysTracked < 3) return null;
      if (eb.avgBalance >= -200) return null; // Not a meaningful deficit
      return { avgBalance: eb.avgBalance, avgIn: eb.avgIn, avgOut: eb.avgOut };
    },
    template: function(data) {
      return {
        headline: 'Calorie deficit working against strength goal',
        body: 'You\'re in a ' + Math.abs(data.avgBalance) + ' cal/day deficit (eating ' + data.avgIn.toLocaleString() + ', burning ' + data.avgOut.toLocaleString() + '). For strength and muscle gain, you need to be at maintenance or a slight surplus (+200-300 cal). Muscle protein synthesis requires energy — training hard in a deficit limits gains and slows recovery.',
        action: 'How many calories do I need to build strength?'
      };
    }
  },

  // ── Sleep Better Goal Rules ──

  {
    id: 'sleep_efficiency_focus',
    domain: 'sleep',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var eff = ctx.metrics.sleepData.efficiency;
      if (eff === undefined || eff === null || eff >= 85) return null;
      var totalMin = ctx.metrics.sleepData.totalMinutes || 0;
      var awakeMin = totalMin > 0 ? Math.round(totalMin * (1 - eff / 100)) : 0;
      return { efficiency: eff, awakeMin: awakeMin };
    },
    template: function(data) {
      return {
        headline: 'Sleep efficiency below target',
        body: 'Sleep efficiency of ' + data.efficiency + '% means ' + data.awakeMin + ' minutes in bed awake. Two biggest levers: consistent bed/wake times (\u00b130 min) and getting out of bed if awake >20 min. This is the core of CBT-I \u2014 more effective than medication long-term.',
        action: 'What is CBT-I and how can it improve my sleep efficiency?'
      };
    }
  },
  {
    id: 'sleep_deep_pct_low',
    domain: 'sleep',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData || !ctx.metrics.sleepData.stages) return null;
      var deep = ctx.metrics.sleepData.stages.deep;
      if (!deep || deep.pct >= 13) return null;
      return { deepPct: deep.pct };
    },
    template: function(data) {
      return {
        headline: 'Deep sleep is low',
        body: 'Deep sleep is ' + data.deepPct + '% (target: 15\u201320%). This is when growth hormone peaks, tissue repairs, and memories consolidate. Top evidence-based boosters: regular exercise earlier in the day, avoiding alcohol, keeping room cool (65\u201368\u00b0F).',
        action: 'How can I increase my deep sleep percentage?'
      };
    }
  },
  {
    id: 'sleep_rem_pct_low',
    domain: 'sleep',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData || !ctx.metrics.sleepData.stages) return null;
      var rem = ctx.metrics.sleepData.stages.rem;
      if (!rem || rem.pct >= 18) return null;
      return { remPct: rem.pct };
    },
    template: function(data) {
      return {
        headline: 'REM sleep is low',
        body: 'REM is ' + data.remPct + '% (target: 20\u201325%). Critical for emotional regulation and motor learning. Alcohol is the #1 REM suppressant \u2014 even 1\u20132 drinks reduces REM by 20\u201330%. REM concentrates in the last 2 hours of sleep, so cutting sleep short disproportionately kills REM.',
        action: 'How can I increase my REM sleep?'
      };
    }
  },
  {
    id: 'sleep_bedtime_consistency',
    domain: 'sleep',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.healthData) return null;
      var sleepRows = ctx.healthData['sleep_analysis'];
      if (!sleepRows || sleepRows.length === 0) return null;
      var sessions = identifySleepSessions(sleepRows);
      if (sessions.length < 3) return null;
      // Use up to 7 most recent sessions
      var recent = sessions.slice(0, 7);
      var bedtimeMinutes = recent.map(function(sess) {
        var d = new Date(sess.startTime);
        var mins = d.getHours() * 60 + d.getMinutes();
        // Normalize: shift times before noon to +24h (next-day)
        if (mins < 720) mins += 1440;
        return mins;
      });
      var mean = bedtimeMinutes.reduce(function(s, v) { return s + v; }, 0) / bedtimeMinutes.length;
      var variance = bedtimeMinutes.reduce(function(s, v) { return s + Math.pow(v - mean, 2); }, 0) / bedtimeMinutes.length;
      var stdDev = Math.round(Math.sqrt(variance));
      if (stdDev < 60) return null;
      return { stdDevMin: stdDev, nights: recent.length };
    },
    template: function(data) {
      return {
        headline: 'Bedtime is inconsistent',
        body: 'Bedtime varied by ~' + data.stdDevMin + ' minutes over ' + data.nights + ' nights. A 2020 Sleep study found >90 min variability reduces overnight recovery by 15%. Tightening by even 30 minutes makes a measurable difference. Your circadian clock can\'t optimize what changes every night.',
        action: 'How does bedtime consistency affect sleep quality?'
      };
    }
  },
  {
    id: 'sleep_caffeine_proxy',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      if (ctx.metrics.sleepData.efficiency >= 85) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        var d = localDateStr(new Date(m.meal_time || m.created_at));
        return (new Date(todayStr) - new Date(d)) / 86400000 <= 7;
      });
      if (recentMeals.length === 0) return null;

      // Check if any recent meal has structured Caffeine data
      var hasStructured = false;
      recentMeals.forEach(function(m) {
        var data = null;
        try { data = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) {}
        if (!data || !data.total_nutrition) return;
        var cats = Object.values(data.total_nutrition);
        for (var i = 0; i < cats.length; i++) {
          if (!Array.isArray(cats[i])) continue;
          for (var j = 0; j < cats[i].length; j++) {
            if (MICRO_ALIAS_MAP[cats[i][j].name] && MICRO_ALIAS_MAP[cats[i][j].name].key === 'Caffeine') {
              hasStructured = true; return;
            }
          }
        }
      });

      if (hasStructured) {
        // Use structured data: sum caffeine from afternoon meals
        var afternoonMeals = recentMeals.filter(function(m) {
          return new Date(m.meal_time || m.created_at).getHours() >= 14;
        });
        var totalMg = 0;
        var caffeineDays = {};
        afternoonMeals.forEach(function(m) {
          var mData = null;
          try { mData = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) {}
          if (!mData || !mData.total_nutrition) return;
          var cats = Object.values(mData.total_nutrition);
          for (var i = 0; i < cats.length; i++) {
            if (!Array.isArray(cats[i])) continue;
            for (var j = 0; j < cats[i].length; j++) {
              var def = MICRO_ALIAS_MAP[cats[i][j].name];
              if (def && def.key === 'Caffeine') {
                var val = parseFloat(cats[i][j].value || 0);
                if (val > 0) {
                  totalMg += val;
                  caffeineDays[localDateStr(new Date(m.meal_time || m.created_at))] = true;
                }
              }
            }
          }
        });
        var count = Object.keys(caffeineDays).length;
        if (count === 0) return null;
        return { days: count, efficiency: ctx.metrics.sleepData.efficiency, mg: Math.round(totalMg) };
      } else {
        // Fallback: keyword matching for old meals without structured data
        var caffeineWords = /\b(coffee|espresso|caffeine|energy drink|pre-workout|latte|cappuccino|cold brew|matcha)\b/i;
        var caffeineDaysKw = {};
        recentMeals.forEach(function(m) {
          var mealHour = new Date(m.meal_time || m.created_at).getHours();
          if (mealHour < 14) return;
          var desc = (m.description || '').toLowerCase();
          if (caffeineWords.test(desc)) caffeineDaysKw[localDateStr(new Date(m.meal_time || m.created_at))] = true;
        });
        var countKw = Object.keys(caffeineDaysKw).length;
        if (countKw === 0) return null;
        return { days: countKw, efficiency: ctx.metrics.sleepData.efficiency, mg: null };
      }
    },
    template: function(data) {
      var mgNote = data.mg ? ' (~' + data.mg + 'mg total after 2 PM)' : '';
      return {
        headline: 'Afternoon caffeine may be hurting sleep',
        body: 'You logged caffeine in the afternoon/evening on ' + data.days + ' day' + (data.days > 1 ? 's' : '') + ' this week' + mgNote + '. Caffeine has a 6-hour half-life \u2014 a 2 PM coffee is still 50% active at 8 PM. Try cutting caffeine by noon for two weeks and track the effect on your sleep efficiency.',
        action: 'How does caffeine timing affect my sleep?'
      };
    }
  },
  {
    id: 'sleep_activity_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.metrics || !ctx.metrics.steps || !ctx.metrics.sleepData) return null;
      if (ctx.metrics.steps >= 5000) return null;
      var poorSleep = ctx.metrics.sleepData.efficiency < 85 || (ctx.metrics.sleepData.avg && ctx.metrics.sleepData.avg < 6.5);
      if (!poorSleep) return null;
      return { steps: ctx.metrics.steps, efficiency: ctx.metrics.sleepData.efficiency || 0 };
    },
    template: function(data) {
      return {
        headline: 'Low activity may be affecting sleep',
        body: 'Averaging ' + data.steps + ' steps/day with ' + data.efficiency + '% sleep efficiency. Research consistently shows moderate daily activity (7,000+ steps) improves sleep quality. For your sleep goal, a daily walk is the single most accessible intervention \u2014 and it costs nothing.',
        action: 'How does exercise affect sleep quality?'
      };
    }
  },
  {
    id: 'sleep_alcohol_proxy',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('sleep')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var stages = ctx.metrics.sleepData.stages;
      var remPct = stages && stages.rem ? stages.rem.pct : null;
      var eff = ctx.metrics.sleepData.efficiency;
      var poorSleep = (remPct !== null && remPct < 18) || (eff !== undefined && eff < 85);
      if (!poorSleep) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        var d = localDateStr(new Date(m.meal_time || m.created_at));
        return (new Date(todayStr) - new Date(d)) / 86400000 <= 7;
      });
      if (recentMeals.length === 0) return null;

      // Check if any recent meal has structured Alcohol data
      var hasStructured = false;
      recentMeals.forEach(function(m) {
        var data = null;
        try { data = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) {}
        if (!data || !data.total_nutrition) return;
        var cats = Object.values(data.total_nutrition);
        for (var i = 0; i < cats.length; i++) {
          if (!Array.isArray(cats[i])) continue;
          for (var j = 0; j < cats[i].length; j++) {
            if (MICRO_ALIAS_MAP[cats[i][j].name] && MICRO_ALIAS_MAP[cats[i][j].name].key === 'Alcohol') {
              hasStructured = true; return;
            }
          }
        }
      });

      if (hasStructured) {
        // Use structured data: sum alcohol per day
        var alcoholDays = {};
        var totalGrams = 0;
        recentMeals.forEach(function(m) {
          var mData = null;
          try { mData = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) {}
          if (!mData || !mData.total_nutrition) return;
          var cats = Object.values(mData.total_nutrition);
          for (var i = 0; i < cats.length; i++) {
            if (!Array.isArray(cats[i])) continue;
            for (var j = 0; j < cats[i].length; j++) {
              var def = MICRO_ALIAS_MAP[cats[i][j].name];
              if (def && def.key === 'Alcohol') {
                var val = parseFloat(cats[i][j].value || 0);
                if (val > 0) {
                  totalGrams += val;
                  alcoholDays[localDateStr(new Date(m.meal_time || m.created_at))] = true;
                }
              }
            }
          }
        });
        var count = Object.keys(alcoholDays).length;
        if (count === 0) return null;
        var drinks = Math.round(totalGrams / 14 * 10) / 10;
        return { days: count, remPct: remPct, efficiency: eff, grams: Math.round(totalGrams), drinks: drinks };
      } else {
        // Fallback: keyword matching for old meals without structured data
        var alcoholWords = /\b(beer|wine|cocktail|alcohol|bourbon|whiskey|whisky|vodka|rum|margarita|ipa|miller|sake|champagne|mimosa|sangria|tequila|gin|seltzer)\b/i;
        var alcoholDaysKw = {};
        recentMeals.forEach(function(m) {
          var desc = (m.description || '').toLowerCase();
          if (alcoholWords.test(desc)) alcoholDaysKw[localDateStr(new Date(m.meal_time || m.created_at))] = true;
        });
        var countKw = Object.keys(alcoholDaysKw).length;
        if (countKw === 0) return null;
        return { days: countKw, remPct: remPct, efficiency: eff, grams: null, drinks: null };
      }
    },
    template: function(data) {
      var details = '';
      if (data.remPct !== null) details += ' Your REM of ' + data.remPct + '%';
      if (data.efficiency !== undefined) details += (details ? ' and' : ' Your') + ' efficiency of ' + data.efficiency + '%';
      details += ' may be directly impacted.';
      var quantityNote = data.grams ? ' (~' + data.grams + 'g ethanol / ' + data.drinks + ' standard drinks)' : '';
      return {
        headline: 'Alcohol may be fragmenting sleep',
        body: 'You logged alcohol on ' + data.days + ' day' + (data.days > 1 ? 's' : '') + ' this week' + quantityNote + '. Even moderate alcohol (1\u20132 drinks) suppresses REM sleep by 20\u201330% and fragments sleep architecture.' + details + ' Consider tracking alcohol-free nights vs nights with drinks to see the difference in your own data.',
        action: 'How does alcohol affect my sleep stages?'
      };
    }
  },

  // ── Feel Better Goal Rules ──

  {
    id: 'wellness_vitality_trend',
    domain: 'cross',
    severity: 'neutral',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.vaHistory || ctx.vaHistory.length < 7) return null;
      // Sort by date ascending
      var sorted = ctx.vaHistory.slice().sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
      var recent = sorted.slice(-7);
      var first = recent[0].age;
      var last = recent[recent.length - 1].age;
      var delta = Math.round((first - last) * 10) / 10; // Positive = improvement (younger)
      if (Math.abs(delta) < 0.3) return null;
      return { delta: Math.abs(delta), improving: delta > 0, entries: ctx.vaHistory.length };
    },
    template: function(data) {
      if (data.improving) {
        return {
          headline: 'Vitality Age improving',
          body: 'Vitality Age improved ' + data.delta + ' years over the past month \u2014 overall health trajectory is positive.',
          action: 'What\'s driving my vitality improvement?',
          _severity: 'positive'
        };
      }
      return {
        headline: 'Vitality Age declining',
        body: 'Vitality Age has been flat or declining. The three highest-ROI interventions: consistent sleep (7\u20138h), daily movement (8,000 steps), adequate protein (0.8g/lb).',
        action: 'What can I do to improve my vitality age?',
        _severity: 'attention'
      };
    }
  },
  {
    id: 'energy_deficiency_triad',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.meals || ctx.meals.length < 5) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      if (days === 0) return null;
      var checks = [
        { name: 'Iron', daily: (totals['Iron'] || 0) / days, rda: 18 },
        { name: 'Vitamin B12', daily: (totals['Vitamin B12'] || totals['B12'] || 0) / days, rda: 0.0024 },
        { name: 'Vitamin D', daily: (totals['Vitamin D'] || 0) / days, rda: 20 }
      ];
      var low = checks.filter(function(c) { return c.daily < c.rda * 0.6; });
      if (low.length < 2) return null;
      return { low: low.map(function(c) { return c.name; }) };
    },
    template: function(data) {
      return {
        headline: 'Possible nutritional causes of fatigue',
        body: 'You\'re low on ' + data.low.join(' and ') + ' \u2014 the most common nutritional causes of fatigue. These three (iron, B12, vitamin D) account for the majority of diet-related low energy. This is the first thing a doctor checks when someone says \'I\'m always tired.\' Get bloodwork to confirm, then address the gaps.',
        action: 'How do iron, B12, and vitamin D affect energy levels?'
      };
    }
  },
  {
    id: 'wellness_inflammation',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.metrics || !ctx.metrics.bloodwork) return null;
      var crp = ctx.metrics.bloodwork.crp;
      if (!crp || crp <= 1.5) return null;
      var flags = [];
      if (ctx.metrics.sleepData && ctx.metrics.sleepData.avg && ctx.metrics.sleepData.avg < 6.5) flags.push('poor sleep');
      if (ctx.metrics.steps && ctx.metrics.steps < 5000) flags.push('low activity');
      var weightKg = ctx.profile && ctx.profile.current_weight_kg;
      var heightCm = ctx.profile && ctx.profile.height_cm;
      if (weightKg && heightCm) {
        var bmi = weightKg / Math.pow(heightCm / 100, 2);
        if (bmi > 28) flags.push('elevated BMI');
      }
      if (flags.length === 0) return null;
      return { crp: crp, flags: flags };
    },
    template: function(data) {
      return {
        headline: 'Inflammation elevated with lifestyle factors',
        body: 'CRP of ' + data.crp + ' mg/L indicates low-grade inflammation, paired with ' + data.flags.join(' and ') + '. Chronic inflammation drives fatigue, brain fog, and poor recovery. Each lifestyle factor independently reduces CRP by 20\u201330% \u2014 fix the biggest gap first.',
        action: 'How can I reduce my CRP and inflammation?'
      };
    }
  },
  {
    id: 'wellness_activity_baseline',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.metrics || !ctx.metrics.steps) return null;
      if (ctx.metrics.steps >= 5000) return null;
      return { steps: ctx.metrics.steps };
    },
    template: function(data) {
      return {
        headline: 'Daily activity is low',
        body: 'Averaging ' + data.steps + ' steps/day. A 2023 JAMA meta-analysis found each additional 1,000 steps reduced all-cause mortality by 15%. Getting from ' + data.steps + ' to 7,000 is the single highest-ROI change for general wellness \u2014 it affects energy, mood, sleep, and metabolic health simultaneously.',
        action: 'How does walking affect overall health?'
      };
    }
  },
  {
    id: 'wellness_sleep_foundation',
    domain: 'sleep',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var avg = ctx.metrics.sleepData.avg;
      if (!avg || avg >= 6.5) return null;
      return { avg: avg };
    },
    template: function(data) {
      return {
        headline: 'Sleep is undermining how you feel',
        body: 'Averaging ' + data.avg + 'h of sleep. For feeling better, sleep is the foundation \u2014 it affects mood, energy, immune function, weight, and cognitive performance. Sleep deprivation impairs glucose tolerance, increases hunger, elevates inflammation, and reduces emotional resilience within days. Prioritize 7+ hours before optimizing anything else.',
        action: 'How does sleep affect energy and mood?'
      };
    }
  },
  {
    id: 'wellness_nutrition_completeness',
    domain: 'nutrition',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.meals || ctx.meals.length < 5) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 5) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      if (days === 0) return null;
      var nutrients = [
        { name: 'Iron', daily: (totals['Iron'] || 0) / days, rda: 18, food: 'red meat, spinach, lentils' },
        { name: 'Vitamin B12', daily: (totals['Vitamin B12'] || totals['B12'] || 0) / days, rda: 0.0024, food: 'meat, fish, eggs, dairy' },
        { name: 'Vitamin D', daily: (totals['Vitamin D'] || 0) / days, rda: 20, food: 'fatty fish, egg yolks, fortified foods' },
        { name: 'Magnesium', daily: (totals['Magnesium'] || 0) / days, rda: 400, food: 'nuts, seeds, leafy greens' },
        { name: 'Zinc', daily: (totals['Zinc'] || 0) / days, rda: 11, food: 'meat, shellfish, legumes' },
        { name: 'Calcium', daily: (totals['Calcium'] || 0) / days, rda: 1000, food: 'dairy, sardines, broccoli' },
        { name: 'Omega-3', daily: (totals['Omega-3'] || totals['Omega-3 Fatty Acids'] || totals['DHA'] || totals['EPA'] || 0) / days, rda: 1.6, food: 'fatty fish, walnuts, flaxseed' }
      ];
      var low = nutrients.filter(function(n) { return n.daily < n.rda * 0.6; });
      if (low.length < 3) return null;
      return { count: low.length, gaps: low };
    },
    template: function(data) {
      var gapList = data.gaps.map(function(g) { return g.name + ' (try ' + g.food + ')'; }).join('; ');
      return {
        headline: 'Multiple micronutrient gaps detected',
        body: data.count + ' of 7 key micronutrients are below target this week. Subclinical deficiencies are invisible but drain energy, mood, and recovery. Your gaps: ' + gapList + '. Even small dietary shifts \u2014 adding leafy greens, fatty fish, or nuts \u2014 can move multiple nutrients at once.',
        action: 'Which micronutrients matter most for energy and mood?'
      };
    }
  },
  {
    id: 'wellness_rhr_elevated',
    domain: 'heart',
    severity: 'attention',
    detect: function(ctx) {
      if (!goalIncludes('feel')) return null;
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      if (ctx.metrics.hr <= 75) return null;
      // Exclude if high activity (probably exercising)
      if (ctx.metrics.steps && ctx.metrics.steps > 12000) return null;
      return { hr: ctx.metrics.hr };
    },
    template: function(data) {
      return {
        headline: 'Resting heart rate is elevated',
        body: 'Resting HR of ' + data.hr + ' bpm is elevated. Outside of exercise, an elevated resting HR can signal stress, dehydration, poor sleep, or deconditioning. Each 10 bpm above 60 increases mortality risk by ~9%. The most effective interventions: consistent aerobic activity, better sleep, and stress management.',
        action: 'Why is my resting heart rate high and how can I lower it?'
      };
    }
  },
  // ── Blood Pressure Rules ──
  {
    id: 'bp_optimal',
    domain: 'heart',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      var dia = ctx.profile.diastolic_bp;
      if (!sys || !dia) return null;
      if (sys < 120 && dia < 80) return { sys: sys, dia: dia };
      return null;
    },
    template: function(data) {
      return {
        headline: 'Blood pressure is optimal',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg is in the optimal range (<120/80). Optimal blood pressure is the single strongest predictor of cardiovascular longevity. Keep it here with regular exercise, sleep, and moderate sodium.',
        action: 'How can I maintain optimal blood pressure long-term?'
      };
    }
  },
  {
    id: 'bp_elevated',
    domain: 'heart',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      var dia = ctx.profile.diastolic_bp;
      if (!sys || !dia) return null;
      if ((sys >= 120 && sys <= 139) || (dia >= 80 && dia <= 89)) {
        if (sys >= 140 || dia >= 90) return null; // handled by bp_hypertension
        return { sys: sys, dia: dia };
      }
      return null;
    },
    template: function(data) {
      return {
        headline: 'Blood pressure is elevated',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg is in the elevated range. Without intervention, elevated BP progresses to hypertension in most people within 4 years. Aerobic exercise (150 min/week), sodium reduction (<2,300 mg/day), and weight management are the most effective lifestyle interventions.',
        action: 'What lifestyle changes lower blood pressure most effectively?'
      };
    }
  },
  {
    id: 'bp_hypertension',
    domain: 'heart',
    severity: 'alert',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      var dia = ctx.profile.diastolic_bp;
      if (!sys || !dia) return null;
      if (sys >= 140 || dia >= 90) return { sys: sys, dia: dia };
      return null;
    },
    template: function(data) {
      return {
        headline: 'Blood pressure is in the hypertension range',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg meets the threshold for hypertension (\u2265140/90). Sustained hypertension doubles the risk of heart disease, stroke, and kidney damage. Discuss this reading with your healthcare provider.',
        action: 'What should I do about high blood pressure?'
      };
    }
  },
  {
    id: 'bp_activity_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      if (!sys || sys < 130) return null;
      if (!ctx.metrics || !ctx.metrics.steps) return null;
      if (ctx.metrics.steps >= 6000) return null;
      return { sys: sys, steps: ctx.metrics.steps };
    },
    template: function(data) {
      return {
        headline: 'Elevated BP + low activity',
        body: 'Your systolic BP is ' + data.sys + ' mmHg and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day. Regular aerobic activity (brisk walking, cycling) reduces systolic BP by 5\u201310 mmHg \u2014 comparable to a first-line medication. Aim for 7,000+ steps to start.',
        action: 'How does exercise lower blood pressure?'
      };
    }
  },
  {
    id: 'bp_sleep_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      if (!sys || sys < 130) return null;
      if (!ctx.metrics || !ctx.metrics.sleepData) return null;
      var avgSleep = ctx.metrics.sleepData.avg || ctx.metrics.sleepData.latest;
      if (!avgSleep || avgSleep >= 6.5) return null;
      return { sys: sys, sleep: Math.round(avgSleep * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'Elevated BP + short sleep',
        body: 'Your systolic BP is ' + data.sys + ' mmHg and you\'re averaging ' + data.sleep + 'h of sleep. Sleeping under 6.5 hours raises blood pressure by activating the sympathetic nervous system and disrupting the nocturnal BP dip. Improving sleep to 7+ hours can reduce systolic BP by 3\u20135 mmHg.',
        action: 'How does sleep affect blood pressure?'
      };
    }
  },
  {
    id: 'bp_sodium_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      if (!sys || sys < 130) return null;
      if (!ctx.meals || ctx.meals.length === 0) return null;
      var todayStr = localDateStr(new Date());
      var recentMeals = ctx.meals.filter(function(m) {
        return (new Date(todayStr) - new Date(localDateStr(new Date(m.meal_time || m.created_at)))) / 86400000 <= 7;
      });
      if (recentMeals.length < 3) return null;
      var totals = getMicroTotalsFromMeals(recentMeals);
      var days = Math.min(7, new Set(recentMeals.map(function(m) { return localDateStr(new Date(m.meal_time || m.created_at)); })).size);
      var dailySodium = (totals['Sodium'] || 0) / days;
      if (dailySodium < 2300) return null;
      return { sys: sys, sodium: Math.round(dailySodium) };
    },
    template: function(data) {
      return {
        headline: 'Elevated BP + high sodium intake',
        body: 'Your systolic BP is ' + data.sys + ' mmHg and you\'re averaging ' + data.sodium + ' mg sodium/day. The DASH-Sodium trial showed that reducing sodium to <1,500 mg/day lowers systolic BP by 7\u201312 mmHg in people with elevated readings. Focus on reducing processed foods, restaurant meals, and added salt.',
        action: 'How much does reducing sodium lower blood pressure?'
      };
    }
  },
  {
    id: 'bp_hr_compound',
    domain: 'cross',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      var sys = ctx.profile.systolic_bp;
      if (!sys || sys < 130) return null;
      if (!ctx.metrics || ctx.metrics.hr === null) return null;
      if (ctx.metrics.hr <= 75) return null;
      return { sys: sys, hr: ctx.metrics.hr };
    },
    template: function(data) {
      return {
        headline: 'Elevated BP + elevated resting heart rate',
        body: 'Systolic BP of ' + data.sys + ' mmHg combined with a resting HR of ' + data.hr + ' bpm creates compounding cardiovascular strain. Together, they increase cardiac workload and arterial wall stress. Aerobic exercise is the most efficient intervention \u2014 it lowers both BP and resting HR simultaneously.',
        action: 'What exercises lower both blood pressure and heart rate?'
      };
    }
  },
  {
    id: 'bp_not_set',
    domain: 'unlock',
    severity: 'neutral',
    detect: function(ctx) {
      if (!ctx.profile) return null;
      // If BP data exists, don't show unlock
      if (ctx.profile.systolic_bp && ctx.profile.diastolic_bp) return null;
      // Only show if they have some other data
      if (!ctx.metrics) return null;
      if (ctx.metrics.hr === null && !ctx.metrics.sleepData && !ctx.metrics.steps && !ctx.metrics.bloodwork) return null;
      return {};
    },
    template: function() {
      return {
        headline: 'Add blood pressure to unlock BP insights',
        body: 'Blood pressure is the single most predictive vital sign for cardiovascular risk. Adding your BP reading lets Healix connect it to your activity, sleep, sodium intake, and heart rate for personalized insights.',
        action: 'Why is blood pressure important to track?'
      };
    }
  },
  // ── VO2 Max Rules ──
  {
    id: 'vo2_low_for_age',
    domain: 'heart',
    severity: 'attention',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.vo2max === null || ctx.metrics.vo2max === undefined) return null;
      if (ctx.metrics.vo2max >= 30) return null;
      return { vo2: Math.round(ctx.metrics.vo2max * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'VO2 max is below average',
        body: 'Your VO2 max of ' + data.vo2 + ' mL/kg/min is below the 30 mL/kg/min threshold associated with increased all-cause mortality. A 2022 JAMA study of 750,000 veterans found that moving from low to moderate cardiorespiratory fitness reduced mortality risk by 50%. Even moderate aerobic training (brisk walking, cycling) 3\u20144x/week can raise VO2 max by 10\u201315% within 8\u201312 weeks.',
        action: 'How can I improve my VO2 max?'
      };
    }
  },
  {
    id: 'vo2_above_average',
    domain: 'heart',
    severity: 'positive',
    detect: function(ctx) {
      if (!ctx.metrics || ctx.metrics.vo2max === null || ctx.metrics.vo2max === undefined) return null;
      if (ctx.metrics.vo2max < 40) return null;
      return { vo2: Math.round(ctx.metrics.vo2max * 10) / 10 };
    },
    template: function(data) {
      return {
        headline: 'VO2 max is above average',
        body: 'Your VO2 max of ' + data.vo2 + ' mL/kg/min puts you above average for cardiorespiratory fitness. Higher VO2 max is the strongest predictor of longevity \u2014 each 1 mL/kg/min increase reduces all-cause mortality by ~2%. To keep progressing, incorporate interval training (tempo runs, cycling intervals) alongside steady-state cardio.',
        action: 'What\'s the best way to keep improving VO2 max?'
      };
    }
  }
];

function buildInsightContext() {
  // Delegate to the ported insight engine's context adapter if available
  if (window.HealixInsights && window.HealixInsights.buildWebRuleContext) {
    return window.HealixInsights.buildWebRuleContext(
      window._lastDashboardMetrics || {},
      window.userProfileData || {},
      window._lastHealthByType || {}
    );
  }
  // Fallback: legacy context shape
  var vaHistory = [];
  try {
    var key = 'healix_va_history_' + (currentUser ? currentUser.id : '');
    var raw = localStorage.getItem(key);
    if (raw) vaHistory = JSON.parse(raw);
  } catch(e) {}
  return {
    metrics: window._lastDashboardMetrics || {},
    result: window._lastVitalityResult || null,
    timestamps: window._lastDashboardTimestamps || {},
    vaHistory: vaHistory,
    healthData: window._lastHealthByType || null,
    meals: window._lastDashboardMeals || [],
    profile: window.userProfileData || null
  };
}

function runInsightRules(ctx) {
  // Use the ported engine (125 rules with rotation-aware scoring) if available
  var rules = (window.HealixInsights && window.HealixInsights.ALL_INSIGHT_RULES)
    ? window.HealixInsights.ALL_INSIGHT_RULES
    : INSIGHT_RULES;

  // Load seen timestamps from localStorage for freshness rotation
  var seenKey = 'healix_insights_seen_' + (currentUser ? currentUser.id : '');
  var seen = {};
  try { var raw = localStorage.getItem(seenKey); if (raw) seen = JSON.parse(raw); } catch(e) {}

  // Domain timestamps for data-staleness scoring
  var timestamps = ctx.timestamps || window._lastDashboardTimestamps || {};
  var domainTs = {};
  if (timestamps.heart_rate) domainTs.heart = timestamps.heart_rate;
  if (timestamps.sleep) domainTs.sleep = timestamps.sleep;
  if (timestamps.bloodwork) domainTs.bloodwork = timestamps.bloodwork;
  if (timestamps.strength) domainTs.strength = timestamps.strength;

  var picked;
  if (window.HealixInsights && window.HealixInsights.runInsightRules) {
    picked = window.HealixInsights.runInsightRules(rules, ctx, seen, domainTs);
  } else {
    // Fallback: simple evaluate + severity sort
    var all = [];
    for (var i = 0; i < rules.length; i++) {
      try {
        var data = rules[i].detect(ctx);
        if (data) {
          var tpl = rules[i].template(data);
          all.push({ id: rules[i].id, domain: rules[i].domain, severity: tpl._severity || rules[i].severity, headline: tpl.headline, body: tpl.body, action: tpl.action, _score: 0 });
        }
      } catch(e) {}
    }
    all.sort(function(a, b) { var o = { alert: 0, attention: 1, positive: 2, neutral: 3 }; return (o[a.severity] || 3) - (o[b.severity] || 3); });
    picked = all.slice(0, 10);
  }

  // Record what we showed + prune old entries
  var now = Date.now();
  picked.forEach(function(ins) { seen[ins.id] = now; });
  Object.keys(seen).forEach(function(k) { if (now - seen[k] > 30 * 86400000) delete seen[k]; });
  safeLSSet(seenKey, JSON.stringify(seen));

  return picked;
}

var _insightFeedData = [];
var _insightPage = 0;
var INSIGHTS_PER_PAGE = 2;

function renderInsightFeed(insights) {
  var section = document.getElementById('insight-feed-section');
  var list = document.getElementById('insight-feed-list');
  var banner = document.getElementById('insight-alert-banner');
  if (!section || !list) return;

  if (!insights || insights.length === 0) {
    section.style.display = 'none';
    if (banner) banner.style.display = 'none';
    return;
  }

  // Alert banner for severity=alert
  if (banner) {
    var alerts = insights.filter(function(ins) { return ins.severity === 'alert'; });
    if (alerts.length > 0) {
      banner.innerHTML = '<div class="insight-alert-inner"><span class="insight-alert-icon">!</span> ' + escapeHtml(alerts[0].headline) + ' — ' + escapeHtml(alerts[0].body) + '</div>';
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  _insightFeedData = insights;
  _insightPage = 0;
  renderInsightPage();
  section.style.display = 'block';
}

function renderInsightPage() {
  var list = document.getElementById('insight-feed-list');
  var nav = document.getElementById('insight-feed-nav');
  var dotsEl = document.getElementById('insight-dots');
  if (!list) return;

  var totalPages = Math.ceil(_insightFeedData.length / INSIGHTS_PER_PAGE);
  var start = _insightPage * INSIGHTS_PER_PAGE;
  var pageItems = _insightFeedData.slice(start, start + INSIGHTS_PER_PAGE);

  var html = '';
  for (var i = 0; i < pageItems.length; i++) {
    var ins = pageItems[i];
    var badgeCls = ins.severity;
    var badgeText = ins.severity === 'positive' ? 'Win' : ins.severity === 'attention' ? 'Attention' : ins.severity === 'alert' ? 'Alert' : 'Insight';
    html += '<div class="insight-feed-card severity-' + badgeCls + '">';
    html += '<div class="insight-feed-card-top">';
    html += '<div class="insight-badge ' + badgeCls + '">' + badgeText + '</div>';
    html += '<div class="insight-headline">' + escapeHtml(ins.headline) + '</div>';
    html += '</div>';
    html += '<div class="insight-body">' + escapeHtml(ins.body) + '</div>';
    if (ins.action) {
      html += '<div class="insight-feed-card-footer">';
      html += '<a href="#" class="insight-discuss" onclick="event.preventDefault();openInsightChat(\'' + escapeHtml(ins.action).replace(/'/g, "\\'") + '\')">';
      html += 'Discuss with Healix \u2192</a>';
      html += '</div>';
    }
    html += '</div>';
  }
  list.innerHTML = html;

  // Navigation dots
  if (nav && dotsEl) {
    if (totalPages > 1) {
      nav.style.display = 'flex';
      var dots = '';
      for (var p = 0; p < totalPages; p++) {
        dots += '<div class="insight-nav-dot' + (p === _insightPage ? ' active' : '') + '"></div>';
      }
      dotsEl.innerHTML = dots;
      document.getElementById('insight-prev').disabled = _insightPage === 0;
      document.getElementById('insight-next').disabled = _insightPage >= totalPages - 1;
    } else {
      nav.style.display = 'none';
    }
  }
}

function pageInsights(dir) {
  var totalPages = Math.ceil(_insightFeedData.length / INSIGHTS_PER_PAGE);
  _insightPage = Math.max(0, Math.min(totalPages - 1, _insightPage + dir));
  renderInsightPage();
}

function openInsightChat(question) {
  if (!isChatAllowed()) {
    showUpgradeModal();
    return;
  }
  if (typeof HealixChat !== 'undefined' && HealixChat.openWithQuestion) {
    HealixChat.openWithQuestion(question);
  }
}

// ── DYNAMIC DRIVER EXPLAINERS ──

function computeDriverExplainer(key, ctx) {
  if (!ctx || !ctx.metrics) return null;
  var m = ctx.metrics;
  var byType = ctx.healthData;
  var goal = (ctx.profile && ctx.profile.primary_goal || '').toLowerCase();

  if (key === 'heart') {
    if (m.hr === null) return null;
    var hrScore = typeof scoreHR === 'function' ? scoreHR(m.hr) : null;
    var zone = hrScore >= 70 ? 'optimal zone' : hrScore >= 40 ? 'average range' : 'elevated range';
    var text = 'Resting HR of ' + m.hr + ' bpm (' + zone + ').';
    if (byType) {
      var hrSamples = byType['resting_heart_rate'] || byType['heart_rate'];
      if (hrSamples) {
        var trend = computeMetricTrend(hrSamples, 7);
        if (trend && trend.direction !== 'stable') {
          var delta = Math.abs(Math.round(trend.slope * 7 * 10) / 10);
          text += ' ' + (trend.direction === 'down' ? 'Down' : 'Up') + ' ' + delta + ' bpm this week.';
        }
      }
    }
    if (byType && byType['step_count']) {
      var now = Date.now();
      var thisWeek = [], lastWeek = [];
      var steps = byType['step_count'];
      for (var i = 0; i < steps.length; i++) {
        var ts = new Date(steps[i].start_date || steps[i].recorded_at).getTime();
        var daysAgo = (now - ts) / 86400000;
        if (daysAgo <= 7) thisWeek.push(parseFloat(steps[i].value || 0));
        else if (daysAgo <= 14) lastWeek.push(parseFloat(steps[i].value || 0));
      }
      if (thisWeek.length > 0 && lastWeek.length > 0) {
        var thisAvg = thisWeek.reduce(function(s, v) { return s + v; }, 0) / thisWeek.length;
        var lastAvg = lastWeek.reduce(function(s, v) { return s + v; }, 0) / lastWeek.length;
        if (lastAvg > 0) {
          var stepPct = Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
          if (Math.abs(stepPct) >= 10) {
            text += ' Your step count is ' + (stepPct > 0 ? 'up' : 'down') + ' ' + Math.abs(stepPct) + '% vs last week.';
          }
        }
      }
    }
    // Goal-aware framing
    if (goal.indexOf('strength') !== -1) text += ' Lower resting HR signals better recovery between training sessions.';
    else if (goal.indexOf('cardio') !== -1) text += ' Cardiovascular improvements show up here first.';
    else text += ' Worth 30% of your score.';
    return text;
  }

  if (key === 'weight') {
    if (!m.weightScore || !m.weightVal) return null;
    var zone = m.weightScore >= 70 ? 'optimal' : m.weightScore >= 40 ? 'moderate' : 'needs attention';
    var text = 'Weight score: ' + zone + '.';
    if (typeof weightEntries !== 'undefined' && weightEntries && weightEntries.length >= 2) {
      var points = weightEntries.map(function(w) { var wv = parseFloat(w.value); return { recorded_at: w.logged_at, value: (w.unit||'lbs').toLowerCase() === 'kg' ? wv : wv / 2.205 }; });
      var trend = computeMetricTrend(points, 14);
      if (trend && trend.direction !== 'stable') {
        var weeklyKg = Math.abs(Math.round(trend.slope * 7 * 10) / 10);
        if (weeklyKg >= 0.2) {
          text += ' Trending ' + (trend.direction === 'down' ? 'down' : 'up') + ' ~' + weeklyKg + ' kg/week.';
        }
      }
    }
    if (goal.indexOf('weight') !== -1) text += ' You\'re working toward a weight goal — keep tracking consistently.';
    else if (goal.indexOf('strength') !== -1) text += ' Body composition supports strength — maintaining a healthy weight aids performance.';
    else text += ' Worth 20% of your score.';
    return text;
  }

  if (key === 'strength') {
    if (!m.strengthData) return null;
    var pctl = m.strengthData.avgPercentile;
    var zone = pctl >= 70 ? 'above average' : pctl >= 40 ? 'average' : 'below average';
    var text = pctl + 'th percentile overall (' + zone + ') across ' + m.strengthData.uniqueTestTypes + ' test types.';
    if (goal.indexOf('strength') !== -1) {
      var domains = getCompletedDomains(m.strengthData);
      if (domains.missing.length > 0) {
        text += ' Complete ' + domains.missing.map(function(d) { return d.label; }).join(', ') + ' for a confirmed score.';
      } else {
        text += ' All 5 domains tested — keep logging to track progression.';
      }
    } else {
      text += ' Worth 10% of your score.';
    }
    return text;
  }

  if (key === 'aerobic') {
    if (m.vo2max === null) return null;
    var text = 'VO2 max of ' + Math.round(m.vo2max * 10) / 10 + ' mL/kg/min.';
    if (goal.indexOf('cardio') !== -1) text += ' This is your core metric — the best measure of cardiovascular fitness.';
    else if (goal.indexOf('strength') !== -1) text += ' Aerobic base supports recovery between heavy sets.';
    else text += ' The single strongest predictor of all-cause mortality. Worth 5% of your score.';
    return text;
  }

  if (key === 'bloodwork') {
    if (!m.bloodwork) return null;
    var count = Object.keys(m.bloodwork).length;
    var bwScore = typeof scoreBloodwork === 'function' ? scoreBloodwork(m.bloodwork) : null;
    var zone = bwScore !== null ? (bwScore >= 70 ? 'good' : bwScore >= 40 ? 'fair' : 'needs attention') : 'scored';
    var text = count + ' biomarkers tracked — overall ' + zone + '.';
    if (goal.indexOf('strength') !== -1) text += ' Key markers like testosterone, iron, and vitamin D directly affect strength and recovery.';
    else if (goal.indexOf('weight') !== -1) text += ' Metabolic markers like glucose and thyroid function influence weight management.';
    else text += ' Worth 35% of your score.';
    return text;
  }

  return null;
}

// ── BOSS INSIGHT (PROACTIVE AI) ──
var BOSS_INSIGHT_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function loadBossInsight() {
  if (!currentUser) return;

  // Skip in client view — edge function bypasses proxy and would show coach's data
  if (_viewingUserId) {
    var bossContainer = document.getElementById('boss-insight-card');
    if (bossContainer) bossContainer.style.display = 'none';
    return;
  }

  // Don't call if user has no health data at all
  var state = getDataConnectivityState();
  if (state.totalConnected < 1) return;

  var cacheKey = 'healix_boss_insight_' + currentUser.id;
  var container = document.getElementById('boss-insight-card');
  if (!container) return;

  // Check cache
  try {
    var cached = localStorage.getItem(cacheKey);
    if (cached) {
      var c = JSON.parse(cached);
      if (c.cachedAt && (Date.now() - c.cachedAt < BOSS_INSIGHT_TTL) && c.insight) {
        renderBossInsight(c.insight);
        return;
      }
    }
  } catch(e) {}

  // Show loading state
  container.style.display = 'block';
  container.innerHTML = '<div class="boss-insight" style="text-align:center;padding:24px"><div style="color:var(--muted);font-size:12px">Generating your daily insight...</div></div>';

  try {
    var today = new Date();
    var sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    var response = await fetch(SUPABASE_URL + '/functions/v1/generate-unified-health-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({
        userId: currentUser.id,
        startDate: localDateStr(sevenDaysAgo),
        endDate: localDateStr(today)
      })
    });

    if (!response.ok) throw new Error('Status ' + response.status);
    var data = await response.json();

    if (data && data.insight) {
      if (!_viewingUserId) { try { localStorage.setItem(cacheKey, JSON.stringify({ insight: data.insight, cachedAt: Date.now() })); } catch(e) {} }
      renderBossInsight(data.insight);
    } else {
      container.style.display = 'none';
    }
  } catch(e) {
    console.warn('[Healix] Boss insight error:', e.message);
    container.style.display = 'none';
  }
}

function renderBossInsight(insight) {
  var container = document.getElementById('boss-insight-card');
  if (!container || !insight) return;

  var badgeCls = (insight.statusBadge || 'NEUTRAL').toLowerCase();
  var badgeText = insight.statusBadge === 'POSITIVE' ? 'On Track' : insight.statusBadge === 'ATTENTION' ? 'Needs Attention' : 'Neutral';

  var html = '<div class="boss-insight">';
  html += '<div class="boss-badge ' + badgeCls + '">' + badgeText + '</div>';
  html += '<div class="boss-headline">' + escapeHtml(insight.headline || '') + '</div>';
  html += '<div class="boss-summary">' + escapeHtml(insight.summary || '') + '</div>';

  // Primary action
  if (insight.primaryAction) {
    html += '<div class="boss-action"><strong>' + escapeHtml(insight.primaryAction.label || '') + '</strong>';
    if (insight.primaryAction.details) html += '<br>' + escapeHtml(insight.primaryAction.details);
    html += '</div>';
  }

  // Domain check-in bullets
  if (insight.overallCheckIn && insight.overallCheckIn.length > 0) {
    var toneColors = { POSITIVE: 'var(--up)', NEUTRAL: 'var(--gold)', ATTENTION: 'var(--down)' };
    html += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">';
    insight.overallCheckIn.forEach(function(d) {
      var dotColor = toneColors[d.tone] || 'var(--muted)';
      html += '<div style="display:flex;gap:8px;align-items:flex-start">'
        + '<div class="boss-domain-dot" style="background:' + dotColor + '"></div>'
        + '<div style="font-size:12px;color:var(--cream-dim);line-height:1.5">' + escapeHtml(d.bullet || '') + '</div>'
        + '</div>';
    });
    html += '</div>';
  }

  // Discuss link
  var chatQ = encodeURIComponent(insight.headline || 'What should I focus on today?');
  html += '<a href="#" onclick="event.preventDefault();HealixChat.openWithQuestion(decodeURIComponent(\'' + chatQ + '\'))" style="font-size:11px;color:var(--gold);text-decoration:none">Discuss with Healix →</a>';

  html += '</div>';
  container.innerHTML = html;
  container.style.display = 'block';
}

// ── INIT ──
init();
