// Run the actual TypeScript methods with deterministic vault failures and timers.
// These tests do not claim to emulate Obsidian's DOM or embedded editor runtime.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function environment() {
  const notices = [];
  const timers = new Map();
  let timerId = 0;
  const clock = {
    setTimeout(fn, delay) {const id = ++timerId; timers.set(id, {fn, delay}); return id},
    clearTimeout(id) {timers.delete(id)},
    requestAnimationFrame(fn) {return this.setTimeout(fn, 16)},
    cancelAnimationFrame(id) {timers.delete(id)},
  };
  class TFile {constructor(path) {this.path = path; this.extension = 'md'; this.basename = path.split('/').pop().replace(/\.md$/, '')}}
  const obsidian = {
    TFile, AbstractInputSuggest: class {}, Component: class {load() {} unload() {}}, FileView: class {},
    ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {},
    Notice: class {constructor(message) {notices.push(message)}},
    MarkdownRenderer: {render: async () => {}},
    getFrontMatterInfo: text => {
      const match = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(text);
      return {contentStart: match?.[0].length ?? 0, exists: !!match};
    },
    getAllTags: cache => cache?.tags?.map(item => item.tag) ?? [],
    parseFrontMatterTags: frontmatter => frontmatter?.tags ?? [],
    parseYaml: () => ({}),
    setIcon() {}, setTooltip() {}, debounce: fn => fn,
    moment: () => ({startOf() {return this}, diff() {return 0}, isValid() {return true}}),
  };
  const modules = new Map();
  function load(name) {
    const file = path.join(root, 'src', `${name}.ts`);
    if (modules.has(file)) return modules.get(file).exports;
    const module = {exports: {}};
    modules.set(file, module);
    let source = fs.readFileSync(file, 'utf8');
    if (name === 'editor') source += '\nexport { RichEditor, resolveEditorCtor };';
    const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
    const customRequire = spec => spec === 'obsidian' ? obsidian : spec.startsWith('.') ? load(path.basename(spec)) : require(spec);
    vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {
      console: {warn() {}, error() {}}, window: clock, performance, Date,
      createDiv: () => ({createDiv: () => ({}), createEl: () => ({}), createSpan: () => ({}), empty() {}, appendChild() {}, setText() {}, setAttribute() {}}),
      createFragment: () => ({appendText() {}, createEl() {}}),
    }, {filename: file})(customRequire, module, module.exports);
    return module.exports;
  }
  function entryFixture(initial, diskInitial = initial) {
    const {NoteEntry} = load('entry');
    const {SaveQueue} = load('saveQueue');
    const file = new TFile('Journal/2026-09-12.md');
    const files = new Map([[file.path, diskInitial]]);
    let editorText = initial;
    let writes = 0;
    const entry = Object.create(NoteEntry.prototype);
    Object.assign(entry, {
      file, path: file.path, lastKnownContent: initial, latestContent: diskInitial,
      lastKnownEditorBody: initial, hiddenNotePrefix: null, pendingTemplate: null,
      pendingTemplatePrefix: null, acceptedTemplateProjection: false, saveConflict: false,
      conflictCopy: null, conflictBody: null, saveFailureNotified: false, captureRetryTimer: 0,
      destroyed: false, externalReloadPending: false, metadataWrites: Promise.resolve(),
      readToken: 0, loaded: true, loadingContent: false, hideDailyNoteH1: false,
      focused: false,
      editor: {getValue: () => editorText, tryGetValue: () => editorText, destroy() {}, setFile() {}},
      refreshMetadata(content) {this.latestContent = content},
      host: {date: {format: () => '2026-09-12'}, app: {vault: {
        process: async (f, fn) => {
          writes++;
          if (!files.has(f.path)) throw new Error('missing file');
          const next = fn(files.get(f.path)); files.set(f.path, next); return next;
        },
        cachedRead: async f => files.get(f.path),
        getAbstractFileByPath: p => files.has(p) ? new TFile(p) : null,
        create: async (p, text) => {
          if (files.has(p)) throw new Error('file exists');
          files.set(p, text); return new TFile(p);
        },
      }}},
      clearFindState() {}, stopRevealing() {}, el: {remove() {}, addClass() {}, removeClass() {}, toggleClass() {}},
      bodyEl: {empty() {}}, focusSettleToken: 0,
    });
    entry.queue = new SaveQueue(value => entry.writeValue(value));
    return {entry, files, writes: () => writes, type: text => {editorText = text}};
  }
  return {load, notices, timers, clock, TFile, entryFixture};
}

test('later edits keep saving to the conflict copy without overwriting the original', async () => {
  const e = environment(); const f = e.entryFixture('original', 'external edit');
  f.type('journal edit'); await f.entry.flush();
  const copy = f.entry.conflictCopy;
  assert.ok(copy);
  f.type('journal edit plus later words'); await f.entry.flush();
  f.entry.destroy(); await f.entry.queue.settled();
  assert.equal(f.files.get(f.entry.path), 'external edit');
  assert.equal(f.files.get(copy.path), 'journal edit plus later words');
  assert.equal(f.files.size, 2);
  assert.equal(e.timers.size, 0);
});

test('editing a conflict copy elsewhere saves further journal edits to another copy', async () => {
  const e = environment(); const f = e.entryFixture('original', 'external edit');
  f.type('journal edit'); await f.entry.flush();
  const firstCopy = f.entry.conflictCopy.path;
  f.files.set(firstCopy, 'edited recovery elsewhere');
  f.type('more journal text'); await f.entry.flush();
  assert.equal(f.files.get(firstCopy), 'edited recovery elsewhere');
  assert.equal(f.files.get(f.entry.conflictCopy.path), 'more journal text');
  assert.notEqual(firstCopy, f.entry.conflictCopy.path);
});

test('a failed internal editor read never saves an empty body and retries capture', async () => {
  const e = environment(); const f = e.entryFixture('valuable note body');
  const {RichEditor} = e.load('editor');
  const editor = Object.create(RichEditor.prototype);
  editor.lastReadableValue = 'valuable note body';
  editor.instance = {get() {throw new Error('internal API failure')}};
  f.entry.editor = editor;
  await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), 'valuable note body');
  assert.equal(f.writes(), 0);
  assert.equal(editor.getValue(), 'valuable note body');
  assert.equal(e.timers.size, 1);
  editor.instance.get = () => 'recovered editor text';
  await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), 'recovered editor text');
  assert.equal(e.timers.size, 0);
});

test('benchmark search match rank across the journal', {skip: process.env.JOURNAL_PERF !== '1'}, () => {
  const {FindResults} = environment().load('findResults');
  function sample(size, instrument) {
    const results = new FindResults();
    const keys = Array.from({length: size}, (_, i) => new Date(Date.UTC(1970, 0, i + 1)).toISOString().slice(0, 10));
    const prefix = [0];
    for (let i = 0; i < size; i++) {
      const count = i % 7 + 1;
      results.set(keys[i], keys[i] + '.md', 0, count, 1);
      results.set(keys[i], keys[i] + ' evening.md', 1, 2, 1);
      prefix.push(prefix[i] + count + 2);
    }
    const queries = [];
    for (let i = 0; i < 1000; i++) {
      const at = i % 4 === 0 ? 0 : i % 4 === 1 ? size - 1 : Math.floor(((i * 7919) % size));
      const step = i % 2 ? -1 : 1;
      const path = keys[at] + ' evening.md';
      const expected = (step > 0 ? prefix[at] : prefix[size] - prefix[at + 1]) + (at % 7 + 1) + 1;
      queries.push({position: {key: keys[at], path, index: 1}, step, expected});
    }
    let lookups = 0;
    if (instrument) {
      const get = results.days.get.bind(results.days);
      results.days.get = (...args) => {lookups++; return get(...args);};
    }
    const start = performance.now();
    for (const {position, step, expected} of queries) assert.equal(results.indexOf(position, step), expected);
    return {ms: performance.now() - start, lookups};
  }
  console.log('RANK_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    sample(size, false);
    const samples = Array.from({length: 5}, () => sample(size, false));
    console.log('RANK_RESULT ' + JSON.stringify({size, samples, lookups: sample(size, true).lookups}));
  }
});

