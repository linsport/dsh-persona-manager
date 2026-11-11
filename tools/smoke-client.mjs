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
/**
 * Forces the next write to fail: `{ status, error }` makes the host answer
 * with a rejection, `null` lets it succeed. The save flow has two branches —
 * close the editor, or keep it and show why — and only a rejected write can
 * exercise the second one.
 */
let writeFailure = null;

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
    // Writes answer from the same state payload unless a case forces a
    // rejection, so a save looks like any other host call by default.
    if (writeFailure !== null && /\/create$|\/update$/.test(path)) {
      return Promise.resolve({
        ok: false,
        status: writeFailure.status,
        json: async () => ({ ok: false, error: writeFailure.error }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => payload });
  },
  // Reads the text the test hung on the fake file, then reports it the way the
  // real reader does: asynchronously, through `onload`.
  FileReader: class {
    readAsText(file) {
      this.result = file.__text;
      if (typeof this.onload === 'function') this.onload();
    }
  },
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

    // --- live statistics and the preview switch -----------------------------
    const editorText = text(editorTree);
    check('the editor reports a character count', /0 字/.test(editorText), editorText.slice(0, 200));
    check('the editor reports a line count', /0 行/.test(editorText));
    check('the editor reports a paragraph count', /0 段/.test(editorText));
    const toggles = findAll(editorTree, (n) => n.type === 'button' && text(n) === '预览');
    check('the persona field carries a preview switch', toggles.length === 1, String(toggles.length));

    if (toggles.length === 1) {
      // Type a body, then switch to the preview: the textarea must be replaced by
      // rendered blocks, with the marks gone and the headings kept.
      const area = findAll(editorTree, (n) => n.type === 'textarea')[0];
      area.props.onChange({ target: { value: '## 标题\n\n正文 **加粗** 与 `代码`。\n\n- 第一项\n- 第二项' } });
      hookIndex = 0;
      pendingEffects = [];
      const withBody = expand(slots.Component({ close() {} }));
      const bodyText = text(withBody);
      check('the count follows the typed text', bodyText.includes('字') && !/0 字/.test(bodyText), bodyText.slice(0, 120));

      const sw = findAll(withBody, (n) => n.type === 'button' && text(n) === '预览');
      sw[0].props.onClick();
      hookIndex = 0;
      pendingEffects = [];
      const previewTree = expand(slots.Component({ close() {} }));
      check('preview hides the textarea', findAll(previewTree, (n) => n.type === 'textarea').length === 0);
      // Scope every count to the preview box: the page has its own h2 title and
      // the card lists are ul/li too, so a whole-tree count would prove nothing.
      const previewBox = findAll(previewTree, (n) => n.type === 'div' && n.props.style && n.props.style.maxHeight === '420px');
      check('the preview box is present', previewBox.length === 1, String(previewBox.length));
      const scope = previewBox[0] ?? previewTree;
      check('preview renders a heading', findAll(scope, (n) => n.type === 'h2').length === 1, String(findAll(scope, (n) => n.type === 'h2').length));
      check('preview renders list items', findAll(scope, (n) => n.type === 'li').length === 2, String(findAll(scope, (n) => n.type === 'li').length));
      check('preview renders bold and code as elements', findAll(scope, (n) => n.type === 'strong').length === 1 && findAll(scope, (n) => n.type === 'code').length === 1);
      const previewText = text(scope);
      check('preview keeps the words', previewText.includes('标题') && previewText.includes('加粗') && previewText.includes('代码'), previewText);
      // A persona is untrusted text: a tag written in the body must stay visible
      // text, never become an element. The only `pre` the renderer may produce
      // comes from an actual ``` fence.
      {
        const area2 = findAll(withBody, (n) => n.type === 'textarea')[0];
        area2.props.onChange({ target: { value: '正文 <img src=x onerror=alert(1)> 结束' } });
        hookIndex = 0;
        pendingEffects = [];
        expand(slots.Component({ close() {} })); // re-render with the new body
        hookIndex = 0;
        pendingEffects = [];
        const injected = expand(slots.Component({ close() {} }));
        const box = findAll(injected, (n) => n.type === 'div' && n.props.style && n.props.style.maxHeight === '420px')[0];
        check('a tag written in the body stays text', findAll(box, (n) => n.type === 'img').length === 0);
        check('and it is still readable', text(box).includes('<img'));
      }
      check(
        'the switch becomes "back to edit"',
        findAll(previewTree, (n) => n.type === 'button' && text(n) === '返回编辑').length === 1,
      );
    }
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

// --- saving closes the editor on success and keeps it on failure -----------
// A rejected write must leave the typed body in place: the user has to be able
// to fix the field that was wrong without retyping the whole persona.
stateSlots = [];
writeFailure = null;
stateResponse = {
  ok: true,
  ready: true,
  managed: [],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

/**
 * Render the page from the current state, flushing the effects it schedules.
 *
 * Every render has to start its hook slots from zero: the component's hook list
 * is replayed per render, so a stale counter silently shifts every following
 * `useState`/`useCallback` onto the wrong slot.
 *
 * `flushEffects: false` renders the state as it stands. This stub records
 * effects on every render, while real React only re-runs one when its deps
 * change, so flushing again would re-run the mount fetch — and `refresh()`
 * starts by clearing the error the previous step just set.
 */
function renderPage(options) {
  const flushEffects = options?.flushEffects !== false;
  hookIndex = 0;
  pendingEffects = [];
  slots.Component({ close() {} });
  if (flushEffects) {
    for (const effect of pendingEffects.splice(0)) {
      try {
        effect();
      } catch (err) {
        console.log('  effect threw:', err.message);
      }
    }
  }
  pendingEffects = [];
  hookIndex = 0;
  return expand(slots.Component({ close() {} }));
}

/** Fill the open editor and click Save; returns the tree rendered afterwards. */
async function fillAndSave(value) {
  const area = findAll(renderPage(), (n) => n.type === 'textarea')[0];
  area.props.onChange({ target: { value } });
  const withBody = renderPage();
  const saveButton = findAll(withBody, (n) => n.type === 'button' && text(n) === '保存')[0];
  saveButton.props.onClick();
  // `save` awaits `run`, which awaits the host call, which awaits the response
  // body: three hops before the outcome reaches state. Draining the queue a
  // fixed number of times would be a guess, so drain it until it stops moving.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return renderPage({ flushEffects: false });
}

{
  const fresh = await settle();
  const newBtn = findAll(fresh, (n) => n.type === 'button' && text(n).includes('新建预设'))[0];
  newBtn.props.onClick();
  renderPage();

  // Failure first: the editor must survive with the body still in it.
  writeFailure = { status: 400, error: 'id must use lowercase letters, digits and hyphens' };
  const afterFail = await fillAndSave('## 失败也要留住这段正文');
  check(
    'a rejected save keeps the editor open',
    findAll(afterFail, (n) => n.type === 'textarea').length === 1,
  );
  check(
    'a rejected save keeps the typed body',
    String(findAll(afterFail, (n) => n.type === 'textarea')[0]?.props.value ?? '').includes('失败也要留住这段正文'),
  );
  check(
    'a rejected save shows why',
    text(afterFail).includes('lowercase letters'),
    text(afterFail).slice(0, 160),
  );

  // Success: same click, a host that accepts it, editor goes away.
  writeFailure = null;
  const afterOk = await fillAndSave('## 保存成功这段应该消失');
  check(
    'a successful save closes the editor',
    findAll(afterOk, (n) => n.type === 'textarea').length === 0,
  );
  check(
    'a successful save says so',
    text(afterOk).includes('预设已创建'),
    text(afterOk).slice(0, 160),
  );
}

// --- saving an existing preset closes it too -------------------------------
stateSlots = [];
writeFailure = null;
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
      persona: '原正文',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'library',
      editable: true,
    },
  ],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const listTree = await settle();
  const editButtons = findAll(listTree, (n) => n.type === 'button' && text(n) === '编辑');
  check('the managed card offers an edit action', editButtons.length === 1, String(editButtons.length));
  if (editButtons.length === 1) {
    editButtons[0].props.onClick();
    const editing = renderPage();
    check('editing an existing preset opens the editor', findAll(editing, (n) => n.type === 'textarea').length === 1);

    // Failure on update keeps the panel too, not just on create.
    writeFailure = { status: 500, error: 'cannot write the library' };
    const failedUpdate = await fillAndSave('改了一点');
    check(
      'a rejected update keeps the editor open',
      findAll(failedUpdate, (n) => n.type === 'textarea').length === 1,
    );

    writeFailure = null;
    const okUpdate = await fillAndSave('改好了');
    check(
      'a successful update closes the editor',
      findAll(okUpdate, (n) => n.type === 'textarea').length === 0,
    );
  }
}

