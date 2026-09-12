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
  class TFile {constructor(path) {this.path = path; this.extension = 'md'}}
  const obsidian = {
    TFile, AbstractInputSuggest: class {}, Component: class {}, FileView: class {},
    ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {},
    Notice: class {constructor(message) {notices.push(message)}},
    getFrontMatterInfo: text => {
      const match = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(text);
      return {contentStart: match?.[0].length ?? 0, exists: !!match};
    },
    getAllTags: cache => cache?.tags?.map(item => item.tag) ?? [], debounce: fn => fn,
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
      createDiv: () => ({}),
    }, {filename: file})(customRequire, module, module.exports);
    return module.exports;
  }
  function dayFixture(initial, diskInitial = initial) {
    const {DaySection} = load('day');
    const {SaveQueue} = load('saveQueue');
    const file = new TFile('Journal/2026-09-12.md');
    const files = new Map([[file.path, diskInitial]]);
    let editorText = initial;
    let writes = 0;
    const day = Object.create(DaySection.prototype);
    Object.assign(day, {
      file, path: file.path, lastKnownContent: initial, latestContent: diskInitial,
      lastKnownEditorBody: initial, hiddenNotePrefix: null, pendingTemplate: null,
      pendingTemplatePrefix: null, acceptedTemplateProjection: false, saveConflict: false,
      conflictCopy: null, conflictBody: null, saveFailureNotified: false, captureRetryTimer: 0,
      destroyed: false, externalReloadPending: false, metadataWrites: Promise.resolve(),
      readToken: 0, contentReady: true, loadingContent: false,
      editor: {getValue: () => editorText, tryGetValue: () => editorText, destroy() {}, setFile() {}},
      refreshMetadata(content) {this.latestContent = content},
      host: {app: {vault: {
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
      clearFindState() {}, stopRevealing() {}, el: {remove() {}}, bodyEl: {empty() {}}, focusSettleToken: 0,
    });
    day.queue = new SaveQueue(value => day.writeValue(value));
    return {day, files, writes: () => writes, type: text => {editorText = text}};
  }
  return {load, notices, timers, clock, TFile, dayFixture};
}

test('later edits keep saving to the conflict copy without overwriting the original', async () => {
  const e = environment(); const f = e.dayFixture('original', 'external edit');
  f.type('journal edit'); await f.day.flush();
  const copy = f.day.conflictCopy;
  assert.ok(copy);
  f.type('journal edit plus later words'); await f.day.flush();
  f.day.destroy(); await f.day.queue.settled();
  assert.equal(f.files.get(f.day.path), 'external edit');
  assert.equal(f.files.get(copy.path), 'journal edit plus later words');
  assert.equal(f.files.size, 2);
  assert.equal(e.timers.size, 0);
});

test('editing a conflict copy elsewhere saves further journal edits to another copy', async () => {
  const e = environment(); const f = e.dayFixture('original', 'external edit');
  f.type('journal edit'); await f.day.flush();
  const firstCopy = f.day.conflictCopy.path;
  f.files.set(firstCopy, 'edited recovery elsewhere');
  f.type('more journal text'); await f.day.flush();
  assert.equal(f.files.get(firstCopy), 'edited recovery elsewhere');
  assert.equal(f.files.get(f.day.conflictCopy.path), 'more journal text');
  assert.notEqual(firstCopy, f.day.conflictCopy.path);
});

test('a failed internal editor read never saves an empty body and retries capture', async () => {
  const e = environment(); const f = e.dayFixture('valuable note body');
  const {RichEditor} = e.load('editor');
  const editor = Object.create(RichEditor.prototype);
  editor.lastReadableValue = 'valuable note body';
  editor.instance = {get() {throw new Error('internal API failure')}};
  f.day.editor = editor;
  await f.day.flush();
  assert.equal(f.files.get(f.day.path), 'valuable note body');
  assert.equal(f.writes(), 0);
  assert.equal(editor.getValue(), 'valuable note body');
  assert.equal(e.timers.size, 1);
  editor.instance.get = () => 'recovered editor text';
  await f.day.flush();
  assert.equal(f.files.get(f.day.path), 'recovered editor text');
  assert.equal(e.timers.size, 0);
});

test('editor document supplies current text when its convenience getter breaks', () => {
  const e = environment(); const {RichEditor} = e.load('editor');
  const editor = Object.create(RichEditor.prototype);
  editor.instance = {get() {throw new Error('getter failed')}, editor: {cm: {state: {doc: {toString: () => 'current document'}}}}};
  assert.equal(editor.tryGetValue(), 'current document');
});

test('failed teardown writes retry automatically and release their timer after recovery', async () => {
  const e = environment(); const f = e.dayFixture('original');
  const vault = f.day.host.app.vault; const process = vault.process;
  vault.process = async () => {throw new Error('disk unavailable')};
  f.type('unsaved text'); f.day.destroy(); await f.day.queue.settled();
  assert.equal(f.day.editor, null); assert.equal(f.day.queue.hasPending, true);
  assert.equal(e.timers.size, 1);
  vault.process = process;
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn();
  await f.day.queue.settled();
  assert.equal(f.files.get(f.day.path), 'unsaved text');
  assert.equal(f.day.queue.hasPending, false); assert.equal(e.timers.size, 0);
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
  const e = environment(); const f = e.dayFixture('original');
  const vault = f.day.host.app.vault; const process = vault.process;
  let finish; let started;
  const ready = new Promise(resolve => {started = resolve});
  vault.process = async (file, fn) => {
    vault.process = process;
    started(); await new Promise(resolve => {finish = resolve});
    return process(file, fn);
  };
  f.type('temporary edit'); const saving = f.day.flush(); await ready;
  f.type('original'); const undoing = f.day.flush(); finish();
  await Promise.all([saving, undoing]);
  assert.equal(f.files.get(f.day.path), 'original'); assert.equal(f.day.isDirty, false);
});

test('cancelled search cannot navigate after an outstanding read returns', async () => {
  const e = environment(); const {JournalFind} = e.load('find');
  let finishRead; let navigations = 0;
  const find = Object.create(JournalFind.prototype);
  Object.assign(find, {
    input: {value: 'needle'}, open: true, scanToken: 0, caseSensitive: false,
    countEl: {setText() {}}, updateButtons() {},
    host: {sections: [{key: '2026-09-12'}], sortStep: () => 1,
      plugin: {settings: {hideEmptyDays: true}, filteredIndex: {ensureCurrent() {}, keysFrom: () => ['2026-09-13']}, daily: {fileFor: () => new e.TFile('test.md')}},
      app: {vault: {cachedRead: () => new Promise(resolve => {finishRead = resolve})}},
      loadFindDate: async () => {navigations++},
    },
  });
  const operation = find.scanBeyond(1); find.cancelScan(); find.open = false;
  finishRead('needle'); await operation; assert.equal(navigations, 0);
});

test('unfiltered index delegates navigation without duplicate scans or membership', () => {
  const e = environment(); const {FilteredDailyNoteIndex} = e.load('filter');
  let scans = 0;
  const keys = ['2026-01-01', '2026-01-03'];
  const base = {version: 1, ensureCurrent() {}, size: 2, has: key => keys.includes(key),
    range: () => ({first: keys[0], last: keys[1]}), next: () => keys[1], prev: () => keys[0], keysFrom: () => keys};
  const index = new FilteredDailyNoteIndex({vault: {getMarkdownFiles() {scans++; return []}}}, base, () => []);
  index.ensureCurrent(); base.version++; index.ensureCurrent();
  assert.equal(index.has(keys[0]), true); assert.equal(index.size, 2);
  assert.deepEqual(index.range(), base.range()); assert.equal(index.next(keys[0]), keys[1]);
  assert.equal(index.prev(keys[1]), keys[0]); assert.deepEqual(index.keysFrom(keys[0], 1), keys);
  assert.equal(scans, 0);
  for (const collection of ['keys', 'matchingPaths', 'pathKeys', 'matchingCounts']) assert.equal(index[collection].size, 0);
});

test('turning filters on and off still returns the correct dates and frees filter storage', () => {
  const e = environment(); const {FilteredDailyNoteIndex} = e.load('filter');
  const files = [new e.TFile('one'), new e.TFile('two')];
  let rules = [];
  const base = {version: 1, ensureCurrent() {}, resolvedConfig: () => ({}), keyForPath: path => path, has: () => true, size: 2};
  const index = new FilteredDailyNoteIndex({vault: {getMarkdownFiles: () => files}, metadataCache: {getFileCache: file => ({tags: [{tag: file.path === 'one' ? '#yes' : '#no'}]})}}, base, () => rules);
  index.ensureCurrent(); assert.equal(index.size, 2);
  rules = [{kind: 'tag', mode: 'include', tag: 'yes'}]; index.ensureCurrent();
  assert.equal(index.size, 1); assert.equal(index.has('one'), true); assert.equal(index.has('two'), false);
  rules = []; index.ensureCurrent(); assert.equal(index.size, 2); assert.equal(index.pathKeys.size, 0);
});

test('literal existence checks match full search semantics including Unicode and punctuation', () => {
  const e = environment(); const {containsLiteral, findLiteralRanges} = e.load('findText');
  for (const [text, query] of [['a[b a[b', 'a[b'], ['Kelvin K', 'k'], ['😀😀', '😀'], ['none', ''], ['Straße', 'SS'], ['A\na', 'a']]) {
    for (const sensitive of [true, false]) assert.equal(containsLiteral(text, query, sensitive), findLiteralRanges(text, query, sensitive).length > 0);
  }
});

test('a late read cannot replace newer content from a metadata event', async () => {
  const e = environment(); const f = e.dayFixture('old');
  f.day.editor = null; f.day.renderPreview = async () => {}; f.day.host.onDayContentChanged = () => {};
  let finish; f.day.host.app.vault.cachedRead = () => new Promise(resolve => {finish = resolve});
  const stale = f.day.reload(); await f.day.reload('new external content'); finish('stale content'); await stale;
  assert.equal(f.day.lastKnownContent, 'new external content');
});

test('a failed vault read leaves existing content intact', async () => {
  const e = environment(); const f = e.dayFixture('existing note');
  f.day.host.app.vault.cachedRead = async () => {throw new Error('read failed')};
  await f.day.reload(); assert.equal(f.day.lastKnownContent, 'existing note');
  assert.equal(f.day.editor.getValue(), 'existing note');
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

test('folder configuration changes rebuild without retargeting dirty sections first', () => {
  const e = environment(); const {JournalView} = e.load('view');
  const view = Object.create(JournalView.prototype); let rebuilt = false;
  Object.assign(view, {ready: true, configSignature: 'old', plugin: {daily: {config: () => ({folder: 'new'})}},
    visibleDate: () => 'current day', rebuild: async date => {rebuilt = date === 'current day'},
    sections: [{revalidate() {throw new Error('must not retarget an unsaved editor')}}]});
  view.revalidatePaths(); assert.equal(rebuilt, true);
});

test('renaming a file updates its path mapping using the old stored path', () => {
  const e = environment(); const f = e.dayFixture('text'); let oldPath;
  f.day.refreshState = () => {}; f.day.host.onDayFileChanged = (_day, previous) => {oldPath = previous};
  f.day.file.path = 'Journal/2026-09-13.md'; f.day.setFile(f.day.file);
  assert.equal(oldPath, 'Journal/2026-09-12.md'); assert.equal(f.day.path, 'Journal/2026-09-13.md');
});

test('failed external editor replacement cannot overwrite the newer vault content', async () => {
  const e = environment(); const f = e.dayFixture('old editor text', 'new vault text');
  f.day.editor.setValue = () => false;
  f.day.host.plugin = {settings: {saveDelay: 2000}};
  f.day.applyExternalContent('new vault text');
  assert.equal(f.day.lastKnownEditorBody, 'old editor text');
  await f.day.flush();
  assert.equal(f.files.get(f.day.path), 'new vault text'); assert.equal(f.writes(), 0);
  assert.equal(e.timers.size, 1);
});

test('an unreadable editor survives teardown until its text can be captured', async () => {
  const e = environment(); const f = e.dayFixture('initial');
  const editor = f.day.editor; editor.tryGetValue = () => null;
  f.day.destroy(); assert.equal(f.day.editor, editor); assert.equal(e.timers.size, 1);
  editor.tryGetValue = () => 'recovered final text';
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn(); await f.day.queue.settled();
  assert.equal(f.files.get(f.day.path), 'recovered final text');
  assert.equal(f.day.editor, null); assert.equal(e.timers.size, 0);
});

test('a failed template insertion does not turn an untouched empty day into an edit', async () => {
  const e = environment(); const f = e.dayFixture('');
  f.day.file = null;
  Object.defineProperty(f.day, 'hasFocus', {value: true});
  f.day.host.plugin = {daily: {templateContent: async () => 'template body'}};
  f.day.editor.setValue = () => false;
  await f.day.offerTemplate(); await f.day.flush();
  assert.equal(f.day.pendingTemplate, null); assert.equal(f.writes(), 0);
});

test('typing before the template loads writes the intended note instead of a false conflict', async () => {
  const e = environment(); const f = e.dayFixture('');
  f.files.clear(); f.day.file = null;
  f.day.refreshState = () => {}; f.day.host.onDayFileChanged = () => {};
  f.day.host.plugin = {daily: {createForEdit: async (_date, path) => {
    const content = '---\ntype: daily\n---\n# Heading\n\nTemplate body';
    f.files.set(path, content); return {file: new e.TFile(path), createdContent: content};
  }}};
  f.day.hideDailyNoteH1 = true;
  f.type('fast typing'); await f.day.flush();
  assert.equal(f.files.get(f.day.path), '---\ntype: daily\n---\n# Heading\n\nfast typing');
  assert.equal(f.files.size, 1); assert.equal(f.day.saveConflict, false);
});

test('a concurrently created note is protected even when typing beats the template', async () => {
  const e = environment(); const f = e.dayFixture('');
  f.files.clear(); f.day.file = null;
  f.day.refreshState = () => {}; f.day.host.onDayFileChanged = () => {};
  f.day.host.plugin = {daily: {createForEdit: async (_date, path) => {
    f.files.set(path, 'another writer'); return {file: new e.TFile(path), createdContent: null};
  }}};
  f.type('my writing'); await f.day.flush();
  assert.equal(f.files.get(f.day.path), 'another writer');
  assert.equal(f.files.get(f.day.conflictCopy.path), 'my writing');
});

test('saving hidden headings keeps concurrent frontmatter and title changes', async () => {
  const e = environment(); const f = e.dayFixture('body', '---\nmood: good\n---\n# Renamed title\n\nbody');
  f.day.hiddenNotePrefix = '# Original title\n\n'; f.day.hideDailyNoteH1 = true;
  f.type('new body'); await f.day.flush();
  assert.equal(f.files.get(f.day.path), '---\nmood: good\n---\n# Renamed title\n\nnew body');
  assert.equal(f.day.saveConflict, false);
});

test('conflict copy updates keep its frontmatter and hidden heading', async () => {
  const e = environment(); const f = e.dayFixture('body', '---\nmood: good\n---\n# Renamed title\n\nexternal body');
  f.day.hiddenNotePrefix = '# Original title\n\n'; f.day.hideDailyNoteH1 = true;
  f.type('journal body'); await f.day.flush();
  f.type('further journal body'); await f.day.flush();
  assert.equal(f.files.get(f.day.conflictCopy.path), '---\nmood: good\n---\n# Renamed title\n\nfurther journal body');
  assert.equal(f.files.size, 2);
});

test('a write that reached disk before reporting failure retries without a false conflict', async () => {
  const e = environment(); const f = e.dayFixture('initial');
  const vault = f.day.host.app.vault; const process = vault.process;
  vault.process = async (file, fn) => {
    vault.process = process;
    await process(file, fn); throw new Error('acknowledgement failed after writing');
  };
  f.type('final text'); await f.day.flush();
  assert.equal(f.day.queue.hasPending, true);
  const [id, timer] = [...e.timers][0]; e.timers.delete(id); timer.fn(); await f.day.queue.settled();
  assert.equal(f.day.queue.hasPending, false); assert.equal(f.files.size, 1);
  assert.equal(f.files.get(f.day.path), 'final text'); assert.equal(f.day.saveConflict, false);
});