test('search ranks stay exact after insert, recount, move, deletion and prune', () => {
  const {FindResults} = environment().load('findResults');
  const r = new FindResults();
  const keys = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
  const model = new Map();
  const set = (key, path, order, count, generation) => {
    r.set(key, path, order, count, generation);
    if (count > 0) model.set(path, {key, path, order, count, generation});
    else model.delete(path);
  };
  const check = () => {
    for (const step of [-1, 1]) {
      const sorted = [...model.values()].sort((a, b) =>
        step * a.key.localeCompare(b.key) || a.order - b.order || a.path.localeCompare(b.path));
      let index = 0;
      for (const note of sorted) {
        for (let i = 0; i < note.count; i++) {
          assert.equal(r.indexOf({key: note.key, path: note.path, index: i}, step), index++);
        }
        assert.equal(r.indexOf({key: note.key, path: note.path, index: note.count}, step), -1);
        assert.equal(r.indexOf({key: note.key, path: note.path, index: -1}, step), -1);
      }
      assert.equal(r.total, index);
      assert.equal(r.indexOf({key: keys[0], path: 'missing', index: 0}, step), -1);
    }
  };
  check();
  set(keys[3], 'd', 0, 7, 1); check();
  set(keys[0], 'a', 0, 2, 1);
  set(keys[0], 'a2', 1, 3, 1);
  set(keys[1], 'b', 0, 5, 2);
  set(keys[2], 'c', 0, 4, 2); check();
  set(keys[1], 'b', 0, 1, 3); check();
  set(keys[3], 'c', 1, 2, 3); check();
  r.delete('a'); model.delete('a'); check();
  r.prune(2);
  for (const [path, note] of model) if (note.generation < 2) model.delete(path);
  check();
  r.clear(); model.clear(); check();
});

test('editor document supplies current text when its convenience getter breaks', () => {
  const e = environment(); const {RichEditor} = e.load('editor');
  const editor = Object.create(RichEditor.prototype);
  editor.instance = {get() {throw new Error('getter failed')}, editor: {cm: {state: {doc: {toString: () => 'current document'}}}}};
  assert.equal(editor.tryGetValue(), 'current document');
});

test('live editor updates include frontmatter and skip conflicted content', () => {
  const e = environment(); const {RichEditor} = e.load('editor');
  const editor = Object.create(RichEditor.prototype);
  const file = new e.TFile('Journal/today.md'); const owner = {file}; const events = [];
  editor.owner = owner;
  editor.instance = {get: () => 'new body'};
  editor.options = {
    app: {workspace: {activeEditor: owner, trigger: (...args) => events.push(args)}},
    noteContent: body => `---\nmood: good\n---\n# Title\n\n${body}`,
  };
  editor.publishCurrentContent(true);
  assert.deepEqual(events[0], ['quick-preview', file, '---\nmood: good\n---\n# Title\n\nnew body']);
  editor.options.noteContent = () => null;
  editor.publishCurrentContent(true);
  assert.equal(events.length, 1);
});

test('failed teardown writes retry automatically and release their timer after recovery', async () => {
  const e = environment(); const f = e.entryFixture('original');
  const vault = f.entry.host.app.vault; const process = vault.process;
  vault.process = async () => {throw new Error('disk unavailable')};
  f.type('unsaved text'); f.entry.destroy(); await f.entry.queue.settled();
  assert.equal(f.entry.editor, null); assert.equal(f.entry.queue.hasPending, true);
  assert.equal(e.timers.size, 1);
  vault.process = process;
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn();
  await f.entry.queue.settled();
  assert.equal(f.files.get(f.entry.path), 'unsaved text');
  assert.equal(f.entry.queue.hasPending, false); assert.equal(e.timers.size, 0);
});

test('thrown queue callbacks keep the newest pending value with bounded backoff', async () => {
  const e = environment(); const {SaveQueue} = e.load('saveQueue');
  let broken = true; const saved = [];
  const queue = new SaveQueue(async value => {if (broken) throw new Error('failure'); saved.push(value); return true});
  await queue.submit('first');
  await queue.submit('newest');
  for (let i = 0; i < 8; i++) {
    assert.equal(e.timers.size, 1);
    const [id, timer] = [...e.timers][0]; assert.ok(timer.delay <= 60000);
    e.timers.delete(id); timer.fn(); await queue.settled();
  }
  broken = false;
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn(); await queue.settled();
  assert.deepEqual(saved, ['newest']); assert.equal(e.timers.size, 0);
});

test('undo during a delayed save leaves the final editor text on disk', async () => {
  const e = environment(); const f = e.entryFixture('original');
  const vault = f.entry.host.app.vault; const process = vault.process;
  let finish; let started;
  const ready = new Promise(resolve => {started = resolve});
  vault.process = async (file, fn) => {
    vault.process = process;
    started(); await new Promise(resolve => {finish = resolve});
    return process(file, fn);
  };
  f.type('temporary edit'); const saving = f.entry.flush(); await ready;
  f.type('original'); const undoing = f.entry.flush(); finish();
  await Promise.all([saving, undoing]);
  assert.equal(f.files.get(f.entry.path), 'original'); assert.equal(f.entry.isDirty, false);
});

test('benchmark recounting existing search results', () => {
  const {FindResults} = environment().load('findResults');
  function sample(size, instrument) {
    const keys = Array.from({length: size}, (_, i) => new Date(Date.UTC(1970, 0, 1 + i)).toISOString().slice(0, 10));
    const results = new FindResults();
    for (const key of keys) results.set(key, key + '.md', 0, 2, 1);
    let shifts = 0;
    if (instrument) {
      const splice = results.keys.splice.bind(results.keys);
      results.keys.splice = (...args) => {shifts++; return splice(...args);};
    }
    const start = performance.now();
    for (const key of keys) results.set(key, key + '.md', 0, 3, 2);
    const ms = performance.now() - start;
    results.prune(2);
    assert.equal(results.total, size * 3);
    assert.equal(results.indexOf(results.first(keys[Math.floor(size / 2)]), 1), Math.floor(size / 2) * 3);
    assert.equal(results.indexOf(results.first(keys[Math.floor(size / 2)]), -1), (size - 1 - Math.floor(size / 2)) * 3);
    if (instrument) assert.equal(shifts, 0);
    return {ms, shifts};
  }
  console.log('RECOUNT_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    sample(size, false);
    const samples = Array.from({length: 5}, () => sample(size, false));
    console.log('RECOUNT_RESULT ' + JSON.stringify({size, samples, shifts: sample(size, true).shifts}));
  }
});