// --- importing a Markdown file opens a draft with the file's text ----------
// A `.md` file carries prose only, so it cannot be merged into the library: the
// editor opens with the text loaded and every other field at its own default.
stateSlots = [];
writeFailure = null;
stateResponse = {
  ok: true,
  ready: true,
  managed: [],
  builtin: [
    { id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 },
    { id: 'ptc', name: 'PTC 模式', broken: null, kind: 'shipped', order: 2 },
  ],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const beforeImport = await settle();
  const fileInput = findAll(beforeImport, (n) => n.type === 'input' && n.props.type === 'file')[0];
  check('the toolbar offers a file input', fileInput !== undefined);

  if (fileInput !== undefined) {
    fileInput.props.onChange({
      target: {
        files: [{ name: '我的角色.md', __text: '## 标题\r\n\r\n正文内容' }],
        value: 'C:\\fakepath\\我的角色.md',
      },
    });
    const afterImport = renderPage();
    check('a Markdown import opens the editor', findAll(afterImport, (n) => n.type === 'textarea').length === 1);

    // The two fields that share a row, read by position rather than by guessing
    // a selector. Index 0 is the toolbar's hidden file input, so the row starts
    // at 1: id, then name, then order.
    const rowInputs = findAll(afterImport, (n) => n.type === 'input').filter((n) => n.props.type !== 'file');
    const idValue = rowInputs[0]?.props.value;
    const nameValue = rowInputs[1]?.props.value;
    const orderValue = rowInputs[2]?.props.value;
    check('an imported id starts empty', idValue === '', JSON.stringify(idValue));
    check('the file name seeds the display name', nameValue === '我的角色', JSON.stringify(nameValue));
    // A fixed 100 used to be hard-coded here while every other new draft took
    // `max + 1`, so two presets could share an order and the list fell back to
    // alphabetical id. The shipped presets in this fixture are 1 and 2, so the
    // imported draft must land on 3.
    check('the imported draft takes the next free order', orderValue === 3, JSON.stringify(orderValue));
    check(
      'the imported body lands in the persona field',
      String(findAll(afterImport, (n) => n.type === 'textarea')[0]?.props.value ?? '').includes('正文内容'),
    );
    check(
      'CRLF is normalised on import',
      !String(findAll(afterImport, (n) => n.type === 'textarea')[0]?.props.value ?? '').includes('\r'),
    );
  }
}

