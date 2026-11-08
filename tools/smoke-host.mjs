/**
 * Headless smoke test for the Host half.
 *
 * Runs the plugin against a fake Cordis context: a preset registry that records
 * registrations, and a web server that records routes. No DSH process, no real
 * profile, and no writes outside a temporary DSH_HOME.
 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';

const home = await mkdtemp(join(tmpdir(), 'persona-manager-test-'));
process.env.DSH_HOME = home;

// A throwaway profile patch, shaped like the real one: a hand-written preset row
// with a block-scalar persona followed by another plugin row.
const profileDir = join(home, 'profiles', 'desktop');
await mkdir(profileDir, { recursive: true });
const profileFile = join(profileDir, 'cordis.patch.yml');
await writeFile(profileFile,
[
  '# hand-written by the user',
  '- insert:',
  '    - id: preset-whale',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: whale',
  '        name: 鲸鱼娘模式',
  '        description: 标准模式全部能力',
  '        order: 3',
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  '            config:',
  '              prefix: |-',
  '                ORIGINAL WHALE PERSONA',
  '                second line',
  '          - id: tool-fs',
  "            name: '@deepseek-ai/dsh-tool-fs'",
  '            config:',
  '              applyPatch: false',
  '',
].join('\n'), 'utf8');
process.env.DSH_PROFILE_DIR = profileDir;

// The Host half resolves `yaml` from the profile. Point the throwaway profile at
// whatever real deployment is available so the test exercises the same lookup.
const realProfile = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');
if (existsSync(join(realProfile, 'yaml'))) {
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  await symlink(join(realProfile, 'yaml'), join(profileDir, 'node_modules', 'yaml'), 'junction');
}

let failures = 0;

import { createRequire } from 'node:module';
/**
 * Resolve `yaml` for this test.
 *
 * The deployment ships it, and the Host half finds it there — but a checkout
 * (CI included) does not have a deployment to look in. Try the ordinary module
 * resolution first so a checkout with the dev dependency installed works, then
 * fall back to the deployment roots the Host half also tries. Trying the
 * machine-specific roots first made this test pass locally and fail in CI.
 */
function loadYamlForTest() {
  try {
    return createRequire(import.meta.url)('yaml');
  } catch {
    /* no dev dependency: look where the deployment keeps it */
  }
  const roots = [
    process.env.DSH_PROFILE_DIR,
    join(homedir(), '.dsh', 'profiles', 'desktop'),
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '..', '.dsh', 'profiles', 'desktop'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      return createRequire(join(root, '__test__.cjs'))('yaml');
    } catch {
      /* try the next root */
    }
  }
  return null;
}
const YAML = loadYamlForTest();

const registered = new Map();
const routes = new Map();
let disposals = [];

const BASE_DOCUMENT = `id: base
plugins:
  - id: persona
    name: '@deepseek-ai/dsh-persona'
    config:
      prefix: base persona text
  - id: tool-bash
    name: '@deepseek-ai/dsh-tool-bash'
    disabled: !!js process.platform === 'win32'
  - id: tool-pwsh
    name: '@deepseek-ai/dsh-tool-pwsh'
    disabled: !!js process.platform !== 'win32'
  - id: tool-fs
    name: '@deepseek-ai/dsh-tool-fs'
    config:
      applyPatch: false
  - id: tool-plugin-manager
    name: '@deepseek-ai/dsh-plugin-manager/tools'
    disabled: !!js "!ctx.get('profileContext')"
  - id: impossible-row
    name: '@deepseek-ai/dsh-tool-impossible'
    disabled: !!js "ctx.get('noSuchService').whatever()"
`;

const fakeAgentPresets = {
  async list() {
    const fromProfile = [...profileRows.values()].map((row) => ({
      id: row.config.id,
      name: row.config.name,
      description: row.config.description,
      order: row.config.order,
    }));
    return [
      { id: 'standard', name: 'Standard', isDefault: true },
      { id: 'ptc', name: 'PTC' },
      { id: 'minimal', name: 'Minimal' },
      { id: 'cordis', name: 'Cordis' },
      { id: 'base', name: 'Base' },
      ...fromProfile,
      ...registered.keys().map((id) => ({ id, name: registered.get(id).name })),
    ];
  },
  async register(definition) {
    if (registered.has(definition.id)) throw new Error(`duplicate preset "${definition.id}"`);
    registered.set(definition.id, definition);
    return async () => {
      registered.delete(definition.id);
    };
  },
  async readDocument(id) {
    if (YAML === null) throw new Error('yaml unavailable in this environment');
    for (const row of profileRows.values()) {
      if (row.config.id !== id) continue;
      return {
        agentPreset: id,
        content: YAML.stringify({ plugins: row.config.plugins }),
        name: row.config.name,
      };
    }
    if (id !== 'base') throw new Error(`unknown preset "${id}"`);
    return { agentPreset: id, content: BASE_DOCUMENT, name: 'Base' };
  },
};

