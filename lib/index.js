/**
 * dsh-persona-manager — Host half.
 *
 * Manages the persona presets this plugin owns, and lists every other preset on
 * the machine read-only: the four the harness ships (standard, ptc, minimal,
 * cordis) and any an installed add-on declares.
 *
 * A preset becomes editable in exactly two ways:
 *
 *   - it was created here, so it lives in this plugin's own library file; or
 *   - it is a row the profile's own patch declares (a hand-written preset).
 *     Editing that one rewrites only its persona block, as text, so the file
 *     keeps its comments, quoting, ordering and loader expressions.
 *
 * Nothing else is ever written. In particular the bundled add-on presets belong
 * to their packages, so the page offers "Copy", not "Edit", for them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { replacePersonaInFile, readPersonaFromFile, updateRowFieldsInFile } from './profile-patch.js';

const PERSONA_PLUGIN_NAMES = new Set(['@deepseek-ai/dsh-persona', 'persona']);
/** The four presets the harness ships; everything else is editable. */
const BUILTIN_PRESETS = new Set(['standard', 'ptc', 'minimal', 'cordis']);

/**
 * Display copy for the four shipped presets.
 *
 * They publish no `name` or `description` of their own — the shipped page looks
 * the text up in its locale dictionaries instead. A plugin reading the roster
 * therefore sees four nameless rows, so this table carries the same copy the
 * harness shows, in both languages.
 */
const BUILTIN_COPY = {
  standard: {
    zh: ['标准模式', '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。'],
    en: ['Standard', 'Works with code, files and references — the right default for most tasks. The agent reaches for search, editing and terminal tools as needed.'],
  },
  ptc: {
    zh: ['PTC 模式', '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。'],
    en: ['PTC mode', 'Everything Standard mode does, tuned for calling tools in bulk and then filtering, tidying, de-duplicating, counting or summarising the results.'],
  },
  minimal: {
    zh: ['极简模式', 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。'],
    en: ['Minimal mode', 'The agent gets the terminal and image reading tools plus context compaction — useful for testing and comparing its baseline behaviour.'],
  },
  cordis: {
    zh: ['创造模式', '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。'],
    en: ['Creator mode', 'Customise DSH by talking to it: have the agent write plugins, add features or UI, and compose tools and prompts into your own modes.'],
  },
};
const API_PREFIX = '/api/dsh-persona-manager';
const ACTIONS = ['state', 'export', 'create', 'update', 'delete', 'import', 'reload', 'examples', 'example'];
const CSRF_HEADER = 'x-persona-manager';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const JS_TAG = 'tag:yaml.org,2002:js';

export const name = 'dsh-persona-manager';
export const inject = ['agentPresets', 'webServer'];

/* ------------------------------------------------------------------ paths */

function resolveDshHome() {
  const custom = process.env.DSH_HOME;
  if (typeof custom === 'string' && custom.trim() !== '') return custom.trim();
  return join(homedir(), '.dsh');
}

/**
 * Directories whose `node_modules` may hold the deployment's own packages.
 *
 * A Host plugin is linked into a profile, so a bare import resolves through the
 * plugin's checkout rather than the profile. `DSH_PROFILE_DIR` is set for shells
 * the profile spawns, not inside the Host process itself, so the profile
 * directory is also discovered from `$DSH_HOME/profiles/*`.
 */
function profileRoots() {
  const roots = [];
  const envProfile = process.env.DSH_PROFILE_DIR;
  if (typeof envProfile === 'string' && envProfile !== '') roots.push(envProfile);
  const home = resolveDshHome();
  const profilesDir = join(home, 'profiles');
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(profilesDir, entry.name));
    }
  } catch {
    /* no profiles directory: not a profile-launched Harness */
  }
  if (typeof process.execPath === 'string') roots.push(dirname(process.execPath));
  roots.push(join(home));
  return roots;
}

function libraryPath() {
  return join(resolveDshHome(), 'persona-manager', 'presets.json');
}

/**
 * The bundled example personas that ship inside this plugin.
 *
 * These are prose files, deliberately *not* registered as presets: a sample that
 * appears in every user's session preset picker is a sample nobody asked for.
 * The page offers them as a starting point the user can load into the editor.
 *
 * The directory sits beside `lib/`, so it is found relative to this module
 * rather than to the working directory.
 */
function examplesDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
}

/**
 * Read the example roster.
 *
 * Only `.md` files one level deep are listed. Each entry carries a display name
 * (the filename without its extension) and a short description taken from the
 * first non-empty line when that line is a heading or a quote, so the page has
 * something to show besides a filename.
 */