test('search recount updates counts and generations without disturbing result order', () => {
  const {FindResults} = environment().load('findResults');
  const r = new FindResults();
  const day = '2026-11-26', later = '2026-11-27';
  r.set(day, 'b', 1, 2, 1);
  r.set(day, 'a', 0, 1, 1);
  r.set(later, 'c', 0, 3, 1);
  r.set(day, 'b', 1, 5, 2);
  r.set(day, 'a', 0, 1, 2); // unchanged count still updates generation
  r.prune(2);
  assert.equal(r.total, 6);
  assert.equal(r.first(day).path, 'a');
  assert.equal(r.last(day).path, 'b');
  assert.equal(r.indexOf({key: day, path: 'b', index: 4}, 1), 5);
  assert.equal(r.indexOf({key: day, path: 'b', index: 4}, -1), 5);
  r.set(day, 'b', -1, 5, 3); // order changed
  assert.equal(r.first(day).path, 'b');
  r.set(later, 'b', 0, 4, 3); // path moved to another day
  assert.equal(r.first(day).path, 'a');
  assert.equal(r.first(later).path, 'b');
  assert.equal(r.total, 5);
  r.set(day, 'a', 0, 0, 3);
  assert.equal(r.first(day), null);
  assert.equal(r.total, 4);
  r.delete('b');
  assert.equal(r.total, 0);
  assert.equal(r.firstKey(1), null);
});

test('cancelled search cannot select a result after an outstanding day load returns', async () => {
  const e = environment(); const {JournalFind} = e.load('find');
  let finish; let synced = 0; let selections = 0;
  const find = Object.create(JournalFind.prototype);
  Object.assign(find, {
    navigationToken: 0, open: true, pass: {}, live: new Map(), travelling: false,
    cancelJump() {}, updateButtons() {}, select() {selections++}, syncLive() {synced++},
    host: {loadFindDate: () => new Promise(resolve => {finish = resolve}), isFindReady: () => true},
  });
  const pending = find.goTo({key: '2026-09-12', path: 'Journal/2026-09-12.md', index: 0});
  find.navigationToken++; find.open = false;
  finish(); await pending;
  assert.equal(synced, 0); assert.equal(selections, 1);
});

test('unfiltered index delegates navigation without duplicate scans or membership', () => {
  const e = environment(); const {FilteredDailyNoteIndex} = e.load('filter');
  let scans = 0;
  const keys = ['2026-01-01', '2026-01-03'];
  const base = {version: 1, ensureCurrent() {}, size: 2, has: key => keys.includes(key),
    changedSince: () => null,
    range: () => ({first: keys[0], last: keys[1]}), next: () => keys[1], prev: () => keys[0], keysAround: () => keys};
  const index = new FilteredDailyNoteIndex({vault: {getMarkdownFiles() {scans++; return []}}}, base, () => []);
  index.ensureCurrent(); base.version++; index.ensureCurrent();
  assert.equal(index.has(keys[0]), true); assert.equal(index.size, 2);
  assert.deepEqual(index.range(), base.range()); assert.equal(index.next(keys[0]), keys[1]);
  assert.equal(index.prev(keys[1]), keys[0]); assert.deepEqual(index.keysAround(keys[0], 1), keys);
  assert.equal(scans, 0);
  for (const collection of ['keys', 'matchingPaths', 'pathKeys', 'matchingCounts']) assert.equal(index[collection].size, 0);
});

test('turning filters on and off still returns the correct dates and frees filter storage', () => {
  const e = environment(); const {FilteredDailyNoteIndex} = e.load('filter');
  const files = [new e.TFile('one'), new e.TFile('two')];
  let rules = [];
  const base = {version: 1, ensureCurrent() {}, resolvedConfig: () => ({}), keyForPath: path => path, has: () => true, size: 2, changedSince: () => null};
  const index = new FilteredDailyNoteIndex({vault: {getMarkdownFiles: () => files}, metadataCache: {getFileCache: file => ({tags: [{tag: file.path === 'one' ? '#yes' : '#no'}]})}}, base, () => rules);
  index.ensureCurrent(); assert.equal(index.size, 2);
  rules = [{kind: 'tag', mode: 'include', tag: 'yes'}]; index.ensureCurrent();
  assert.equal(index.size, 1); assert.equal(index.has('one'), true); assert.equal(index.has('two'), false);
  rules = []; index.ensureCurrent(); assert.equal(index.size, 2); assert.equal(index.pathKeys.size, 0);
});

test('benchmark incremental unfiltered index updates on synthetic vaults', () => {
  const e = environment();
  const {FilteredDailyNoteIndex} = e.load('filter');
  const rules = [];
  function sample(size) {
    const files = new Map();
    const keys = new Set();
    let resolutions = 0;
    let metadataLookups = 0;
    let lastPath = null;
    const base = {
      version: 0, ensureCurrent() {},
      changedSince(version) {
        if (version === this.version) return [];
        return version === this.version - 1 && lastPath ? [lastPath] : null;
      },
      keyForPath(path) {resolutions++; return path.slice(8, -3);},
      has: key => keys.has(key),
      get size() {return keys.size;},
    };
    const index = new FilteredDailyNoteIndex({
      vault: {
        getMarkdownFiles: () => [...files.values()],
        getAbstractFileByPath: path => files.get(path) ?? null,
      },
      metadataCache: {getFileCache() {metadataLookups++; return null;}},
    }, base, () => rules);
    index.ensureCurrent();
    const incoming = Array.from({length: size}, (_, i) => {
      const key = new Date(Date.UTC(1970, 0, 1 + i)).toISOString().slice(0, 10);
      return {key, file: new e.TFile('Journal/' + key + '.md')};
    });
    const start = performance.now();
    for (const {key, file} of incoming) {
      keys.add(key);
      files.set(file.path, file);
      lastPath = file.path;
      base.version++;
      index.ensureCurrent();
    }
    const ms = performance.now() - start;
    assert.equal(index.size, size);
    assert.equal(index.has(incoming[0].key), true);
    assert.equal(index.has(incoming[size - 1].key), true);
    const membershipEntries = ['keys', 'matchingPaths', 'pathKeys', 'matchingCounts']
      .reduce((sum, field) => sum + index[field].size, 0);
    return {ms, resolutions, metadataLookups, membershipEntries};
  }
  console.log('INCREMENTAL_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    sample(size);
    const samples = Array.from({length: 5}, () => sample(size));
    const median = {};
    for (const key of Object.keys(samples[0])) {
      median[key] = samples.map(row => row[key]).sort((a, b) => a - b)[2];
    }
    console.log('INCREMENTAL_RESULT ' + JSON.stringify({size, median, samples}));
  }
});

