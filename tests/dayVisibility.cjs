const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const DAY = 86400000;
function date(key) {
  let time = Date.parse(key);
  return {
    clone: () => date(new Date(time).toISOString().slice(0, 10)),
    add(n) {time += n * DAY; return this},
    startOf() {return this},
    diff(other) {return (time - other.valueOf()) / DAY},
    format: () => new Date(time).toISOString().slice(0, 10),
    valueOf: () => time,
  };
}
function load(name) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', name + '.ts'), 'utf8');
  const js = ts.transpileModule(code, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
  const module = {exports: {}};
  const requireStub = spec => {
    if (spec === './moment') return {createMoment: date};
    if (spec === './noteIndex') return {DAY_KEY_FORMAT: 'YYYY-MM-DD'};
    throw new Error('Unexpected dependency: ' + spec);
  };
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})')(requireStub, module, module.exports);
  return module.exports;
}
const {DayWalker, ShownDays, monthTarget, MAX_OFFSET} = load('dayWalk');
const {emptyDayVisibilitySetting, hidesEmptyDay} = load('dayVisibility');
function sequence(keys) {
  const sorted = [...keys].sort();
  return {
    has: key => sorted.includes(key),
    next: key => sorted.find(k => k > key) ?? null,
    prev: key => [...sorted].reverse().find(k => k < key) ?? null,
  };
}
const today = date('2026-11-25');
const notes = sequence(['2000-01-01', '2026-11-20', '2026-11-23', '2026-11-27', '2050-01-01']);
const matching = sequence(['2000-01-01', '2026-11-20', '2026-11-27', '2050-01-01']);
function fixture(mode) {
  const hide = offset => hidesEmptyDay(mode, offset);
  const files = sequence(['2026-11-22', '2026-11-23', '2026-11-26']);
  const shown = new ShownDays(notes, matching, () => files, key => !hide(date(key).diff(today)));
  return {shown, walker: new DayWalker(today, notes, shown, hide)};
}
test('old toggle values migrate without changing the default or new selection', () => {
  assert.equal(emptyDayVisibilitySetting(undefined, true), 'notes');
  assert.equal(emptyDayVisibilitySetting(undefined, false), 'all');
  assert.equal(emptyDayVisibilitySetting(undefined, undefined), 'notes');
  assert.equal(emptyDayVisibilitySetting('future', true), 'future');
  assert.equal(emptyDayVisibilitySetting('invalid', false), 'all');
});
test('all three modes keep today and respect hidden notes', () => {
  for (const mode of ['all', 'notes', 'future']) {
    const {walker} = fixture(mode);
    assert.equal(walker.isVisible(0), true);
    assert.equal(walker.isVisible(-2), false);
    assert.equal(walker.isVisible(-5), true);
    assert.equal(walker.isVisible(2), true);
    assert.equal(walker.isVisible(-1), mode === 'all');
    assert.equal(walker.isVisible(1), mode !== 'notes');
  }
});
test('mixed mode jumps across empty past dates and walks future dates in either direction', () => {
  const {walker, shown} = fixture('future');
  assert.equal(walker.next(0, -1), -5);
  assert.equal(walker.next(-5, 1), 0);
  assert.equal(walker.next(0, 1), 1);
  assert.equal(walker.next(1, 1), 2);
  assert.equal(walker.next(2, -1), 1);
  assert.equal(walker.next(1, -1), 0);
  assert.equal(walker.next(-3, 1), 0);
  assert.equal(walker.next(-3, -1), -5);
  assert.equal(walker.origin(date('2026-11-24')), 0);
  assert.equal(shown.has('2026-11-22'), false);
  assert.equal(shown.has('2026-11-23'), false);
  assert.equal(shown.has('2026-11-26'), true);
  assert.equal(shown.prev('2026-11-25'), '2026-11-20');
});
test('mixed mode keeps the past indexed-note exception but bounds future empty dates', () => {
  const {walker} = fixture('future');
  const farPast = walker.offsetFor('2000-01-01');
  const farFuture = walker.offsetFor('2050-01-01');
  assert.equal(walker.next(-5, -1), farPast);
  assert.equal(walker.isReachable(farPast), true);
  assert.equal(walker.isReachable(farFuture), false);
  assert.equal(walker.next(MAX_OFFSET, 1), null);
  assert.equal(walker.isReachable(-MAX_OFFSET - 1), false);
});
test('the previous modes retain calendar walking and sparse walking respectively', () => {
  assert.equal(fixture('all').walker.next(0, -1), -1);
  assert.equal(fixture('all').walker.next(0, 1), 1);
  assert.equal(fixture('notes').walker.next(0, -1), -5);
  assert.equal(fixture('notes').walker.next(0, 1), 2);
});
test('mixed mode month navigation falls back to visible dates', () => {
  const {walker, shown} = fixture('future');
  const target = (year, month) => monthTarget(shown, year, month, '2026-11-25', false,
    key => walker.isVisible(walker.offsetFor(key)));
  assert.equal(target(2026, 11), '2026-12-01');
  assert.equal(target(2026, 9), '2026-11-20');
});