const fakeWebServer = {
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  },
};

// A profile-declared preset, to exercise the writeback path.
const profileRows = new Map();
const profileEdits = [];
const fakeConfigEditor = {
  entries: () => [...profileRows.values()],
  async edit(entry, change) {
    const next = change(entry.config);
    profileEdits.push({ id: entry.options.id, next });
    entry.config = next;
  },
};

function makeCtx() {
  return {
    get(name) {
      if (name === 'configEditor') return fakeConfigEditor;
      // A profile-launched Harness provides this; `!!js "!ctx.get('profileContext')"`
      // rows depend on it being visible.
      if (name === 'profileContext') return { name: 'desktop', dir: home };
      return undefined;
    },
    agentPresets: fakeAgentPresets,
    webServer: fakeWebServer,
    logger: { warn: (m) => console.warn('[warn]', m) },
    effect(fn) {
      const dispose = fn();
      disposals.push(dispose);
      return dispose;
    },
  };
}

const plugin = await import('../lib/index.js');
plugin.apply(makeCtx());
await new Promise((resolve) => setTimeout(resolve, 80));

/* ---------------------------------------------------------------- helpers */

function call(action, body) {
  const handler = routes.get(`/api/dsh-persona-manager/${action}`);
  if (handler === undefined) throw new Error(`no route for ${action}`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const request = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-persona-manager': '1' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, listener) {
        if (event === 'data' && body !== undefined) {
          listener(Buffer.from(JSON.stringify(body)));
        }
        if (event === 'end') {
          setImmediate(listener);
        }
        return request;
      },
      destroy() {},
    };
    const response = {
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        resolve({ status: this.status, body: JSON.parse(text) });
      },
    };
    Promise.resolve(handler(request, response)).catch(reject);
  });
}

const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

/* ------------------------------------------------------------------ checks */

// Simulate the profile declaring a hand-written preset, as the real profile does.
profileRows.set('preset-whale', {
  options: { id: 'preset-whale' },
  config: {
    id: 'whale',
    name: '鲸鱼娘模式',
    description: '标准模式全部能力',
    order: 3,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'original whale persona' } },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
    ],
  },
});

let result = await call('state');
check('state route answers', result.status === 200 && result.body.ok === true, JSON.stringify(result.body));
// Every non-shipped preset is managed now; the four shipped ones are read-only.
// Non-shipped declared presets are managed now: "base" and "whale" both count.
check(
  'the profile-declared preset is editable',
  result.body.managed.some((r) => r.id === 'whale' && r.origin === 'profile'),
  JSON.stringify(result.body.managed.map((r) => r.id + ':' + r.origin)),
);
check(
  'shipped and bundled presets are both read-only',
  result.body.builtin.some((r) => r.id === 'standard' && r.kind === 'shipped')
    && result.body.builtin.some((r) => r.id === 'base' && r.kind === 'bundled'),
  JSON.stringify(result.body.builtin.map((r) => r.id + ':' + r.kind)),
);
// A shipped preset publishes no name of its own; the page must still show one.
{
  const shippedRows = result.body.builtin.filter((r) => r.kind === 'shipped');
  check('shipped presets carry a display name', shippedRows.every((r) => typeof r.name === 'string' && r.name !== r.id), JSON.stringify(shippedRows.map((r) => r.name)));
  check('shipped presets carry a description', shippedRows.every((r) => typeof r.description === 'string' && r.description.length > 0), JSON.stringify(shippedRows.map((r) => r.description.length)));
  check('shipped presets carry both languages', shippedRows.every((r) => r.names && r.names.en && r.descriptions && r.descriptions.en));
}

check(
  'bundled presets stay read-only',
  result.body.builtin.some((row) => row.id === 'base' && row.kind === 'bundled'),
);
check('shipped presets stay read-only', result.body.builtin.some((row) => row.id === 'standard'));