/**
 * Parse the optional metadata comment at the top of an example file.
 *
 * A sample's first line is often the persona text itself, and a heading added
 * just to label the file would leak into the persona body when it is loaded. An
 * HTML comment carries the label without ever being part of the prose:
 *
 *   <!-- dsh-persona-manager: 鲸鱼娘 | 说明文字 -->
 */
const EXAMPLE_META = /^<!--\s*dsh-persona-manager:\s*([^|]*?)\s*(?:\|([\s\S]*?))?\s*-->\s*\r?\n?/;

function parseExampleMeta(text) {
  const match = text.match(EXAMPLE_META);
  if (match === null) return { name: '', summary: '', body: text };
  return {
    name: (match[1] ?? '').trim(),
    summary: (match[2] ?? '').trim(),
    body: text.slice(match[0].length),
  };
}

function listExamples() {
  const dir = examplesDir();
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;
    const file = join(dir, entry.name);
    const fallback = entry.name.replace(/\.md$/i, '');
    let meta = { name: '', summary: '' };
    try {
      meta = parseExampleMeta(readFileSync(file, 'utf8'));
    } catch {
      /* unreadable: fall back to the filename and no summary */
    }
    rows.push({
      name: meta.name !== '' ? meta.name : fallback,
      file,
      summary: meta.summary,
      fileName: entry.name,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read one example file's body.
 *
 * The filename is matched against the roster rather than joined directly, so a
 * request cannot walk out of the examples directory with `../`.
 */
function readExample(name) {
  const wanted = typeof name === 'string' ? name : '';
  const row = listExamples().find(
    (entry) => entry.name === wanted || entry.fileName === wanted,
  );
  if (row === undefined) throw new Error(`no bundled example named "${wanted}"`);
  const text = readFileSync(row.file, 'utf8');
  // The metadata comment is not persona text: strip it so the body matches the
  // file the user would get from anywhere else.
  const { body } = parseExampleMeta(text);
  return { ok: true, name: row.name, persona: normalizePersona(body) };
}

/* ------------------------------------------------------------------ store */

let writeQueue = Promise.resolve();

function enqueueWrite(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

function emptyLibrary() {
  return { version: 1, presets: [] };
}

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    order: Number.isFinite(raw.order) ? Number(raw.order) : 100,
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    basePreset: typeof raw.basePreset === 'string' && raw.basePreset !== '' ? raw.basePreset : null,
    plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
  };
}

async function readLibrary() {
  const path = libraryPath();
  if (!existsSync(path)) return emptyLibrary();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) {
      return emptyLibrary();
    }
    const presets = [];
    const seen = new Set();
    for (const raw of parsed.presets) {
      const entry = normalizeEntry(raw);
      if (entry === null || seen.has(entry.id)) continue;
      seen.add(entry.id);
      presets.push(entry);
    }
    return { version: 1, presets };
  } catch {
    return emptyLibrary();
  }
}

async function writeLibrary(library) {
  const path = libraryPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ version: 1, presets: library.presets }, null, 2)}\n`;
  const nonce = randomUUID();
  const tmp = `${path}.${process.pid}.${nonce}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    await unlink(tmp).catch(() => {});
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST') throw error;
    // Windows can refuse a rename over a file another handle holds open.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(path, text, 'utf8');
  }
}

/* ------------------------------------------------------------ yaml loading */

let yamlModule;
let yamlLoadError;
let yamlAttempts = [];

/**
 * Resolve the `yaml` package the deployment already ships. A linked bundle
 * resolves to its checkout, so a bare import walks the wrong tree; ask the
 * deployment-provided roots explicitly instead of adding a dependency the user
 * would have to install.
 */
function loadYaml() {
  if (yamlModule !== undefined) return yamlModule;
  if (yamlLoadError !== undefined) throw yamlLoadError;
  const attempts = [];
  const tryResolve = (label, loader) => {
    try {
      const found = loader();
      attempts.push(`${label}: ok`);
      yamlModule = found;
      return true;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERR';
      attempts.push(`${label}: ${code} ${errorMessage(error).split('\n')[0]}`);
      return false;
    }
  };

  const profileDir = process.env.DSH_PROFILE_DIR;
  const candidates = [];

  // Ask every discovered deployment root, profile first: the deployment ships
  // `yaml`, so this needs no dependency of the plugin's own.
  for (const root of profileRoots()) {
    candidates.push([`require@${root}`, () => createRequire(join(root, '__dsh_persona_manager__.cjs'))('yaml')]);
    candidates.push([
      `direct@${root}`,
      () => createRequire(join(root, 'node_modules', 'yaml', 'package.json'))('./dist/index.js'),
    ]);
  }
  // Last resort: the bundle's own resolution chain.
  candidates.push(['module', () => createRequire(import.meta.url)('yaml')]);

  for (const [label, loader] of candidates) {
    if (tryResolve(label, loader)) {
      yamlAttempts = attempts;
      return yamlModule;
    }
  }
  yamlAttempts = attempts;
  yamlLoadError = new Error(
    `The "yaml" package could not be resolved, so a base preset cannot be read. Tried ${attempts.join('; ')}`,
  );
  throw yamlLoadError;
}