test('unfiltered incremental projection stays empty and active rules rebuild correctly', () => {
  const e = environment();
  const {FilteredDailyNoteIndex} = e.load('filter');
  const files = new Map();
  const keys = new Set();
  let rules = [];
  let lastPath;
  let lookups = 0;
  const base = {
    version: 0, ensureCurrent() {}, resolvedConfig: () => ({}),
    changedSince(version) {
      if (version === this.version) return [];
      return version === this.version - 1 && lastPath ? [lastPath] : null;
    },
    keyForPath: path => path.slice(8, -3),
    has: key => keys.has(key),
    get size() {return keys.size;},
  };
  const index = new FilteredDailyNoteIndex({
    vault: {getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: path => files.get(path) ?? null},
    metadataCache: {getFileCache(file) {lookups++; return {frontmatter: {include: file.path.includes('01.md')}};}},
  }, base, () => rules);
  function change(key, exists) {
    const path = 'Journal/' + key + '.md';
    if (exists) {files.set(path, new e.TFile(path)); keys.add(key);}
    else {files.delete(path); keys.delete(key);}
    lastPath = path; base.version++; index.ensureCurrent();
    assert.equal(index.baseVersion, base.version);
  }
  const empty = () => {
    for (const field of ['keys', 'matchingPaths', 'pathKeys', 'matchingCounts']) assert.equal(index[field].size, 0);
  };
  index.ensureCurrent();
  change('2026-01-01', true);
  change('2026-01-02', true);
  assert.equal(index.size, 2);
  assert.equal(index.has('2026-01-02'), true);
  empty(); assert.equal(lookups, 0);
  rules = [{kind: 'property', mode: 'include', property: 'include', value: true}];
  index.ensureCurrent();
  assert.equal(index.size, 1);
  assert.equal(index.has('2026-01-01'), true);
  assert.equal(index.has('2026-01-02'), false);
  change('2026-01-01', false);
  assert.equal(index.size, 0);
  change('2026-02-01', true);
  assert.equal(index.size, 1);
  assert.equal(index.has('2026-02-01'), true);
  rules = []; index.ensureCurrent(); empty();
  const prior = lookups;
  change('2026-02-01', false);
  change('2026-02-02', true);
  assert.equal(index.size, 2);
  assert.equal(index.has('2026-02-01'), false);
  assert.equal(index.has('2026-02-02'), true);
  empty(); assert.equal(lookups, prior);
});

test('literal existence checks match full search semantics including Unicode and punctuation', () => {
  const e = environment(); const {containsLiteral, findLiteralRanges} = e.load('findText');
  for (const [text, query] of [['a[b a[b', 'a[b'], ['Kelvin K', 'k'], ['😀😀', '😀'], ['none', ''], ['Straße', 'SS'], ['A\na', 'a']]) {
    for (const sensitive of [true, false]) assert.equal(containsLiteral(text, query, sensitive), findLiteralRanges(text, query, sensitive).length > 0);
  }
});

test('benchmark pruning stale search results at different densities', () => {
  const {FindResults} = environment().load('findResults');
  function sample(size, stalePercent, instrument) {
    const results = new FindResults();
    const keys = Array.from({length: size}, (_, i) => new Date(Date.UTC(1970, 0, i + 1)).toISOString().slice(0, 10));
    const survivors = [];
    let total = 0;
    for (let i = 0; i < size; i++) {
      const key = keys[i];
      const stale = i % 100 < stalePercent;
      results.set(key, key + '.md', 0, 2, stale ? 1 : 2);
      if (!stale) {survivors.push(key); total += 2;}
      if (i % 17 === 0) {
        results.set(key, key + ' evening.md', 1, 3, 2);
        if (stale) survivors.push(key);
        total += 3;
      }
    }
    let shifts = 0;
    if (instrument) {
      const splice = results.keys.splice.bind(results.keys);
      results.keys.splice = (...args) => {shifts++; return splice(...args);};
    }
    const start = performance.now();
    results.prune(2);
    const ms = performance.now() - start;
    assert.equal(results.total, total);
    assert.deepEqual(Array.from(results.keys), survivors);
    assert.equal(results.noteKeys.size, size - keys.filter((_, i) => i % 100 < stalePercent).length + Math.ceil(size / 17));
    assert.equal(results.firstKey(1), survivors[0] ?? null);
    assert.equal(results.firstKey(-1), survivors.at(-1) ?? null);
    for (let i = 0; i < size; i++) {
      const key = keys[i];
      assert.equal(results.note(key + '.md')?.count ?? 0, i % 100 < stalePercent ? 0 : 2);
      if (i % 17 === 0) assert.equal(results.note(key + ' evening.md')?.count, 3);
    }
    if (instrument) assert.equal(shifts, 0);
    return {ms, shifts};
  }
  console.log('PRUNE_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    for (const stalePercent of [0, 50, 90]) {
      sample(size, stalePercent, false);
      const samples = Array.from({length: 5}, () => sample(size, stalePercent, false));
      console.log('PRUNE_RESULT ' + JSON.stringify({size, stalePercent, samples, shifts: sample(size, stalePercent, true).shifts}));
    }
  }
});

test('prune preserves order and navigation across partially surviving days and repeated cleanup', () => {
  const {FindResults} = environment().load('findResults');
  const r = new FindResults();
  const a = '2026-01-01', b = '2026-01-02', c = '2026-01-03';
  r.set(c, 'c', 0, 4, 1);
  r.set(a, 'a3', 2, 3, 2);
  r.set(a, 'a2', 1, 2, 1);
  r.set(a, 'a1', 0, 1, 2);
  r.set(b, 'b', 0, 2, 3);
  r.prune(2);
  assert.equal(r.total, 6);
  assert.equal(r.note('a2'), null);
  assert.equal(r.note('c'), null);
  assert.equal(r.first(a).path, 'a1');
  assert.equal(r.last(a).path, 'a3');
  assert.equal(r.after(r.last(a), 1).path, 'b');
  assert.equal(r.before(r.first(b), 1).path, 'a3');
  assert.equal(r.indexOf(r.last(a), 1), 3);
  assert.equal(r.indexOf(r.last(a), -1), 5);
  r.prune(2); assert.equal(r.total, 6);
  r.prune(3); assert.equal(r.total, 2); assert.equal(r.firstKey(1), b);
  r.prune(4); assert.equal(r.total, 0); assert.equal(r.firstKey(-1), null);
  assert.equal(r.noteKeys.size, 0); assert.equal(r.days.size, 0);
  r.set(c, 'c', 0, 4, 5); assert.equal(r.total, 4); assert.equal(r.firstKey(1), c);
});

test('a late read cannot replace newer content from a metadata event', async () => {
  const e = environment(); const f = e.entryFixture('old');
  f.entry.editor = null; f.entry.renderPreview = async () => {}; f.entry.host.onEntryContentChanged = () => {};
  let finish; f.entry.host.app.vault.cachedRead = () => new Promise(resolve => {finish = resolve});
  const stale = f.entry.reload(); await f.entry.reload('new external content'); finish('stale content'); await stale;
  assert.equal(f.entry.lastKnownContent, 'new external content');
});

test('a failed vault read leaves existing content intact', async () => {
  const e = environment(); const f = e.entryFixture('existing note');
  f.entry.host.app.vault.cachedRead = async () => {throw new Error('read failed')};
  await f.entry.reload(); assert.equal(f.entry.lastKnownContent, 'existing note');
  assert.equal(f.entry.editor.getValue(), 'existing note');
});

