/**
 * Render smoke test for the Client half.
 *
 * Loads the real client.js with a stub module loader and a stub React that only
 * records elements, then renders the page for the states that matter: empty,
 * with a managed preset, and with the editor open.
 *
 * A component that throws here blanks the real slot the same way, which is the
 * failure a syntax check cannot catch.
 *
 * The harness keeps one rule: an element is `{ type, props }` where children
 * live in `props.children`, exactly like React. Every walker reads that one
 * place, so nothing can silently miss a subtree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/* ------------------------------------------------------------- fake React */

let hookIndex = 0;
let pendingEffects = [];
let stateSlots = [];

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) {
    const index = hookIndex++;
    if (stateSlots[index] === undefined) {
      stateSlots[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [
      stateSlots[index],
      (next) => {
        stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
      },
    ];
  },
  useEffect(fn) {
    pendingEffects.push(fn);
  },
  useMemo(fn) {
    hookIndex += 1;
    return fn();
  },
  useCallback(fn) {
    hookIndex += 1;
    return fn;
  },
  useRef(value) {
    hookIndex += 1;
    return { current: value };
  },
};

/* ---------------------------------------------------------- fake globals */

let stateResponse = { ok: true, ready: true, managed: [], external: [], warnings: [] };
/** Served for the `examples` route; empty by default so earlier cases are unaffected. */
let exampleResponse = { ok: true, examples: [] };
/** Served for the `example` route, i.e. reading one bundled sample. */
let exampleBody = { ok: true, name: '', persona: '' };

const globals = {
  navigator: { language: 'zh-CN' },
  document: {
    documentElement: {},
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    body: { appendChild() {}, removeChild() {} },
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  // Route by URL: the page talks to several endpoints, and answering every one
  // with the state payload would silently pass even if a call went to the wrong
  // place.
  fetch: (url) => {
    const path = String(url).split('?')[0];
    let payload = stateResponse;
    if (path.endsWith('/examples')) payload = exampleResponse;
    else if (path.endsWith('/example')) payload = exampleBody;
    return Promise.resolve({ ok: true, status: 200, json: async () => payload });
  },
  FileReader: class {},
  Blob: class {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  console,
  setTimeout,
  Promise,
};

/* ------------------------------------------------------------ load client */

let registration = null;
const loaderWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registration = { id, exports: factory((name) => {
        if (name === 'react') return React;
        throw new Error(`unexpected module: ${name}`);
      }) };
    },
  },
};

const context = vm.createContext({ ...globals, window: loaderWindow });
vm.runInContext(source, context, { filename: 'client.js' });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

check('module registered', registration !== null && registration.id === 'dsh-persona-manager');

/* ------------------------------------------------------- fake slot context */

const slots = {
  inject(_name, fn) {
    this.registered = fn();
    return () => {};
  },
  register(_options, Component) {
    this.Component = Component;
    return () => {};
  },
};
registration.exports.apply({ slots });
check('slot registration happened', typeof slots.Component === 'function');

/* ---------------------------------------------------------------- walking */

/** Expand function components into host elements, exactly as React would. */
function expand(node, depth = 0) {
  if (node === null || node === undefined || depth > 50) return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1));
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    return expand(node.type(node.props ?? {}), depth + 1);
  }
  const kids = node.props.children;
  if (kids !== undefined) return { type: node.type, props: { ...node.props, children: expand(kids, depth + 1) } };
  return node;
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === 'object') textOf(node.props?.children, out);
  return out;
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

const text = (node) => textOf(node).join(' ');

/* --------------------------------------------------------------- rendering */

/**
 * Render once, run the effects the mount scheduled, let their promises settle,
 * then render again from the state those promises wrote. Two passes is what a
 * mounted React tree does around an async fetch.
 */
async function settle() {
  hookIndex = 0;
  pendingEffects = [];
  slots.Component({ close() {} });
  for (const effect of pendingEffects.splice(0)) {
    try {
      effect();
    } catch (err) {
      console.log('  effect threw:', err.message);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  hookIndex = 0;
  pendingEffects = [];
  return expand(slots.Component({ close() {} }));
}

/* ------------------------------------------------------------- assertions */

// --- state 1: nothing managed yet
stateResponse = {
  ok: true,
  ready: true,
  managed: [],
  builtin: [
    { id: 'standard', name: '标准模式', isDefault: true, broken: null },
    { id: 'whale', name: '鲸鱼娘模式', description: '标准模式全部能力 + 人设', broken: null },
  ],
  warnings: [],
  libraryPath: '/tmp/presets.json',
};

let tree;
try {
  tree = await settle();
  check('renders with no managed presets', true);
} catch (err) {
  check('renders with no managed presets', false, err.message);
  process.exit(1);
}

let body = text(tree);
check('shows the zh title', body.includes('人设预设'));
check('shows the empty hint', body.includes('还没有预设'));
check('lists a builtin preset', body.includes('标准模式'));
check(
  'external section uses a card grid',
  findAll(tree, (n) => n.type === 'ul' && n.props.style?.display === 'grid').length >= 1,
);

// --- state 2: one managed preset
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [
    {
      id: 'demo',
      name: '演示卡片',
      description: '示例说明',
      order: 100,
      basePreset: 'whale',
      persona: '人设正文',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'profile',
      editable: true,
    },
  ],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null }],
  warnings: [],
  libraryPath: '/tmp/presets.json',
};