// --- the export panel and the editor never show at once --------------------
// Both are tall panels above the list. Rendering them together pushed the
// second one below the fold and gave the page two competing main tasks.
stateSlots = [];
writeFailure = null;
stateResponse = {
  ok: true,
  ready: true,
  managed: [],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const start = await settle();
  const newBtn = findAll(start, (n) => n.type === 'button' && text(n).includes('新建预设'))[0];
  newBtn.props.onClick();
  const withEditor = renderPage();
  check('the editor is open before exporting', findAll(withEditor, (n) => n.type === 'textarea').length === 1);

  // Type something first: it has to survive a round trip through the export
  // panel, otherwise opening export silently destroys the draft.
  const area = findAll(withEditor, (n) => n.type === 'textarea')[0];
  area.props.onChange({ target: { value: '导出期间不要弄丢这段' } });
  const typed = renderPage();

  const exportBtn = findAll(typed, (n) => n.type === 'button' && text(n) === '导出')[0];
  check('the toolbar offers an export action', exportBtn !== undefined);
  exportBtn.props.onClick();
  const exporting = renderPage();

  check(
    'opening export hides the editor',
    findAll(exporting, (n) => n.type === 'textarea').length === 0,
    `still ${findAll(exporting, (n) => n.type === 'textarea').length}`,
  );
  check('opening export shows one panel', findAll(exporting, (n) => n.type === 'button' && text(n) === '导出').length >= 1);

  // Cancel goes back to the draft, body intact.
  const cancel = findAll(exporting, (n) => n.type === 'button' && text(n) === '取消')[0];
  check('the export panel can be cancelled', cancel !== undefined);
  cancel.props.onClick();
  const back = renderPage();
  check('cancelling export brings the editor back', findAll(back, (n) => n.type === 'textarea').length === 1);
  check(
    'the draft survived the export panel',
    String(findAll(back, (n) => n.type === 'textarea')[0]?.props.value ?? '').includes('导出期间不要弄丢这段'),
  );

  // Opening the editor from inside the export panel. The panels are mutually
  // exclusive, so the action the user just clicked has to win: a New preset
  // that leaves the export panel on screen looks like the button did nothing.
  exportBtn.props.onClick();
  const exportingAgain = renderPage();
  check('export reopens from the draft', findAll(exportingAgain, (n) => n.type === 'textarea').length === 0);

  const newFromExport = findAll(exportingAgain, (n) => n.type === 'button' && text(n).includes('新建预设'))[0];
  newFromExport.props.onClick();
  const afterNewFromExport = renderPage();
  check(
    'New preset from inside export switches to the editor',
    findAll(afterNewFromExport, (n) => n.type === 'textarea').length === 1,
  );
  check(
    'New preset from inside export clears the draft body',
    String(findAll(afterNewFromExport, (n) => n.type === 'textarea')[0]?.props.value ?? '') === '',
  );
}