/** Diagnostics for the settings page: which roots were tried for `yaml`. */
export function yamlDiagnostics() {
  return yamlAttempts.slice();
}

const JS_EXPR_TAG = {
  tag: JS_TAG,
  resolve: (source) => ({ __jsExpr: source }),
};

function parseDeclaredPlugins(text) {
  const mod = loadYaml();
  const YAML = mod.default ?? mod;
  const document = YAML.parse(text, { customTags: [JS_EXPR_TAG] });
  let list = null;
  if (Array.isArray(document)) list = document;
  else if (document !== null && typeof document === 'object' && Array.isArray(document.plugins)) {
    list = document.plugins;
  }
  if (list === null) throw new Error('the base preset document has no plugin list');
  return list;
}

function isJsExpr(value) {
  return value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string';
}

/**
 * A read-only stand-in for the Loader context an `!!js` expression sees.
 *
 * The Loader evaluates these expressions against its own `ctx`, so common rows
 * read like `!!js "!ctx.get('profileContext')"`. Reproducing that needs a `get`
 * that resolves services; nothing else is exposed, so an expression cannot
 * reach a service method through this object.
 */
function expressionContext(ctx) {
  return {
    get(name) {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
      } catch {
        // A service that refuses probe reads is the same as one that is absent
        // for the purpose of a boolean condition.
        return undefined;
      }
    },
  };
}

function evaluateJsExpr(source, ctx) {
  try {
    // Loader expressions see Node globals and the Loader context; a bare
    // `process.platform` check and a `ctx.get(...)` availability check are the
    // two common shapes. Anything needing loader-only helpers throws and the
    // caller decides what to do about it.
    const fn = new Function('ctx', `return (${source});`);
    return { ok: true, value: fn(expressionContext(ctx)) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Turn a declared plugin list into a plain object list this plugin can register
 * dynamically. Loader `!!js` expressions cannot survive as functions, so each
 * one is evaluated once; a value that cannot be evaluated drops the row rather
 * than shipping a silently different tool surface.
 */
function materializePlugins(list, warnings, ctx) {
  const result = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = cloneJson(raw);
    let keep = true;
    if (isJsExpr(row.disabled)) {
      const evaluated = evaluateJsExpr(row.disabled.__jsExpr, ctx);
      if (evaluated.ok && typeof evaluated.value === 'boolean') row.disabled = evaluated.value;
      else if (evaluated.ok && evaluated.value === undefined) row.disabled = false;
      else {
        // A conditional row we cannot resolve: keep it disabled, never enabled.
        row.disabled = true;
        warnings.push(`row "${row.id ?? row.name ?? '?'}" has an unevaluated condition and was kept disabled`);
      }
    }
    if (row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)) {
      const cleaned = {};
      for (const [key, value] of Object.entries(row.config)) {
        if (isJsExpr(value)) {
          const evaluated = evaluateJsExpr(value.__jsExpr, ctx);
          if (evaluated.ok) cleaned[key] = evaluated.value;
          else {
            keep = false;
            warnings.push(`row "${row.id ?? row.name ?? '?'}" was dropped: config.${key} needs an expression this plugin cannot evaluate`);
            break;
          }
        } else {
          cleaned[key] = value;
        }
      }
      row.config = cleaned;
    }
    if (keep) result.push(row);
  }
  return result;
}

/* --------------------------------------------------------- plugin builders */

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPersonaRow(row) {
  if (row === null || typeof row !== 'object') return false;
  if (typeof row.id === 'string' && row.id === 'persona') return true;
  return typeof row.name === 'string' && PERSONA_PLUGIN_NAMES.has(row.name);
}

function personaOf(plugins) {
  if (!Array.isArray(plugins)) return '';
  const row = plugins.find(isPersonaRow);
  if (row === undefined || row === null || typeof row !== 'object') return '';
  if (row.config === null || typeof row.config !== 'object') return '';
  return typeof row.config.prefix === 'string' ? row.config.prefix : '';
}

/** Replace (or add) the persona body inside a plugin list. */
function withPersona(plugins, personaText) {
  const list = cloneJson(Array.isArray(plugins) ? plugins : []);
  const index = list.findIndex(isPersonaRow);
  if (index >= 0) {
    const row = list[index];
    row.config = { ...(row.config && typeof row.config === 'object' ? row.config : {}) };
    row.config.prefix = personaText;
    return list;
  }
  list.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: personaText } });
  return list;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizePersona(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n/g, '\n');
}