try {
  tree = await settle();
  check('renders with one managed preset', true);
} catch (err) {
  check('renders with one managed preset', false, err.message);
  process.exit(1);
}

body = text(tree);
check('card shows the preset name', body.includes('演示卡片'));
check('card shows the plugin count', body.includes('22'));

const cards = findAll(tree, (n) => n.type === 'li');
check('one card per preset', cards.length === 2, `got ${cards.length}`);
if (cards.length > 0) {
  const style = cards[0].props.style;
  check('card has a radius', style.borderRadius !== undefined, String(style.borderRadius));
  check('card has a background', typeof style.background === 'string', String(style.background));
  check('card stacks vertically', style.flexDirection === 'column');
}
const grids = findAll(tree, (n) => n.type === 'ul');
check('preset lists are grids', grids.length >= 1 && grids.every((g) => g.props.style?.display === 'grid'));
if (grids.length > 0) {
  check('grid auto-fills 268px columns', String(grids[0].props.style.gridTemplateColumns).includes('268px'));
}

// --- state 3: editor open
const newButton = findAll(
  tree,
  (n) => n.type === 'button' && text(n).includes('新建预设'),
);
check('new-preset button exists', newButton.length === 1, String(newButton.length));

if (newButton.length === 1) {
  newButton[0].props.onClick();
  hookIndex = 0;
  pendingEffects = [];
  let editorTree;
  try {
    editorTree = expand(slots.Component({ close() {} }));
    check('editor renders after clicking New preset', true);
  } catch (err) {
    check('editor renders after clicking New preset', false, err.message);
  }
  if (editorTree !== undefined) {
    const editorBody = text(editorTree);
    check('editor shows the persona field label', editorBody.includes('人设正文'));
    const areas = findAll(editorTree, (n) => n.type === 'textarea');
    check('editor has a textarea', areas.length === 1, String(areas.length));
    if (areas.length === 1) {
      check('textarea uses a monospace face', String(areas[0].props.style.fontFamily).includes('monospace'));
      check('textarea is reasonably tall', String(areas[0].props.style.minHeight) === '300px');
    }
    const selects = findAll(editorTree, (n) => n.type === 'select');
    check('editor has the base-preset selector', selects.length === 1, String(selects.length));

    // Every field that is a direct child of the editor panel must not carry a
    // horizontal flex basis: the panel is a column, so that basis would become a
    // height and open a large gap between rows.
    const panelLabels = findAll(editorTree, (n) => n.type === 'label' && n.props.style);
    // A label whose style carries `flex: "1 1 200px"` is row-scoped; inside the
    // column panel that basis turns into a height. Panel-direct fields therefore
    // carry `flex: "0 0 auto"` instead.
    const stretched = panelLabels.filter((n) => {
      const basis = n.props.style.flexBasis ?? n.props.style.flex;
      return basis !== undefined && /200px/.test(String(basis));
    });
    const stackedCount = panelLabels.filter((n) => String(n.props.style.flex) === '0 0 auto').length;
    check('the panel stacks its fields at natural height', stackedCount >= 3, String(stackedCount));
    // The row-scoped fields are expected: the ID/name/order row lays three
    // fields side by side. What matters is that the panel-direct fields are not
    // among them.
    check(
      'row fields keep their horizontal basis',
      stretched.length === 2,
      String(stretched.length),
    );

    // The editor must sit above the managed list, so creating a preset starts
    // where the eye already is instead of appending below the whole catalogue.
    const ordered = [];
    (function walk(node) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (typeof node !== 'object') return;
      ordered.push(node);
      walk(node.props && node.props.children);
    })(editorTree);
    const editorPos = ordered.findIndex((n) => n.type === 'div' && n.props.style && n.props.style.padding === '16px');
    const firstHeading = ordered.findIndex((n) => n.type === 'h3');
    check(
      'the editor is rendered above the groups',
      editorPos >= 0 && firstHeading >= 0 && editorPos < firstHeading,
      `editor@${editorPos} heading@${firstHeading}`,
    );
  }
}