test('benchmark overlapping search reads of synthetic notes', async () => {
  const e = environment();
  const {FindCorpus} = e.load('findCorpus');
  async function sample(size) {
    let reads = 0;
    const text = '---\r\nmarker: hidden\r\n---\r\n# Heading\r\nneedle 😀\r\n';
    const expected = '# Heading\nneedle 😀\n';
    const files = Array.from({length: size}, (_, i) => {
      const file = new e.TFile('Journal/' + i + '.md');
      file.stat = {mtime: 1, size: text.length};
      return file;
    });
    const byPath = new Map(files.map(file => [file.path, file]));
    const corpus = new FindCorpus({vault: {
      cachedRead: async () => {reads++; return text;},
      getAbstractFileByPath: path => byPath.get(path) ?? null,
    }});
    const release = corpus.retain();
    const start = performance.now();
    for (let i = 0; i < size; i += 6) {
      const batch = files.slice(i, i + 6);
      const bodies = await Promise.all(batch.flatMap(file =>
        [corpus.read(file), corpus.read(file), corpus.read(file), corpus.read(file)]));
      assert.ok(bodies.every(body => body === expected));
    }
    const ms = performance.now() - start;
    assert.equal(reads, size);
    assert.ok(files.every(file => corpus.peek(file) === expected));
    release(); corpus.onunload();
    assert.equal(e.timers.size, 0);
    return {ms, reads};
  }
  console.log('SEARCH_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    await sample(size);
    const samples = [];
    for (let i = 0; i < 5; i++) samples.push(await sample(size));
    console.log('SEARCH_RESULT ' + JSON.stringify({size, samples}));
  }
});

function corpusFixture() {
  const e = environment();
  const {FindCorpus} = e.load('findCorpus');
  const file = new e.TFile('Journal/2026-11-26.md');
  file.stat = {mtime: 1, size: 10};
  const files = new Map([[file.path, file]]);
  const pending = [];
  const corpus = new FindCorpus({vault: {
    getAbstractFileByPath: path => files.get(path) ?? null,
    cachedRead: target => new Promise((resolve, reject) => pending.push({target, resolve, reject})),
  }});
  const release = corpus.retain();
  return {e, corpus, file, files, pending, release};
}

test('overlapping corpus reads share work, and a failed read can be retried', async () => {
  const {corpus, file, pending, release, e} = corpusFixture();
  const first = corpus.read(file), second = corpus.read(file);
  assert.equal(pending.length, 1);
  pending[0].reject(new Error('read failed'));
  assert.equal(await first, null); assert.equal(await second, null);
  const retry = corpus.read(file);
  assert.equal(pending.length, 2);
  pending[1].resolve('---\r\na: b\r\n---\r\n# Title\r\nneedle 😀');
  assert.equal(await retry, '# Title\nneedle 😀');
  assert.equal(corpus.peek(file), '# Title\nneedle 😀');
  release(); corpus.onunload(); assert.equal(e.timers.size, 0);
});

test('a same-size edit starts a fresh read and late completion cannot replace it', async () => {
  const {corpus, file, pending} = corpusFixture();
  const old = corpus.read(file);
  corpus.invalidate(file, [file.path]);
  const fresh = corpus.read(file);
  assert.equal(pending.length, 2);
  pending[1].resolve('new body');
  assert.equal(await fresh, 'new body');
  pending[0].resolve('old body');
  assert.equal(await old, 'new body');
  assert.equal(corpus.peek(file), 'new body');
  assert.equal(pending.length, 2);
  corpus.onunload();
});

test('folder rename invalidates pending reads and deletion cannot resurrect a cache entry', async () => {
  const {corpus, file, files, pending} = corpusFixture();
  const oldPath = file.path;
  const old = corpus.read(file);
  files.delete(oldPath); file.path = 'Moved/2026-11-26.md'; files.set(file.path, file);
  corpus.invalidateFolder(['Journal', 'Moved']);
  const fresh = corpus.read(file);
  pending[1].resolve('new body');
  assert.equal(await fresh, 'new body');
  pending[0].resolve('old body');
  assert.equal(await old, 'new body');
  assert.equal(corpus.texts.has(oldPath), false);
  corpus.invalidate(file, [file.path]);
  const deleted = corpus.read(file);
  files.delete(file.path); corpus.invalidate(file, [file.path]);
  pending[2].resolve('deleted');
  assert.equal(await deleted, null);
  assert.equal(corpus.peek(file), null);
  corpus.onunload();
});

test('unloading the corpus clears outstanding reads without repopulating it', async () => {
  const {corpus, file, pending} = corpusFixture();
  const read = corpus.read(file);
  corpus.onunload();
  pending[0].resolve('late');
  assert.equal(await read, null);
  assert.equal(await corpus.read(file), null);
  assert.equal(corpus.pending.size, 0);
  assert.equal(corpus.peek(file), null);
});

test('a failed obsolete read cannot hide a newer successful result', async () => {
  const {corpus, file, pending} = corpusFixture();
  const old = corpus.read(file);
  corpus.invalidate(file, [file.path]);
  const fresh = corpus.read(file);
  pending[1].resolve('new body');
  assert.equal(await fresh, 'new body');
  pending[0].reject(new Error('old revision failed'));
  assert.equal(await old, 'new body');
  assert.equal(corpus.peek(file), 'new body');
  assert.equal(pending.length, 2);
  corpus.onunload();
});