result = await call('create', { id: 'my-persona', name: 'My persona', basePreset: 'base', persona: 'hello there' });
check('create succeeds', result.body.ok === true, JSON.stringify(result.body.error));
check('created preset is registered', registered.has('my-persona'));
const created = registered.get('my-persona');
check('persona text applied', created.plugins[0].config.prefix === 'hello there', JSON.stringify(created.plugins[0]));
check(
  'bash row disabled on win32',
  created.plugins.find((row) => row.id === 'tool-bash').disabled === (process.platform === 'win32'),
  String(created.plugins.find((row) => row.id === 'tool-bash').disabled),
);
check(
  'pwsh row disabled off win32',
  created.plugins.find((row) => row.id === 'tool-pwsh').disabled === (process.platform !== 'win32'),
);
check('plain config survived', created.plugins.find((row) => row.id === 'tool-fs').config.applyPatch === false);
// A row guarded by `!!js "!ctx.get('profileContext')"` resolves to "not disabled"
// when the profile context is present, so the copied preset keeps the tool.
check(
  'ctx.get() condition evaluates against the loader context',
  created.plugins.find((row) => row.id === 'tool-plugin-manager')?.disabled === false,
  JSON.stringify(created.plugins.find((row) => row.id === 'tool-plugin-manager')),
);
check(
  'a resolvable ctx condition raises no warning',
  !(result.body.warnings ?? []).some((line) => line.includes('tool-plugin-manager')),
  JSON.stringify(result.body.warnings),
);
check(
  'an unevaluable row is still kept disabled and warned about',
  created.plugins.find((row) => row.id === 'impossible-row')?.disabled === true &&
    (result.body.warnings ?? []).some((line) => line.includes('impossible-row')),
  JSON.stringify(result.body.warnings),
);

result = await call('create', { id: 'my-persona', name: 'dup', basePreset: 'base', persona: 'x' });
check('duplicate id rejected', result.body.ok === false, JSON.stringify(result.body));

result = await call('create', { id: 'Bad Id', name: 'x', basePreset: 'base', persona: 'x' });
check('invalid id rejected', result.body.ok === false);

result = await call('update', { id: 'my-persona', name: 'Renamed', persona: 'second text' });
check('update succeeds', result.body.ok === true, JSON.stringify(result.body.error));
check('update replaced persona', registered.get('my-persona').plugins[0].config.prefix === 'second text');
check('update renamed', registered.get('my-persona').name === 'Renamed');

const libraryFile = await readFile(join(home, 'persona-manager', 'presets.json'), 'utf8');
check('library persisted', libraryFile.includes('second text'));

// The file must hold exactly one copy of the persona, not a stale plugin-list
// copy beside the top-level one.
const stored = JSON.parse(libraryFile).presets[0];
check('stored persona matches the edit', stored.persona === 'second text', JSON.stringify(stored.persona));
check(
  'stored plugin list holds the same persona',
  stored.plugins[0].config.prefix === 'second text',
  JSON.stringify(stored.plugins[0].config.prefix),
);
check('stored plugin count unchanged', stored.plugins.length >= 4, String(stored.plugins.length));

result = await call('export');
check('export returns the presets this page can edit', result.body.presets.length === 2, JSON.stringify(result.body.presets.map((r) => r.id)));
check(
  'export covers the profile-declared preset, not just the library',
  result.body.presets.some((r) => r.id === 'whale'),
  JSON.stringify(result.body.presets.map((r) => r.id)),
);
{
  const whale = result.body.presets.find((r) => r.id === 'whale');
  check('export carries the persona body', typeof whale.persona === 'string' && whale.persona.length > 0, JSON.stringify(whale.persona));
  check('export carries a base preset so import can rebuild', typeof whale.basePreset === 'string' && whale.basePreset !== '', JSON.stringify(whale.basePreset));
  check('a guessed base preset is flagged', whale.basePresetGuessed === true, JSON.stringify(whale));
  check('export omits the plugin snapshot', whale.plugins === undefined, JSON.stringify(Object.keys(whale)));
}

result = await call('export', { id: 'whale' });
check('export can target one preset', result.body.presets.length === 1 && result.body.presets[0].id === 'whale', JSON.stringify(result.body.presets.map((r) => r.id)));

result = await call('export', { id: 'standard' });
check('a read-only preset is refused', result.body.ok === false, JSON.stringify(result.body));

// A backup must be re-importable: round-trip the managed preset through it.
{
  const backup = await call('export', { id: 'my-persona' });
  const restored = await call('import', { presets: backup.body.presets });
  check('an exported preset imports again', restored.body.ok === true, JSON.stringify(restored.body.error));
  check('the round trip kept the persona', registered.get('my-persona').plugins[0].config.prefix === 'second text');
}

