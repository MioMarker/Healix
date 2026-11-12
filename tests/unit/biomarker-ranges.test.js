// Run with: npm run test:unit  (plain Node, no browser needed)
var test = require('node:test');
var assert = require('node:assert');
var R = require('../../biomarker-ranges.js');

var man = { sex: 'male', age: 40 };
var woman = { sex: 'female', age: 40 };
var unknownSex = { sex: null, age: 40 };

function levels(bw, units, person) {
  return R.checkLabResults(bw, units, person).map(function (f) { return f.key + ':' + f.level; });
}

test('glucose: normal, prediabetes range, diabetes range', function () {
  assert.deepStrictEqual(levels({ glucose: 92 }, { glucose: 'mg/dL' }, man), []);
  assert.deepStrictEqual(levels({ glucose: 110 }, { glucose: 'mg/dL' }, man), ['glucose:borderline']);
  var high = R.checkLabResults({ glucose: 130 }, { glucose: 'mg/dL' }, man)[0];
  assert.strictEqual(high.severity, 'alert');
  assert.match(high.bandLabel, /Diabetes range/);
});

test('HDL uses a different cut-off for men and women', function () {
  assert.deepStrictEqual(levels({ hdl: 45 }, { hdl: 'mg/dL' }, man), []);
  assert.deepStrictEqual(levels({ hdl: 45 }, { hdl: 'mg/dL' }, woman), ['hdl:low']);
});

test('sex-specific markers are skipped, not guessed, when sex is unknown', function () {
  assert.deepStrictEqual(levels({ hdl: 35, testosterone: 250 }, { hdl: 'mg/dL', testosterone: 'ng/dL' }, unknownSex), []);
  assert.deepStrictEqual(levels({ glucose: 130 }, { glucose: 'mg/dL' }, unknownSex), ['glucose:high']);
});

test('testosterone is assessed for men only', function () {
  assert.deepStrictEqual(levels({ testosterone: 250 }, { testosterone: 'ng/dL' }, man), ['testosterone:low']);
  assert.deepStrictEqual(levels({ testosterone: 25 }, { testosterone: 'ng/dL' }, woman), []);
});

test('adult ranges are not applied to under-18s or unknown ages', function () {
  assert.deepStrictEqual(levels({ glucose: 130 }, { glucose: 'mg/dL' }, { sex: 'male', age: 16 }), []);
  assert.deepStrictEqual(levels({ glucose: 130 }, { glucose: 'mg/dL' }, { sex: 'male', age: null }), []);
});

test('values in an unexpected or missing unit are not judged', function () {
  assert.deepStrictEqual(levels({ glucose: 7.5 }, { glucose: 'mmol/L' }, man), []);
  assert.deepStrictEqual(levels({ glucose: 130 }, {}, man), []);
  assert.deepStrictEqual(levels({ ferritin: 10 }, { ferritin: 'ug/L' }, man), ['ferritin:low']);
});

test('one vitamin D scale: under 20 deficient, 20-29 insufficient', function () {
  assert.deepStrictEqual(levels({ vitaminD: 15 }, { vitaminD: 'ng/mL' }, man), ['vitaminD:low']);
  assert.deepStrictEqual(levels({ vitaminD: 25 }, { vitaminD: 'ng/mL' }, man), ['vitaminD:borderline']);
  assert.deepStrictEqual(levels({ vitaminD: 35 }, { vitaminD: 'ng/mL' }, man), []);
});

test('most urgent first, every result cited, no causal claims', function () {
  var out = R.checkLabResults(
    { vitaminD: 15, glucose: 130, ldl: 120 },
    { vitaminD: 'ng/mL', glucose: 'mg/dL', ldl: 'mg/dL' },
    man
  );
  assert.strictEqual(out[0].key, 'glucose');
  out.forEach(function (f) {
    assert.ok(f.citation.length > 0);
    assert.doesNotMatch(f.action, /\b(because|caused|causes|due to)\b/i);
  });
});

test('profile gender and birth date are read, never defaulted', function () {
  assert.strictEqual(R.sexFromProfile('Female'), 'female');
  assert.strictEqual(R.sexFromProfile('male'), 'male');
  assert.strictEqual(R.sexFromProfile('non-binary'), null);
  assert.strictEqual(R.sexFromProfile(null), null);
  assert.strictEqual(R.ageFromBirthDate('1986-11-20', new Date(2026, 10, 11)), 39);
  assert.strictEqual(R.ageFromBirthDate('1986-11-11', new Date(2026, 10, 11)), 40);
  assert.strictEqual(R.ageFromBirthDate(null), null);
});