test('repeated invalidation does not return stale search text after retry exhaustion', async () => {
  const {corpus, file, pending} = corpusFixture();
  const read = corpus.read(file);
  for (let i = 0; i < 3; i++) {
    assert.equal(pending.length, i + 1);
    corpus.invalidate(file, [file.path]);
    pending[i].resolve('obsolete ' + i);
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
  assert.equal(await read, null);
  assert.equal(corpus.peek(file), null);
  corpus.onunload();
});

test('closing a view while rebuild waits for saves cannot rebuild the closed tab', async () => {
  const e = environment(); const {JournalView} = e.load('view');
  const view = Object.create(JournalView.prototype); let finish; let builds = 0;
  Object.assign(view, {closed: false, epoch: 0, flushAll: () => new Promise(resolve => {finish = resolve}), teardown() {this.epoch++}, build: async () => {builds++}});
  const pending = view.rebuild(); view.closed = true; view.epoch++; finish(); await pending;
  assert.equal(builds, 0);
});

test('only the newest concurrent rebuild proceeds after delayed saves', async () => {
  const e = environment(); const {JournalView} = e.load('view');
  const view = Object.create(JournalView.prototype); const pending = []; const builds = [];
  Object.assign(view, {closed: false, epoch: 0, flushAll: () => new Promise(resolve => pending.push(resolve)), teardown() {this.epoch++}, build: async date => {builds.push(date)}});
  const first = view.rebuild('first'); const second = view.rebuild('second');
  pending[0](); pending[1](); await Promise.all([first, second]); assert.deepEqual(builds, ['second']);
});

test('benchmark alternate vocabulary forms across repeated month selections', {skip: process.env.JOURNAL_PERF !== '1'}, () => {
  const {NewWordsMosaic} = environment().load('newWords');
  const STEMS = 2000, WORDS = 100, SELECTIONS = 12;
  function sample(size, instrument) {
    const notes = [];
    const model = new Map();
    const first = new Map();
    let calls = 0;
    const statistics = {
      stemCount: STEMS, wordCount: STEMS * 3,
      stemOf(id) {if (instrument) calls++; return Math.floor(id / 3);},
      word(id) {return 'form-' + id;},
    };
    for (let n = 0; n < size; n++) {
      const ids = Uint32Array.from({length: WORDS}, (_, i) => ((n * 37 + i * 19) % STEMS) * 3 + ((n + i) % 3));
      notes.push({month: Math.floor(n / 30), vocabulary: {status: 'ready', ids}});
      for (const id of ids) {
        const stem = Math.floor(id / 3);
        if (!first.has(stem)) first.set(stem, id);
        else if (first.get(stem) !== id) {
          if (!model.has(stem)) model.set(stem, new Set());
          model.get(stem).add('form-' + id);
        }
      }
    }
    const mosaic = new NewWordsMosaic({}, {statistics});
    mosaic.notes = notes;
    mosaic.updateTiles = () => {};
    const startFold = performance.now();
    mosaic.advance();
    const foldMs = performance.now() - startFold;
    assert.equal(mosaic.frontier, size);
    assert.equal(mosaic.alternateSeen.length, 0);
    const foldLookups = calls;
    const queries = Array.from({length: SELECTIONS}, (_, i) =>
      new Set(Array.from({length: i % 3 === 0 ? 20 : i % 3 === 1 ? 100 : 300}, (_, j) => (i * 113 + j * 7) % STEMS)));
    const start = performance.now();
    const results = queries.map(query => mosaic.otherForms(query));
    const ms = performance.now() - start;
    for (let i = 0; i < queries.length; i++) {
      const actual = results[i], query = queries[i];
      assert.equal(actual.size, [...query].filter(stem => model.has(stem)).length);
      for (const stem of query) assert.deepEqual(Array.from(actual.get(stem) ?? []), Array.from(model.get(stem) ?? []));
    }
    if (instrument) assert.equal(calls - foldLookups, 0);
    return {ms, foldMs, foldLookups, selectionLookups: calls - foldLookups,
      alternateIds: mosaic.alternateForms ? [...mosaic.alternateForms.values()].reduce((n, ids) => n + ids.size, 0) : 0};
  }
  console.log('FORMS_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    sample(size, false);
    const samples = Array.from({length: 5}, () => sample(size, false));
    console.log('FORMS_RESULT ' + JSON.stringify({size, samples, operations: sample(size, true)}));
  }
});

test('alternate vocabulary forms follow the active chronological fold and disappear on refresh', async () => {
  const e = environment();
  const {NewWordsMosaic} = e.load('newWords');
  const a = new e.TFile('a.md'), b = new e.TFile('b.md'), c = new e.TFile('c.md');
  const first = '2026-01-01', next = '2026-02-01', last = '2026-03-01';
  const notes = new Map([[first, a], [next, b], [last, c]]);
  const vocab = new Map([[a, {status: 'ready', ids: Uint32Array.from([1, 3, 0])}],
    [b, {status: 'ready', ids: Uint32Array.from([2, 0, 4, 2])}], [c, {status: 'error'}]]);
  const stats = {stemCount: 2, wordCount: 6, stemOf: id => Math.floor(id / 3), word: id => 'form-' + id,
    peekVocabulary: file => vocab.get(file)};
  const plugin = {statistics: stats, daily: {config: () => ({})},
    index: {ensureCurrent() {}, keys: () => [...notes.keys()], pathsFor: key => [notes.get(key).path]},
    app: {vault: {getAbstractFileByPath: path => [...notes.values()].find(file => file.path === path)}}};
  const mosaic = new NewWordsMosaic({}, plugin);
  mosaic.renderGrid = () => {};
  mosaic.updateTiles = () => {};
  mosaic.status = {setText() {}};
  mosaic.renderWords = () => {};
  await mosaic.refresh();
  assert.equal(mosaic.frontier, 3);
  assert.equal(mosaic.form[0], 1);
  assert.equal(mosaic.uses[0], 2);
  assert.deepEqual(Array.from(mosaic.otherForms(new Set([0])).get(0)), ['form-0', 'form-2']);
  assert.deepEqual(Array.from(mosaic.otherForms(new Set([1])).get(1)), ['form-4']);
  notes.delete(first);
  await mosaic.refresh();
  assert.equal(mosaic.frontier, 2);
  assert.equal(mosaic.form[0], 2);
  assert.equal(mosaic.uses[0], 1);
  assert.deepEqual(Array.from(mosaic.otherForms(new Set([0])).get(0)), ['form-0']);
  assert.equal(mosaic.otherForms(new Set([1])).has(1), false);
  mosaic.onunload();
  assert.equal(mosaic.alternateForms.size, 0);
  assert.equal(mosaic.alternateSeen.length, 0);
  assert.equal(e.timers.size, 0);
});

test('temporary alternate ID marks grow across partially read vocabulary and are released', () => {
  const {NewWordsMosaic} = environment().load('newWords');
  const stats = {stemCount: 2, wordCount: 3, stemOf: id => id < 3 ? 0 : 1, word: id => 'form-' + id};
  const mosaic = new NewWordsMosaic({}, {statistics: stats});
  mosaic.updateTiles = () => {};
  mosaic.notes = [{month: 1, vocabulary: {status: 'ready', ids: Uint32Array.from([0, 1])}},
    {month: 2, vocabulary: null}];
  mosaic.advance();
  assert.equal(mosaic.frontier, 1);
  assert.ok(mosaic.alternateSeen.length >= 3);
  assert.equal(mosaic.alternateSeen[1], 1);
  stats.wordCount = 1202;
  mosaic.notes[1].vocabulary = {status: 'ready', ids: Uint32Array.from([1, 2, 1200, 1201])};
  mosaic.advance();
  assert.equal(mosaic.frontier, 2);
  assert.deepEqual(Array.from(mosaic.otherForms(new Set([0])).get(0)), ['form-1', 'form-2']);
  assert.deepEqual(Array.from(mosaic.otherForms(new Set([1])).get(1)), ['form-1201']);
  assert.equal(mosaic.alternateSeen.length, 0);
  mosaic.advance();
  assert.equal(mosaic.alternateSeen.length, 0);
});

test('failed embedded-editor initialization unloads its instance before fallback', () => {
  const e = environment(); const {RichEditor} = e.load('editor'); let destroyed = 0; let unloaded = 0;
  class BrokenEditor {get() {return ''} set() {} load() {throw new Error('load failed')} destroy() {destroyed++} unload() {unloaded++}}
  const options = {value: 'text', container: {empty() {}}, workspaceEditors: {update() {}}};
  assert.throws(() => new RichEditor(options, BrokenEditor), /load failed/);
  assert.equal(destroyed, 1); assert.equal(unloaded, 1);
});

test('failed editor-constructor probe still unloads its temporary embed', () => {
  const e = environment(); const {resolveEditorCtor} = e.load('editor'); let unloaded = 0;
  const app = {embedRegistry: {embedByExtension: {md: () => ({showEditor() {throw new Error('probe failed')}, unload() {unloaded++}})}}};
  assert.equal(resolveEditorCtor(app), null); assert.equal(unloaded, 1);
});

test('nearest-day traversal preserves sparse date order, missing anchors and ties in both directions', () => {
  const {keysAround} = environment().load('noteIndex');
  const keys = ['1999-12-31', '2000-01-01', '2000-02-28', '2000-02-29', '2000-03-01', '2000-03-02', '2026-11-25'];
  for (const key of ['1900-01-01', ...keys, '2000-02-27', '2000-03-03', '2050-01-01']) {
    for (const direction of [-1, 1]) {
      const expected = keys.filter(candidate => candidate !== key).sort((a, b) =>
        Math.abs(Date.parse(a) - Date.parse(key)) - Math.abs(Date.parse(b) - Date.parse(key)) ||
        direction * (Date.parse(b) - Date.parse(a)));
      assert.deepEqual(Array.from(keysAround(keys, key, direction)), expected);
    }
  }
  assert.deepEqual(Array.from(keysAround([], '2000-02-29', 1)), []);
});

test('folder configuration changes rebuild without retargeting dirty sections first', () => {
  const e = environment(); const {JournalView} = e.load('view');
  const view = Object.create(JournalView.prototype); let rebuilt = false;
  Object.assign(view, {ready: true, configSignature: 'old', plugin: {daily: {config: () => ({folder: 'new'})}},
    visibleDate: () => 'current day', rebuild: async date => {rebuilt = date === 'current day'},
    sections: [{revalidate() {throw new Error('must not retarget an unsaved editor')}}]});
  view.revalidatePaths(); assert.equal(rebuilt, true);
});

test('renaming a file updates its path mapping using the old stored path', () => {
  const e = environment(); const f = e.entryFixture('text'); let oldPath;
  f.entry.refreshState = () => {}; f.entry.host.onEntryFileChanged = (_entry, previous) => {oldPath = previous};
  f.entry.host.plugin = {daily: {pathFor: () => 'Journal/2026-09-12.md'}};
  f.entry.file.path = 'Journal/2026-09-13.md'; f.entry.setFile(f.entry.file);
  assert.equal(oldPath, 'Journal/2026-09-12.md'); assert.equal(f.entry.path, 'Journal/2026-09-13.md');
});

test('failed external editor replacement cannot overwrite the newer vault content', async () => {
  const e = environment(); const f = e.entryFixture('old editor text', 'new vault text');
  f.entry.editor.setValue = () => false;
  f.entry.host.plugin = {settings: {saveDelay: 2000}};
  f.entry.applyExternalContent('new vault text');
  assert.equal(f.entry.lastKnownEditorBody, 'old editor text');
  await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), 'new vault text'); assert.equal(f.writes(), 0);
  assert.equal(e.timers.size, 1);
});