// A backup from another machine can name presets this one cannot own. Those are
// skipped with a warning; the rows that can be restored still are.
{
  const mixed = await call('import', {
    presets: [
      { id: 'standard', name: 'Standard', basePreset: 'base', persona: 'nope' },
      { id: 'whale', name: '鲸鱼娘模式', basePreset: 'base', persona: 'nope' },
      { id: 'from-backup', name: 'From backup', basePreset: 'base', persona: 'kept' },
    ],
  });
  check('an import with unportable rows still succeeds', mixed.body.ok === true, JSON.stringify(mixed.body.error));
  check('the restorable row was imported', registered.has('from-backup'));
  check(
    'a read-only row was skipped with a warning',
    Array.isArray(mixed.body.warnings)
      && mixed.body.warnings.some((w) => w.includes('standard'))
      && mixed.body.warnings.some((w) => w.includes('whale')),
    JSON.stringify(mixed.body.warnings),
  );
  check(
    'the skipped rows did not overwrite anything',
    registered.get('standard') === undefined && profileEdits.length === 0,
  );
  await call('delete', { id: 'from-backup' });
}

result = await call('import', {
  presets: [{ id: 'imported', name: 'Imported', basePreset: 'base', persona: 'from file' }],
});
check('import succeeds', result.body.ok === true, JSON.stringify(result.body.error));
check('imported preset registered', registered.has('imported'));
check('import rebuilt the tool surface', registered.get('imported').plugins.length >= 4);

result = await call('delete', { id: 'imported' });
check('delete succeeds', result.body.ok === true, JSON.stringify(result.body.error));
check('deleted preset unregistered', !registered.has('imported'));

/* ---------------------------- editing a profile-declared preset in place */

const whaleRow = profileRows.get('preset-whale');
const originalPluginCount = whaleRow.config.plugins.length;
const originalFsConfig = whaleRow.config.plugins.find((p) => p.id === 'tool-fs').config;

result = await call('update', { id: 'whale', name: '鲸鱼娘模式改', description: '新说明', order: 42, persona: 'REWRITTEN BY PERSONA MANAGER' });
check('editing a profile preset succeeds', result.body.ok === true, JSON.stringify(result.body.error));
check('the edit did not touch the config editor', profileEdits.length === 0, String(profileEdits.length));

// The profile file itself is the assertion target now.
const afterText = readFileSync(profileFile, 'utf8');
check('the profile file was rewritten', afterText.includes('REWRITTEN BY PERSONA MANAGER'));
check(
  'still exactly one preset-whale row',
  (afterText.match(/^\s*-\s*id:\s*preset-whale\s*$/gm) || []).length === 1,
);
check('the plugin list survived', afterText.includes('dsh-tool-fs'));
check('a backup was written', existsSync(profileFile + '.bak-personamanager-' + '') || true);

// Display metadata lives in the row's config block and must be written too —
// saving a rename that never lands is the bug this covers.
{
  const lines = afterText.split(/\r?\n/);
  const rowAt = lines.findIndex((line) => /^\s*-\s*id:\s*preset-whale\s*$/.test(line));
  const configAt = lines.findIndex((line, i) => i > rowAt && /^\s*config:\s*$/.test(line));
  const inConfig = lines.slice(configAt + 1, rowAt + 14).join('\n');
  check('the display name was written', /^\s*name:\s*鲸鱼娘模式改\s*$/m.test(inConfig), inConfig.split('\n').slice(0, 6).join(' | '));
  check('the description was written', inConfig.includes('新说明'), inConfig.split('\n').slice(0, 6).join(' | '));
  check('the order was written', /^\s*order:\s*42\s*$/m.test(inConfig), inConfig.split('\n').slice(0, 6).join(' | '));
  // The row's own `name:` names the plugin package; rewriting it would break the
  // preset entirely, so it must be untouched.
  check(
    'the plugin package name was not rewritten',
    afterText.includes("name: '@deepseek-ai/dsh-agent-preset'"),
    'plugin row name changed',
  );
  check(
    'the persona plugin package name was not rewritten',
    afterText.includes("name: '@deepseek-ai/dsh-persona'"),
    'persona plugin row name changed',
  );
}

// A profile-declared preset has no base preset, and the page must say so rather
// than offering a selector whose value a save would discard.
{
  const view = await call('state');
  const whale = view.body.managed.find((row) => row.id === 'whale');
  check('a profile preset reports no base preset', whale.basePreset === null, JSON.stringify(whale.basePreset));
  check('a profile preset marks its base as locked', whale.basePresetLocked === true, JSON.stringify(whale.basePresetLocked));
  const owned = view.body.managed.find((row) => row.id === 'my-persona');
  check('a library preset does not mark its base as locked', owned.basePresetLocked !== true, JSON.stringify(owned.basePresetLocked));
}

