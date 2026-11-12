/**
 * Guideline ranges for judging lab results, by sex where guidelines differ.
 *
 * COPY OF the HealthBite app's source of truth:
 *   healthbite/supabase/functions/_shared/biomarkerRanges.ts  (ranges)
 *   healthbite/supabase/functions/generate-health-findings/specs/bloodwork.ts  (advice)
 * If you change a cut-off there, change it here too (and run `npm run test:unit`).
 *
 * All ranges are for adults (18+). Values must be in the unit listed.
 * When sex or age is unknown, markers that depend on them are skipped, never guessed.
 *
 * Exposed as window.HealixRanges in the browser and module.exports in Node (for tests).
 */
(function (root) {
  'use strict';

  var ADULT_MIN_AGE = 18;

  // A band covers min (inclusive) up to max (exclusive). A missing side is open.
  var MARKER_RANGES = {
    glucose: {
      key: 'glucose', label: 'Fasting glucose', unit: 'mg/dL', citation: 'ADA Standards of Care 2024',
      bands: [
        { level: 'low', label: 'Below the normal fasting range', max: 70 },
        { level: 'normal', label: 'Normal fasting range', min: 70, max: 100 },
        { level: 'borderline', label: 'Prediabetes range (if this was a fasting test)', min: 100, max: 126 },
        { level: 'high', label: 'Diabetes range (if this was a fasting test)', min: 126 }
      ],
      bandsBySex: null
    },
    hba1c: {
      key: 'hba1c', label: 'HbA1c', unit: '%', citation: 'ADA Standards of Care 2024',
      bands: [
        { level: 'normal', label: 'Normal', max: 5.7 },
        { level: 'borderline', label: 'Prediabetes range', min: 5.7, max: 6.5 },
        { level: 'high', label: 'Diabetes range', min: 6.5 }
      ],
      bandsBySex: null
    },
    ldl: {
      key: 'ldl', label: 'LDL cholesterol', unit: 'mg/dL', citation: 'AHA/ACC Cholesterol Guideline 2018',
      bands: [
        { level: 'normal', label: 'Optimal', max: 100 },
        { level: 'borderline', label: 'Above optimal', min: 100, max: 160 },
        { level: 'high', label: 'High', min: 160, max: 190 },
        { level: 'very_high', label: 'Very high', min: 190 }
      ],
      bandsBySex: null
    },
    hdl: {
      key: 'hdl', label: 'HDL cholesterol', unit: 'mg/dL', citation: 'AHA/ACC Cholesterol Guideline 2018',
      bands: null,
      bandsBySex: {
        male: [
          { level: 'low', label: 'Low (below 40 for men)', max: 40 },
          { level: 'normal', label: 'Normal', min: 40 }
        ],
        female: [
          { level: 'low', label: 'Low (below 50 for women)', max: 50 },
          { level: 'normal', label: 'Normal', min: 50 }
        ]
      }
    },
    triglycerides: {
      key: 'triglycerides', label: 'Triglycerides', unit: 'mg/dL', citation: 'AHA Scientific Statement 2011',
      bands: [
        { level: 'normal', label: 'Normal', max: 150 },
        { level: 'borderline', label: 'Borderline high', min: 150, max: 200 },
        { level: 'high', label: 'High', min: 200, max: 500 },
        { level: 'very_high', label: 'Very high', min: 500 }
      ],
      bandsBySex: null
    },
    vitaminD: {
      key: 'vitaminD', label: 'Vitamin D', unit: 'ng/mL', citation: 'Endocrine Society 2011',
      bands: [
        { level: 'low', label: 'Deficient', max: 20 },
        { level: 'borderline', label: 'Insufficient', min: 20, max: 30 },
        { level: 'normal', label: 'Sufficient', min: 30 }
      ],
      bandsBySex: null
    },
    crp: {
      key: 'crp', label: 'CRP', unit: 'mg/L', citation: 'AHA/CDC Scientific Statement 2003',
      bands: [
        { level: 'normal', label: 'Lower heart-risk range', max: 1 },
        { level: 'borderline', label: 'Average heart-risk range', min: 1, max: 3 },
        { level: 'high', label: 'Higher heart-risk range', min: 3, max: 10 },
        { level: 'very_high', label: 'Very high — often a recent infection or injury', min: 10 }
      ],
      bandsBySex: null
    },
    testosterone: {
      key: 'testosterone', label: 'Testosterone', unit: 'ng/dL', citation: 'AUA Testosterone Guideline 2018',
      bands: null,
      bandsBySex: {
        male: [
          { level: 'low', label: 'Low (below 300 for men)', max: 300 },
          { level: 'normal', label: 'Normal', min: 300 }
        ],
        // Guidelines give no comparable cut-off for women; not assessed.
        female: []
      }
    },
    ferritin: {
      key: 'ferritin', label: 'Ferritin', unit: 'ng/mL', citation: 'WHO Ferritin Guideline 2020',
      // WHO's iron-deficiency cut-off for adults is the same for men and women.
      bands: [
        { level: 'low', label: 'Low iron stores', max: 15 },
        { level: 'normal', label: 'Normal', min: 15 }
      ],
      bandsBySex: null
    }
  };

  /** Read a profile's free-text gender as a sex for ranges. Unknown → null (never guessed). */
  function sexFromProfile(gender) {
    var g = String(gender == null ? '' : gender).trim().toLowerCase();
    if (g === 'male' || g === 'man' || g === 'm') return 'male';
    if (g === 'female' || g === 'woman' || g === 'f') return 'female';
    return null;
  }

  /** Whole years from a birth date ("1990-05-20"), or null if missing/invalid. */
  function ageFromBirthDate(birthDate, now) {
    if (!birthDate) return null;
    var parts = String(birthDate).slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    now = now || new Date();
    var age = now.getFullYear() - parts[0];
    var m = now.getMonth() + 1;
    if (m < parts[1] || (m === parts[1] && now.getDate() < parts[2])) age--;
    return age;
  }

  /** The bands that apply to this person, or null when we can't judge fairly. */
  function bandsFor(range, person) {
    if (!person || person.age == null || person.age < ADULT_MIN_AGE) return null;
    if (range.bands) return range.bands;
    if (!range.bandsBySex || !person.sex) return null;
    var bands = range.bandsBySex[person.sex];
    return bands && bands.length > 0 ? bands : null;
  }

  function unitText(unit) {
    return String(unit).toLowerCase().replace(/\s+/g, '').replace(/[μµ]/g, 'u');
  }

  var SAME_UNIT = { 'ng/ml': ['ug/l', 'mcg/l'] };

  function unitMatches(range, unit) {
    if (unit == null || unit === '') return false;
    var want = unitText(range.unit);
    var got = unitText(unit);
    return got === want || (SAME_UNIT[want] || []).indexOf(got) !== -1;
  }

  /** Which band a value falls in for this person, or null if it can't be judged. */
  function classifyValue(key, value, unit, person) {
    var range = MARKER_RANGES[key];
    if (!range || value == null || !isFinite(value) || !unitMatches(range, unit)) return null;
    var bands = bandsFor(range, person);
    if (!bands) return null;
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if ((b.min === undefined || value >= b.min) && (b.max === undefined || value < b.max)) {
        return { band: b, range: range };
      }
    }
    return null;
  }

  var SEE = 'Please book a visit with your doctor to confirm this result.';

  /** What to do, by marker and band. Hedged, practical, never causal. Null when normal. */
  function adviceFor(key, level) {
    if (level === 'normal') return null;
    switch (key) {
      case 'glucose':
        if (level === 'low') return { severity: 'attention', action: 'If you felt shaky or unwell around that time, mention it to your doctor.' };
        if (level === 'high') return { severity: 'alert', action: SEE + ' A repeat test or an HbA1c test is the usual next step.' };
        return { severity: 'attention', action: 'Ask your doctor whether to confirm with an HbA1c test. Regular activity and fewer sugary drinks and refined carbs are the usual first steps.' };
      case 'hba1c':
        if (level === 'high') return { severity: 'alert', action: SEE };
        return { severity: 'attention', action: 'Worth discussing with your doctor. Regular activity, modest weight loss if needed, and fewer refined carbs are the usual first steps.' };
      case 'ldl':
        if (level === 'very_high') return { severity: 'alert', action: SEE + ' At this level guidelines usually consider treatment.' };
        if (level === 'high') return { severity: 'attention', action: 'Talk to your doctor about this result alongside your other heart-risk factors.' };
        return { severity: 'attention', action: 'Swapping some saturated fat (fatty meat, butter) for unsaturated fat and adding fibre (oats, beans) are the usual first steps.' };
      case 'hdl':
        return { severity: 'attention', action: 'Regular aerobic exercise is the most reliable way to raise HDL. Worth looking at alongside your LDL and triglycerides.' };
      case 'triglycerides':
        if (level === 'very_high') return { severity: 'alert', action: SEE + ' Very high triglycerides need prompt attention.' };
        return { severity: 'attention', action: 'Cutting back on sugar, refined carbs and alcohol usually brings triglycerides down. A fasting retest gives the clearest number.' };
      case 'vitaminD':
        return { severity: 'attention', action: 'Ask your doctor whether a vitamin D supplement makes sense for you, and retest in about 3 months.' };
      case 'crp':
        if (level === 'very_high') return { severity: 'attention', action: "Levels this high usually reflect a recent infection or injury. Retest in a few weeks once you're well." };
        return { severity: 'attention', action: "CRP can rise with a cold or a hard workout. Retest when you're well, and discuss it with your doctor alongside your cholesterol." };
      case 'testosterone':
        return { severity: 'attention', action: "One low result isn't a diagnosis; guidelines recommend a repeat early-morning test. Worth discussing with your doctor." };
      case 'ferritin':
        return { severity: 'attention', action: 'Low iron stores can cause tiredness. Ask your doctor about checking for iron deficiency before taking supplements.' };
      default:
        return null;
    }
  }

  /**
   * Every marker outside its guideline normal band, most urgent first.
   * bloodwork: { key: value }, units: { key: unit }, person: { sex, age }.
   */
  function checkLabResults(bloodwork, units, person) {
    var out = [];
    if (!bloodwork) return out;
    Object.keys(MARKER_RANGES).forEach(function (key) {
      var value = bloodwork[key];
      if (value == null) return;
      var result = classifyValue(key, value, units ? units[key] : null, person);
      if (!result) return;
      var advice = adviceFor(key, result.band.level);
      if (!advice) return;
      out.push({
        key: key,
        label: result.range.label,
        value: value,
        unit: result.range.unit,
        level: result.band.level,
        bandLabel: result.band.label,
        citation: result.range.citation,
        severity: advice.severity,
        action: advice.action
      });
    });
    return out.sort(function (a, b) {
      if (a.severity !== b.severity) return a.severity === 'alert' ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }

  var api = {
    ADULT_MIN_AGE: ADULT_MIN_AGE,
    MARKER_RANGES: MARKER_RANGES,
    sexFromProfile: sexFromProfile,
    ageFromBirthDate: ageFromBirthDate,
    bandsFor: bandsFor,
    unitMatches: unitMatches,
    classifyValue: classifyValue,
    adviceFor: adviceFor,
    checkLabResults: checkLabResults
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HealixRanges = api;
})(typeof window !== 'undefined' ? window : null);
