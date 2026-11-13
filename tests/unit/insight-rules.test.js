// Loads the browser scripts into a fake window and runs the lab insight rules.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var sandbox = { window: {}, console: console };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
['biomarker-ranges.js', 'insights-engine.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8'), sandbox, { filename: f });
});
var HI = sandbox.window.HealixInsights;
function rule(id) { return HI.ALL_INSIGHT_RULES.filter(function (r) { return r.id === id; })[0]; }

function ctxFor(labValues, labUnits, person, extra) {
  var metrics = Object.assign({ bloodwork: labValues, labResults: { values: labValues, units: labUnits }, labPerson: person }, extra || {});
  return HI.buildWebRuleContext(metrics, {}, {});
}

test('flagged-labs card uses guideline bands, cites sources, gives a next step', function () {
  var r = rule('bloodwork_flagged');
  var data = r.detect(ctxFor({ glucose: 130, ldl: 117 }, { glucose: 'mg/dL', ldl: 'mg/dL' }, { sex: 'male', age: 40 }));
  assert.strictEqual(data.flagged.map(function (f) { return f.key; }).join(','), 'glucose,ldl');
  var card = r.template(data);
  assert.strictEqual(card._severity, 'alert');
  assert.match(card.body, /diabetes range/);
  assert.match(card.body, /ADA Standards of Care 2024/);
  assert.match(card.body, /Please book a visit/);
});

test('flagged-labs card: LDL 117 alone is "above optimal", not silent', function () {
  var r = rule('bloodwork_flagged');
  var card = r.template(r.detect(ctxFor({ ldl: 117 }, { ldl: 'mg/dL' }, { sex: 'male', age: 40 })));
  assert.strictEqual(card.headline, 'LDL cholesterol: Above optimal');
});

test('flagged-labs card: nothing when all results are in range', function () {
  var r = rule('bloodwork_flagged');
  assert.strictEqual(r.detect(ctxFor({ glucose: 90, ldl: 80 }, { glucose: 'mg/dL', ldl: 'mg/dL' }, { sex: 'male', age: 40 })), null);
});

test('flagged-labs card: HDL 45 is low for a woman, fine for a man, skipped if sex unknown', function () {
  var r = rule('bloodwork_flagged');
  var u = { hdl: 'mg/dL' };
  assert.ok(r.detect(ctxFor({ hdl: 45 }, u, { sex: 'female', age: 40 })));
  assert.strictEqual(r.detect(ctxFor({ hdl: 45 }, u, { sex: 'male', age: 40 })), null);
  assert.strictEqual(r.detect(ctxFor({ hdl: 35 }, u, { sex: null, age: 40 })), null);
});

test('VO2 + HDL card uses the sex-aware cut-off and says which one', function () {
  var r = rule('vo2_hdl');
  var woman = r.detect(ctxFor({ hdl: 45 }, { hdl: 'mg/dL' }, { sex: 'female', age: 40 }, { vo2max: 35 }));
  assert.strictEqual(woman.lowHdl, true);
  assert.match(r.template(woman).body, /50 mg\/dL AHA threshold for women/);
  var man = r.detect(ctxFor({ hdl: 45 }, { hdl: 'mg/dL' }, { sex: 'male', age: 40 }, { vo2max: 35 }));
  assert.strictEqual(man.lowHdl, false);
  assert.strictEqual(r.detect(ctxFor({ hdl: 45 }, { hdl: 'mg/dL' }, { sex: null, age: 40 }, { vo2max: 35 })), null);
});

test('age and sex come from the profile when metrics lack them', function () {
  var ctx = HI.buildWebRuleContext({}, { gender: 'Female', birth_date: '1980-01-01' }, {});
  assert.strictEqual(ctx.metrics.labPerson.sex, 'female');
  assert.ok(ctx.metrics.labPerson.age >= 45);
  assert.strictEqual(HI.buildWebRuleContext({}, {}, {}).metrics.labPerson.sex, null);
});
