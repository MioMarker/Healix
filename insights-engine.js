/**
 * Healix Insight Rules Engine
 * Ported from HealthBite mobile app (TypeScript) to vanilla JS for the web dashboard.
 *
 * 122 deterministic rules across 10 domains:
 *   sleep, heart, nutrition, strength, bloodwork, weight, cross, unlock, achievement, bp (heart)
 *
 * Public API exposed on window.HealixInsights:
 *   - runInsightRules(rules, ctx, seenTimestamps, domainTimestamps)
 *   - buildWebRuleContext(metrics, userProfile, byType)
 *   - ALL_INSIGHT_RULES
 */
(function () {
  'use strict';

  // =========================================================================
  // Types & Constants
  // =========================================================================

  var SEVERITY_BASE_SCORE = {
    alert: 400,
    attention: 300,
    positive: 200,
    neutral: 100
  };

  var CAFFEINE_WORDS =
    /\b(coffee|espresso|latte|cappuccino|cold brew|energy drink|pre-workout|matcha)\b/i;

  var ALCOHOL_WORDS =
    /\b(beer|wine|cocktail|whiskey|vodka|rum|bourbon|margarita|ipa|sake|champagne|tequila|gin|seltzer)\b/i;

  var DOMAIN_CATEGORIES = {
    'Upper Push': ['bench_1rm', 'pushup'],
    'Upper Pull': ['pullup', 'dead_hang'],
    'Lower Body': ['squat_1rm', 'deadlift_1rm'],
    'Carry / Grip': ['farmer_carry', 'dead_hang'],
    Core: ['plank', 'sit_to_stand'],
    Aerobic: ['vo2max']
  };

  var ALL_DOMAINS = Object.keys(DOMAIN_CATEGORIES);

  var STRENGTH_STANDARDS = {
    bench_1rm: { beginner: 0.5, novice: 0.75, intermediate: 1.0, advanced: 1.5 },
    squat_1rm: { beginner: 0.75, novice: 1.0, intermediate: 1.5, advanced: 2.0 },
    deadlift_1rm: { beginner: 1.0, novice: 1.25, intermediate: 1.75, advanced: 2.5 }
  };

  var OPTIMAL_RANGES = {
    glucose: { min: 70, max: 100, unit: 'mg/dL', label: 'Fasting Glucose' },
    hba1c: { min: 4.0, max: 5.6, unit: '%', label: 'HbA1c' },
    ldl: { min: 0, max: 100, unit: 'mg/dL', label: 'LDL Cholesterol' },
    hdl: { min: 40, max: Infinity, unit: 'mg/dL', label: 'HDL Cholesterol' },
    triglycerides: { min: 0, max: 150, unit: 'mg/dL', label: 'Triglycerides' },
    crp: { min: 0, max: 1, unit: 'mg/L', label: 'CRP' }
  };

  var RDA_TARGETS = {
    Iron: 18,
    Calcium: 1000,
    'Vitamin D': 15,
    'Vitamin C': 90,
    'Vitamin B12': 2.4,
    Magnesium: 400,
    Potassium: 4700
  };

  // =========================================================================
  // Engine (evaluate, score, filter)
  // =========================================================================

  /** Evaluate all rules against a context, return matched insights */
  function evaluateRules(rules, ctx) {
    var results = [];

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      try {
        var data = rule.detect(ctx);
        if (data === null) continue;

        var tmpl = rule.template(data);
        var severity = tmpl._severity || rule.severity;

        results.push({
          id: rule.id,
          domain: rule.domain,
          severity: severity,
          headline: tmpl.headline,
          body: tmpl.body,
          action: tmpl.action,
          chatQuestion: tmpl.chatQuestion || undefined,
          _score: 0
        });
      } catch (err) {
        console.warn('[InsightRules] Rule "' + rule.id + '" threw:', err);
      }
    }

    return results;
  }

  /**
   * Score insights with rotation-aware freshness system.
   */
  function scoreInsights(insights, seenTimestamps, domainTimestamps) {
    var now = Date.now();
    var dayOfYear = Math.floor(now / 86400000);

    return insights.map(function (insight) {
      var score = SEVERITY_BASE_SCORE[insight.severity] || 100;

      var lastSeen = seenTimestamps[insight.id];
      if (!lastSeen) {
        score += 100;
      } else {
        var daysSinceSeen = (now - lastSeen) / 86400000;
        if (daysSinceSeen < 1) {
          score -= 200;
        } else if (daysSinceSeen < 3) {
          score -= 100;
        } else if (daysSinceSeen < 7) {
          score -= 30;
        } else {
          score += Math.min(80, daysSinceSeen * 5);
        }
      }

      if (insight.severity === 'positive') {
        score += 50;
      }

      var domainTs = domainTimestamps[insight.domain];
      if (domainTs) {
        var daysStale = (now - new Date(domainTs).getTime()) / 86400000;
        if (daysStale > 30) score -= 80;
        else if (daysStale > 14) score -= 40;
        else if (daysStale > 7) score -= 15;
      }

      var hash = 0;
      var jitterKey = insight.id + '-' + dayOfYear;
      for (var j = 0; j < jitterKey.length; j++) {
        hash = ((hash << 5) - hash + jitterKey.charCodeAt(j)) | 0;
      }
      score += (Math.abs(hash) % 30);

      return Object.assign({}, insight, { _score: score });
    });
  }

  /** Filter for domain diversity: max 3 per domain, max 1 unlock, top N total */
  function filterByDiversity(insights, maxPerDomain, maxTotal) {
    if (maxPerDomain == null) maxPerDomain = 3;
    if (maxTotal == null) maxTotal = 10;

    var sorted = insights.slice().sort(function (a, b) { return b._score - a._score; });

    var domainCounts = {};
    var unlockCount = 0;
    var positiveCount = 0;
    var filtered = [];

    for (var i = 0; i < sorted.length; i++) {
      var insight = sorted[i];
      if (filtered.length >= maxTotal) break;

      if (insight.domain === 'unlock') {
        if (unlockCount >= 1) continue;
        unlockCount++;
      }

      var count = domainCounts[insight.domain] || 0;
      var limit = insight.domain === 'cross' ? 3 : maxPerDomain;
      if (count >= limit) continue;

      if (filtered.length >= 5 && positiveCount === 0 && insight.severity !== 'positive') {
        continue;
      }

      if (insight.severity === 'positive') positiveCount++;
      domainCounts[insight.domain] = count + 1;
      filtered.push(insight);
    }

    return filtered;
  }

  /** Full pipeline: evaluate -> score -> filter */
  function runInsightRules(rules, ctx, seenTimestamps, domainTimestamps) {
    if (!seenTimestamps) seenTimestamps = {};
    if (!domainTimestamps) domainTimestamps = {};
    var matched = evaluateRules(rules, ctx);
    var scored = scoreInsights(matched, seenTimestamps, domainTimestamps);
    return filterByDiversity(scored);
  }

  // =========================================================================
  // Context Adapter
  // =========================================================================

  /** Map biomarker names to canonical keys used by rules */
  function mapBiomarkerKey(name) {
    var lower = name.toLowerCase().trim();
    if (lower.includes('glucose') || lower === 'fasting glucose') return 'glucose';
    if (lower.includes('hba1c') || lower.includes('hemoglobin a1c')) return 'hba1c';
    if (lower.includes('ldl')) return 'ldl';
    if (lower.includes('hdl')) return 'hdl';
    if (lower.includes('triglyceride')) return 'triglycerides';
    if (lower === 'crp' || lower.includes('c-reactive') || lower.includes('hs-crp')) return 'crp';
    if (lower.includes('total cholesterol')) return 'totalCholesterol';
    if (lower.includes('tsh')) return 'tsh';
    if (lower.includes('ferritin')) return 'ferritin';
    if (lower.includes('vitamin d')) return 'vitaminD';
    if (lower.includes('vitamin b12') || lower === 'b12') return 'vitaminB12';
    if (lower.includes('cortisol')) return 'cortisol';
    if (lower.includes('testosterone')) return 'testosterone';
    if (lower.includes('creatinine') || lower.includes('egfr')) return 'creatinine';
    if (lower === 'iron' || lower.includes('serum iron')) return 'iron';
    return null;
  }

  /**
   * Build a RuleContext from web dashboard data.
   *
   * @param {Object} metrics  - Dashboard metrics object
   * @param {Object} userProfile - window.userProfileData (Supabase profiles row)
   * @param {Object} byType - window._lastHealthByType (raw health samples by metric_type)
   * @returns {Object} RuleContext compatible with all rules
   */
  function buildWebRuleContext(metrics, userProfile, byType) {
    metrics = metrics || {};
    userProfile = userProfile || {};
    byType = byType || {};

    // --- Compute HR weekly average from raw samples ---
    var hrWeeklyAvg = null;
    var rhrSamples = byType['resting_heart_rate'] || byType['heart_rate'] || [];
    if (rhrSamples.length > 0) {
      var sevenDaysAgo = Date.now() - 7 * 86400000;
      var recentHr = [];
      for (var i = 0; i < rhrSamples.length; i++) {
        var s = rhrSamples[i];
        var sTime = new Date(s.start_date || s.date || s.timestamp || '').getTime();
        if (sTime >= sevenDaysAgo) {
          var val = parseFloat(s.value || s.avg || s.quantity || 0);
          if (val > 0) recentHr.push(val);
        }
      }
      if (recentHr.length > 0) {
        var sum = 0;
        for (var h = 0; h < recentHr.length; h++) sum += recentHr[h];
        hrWeeklyAvg = Math.round(sum / recentHr.length);
      }
    }

    // --- Steps: from metrics or compute from byType ---
    var steps = metrics.steps || null;
    if (steps == null) {
      var stepSamples = byType['step_count'] || [];
      if (stepSamples.length > 0) {
        var stepSum = 0;
        var stepDays = {};
        for (var si = 0; si < stepSamples.length; si++) {
          var ss = stepSamples[si];
          var sVal = parseFloat(ss.value || ss.quantity || 0);
          var sDate = localDateStr(new Date(ss.start_date || ss.date || ''));
          if (!stepDays[sDate]) stepDays[sDate] = 0;
          stepDays[sDate] += sVal;
        }
        var dayKeys = Object.keys(stepDays);
        for (var dk = 0; dk < dayKeys.length; dk++) stepSum += stepDays[dayKeys[dk]];
        if (dayKeys.length > 0) steps = Math.round(stepSum / dayKeys.length);
      }
    }

    // --- Bloodwork: use metrics.bloodwork directly (already canonical key->value) ---
    var bloodwork = metrics.bloodwork || null;

    // --- Strength data ---
    var strengthData = metrics.strengthData || null;

    // --- Sleep data ---
    var sleepData = metrics.sleepData || null;

    // --- Compute real age ---
    var realAge = metrics.realAge || 35;
    if (!metrics.realAge && userProfile.birth_date) {
      var birth = new Date(userProfile.birth_date);
      var now = new Date();
      var age = now.getFullYear() - birth.getFullYear();
      if (now.getMonth() < birth.getMonth() ||
          (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) {
        age--;
      }
      realAge = age;
    }

    // --- Weight score ---
    var weightScore = metrics.weightScore != null ? metrics.weightScore : null;

    // --- Build vitality result from dashboard globals ---
    var result = null;
    if (window._lastVitalityResult) {
      result = window._lastVitalityResult;
    }

    // --- VA History ---
    var vaHistory = window._vitalityHistory || [];

    // --- Meals ---
    var meals = window._lastMealData || [];

    // --- Parse family history ---
    var familyHistory = null;
    if (userProfile.family_history) {
      if (typeof userProfile.family_history === 'string') {
        try { familyHistory = JSON.parse(userProfile.family_history); } catch (e) { /* ignore */ }
      } else {
        familyHistory = userProfile.family_history;
      }
    }

    // --- Profile ---
    var profile = {
      primary_goal: userProfile.primary_goal || null,
      current_weight_kg: userProfile.current_weight_kg || null,
      height_cm: userProfile.height_cm || null,
      target_weight_kg: userProfile.target_weight_kg || null,
      birth_date: userProfile.birth_date || null,
      gender: userProfile.gender || null,
      sex: (userProfile.gender || '').toLowerCase() === 'female' ? 'female' : 'male',
      family_history: familyHistory,
      systolic_bp: metrics.systolic || userProfile.systolic_bp || null,
      diastolic_bp: metrics.diastolic || userProfile.diastolic_bp || null
    };

    // --- Timestamps ---
    var timestamps = {};
    if (strengthData && strengthData.tests && strengthData.tests.length > 0) {
      timestamps.strength = strengthData.tests[0].tested_at;
    }

    return {
      metrics: {
        hr: metrics.hr || null,
        hrWeeklyAvg: hrWeeklyAvg,
        steps: steps,
        sleepData: sleepData,
        weightScore: weightScore,
        bloodwork: bloodwork,
        strengthData: strengthData,
        vo2max: metrics.vo2max || null,
        realAge: realAge
      },
      result: result,
      vaHistory: vaHistory,
      meals: meals,
      profile: profile,
      timestamps: timestamps
    };
  }

  // =========================================================================
  // Helper Functions
  // =========================================================================

  /** Check if user's primary goal includes a keyword */
  function goalIncludes(ctx, keyword) {
    var goal = (ctx.profile && ctx.profile.primary_goal) ? ctx.profile.primary_goal.toLowerCase() : '';
    return goal.indexOf(keyword.toLowerCase()) !== -1;
  }

  /** Get local date string YYYY-MM-DD */
  function localDateStr(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1);
    if (m.length < 2) m = '0' + m;
    var d = String(date.getDate());
    if (d.length < 2) d = '0' + d;
    return y + '-' + m + '-' + d;
  }

  /** Extract macros from a meal's data JSON */
  function getMacrosFromMeal(meal) {
    var result = { cal: 0, prot: 0, carb: 0, fat: 0 };
    var data = meal.data;
    if (!data || !data.total_nutrition) return result;

    var allNutrients = [];
    var categories = Object.keys(data.total_nutrition);
    for (var c = 0; c < categories.length; c++) {
      var arr = data.total_nutrition[categories[c]];
      if (Array.isArray(arr)) {
        for (var a = 0; a < arr.length; a++) allNutrients.push(arr[a]);
      }
    }

    for (var i = 0; i < allNutrients.length; i++) {
      var n = allNutrients[i];
      var name = (n.name || '').toLowerCase().trim();
      var val = n.value || 0;
      if (name === 'calories' || name === 'energy' || name === 'total calories') result.cal = val;
      else if (name === 'protein') result.prot = val;
      else if (name.indexOf('carbohydrate') !== -1 || name === 'carbs' || name === 'total carbohydrate') result.carb = val;
      else if (name === 'fat' || name === 'total fat') result.fat = val;
    }
    return result;
  }

  function normalizeMicroName(name) {
    var lower = name.toLowerCase().trim();
    if (lower.indexOf('magnesium') !== -1) return 'Magnesium';
    if (lower.indexOf('calcium') !== -1) return 'Calcium';
    if (lower.indexOf('iron') !== -1) return 'Iron';
    if (lower.indexOf('zinc') !== -1) return 'Zinc';
    if (lower.indexOf('potassium') !== -1) return 'Potassium';
    if (lower.indexOf('sodium') !== -1) return 'Sodium';
    if (lower === 'fiber' || lower === 'dietary fiber') return 'Fiber';
    if (lower.indexOf('vitamin d') !== -1) return 'Vitamin D';
    if (lower.indexOf('vitamin c') !== -1) return 'Vitamin C';
    if (lower.indexOf('vitamin b12') !== -1 || lower === 'b12') return 'Vitamin B12';
    if (lower.indexOf('omega-3') !== -1 || lower.indexOf('omega 3') !== -1 || lower === 'dha' || lower === 'epa') return 'Omega-3';
    if (lower.indexOf('saturated fat') !== -1) return 'Saturated Fat';
    if (lower.indexOf('leucine') !== -1) return 'Leucine';
    if (lower.indexOf('caffeine') !== -1) return 'Caffeine';
    if (lower.indexOf('alcohol') !== -1) return 'Alcohol';
    return name;
  }

  /** Sum micronutrients across multiple meals, returns totals by canonical name */
  function getMicroTotalsFromMeals(meals) {
    var totals = {};
    for (var mi = 0; mi < meals.length; mi++) {
      var meal = meals[mi];
      if (!meal.data || !meal.data.total_nutrition) continue;
      var categories = Object.keys(meal.data.total_nutrition);
      for (var c = 0; c < categories.length; c++) {
        var arr = meal.data.total_nutrition[categories[c]];
        if (!Array.isArray(arr)) continue;
        for (var a = 0; a < arr.length; a++) {
          var n = arr[a];
          if (!n.name || !n.value) continue;
          var key = normalizeMicroName(n.name);
          totals[key] = (totals[key] || 0) + n.value;
        }
      }
    }
    return totals;
  }

  /** Get recent meals (last N days) */
  function getRecentMeals(meals, days) {
    var now = new Date();
    var todayStr = localDateStr(now);
    return meals.filter(function (m) {
      var mDate = localDateStr(new Date(m.meal_time || m.created_at || ''));
      var diffDays = (new Date(todayStr).getTime() - new Date(mDate).getTime()) / 86400000;
      return diffDays <= days;
    });
  }

  /** Count unique days in a list of meals */
  function countMealDays(meals) {
    var days = {};
    for (var i = 0; i < meals.length; i++) {
      var d = localDateStr(new Date(meals[i].meal_time || meals[i].created_at || ''));
      days[d] = true;
    }
    var count = Object.keys(days).length;
    return Math.max(1, count);
  }

  /** Parse family history from profile (handles string or object) */
  function parseFamilyHistory(ctx) {
    if (!ctx.profile || !ctx.profile.family_history) return null;
    var fh = ctx.profile.family_history;
    if (typeof fh === 'string') {
      try { return JSON.parse(fh); } catch (e) { return null; }
    }
    return fh;
  }

  /** Get recent meals (7 days) only if there are >= minCount meals */
  function recentMealsOrNull(ctx, minCount) {
    if (minCount == null) minCount = 5;
    var recent = getRecentMeals(ctx.meals, 7);
    return recent.length >= minCount ? recent : null;
  }

  /** Daily average for a micronutrient across recent meals */
  function dailyMicro(meals, key) {
    var totals = getMicroTotalsFromMeals(meals);
    var days = countMealDays(meals);
    return (totals[key] || 0) / days;
  }

  /** Group meals by date string */
  function mealsByDate(meals) {
    var grouped = {};
    for (var i = 0; i < meals.length; i++) {
      var meal = meals[i];
      var date = localDateStr(new Date(meal.meal_time || meal.created_at || ''));
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(meal);
    }
    return grouped;
  }

  // --- Strength helpers ---

  function testDomain(testKey) {
    var keys = Object.keys(DOMAIN_CATEGORIES);
    for (var i = 0; i < keys.length; i++) {
      if (DOMAIN_CATEGORIES[keys[i]].indexOf(testKey) !== -1) return keys[i];
    }
    return null;
  }

  function testsByKey(ctx) {
    var grouped = {};
    var tests = (ctx.metrics.strengthData && ctx.metrics.strengthData.tests) ? ctx.metrics.strengthData.tests : [];

    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      if (!grouped[t.test_key]) grouped[t.test_key] = [];
      grouped[t.test_key].push({ raw_value: t.raw_value, percentile: t.percentile, tested_at: t.tested_at });
    }

    var keys = Object.keys(grouped);
    for (var k = 0; k < keys.length; k++) {
      grouped[keys[k]].sort(function (a, b) {
        return new Date(a.tested_at).getTime() - new Date(b.tested_at).getTime();
      });
    }

    return grouped;
  }

  function completedDomains(ctx) {
    var byKey = testsByKey(ctx);
    var testedKeys = {};
    var bkKeys = Object.keys(byKey);
    for (var i = 0; i < bkKeys.length; i++) testedKeys[bkKeys[i]] = true;

    return ALL_DOMAINS.filter(function (domain) {
      var domainKeys = DOMAIN_CATEGORIES[domain];
      for (var j = 0; j < domainKeys.length; j++) {
        if (testedKeys[domainKeys[j]]) return true;
      }
      return false;
    });
  }

  function classifyStrengthLevel(ratio, standards) {
    if (ratio >= standards.advanced) return 'advanced';
    if (ratio >= standards.intermediate) return 'intermediate';
    if (ratio >= standards.novice) return 'novice';
    return 'beginner';
  }

  // --- Heart helpers ---

  function hrScoreToTier(score) {
    if (score >= 70) return 'good';
    if (score >= 40) return 'fair';
    return 'low';
  }

  function previousHrTier(ctx) {
    var sorted = ctx.vaHistory.slice().sort(function (a, b) {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
    var prev = null;
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i].drivers && sorted[i].drivers['restingHR'] != null) {
        prev = sorted[i];
        break;
      }
    }
    if (!prev || !prev.drivers || prev.drivers['restingHR'] == null) return null;
    return hrScoreToTier(prev.drivers['restingHR']);
  }

  // --- Weight helpers ---

  function weightScoreToTier(score) {
    if (score >= 70) return 'good';
    if (score >= 40) return 'fair';
    return 'low';
  }

  function previousWeightTier(ctx) {
    var sorted = ctx.vaHistory.slice().sort(function (a, b) {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
    var prev = null;
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i].drivers && sorted[i].drivers['weight'] != null) {
        prev = sorted[i];
        break;
      }
    }
    if (!prev || !prev.drivers || prev.drivers['weight'] == null) return null;
    return weightScoreToTier(prev.drivers['weight']);
  }

  // --- BP helpers ---

  function getSystolic(ctx) {
    if (ctx.profile && ctx.profile.systolic_bp != null) return ctx.profile.systolic_bp;
    return null;
  }

  function getDiastolic(ctx) {
    if (ctx.profile && ctx.profile.diastolic_bp != null) return ctx.profile.diastolic_bp;
    return null;
  }

  // =========================================================================
  // Rules: Sleep
  // =========================================================================

  var sleepDebtHigh = {
    id: 'sleep_debt_high',
    domain: 'sleep',
    severity: 'attention',
    detect: function (ctx) {
      var debt = ctx.metrics.sleepData ? ctx.metrics.sleepData.debt : null;
      if (debt == null || debt <= 7) return null;
      return {
        debt: debt,
        goalIsSleep: goalIncludes(ctx, 'sleep'),
        goalIsFeel: goalIncludes(ctx, 'feel')
      };
    },
    template: function (data) {
      var body = 'You\'ve accumulated about ' + data.debt.toFixed(1) + ' hours of sleep debt against the AASM-recommended 7+ hours/night for adults.';
      if (data.goalIsSleep) {
        body += ' Since sleep is one of your goals, this gap is worth tracking closely.';
      }
      return {
        headline: 'Sleep debt is high',
        body: body,
        action: 'Track your bedtime to see where the deficit is coming from.'
      };
    }
  };

  var sleepTrend = {
    id: 'sleep_trend',
    domain: 'sleep',
    severity: 'neutral',
    detect: function (ctx) {
      var trend = ctx.metrics.sleepData ? ctx.metrics.sleepData.trend : null;
      if (trend == null || trend.direction === 'stable') return null;
      return { direction: trend.direction, deltaHours: trend.deltaHours };
    },
    template: function (data) {
      var improving = data.direction === 'improving' || data.direction === 'up';
      var absHours = Math.abs(data.deltaHours).toFixed(1);
      return {
        headline: 'Sleep duration ' + (improving ? 'improving' : 'declining'),
        body: improving
          ? 'You\'re averaging about ' + absHours + ' more hours of sleep compared to last week. Consistency here compounds into better energy and recovery.'
          : 'You\'re averaging about ' + absHours + ' fewer hours of sleep compared to last week. Even small dips in duration add up over time.',
        action: improving
          ? 'Keep your current bedtime routine going.'
          : 'Try setting a wind-down alarm 30 minutes before your target bedtime.'
      };
    }
  };

  var achievementSleepConsistency = {
    id: 'achievement_sleep_consistency',
    domain: 'sleep',
    severity: 'positive',
    detect: function (ctx) {
      var sleep = ctx.metrics.sleepData;
      if (sleep == null) return null;
      var avg = sleep.avg;
      var efficiency = sleep.efficiency;
      var debt = sleep.debt;
      if (avg == null || efficiency == null) return null;
      if (avg < 7 || efficiency < 85 || debt > 3) return null;
      return { avg: avg, efficiency: efficiency, debt: debt };
    },
    template: function (data) {
      return {
        headline: 'Sleep is dialed in',
        body: 'Averaging ' + data.avg.toFixed(1) + ' hours with ' + data.efficiency + '% efficiency and minimal debt. This is the kind of consistency that drives long-term health gains.',
        action: 'Keep doing what you\'re doing.'
      };
    }
  };

  var sleepEfficiencyFocus = {
    id: 'sleep_efficiency_focus',
    domain: 'sleep',
    severity: 'attention',
    detect: function (ctx) {
      var efficiency = ctx.metrics.sleepData ? ctx.metrics.sleepData.efficiency : null;
      if (efficiency == null || efficiency >= 85) return null;
      return { efficiency: efficiency };
    },
    template: function (data) {
      return {
        headline: 'Sleep efficiency below 85%',
        body: 'Your sleep efficiency is ' + data.efficiency + '% \u2014 meaning ' + (100 - data.efficiency) + '% of your time in bed is spent awake. Clinical sleep medicine generally considers 85%+ as the typical healthy range. Research supports cognitive behavioral therapy for insomnia (CBT-I) as a first-line approach for chronic insomnia.',
        action: 'How can I improve my sleep efficiency?'
      };
    }
  };

  var sleepDeepPctLow = {
    id: 'sleep_deep_pct_low',
    domain: 'sleep',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.metrics.vo2max) return null;
      var deepPct = (ctx.metrics.sleepData && ctx.metrics.sleepData.stages && ctx.metrics.sleepData.stages.deep) ? ctx.metrics.sleepData.stages.deep.pct : null;
      if (deepPct == null || deepPct >= 13) return null;
      return { deepPct: deepPct };
    },
    template: function (data) {
      return {
        headline: 'Deep sleep is critically low',
        body: 'Deep sleep is only ' + data.deepPct + '% of your total (target: 15-20%). A 2023 study in Sleep found deep sleep duration is the strongest predictor of all-cause mortality \u2014 stronger than total sleep time. Deep sleep drives growth hormone release, tissue repair, and immune function.',
        action: 'How can I increase my deep sleep?'
      };
    }
  };

  var sleepRemPctLow = {
    id: 'sleep_rem_pct_low',
    domain: 'sleep',
    severity: 'attention',
    detect: function (ctx) {
      var remPct = (ctx.metrics.sleepData && ctx.metrics.sleepData.stages && ctx.metrics.sleepData.stages.rem) ? ctx.metrics.sleepData.stages.rem.pct : null;
      if (remPct == null || remPct >= 18) return null;
      return { remPct: remPct };
    },
    template: function (data) {
      return {
        headline: 'REM sleep is below target',
        body: 'REM is ' + data.remPct + '% of your sleep (target: 20-25%). Research links lower REM sleep duration to higher dementia incidence. REM tends to concentrate in the final hours of sleep, so short nights disproportionately reduce it.',
        action: 'What affects my REM sleep and why does it matter?'
      };
    }
  };

  var sleepDeepPctGood = {
    id: 'sleep_deep_pct_good',
    domain: 'sleep',
    severity: 'positive',
    detect: function (ctx) {
      if (ctx.metrics.vo2max) return null;
      var deepPct = (ctx.metrics.sleepData && ctx.metrics.sleepData.stages && ctx.metrics.sleepData.stages.deep) ? ctx.metrics.sleepData.stages.deep.pct : null;
      if (deepPct == null || deepPct < 15) return null;
      return { deepPct: deepPct };
    },
    template: function (data) {
      return {
        headline: 'Deep sleep is strong',
        body: data.deepPct + '% deep sleep puts you in the healthy range. This is the most restorative stage \u2014 driving growth hormone, tissue repair, and immune function. A 2023 study found this is the single strongest sleep predictor of longevity.',
        action: 'What can I do to maintain good deep sleep?'
      };
    }
  };

  var sleepRemPctGood = {
    id: 'sleep_rem_pct_good',
    domain: 'sleep',
    severity: 'positive',
    detect: function (ctx) {
      var remPct = (ctx.metrics.sleepData && ctx.metrics.sleepData.stages && ctx.metrics.sleepData.stages.rem) ? ctx.metrics.sleepData.stages.rem.pct : null;
      if (remPct == null || remPct < 20) return null;
      return { remPct: remPct };
    },
    template: function (data) {
      return {
        headline: 'REM sleep is on target',
        body: data.remPct + '% REM sleep is in the typical healthy range. Research links higher REM sleep duration to lower dementia incidence in adults.',
        action: 'How does REM sleep affect my brain health?'
      };
    }
  };

  var sleepBedtimeConsistency = {
    id: 'sleep_bedtime_consistency',
    domain: 'sleep',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'sleep')) return null;
      return null;
    },
    template: function () {
      return {
        headline: 'Bedtime consistency',
        body: 'Consistent bedtimes help regulate your circadian rhythm, making it easier to fall asleep and improving sleep quality over time.',
        action: 'Try to keep your bedtime within a 30-minute window each night.'
      };
    }
  };

  var wellnessSleepFoundation = {
    id: 'wellness_sleep_foundation',
    domain: 'sleep',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'feel')) return null;
      if (ctx.metrics.hr) return null;
      var systolic = getSystolic(ctx);
      if (systolic) return null;
      var avg = ctx.metrics.sleepData ? ctx.metrics.sleepData.avg : null;
      if (avg == null || avg >= 6.5) return null;
      return { avg: avg };
    },
    template: function (data) {
      return {
        headline: 'Sleep as a foundation',
        body: 'You\'re averaging ' + data.avg.toFixed(1) + ' hours of sleep. AASM recommends 7+ hours per night for adults.',
        action: 'Track your bedtime to see what\'s driving the shorter nights.'
      };
    }
  };

  // =========================================================================
  // Rules: Heart
  // =========================================================================

  var hrThresholdCrossed = {
    id: 'hr_threshold_crossed',
    domain: 'heart',
    severity: 'attention',
    detect: function (ctx) {
      var hr = ctx.metrics.hr;
      if (hr == null) return null;
      var hrScore = null;
      if (ctx.result && ctx.result.scores) {
        for (var i = 0; i < ctx.result.scores.length; i++) {
          if (ctx.result.scores[i].name === 'restingHR') {
            hrScore = ctx.result.scores[i].score;
            break;
          }
        }
      }
      if (hrScore == null) return null;
      var currentTier = hrScoreToTier(hrScore);
      var prevTier = previousHrTier(ctx);
      if (prevTier == null || prevTier === currentTier) return null;
      var tierRank = { good: 2, fair: 1, low: 0 };
      var improved = tierRank[currentTier] > tierRank[prevTier];
      return { currentTier: currentTier, previousTier: prevTier, improved: improved };
    },
    template: function (data) {
      var verb = data.improved ? 'improved' : 'dropped';
      return {
        headline: 'Resting HR ' + verb + ' to ' + data.currentTier,
        body: data.improved
          ? 'Your resting heart rate score moved from ' + data.previousTier + ' to ' + data.currentTier + '. Keep up the consistency.'
          : 'Your resting heart rate score shifted from ' + data.previousTier + ' to ' + data.currentTier + '. Stress, sleep, and hydration can all influence this.',
        action: data.improved
          ? 'Review your recent activity for what helped.'
          : 'Check sleep quality and stress levels this week.'
      };
    }
  };

  var hrTrend = {
    id: 'hr_trend',
    domain: 'heart',
    severity: 'neutral',
    detect: function (ctx) {
      var hr = ctx.metrics.hr;
      if (hr == null) return null;
      var sorted = ctx.vaHistory.filter(function (e) {
        return e.drivers && e.drivers['restingHR'] != null;
      }).sort(function (a, b) {
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
      if (sorted.length < 2) return null;
      var recent = sorted.slice(-3);
      var firstScore = (recent[0].drivers && recent[0].drivers['restingHR']) || 0;
      var lastScore = (recent[recent.length - 1].drivers && recent[recent.length - 1].drivers['restingHR']) || 0;
      var delta = lastScore - firstScore;
      if (Math.abs(delta) < 5) return null;
      var direction = delta > 0 ? 'down' : 'up';
      return { direction: direction, hr: hr };
    },
    template: function (data) {
      var improving = data.direction === 'down';
      return {
        headline: 'Resting HR trending ' + data.direction,
        body: improving
          ? 'Your resting heart rate is trending downward over recent weeks.'
          : 'Your resting heart rate is trending upward over recent weeks. Stress, sleep, hydration, and training load are common factors that affect resting HR.',
        action: improving
          ? 'Note what changed in your routine.'
          : 'Note any recent changes in sleep, stress, or training.'
      };
    }
  };

  var hrvTrend = {
    id: 'hrv_trend',
    domain: 'heart',
    severity: 'neutral',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var hrvLowBaseline = {
    id: 'hrv_low_baseline',
    domain: 'heart',
    severity: 'attention',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var seeDoctorRhrExtreme = {
    id: 'see_doctor_rhr_extreme',
    domain: 'heart',
    severity: 'alert',
    detect: function (ctx) {
      var hr = ctx.metrics.hr;
      if (hr == null) return null;
      if (hr >= 100) return { type: 'tachycardia', hr: hr };
      var vo2 = ctx.metrics.vo2max;
      var likelyAthlete = vo2 != null && vo2 >= 50;
      if (hr <= 40 && !likelyAthlete) return { type: 'bradycardia', hr: hr };
      return null;
    },
    template: function (data) {
      if (data.type === 'tachycardia') {
        return {
          headline: 'Resting heart rate is very high',
          body: 'Your resting HR of ' + data.hr + ' bpm is at or above 100, which is above the AHA\'s normal adult resting range (60–100 bpm).',
          action: 'Consider speaking with a healthcare provider if this persists.'
        };
      }
      return {
        headline: 'Resting heart rate is unusually low',
        body: 'Your resting HR of ' + data.hr + ' bpm is at or below 40, which is below the AHA\'s normal adult resting range (60–100 bpm). Endurance athletes commonly fall below this range; otherwise this may warrant a clinical conversation.',
        action: 'Consider speaking with a healthcare provider.'
      };
    }
  };

  var achievementRhrElite = {
    id: 'achievement_rhr_elite',
    domain: 'heart',
    severity: 'positive',
    detect: function (ctx) {
      var hr = ctx.metrics.hr;
      if (hr == null || hr > 55) return null;
      return { hr: hr };
    },
    template: function (data) {
      return {
        headline: 'Athlete-level resting heart rate',
        body: 'A resting HR of ' + data.hr + ' bpm puts you in the athlete zone. This reflects strong cardiovascular conditioning.',
        action: 'Keep training consistently to maintain this.'
      };
    }
  };

  var wellnessRhrElevated = {
    id: 'wellness_rhr_elevated',
    domain: 'heart',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'feel')) return null;
      var hr = ctx.metrics.hr;
      var steps = ctx.metrics.steps;
      if (hr == null || steps == null) return null;
      if (hr <= 75 || steps >= 12000) return null;
      return { hr: hr, steps: steps };
    },
    template: function (data) {
      return {
        headline: 'Elevated resting heart rate',
        body: 'Your resting HR of ' + data.hr + ' bpm is on the higher end of the AHA\'s normal adult resting range (60–100 bpm), and your activity level is averaging ' + data.steps.toLocaleString() + ' steps/day.',
        action: 'Note any recent changes in sleep, stress, or activity.'
      };
    }
  };

  // =========================================================================
  // Rules: Nutrition
  // =========================================================================

  var proteinDeficit = {
    id: 'protein_deficit',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength') && !goalIncludes(ctx, 'weight')) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      if (weightKg == null) return null;
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var targetG = 1.6 * weightKg;
      var byDate = mealsByDate(recent);
      var dates = Object.keys(byDate);
      var daysChecked = Math.min(dates.length, 7);
      var hitDays = 0;
      for (var i = 0; i < dates.length; i++) {
        var dayProtein = 0;
        for (var j = 0; j < byDate[dates[i]].length; j++) {
          dayProtein += getMacrosFromMeal(byDate[dates[i]][j]).prot;
        }
        if (dayProtein >= targetG * 0.8) hitDays++;
      }
      if (hitDays >= daysChecked - 1) return null;
      return { hitDays: hitDays, daysChecked: daysChecked, targetG: targetG };
    },
    template: function (data) {
      return {
        headline: 'Protein intake is falling short',
        body: 'You hit at least 80% of your ' + Math.round(data.targetG) + 'g protein target on only ' + data.hitDays + ' of the last ' + data.daysChecked + ' days. Research links adequate protein intake to muscle protein synthesis and recovery in active adults.',
        action: 'Track protein across meals to see where the gap is.'
      };
    }
  };

  var proteinOnTrack = {
    id: 'protein_on_track',
    domain: 'nutrition',
    severity: 'positive',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength') && !goalIncludes(ctx, 'weight')) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      if (weightKg == null) return null;
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var targetG = 1.6 * weightKg;
      var byDate = mealsByDate(recent);
      var dates = Object.keys(byDate);
      var daysChecked = Math.min(dates.length, 7);
      var hitDays = 0;
      for (var i = 0; i < dates.length; i++) {
        var dayProtein = 0;
        for (var j = 0; j < byDate[dates[i]].length; j++) {
          dayProtein += getMacrosFromMeal(byDate[dates[i]][j]).prot;
        }
        if (dayProtein >= targetG * 0.8) hitDays++;
      }
      if (hitDays < daysChecked - 1) return null;
      return { hitDays: hitDays, daysChecked: daysChecked, targetG: targetG };
    },
    template: function (data) {
      return {
        headline: 'Protein intake is on track',
        body: 'You hit your ' + Math.round(data.targetG) + 'g protein target on ' + data.hitDays + ' of the last ' + data.daysChecked + ' days. Research links consistent protein intake to muscle protein synthesis and recovery in active adults.',
        action: 'Keep tracking to maintain visibility on your intake.'
      };
    }
  };

  var calorieSurplus = {
    id: 'calorie_surplus',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'weight')) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      if (weightKg == null) return null;
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var targetCal = weightKg * 22;
      var byDate = mealsByDate(recent);
      var dates = Object.keys(byDate);
      var surplusDays = 0;
      for (var i = 0; i < dates.length; i++) {
        var dayCal = 0;
        for (var j = 0; j < byDate[dates[i]].length; j++) {
          dayCal += getMacrosFromMeal(byDate[dates[i]][j]).cal;
        }
        if (dayCal > targetCal * 1.1) surplusDays++;
      }
      if (surplusDays < 3) return null;
      return { surplusDays: surplusDays, targetCal: Math.round(targetCal) };
    },
    template: function (data) {
      return {
        headline: 'Calorie intake exceeding target',
        body: 'You exceeded your estimated ' + data.targetCal + ' kcal maintenance target by more than 10% on ' + data.surplusDays + ' of the last 7 days.',
        action: 'Review your recent meals to see where the surplus came from.'
      };
    }
  };

  var proteinDistribution = {
    id: 'protein_distribution',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength') && !goalIncludes(ctx, 'weight')) return null;
      var todayStr = localDateStr(new Date());
      var todayMeals = ctx.meals.filter(function (m) {
        return localDateStr(new Date(m.meal_time || m.created_at || '')) === todayStr;
      });
      if (todayMeals.length < 2) return null;
      var mealProteins = todayMeals.map(function (m) {
        return { prot: getMacrosFromMeal(m).prot, type: m.meal_type || 'meal' };
      });
      var totalProt = 0;
      for (var i = 0; i < mealProteins.length; i++) totalProt += mealProteins[i].prot;
      if (totalProt <= 0) return null;
      var maxProt = 0;
      var maxType = 'meal';
      for (var j = 0; j < mealProteins.length; j++) {
        if (mealProteins[j].prot > maxProt) {
          maxProt = mealProteins[j].prot;
          maxType = mealProteins[j].type;
        }
      }
      var maxPct = (maxProt / totalProt) * 100;
      if (maxPct <= 60) return null;
      return { maxPct: Math.round(maxPct), mealType: maxType };
    },
    template: function (data) {
      return {
        headline: 'Protein is concentrated in one meal',
        body: 'About ' + data.maxPct + '% of today\'s protein came from your ' + data.mealType + '. Research suggests muscle protein synthesis is supported by distributing protein across meals.',
        action: 'Note where else in your day you could include protein.'
      };
    }
  };

  var sodiumPotassiumRatio = {
    id: 'sodium_potassium_ratio',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var sodium = dailyMicro(recent, 'Sodium');
      var potassium = dailyMicro(recent, 'Potassium');
      if (potassium <= 0) return null;
      var ratio = sodium / potassium;
      if (sodium <= 2500 || potassium >= 3500 || ratio <= 1.5) return null;
      return { sodium: Math.round(sodium), potassium: Math.round(potassium), ratio: Math.round(ratio * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Sodium-to-potassium ratio is elevated',
        body: 'Your average daily sodium (' + data.sodium + 'mg) is high and potassium (' + data.potassium + 'mg) is low, giving a ratio of ' + data.ratio + '. Research links high dietary sodium-to-potassium ratios to elevated blood pressure.',
        action: 'Bananas, sweet potatoes, and leafy greens are common potassium sources.'
      };
    }
  };

  var calciumBoneStrength = {
    id: 'calcium_bone_strength',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var dailyCa = dailyMicro(recent, 'Calcium');
      if (dailyCa >= 800) return null;
      return { dailyCa: Math.round(dailyCa) };
    },
    template: function (data) {
      return {
        headline: 'Calcium intake is low',
        body: 'Your average daily calcium is about ' + data.dailyCa + 'mg, below NIH\'s recommended 1,000mg daily intake for most adults. Calcium plays a role in maintaining bone density.',
        action: 'Dairy products, fortified plant milks, and leafy greens are common calcium sources.'
      };
    }
  };

  var b12Deficiency = {
    id: 'b12_deficiency',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var dailyB12 = dailyMicro(recent, 'Vitamin B12');
      if (dailyB12 >= 2.0) return null;
      return { dailyB12: Math.round(dailyB12 * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Vitamin B12 intake may be low',
        body: 'Your average daily B12 from meals is about ' + data.dailyB12 + 'mcg, below the NIH-recommended 2.4mcg daily intake for adults. B12 plays a role in red blood cell formation and nerve function.',
        action: 'Animal products and fortified cereals are common B12 sources; discuss supplementation with a healthcare provider.'
      };
    }
  };

  var ironVitaminCSynergy = {
    id: 'iron_vitamin_c_synergy',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var dailyIron = dailyMicro(recent, 'Iron');
      var dailyVitC = dailyMicro(recent, 'Vitamin C');
      if (dailyIron >= 18 || dailyVitC >= 90) return null;
      return { dailyIron: Math.round(dailyIron * 10) / 10, dailyVitC: Math.round(dailyVitC) };
    },
    template: function (data) {
      return {
        headline: 'Low iron and vitamin C together',
        body: 'Your daily iron (~' + data.dailyIron + 'mg) and vitamin C (~' + data.dailyVitC + 'mg) are both below NIH recommended intakes. Per NIH, vitamin C enhances non-heme iron absorption.',
        action: 'Pairing iron-rich foods (beans, spinach, red meat) with vitamin C sources (citrus, peppers) is one common approach.'
      };
    }
  };

  var calciumIronConflict = {
    id: 'calcium_iron_conflict',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function (ctx) {
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var dailyIron = dailyMicro(recent, 'Iron');
      var dailyCa = dailyMicro(recent, 'Calcium');
      if (dailyIron >= 18 || dailyCa <= 800) return null;
      return { dailyIron: Math.round(dailyIron * 10) / 10, dailyCa: Math.round(dailyCa) };
    },
    template: function (data) {
      return {
        headline: 'Calcium may be blocking iron absorption',
        body: 'Your iron intake (~' + data.dailyIron + 'mg/day) is below NIH recommended intake while calcium is adequate (~' + data.dailyCa + 'mg/day). Per NIH, calcium can interfere with non-heme iron absorption when consumed in the same meal.',
        action: 'Separating calcium-rich and iron-rich foods into different meals is one common approach.'
      };
    }
  };

  var energyBalanceDaily = {
    id: 'energy_balance_daily',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var energyBalanceWeekly = {
    id: 'energy_balance_weekly',
    domain: 'nutrition',
    severity: 'neutral',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var deficitTooAggressive = {
    id: 'deficit_too_aggressive',
    domain: 'nutrition',
    severity: 'attention',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var energyDeficiencyTriad = {
    id: 'energy_deficiency_triad',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'feel')) return null;
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var thresholds = { Iron: 18, 'Vitamin B12': 2.4, 'Vitamin D': 15 };
      var lowNutrients = [];
      var keys = Object.keys(thresholds);
      for (var i = 0; i < keys.length; i++) {
        if (dailyMicro(recent, keys[i]) < thresholds[keys[i]]) {
          lowNutrients.push(keys[i]);
        }
      }
      if (lowNutrients.length < 2) return null;
      return { lowNutrients: lowNutrients };
    },
    template: function (data) {
      var list = data.lowNutrients.join(', ');
      return {
        headline: 'Multiple energy nutrients are low',
        body: 'Your intake of ' + list + ' is below NIH recommended daily levels. These nutrients play roles in energy metabolism.',
        action: 'Discuss with a healthcare provider whether supplementation is appropriate for you.'
      };
    }
  };

  var wellnessNutritionCompleteness = {
    id: 'wellness_nutrition_completeness',
    domain: 'nutrition',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'feel')) return null;
      var recent = recentMealsOrNull(ctx, 3);
      if (!recent) return null;
      var lowNutrients = [];
      var keys = Object.keys(RDA_TARGETS);
      for (var i = 0; i < keys.length; i++) {
        var daily = dailyMicro(recent, keys[i]);
        if (daily < RDA_TARGETS[keys[i]] * 0.6) {
          lowNutrients.push(keys[i]);
        }
      }
      if (lowNutrients.length < 3) return null;
      return { lowCount: lowNutrients.length, lowNutrients: lowNutrients };
    },
    template: function (data) {
      var list = data.lowNutrients.join(', ');
      return {
        headline: 'Nutrition gaps detected',
        body: data.lowCount + ' key micronutrients (' + list + ') are below 60% of the NIH recommended daily amount based on your logged meals.',
        action: 'Variety in fruits, vegetables, and whole grains is one common way to broaden micronutrient intake.'
      };
    }
  };

  var winMealLoggingConsistency = {
    id: 'win_meal_logging_consistency',
    domain: 'nutrition',
    severity: 'positive',
    detect: function (ctx) {
      var recent = getRecentMeals(ctx.meals, 7);
      var daysLogged = countMealDays(recent);
      if (daysLogged < 5) return null;
      return { daysLogged: daysLogged };
    },
    template: function (data) {
      return {
        headline: 'Great meal logging consistency',
        body: 'You logged meals on ' + data.daysLogged + ' of the last 7 days. Consistent tracking is one of the strongest predictors of achieving nutrition goals.',
        action: 'Keep the streak going \u2014 every logged meal makes your insights more accurate.'
      };
    }
  };

  // =========================================================================
  // Rules: Strength
  // =========================================================================

  var liftPr = {
    id: 'lift_pr',
    domain: 'strength',
    severity: 'positive',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      var byKey = testsByKey(ctx);
      var prs = [];
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) {
        var entries = byKey[keys[k]];
        if (entries.length < 2) continue;
        var latest = entries[entries.length - 1];
        var previous = entries[entries.length - 2];
        if (latest.raw_value > previous.raw_value) {
          prs.push({ key: keys[k], previous: previous.raw_value, latest: latest.raw_value });
        }
      }
      if (prs.length === 0) return null;
      return { prs: prs };
    },
    template: function (data) {
      var prList = data.prs.map(function (pr) {
        return pr.key.replace(/_/g, ' ') + ' (' + pr.previous + ' -> ' + pr.latest + ')';
      }).join(', ');
      var plural = data.prs.length > 1 ? 'PRs' : 'PR';
      return {
        headline: 'New personal ' + plural + ' set',
        body: 'You hit new personal records: ' + prList + '.',
        action: 'Log your next session to keep tracking progress.'
      };
    }
  };

  var liftStall = {
    id: 'lift_stall',
    domain: 'strength',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      var byKey = testsByKey(ctx);
      var stalledLifts = [];
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) {
        var entries = byKey[keys[k]];
        if (entries.length < 2) continue;
        var latest = entries[entries.length - 1];
        var previous = entries[entries.length - 2];
        if (latest.raw_value > previous.raw_value) continue;
        var daysBetween = Math.round(
          (new Date(latest.tested_at).getTime() - new Date(previous.tested_at).getTime()) / 86400000
        );
        if (daysBetween >= 28) {
          stalledLifts.push({ key: keys[k], daysBetween: daysBetween });
        }
      }
      if (stalledLifts.length === 0) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      var lowProtein = false;
      if (weightKg != null) {
        var recent = getRecentMeals(ctx.meals, 7);
        if (recent.length >= 3) {
          var days = countMealDays(recent);
          var totalProt = 0;
          for (var r = 0; r < recent.length; r++) {
            totalProt += getMacrosFromMeal(recent[r]).prot;
          }
          var avgProt = totalProt / days;
          lowProtein = avgProt < weightKg * 1.6 * 0.8;
        }
      }
      return { stalledLifts: stalledLifts, lowProtein: lowProtein };
    },
    template: function (data) {
      var liftNames = data.stalledLifts.map(function (s) { return s.key.replace(/_/g, ' '); }).join(', ');
      var body = 'Your ' + liftNames + ' ' + (data.stalledLifts.length > 1 ? 'have' : 'has') + ' plateaued for 4+ weeks.';
      if (data.lowProtein) {
        body += ' Your recent protein intake is also below target, which may be contributing.';
      }
      return {
        headline: 'Strength plateau detected',
        body: body,
        action: data.lowProtein
          ? 'Increase protein intake and consider adjusting your training program.'
          : 'Consider adjusting training volume, intensity, or exercise variation.'
      };
    }
  };

  var domainIncomplete = {
    id: 'domain_incomplete',
    domain: 'strength',
    severity: 'neutral',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      if (!ctx.metrics.strengthData || ctx.metrics.strengthData.testCount === 0) return null;
      var completed = completedDomains(ctx);
      if (completed.length >= ALL_DOMAINS.length) return null;
      var missing = ALL_DOMAINS.filter(function (d) { return completed.indexOf(d) === -1; });
      return { completed: completed.length, total: ALL_DOMAINS.length, missing: missing };
    },
    template: function (data) {
      var missingList = data.missing.join(', ');
      return {
        headline: data.completed + ' of ' + data.total + ' fitness domains tested',
        body: 'You haven\'t tested: ' + missingList + '. A complete picture across all domains helps identify strengths and weaknesses in your fitness profile.',
        action: 'Add a test in one of the missing domains to round out your assessment.'
      };
    }
  };

  var trainingStale = {
    id: 'training_stale',
    domain: 'strength',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      var lastStrength = ctx.timestamps['strength'];
      if (!lastStrength) return null;
      var daysSince = Math.round((Date.now() - new Date(lastStrength).getTime()) / 86400000);
      if (daysSince < 21) return null;
      return { daysSince: daysSince };
    },
    template: function (data) {
      return {
        headline: 'Fitness tests are getting stale',
        body: 'It\'s been ' + data.daysSince + ' days since your last fitness test. Regular re-testing helps track progress and keeps your strength profile current.',
        action: 'Schedule a quick fitness test this week to update your baseline.'
      };
    }
  };

  var pushPullImbalance = {
    id: 'push_pull_imbalance',
    domain: 'strength',
    severity: 'attention',
    detect: function (ctx) {
      var byKey = testsByKey(ctx);
      var pushKeys = ['bench_1rm', 'pushup'];
      var pullKeys = ['pullup', 'dead_hang'];
      var pushPercentiles = [];
      var pullPercentiles = [];
      for (var i = 0; i < pushKeys.length; i++) {
        var entries = byKey[pushKeys[i]];
        if (entries && entries.length > 0) {
          var latest = entries[entries.length - 1];
          if (latest.percentile != null) pushPercentiles.push(latest.percentile);
        }
      }
      for (var j = 0; j < pullKeys.length; j++) {
        var entries2 = byKey[pullKeys[j]];
        if (entries2 && entries2.length > 0) {
          var latest2 = entries2[entries2.length - 1];
          if (latest2.percentile != null) pullPercentiles.push(latest2.percentile);
        }
      }
      if (pushPercentiles.length === 0 || pullPercentiles.length === 0) return null;
      var pushSum = 0;
      for (var ps = 0; ps < pushPercentiles.length; ps++) pushSum += pushPercentiles[ps];
      var pushAvg = pushSum / pushPercentiles.length;
      var pullSum = 0;
      for (var pl = 0; pl < pullPercentiles.length; pl++) pullSum += pullPercentiles[pl];
      var pullAvg = pullSum / pullPercentiles.length;
      var gap = Math.abs(pushAvg - pullAvg);
      if (gap < 25) return null;
      var direction = pushAvg > pullAvg ? 'push-dominant' : 'pull-dominant';
      return { pushAvg: Math.round(pushAvg), pullAvg: Math.round(pullAvg), gap: Math.round(gap), direction: direction };
    },
    template: function (data) {
      var weaker = data.direction === 'push-dominant' ? 'pulling' : 'pushing';
      return {
        headline: 'Push-pull imbalance detected',
        body: 'Your push percentile (' + data.pushAvg + 'th) and pull percentile (' + data.pullAvg + 'th) differ by ' + data.gap + ' points. You\'re ' + data.direction + '.',
        action: 'Adding ' + weaker + ' exercises is one way to close the gap.'
      };
    }
  };

  var strengthBodyweightRatio = {
    id: 'strength_bodyweight_ratio',
    domain: 'strength',
    severity: 'neutral',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      if (weightKg == null || weightKg <= 0) return null;
      var byKey = testsByKey(ctx);
      var lifts = [];
      var stdKeys = Object.keys(STRENGTH_STANDARDS);
      for (var i = 0; i < stdKeys.length; i++) {
        var key = stdKeys[i];
        var entries = byKey[key];
        if (!entries || entries.length === 0) continue;
        var latest = entries[entries.length - 1];
        var ratio = latest.raw_value / weightKg;
        var level = classifyStrengthLevel(ratio, STRENGTH_STANDARDS[key]);
        lifts.push({ key: key, ratio: Math.round(ratio * 100) / 100, level: level });
      }
      if (lifts.length === 0) return null;
      return { lifts: lifts };
    },
    template: function (data) {
      var summary = data.lifts.map(function (l) {
        return l.key.replace(/_/g, ' ') + ': ' + l.ratio + 'x BW (' + l.level + ')';
      }).join(', ');
      return {
        headline: 'Strength-to-bodyweight ratios',
        body: 'Your current ratios: ' + summary + '. These benchmarks help contextualize your absolute strength relative to your size.',
        action: 'Use these levels to set progressive training targets.'
      };
    }
  };

  var achievementStrengthProgress = {
    id: 'achievement_strength_progress',
    domain: 'strength',
    severity: 'positive',
    detect: function (ctx) {
      var byKey = testsByKey(ctx);
      var gains = [];
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) {
        var entries = byKey[keys[k]];
        if (entries.length < 2) continue;
        var oldest = entries[0];
        var latest = entries[entries.length - 1];
        if (oldest.raw_value <= 0) continue;
        var gainPct = ((latest.raw_value - oldest.raw_value) / oldest.raw_value) * 100;
        if (gainPct >= 10) {
          gains.push({ key: keys[k], gainPct: Math.round(gainPct) });
        }
      }
      if (gains.length === 0) return null;
      return { gains: gains };
    },
    template: function (data) {
      var gainList = data.gains.map(function (g) {
        return g.key.replace(/_/g, ' ') + ' (+' + g.gainPct + '%)';
      }).join(', ');
      return {
        headline: 'Significant strength gains',
        body: 'You\'ve made 10%+ improvements: ' + gainList + '. That level of progress reflects real adaptation from consistent training.',
        action: 'Keep pushing \u2014 document what\'s working so you can replicate it.'
      };
    }
  };

  var achievementAllDomains = {
    id: 'achievement_all_domains',
    domain: 'strength',
    severity: 'positive',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      if (!ctx.metrics.strengthData || ctx.metrics.strengthData.testCount === 0) return null;
      var completed = completedDomains(ctx);
      if (completed.length < ALL_DOMAINS.length) return null;
      return { domainCount: ALL_DOMAINS.length };
    },
    template: function (data) {
      return {
        headline: 'All fitness domains tested',
        body: 'You\'ve completed tests across all ' + data.domainCount + ' fitness domains: Upper Push, Upper Pull, Lower Body, Core, and Aerobic. This gives you a comprehensive view of your overall fitness.',
        action: 'Re-test periodically to track changes across all domains.'
      };
    }
  };

  // =========================================================================
  // Rules: Blood Pressure
  // =========================================================================

  var bpOptimal = {
    id: 'bp_optimal',
    domain: 'heart',
    severity: 'positive',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      if (sys == null || dia == null) return null;
      if (sys >= 120 || dia >= 80) return null;
      return { sys: sys, dia: dia };
    },
    template: function (data) {
      return {
        headline: 'Blood pressure is optimal',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg is in the optimal range (<120/80). This is one of the strongest cardiovascular health signals.',
        action: 'How does blood pressure affect my heart health?'
      };
    }
  };

  var bpElevated = {
    id: 'bp_elevated',
    domain: 'heart',
    severity: 'attention',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      if (sys == null || dia == null) return null;
      if (sys >= 140 || dia >= 90) return null;
      var elevated = (sys >= 120 && sys <= 139) || (dia >= 80 && dia <= 89);
      if (!elevated) return null;
      return { sys: sys, dia: dia };
    },
    template: function (data) {
      return {
        headline: 'Blood pressure is elevated',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg is above the optimal 120/80 threshold. The AHA classifies this as elevated/stage 1 hypertension. Regular exercise, reducing sodium, and improving sleep are the most effective lifestyle interventions.',
        action: 'How can I lower my blood pressure naturally?'
      };
    }
  };

  var bpHypertension = {
    id: 'bp_hypertension',
    domain: 'heart',
    severity: 'alert',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      if (sys == null || dia == null) return null;
      if (sys < 140 && dia < 90) return null;
      return { sys: sys, dia: dia };
    },
    template: function (data) {
      return {
        headline: 'Talk to your doctor: blood pressure in hypertensive range',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg is at or above 140/90, which the AHA classifies as stage 2 hypertension. Please discuss with your doctor at your next visit.',
        action: 'What does stage 2 hypertension mean?'
      };
    }
  };

  var bpActivityConnection = {
    id: 'bp_activity_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      var steps = ctx.metrics.steps;
      if (sys == null || dia == null || steps == null) return null;
      if (sys < 130 || steps >= 6000) return null;
      return { sys: sys, dia: dia, steps: steps };
    },
    template: function (data) {
      return {
        headline: 'Low activity may be contributing to elevated blood pressure',
        body: 'Your blood pressure is ' + data.sys + '/' + data.dia + ' mmHg and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day. Regular aerobic exercise is the single most effective non-pharmaceutical blood pressure intervention \u2014 a 2019 meta-analysis found it reduces systolic BP by 5\u20138 mmHg.',
        action: 'How does exercise affect blood pressure?'
      };
    }
  };

  var bpSleepConnection = {
    id: 'bp_sleep_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      if (sys == null || dia == null) return null;
      if (sys < 130) return null;
      var avgSleep = (ctx.metrics.sleepData && ctx.metrics.sleepData.avg != null) ? ctx.metrics.sleepData.avg : ((ctx.metrics.sleepData && ctx.metrics.sleepData.latest != null) ? ctx.metrics.sleepData.latest : null);
      if (avgSleep == null || avgSleep >= 6.5) return null;
      return { sys: sys, dia: dia, sleep: Math.round(avgSleep * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Poor sleep linked to elevated blood pressure',
        body: 'Your blood pressure is ' + data.sys + '/' + data.dia + ' mmHg and you\'re averaging ' + data.sleep + 'h of sleep. Research links short sleep duration (<6 hours) to elevated blood pressure.',
        action: 'How does sleep affect blood pressure?'
      };
    }
  };

  var bpSodiumConnection = {
    id: 'bp_sodium_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      if (sys == null || dia == null) return null;
      if (sys < 130) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length < 3) return null;
      var totals = getMicroTotalsFromMeals(recent);
      var days = countMealDays(recent);
      var dailySodium = (totals['Sodium'] || 0) / days;
      if (dailySodium <= 2500) return null;
      return { sys: sys, dia: dia, sodium: Math.round(dailySodium) };
    },
    template: function (data) {
      return {
        headline: 'High sodium intake with elevated blood pressure',
        body: 'Your blood pressure is ' + data.sys + '/' + data.dia + ' mmHg and you\'re averaging ' + data.sodium + 'mg sodium/day. The DASH trial showed reducing sodium to <2300mg/day lowers systolic BP by 5\u20136 mmHg.',
        action: 'How does sodium affect my blood pressure?'
      };
    }
  };

  var bpHrCompound = {
    id: 'bp_hr_compound',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      var dia = getDiastolic(ctx);
      var hr = ctx.metrics.hr;
      if (sys == null || dia == null || hr == null) return null;
      if (sys < 130 || hr <= 75) return null;
      return { sys: sys, dia: dia, hr: hr };
    },
    template: function (data) {
      return {
        headline: 'Elevated blood pressure and heart rate together',
        body: 'Your blood pressure of ' + data.sys + '/' + data.dia + ' mmHg and resting HR of ' + data.hr + ' bpm are both elevated relative to AHA reference ranges.',
        action: 'Why are both my blood pressure and heart rate elevated?'
      };
    }
  };

  var bpNotSet = {
    id: 'bp_not_set',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      var sys = getSystolic(ctx);
      if (sys != null) return null;
      var hasHr = ctx.metrics.hr != null;
      var hasBloodwork = ctx.metrics.bloodwork != null;
      var hasStrength = ctx.metrics.strengthData != null;
      if (!hasHr && !hasBloodwork && !hasStrength) return null;
      return true;
    },
    template: function () {
      return {
        headline: 'Add blood pressure to improve your Vitality Age',
        body: 'Blood pressure is one of the strongest cardiovascular predictors and accounts for 15% of your Vitality Age score. Add it in Edit Profile to unlock this component.',
        action: 'Why is blood pressure important for my health score?'
      };
    }
  };

  var vo2LowForAge = {
    id: 'vo2_low_for_age',
    domain: 'heart',
    severity: 'attention',
    detect: function (ctx) {
      var vo2 = ctx.metrics.vo2max;
      if (vo2 == null || vo2 >= 30) return null;
      return { vo2: Math.round(vo2 * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'VO2 max is below average',
        body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min is below the typical range for your age. Research links higher cardiorespiratory fitness to lower all-cause mortality.',
        action: 'How can I improve my VO2 max?'
      };
    }
  };

  var vo2AboveAverage = {
    id: 'vo2_above_average',
    domain: 'heart',
    severity: 'positive',
    detect: function (ctx) {
      var vo2 = ctx.metrics.vo2max;
      if (vo2 == null || vo2 < 40) return null;
      return { vo2: Math.round(vo2 * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'VO2 max is above average',
        body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min puts you above average for your age. Research from the Cooper Institute shows this level of aerobic fitness is associated with significantly lower all-cause mortality.',
        action: 'How does my VO2 max compare to my age group?'
      };
    }
  };

  // =========================================================================
  // Rules: Bloodwork
  // =========================================================================

  var bloodworkFlagged = {
    id: 'bloodwork_flagged',
    domain: 'bloodwork',
    severity: 'attention',
    detect: function (ctx) {
      var bloodwork = ctx.metrics.bloodwork;
      if (!bloodwork) return null;
      var flagged = [];
      var keys = Object.keys(OPTIMAL_RANGES);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var range = OPTIMAL_RANGES[key];
        var value = bloodwork[key];
        if (value == null) continue;
        var belowMin = range.min > 0 && value < range.min;
        var aboveMax = range.max !== Infinity && value > range.max;
        if (belowMin) {
          flagged.push({ key: key, value: value, label: range.label, unit: range.unit, direction: 'low' });
        } else if (aboveMax) {
          flagged.push({ key: key, value: value, label: range.label, unit: range.unit, direction: 'high' });
        }
      }
      if (flagged.length === 0) return null;
      return { flagged: flagged };
    },
    template: function (data) {
      var details = data.flagged.map(function (f) {
        return f.label + ': ' + f.value + ' ' + f.unit + ' (' + f.direction + ')';
      }).join('; ');
      var plural = data.flagged.length > 1 ? 'markers are' : 'marker is';
      return {
        headline: 'Bloodwork ' + plural + ' outside optimal range',
        body: 'The following ' + plural + ' outside the optimal range: ' + details + '. Optimal ranges shown are based on AHA cholesterol guidelines and ADA glucose standards. Discuss these results with your healthcare provider.',
        action: 'Discuss these results with your healthcare provider.',
        _severity: data.flagged.length >= 3 ? 'alert' : 'attention'
      };
    }
  };

  var seeDoctorCrpWeightLoss = {
    id: 'see_doctor_crp_weight_loss',
    domain: 'bloodwork',
    severity: 'alert',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var seeDoctorGlucoseSpike = {
    id: 'see_doctor_glucose_spike',
    domain: 'bloodwork',
    severity: 'alert',
    detect: function (ctx) {
      var bloodwork = ctx.metrics.bloodwork;
      if (!bloodwork) return null;
      var glucose = bloodwork['glucose'] != null ? bloodwork['glucose'] : null;
      var hba1c = bloodwork['hba1c'] != null ? bloodwork['hba1c'] : null;
      var glucoseHigh = glucose != null && glucose >= 126;
      var hba1cHigh = hba1c != null && hba1c >= 6.5;
      if (!glucoseHigh && !hba1cHigh) return null;
      return {
        glucose: glucoseHigh ? glucose : null,
        hba1c: hba1cHigh ? hba1c : null
      };
    },
    template: function (data) {
      var markers = [];
      if (data.glucose != null) markers.push('fasting glucose of ' + data.glucose + ' mg/dL');
      if (data.hba1c != null) markers.push('HbA1c of ' + data.hba1c + '%');
      var markerText = markers.join(' and ');
      return {
        headline: 'Blood sugar levels require medical attention',
        body: 'Your ' + markerText + ' ' + (markers.length > 1 ? 'are' : 'is') + ' at or above the ADA diabetes diagnostic thresholds (fasting glucose ≥126 mg/dL or HbA1c ≥6.5%). These values warrant prompt medical evaluation.',
        action: 'Schedule an appointment with your healthcare provider as soon as possible.'
      };
    }
  };

  // =========================================================================
  // Rules: Achievement
  // =========================================================================

  var achievementVaImproved = {
    id: 'achievement_va_improved',
    domain: 'achievement',
    severity: 'positive',
    detect: function (ctx) {
      if (ctx.vaHistory.length < 7) return null;
      var sorted = ctx.vaHistory.slice().sort(function (a, b) {
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
      var first = sorted[0];
      var last = sorted[sorted.length - 1];
      var improvement = first.vAge - last.vAge;
      if (improvement < 1) return null;
      return { improvement: improvement };
    },
    template: function (data) {
      var years = data.improvement.toFixed(1);
      return {
        headline: 'Vitality Age improved ' + years + ' years',
        body: 'Since you started tracking, your Vitality Age has dropped by ' + years + ' years. That reflects real, measurable progress across your health metrics.',
        action: 'Keep the momentum going \u2014 consistency compounds.'
      };
    }
  };

  var achievementComposite80 = {
    id: 'achievement_composite_80',
    domain: 'achievement',
    severity: 'positive',
    detect: function (ctx) {
      if (ctx.result == null) return null;
      if (ctx.result.composite < 80) return null;
      return { composite: ctx.result.composite };
    },
    template: function (data) {
      var score = Math.round(data.composite);
      return {
        headline: 'Composite health score: ' + score + '/100',
        body: 'A composite score of ' + score + ' puts you well above average. This reflects strong performance across heart, sleep, weight, and fitness metrics.',
        action: 'Review individual scores to see where you can push further.'
      };
    }
  };

  var winVitalityImproving = {
    id: 'win_vitality_improving',
    domain: 'achievement',
    severity: 'positive',
    detect: function (ctx) {
      if (ctx.vaHistory.length < 5) return null;
      var sorted = ctx.vaHistory.slice().sort(function (a, b) {
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
      var recent = sorted.slice(-7);
      if (recent.length < 5) return null;
      var first = recent[0];
      var last = recent[recent.length - 1];
      var improvement = first.vAge - last.vAge;
      if (improvement < 0.5) return null;
      return { improvement: improvement, entries: recent.length };
    },
    template: function (data) {
      var years = data.improvement.toFixed(1);
      return {
        headline: 'Vitality Age improving',
        body: 'Over your last ' + data.entries + ' check-ins, your Vitality Age has improved by ' + years + ' year' + (data.improvement >= 2 ? 's' : '') + '. Whatever you\u2019re doing is working.',
        action: 'Check which health drivers improved the most.'
      };
    }
  };

  // =========================================================================
  // Rules: Unlock
  // =========================================================================

  var unlockBloodwork = {
    id: 'unlock_bloodwork',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.metrics.bloodwork != null) return null;
      var hasHr = ctx.metrics.hr != null;
      var hasSleep = ctx.metrics.sleepData != null;
      var hasSteps = ctx.metrics.steps != null;
      if (!hasHr && !hasSleep && !hasSteps) return null;
      return { hasHr: hasHr, hasSleep: hasSleep, hasSteps: hasSteps };
    },
    template: function () {
      return {
        headline: 'Unlock 15+ insights with bloodwork',
        body: 'Adding bloodwork results unlocks lipid, metabolic, and inflammation insights that wearables alone can\'t provide. It also sharpens your Vitality Age calculation.',
        action: 'Upload bloodwork in the Documents tab.'
      };
    }
  };

  var unlockMeals = {
    id: 'unlock_meals',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.meals.length >= 5) return null;
      var hasHr = ctx.metrics.hr != null;
      var hasSleep = ctx.metrics.sleepData != null;
      if (!hasHr && !hasSleep) return null;
      return { mealCount: ctx.meals.length };
    },
    template: function (data) {
      var remaining = 5 - data.mealCount;
      return {
        headline: 'Log meals to unlock nutrition insights',
        body: 'With ' + remaining + ' more meal' + (remaining === 1 ? '' : 's') + ' logged, Healix can analyze your macro balance, micronutrient gaps, and how nutrition interacts with your sleep and heart rate data.',
        action: 'Log a meal to get started.'
      };
    }
  };

  var unlockStrength = {
    id: 'unlock_strength',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.metrics.strengthData != null) return null;
      if (!goalIncludes(ctx, 'strength')) return null;
      return true;
    },
    template: function () {
      return {
        headline: 'Log a fitness test',
        body: 'Strength testing lets Healix track your functional fitness over time and factor it into your Vitality Age. Even one test gives a baseline.',
        action: 'Add a fitness test in the Strength tab.'
      };
    }
  };

  var unlockSleep = {
    id: 'unlock_sleep',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.metrics.sleepData != null) return null;
      if (ctx.metrics.hr == null) return null;
      return true;
    },
    template: function () {
      return {
        headline: 'Connect sleep data for recovery insights',
        body: 'Sleep is the foundation of recovery. Connecting sleep data unlocks debt tracking, deep-sleep analysis, and correlations between sleep quality and your heart rate trends.',
        action: 'Connect a sleep-tracking wearable in Settings.'
      };
    }
  };

  var unlockVo2 = {
    id: 'unlock_vo2',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.metrics.vo2max != null) return null;
      var hasStrength = ctx.metrics.strengthData != null;
      var hasBloodwork = ctx.metrics.bloodwork != null;
      if (!hasStrength && !hasBloodwork) return null;
      return { hasStrength: hasStrength, hasBloodwork: hasBloodwork };
    },
    template: function () {
      return {
        headline: 'Add VO2 max \u2014 the top longevity predictor',
        body: 'VO2 max is the single strongest predictor of all-cause mortality. Adding it gives Healix a critical data point for your Vitality Age and cardiovascular profile.',
        action: 'Sync VO2 max from your wearable or enter it manually.'
      };
    }
  };

  var unlockFamilyHistory = {
    id: 'unlock_family_history',
    domain: 'unlock',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.profile && ctx.profile.family_history != null) return null;
      if (ctx.metrics.bloodwork == null) return null;
      return true;
    },
    template: function () {
      return {
        headline: 'Add family history for personalized risk signals',
        body: 'Family history helps Healix flag bloodwork markers that matter most for you. A family history of heart disease, diabetes, or cancer changes which biomarkers deserve attention.',
        action: 'Add family history in Settings.'
      };
    }
  };

  // =========================================================================
  // Rules: Weight
  // =========================================================================

  var weightThresholdCrossed = {
    id: 'weight_threshold_crossed',
    domain: 'weight',
    severity: 'attention',
    detect: function (ctx) {
      var weightScore = ctx.metrics.weightScore;
      if (weightScore == null) return null;
      var currentTier = weightScoreToTier(weightScore);
      var prevTier = previousWeightTier(ctx);
      if (prevTier == null || prevTier === currentTier) return null;
      var tierRank = { good: 2, fair: 1, low: 0 };
      var improved = tierRank[currentTier] > tierRank[prevTier];
      return { currentTier: currentTier, previousTier: prevTier, improved: improved };
    },
    template: function (data) {
      var verb = data.improved ? 'improved' : 'dropped';
      return {
        headline: 'Weight score ' + verb,
        body: data.improved
          ? 'Your weight score moved from ' + data.previousTier + ' to ' + data.currentTier + '.'
          : 'Your weight score shifted from ' + data.previousTier + ' to ' + data.currentTier + '. Day-to-day weight fluctuations are common.',
        action: 'Note what changed in your recent routine.'
      };
    }
  };

  var weightTrend = {
    id: 'weight_trend',
    domain: 'weight',
    severity: 'neutral',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var achievementWeightGoalProgress = {
    id: 'achievement_weight_goal_progress',
    domain: 'weight',
    severity: 'positive',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  // =========================================================================
  // Rules: Cross-Domain
  // =========================================================================

  var vo2DeepSleep = {
    id: 'vo2_deep_sleep',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      if (ctx.metrics.vo2max == null) return null;
      var deep = (ctx.metrics.sleepData && ctx.metrics.sleepData.stages) ? ctx.metrics.sleepData.stages.deep : null;
      if (!deep || deep.pct == null) return null;
      var age = ctx.metrics.realAge || 35;
      var vo2Good = 40;
      if (age >= 60) vo2Good = 30;
      else if (age >= 50) vo2Good = 33;
      else if (age >= 40) vo2Good = 36;
      return {
        vo2: Math.round(ctx.metrics.vo2max * 10) / 10,
        deepPct: deep.pct,
        goodSleep: deep.pct >= 15,
        goodVo2: ctx.metrics.vo2max >= vo2Good
      };
    },
    template: function (data) {
      if (data.goodSleep && data.goodVo2) {
        return {
          headline: 'Aerobic fitness supporting deep sleep',
          body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min and ' + data.deepPct + '% deep sleep are both in the typical healthy range.',
          action: 'How does VO2 max affect my sleep quality?',
          _severity: 'positive'
        };
      }
      if (data.goodSleep && !data.goodVo2) {
        return {
          headline: 'Deep sleep is good \u2014 VO2 max could help it further',
          body: 'Your deep sleep is ' + data.deepPct + '% (typical healthy range) but your VO2 max of ' + data.vo2 + ' ml/kg/min is below average for your age.',
          action: 'How does VO2 max affect my sleep quality?',
          chatQuestion: 'How can I improve my VO2 max to get better sleep?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Deep sleep below target',
        body: 'Your deep sleep is ' + data.deepPct + '% (target: 15-20%) and your VO2 max is ' + data.vo2 + '.',
        action: 'How can I increase my deep sleep percentage?',
        _severity: 'attention'
      };
    }
  };

  var sleepRhrCorrelation = {
    id: 'sleep_rhr_correlation',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.metrics.hr == null) return null;
      var avgSleep = (ctx.metrics.sleepData && ctx.metrics.sleepData.avg != null) ? ctx.metrics.sleepData.avg : ((ctx.metrics.sleepData && ctx.metrics.sleepData.latest != null) ? ctx.metrics.sleepData.latest : null);
      if (avgSleep == null) return null;
      if (avgSleep >= 6 || ctx.metrics.hr <= 72) return null;
      return { hr: ctx.metrics.hr, sleep: Math.round(avgSleep * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Short sleep is elevating your heart rate',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep (below AASM-recommended 7+ hours) and your resting HR is ' + data.hr + ' bpm.',
        action: 'How does sleep affect my resting heart rate?'
      };
    }
  };

  var stepsSleepEfficiency = {
    id: 'steps_sleep_efficiency',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      var steps = ctx.metrics.steps;
      var eff = ctx.metrics.sleepData ? ctx.metrics.sleepData.efficiency : null;
      if (steps == null || eff == null) return null;
      if (steps < 4000 && eff < 82) return { steps: steps, efficiency: eff, low: true };
      if (steps >= 7000 && eff >= 88) return { steps: steps, efficiency: eff, low: false };
      return null;
    },
    template: function (data) {
      if (data.low) {
        return {
          headline: 'Low activity may be hurting sleep quality',
          body: 'You logged ' + data.steps.toLocaleString() + ' steps today and your sleep efficiency is ' + data.efficiency + '%.',
          action: 'How does physical activity affect my sleep?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Activity level supporting sleep quality',
        body: 'Your ' + data.steps.toLocaleString() + ' daily steps and ' + data.efficiency + '% sleep efficiency are both in healthy ranges.',
        action: 'What else can I do to optimize my sleep?',
        _severity: 'positive'
      };
    }
  };

  var gripStrengthLongevity = {
    id: 'grip_strength_longevity',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      var tests = ctx.metrics.strengthData ? ctx.metrics.strengthData.tests : null;
      if (!tests) return null;
      var grip = null;
      for (var i = 0; i < tests.length; i++) {
        if (tests[i].test_key === 'grip_strength' || tests[i].test_key === 'dead_hang') {
          grip = tests[i];
          break;
        }
      }
      if (!grip) return null;
      var isDeadHang = grip.test_key === 'dead_hang';
      return {
        value: Math.round(grip.raw_value),
        pctl: grip.percentile != null ? grip.percentile : 50,
        unit: isDeadHang ? 'seconds' : 'lbs',
        isDeadHang: isDeadHang
      };
    },
    template: function (data) {
      var sev = data.pctl >= 50 ? 'positive' : 'attention';
      var label = data.isDeadHang ? 'hang endurance' : 'grip strength';
      var valueStr = data.value + ' ' + data.unit;
      var body;
      if (data.pctl >= 50) {
        body = 'Your ' + label + ' of ' + valueStr + ' (' + data.pctl + 'th percentile) is a powerful longevity signal. A Lancet study of 140,000 people found grip strength predicts cardiovascular death better than blood pressure.';
      } else if (data.isDeadHang) {
        body = 'Your ' + label + ' of ' + valueStr + ' (' + data.pctl + 'th percentile) has room to improve. Hang endurance is a strong proxy for grip strength, which a Lancet study of 140,000 people linked to cardiovascular mortality. Progressive dead hangs and farmer\'s walks are high-ROI exercises.';
      } else {
        body = 'Your ' + label + ' of ' + valueStr + ' (' + data.pctl + 'th percentile) has room to improve. A Lancet study of 140,000 people found each 5 kg decrease in grip strength increases cardiovascular mortality by 17%. Dead hangs and farmer\'s walks are high-ROI exercises.';
      }
      return {
        headline: (data.isDeadHang ? 'Hang endurance' : 'Grip strength') + ': ' + (data.pctl >= 50 ? 'strong longevity signal' : 'worth improving'),
        body: body,
        action: 'Why is grip strength important for longevity?',
        _severity: sev
      };
    }
  };

  var pushupCardiovascular = {
    id: 'pushup_cardiovascular',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      var tests = ctx.metrics.strengthData ? ctx.metrics.strengthData.tests : null;
      if (!tests) return null;
      var pushup = null;
      for (var i = 0; i < tests.length; i++) {
        if (tests[i].test_key === 'pushup') { pushup = tests[i]; break; }
      }
      if (!pushup) return null;
      return { reps: Math.round(pushup.raw_value) };
    },
    template: function (data) {
      if (data.reps >= 40) {
        return {
          headline: 'Pushups: cardiovascular risk indicator',
          body: 'You logged ' + data.reps + ' pushups. A Harvard-affiliated study found that men completing 40+ pushups had a 96% lower risk of heart events over 10 years. You\'re in the protective zone.',
          action: 'How do pushups relate to heart health?',
          _severity: 'positive'
        };
      }
      if (data.reps >= 10) {
        return {
          headline: 'Pushups: cardiovascular risk indicator',
          body: 'You logged ' + data.reps + ' pushups. Research shows 40+ pushups is associated with 96% lower cardiovascular event risk. Building toward that threshold is a meaningful heart health goal.',
          action: 'How do pushups relate to heart health?',
          _severity: 'neutral'
        };
      }
      return {
        headline: 'Pushups: cardiovascular risk indicator',
        body: 'You logged ' + data.reps + ' pushups. Research links low pushup capacity (<10) to significantly higher cardiovascular risk. This is one of the simplest, most predictive fitness tests \u2014 worth building up.',
        action: 'How do pushups relate to heart health?',
        _severity: 'attention'
      };
    }
  };

  var vo2RhrConsistency = {
    id: 'vo2_rhr_consistency',
    domain: 'cross',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.metrics.vo2max == null || ctx.metrics.hr == null) return null;
      var vo2 = ctx.metrics.vo2max;
      var rhr = ctx.metrics.hr;
      var highFit = vo2 >= 40;
      var highHr = rhr > 72;
      var lowFit = vo2 < 30;
      var lowHr = rhr < 60;
      if (highFit && highHr) return { vo2: Math.round(vo2 * 10) / 10, rhr: rhr, inconsistent: true };
      if (lowFit && lowHr) return { vo2: Math.round(vo2 * 10) / 10, rhr: rhr, inconsistent: true };
      if (highFit && lowHr) return { vo2: Math.round(vo2 * 10) / 10, rhr: rhr, inconsistent: false };
      return null;
    },
    template: function (data) {
      if (data.inconsistent) {
        return {
          headline: 'VO2 max and resting HR are misaligned',
          body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min and resting HR of ' + data.rhr + ' bpm don\'t match typical patterns. Stress, dehydration, and training load are common factors that can affect this alignment.',
          action: 'Why is my resting heart rate higher than expected for my fitness level?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Fitness and heart rate well aligned',
        body: 'Your VO2 max of ' + data.vo2 + ' ml/kg/min and resting HR of ' + data.rhr + ' bpm are in ranges typical of good cardiovascular conditioning.',
        action: 'How can I continue improving my cardiovascular fitness?',
        _severity: 'positive'
      };
    }
  };

  var sleepGlucose = {
    id: 'sleep_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var avgSleep = (ctx.metrics.sleepData && ctx.metrics.sleepData.avg != null) ? ctx.metrics.sleepData.avg : ((ctx.metrics.sleepData && ctx.metrics.sleepData.latest != null) ? ctx.metrics.sleepData.latest : null);
      if (avgSleep == null) return null;
      var bw = ctx.metrics.bloodwork;
      if (!bw) return null;
      var glucose = bw.glucose != null ? bw.glucose : null;
      var hba1c = bw.hba1c != null ? bw.hba1c : null;
      if (glucose == null && hba1c == null) return null;
      var shortSleep = avgSleep < 6.5;
      var elevated = (glucose != null && glucose > 100) || (hba1c != null && hba1c > 5.6);
      if (!shortSleep || !elevated) return null;
      return { sleep: Math.round(avgSleep * 10) / 10, glucose: glucose, hba1c: hba1c };
    },
    template: function (data) {
      var markers = [];
      if (data.glucose != null) markers.push('fasting glucose of ' + data.glucose + ' mg/dL');
      if (data.hba1c != null) markers.push('HbA1c of ' + data.hba1c + '%');
      return {
        headline: 'Short sleep may be affecting blood sugar',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep (below AASM-recommended 7+ hours) with ' + markers.join(' and ') + '. Research links short sleep duration to reduced insulin sensitivity.',
        action: 'How does sleep affect my blood sugar levels?'
      };
    }
  };

  var sleepWeightGain = {
    id: 'sleep_weight_gain',
    domain: 'cross',
    severity: 'attention',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var activityTriglycerides = {
    id: 'activity_triglycerides',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.metrics.steps == null || !ctx.metrics.bloodwork) return null;
      var trig = ctx.metrics.bloodwork.triglycerides;
      if (!trig || trig <= 150) return null;
      return { steps: ctx.metrics.steps, trig: trig, lowActivity: ctx.metrics.steps < 6000 };
    },
    template: function (data) {
      var body = 'Your triglycerides are ' + data.trig + ' mg/dL (above the 150 optimal threshold) and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day.';
      if (data.lowActivity) {
        body += ' Exercise is one of the most potent triglyceride-lowering interventions \u2014 research shows regular activity reduces them by 10-20%. Increasing to 8,000+ steps could meaningfully impact this at your next blood draw.';
      } else {
        body += ' While your activity level is reasonable, research shows exercise reduces triglycerides by 10-20%. Higher-intensity sessions or longer walks may provide additional benefit.';
      }
      return {
        headline: 'Activity level and triglycerides',
        body: body,
        action: 'How can I lower my triglycerides through exercise?'
      };
    }
  };

  var vo2Hdl = {
    id: 'vo2_hdl',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      if (ctx.metrics.vo2max == null || !ctx.metrics.bloodwork) return null;
      var hdl = ctx.metrics.bloodwork.hdl;
      if (!hdl) return null;
      return { vo2: Math.round(ctx.metrics.vo2max * 10) / 10, hdl: hdl, lowHdl: hdl < 40 };
    },
    template: function (data) {
      if (data.lowHdl) {
        return {
          headline: 'Low HDL \u2014 aerobic fitness can help',
          body: 'Your HDL is ' + data.hdl + ' mg/dL (below the 40 mg/dL AHA threshold) with a VO2 max of ' + data.vo2 + '. Research links higher aerobic fitness to higher HDL levels.',
          action: 'How can I raise my HDL cholesterol?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Aerobic fitness supporting HDL levels',
        body: 'Your VO2 max of ' + data.vo2 + ' and HDL of ' + data.hdl + ' mg/dL are both in healthy ranges.',
        action: 'What else affects my HDL cholesterol?',
        _severity: 'positive'
      };
    }
  };

  var strengthCrp = {
    id: 'strength_crp',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      var crp = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.crp : null;
      var pctl = ctx.metrics.strengthData ? ctx.metrics.strengthData.avgPercentile : null;
      if (crp == null || pctl == null) return null;
      return { pctl: pctl, crp: crp };
    },
    template: function (data) {
      var body;
      if (data.crp > 1 && data.pctl < 50) {
        body = 'Your CRP is ' + data.crp + ' mg/L (elevated) and your strength is at the ' + data.pctl + 'th percentile. Research shows people in the top third of strength have 32% lower CRP \u2014 muscle secretes anti-inflammatory molecules (myokines) when it contracts. Consistent training may help bring inflammation down.';
      } else if (data.crp <= 1 && data.pctl >= 50) {
        body = 'Your CRP of ' + data.crp + ' mg/L (low inflammation) and ' + data.pctl + 'th percentile strength are aligned. Muscle acts as an anti-inflammatory organ \u2014 research shows stronger individuals have 32% lower CRP.';
      } else {
        body = 'Your CRP is ' + data.crp + ' mg/L and strength is at the ' + data.pctl + 'th percentile. Research links higher muscular strength to 32% lower chronic inflammation through anti-inflammatory myokine release during muscle contraction.';
      }
      return {
        headline: 'Strength and inflammation',
        body: body,
        action: 'How does strength training affect inflammation?',
        _severity: data.crp <= 1 ? 'positive' : 'attention'
      };
    }
  };

  var weightRhr = {
    id: 'weight_rhr',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.metrics.hr == null) return null;
      var profile = ctx.profile;
      if (!profile || !profile.current_weight_kg || !profile.height_cm) return null;
      var bmi = profile.current_weight_kg / Math.pow(profile.height_cm / 100, 2);
      if (bmi < 25 || ctx.metrics.hr <= 72) return null;
      return { bmi: Math.round(bmi * 10) / 10, rhr: ctx.metrics.hr };
    },
    template: function (data) {
      return {
        headline: 'Elevated BMI contributing to higher heart rate',
        body: 'Your BMI of ' + data.bmi + ' and resting HR of ' + data.rhr + ' bpm are both above the typical healthy range.',
        action: 'How does my weight affect my heart health?'
      };
    }
  };

  var proteinSleepQuality = {
    id: 'protein_sleep_quality',
    domain: 'cross',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.meals.length === 0) return null;
      var deepPct = (ctx.metrics.sleepData && ctx.metrics.sleepData.stages && ctx.metrics.sleepData.stages.deep) ? ctx.metrics.sleepData.stages.deep.pct : null;
      if (deepPct == null) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      if (!weightKg) return null;
      var totalProt = 0;
      var daysSeen = {};
      for (var i = 0; i < ctx.meals.length; i++) {
        var mac = getMacrosFromMeal(ctx.meals[i]);
        if (mac.prot > 0) {
          totalProt += mac.prot;
          daysSeen[localDateStr(new Date(ctx.meals[i].meal_time || ctx.meals[i].created_at || ''))] = true;
        }
      }
      var mealDays = Object.keys(daysSeen).length;
      if (mealDays < 3) return null;
      var dailyAvg = totalProt / mealDays;
      var perKg = Math.round((dailyAvg / weightKg) * 10) / 10;
      if (perKg >= 1.2 && deepPct >= 15) return { perKg: perKg, deepPct: deepPct, good: true };
      if (perKg < 1.0 && deepPct < 15) return { perKg: perKg, deepPct: deepPct, good: false };
      return null;
    },
    template: function (data) {
      if (data.good) {
        return {
          headline: 'Protein intake supporting sleep quality',
          body: 'Your ' + data.perKg + ' g/kg daily protein and ' + data.deepPct + '% deep sleep are both in typical healthy ranges.',
          action: 'How does protein affect my sleep quality?',
          _severity: 'positive'
        };
      }
      return {
        headline: 'Low protein may be affecting deep sleep',
        body: 'Your protein intake of ' + data.perKg + ' g/kg and ' + data.deepPct + '% deep sleep (target: 15-20%) are both below typical ranges.',
        action: 'Can increasing protein improve my sleep?',
        _severity: 'attention'
      };
    }
  };

  var activityGlucose = {
    id: 'activity_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.metrics.steps == null || !ctx.metrics.bloodwork) return null;
      var glucose = ctx.metrics.bloodwork.glucose;
      if (!glucose || glucose <= 100) return null;
      return { steps: ctx.metrics.steps, glucose: glucose, lowActivity: ctx.metrics.steps < 6000 };
    },
    template: function (data) {
      var body = 'Your fasting glucose is ' + data.glucose + ' mg/dL (above optimal) and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day.';
      if (data.lowActivity) {
        body += ' Research shows each additional 2,000 steps/day lowers fasting glucose by about 1.5 mg/dL. Even a 10-15 minute walk after meals reduces glucose spikes by 20-30%.';
      } else {
        body += ' While your activity level is decent, post-meal walking (even 10-15 minutes) can reduce glucose spikes by 20-30% \u2014 one of the most underrated glucose management tools.';
      }
      return {
        headline: 'Activity and blood sugar',
        body: body,
        action: 'How does walking after meals affect my blood sugar?'
      };
    }
  };

  var overtrainingSignal = {
    id: 'overtraining_signal',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var hrUp = false;
      if (ctx.metrics.hr != null) {
        if (ctx.metrics.hrWeeklyAvg != null) {
          hrUp = ctx.metrics.hr >= ctx.metrics.hrWeeklyAvg + 8;
        } else {
          hrUp = ctx.metrics.hr > 80;
        }
      }
      var highActivity = ctx.metrics.steps != null && ctx.metrics.steps > 15000;
      var poorSleep = ctx.metrics.sleepData && ctx.metrics.sleepData.avg != null && ctx.metrics.sleepData.avg < 6;
      var signals = (hrUp ? 1 : 0) + (highActivity ? 1 : 0) + (poorSleep ? 1 : 0);
      if (signals < 2) return null;
      return { hrUp: hrUp, highActivity: highActivity, poorSleep: poorSleep };
    },
    template: function (data) {
      var reasons = [];
      if (data.hrUp) reasons.push('resting HR is elevated above your baseline');
      if (data.poorSleep) reasons.push('sleep is under 6 hours');
      if (data.highActivity) reasons.push('activity load is high');
      return {
        headline: 'Recovery may need attention',
        body: 'Multiple recovery-related metrics are outside your typical baseline: ' + reasons.join(', ') + '.',
        action: 'What are the signs I need more recovery time?'
      };
    }
  };

  var sleepStrengthPerformance = {
    id: 'sleep_strength_performance',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      var avgSleep = (ctx.metrics.sleepData && ctx.metrics.sleepData.avg != null) ? ctx.metrics.sleepData.avg : ((ctx.metrics.sleepData && ctx.metrics.sleepData.latest != null) ? ctx.metrics.sleepData.latest : null);
      if (avgSleep == null || avgSleep >= 6.5) return null;
      var tests = ctx.metrics.strengthData ? ctx.metrics.strengthData.tests : null;
      if (!tests || tests.length < 2) return null;
      var byKey = {};
      for (var i = 0; i < tests.length; i++) {
        var t = tests[i];
        if (!byKey[t.test_key]) byKey[t.test_key] = [];
        byKey[t.test_key].push(t);
      }
      var bkKeys = Object.keys(byKey);
      for (var k = 0; k < bkKeys.length; k++) {
        byKey[bkKeys[k]].sort(function (a, b) {
          return new Date(a.tested_at).getTime() - new Date(b.tested_at).getTime();
        });
      }
      var stalling = false;
      var liftKeys = ['bench_1rm', 'squat_1rm', 'deadlift_1rm'];
      for (var lk = 0; lk < liftKeys.length; lk++) {
        var h = byKey[liftKeys[lk]];
        if (h && h.length >= 2 && h[h.length - 1].raw_value <= h[h.length - 2].raw_value) {
          stalling = true;
          break;
        }
      }
      if (!stalling) return null;
      return { sleep: Math.round(avgSleep * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Sleep may be limiting your strength gains',
        body: 'You\'re averaging ' + data.sleep + 'h of sleep (below AASM-recommended 7+ hours) and your lifts have stalled.',
        action: 'How does sleep affect my strength and muscle growth?'
      };
    }
  };

  var weightHba1c = {
    id: 'weight_hba1c',
    domain: 'cross',
    severity: 'attention',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var recoveryCompound = {
    id: 'recovery_compound',
    domain: 'cross',
    severity: 'positive',
    detect: function (ctx) {
      var sleepOk = (ctx.metrics.sleepData && ctx.metrics.sleepData.efficiency != null) ? ctx.metrics.sleepData.efficiency >= 85 : false;
      var hrOk = ctx.metrics.hr != null && ctx.metrics.hr <= 65;
      var protOk = false;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      if (weightKg && ctx.meals.length > 0) {
        var todayStr = localDateStr(new Date());
        var todayProt = 0;
        for (var i = 0; i < ctx.meals.length; i++) {
          if (localDateStr(new Date(ctx.meals[i].meal_time || ctx.meals[i].created_at || '')) === todayStr) {
            todayProt += getMacrosFromMeal(ctx.meals[i]).prot;
          }
        }
        var target = weightKg * 1.6;
        if (todayProt >= target * 0.8) protOk = true;
      }
      var pillars = (sleepOk ? 1 : 0) + (hrOk ? 1 : 0) + (protOk ? 1 : 0);
      if (pillars < 2) return null;
      return { sleepOk: sleepOk, hrOk: hrOk, protOk: protOk, allGood: pillars === 3 };
    },
    template: function (data) {
      if (data.allGood) {
        return {
          headline: 'All three recovery pillars in check',
          body: 'Your sleep efficiency, resting heart rate, and protein intake are all in typical healthy ranges today.',
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
        body: 'Your ' + weak.join(' and ') + ' is outside the typical healthy range today.',
        action: 'What factors affect recovery?',
        _severity: 'neutral'
      };
    }
  };

  var magnesiumSleep = {
    id: 'magnesium_sleep',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.sleepData) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyMg = dailyMicro(recent, 'Magnesium');
      var rda = 400;
      if (dailyMg >= rda * 0.7) return null;
      var isSleepGoal = goalIncludes(ctx, 'sleep');
      if (!isSleepGoal) {
        var sleepIssue = ((ctx.metrics.sleepData.efficiency != null ? ctx.metrics.sleepData.efficiency : 100) < 85) || (ctx.metrics.sleepData.avg != null && ctx.metrics.sleepData.avg < 6.5);
        if (!sleepIssue) return null;
      }
      return { dailyMg: Math.round(dailyMg), rda: rda, pctRda: Math.round((dailyMg / rda) * 100) };
    },
    template: function (data) {
      return {
        headline: 'Low magnesium may be affecting sleep',
        body: 'You\'re averaging ' + data.dailyMg + 'mg magnesium/day (' + data.pctRda + '% of RDA) and your sleep quality is below target. Magnesium regulates GABA receptors and melatonin production \u2014 a 2012 study in the Journal of Research in Medical Sciences found supplementing 500mg improved sleep quality, onset latency, and duration in elderly adults.',
        action: 'Should I take magnesium for sleep?'
      };
    }
  };

  var fiberCholesterol = {
    id: 'fiber_cholesterol',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.bloodwork) return null;
      var ldl = ctx.metrics.bloodwork.ldl;
      if (!ldl || ldl <= 100) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyFiber = dailyMicro(recent, 'Fiber');
      if (dailyFiber >= 25) return null;
      return { fiber: Math.round(dailyFiber), ldl: ldl };
    },
    template: function (data) {
      return {
        headline: 'Low fiber linked to elevated LDL',
        body: 'You\'re averaging ' + data.fiber + 'g fiber/day (target: 25-30g) with LDL at ' + data.ldl + ' mg/dL. Soluble fiber binds bile acids and directly lowers LDL \u2014 a meta-analysis in the American Journal of Clinical Nutrition found each 5-10g increase reduces LDL by 5-10 mg/dL.',
        action: 'What foods should I eat to lower my LDL cholesterol?'
      };
    }
  };

  var omega3Triglycerides = {
    id: 'omega3_triglycerides',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.bloodwork) return null;
      var trig = ctx.metrics.bloodwork.triglycerides;
      if (!trig || trig <= 150) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyOmega = dailyMicro(recent, 'Omega-3');
      if (dailyOmega >= 1.5) return null;
      return { omega3: Math.round(dailyOmega * 10) / 10, trig: trig };
    },
    template: function (data) {
      return {
        headline: 'Low omega-3 with elevated triglycerides',
        body: 'Your triglycerides are ' + data.trig + ' mg/dL (above the 150 optimal threshold) and you\'re averaging only ' + data.omega3 + 'g omega-3/day. Research links EPA and DHA intake to reductions in triglyceride levels.',
        action: 'How do omega-3s affect my triglycerides?'
      };
    }
  };

  var omega3Inflammation = {
    id: 'omega3_inflammation',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.bloodwork) return null;
      var crp = ctx.metrics.bloodwork.crp;
      if (!crp || crp <= 1) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyOmega = dailyMicro(recent, 'Omega-3');
      if (dailyOmega >= 1.5) return null;
      return { omega3: Math.round(dailyOmega * 10) / 10, crp: crp };
    },
    template: function (data) {
      return {
        headline: 'Low omega-3 with elevated inflammation',
        body: 'Your CRP is ' + data.crp + ' mg/L (elevated) and omega-3 intake is ' + data.omega3 + 'g/day. Omega-3 fatty acids are among the most potent dietary anti-inflammatories \u2014 a 2017 meta-analysis showed they reduce CRP by 0.2-0.5 mg/L. Fatty fish, walnuts, and flaxseed are the best food sources.',
        action: 'What anti-inflammatory foods should I eat?'
      };
    }
  };

  var saturatedFatLdl = {
    id: 'saturated_fat_ldl',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.bloodwork) return null;
      var ldl = ctx.metrics.bloodwork.ldl;
      if (!ldl || ldl <= 100) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailySatFat = dailyMicro(recent, 'Saturated Fat');
      if (dailySatFat <= 15) return null;
      return { satFat: Math.round(dailySatFat), ldl: ldl };
    },
    template: function (data) {
      return {
        headline: 'High saturated fat linked to elevated LDL',
        body: 'You\'re averaging ' + data.satFat + 'g saturated fat/day (target: under 15-20g) with LDL at ' + data.ldl + ' mg/dL. A Cochrane review found that replacing saturated fat with unsaturated sources (olive oil, nuts, avocado) reduces cardiovascular events by 17%.',
        action: 'How should I adjust my fat intake to lower LDL?'
      };
    }
  };

  var vitaminDStatus = {
    id: 'vitamin_d_status',
    domain: 'cross',
    severity: 'neutral',
    detect: function (ctx) {
      var bloodVitD = ctx.metrics.bloodwork ? (ctx.metrics.bloodwork.vitaminD != null ? ctx.metrics.bloodwork.vitaminD : null) : null;
      if (bloodVitD == null || bloodVitD >= 30) return null;
      var goal = (ctx.profile && ctx.profile.primary_goal) ? ctx.profile.primary_goal.toLowerCase() : '';
      var hasStrength = ctx.metrics.strengthData != null;
      var dailyD = null;
      var pctRda = null;
      var recent = ctx.meals.length > 0 ? recentMealsOrNull(ctx) : null;
      if (recent) {
        dailyD = Math.round(dailyMicro(recent, 'Vitamin D') * 10) / 10;
        pctRda = Math.round(((dailyD || 0) / 20) * 100);
      }
      return { bloodVitD: bloodVitD, dailyD: dailyD, pctRda: pctRda, goal: goal, hasStrength: hasStrength };
    },
    template: function (data) {
      var body = 'Your bloodwork shows vitamin D at ' + data.bloodVitD + ' ng/mL, which is below the sufficient threshold of 30 ng/mL. Vitamin D is important for bone density, immune function, and muscle strength.';
      if (data.dailyD != null && data.pctRda != null) {
        body += ' Your dietary intake is also low at ' + data.dailyD + ' mcg/day (' + data.pctRda + '% of RDA), though sunlight is the primary source for most people.';
      }
      if (data.goal.indexOf('strength') !== -1) {
        body += ' Low vitamin D is associated with reduced testosterone and impaired muscle protein synthesis.';
      }
      body += ' Discuss supplementation (1000-2000 IU/day) with your healthcare provider.';
      return {
        headline: 'Vitamin D is low based on bloodwork',
        body: body,
        action: 'Should I supplement vitamin D?',
        _severity: 'attention'
      };
    }
  };

  var ironEnergy = {
    id: 'iron_energy',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyIron = dailyMicro(recent, 'Iron');
      var sex = (ctx.profile && ctx.profile.sex) ? ctx.profile.sex : 'male';
      var rda = sex === 'female' ? 18 : 8;
      if (dailyIron >= rda * 0.6) return null;
      var lowAerobic = ctx.metrics.vo2max != null && ctx.metrics.vo2max < 35;
      return { dailyIron: Math.round(dailyIron * 10) / 10, rda: rda, pctRda: Math.round((dailyIron / rda) * 100), lowAerobic: lowAerobic };
    },
    template: function (data) {
      var body = 'You\'re averaging ' + data.dailyIron + 'mg iron/day (' + data.pctRda + '% of your ' + data.rda + 'mg RDA). Iron carries oxygen to muscles \u2014 deficiency is the most common nutritional deficiency worldwide and directly impairs exercise capacity.';
      if (data.lowAerobic) {
        body += ' Your VO2 max is also below average \u2014 iron supplementation or iron-rich foods (red meat, spinach, lentils) could help both.';
      }
      return {
        headline: 'Iron intake below target',
        body: body,
        action: 'How does iron affect my energy and exercise performance?'
      };
    }
  };

  var zincRecovery = {
    id: 'zinc_recovery',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'strength')) return null;
      if (ctx.meals.length === 0) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyZinc = dailyMicro(recent, 'Zinc');
      if (dailyZinc >= 8) return null;
      return { dailyZinc: Math.round(dailyZinc * 10) / 10, pctRda: Math.round((dailyZinc / 11) * 100) };
    },
    template: function (data) {
      return {
        headline: 'Low zinc may limit strength recovery',
        body: 'You\'re averaging ' + data.dailyZinc + 'mg zinc/day (' + data.pctRda + '% of RDA). Zinc is essential for testosterone production and muscle protein synthesis \u2014 a 1996 Wayne State study found zinc deficiency reduced testosterone by 75% in young men. Red meat, oysters, pumpkin seeds, and legumes are rich sources.',
        action: 'How does zinc affect testosterone and recovery?'
      };
    }
  };

  var lateEatingSleep = {
    id: 'late_eating_sleep',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.sleepData) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length === 0) return null;
      var lateDays = {};
      for (var i = 0; i < recent.length; i++) {
        var mealTime = new Date(recent[i].meal_time || recent[i].created_at || '');
        var mealHour = mealTime.getHours();
        if (mealHour >= 21) {
          lateDays[localDateStr(mealTime)] = true;
        }
      }
      var lateDayCount = Object.keys(lateDays).length;
      var threshold = goalIncludes(ctx, 'sleep') ? 2 : 3;
      if (lateDayCount < threshold) return null;
      return { count: lateDayCount, efficiency: ctx.metrics.sleepData.efficiency };
    },
    template: function (data) {
      var body = 'You ate after 9 PM on ' + data.count + ' occasions this week.';
      if (data.efficiency != null && data.efficiency < 85) {
        body += ' Your sleep efficiency of ' + data.efficiency + '% is below the 85% target.';
      }
      body += ' A British Journal of Nutrition study found late meals reduce sleep efficiency by 4-8% and deep sleep by 10-15 minutes due to elevated core body temperature. Try finishing your last meal 3+ hours before bed.';
      return {
        headline: 'Late eating affecting sleep quality',
        body: body,
        action: 'How does meal timing affect my sleep?'
      };
    }
  };

  var highCarbGlucose = {
    id: 'high_carb_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (ctx.meals.length === 0 || !ctx.metrics.bloodwork) return null;
      var glucose = ctx.metrics.bloodwork.glucose != null ? ctx.metrics.bloodwork.glucose : null;
      var hba1c = ctx.metrics.bloodwork.hba1c != null ? ctx.metrics.bloodwork.hba1c : null;
      if ((glucose == null || glucose <= 100) && (hba1c == null || hba1c <= 5.6)) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var totalCarbs = 0;
      for (var i = 0; i < recent.length; i++) {
        totalCarbs += getMacrosFromMeal(recent[i]).carb;
      }
      var days = countMealDays(recent);
      var dailyCarbs = totalCarbs / days;
      if (dailyCarbs < 250) return null;
      return { carbs: Math.round(dailyCarbs), glucose: glucose, hba1c: hba1c };
    },
    template: function (data) {
      var markers = [];
      if (data.glucose != null) markers.push('fasting glucose of ' + data.glucose + ' mg/dL');
      if (data.hba1c != null) markers.push('HbA1c of ' + data.hba1c + '%');
      return {
        headline: 'High carb intake with elevated blood sugar',
        body: 'You\'re averaging ' + data.carbs + 'g carbs/day with ' + markers.join(' and ') + '. A BMJ meta-analysis showed reducing refined carbs by 20-30% can lower HbA1c by 0.3-0.5%. Focus on swapping refined carbs for complex sources \u2014 whole grains, vegetables, legumes.',
        action: 'Which carbs should I eat and which should I avoid?'
      };
    }
  };

  var calorieWeightDiscrepancy = {
    id: 'calorie_weight_discrepancy',
    domain: 'cross',
    severity: 'neutral',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var energyPredictedVsActualWeight = {
    id: 'energy_predicted_vs_actual_weight',
    domain: 'cross',
    severity: 'attention',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var strengthInDeficitWarning = {
    id: 'strength_in_deficit_warning',
    domain: 'cross',
    severity: 'attention',
    detect: function () { return null; },
    template: function () { return { headline: '', body: '', action: '' }; }
  };

  var sleepCaffeineProxy = {
    id: 'sleep_caffeine_proxy',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'sleep')) return null;
      if (!ctx.metrics.sleepData) return null;
      if ((ctx.metrics.sleepData.efficiency != null ? ctx.metrics.sleepData.efficiency : 100) >= 85) return null;
      if (ctx.meals.length === 0) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length === 0) return null;
      var caffeineDays = {};
      for (var i = 0; i < recent.length; i++) {
        var mealHour = new Date(recent[i].meal_time || recent[i].created_at || '').getHours();
        if (mealHour < 14) continue;
        var desc = (recent[i].description || recent[i].raw_input || '').toLowerCase();
        if (CAFFEINE_WORDS.test(desc)) {
          caffeineDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var cafDayCount = Object.keys(caffeineDays).length;
      if (cafDayCount === 0) return null;
      return { days: cafDayCount, efficiency: ctx.metrics.sleepData.efficiency };
    },
    template: function (data) {
      return {
        headline: 'Afternoon caffeine may be hurting sleep',
        body: 'You logged caffeine in the afternoon/evening on ' + data.days + ' day' + (data.days > 1 ? 's' : '') + ' this week. Caffeine has an approximately 6-hour half-life. Consider tracking caffeine-free nights to compare your sleep data.',
        action: 'How does caffeine timing affect my sleep?'
      };
    }
  };

  var sleepActivityConnection = {
    id: 'sleep_activity_connection',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'sleep')) return null;
      if (ctx.metrics.steps == null || !ctx.metrics.sleepData) return null;
      if (ctx.metrics.steps >= 5000) return null;
      var poorSleep = ((ctx.metrics.sleepData.efficiency != null ? ctx.metrics.sleepData.efficiency : 100) < 85) || (ctx.metrics.sleepData.avg != null && ctx.metrics.sleepData.avg < 6.5);
      if (!poorSleep) return null;
      return { steps: ctx.metrics.steps, efficiency: ctx.metrics.sleepData.efficiency || 0 };
    },
    template: function (data) {
      return {
        headline: 'Low activity may be affecting sleep',
        body: 'Averaging ' + data.steps + ' steps/day with ' + data.efficiency + '% sleep efficiency. Both are below typical healthy ranges.',
        action: 'How does exercise affect sleep quality?'
      };
    }
  };

  var sleepAlcoholProxy = {
    id: 'sleep_alcohol_proxy',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'sleep')) return null;
      if (!ctx.metrics.sleepData) return null;
      if (ctx.meals.length === 0) return null;
      var remPct = (ctx.metrics.sleepData.stages && ctx.metrics.sleepData.stages.rem) ? ctx.metrics.sleepData.stages.rem.pct : null;
      var eff = ctx.metrics.sleepData.efficiency != null ? ctx.metrics.sleepData.efficiency : null;
      var poorSleep = (remPct != null && remPct < 18) || (eff != null && eff < 85);
      if (!poorSleep) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length === 0) return null;
      var alcoholDays = {};
      for (var i = 0; i < recent.length; i++) {
        var desc = (recent[i].description || recent[i].raw_input || '').toLowerCase();
        if (ALCOHOL_WORDS.test(desc)) {
          alcoholDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var alcDayCount = Object.keys(alcoholDays).length;
      if (alcDayCount === 0) return null;
      return { days: alcDayCount, remPct: remPct, efficiency: eff };
    },
    template: function (data) {
      var details = '';
      if (data.remPct != null) details += ' Your REM of ' + data.remPct + '%';
      if (data.efficiency != null) {
        details += (details ? ' and' : ' Your') + ' efficiency of ' + data.efficiency + '%';
      }
      details += ' may be directly impacted.';
      return {
        headline: 'Alcohol may be fragmenting sleep',
        body: 'You logged alcohol on ' + data.days + ' day' + (data.days > 1 ? 's' : '') + ' this week. Research links alcohol consumption to fragmented sleep architecture.' + details + ' Consider tracking alcohol-free nights vs nights with drinks to see the difference in your own data.',
        action: 'How does alcohol affect my sleep stages?'
      };
    }
  };

  var cardioStrengthBalance = {
    id: 'cardio_strength_balance',
    domain: 'cross',
    severity: 'neutral',
    detect: function (ctx) {
      if (ctx.metrics.vo2max == null || !ctx.metrics.strengthData) return null;
      var vo2ScoreEntry = null;
      if (ctx.result && ctx.result.scores) {
        for (var i = 0; i < ctx.result.scores.length; i++) {
          if (ctx.result.scores[i].name === 'vo2max' || ctx.result.scores[i].name === 'vo2') {
            vo2ScoreEntry = ctx.result.scores[i];
            break;
          }
        }
      }
      var vo2Score = vo2ScoreEntry ? vo2ScoreEntry.score : null;
      var strScore = ctx.metrics.strengthData.avgPercentile;
      if (vo2Score == null || strScore == null) return null;
      var gap = Math.abs(vo2Score - strScore);
      if (gap < 25) return null;
      return { vo2Score: vo2Score, strScore: strScore, gap: gap, cardioWeak: vo2Score < strScore };
    },
    template: function (data) {
      if (data.cardioWeak) {
        return {
          headline: 'Strong but aerobically underdeveloped',
          body: 'Your strength is at the ' + data.strScore + 'th percentile but VO2 max is only ' + data.vo2Score + 'th \u2014 a ' + data.gap + '-point gap. Research links higher VO2 max to lower all-cause mortality.',
          action: 'How can I improve cardio without losing strength?',
          _severity: 'attention'
        };
      }
      return {
        headline: 'Good cardio but strength lagging',
        body: 'Your VO2 max is at the ' + data.vo2Score + 'th percentile but strength is only ' + data.strScore + 'th \u2014 a ' + data.gap + '-point gap. Research links grip strength to cardiovascular mortality risk.',
        action: 'How can I build strength without losing cardio fitness?',
        _severity: 'attention'
      };
    }
  };

  var wellnessInflammation = {
    id: 'wellness_inflammation',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'feel')) return null;
      var crp = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.crp : null;
      if (!crp || crp <= 1.5) return null;
      var flags = [];
      if (ctx.metrics.sleepData && ctx.metrics.sleepData.avg != null && ctx.metrics.sleepData.avg < 6.5) {
        flags.push('poor sleep');
      }
      if (ctx.metrics.steps != null && ctx.metrics.steps < 5000) {
        flags.push('low activity');
      }
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      var heightCm = ctx.profile ? ctx.profile.height_cm : null;
      if (weightKg && heightCm) {
        var bmi = weightKg / Math.pow(heightCm / 100, 2);
        if (bmi > 28) flags.push('elevated BMI');
      }
      if (flags.length === 0) return null;
      return { crp: crp, flags: flags };
    },
    template: function (data) {
      return {
        headline: 'Inflammation elevated with lifestyle factors',
        body: 'Your CRP of ' + data.crp + ' mg/L is above the AHA-referenced low-risk threshold of 1 mg/L, alongside ' + data.flags.join(' and ') + '.',
        action: 'How can I reduce my CRP and inflammation?'
      };
    }
  };

  var wellnessActivityBaseline = {
    id: 'wellness_activity_baseline',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      if (!goalIncludes(ctx, 'feel')) return null;
      if (ctx.metrics.steps == null || ctx.metrics.steps >= 5000) return null;
      return { steps: ctx.metrics.steps };
    },
    template: function (data) {
      return {
        headline: 'Daily activity is low',
        body: 'Averaging ' + data.steps + ' steps/day. A 2023 JAMA meta-analysis found each additional 1,000 steps reduced all-cause mortality by 15%. Getting from ' + data.steps + ' to 7,000 is the single highest-ROI change for general wellness \u2014 it affects energy, mood, sleep, and metabolic health simultaneously.',
        action: 'How does walking affect overall health?'
      };
    }
  };

  var familyDiabetesGlucose = {
    id: 'family_diabetes_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var fh = parseFamilyHistory(ctx);
      if (!fh) return null;
      var hasDiabetes = ((fh['Type 2 Diabetes'] && fh['Type 2 Diabetes'].length > 0) || (fh['Type 1 Diabetes'] && fh['Type 1 Diabetes'].length > 0));
      if (!hasDiabetes) return null;
      var glucose = ctx.metrics.bloodwork ? (ctx.metrics.bloodwork.glucose != null ? ctx.metrics.bloodwork.glucose : null) : null;
      var hba1c = ctx.metrics.bloodwork ? (ctx.metrics.bloodwork.hba1c != null ? ctx.metrics.bloodwork.hba1c : null) : null;
      var borderline = (glucose != null && glucose > 90) || (hba1c != null && hba1c > 5.4);
      if (!borderline) return null;
      var members = (fh['Type 2 Diabetes'] || fh['Type 1 Diabetes'] || []).join(', ');
      return { members: members, glucose: glucose, hba1c: hba1c };
    },
    template: function (data) {
      var markers = [];
      if (data.glucose != null) markers.push('fasting glucose of ' + data.glucose + ' mg/dL');
      if (data.hba1c != null) markers.push('HbA1c of ' + data.hba1c + '%');
      return {
        headline: 'Family diabetes history + borderline blood sugar',
        body: 'You have family history of diabetes (' + data.members + ') and your ' + markers.join(' and ') + ' is approaching the ADA pre-diabetic threshold. Discuss your risk profile with your healthcare provider.',
        action: 'What should I do about borderline blood sugar with family history of diabetes?'
      };
    }
  };

  var familyHeartDiseaseRisk = {
    id: 'family_heart_disease_risk',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var fh = parseFamilyHistory(ctx);
      if (!fh) return null;
      var heartConditions = ['Heart disease', 'High blood pressure', 'High cholesterol', 'Stroke', 'Sudden cardiac death'];
      var matches = heartConditions.filter(function (c) { return fh[c] && fh[c].length > 0; });
      if (matches.length === 0) return null;
      var bw = ctx.metrics.bloodwork || {};
      var hr = ctx.metrics.hr;
      var concerns = [];
      if (bw.ldl && bw.ldl > 100) concerns.push('LDL ' + bw.ldl + ' mg/dL');
      if (bw.hdl && bw.hdl < 45) concerns.push('HDL ' + bw.hdl + ' mg/dL');
      if (bw.triglycerides && bw.triglycerides > 150) concerns.push('triglycerides ' + bw.triglycerides + ' mg/dL');
      if (bw.crp && bw.crp > 1) concerns.push('CRP ' + bw.crp + ' mg/L');
      if (hr != null && hr > 75) concerns.push('resting HR ' + hr + ' bpm');
      if (concerns.length === 0) return null;
      return { conditions: matches, concerns: concerns };
    },
    template: function (data) {
      return {
        headline: 'Cardiovascular risk factors with family history',
        body: 'Your family history includes ' + data.conditions.join(', ') + '. Combined with ' + data.concerns.join(', ') + ', focusing on heart-healthy habits may be especially impactful for you.',
        action: 'What lifestyle changes lower cardiovascular risk with family history?'
      };
    }
  };

  var familyCholesterolLdl = {
    id: 'family_cholesterol_ldl',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var fh = parseFamilyHistory(ctx);
      if (!fh) return null;
      if (!fh['High cholesterol'] || fh['High cholesterol'].length === 0) return null;
      var ldl = ctx.metrics.bloodwork ? (ctx.metrics.bloodwork.ldl != null ? ctx.metrics.bloodwork.ldl : null) : null;
      if (ldl == null || ldl <= 100) return null;
      return { ldl: ldl, members: fh['High cholesterol'].join(', ') };
    },
    template: function (data) {
      return {
        headline: 'Elevated LDL with family cholesterol history',
        body: 'Your LDL of ' + data.ldl + ' mg/dL is above the AHA optimal threshold of 100 mg/dL, and your family (' + data.members + ') has a history of high cholesterol. Discuss your risk profile with your healthcare provider.',
        action: 'Should I be concerned about familial high cholesterol?'
      };
    }
  };

  // --- Bloodwork x Behavior cross-domain rules ---

  var sleepCortisol = {
    id: 'sleep_cortisol',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var cortisol = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.cortisol : null;
      if (cortisol == null || cortisol <= 18) return null;
      var sleepAvg = ctx.metrics.sleepData ? ctx.metrics.sleepData.avg : null;
      if (sleepAvg == null || sleepAvg >= 6.5) return null;
      return { cortisol: cortisol, sleepAvg: Math.round(sleepAvg * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Sleep deprivation may be driving cortisol up',
        body: 'Your cortisol is ' + data.cortisol + ' ug/dL (above the commonly-cited 18 threshold) and you\'re averaging ' + data.sleepAvg + 'h of sleep (below AASM-recommended 7+ hours).',
        action: 'How does sleep affect my cortisol levels?',
        chatQuestion: 'How does sleep affect my cortisol levels?'
      };
    }
  };

  var overtrainingCortisol = {
    id: 'overtraining_cortisol',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var cortisol = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.cortisol : null;
      if (cortisol == null || cortisol <= 18) return null;
      var steps = ctx.metrics.steps;
      if (steps == null || steps < 15000) return null;
      var hr = ctx.metrics.hr;
      if (hr == null || hr < 65) return null;
      return { cortisol: cortisol, steps: steps, hr: hr };
    },
    template: function (data) {
      return {
        headline: 'High training load may be elevating cortisol',
        body: 'Your cortisol is ' + data.cortisol + ' ug/dL with ' + data.steps.toLocaleString() + ' daily steps and a resting HR of ' + data.hr + ' bpm.',
        action: 'Am I overtraining?',
        chatQuestion: 'Am I overtraining? How does exercise affect cortisol?'
      };
    }
  };

  var caffeineCortisol = {
    id: 'caffeine_cortisol',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var cortisol = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.cortisol : null;
      if (cortisol == null || cortisol <= 18) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length < 5) return null;
      var caffeineDays = {};
      for (var i = 0; i < recent.length; i++) {
        var desc = (recent[i].description || recent[i].raw_input || '').toLowerCase();
        if (CAFFEINE_WORDS.test(desc)) {
          caffeineDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var cafDayCount = Object.keys(caffeineDays).length;
      if (cafDayCount < 3) return null;
      return { cortisol: cortisol, caffeineDays: cafDayCount };
    },
    template: function (data) {
      return {
        headline: 'Caffeine habit may be amplifying cortisol',
        body: 'Your cortisol is ' + data.cortisol + ' ug/dL and you consumed caffeine on ' + data.caffeineDays + ' of the last 7 days.',
        action: 'How does caffeine affect cortisol?',
        chatQuestion: 'How does caffeine affect my cortisol and stress levels?'
      };
    }
  };

  var sleepTestosterone = {
    id: 'sleep_testosterone',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var testosterone = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.testosterone : null;
      if (testosterone == null) return null;
      var sex = (ctx.profile && ctx.profile.sex) ? ctx.profile.sex : 'male';
      var threshold = sex === 'female' ? 15 : 300;
      if (testosterone >= threshold) return null;
      var sleepAvg = ctx.metrics.sleepData ? ctx.metrics.sleepData.avg : null;
      if (sleepAvg == null || sleepAvg >= 7) return null;
      return { testosterone: testosterone, sleepAvg: Math.round(sleepAvg * 10) / 10, sex: sex };
    },
    template: function (data) {
      return {
        headline: 'Short sleep linked to low testosterone',
        body: 'Your testosterone is ' + data.testosterone + ' ng/dL (below the reference threshold) and you\'re averaging ' + data.sleepAvg + 'h of sleep (below AASM-recommended 7+ hours).',
        action: 'How does sleep affect testosterone?',
        chatQuestion: 'How does sleep affect my testosterone levels?'
      };
    }
  };

  var bodyfatTestosterone = {
    id: 'bodyfat_testosterone',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var testosterone = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.testosterone : null;
      if (testosterone == null) return null;
      var sex = (ctx.profile && ctx.profile.sex) ? ctx.profile.sex : 'male';
      var threshold = sex === 'female' ? 15 : 300;
      if (testosterone >= threshold) return null;
      var weightKg = ctx.profile ? ctx.profile.current_weight_kg : null;
      var heightCm = ctx.profile ? ctx.profile.height_cm : null;
      if (!weightKg || !heightCm) return null;
      var bmi = weightKg / Math.pow(heightCm / 100, 2);
      if (bmi < 28) return null;
      return { testosterone: testosterone, bmi: Math.round(bmi * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Elevated BMI may be suppressing testosterone',
        body: 'Your testosterone is ' + data.testosterone + ' ng/dL (below the reference threshold) with a BMI of ' + data.bmi + '.',
        action: 'How does body weight affect testosterone?',
        chatQuestion: 'How does body weight affect my testosterone?'
      };
    }
  };

  var zincTestosterone = {
    id: 'zinc_testosterone',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var testosterone = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.testosterone : null;
      if (testosterone == null) return null;
      var sex = (ctx.profile && ctx.profile.sex) ? ctx.profile.sex : 'male';
      var threshold = sex === 'female' ? 15 : 300;
      if (testosterone >= threshold) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var dailyZinc = dailyMicro(recent, 'Zinc');
      if (dailyZinc >= 8) return null;
      return { testosterone: testosterone, dailyZinc: Math.round(dailyZinc * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Low zinc intake may be limiting testosterone',
        body: 'Your testosterone is ' + data.testosterone + ' ng/dL (below the reference threshold) and your zinc intake averages ' + data.dailyZinc + 'mg/day (below the 8mg RDA minimum). Research links zinc deficiency to reduced testosterone.',
        action: 'How does zinc affect testosterone?',
        chatQuestion: 'How does zinc affect my testosterone levels?'
      };
    }
  };

  var exerciseTestosterone = {
    id: 'exercise_testosterone',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var testosterone = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.testosterone : null;
      if (testosterone == null) return null;
      var sex = (ctx.profile && ctx.profile.sex) ? ctx.profile.sex : 'male';
      var threshold = sex === 'female' ? 15 : 300;
      if (testosterone >= threshold) return null;
      var steps = ctx.metrics.steps;
      if (steps == null || steps >= 5000) return null;
      return { testosterone: testosterone, steps: steps };
    },
    template: function (data) {
      return {
        headline: 'Low activity linked to low testosterone',
        body: 'Your testosterone is ' + data.testosterone + ' ng/dL (below the reference threshold) and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day.',
        action: 'How does exercise affect testosterone?',
        chatQuestion: 'What type of exercise best supports testosterone?'
      };
    }
  };

  var exerciseFerritin = {
    id: 'exercise_ferritin',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var ferritin = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.ferritin : null;
      if (ferritin == null || ferritin >= 30) return null;
      var steps = ctx.metrics.steps;
      if (steps == null || steps < 10000) return null;
      return { ferritin: ferritin, steps: steps };
    },
    template: function (data) {
      return {
        headline: 'High activity alongside low ferritin',
        body: 'Your ferritin is ' + data.ferritin + ' ng/mL (below typical ranges) and you\'re averaging ' + data.steps.toLocaleString() + ' steps/day. Per NIH, endurance exercise is associated with higher iron requirements.',
        action: 'How does exercise affect iron?',
        chatQuestion: 'How does exercise affect my iron levels?'
      };
    }
  };

  var sleepIron = {
    id: 'sleep_iron',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var ferritin = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.ferritin : null;
      if (ferritin == null || ferritin >= 30) return null;
      var sleepAvg = ctx.metrics.sleepData ? ctx.metrics.sleepData.avg : null;
      if (sleepAvg == null || sleepAvg >= 7) return null;
      return { ferritin: ferritin, sleepAvg: Math.round(sleepAvg * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Low ferritin alongside short sleep',
        body: 'Your ferritin is ' + data.ferritin + ' ng/mL (below typical ranges) and you\'re averaging ' + data.sleepAvg + 'h of sleep.',
        action: 'How does iron affect sleep?',
        chatQuestion: 'How does iron deficiency affect sleep quality?'
      };
    }
  };

  var sleepVitaminD = {
    id: 'sleep_vitamin_d_bw',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var vitaminD = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.vitaminD : null;
      if (vitaminD == null || vitaminD >= 30) return null;
      var sleepAvg = ctx.metrics.sleepData ? ctx.metrics.sleepData.avg : null;
      if (sleepAvg == null || sleepAvg >= 7) return null;
      return { vitaminD: vitaminD, sleepAvg: Math.round(sleepAvg * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Low vitamin D alongside short sleep',
        body: 'Your vitamin D is ' + data.vitaminD + ' ng/mL (below the commonly-cited 30 sufficient threshold) and you\'re averaging ' + data.sleepAvg + 'h of sleep.',
        action: 'How does vitamin D affect sleep?',
        chatQuestion: 'How does vitamin D affect my sleep?'
      };
    }
  };

  var strengthVitaminD = {
    id: 'strength_vitamin_d_bw',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var vitaminD = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.vitaminD : null;
      if (vitaminD == null || vitaminD >= 30) return null;
      if (!ctx.metrics.strengthData || ctx.metrics.strengthData.avgPercentile == null) return null;
      if (ctx.metrics.strengthData.avgPercentile >= 40) return null;
      return { vitaminD: vitaminD, strengthPct: ctx.metrics.strengthData.avgPercentile };
    },
    template: function (data) {
      return {
        headline: 'Low vitamin D alongside lower strength',
        body: 'Your vitamin D is ' + data.vitaminD + ' ng/mL (below the commonly-cited 30 sufficient threshold) and your strength is at the ' + data.strengthPct + 'th percentile.',
        action: 'How does vitamin D affect strength?',
        chatQuestion: 'How does vitamin D affect muscle strength?'
      };
    }
  };

  var proteinCreatinine = {
    id: 'protein_creatinine',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var creatinine = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.creatinine : null;
      if (creatinine == null || creatinine <= 1.2) return null;
      var recent = recentMealsOrNull(ctx);
      if (!recent) return null;
      var days = countMealDays(recent);
      var totalProtein = 0;
      for (var i = 0; i < recent.length; i++) {
        totalProtein += getMacrosFromMeal(recent[i]).prot;
      }
      var dailyProtein = totalProtein / days;
      if (dailyProtein < 120) return null;
      return { creatinine: creatinine, dailyProtein: Math.round(dailyProtein) };
    },
    template: function (data) {
      return {
        headline: 'High protein intake alongside elevated creatinine',
        body: 'Your creatinine is ' + data.creatinine + ' mg/dL and you\'re consuming ~' + data.dailyProtein + 'g protein/day. Protein metabolism is one factor that can affect creatinine.',
        action: 'Discuss persistently elevated creatinine with your doctor.',
        chatQuestion: 'Is my high protein diet affecting my kidney function?'
      };
    }
  };

  var exerciseCreatinine = {
    id: 'exercise_creatinine',
    domain: 'cross',
    severity: 'neutral',
    detect: function (ctx) {
      var creatinine = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.creatinine : null;
      if (creatinine == null || creatinine <= 1.2) return null;
      var steps = ctx.metrics.steps;
      if (steps == null || steps < 12000) return null;
      return { creatinine: creatinine, steps: steps };
    },
    template: function (data) {
      return {
        headline: 'High activity alongside elevated creatinine',
        body: 'Your creatinine is ' + data.creatinine + ' mg/dL with ' + data.steps.toLocaleString() + ' daily steps. Intense exercise is one factor that can temporarily raise creatinine.',
        action: 'Does exercise affect creatinine?',
        chatQuestion: 'Does exercise affect my creatinine levels?'
      };
    }
  };

  var sleepDebtGlucose = {
    id: 'sleep_debt_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var glucose = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.glucose : null;
      if (glucose == null || glucose <= 100) return null;
      var debt = ctx.metrics.sleepData ? (ctx.metrics.sleepData.debt || 0) : 0;
      if (debt < 5) return null;
      return { glucose: glucose, debt: Math.round(debt * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Sleep debt alongside elevated blood sugar',
        body: 'Your glucose is ' + data.glucose + ' mg/dL (above ADA optimal) and you\'ve accumulated ' + data.debt + ' hours of sleep debt against the AASM-recommended 7+ hours.',
        action: 'How does sleep debt affect blood sugar?',
        chatQuestion: 'How does sleep debt affect my blood sugar?'
      };
    }
  };

  var alcoholGlucose = {
    id: 'alcohol_glucose',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var glucose = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.glucose : null;
      if (glucose == null || glucose <= 100) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length < 5) return null;
      var alcoholDays = {};
      for (var i = 0; i < recent.length; i++) {
        var desc = (recent[i].description || recent[i].raw_input || '').toLowerCase();
        if (ALCOHOL_WORDS.test(desc)) {
          alcoholDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var alcDayCount = Object.keys(alcoholDays).length;
      if (alcDayCount < 2) return null;
      return { glucose: glucose, alcoholDays: alcDayCount };
    },
    template: function (data) {
      return {
        headline: 'Alcohol intake alongside elevated blood sugar',
        body: 'Your glucose is ' + data.glucose + ' mg/dL (above ADA optimal) and you consumed alcohol on ' + data.alcoholDays + ' of the past 7 days.',
        action: 'How does alcohol affect blood sugar?',
        chatQuestion: 'How does alcohol affect my blood sugar?'
      };
    }
  };

  var sleepDebtInflammation = {
    id: 'sleep_debt_inflammation',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var crp = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.crp : null;
      if (crp == null || crp <= 1.5) return null;
      var debt = ctx.metrics.sleepData ? (ctx.metrics.sleepData.debt || 0) : 0;
      if (debt < 5) return null;
      return { crp: crp, debt: Math.round(debt * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Sleep debt alongside elevated inflammation',
        body: 'Your CRP is ' + data.crp + ' mg/L (above AHA low-risk threshold) and you\'ve accumulated ' + data.debt + ' hours of sleep debt against AASM-recommended 7+ hours.',
        action: 'How does sleep affect inflammation?',
        chatQuestion: 'How does sleep debt affect inflammation?'
      };
    }
  };

  var alcoholInflammation = {
    id: 'alcohol_inflammation',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var crp = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.crp : null;
      if (crp == null || crp <= 1.5) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length < 5) return null;
      var alcoholDays = {};
      for (var i = 0; i < recent.length; i++) {
        var desc = (recent[i].description || recent[i].raw_input || '').toLowerCase();
        if (ALCOHOL_WORDS.test(desc)) {
          alcoholDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var alcDayCount = Object.keys(alcoholDays).length;
      if (alcDayCount < 3) return null;
      return { crp: crp, alcoholDays: alcDayCount };
    },
    template: function (data) {
      return {
        headline: 'Frequent alcohol intake alongside elevated inflammation',
        body: 'Your CRP is ' + data.crp + ' mg/L (above AHA low-risk threshold) and you consumed alcohol on ' + data.alcoholDays + ' of the past 7 days.',
        action: 'How does alcohol affect inflammation?',
        chatQuestion: 'How does alcohol affect my inflammation levels?'
      };
    }
  };

  var sleepLdl = {
    id: 'sleep_ldl',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var ldl = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.ldl : null;
      if (ldl == null || ldl <= 130) return null;
      var sleepAvg = ctx.metrics.sleepData ? ctx.metrics.sleepData.avg : null;
      if (sleepAvg == null || sleepAvg >= 6.5) return null;
      return { ldl: ldl, sleepAvg: Math.round(sleepAvg * 10) / 10 };
    },
    template: function (data) {
      return {
        headline: 'Short sleep alongside elevated LDL',
        body: 'Your LDL is ' + data.ldl + ' mg/dL (above AHA optimal threshold) and you\'re averaging ' + data.sleepAvg + 'h of sleep (below AASM-recommended 7+ hours).',
        action: 'How does sleep affect cholesterol?',
        chatQuestion: 'How does sleep affect my cholesterol levels?'
      };
    }
  };

  var alcoholTriglycerides = {
    id: 'alcohol_triglycerides',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var trigs = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.triglycerides : null;
      if (trigs == null || trigs <= 150) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length < 5) return null;
      var alcoholDays = {};
      for (var i = 0; i < recent.length; i++) {
        var desc = (recent[i].description || recent[i].raw_input || '').toLowerCase();
        if (ALCOHOL_WORDS.test(desc)) {
          alcoholDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var alcDayCount = Object.keys(alcoholDays).length;
      if (alcDayCount < 2) return null;
      return { trigs: trigs, alcoholDays: alcDayCount };
    },
    template: function (data) {
      return {
        headline: 'Alcohol intake alongside elevated triglycerides',
        body: 'Your triglycerides are ' + data.trigs + ' mg/dL (above the 150 optimal threshold) and you consumed alcohol on ' + data.alcoholDays + ' of the past 7 days.',
        action: 'How does alcohol affect triglycerides?',
        chatQuestion: 'How does alcohol affect my triglyceride levels?'
      };
    }
  };

  var lateEatingTriglycerides = {
    id: 'late_eating_triglycerides',
    domain: 'cross',
    severity: 'attention',
    detect: function (ctx) {
      var trigs = ctx.metrics.bloodwork ? ctx.metrics.bloodwork.triglycerides : null;
      if (trigs == null || trigs <= 150) return null;
      var recent = getRecentMeals(ctx.meals, 7);
      if (recent.length < 5) return null;
      var lateDays = {};
      for (var i = 0; i < recent.length; i++) {
        var hour = new Date(recent[i].meal_time || recent[i].created_at || '').getHours();
        if (hour >= 21) {
          lateDays[localDateStr(new Date(recent[i].meal_time || recent[i].created_at || ''))] = true;
        }
      }
      var lateDayCount = Object.keys(lateDays).length;
      if (lateDayCount < 3) return null;
      return { trigs: trigs, lateMealDays: lateDayCount };
    },
    template: function (data) {
      return {
        headline: 'Late eating alongside elevated triglycerides',
        body: 'Your triglycerides are ' + data.trigs + ' mg/dL (above the 150 optimal threshold) and you ate after 9pm on ' + data.lateMealDays + ' of the past 7 days.',
        action: 'How does meal timing affect triglycerides?',
        chatQuestion: 'How does meal timing affect my triglycerides?'
      };
    }
  };

  // =========================================================================
  // ALL_INSIGHT_RULES array
  // =========================================================================

  var ALL_INSIGHT_RULES = [
    // Sleep (10)
    sleepDebtHigh,
    sleepTrend,
    achievementSleepConsistency,
    sleepEfficiencyFocus,
    sleepDeepPctLow,
    sleepDeepPctGood,
    sleepRemPctLow,
    sleepRemPctGood,
    sleepBedtimeConsistency,
    wellnessSleepFoundation,

    // Heart (7)
    hrThresholdCrossed,
    hrTrend,
    hrvTrend,
    hrvLowBaseline,
    seeDoctorRhrExtreme,
    achievementRhrElite,
    wellnessRhrElevated,

    // Nutrition (15)
    proteinDeficit,
    proteinOnTrack,
    calorieSurplus,
    proteinDistribution,
    sodiumPotassiumRatio,
    calciumBoneStrength,
    b12Deficiency,
    ironVitaminCSynergy,
    calciumIronConflict,
    energyBalanceDaily,
    energyBalanceWeekly,
    deficitTooAggressive,
    energyDeficiencyTriad,
    wellnessNutritionCompleteness,
    winMealLoggingConsistency,

    // Strength (8)
    liftPr,
    liftStall,
    domainIncomplete,
    trainingStale,
    pushPullImbalance,
    strengthBodyweightRatio,
    achievementStrengthProgress,
    achievementAllDomains,

    // Blood Pressure + VO2 (10)
    bpOptimal,
    bpElevated,
    bpHypertension,
    bpActivityConnection,
    bpSleepConnection,
    bpSodiumConnection,
    bpHrCompound,
    bpNotSet,
    vo2LowForAge,
    vo2AboveAverage,

    // Bloodwork (3)
    bloodworkFlagged,
    seeDoctorCrpWeightLoss,
    seeDoctorGlucoseSpike,

    // Achievement (3)
    achievementVaImproved,
    achievementComposite80,
    winVitalityImproving,

    // Unlock (6)
    unlockBloodwork,
    unlockMeals,
    unlockStrength,
    unlockSleep,
    unlockVo2,
    unlockFamilyHistory,

    // Weight (3)
    weightThresholdCrossed,
    weightTrend,
    achievementWeightGoalProgress,

    // Cross-Domain (57)
    vo2DeepSleep,
    sleepRhrCorrelation,
    stepsSleepEfficiency,
    gripStrengthLongevity,
    pushupCardiovascular,
    vo2RhrConsistency,
    sleepGlucose,
    sleepWeightGain,
    activityTriglycerides,
    vo2Hdl,
    strengthCrp,
    weightRhr,
    proteinSleepQuality,
    activityGlucose,
    overtrainingSignal,
    sleepStrengthPerformance,
    weightHba1c,
    recoveryCompound,
    magnesiumSleep,
    fiberCholesterol,
    omega3Triglycerides,
    omega3Inflammation,
    saturatedFatLdl,
    vitaminDStatus,
    ironEnergy,
    zincRecovery,
    lateEatingSleep,
    highCarbGlucose,
    calorieWeightDiscrepancy,
    energyPredictedVsActualWeight,
    strengthInDeficitWarning,
    sleepCaffeineProxy,
    sleepActivityConnection,
    sleepAlcoholProxy,
    cardioStrengthBalance,
    wellnessInflammation,
    wellnessActivityBaseline,
    // Bloodwork x behavior
    sleepCortisol,
    overtrainingCortisol,
    caffeineCortisol,
    sleepTestosterone,
    bodyfatTestosterone,
    zincTestosterone,
    exerciseTestosterone,
    exerciseFerritin,
    sleepIron,
    sleepVitaminD,
    strengthVitaminD,
    proteinCreatinine,
    exerciseCreatinine,
    sleepDebtGlucose,
    alcoholGlucose,
    sleepDebtInflammation,
    alcoholInflammation,
    sleepLdl,
    alcoholTriglycerides,
    lateEatingTriglycerides,
    // Family history
    familyDiabetesGlucose,
    familyHeartDiseaseRisk,
    familyCholesterolLdl
  ];

  // =========================================================================
  // Public API
  // =========================================================================

  window.HealixInsights = {
    runInsightRules: runInsightRules,
    buildWebRuleContext: buildWebRuleContext,
    ALL_INSIGHT_RULES: ALL_INSIGHT_RULES,
    // Expose internals for advanced usage
    evaluateRules: evaluateRules,
    scoreInsights: scoreInsights,
    filterByDiversity: filterByDiversity
  };

})();