test('benchmark vocabulary prose preparation across representative note types', {skip: process.env.JOURNAL_PERF !== '1'}, () => {
  const {proseOf} = environment().load('vocabulary');
  const plain = 'A quiet morning by the river. I walked home with a friend and cooked dinner. Café 中文 𐐀.\n'.repeat(12);
  const marked = '# Today\n\n> A quote\n> ordinary words.\n' +
    '> ~~~js\n> hidden code\n> ~~~\n\n    hidden indented code\n\n- a list item\n    nested prose\n' +
    'Words and \x60inline code\x60 plus [[hidden link]] and [ref]\n[ref]: https://example.com\n' +
    'mailto@example.com @name #tag\n' + plain;
  const cases = [
    ['plain', plain],
    ['markup', marked],
    ['email', plain + 'Reach out to person@example.com or @friend.\n'],
  ];
  function sample(size, body) {
    const notes = Array.from({length: size}, (_, i) => '---\nnumber: ' + i + '\n---\n' + body + 'Day ' + i);
    const expected = notes.map(proseOf);
    let length = 0;
    const start = performance.now();
    for (let i = 0; i < notes.length; i++) {
      const text = proseOf(notes[i]);
      assert.equal(text, expected[i]);
      length += text.length;
    }
    const ms = performance.now() - start;
    assert.ok(length > 0);
    return ms;
  }
  console.log('PROSE_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    for (const [kind, body] of cases) {
      sample(size, body);
      const samples = Array.from({length: 5}, () => sample(size, body));
      console.log('PROSE_RESULT ' + JSON.stringify({size, kind, samples}));
    }
  }
});

test('vocabulary email shortcut preserves whitespace and removes complete handle tokens', async () => {
  const {proseOf, noteWords} = environment().load('vocabulary');
  assert.equal(proseOf('plain café 中文\ttext'), 'plain café 中文\ttext');
  assert.equal(proseOf('before [[x@y]] after'), 'before   after');
  assert.equal(proseOf('---\nemail: a@example.com\n---\nplain words'), 'plain words');
  assert.equal(proseOf('before a@example.com @friend\tend'), 'before    \tend');
  assert.equal(proseOf('before\u00a0handle@中\u00a0after'), 'before\u00a0 \u00a0after');
  assert.deepEqual(Array.from(await noteWords('plain café foo@example.com @friend end', () => true)), ['plain', 'café', 'end']);
});

test('an unreadable editor survives teardown until its text can be captured', async () => {
  const e = environment(); const f = e.entryFixture('initial');
  const editor = f.entry.editor; editor.tryGetValue = () => null;
  f.entry.destroy(); assert.equal(f.entry.editor, editor); assert.equal(e.timers.size, 1);
  editor.tryGetValue = () => 'recovered final text';
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn(); await f.entry.queue.settled();
  assert.equal(f.files.get(f.entry.path), 'recovered final text');
  assert.equal(f.entry.editor, null); assert.equal(e.timers.size, 0);
});

test('a failed template insertion does not turn an untouched empty day into an edit', async () => {
  const e = environment(); const f = e.entryFixture('');
  f.entry.file = null;
  Object.defineProperty(f.entry, 'hasFocus', {value: true});
  f.entry.host.plugin = {daily: {creationMoment: () => f.entry.date, templateContent: async () => 'template body'}};
  f.entry.editor.setValue = () => false;
  await f.entry.offerTemplate(); await f.entry.flush();
  assert.equal(f.entry.pendingTemplate, null); assert.equal(f.writes(), 0);
});

test('typing before the template loads writes the intended note instead of a false conflict', async () => {
  const e = environment(); const f = e.entryFixture('');
  f.files.clear(); f.entry.file = null;
  f.entry.refreshState = () => {}; f.entry.host.onEntryFileChanged = () => {};
  f.entry.host.plugin = {daily: {createForEdit: async (_date, path) => {
    const content = '---\ntype: daily\n---\n# Heading\n\nTemplate body';
    f.files.set(path, content); return {file: new e.TFile(path), createdContent: content};
  }}};
  f.entry.hideDailyNoteH1 = true;
  f.type('fast typing'); await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), '---\ntype: daily\n---\n# Heading\n\nfast typing');
  assert.equal(f.files.size, 1); assert.equal(f.entry.saveConflict, false);
});

test('a concurrently created note is protected even when typing beats the template', async () => {
  const e = environment(); const f = e.entryFixture('');
  f.files.clear(); f.entry.file = null;
  f.entry.refreshState = () => {}; f.entry.host.onEntryFileChanged = () => {};
  f.entry.host.plugin = {daily: {createForEdit: async (_date, path) => {
    f.files.set(path, 'another writer'); return {file: new e.TFile(path), createdContent: null};
  }}};
  f.type('my writing'); await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), 'another writer');
  assert.equal(f.files.get(f.entry.conflictCopy.path), 'my writing');
});

test('saving hidden headings keeps concurrent frontmatter and title changes', async () => {
  const e = environment(); const f = e.entryFixture('body', '---\nmood: good\n---\n# Renamed title\n\nbody');
  f.entry.hiddenNotePrefix = '# Original title\n\n'; f.entry.hideDailyNoteH1 = true;
  f.type('new body'); await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), '---\nmood: good\n---\n# Renamed title\n\nnew body');
  assert.equal(f.entry.saveConflict, false);
});