/* ------------------------------------------------------------------ plugin */

export function apply(ctx) {
  const agentPresets = ctx.agentPresets;
  const webServer = ctx.webServer;
  const log = typeof ctx.logger?.warn === 'function' ? (m) => ctx.logger.warn(m) : () => {};

  const state = {
    /** id -> disposer returned by agentPresets.register */
    registrations: new Map(),
    library: emptyLibrary(),
    warnings: [],
    ready: false,
    fatal: null,
    /** Short-lived cache of the profile patch text used for origin detection. */
    patchText: undefined,
  };

  async function declaredPresets() {
    try {
      const rows = await agentPresets.list();
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      log(`persona-manager: cannot list presets: ${errorMessage(error)}`);
      return [];
    }
  }

  /* ---------------------------------------------------- profile declarations */

  /**
   * The profile patch files that carry this user's own declarations.
   *
   * A profile launched from a packaged app may not export `DSH_PROFILE_DIR`, so
   * the profiles directory is walked as well.
   */
  function profilePatchFiles() {
    const files = [];
    const profileDir = process.env.DSH_PROFILE_DIR;
    if (typeof profileDir === 'string' && profileDir !== '') {
      files.push(join(profileDir, 'cordis.patch.yml'));
    }
    const home = resolveDshHome();
    try {
      for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) files.push(join(home, 'profiles', entry.name, 'cordis.patch.yml'));
      }
    } catch {
      /* no profiles directory */
    }
    return files;
  }

  /**
   * Does this profile's own patch declare `preset-<id>`?
   *
   * Matches the row form only, so a preset id that merely appears inside someone's
   * persona text is not mistaken for a declaration.
   */
  function profileDeclares(presetId) {
    const needle = 'preset-' + presetId;
    const rowPattern = new RegExp('^\\s*-\\s*id:\\s*' + needle + '\\s*$', 'm');
    const cache = state.patchText;
    if (cache !== undefined && Date.now() - cache.at < 2000) {
      return rowPattern.test(cache.text);
    }
    const parts = [];
    for (const file of profilePatchFiles()) {
      try {
        parts.push(readFileSync(file, 'utf8'));
      } catch {
        /* absent file: nothing declared there */
      }
    }
    const text = parts.join('\n');
    state.patchText = { at: Date.now(), text };
    return rowPattern.test(text);
  }

  /**
   * Publish library entries through `agentPresets`.
   *
   * An entry that the profile itself declares (or that a bundle declares) is
   * already live; registering a second one under the same id would collide. Such
   * an entry only registers when no declaration currently claims its id, which is
   * the case for presets created here and for bundle presets this plugin shadows.
   */
  async function registerAll() {
    const declared = await declaredPresets();
    const declaredIds = new Set();
    for (const row of declared) {
      const id = typeof row === 'string' ? row : row?.id;
      if (typeof id === 'string') declaredIds.add(id);
    }
    for (const [id, dispose] of state.registrations) {
      try {
        await dispose();
      } catch {
        /* a failed teardown must not block the rest */
      }
      // `declaredIds` is a Set: `delete obj[key]` would silently do nothing and
      // leave the id marked as declared, so the entry would never re-register.
      declaredIds.delete(id);
    }
    state.registrations = new Map();

    const failures = [];
    for (const entry of state.library.presets) {
      if (declaredIds.has(entry.id) && state.registrations.has(entry.id) === false) {
        // The declaration itself is the live one; nothing to publish.
        continue;
      }
      try {
        const dispose = await agentPresets.register({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          order: entry.order,
          plugins: withPersona(entry.plugins, entry.persona),
        });
        state.registrations.set(entry.id, typeof dispose === 'function' ? dispose : async () => {});
      } catch (error) {
        failures.push({ id: entry.id, error: errorMessage(error) });
      }
    }
    state.fatal = null;
    return failures;
  }

  async function reload() {
    state.library = await readLibrary();
    const failures = await registerAll();
    state.ready = true;
    state.warnings = failures.map((row) => `${row.id}: ${row.error}`);
    return failures;
  }

  async function baseSnapshot(basePresetId) {
    const document = await agentPresets.readDocument(basePresetId);
    const content = typeof document?.content === 'string' ? document.content : '';
    if (content.trim() === '') throw new Error(`base preset "${basePresetId}" has no readable composition`);
    const warnings = [];
    const plugins = materializePlugins(parseDeclaredPlugins(content), warnings, ctx);
    if (plugins.length === 0) throw new Error(`base preset "${basePresetId}" produced an empty plugin list`);
    return { plugins, persona: personaOf(plugins), warnings };
  }

  /* ---------------------------------------------------------------- views */

  /**
   * Build the page's view of every preset on this machine.
   *
   * Three sources are merged into two lists:
   *   - `managed`: everything the user may edit. Library entries come first, then
   *     any other declared preset that is not one of the four shipped ones, read
   *     out of its own declaration so the page shows its real persona text.
   *   - `builtin`: the four the harness ships, read-only.
   *
   * `origin` tells the page where a save will land: `library` for a preset this
   * plugin owns, `profile` for a row the profile declares, `bundle` for a preset
   * that arrives with an installed package.
   */
  async function managedView(extraWarnings) {
    const declared = await declaredPresets();
    const declaredById = new Map();
    for (const row of declared) {
      const id = typeof row === 'string' ? row : row?.id;
      if (typeof id === 'string') declaredById.set(id, row);
    }

    const managed = [];
    const builtin = [];
    const covered = new Set();

    // Library entries first: they are the ones this plugin owns outright.
    for (const entry of state.library.presets.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
      const live = declaredById.get(entry.id);
      covered.add(entry.id);
      managed.push({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        order: entry.order,
        basePreset: entry.basePreset,
        persona: entry.persona,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        active: state.registrations.has(entry.id) || declaredById.has(entry.id),
        broken: typeof live?.broken === 'string' ? live.broken : null,
        pluginCount: entry.plugins.length,
        origin: entry.shadowOf ?? 'library',
        editable: true,
      });
    }

    // Every other declared preset. Two of these are read-only — the four the
    // harness ships, and anything an installed package declares — while a row in
    // this profile's own patch is the user's and can be edited in place.
    for (const row of declared) {
      const id = typeof row === 'string' ? row : row?.id;
      if (typeof id !== 'string' || covered.has(id)) continue;
      const meta = {
        id,
        name: typeof row?.name === 'string' ? row.name : id,
        description: typeof row?.description === 'string' ? row.description : '',
        isDefault: row?.isDefault === true,
        broken: typeof row?.broken === 'string' ? row.broken : null,
        order: Number.isFinite(row?.order) ? row.order : 0,
      };
      if (BUILTIN_PRESETS.has(id)) {
        // A shipped preset publishes no name or description; supply the same
        // copy the harness itself shows, rather than leaving the card blank.
        const copy = BUILTIN_COPY[id];
        builtin.push({
          ...meta,
          name: copy !== undefined ? copy.zh[0] : id,
          description: copy !== undefined ? copy.zh[1] : '',
          names: copy !== undefined ? { zh: copy.zh[0], en: copy.en[0] } : undefined,
          descriptions: copy !== undefined ? { zh: copy.zh[1], en: copy.en[1] } : undefined,
          kind: 'shipped',
        });
        continue;
      }
      if (!profileDeclares(id)) {
        // Arrives with an installed package; its row belongs to that package.
        builtin.push({ ...meta, kind: 'bundled' });
        continue;
      }
      // A row this profile declares: editable, and saved as text into that row.
      covered.add(id);
      const detail = await readPresetDetail(id);
      managed.push({
        ...meta,
        basePreset: null,
        // This row carries its plugin list inline, so it never came "from" a
        // base preset: there is no base to show and none that could be changed
        // by this page. The flag tells the editor to lock the selector instead
        // of offering a choice that a save would silently discard.
        basePresetLocked: true,
        persona: detail.persona,
        pluginCount: detail.pluginCount,
        createdAt: null,
        updatedAt: null,
        active: true,
        origin: 'profile',
        editable: true,
      });
    }

    return {
      ok: true,
      ready: state.ready,
      managed,
      builtin: builtin.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      warnings: extraWarnings ?? state.warnings,
      libraryPath: libraryPath(),
      yaml: yamlAttempts.slice(),
      yamlReady: yamlModule !== undefined,
    };
  }

  /** Read a declared preset's persona body and plugin count for display. */
  async function readPresetDetail(presetId) {
    try {
      const document = await agentPresets.readDocument(presetId);
      const content = typeof document?.content === 'string' ? document.content : '';
      if (content.trim() === '') return { persona: '', pluginCount: 0 };
      const plugins = parseDeclaredPlugins(content);
      return { persona: personaOf(plugins), pluginCount: plugins.length };
    } catch (error) {
      log(`persona-manager: cannot read preset "${presetId}": ${errorMessage(error)}`);
      return { persona: '', pluginCount: 0 };
    }
  }

  /* ------------------------------------------------------------ mutations */

  function assertId(id, currentId) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error('id must use lowercase letters, digits and hyphens, and start with a letter or digit');
    }
    if (currentId !== undefined && id === currentId) return;
    if (state.library.presets.some((entry) => entry.id === id)) {
      throw new Error(`preset "${id}" already exists`);
    }
  }

  function buildMeta(input, previous) {
    return {
      id: typeof input.id === 'string' ? input.id.trim() : previous?.id,
      name: typeof input.name === 'string' && input.name.trim() !== ''
        ? input.name.trim()
        : previous?.name ?? '',
      description: typeof input.description === 'string' ? input.description : previous?.description ?? '',
      order: Number.isFinite(Number(input.order))
        ? Number(input.order)
        : previous?.order ?? 100,
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }

  async function createPreset(input) {
    const meta = buildMeta(input, null);
    assertId(meta.id, undefined);
    const basePresetId = typeof input.basePreset === 'string' && input.basePreset !== ''
      ? input.basePreset
      : '';
    let plugins;
    let persona;
    let warnings = [];
    if (basePresetId !== '') {
      const snapshot = await baseSnapshot(basePresetId);
      plugins = snapshot.plugins;
      warnings = snapshot.warnings;
      persona = normalizePersona(input.persona) || snapshot.persona;
    } else if (Array.isArray(input.plugins) && input.plugins.length > 0) {
      plugins = cloneJson(input.plugins);
      persona = normalizePersona(input.persona);
    } else {
      throw new Error('choose a base preset: it supplies the tool surface a persona runs on');
    }
    const entry = {
      ...meta,
      name: meta.name || meta.id,
      persona,
      basePreset: basePresetId || null,
      plugins: withPersona(plugins, persona),
    };
    await enqueueWrite(async () => {
      const current = await readLibrary();
      current.presets.push(entry);
      await writeLibrary(current);
    });
    await reload();
    return managedView(warnings);
  }

  /**
   * Save an edit to a preset, writing it back to where the preset lives.
   *
   * Three paths, tried in order:
   *   1. **Library entry** — the plugin's own file, always writable.
   *   2. **Profile declaration row** — the persona is replaced in place through
   *      the config editor, so the preset keeps its id and everything else in the
   *      row survives.
   *   3. **Bundle-declared preset** — the row belongs to another package, so the
   *      edit is kept here and registered under the same id, shadowing the
   *      original. Deleting the entry restores the bundled preset.
   */
  async function updatePreset(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (id === '') throw new Error('a preset id is required');
    if (BUILTIN_PRESETS.has(id)) throw new Error(`preset "${id}" ships with the harness and cannot be edited`);

    const persona = normalizePersona(input.persona);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description : undefined;
    const order = Number.isFinite(Number(input.order)) ? Number(input.order) : undefined;

    // 1. A preset this plugin already owns.
    const previous = state.library.presets.find((entry) => entry.id === id);
    if (previous !== undefined) {
      const meta = buildMeta({ ...input, id: previous.id }, previous);
      meta.id = previous.id;
      let plugins = previous.plugins;
      let warnings = [];
      let nextPersona = persona === '' && input.persona === undefined ? previous.persona : persona;
      const nextBase = typeof input.basePreset === 'string' && input.basePreset !== ''
        ? input.basePreset
        : previous.basePreset;
      if (nextBase !== null && nextBase !== previous.basePreset) {
        const snapshot = await baseSnapshot(nextBase);
        plugins = snapshot.plugins;
        warnings = snapshot.warnings;
        if (nextPersona === '') nextPersona = snapshot.persona;
      }
      const entry = {
        ...meta,
        name: meta.name || previous.name || previous.id,
        persona: nextPersona,
        basePreset: nextBase,
        plugins: withPersona(plugins, nextPersona),
        shadowOf: previous.shadowOf ?? null,
      };
      await enqueueWrite(async () => {
        const current = await readLibrary();
        const index = current.presets.findIndex((row) => row.id === previous.id);
        if (index < 0) throw new Error(`preset "${previous.id}" disappeared from the library`);
        current.presets[index] = entry;
        await writeLibrary(current);
      });
      await reload();
      return managedView(warnings);
    }

    // 2. A preset this profile's own patch declares (e.g. a hand-written one).
    //    Only the persona block and this preset's own display fields are
    //    rewritten, as text, so the row keeps its comments, quoting, ordering and
    //    expressions. Its `basePreset` is deliberately not written: the row
    //    carries its plugin list inline, so there is no base to record.
    if (profileDeclares(id)) {
      const target = profilePatchFiles().find((f) => existsSync(f)) ?? '';
      const nextPersona = persona !== ''
        ? persona
        : (await readPersonaFromFile(target, id)) ?? '';
      let result = null;
      for (const file of profilePatchFiles()) {
        result = await replacePersonaInFile(file, id, nextPersona);
        if (result.status === 'written' || result.status === 'unchanged') break;
      }
      if (result === null) {
        throw new Error(
          `preset "${id}" is declared by this profile, but its persona block could not be located in the patch file. Nothing was written.`,
        );
      }
      if (result.status === 'unsupported-scalar') {
        // Refusing is the whole point: a "successful" write here would collapse
        // the user's paragraphs and they would only notice next session.
        throw new Error(
          `preset "${id}": ${result.detail}. Nothing was written — edit that block by hand in cordis.patch.yml, or copy the preset and save it as a new one.`,
        );
      }
      if (result.status !== 'written' && result.status !== 'unchanged') {
        throw new Error(
          `preset "${id}" is declared by this profile, but its persona block could not be located in the patch file. Nothing was written.`,
        );
      }

      // Display metadata lives in the row's own `config:` block, not in the
      // persona body, so it needs a second, equally surgical pass.
      const fields = {};
      if (name !== '') fields.name = name;
      if (description !== undefined) fields.description = description;
      if (order !== undefined) fields.order = order;
      const warnings = [];
      if (Object.keys(fields).length > 0) {
        let meta = null;
        for (const file of profilePatchFiles()) {
          meta = await updateRowFieldsInFile(file, id, fields);
          if (meta.status === 'written' || meta.status === 'unchanged') break;
        }
        if (meta === null || (meta.status !== 'written' && meta.status !== 'unchanged')) {
          throw new Error(
            `preset "${id}": its persona was saved, but the row's display fields could not be located in the patch file.`,
          );
        }
        if (Array.isArray(meta.missing) && meta.missing.length > 0) {
          warnings.push(
            `the row does not declare ${meta.missing.join(', ')}, so ${
              meta.missing.length === 1 ? 'that field was' : 'those fields were'
            } not written`,
          );
        }
      }
      await reload();
      return managedView(warnings);
    }

    // 3. Anything else on this machine is read-only here.
    throw new Error(
      `preset "${id}" is provided by an installed plugin and is read-only. Use "Copy" to make an editable persona from it.`,
    );
  }

  /**
   * Remove a preset this plugin owns.
   *
   * Only library entries can be deleted. A preset declared by the profile or by a
   * bundled add-on is that file's own row, so this refuses rather than editing
   * someone else's declaration; the page says where it lives instead.
   */
  async function deletePreset(id) {
    if (BUILTIN_PRESETS.has(id)) throw new Error(`preset "${id}" ships with the harness and cannot be deleted`);
    const target = state.library.presets.find((entry) => entry.id === id);
    if (target === undefined) {
      if (profileDeclares(id)) {
        throw new Error(
          `preset "${id}" is declared by this profile's own patch file, so it is not this plugin's to delete. Remove its "- id: preset-${id}" row from the profile patch, or copy it into a preset you own first.`,
        );
      }
      throw new Error(
        `preset "${id}" is provided by an installed plugin and cannot be deleted here.`,
      );
    }
    await enqueueWrite(async () => {
      const current = await readLibrary();
      current.presets = current.presets.filter((row) => row.id !== id);
      await writeLibrary(current);
    });
    await reload();
    return managedView([]);
  }

  /**
   * Build the export payload for one preset, or for every preset this page can
   * edit when no id is given.
   *
   * What a backup needs is the persona body plus the few facts required to put
   * the preset back: its id, display name, description, order and the base whose
   * tool surface it was built on. The plugin snapshot is deliberately left out —
   * it is a large stale copy of another preset, and `import` rebuilds it from
   * `basePreset` anyway.
   *
   * A preset this profile declares carries its plugin list inline, so it has no
   * base of its own. Importing it needs one, so it is recorded as "standard" and
   * flagged, rather than being silently left out of the backup.
   */
  async function exportPayload(input) {
    const wanted = typeof input?.id === 'string' && input.id !== '' ? input.id : null;
    const view = await managedView();
    const rows = wanted === null ? view.managed : view.managed.filter((row) => row.id === wanted);
    if (wanted !== null && rows.length === 0) {
      throw new Error(`preset "${wanted}" is not one this page can export`);
    }
    const presets = rows.map((row) => {
      const base = typeof row.basePreset === 'string' && row.basePreset !== '' ? row.basePreset : 'standard';
      const out = {
        id: row.id,
        name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
        description: typeof row.description === 'string' ? row.description : '',
        order: Number.isFinite(row.order) ? row.order : 100,
        persona: typeof row.persona === 'string' ? row.persona : '',
        basePreset: base,
      };
      if (base !== row.basePreset) out.basePresetGuessed = true;
      return out;
    });
    return { ok: true, version: 1, exportedAt: new Date().toISOString(), presets };
  }

  async function importLibrary(payload) {
    const rows = Array.isArray(payload?.presets)
      ? payload.presets
      : Array.isArray(payload) ? payload : null;
    if (rows === null) throw new Error('the imported file has no "presets" array');
    const prepared = [];
    const warnings = [];
    for (const raw of rows) {
      const meta = buildMeta(raw, null);
      // Restoring a backup onto the machine it came from re-imports ids that are
      // already here, so an existing library entry is overwritten rather than
      // rejected. A read-only preset is a different matter: its row belongs to
      // the harness or to this profile's patch, so importing it would be a
      // silent no-op. It is skipped with a warning instead of failing the whole
      // file, because one unportable preset must not cost the other rows.
      const existing = state.library.presets.find((entry) => entry.id === meta.id);
      if (BUILTIN_PRESETS.has(meta.id)) {
        warnings.push(`preset "${meta.id}" ships with the harness and was skipped`);
        continue;
      }
      if (existing === undefined && profileDeclares(meta.id)) {
        warnings.push(`preset "${meta.id}" is declared by this profile's patch file and was skipped`);
        continue;
      }
      assertId(meta.id, existing?.id);
      const basePresetId = typeof raw.basePreset === 'string' ? raw.basePreset : '';
      if (basePresetId === '') {
        throw new Error(`preset "${meta.id}" has no basePreset, so its tool surface cannot be rebuilt`);
      }
      const snapshot = await baseSnapshot(basePresetId);
      warnings.push(...snapshot.warnings);
      const persona = normalizePersona(raw.persona) || snapshot.persona;
      prepared.push({
        ...meta,
        name: meta.name || meta.id,
        persona,
        basePreset: basePresetId,
        plugins: withPersona(snapshot.plugins, persona),
      });
    }
    await enqueueWrite(async () => {
      const current = await readLibrary();
      const byId = new Map(current.presets.map((row) => [row.id, row]));
      for (const entry of prepared) byId.set(entry.id, entry);
      current.presets = [...byId.values()];
      await writeLibrary(current);
    });
    await reload();
    return managedView(warnings);
  }

  /* ------------------------------------------------------------- transport */

  function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      request.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BODY_BYTES) {
          reject(new Error('request body is too large'));
          request.destroy();
          return;
        }
        chunks.push(buffer);
      });
      request.on('end', () => {
        if (bytes === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('request body is not valid JSON'));
        }
      });
      request.on('error', reject);
    });
  }

  function isLoopback(address) {
    if (typeof address !== 'string') return false;
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  function isTrustedRequest(request) {
    if (request.headers[CSRF_HEADER] !== '1') return false;
    if (!isLoopback(request.socket?.remoteAddress)) return false;
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    return true;
  }

  async function routeRead(action) {
    if (action === 'state') return managedView();
    if (action === 'export') return exportPayload(null);
    if (action === 'examples') return { ok: true, examples: listExamples() };
    throw new Error(`unknown action "${action}"`);
  }

  async function routeWrite(action, payload) {
    switch (action) {
      case 'create':
        return createPreset(payload);
      case 'update':
        return updatePreset(payload);
      case 'delete':
        return deletePreset(typeof payload.id === 'string' ? payload.id : '');
      case 'import':
        return importLibrary(payload);
      case 'export':
        return exportPayload(payload);
      case 'example':
        // Reading a bundled sample is a read, but it needs a request body to name
        // which one, so it arrives as a POST.
        return readExample(payload.name);
      case 'reload':
        await reload();
        return managedView([]);
      default:
        throw new Error(`unknown action "${action}"`);
    }
  }

  async function handle(request, response, action) {
    try {
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'request rejected: not a same-origin local request' });
        return;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (!state.ready) await reload();
        sendJson(response, 200, await routeRead(action));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' });
        response.end();
        return;
      }
      const payload = (await readBody(request)) ?? {};
      sendJson(response, 200, await routeWrite(action, payload));
    } catch (error) {
      sendJson(response, 400, { ok: false, error: errorMessage(error) });
    }
  }

  ctx.effect(() => {
    const disposers = [];
    for (const action of ACTIONS) {
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/${action}`,
          handler: (request, response) => handle(request, response, action),
        }),
      );
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }, 'dsh-persona-manager: routes');

  ctx.effect(
    () => () => {
      for (const [, dispose] of state.registrations) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      state.registrations = new Map();
    },
    'dsh-persona-manager: presets',
  );

  reload().catch((error) => {
    state.ready = true;
    state.fatal = errorMessage(error);
    state.warnings = [state.fatal];
    log(`persona-manager: initial load failed: ${state.fatal}`);
  });
}