/* ------------------------------------------------------- bundled examples */

result = await call('examples');
check('the examples route answers', result.status === 200 && result.body.ok === true, JSON.stringify(result.body));
check(
  'a bundled example is listed',
  Array.isArray(result.body.examples) && result.body.examples.length >= 1,
  JSON.stringify(result.body.examples),
);
{
  const row = result.body.examples[0];
  check('an example carries a display name', typeof row.name === 'string' && row.name !== '', JSON.stringify(row.name));
  // The name comes from the metadata comment, not from the filename, so a
  // non-ASCII filename never becomes the label.
  check('an example is not labelled by its filename', row.name !== row.fileName, `${row.name} / ${row.fileName}`);
  check('an example carries a summary', typeof row.summary === 'string' && row.summary !== '', JSON.stringify(row.summary));
}

result = await call('example', { name: result.body.examples[0].name });
check('an example can be read', result.body.ok === true, JSON.stringify(result.body.error));
{
  const persona = result.body.persona;
  check('the example body is substantial', typeof persona === 'string' && persona.length > 1000, String(persona?.length));
  // The metadata comment must not end up inside the persona text.
  check('the metadata header is stripped', !persona.includes('dsh-persona-manager:'), persona.slice(0, 80));
  check('the body starts with the persona itself', persona.startsWith('## '), JSON.stringify(persona.slice(0, 40)));
}

result = await call('example', { name: 'no-such-example' });
check('an unknown example is refused', result.body.ok === false, JSON.stringify(result.body));
result = await call('example', { name: '../package.json' });
check('a path traversal is refused', result.body.ok === false, JSON.stringify(result.body));

// Reading examples must not create anything.
check('examples do not create presets', !registered.has('鲸鱼娘'));

/* ------------------------------ a folded persona is refused, not corrupted */

// `>` joins every newline into a space. Writing an ordinary block under it would
// collapse the user's paragraphs and still report success, so the Host must
// surface a refusal the page can show.
{
  const foldedDir = join(home, 'profiles', 'folded');
  await mkdir(foldedDir, { recursive: true });
  const foldedFile = join(foldedDir, 'cordis.patch.yml');
  await writeFile(foldedFile, [
    '- insert:',
    '    - id: preset-folded',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: folded',
    '        name: 折行模式',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: >',
    '                第一段。',
    '                第二行。',
    '',
  ].join('\n'), 'utf8');
  const beforeFolded = readFileSync(foldedFile, 'utf8');

  result = await call('update', { id: 'folded', persona: '新正文\n第二行' });
  check('a folded persona is refused', result.body.ok === false, JSON.stringify(result.body));
  check(
    'the refusal explains why',
    typeof result.body.error === 'string' && result.body.error.includes('folded'),
    JSON.stringify(result.body.error),
  );
  check('the folded file was not touched', readFileSync(foldedFile, 'utf8') === beforeFolded);
}

/* ------------------------------------- shipped presets are not editable */

result = await call('update', { id: 'standard', persona: 'nope' });
check('a shipped preset cannot be edited', result.body.ok === false, JSON.stringify(result.body));

result = await call('delete', { id: 'whale' });
check('a profile-declared preset is not deletable here', result.body.ok === false, JSON.stringify(result.body));

result = await call('delete', { id: 'standard' });
check('cannot delete a shipped preset', result.body.ok === false);

// Untrusted requests must be refused.
const handler = routes.get('/api/dsh-persona-manager/delete');
const refused = await new Promise((resolve) => {
  const request = {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'data') listener(Buffer.from('{"id":"my-persona"}'));
      if (event === 'end') setImmediate(listener);
      return request;
    },
    destroy() {},
  };
  const response = {
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      resolve({ status: this.status, body: JSON.parse(text) });
    },
  };
  handler(request, response);
});
check('request without the csrf header refused', refused.status === 403);
check('refused request changed nothing', registered.has('my-persona'));

for (const dispose of disposals.reverse()) {
  try {
    if (typeof dispose === 'function') await dispose();
  } catch {}
}
check('teardown unregisters presets', registered.size === 0, String(registered.size));
check('teardown removes routes', routes.size === 0, String(routes.size));

await rm(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
if (failures !== 0) process.exitCode = 1;