// The same rule for editing an existing card, which does not go through
// `openNew`: it sets the selection directly.
stateSlots = [];
stateResponse = {
  ok: true,
  ready: true,
  managed: [
    {
      id: 'demo',
      name: '演示卡片',
      description: '',
      order: 1,
      basePreset: 'whale',
      persona: '原有正文',
      pluginCount: 22,
      active: true,
      broken: null,
      origin: 'library',
      editable: true,
    },
  ],
  builtin: [{ id: 'standard', name: '标准模式', isDefault: true, broken: null, kind: 'shipped', order: 1 }],
  warnings: [],
  libraryPath: '/tmp/x.json',
};

{
  const list = await settle();
  const openExport = findAll(list, (n) => n.type === 'button' && text(n) === '导出')[0];
  openExport.props.onClick();
  const exporting = renderPage();
  check('export opens with a card present', findAll(exporting, (n) => n.type === 'textarea').length === 0);

  const editBtn = findAll(exporting, (n) => n.type === 'button' && text(n) === '编辑')[0];
  check('the card edit action is still reachable', editBtn !== undefined);
  editBtn.props.onClick();
  const afterEdit = renderPage();
  check(
    'editing a card from inside export switches to the editor',
    findAll(afterEdit, (n) => n.type === 'textarea').length === 1,
  );
  check(
    'the edited body is the card body',
    String(findAll(afterEdit, (n) => n.type === 'textarea')[0]?.props.value ?? '') === '原有正文',
  );
}

console.log(failures === 0 ? '\nall render checks passed' : `\n${failures} render check(s) failed`);
if (failures !== 0) process.exitCode = 1;