// --- the card head carries the id, the footer does not repeat it ------------
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [
    {
      id: 'demo',
      name: '演示卡片',
      description: '示例说明',
      order: 1,
      basePreset: 'whale',
      persona: 'x',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'library',
      editable: true,
    },
  ],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped' }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const cardTree = await settle();
  const footers = findAll(cardTree, (n) => n.type === 'div' && n.props.style && n.props.style.borderTopWidth === '0.5px');
  check('the card has a footer', footers.length >= 1, String(footers.length));
  if (footers.length >= 1) {
    const footText = text(footers[0]);
    check(
      'the footer shows the plugin count and not the id',
      footText.includes('22') && !footText.includes('demo'),
      footText,
    );
    check('the footer holds the edit action', footText.includes('编辑'), footText);
  }
  const headers = findAll(cardTree, (n) => n.type === 'span' && n.props.style && n.props.style.textOverflow === 'ellipsis');
  check('the card head shows an id', headers.length >= 1, String(headers.length));
}

// --- the export panel offers a scope and a format -------------------------
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [
    {
      id: 'demo',
      name: '演示卡片',
      description: '示例说明',
      order: 1,
      basePreset: 'whale',
      persona: 'x',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'profile',
      editable: true,
    },
    {
      id: 'second',
      name: '第二个',
      description: '',
      order: 2,
      basePreset: null,
      persona: 'y',
      pluginCount: 5,
      active: true,
      broken: null,
      origin: 'profile',
      editable: true,
    },
  ],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped' }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const exportTree = await settle();
  const exportButton = findAll(exportTree, (n) => n.type === 'button' && text(n) === '导出');
  check('the toolbar has an export button', exportButton.length === 1, String(exportButton.length));

  // Closed by default: the panel must not push the list down on every visit.
  check(
    'the export panel is closed initially',
    findAll(exportTree, (n) => n.type === 'select').length === 0,
    String(findAll(exportTree, (n) => n.type === 'select').length),
  );

  if (exportButton.length === 1) {
    exportButton[0].props.onClick();
    hookIndex = 0;
    pendingEffects = [];
    const panelTree = expand(slots.Component({ close() {} }));
    const panelBody = text(panelTree);
    check('the export panel opens above the list', panelBody.includes('导出预设'));
    const selects = findAll(panelTree, (n) => n.type === 'select');
    check('the export panel has a scope and a format selector', selects.length === 2, String(selects.length));

    // Scope offers every editable preset plus "all", because the JSON backup
    // covers them all and Markdown needs exactly one.
    if (selects.length === 2) {
      const options = findAll(selects[0], (n) => n.type === 'option');
      const values = options.map((o) => o.props.value);
      check(
        'the scope lists all presets and a single entry per preset',
        values.includes('') && values.includes('demo') && values.includes('second') && values.length === 3,
        JSON.stringify(values),
      );
      const formats = findAll(selects[1], (n) => n.type === 'option').map((o) => o.props.value);
      check('both formats are offered', formats.includes('json') && formats.includes('markdown'), JSON.stringify(formats));
    }

    // The panel fields are panel-direct, so they must stack at natural height.
    const panelLabels = findAll(panelTree, (n) => n.type === 'label' && n.props.style);
    const stretched = panelLabels.filter((n) => /200px/.test(String(n.props.style.flex ?? '')));
    check('the export panel does not stretch its fields', stretched.length === 0, String(stretched.length));
  }
}

// --- a profile-declared preset cannot choose a base preset -----------------
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [
    {
      id: 'whale',
      name: '鲸鱼娘模式',
      description: '配置行声明',
      order: 3,
      basePreset: null,
      basePresetLocked: true,
      persona: '人设正文',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'profile',
      editable: true,
    },
  ],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const lockedTree = await settle();
  const editButton = findAll(lockedTree, (n) => n.type === 'button' && text(n) === '编辑');
  check('a managed card offers an edit action', editButton.length === 1, String(editButton.length));
  if (editButton.length === 1) {
    editButton[0].props.onClick();
    // Selecting a card only records the id; the draft is built by an effect that
    // is registered on the NEXT render. So: render, run what that render
    // scheduled, then render again — the same two-pass shape `settle()` uses.
    hookIndex = 0;
    pendingEffects = [];
    slots.Component({ close() {} });
    for (const effect of pendingEffects.splice(0)) {
      try {
        effect();
      } catch (err) {
        console.log('  effect threw:', err.message);
      }
    }
    hookIndex = 0;
    pendingEffects = [];
    const editor = expand(slots.Component({ close() {} }));
    const selects = findAll(editor, (n) => n.type === 'select');
    check('the editor still renders one selector', selects.length === 1, String(selects.length));
    if (selects.length === 1) {
      // A disabled selector is the whole point: the row's plugin list is inline,
      // so there is no base to choose and a save could not honour one.
      check('the base selector is locked', selects[0].props.disabled === true, String(selects[0].props.disabled));
      const options = findAll(selects[0], (n) => n.type === 'option').map((o) => o.props.value);
      check('the locked selector offers no base', options.length === 1 && options[0] === '', JSON.stringify(options));
    }
    check('the editor explains why the base is locked', text(editor).includes('没有「基准预设」可换'));
  }
}