test('conflict copy updates keep its frontmatter and hidden heading', async () => {
  const e = environment(); const f = e.entryFixture('body', '---\nmood: good\n---\n# Renamed title\n\nexternal body');
  f.entry.hiddenNotePrefix = '# Original title\n\n'; f.entry.hideDailyNoteH1 = true;
  f.type('journal body'); await f.entry.flush();
  f.type('further journal body'); await f.entry.flush();
  assert.equal(f.files.get(f.entry.conflictCopy.path), '---\nmood: good\n---\n# Renamed title\n\nfurther journal body');
  assert.equal(f.files.size, 2);
});

test('a write that reached disk before reporting failure retries without a false conflict', async () => {
  const e = environment(); const f = e.entryFixture('initial');
  const vault = f.entry.host.app.vault; const process = vault.process;
  vault.process = async (file, fn) => {
    vault.process = process;
    await process(file, fn); throw new Error('acknowledgement failed after writing');
  };
  f.type('final text'); await f.entry.flush();
  assert.equal(f.entry.queue.hasPending, true);
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn(); await f.entry.queue.settled();
  assert.equal(f.entry.queue.hasPending, false); assert.equal(f.files.size, 1);
  assert.equal(f.files.get(f.entry.path), 'final text'); assert.equal(f.entry.saveConflict, false);
});

function mountedHeightFixture() {
  const e = environment();
  const f = e.entryFixture('note body');
  const editor = f.entry.editor;
  let callbacks;
  let offscreen = false;
  let minimum = 0;
  e.load('editor').createJournalEditor = options => {
    callbacks = options;
    // Obsidian reports assigning the initial document during construction.
    options.onChange();
    return editor;
  };
  Object.assign(f.entry, {
    editor: null, modeToken: 0, heldHeight: 0,
    bodyEl: {offsetHeight: 320, empty() {}, setCssProps(props) {minimum = parseFloat(props['--journal-held-height'])}},
    el: {addClass() {}, removeClass() {}, toggleClass() {}},
    updateBlankState() {}, applyFindState() {}, scheduleFocusSettled() {},
  });
  f.entry.host.plugin = {settings: {richEditor: true, saveDelay: 2000}};
  f.entry.host.isOffScreen = () => offscreen;
  f.entry.host.onEntryContentChanged = () => {};
  f.entry.host.onEntryFocus = () => {};
  f.entry.host.onEntryFocusSettled = () => {};
  f.entry.host.onEntryFocusChanged = () => {};
  f.entry.mountEditor();
  return {...f, callbacks, minimum: () => minimum, setOffscreen: value => {offscreen = value}};
}

test('clicking a shorter visible editor keeps the following note at its preview position', () => {
  const f = mountedHeightFixture();
  // The preview is 320px high and its editor is 180px high. The following
  // note's layout position is the greater of content height and min-height.
  const followingTop = () => Math.max(180, f.minimum());
  assert.equal(followingTop(), 320, 'initial document callback must not clear the height');
  f.callbacks.onReady();
  assert.equal(followingTop(), 320, 'first measurement must not shrink a visible note');
  f.callbacks.onFocus();
  f.callbacks.onChange(); // an unchanged document notification is not an edit
  assert.equal(followingTop(), 320, 'focus must not shift the following note');
  assert.equal(f.writes(), 0);
});

test('a real text edit releases the retained preview height and still saves normally', async () => {
  const f = mountedHeightFixture();
  f.callbacks.onReady(); f.callbacks.onFocus();
  f.type('edited note body'); f.callbacks.onChange();
  assert.equal(f.minimum(), 0);
  await f.entry.flush();
  assert.equal(f.files.get(f.entry.path), 'edited note body');
});

test('an editor measured offscreen can adopt its natural height before the reader arrives', () => {
  const f = mountedHeightFixture();
  f.setOffscreen(true); f.callbacks.onReady();
  assert.equal(f.minimum(), 0);
});

test('returning an editor to preview mode clears its previous height hold', () => {
  const f = mountedHeightFixture();
  f.entry.bodyEl.appendChild = () => {};
  f.entry.applyPreview({component: {}, container: {}}, 'note body');
  assert.equal(f.minimum(), 0); assert.equal(f.entry.editor, null);
});

test('benchmark statistics word counting in synthetic notes', async () => {
  const e = environment();
  const {JournalStatistics} = e.load('statistics');
  const body = ('Hello world! 123 … -- café 中文 𐐀 mixed-token emoji😀  \t\n').repeat(24);
  const text = '---\nignored: words\n---\n' + body;
  const expected = body.split(/\s+/u).filter(token => /[\p{L}\p{N}]/u.test(token)).length;
  async function sample(size) {
    const files = new Map();
    for (let i = 0; i < size; i++) {
      const file = new e.TFile('Journal/' + i + '.md');
      file.stat = {mtime: 1, size: text.length};
      files.set(file.path, file);
    }
    let reads = 0;
    const stats = new JournalStatistics({vault: {
      cachedRead: async () => {reads++; return text;},
      getAbstractFileByPath: path => files.get(path),
    }});
    const start = performance.now();
    for (const file of files.values()) {
      const result = await stats.count(file, () => true);
      assert.equal(result?.status, 'ready');
      assert.equal(result.words, expected);
    }
    const ms = performance.now() - start;
    assert.equal(reads, size);
    stats.onunload();
    return {ms, reads};
  }
  console.log('COUNT_ENV ' + JSON.stringify({node: process.version, cpu: require('node:os').cpus()[0]?.model}));
  for (const size of [365, 2000, 10000]) {
    await sample(size);
    const samples = [];
    for (let i = 0; i < 5; i++) samples.push(await sample(size));
    console.log('COUNT_RESULT ' + JSON.stringify({size, samples}));
  }
});

test('statistics word counting preserves Unicode and whitespace across chunk boundaries', async () => {
  const e = environment();
  const {JournalStatistics} = e.load('statistics');
  const cases = [
    '!'.repeat(32767) + '𐐀 end',
    'a'.repeat(32768) + 'b end',
    'a'.repeat(32767) + ' ' + 'next',
    ' '.repeat(32768) + '😀  中文 123',
    '!'.repeat(65536) + ' end',
    ' \u00a0\u2028\ufeff ',
  ];
  for (const body of cases) {
    const text = '---\nignore: words\n---\n' + body;
    const file = new e.TFile('Journal/today.md');
    file.stat = {mtime: 1, size: text.length};
    const stats = new JournalStatistics({vault: {
      cachedRead: async () => text,
      getAbstractFileByPath: () => file,
    }});
    let finished = false;
    const pending = stats.count(file, () => true).finally(() => {finished = true;});
    for (let i = 0; i < 100 && !finished; i++) {
      await Promise.resolve();
      for (const [id, timer] of e.timers) {e.timers.delete(id); timer.fn();}
    }
    assert.ok(finished, 'count must settle after bounded timer yields');
    const result = await pending;
    assert.equal(result?.status, 'ready');
    assert.equal(result.words, body.split(/\s+/u).filter(token => /[\p{L}\p{N}]/u.test(token)).length);
    stats.onunload();
    assert.equal(e.timers.size, 0);
  }
});