// --- a new preset gets a fresh order, not a constant ----------------------
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [
    {
      id: 'demo',
      name: '演示卡片',
      description: '',
      order: 3,
      basePreset: 'standard',
      persona: 'x',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'library',
      editable: true,
    },
  ],
  builtin: [
    { id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 },
    { id: 'base', name: '插件包预设', description: '', broken: null, kind: 'bundled', order: 9 },
  ],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const freshTree = await settle();
  const newButton = findAll(freshTree, (n) => n.type === 'button' && text(n) === '新建预设');
  check('the new-preset button is present', newButton.length === 1, String(newButton.length));
  if (newButton.length === 1) {
    newButton[0].props.onClick();
    hookIndex = 0;
    pendingEffects = [];
    const editor = expand(slots.Component({ close() {} }));
    const numbers = findAll(editor, (n) => n.type === 'input' && n.props.type === 'number');
    check('the editor has an order field', numbers.length === 1, String(numbers.length));
    if (numbers.length === 1) {
      // Highest existing order (9, the bundled preset) plus one.
      check(
        'a new preset sorts after everything else',
        String(numbers[0].props.value) === '10',
        String(numbers[0].props.value),
      );
    }
  }
}

// --- the footer says where the data lives AND that uninstalling keeps it ----
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped' }],
  warnings: [],
  libraryPath: '/tmp/presets.json',
};

{
  const footerTree = await settle();
  const footerBody = text(footerTree);
  check('the page shows the library path', footerBody.includes('/tmp/presets.json'), footerBody);
  // "Not listed any more" and "deleted" are different outcomes. The page has to
  // say which one uninstalling causes, or the user has to guess.
  check(
    'the page says uninstalling keeps the library file',
    footerBody.includes('卸载本插件不会删除这个文件'),
    footerBody,
  );
}

// --- bundled examples are offered, and loading one opens the editor -------
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};
// The examples route is fetched on mount; serve it from the routing table.
exampleResponse = { ok: true, examples: [{ name: '鲸鱼娘', file: '鲸鱼娘.md', fileName: '鲸鱼娘.md', summary: '一份性格与表达范例' }] };
exampleBody = { ok: true, name: '鲸鱼娘', persona: '## 一、优先级栈\n\n正文' };

{
  const exTree = await settle();
  const body = text(exTree);
  check('the examples section is shown', body.includes('附赠示例'), body.slice(0, 200));
  check('the example card shows its summary', body.includes('一份性格与表达范例'));
  check('the examples hint says loading does not create', body.includes('不会自动新增预设'));

  const loadButtons = findAll(exTree, (n) => n.type === 'button' && text(n) === '载入');
  check('the example card offers a load action', loadButtons.length === 1, String(loadButtons.length));
  if (loadButtons.length === 1) {
    loadButtons[0].props.onClick();
    // The load call is async: let the promise chain settle, then render.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    hookIndex = 0;
    pendingEffects = [];
    slots.Component({ close() {} });
    for (const effect of pendingEffects.splice(0)) {
      try {
        effect();
      } catch (err) {
        console.log('  effect threw:', err.message);
      }
    }
    hookIndex = 0;
    pendingEffects = [];
    const loadedTree = expand(slots.Component({ close() {} }));
    const areas = findAll(loadedTree, (n) => n.type === 'textarea');
    check('loading an example opens the editor', areas.length === 1, String(areas.length));
    if (areas.length === 1) {
      check(
        'the loaded body is in the persona field',
        String(areas[0].props.value).includes('优先级栈'),
        JSON.stringify(String(areas[0].props.value).slice(0, 40)),
      );
    }
    // Loading fills the editor; it must not silently create a preset.
    check('loading an example did not create a preset', stateResponse.managed.length === 0);
  }
}

console.log(failures === 0 ? '\nall render checks passed' : `\n${failures} render check(s) failed`);
if (failures !== 0) process.exitCode = 1;
