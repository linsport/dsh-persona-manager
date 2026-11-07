/**
 * dsh-persona-manager — Client half.
 *
 * One page under Settings that lists every persona preset on this machine: the
 * ones this plugin owns (editable) and the ones other bundles declare (listed
 * read-only, so the page is the single place to look at all of them).
 *
 * Styling is inline for a reason: a plugin stylesheet has to reach the slot's
 * rendered DOM, and a `<style>` element in `document.head` does not always do
 * that — the page can render inside a different root, and a blocked or dropped
 * stylesheet degrades to unstyled text, which is exactly what a user must never
 * see. Inline styles travel with the elements themselves, so the page is styled
 * the moment it renders, in any rendering root.
 *
 * The metric values mirror the shipped Agent preset page: a 720px column,
 * 268px minimum card width, 12px gaps, half-pixel card strokes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-persona-manager';
    const BASE = '/api/dsh-persona-manager';
    const CSRF = { 'x-persona-manager': '1' };
    const NEW = '__new__';

    /* ----------------------------------------------------------------- i18n */

    const TEXT = {
      en: {
        section: 'Persona presets',
        title: 'Persona presets',
        intro: 'A preset is one persona body plus the tool surface copied from a base preset. Saved changes apply to sessions you start afterwards.',
        newPreset: 'New preset',
        refresh: 'Refresh',
        export: 'Export',
        exportTitle: 'Export presets',
        exportScope: 'What to export',
        exportAll: 'All presets managed here',
        exportFormat: 'Format',
        formatJson: 'JSON backup (id, name, order, base preset, persona)',
        formatMarkdown: 'Markdown (persona body only)',
        exportOne: 'Export',
        exportHintAll: 'A JSON backup covers every editable preset and can be imported again. Markdown carries only the persona text, so it exports one preset at a time.',
        exportMarkdownAll: 'Markdown exports one preset at a time — pick a preset above.',
        cancelExport: 'Cancel',
        import: 'Import',
        ownTitle: 'Managed here',
        shippedTitle: 'Built in (read-only)',
        bundledTitle: 'Provided by installed plugins (read-only)',
        originProfile: 'profile',
        originBundle: 'bundled',
        editable: 'editable',
        inactive: 'inactive',
        isDefault: 'default',
        builtIn: 'built-in',
        custom: 'custom',
        broken: 'broken',
        edit: 'Edit',
        copyAsNew: 'Copy',
        newTitle: 'New persona preset',
        editTitle: (name) => `Edit “${name}”`,
        idLabel: 'Id',
        nameLabel: 'Display name',
        descriptionLabel: 'Description',
        orderLabel: 'Order',
        baseLabel: 'Base preset (supplies the tool surface)',
        basePlaceholder: '— choose a base preset —',
        baseLockedHint: 'This preset is declared in your profile patch and carries its own plugin list, so it has no base preset. Edit or add plugins in cordis.patch.yml to change its tool surface.',
        baseLockedOption: '— none (declared in the profile patch) —',
        personaLabel: 'Persona body',
        personaPlaceholder: 'Paste the persona text here. It replaces the base preset’s persona prefix.',
        save: 'Save',
        duplicate: 'Duplicate',
        remove: 'Delete',
        cancel: 'Cancel',
        chars: (n) => `${n} chars`,
        libraryFile: (path) => `Library file: ${path}`,
        libraryKeep: 'Uninstalling this plugin does not delete that file. The presets listed here will stop appearing in session presets, but their text stays on disk — reinstall the plugin, or export a JSON backup first, to keep them.',
        confirmDelete: (name) => `Delete preset “${name}”? Its persona text is removed from this machine. Presets declared by other plugins are not touched.`,
        created: 'Preset created.',
        saved: 'Preset saved.',
        deleted: 'Preset deleted.',
        exported: 'Exported.',
        imported: 'Imported.',
        badJson: (message) => `The file is not valid JSON: ${message}`,
        importedMarkdown: (name) => `“${name}” loaded into the editor. Set an id and name, then save.`,
        idHint: 'lowercase letters, digits, hyphens',
        pluginCount: (n) => `${n} plugins`,
        emptyOwn: 'No persona presets yet. Create one.',
        emptyExt: 'No other presets on this machine.',
        examples: 'Bundled examples',
        examplesHint: 'Sample personas that ship with this plugin. Loading one fills the editor — it does not add a preset until you save it.',
        loadExample: 'Load',
        loadExampleInto: (name) => `Load “${name}” into the editor`,
        loadedExample: (name) => `“${name}” loaded into the editor. Set an id and name, then save.`,
      },
      zh: {
        section: '人设预设管理',
        title: '人设预设',
        intro: '一个预设 = 一段人设正文 + 从基准预设复制来的工具面。保存后，之后新开的会话才能选到它。',
        newPreset: '新建预设',
        refresh: '刷新',
        export: '导出',
        exportTitle: '导出预设',
        exportScope: '导出范围',
        exportAll: '本插件管理里的全部预设',
        exportFormat: '格式',
        formatJson: 'JSON 备份（ID、名称、排序、基准预设、人设正文）',
        formatMarkdown: 'Markdown（仅人设正文）',
        exportOne: '导出',
        exportHintAll: 'JSON 备份包含全部可编辑预设，可以直接再导入恢复；Markdown 只有人设正文，因此一次只能导出一个预设。',
        exportMarkdownAll: 'Markdown 一次只能导出一个预设——请先在上面选定一个。',
        cancelExport: '取消',
        import: '导入',
        ownTitle: '本插件管理',
        shippedTitle: '内置预设（只读）',
        bundledTitle: '插件包自带（只读）',
        originProfile: '配置行',
        originBundle: '插件包',
        editable: '可编辑',
        inactive: '未生效',
        isDefault: '默认',
        builtIn: '内置',
        custom: '自定义',
        broken: '异常',
        edit: '编辑',
        copyAsNew: '复制',
        newTitle: '新建人设预设',
        editTitle: (name) => `编辑「${name}」`,
        idLabel: 'ID',
        nameLabel: '显示名称',
        descriptionLabel: '说明',
        orderLabel: '排序',
        baseLabel: '基准预设（提供工具面）',
        basePlaceholder: '— 选择一个基准预设 —',
        baseLockedHint: '这个预设是配置行直接声明的，插件列表写在它自己那一行里，因此没有「基准预设」可换。要改工具面，请到 cordis.patch.yml 里改那一行的插件列表。',
        baseLockedOption: '— 无（由配置行声明） —',
        personaLabel: '人设正文',
        personaPlaceholder: '把人设正文粘贴到这里。它会替换基准预设里的 persona 前缀。',
        save: '保存',
        duplicate: '复制一份',
        remove: '删除',
        cancel: '取消',
        chars: (n) => `${n} 字`,
        libraryFile: (path) => `存储文件：${path}`,
        libraryKeep: '卸载本插件不会删除这个文件。这里列出的预设会从会话预设里消失，但正文仍留在磁盘上——想保住它们，先导出一份 JSON 备份，或之后重新装回本插件。',
        confirmDelete: (name) => `删除预设「${name}」？它的人设正文会从本机移除。其他插件声明的预设不会被改动。`,
        created: '预设已创建。',
        saved: '预设已保存。',
        deleted: '预设已删除。',
        exported: '已导出。',
        imported: '已导入。',
        badJson: (message) => `文件不是合法的 JSON：${message}`,
        importedMarkdown: (name) => `已把「${name}」的内容读入编辑器，填好 ID 和名称后保存即可。`,
        idHint: '小写字母、数字、连字符',
        pluginCount: (n) => `${n} 个插件`,
        emptyOwn: '还没有预设，点上面的「新建预设」开始。',
        emptyExt: '本机没有其他预设。',
        examples: '附赠示例',
        examplesHint: '随本插件一同发布的示例人设。载入只是填进编辑器，不会自动新增预设——保存之后才算你的。',
        loadExample: '载入',
        loadExampleInto: (name) => `把「${name}」载入编辑器`,
        loadedExample: (name) => `已把「${name}」载入编辑器，填好 ID 和名称后保存即可。`,
      },
    };

    function pickLanguage() {
      try {
        return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    const t = TEXT[pickLanguage()];

    /* ------------------------------------------------------------ transport */

    async function callHost(action, options) {
      const init = Object.assign({}, options || {});
      init.headers = Object.assign({}, CSRF, init.headers || {});
      if (init.body !== undefined && typeof init.body !== 'string') {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(init.body);
      }
      const response = await fetch(`${BASE}/${action}`, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok === false) {
        const message = payload && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    }

    /* ---------------------------------------------------------------- theme */

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    /**
     * Resolve a host theme token to a concrete colour.
     *
     * Inline styles cannot carry `var(...)` fallbacks the way a stylesheet can,
     * and a token whose name changed in a newer DSH would resolve to nothing.
     * Reading the computed value once per render keeps the palette live while
     * still guaranteeing a usable colour when a token is absent.
     */
    const TOKEN_FALLBACK = {
      '--dsw-alias-label-primary': '#e8e8e8',
      '--dsw-alias-label-secondary': '#a8a8a8',
      '--dsw-alias-label-tertiary': '#8a8a8a',
      '--dsw-alias-bg-base': '#171717',
      '--dsw-alias-bg-layer-1': '#1f1f1f',
      '--dsw-alias-bg-layer-2': '#262626',
      '--dsw-alias-bg-layer-3': '#ffffff',
      '--dsw-alias-border-l1': '#2e2e2e',
      '--dsw-alias-border-l2': '#3a3a3a',
      '--dsw-alias-border-l3': '#4a4a4a',
      '--dsw-alias-brand-primary': '#4d6bfe',
      '--dsw-alias-state-error-primary': '#ff5f5f',
      '--dsw-alias-state-warn-primary': '#e0a030',
    };

    function tokenReader() {
      let root = null;
      let values = null;
      const read = () => {
        if (typeof document === 'undefined' || !document.documentElement) return {};
        if (root === document.documentElement && values !== null) return values;
        let computed = null;
        try {
          computed = getComputedStyle(document.documentElement);
        } catch {
          computed = null;
        }
        const next = {};
        for (const [name, fallback] of Object.entries(TOKEN_FALLBACK)) {
          let resolved = '';
          if (computed !== null) {
            try {
              resolved = String(computed.getPropertyValue(name) || '').trim();
            } catch {
              resolved = '';
            }
          }
          next[name] = resolved !== '' ? resolved : fallback;
        }
        root = document.documentElement;
        values = next;
        return next;
      };
      return (name) => {
        const sources = read();
        return sources[name] ?? TOKEN_FALLBACK[name] ?? 'inherit';
      };
    }

    const color = tokenReader();

    /* --------------------------------------------------------------- styles */

    function buildStyles() {
      return {
      root: {
        maxWidth: '720px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        color: color('--dsw-alias-label-primary'),
        fontSize: '13px',
        lineHeight: 1.5,
      },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: 1.4 },
      intro: {
        margin: 0,
        fontSize: '13px',
        lineHeight: 1.55,
        color: color('--dsw-alias-label-tertiary'),
      },
      hint: {
        margin: 0,
        fontSize: '12px',
        color: color('--dsw-alias-label-tertiary'),
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap',
      },
      error: {
        margin: 0,
        fontSize: '12px',
        color: color('--dsw-alias-state-error-primary'),
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      warn: {
        margin: 0,
        fontSize: '12px',
        color: color('--dsw-alias-state-warn-primary'),
        whiteSpace: 'pre-wrap',
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      spacer: { flex: '1 1 auto' },
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      groupHead: {
        margin: 0,
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '.06em',
        textTransform: 'uppercase',
        color: color('--dsw-alias-label-tertiary'),
      },
      cards: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))',
        gap: '12px',
        margin: 0,
        padding: 0,
        listStyle: 'none',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: color('--dsw-alias-border-l1'),
        borderRadius: '12px',
        background: color('--dsw-alias-bg-layer-1'),
        overflow: 'hidden',
      },
      cardActive: { borderColor: color('--dsw-alias-brand-primary') },
      cardHover: { background: color('--dsw-alias-bg-layer-2') },
      cardBroken: { borderColor: color('--dsw-alias-state-error-primary') },
      cardMain: {
        appearance: 'none',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'transparent',
        border: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px 12px',
        width: '100%',
        boxSizing: 'border-box',
      },
      cardHead: { display: 'flex', alignItems: 'flex-start', gap: '12px' },
      cardIdentity: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      },
      cardName: {
        minWidth: 0,
        fontSize: '15px',
        fontWeight: 600,
        lineHeight: 1.4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      cardId: {
        maxWidth: '45%',
        flexShrink: 0,
        fontFamily: MONO,
        fontSize: '11px',
        lineHeight: '21px',
        color: color('--dsw-alias-label-tertiary'),
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      cardDesc: {
        margin: 0,
        marginTop: 'auto',
        fontSize: '13px',
        lineHeight: 1.55,
        color: color('--dsw-alias-label-secondary'),
        overflowWrap: 'anywhere',
        display: '-webkit-box',
        WebkitLineClamp: 3,
        minHeight: '3.1em',
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      cardFoot: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: '2px',
        padding: '6px 10px',
        borderTopWidth: '0.5px',
        borderTopStyle: 'solid',
        borderTopColor: color('--dsw-alias-border-l2'),
      },
      cardMeta: {
        marginRight: 'auto',
        fontSize: '11px',
        lineHeight: '21px',
        color: color('--dsw-alias-label-tertiary'),
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      tag: {
        flexShrink: 0,
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '11px',
        fontWeight: 500,
        lineHeight: '17px',
        whiteSpace: 'nowrap',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: color('--dsw-alias-border-l3'),
        color: color('--dsw-alias-label-secondary'),
      },
      tagSolid: {
        borderColor: color('--dsw-alias-brand-primary'),
        background: color('--dsw-alias-brand-primary'),
        color: color('--dsw-alias-bg-layer-3'),
      },
      tagOwn: {
        borderColor: color('--dsw-alias-brand-primary'),
        color: color('--dsw-alias-brand-primary'),
      },
      tagBroken: {
        borderColor: color('--dsw-alias-state-error-primary'),
        background: color('--dsw-alias-state-error-primary'),
        color: color('--dsw-alias-bg-layer-3'),
      },
      btn: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '12px',
        minHeight: '28px',
        padding: '5px 8px',
        borderRadius: '6px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'transparent',
        background: 'transparent',
        color: color('--dsw-alias-label-tertiary'),
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      btnQuiet: { borderColor: color('--dsw-alias-border-l2') },
      btnDanger: { color: color('--dsw-alias-state-error-primary') },
      primary: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        minHeight: '32px',
        padding: '5px 14px',
        borderRadius: '8px',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: color('--dsw-alias-brand-primary'),
        background: color('--dsw-alias-brand-primary'),
        color: color('--dsw-alias-bg-layer-3'),
        cursor: 'pointer',
      },
      panel: {
        display: 'flex',
        flexDirection: 'column',
        // The fields carry a horizontal `flex` basis for their row, and this is a
        // column container: without this the basis stretches them vertically and
        // leaves large gaps between the rows.
        alignItems: 'stretch',
        flexWrap: 'nowrap',
        gap: '12px',
        padding: '16px',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: color('--dsw-alias-border-l1'),
        borderRadius: '12px',
        background: color('--dsw-alias-bg-layer-1'),
      },
      panelHead: { display: 'flex', alignItems: 'center', gap: '10px' },
      panelTitle: { margin: 0, flex: 1, minWidth: 0, fontSize: '15px', fontWeight: 600 },
      row: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 200px', minWidth: 0 },
      fieldNarrow: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 1 96px' },
      // A field that is a direct child of the panel: the panel is a column, so a
      // horizontal flex basis there would become a HEIGHT and leave a gap between
      // rows. These stack at their natural height instead.
      fieldStacked: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto', minWidth: 0 },
      label: { fontSize: '12px', color: color('--dsw-alias-label-secondary') },
      labelTail: { color: color('--dsw-alias-label-tertiary') },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '13px',
        minHeight: '32px',
        padding: '6px 10px',
        borderRadius: '8px',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: color('--dsw-alias-border-l2'),
        background: color('--dsw-alias-bg-layer-2'),
        color: color('--dsw-alias-label-primary'),
        outline: 'none',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontFamily: MONO,
        fontSize: '12.5px',
        lineHeight: 1.6,
        minHeight: '300px',
        resize: 'vertical',
        padding: '10px',
        borderRadius: '8px',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: color('--dsw-alias-border-l2'),
        background: color('--dsw-alias-bg-layer-2'),
        color: color('--dsw-alias-label-primary'),
        outline: 'none',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      footer: { display: 'flex', flexDirection: 'column', gap: '4px' },
      stack: { display: 'flex', flexDirection: 'column', gap: '6px' },
      inputLocked: { opacity: 0.7, cursor: 'not-allowed' },
      count: { marginLeft: 'auto', fontSize: '11px', color: color('--dsw-alias-label-tertiary') },
      };
    }

    function merge(base, extra) {
      return extra === undefined ? base : Object.assign({}, base, extra);
    }

    /* ----------------------------------------------------------- components */

    function Field(props) {
      const S = props.styles;
      return h(
        'label',
        { style: props.stacked ? S.fieldStacked : props.narrow ? S.fieldNarrow : S.field },
        h(
          'span',
          { style: S.label },
          props.label,
          props.tail === undefined
            ? null
            : h('span', { style: S.labelTail }, ` · ${props.tail}`),
        ),
        props.children,
      );
    }

    function Tag(props) {
      const S = props.styles;
      return h('span', { style: merge(S.tag, props.extra), title: props.title }, props.children);
    }

    /**
     * One preset card, laid out like the shipped Agent preset page:
     *
     *   ┌─────────────────────────────────────┐
     *   │ Name  [tag] [tag]             id    │   header: identity left, id right
     *   │ Description spanning three lines    │
     *   ├─────────────────────────────────────┤
     *   │ 22 plugins                  Edit Del │   footer: meta left, actions right
     *   └─────────────────────────────────────┘
     *
     * The id sits on the right rather than beside the name so the name never has
     * to share its line with a monospace string; the footer carries one short
     * fact, not a second copy of the id.
     */
    function PresetCard(props) {
      const S = props.styles;
      const row = props.row;
      // A shipped preset publishes both languages; pick the one in use.
      const lang = t === TEXT.zh ? 'zh' : 'en';
      const rowName = row.names ? row.names[lang] : row.name ?? row.id;
      const rowDesc = row.descriptions ? row.descriptions[lang] : row.description;
      const [hovered, setHovered] = useState(false);

      const cardStyle = merge(
        S.card,
        row.broken
          ? S.cardBroken
          : row.active === true
            ? S.cardActive
            : hovered
              ? S.cardHover
              : undefined,
      );

      const tags = [];
      if (props.managed === true) {
        tags.push(h(Tag, { key: 'own', styles: S, extra: S.tagOwn }, t.editable));
        if (row.origin === 'profile') tags.push(h(Tag, { key: 'org', styles: S }, t.originProfile));
        if (row.active !== true) tags.push(h(Tag, { key: 'off', styles: S }, t.inactive));
      } else if (row.isDefault === true) {
        tags.push(h(Tag, { key: 'def', styles: S, extra: S.tagSolid }, t.isDefault));
      } else {
        tags.push(h(Tag, { key: 'grp', styles: S }, props.groupLabel));
      }
      if (row.broken) tags.push(h(Tag, { key: 'br', styles: S, extra: S.tagBroken }, t.broken));

      const meta = props.managed === true ? t.pluginCount(row.pluginCount ?? 0) : '';
      const actions = props.managed === true
        ? [
            h('button', { key: 'e', type: 'button', style: S.btn, onClick: props.onEdit }, t.edit),
            h(
              'button',
              { key: 'd', type: 'button', style: merge(S.btn, S.btnDanger), onClick: props.onDelete },
              t.remove,
            ),
          ]
        : [h('button', { key: 'c', type: 'button', style: S.btn, onClick: props.onCopy }, t.copyAsNew)];

      return h(
        'li',
        {
          style: cardStyle,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
        },
        h(
          'button',
          {
            type: 'button',
            style: S.cardMain,
            onClick: props.managed === true ? props.onEdit : props.onCopy,
            title: props.managed === true ? t.edit : t.copyAsNew,
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          },
          h(
            'span',
            { style: S.cardHead },
            h(
              'span',
              { style: S.cardIdentity },
              h('span', { style: S.cardName, title: rowName }, rowName),
              tags,
            ),
            h('span', { style: S.cardId, title: row.id }, row.id),
          ),
          h('span', { style: S.cardDesc }, rowDesc && rowDesc !== '' ? rowDesc : ' '),
        ),
        h(
          'div',
          { style: S.cardFoot },
          h('span', { style: S.cardMeta, title: meta }, meta),
          actions,
        ),
        row.broken
          ? h('p', { style: Object.assign({}, S.error, { padding: '0 16px 12px' }) }, row.broken)
          : null,
      );
    }

    /* -------------------------------------------------------------- the page */

    function PersonaManagerPage() {
      // Rebuilt per render: the host theme can change after this module loads.
      const S = buildStyles();
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [selectedId, setSelectedId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [exportOpen, setExportOpen] = useState(false);
      const [exportScope, setExportScope] = useState('');
      const [exportFormat, setExportFormat] = useState('json');
      const importRef = useRef(null);

      const refresh = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const next = await callHost('state');
          setState(next);
          return next;
        } catch (err) {
          setError(err.message);
          return null;
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const managed = useMemo(() => state?.managed ?? [], [state]);
      const builtin = useMemo(() => state?.builtin ?? [], [state]);
      const shipped = useMemo(() => builtin.filter((row) => row.kind === 'shipped'), [builtin]);
      const bundled = useMemo(() => builtin.filter((row) => row.kind !== 'shipped'), [builtin]);
      const [examples, setExamples] = useState([]);

      // The bundled samples are read once on mount. They ship inside the plugin,
      // so they cannot change while the page is open.
      useEffect(() => {
        let alive = true;
        callHost('examples')
          .then((payload) => {
            if (alive) setExamples(Array.isArray(payload.examples) ? payload.examples : []);
          })
          .catch(() => {
            /* A missing examples folder is not an error: there is just nothing
               to offer, and the rest of the page must keep working. */
          });
        return () => {
          alive = false;
        };
      }, []);

      const selected = useMemo(() => {
        if (selectedId === null || selectedId === NEW) return null;
        return managed.find((row) => row.id === selectedId) ?? null;
      }, [managed, selectedId]);

      // Loading the editor from the selection must not clobber a draft the user
      // just started through "New preset" or "Copy".
      useEffect(() => {
        if (selectedId === NEW) return;
        if (selected === null) {
          setDraft(null);
          return;
        }
        setDraft({
          id: selected.id,
          name: selected.name,
          description: selected.description,
          order: selected.order,
          basePreset: selected.basePreset ?? '',
          basePresetLocked: selected.basePresetLocked === true,
          persona: selected.persona,
          isNew: false,
        });
      }, [selectedId, selected]);

      const run = useCallback(async (task, successText) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const result = await task();
          if (result !== undefined && result !== null && result.ok === true) setState(result);
          if (successText) setNotice(successText);
          return result;
        } catch (err) {
          setError(err.message);
          return null;
        } finally {
          setBusy(false);
        }
      }, []);

      const openNew = useCallback((seed) => {
        setNotice(null);
        setSelectedId(NEW);
        setDraft(seed);
      }, []);

      /**
       * The order a new preset should take: one past the highest existing one.
       *
       * A fixed 100 gave every preset created here the same number, so their
       * relative order fell back to alphabetical id and the field meant nothing.
       * Taking `max + 1` means a new preset always lands after the ones it was
       * created next to, which is what a user expects from "new".
       */
      const nextOrder = useMemo(() => {
        let highest = 0;
        for (const row of [...managed, ...builtin]) {
          if (Number.isFinite(row.order) && row.order > highest) highest = row.order;
        }
        return highest + 1;
      }, [managed, builtin]);

      const startNew = useCallback(() => {
        openNew({
          id: '',
          name: '',
          description: '',
          order: nextOrder,
          basePreset: builtin[0]?.id ?? '',
          basePresetLocked: false,
          persona: '',
          isNew: true,
        });
      }, [builtin, nextOrder, openNew]);

      const save = useCallback(() => {
        if (draft === null) return;
        const payload = {
          id: draft.id.trim(),
          name: draft.name,
          description: draft.description,
          order: Number(draft.order),
          persona: draft.persona,
          basePreset: draft.basePreset,
        };
        // A profile-declared preset has no base to change: sending the field
        // would promise an edit this page cannot carry out.
        if (draft.basePresetLocked === true) delete payload.basePreset;
        if (draft.isNew) {
          const newId = payload.id;
          run(async () => {
            const next = await callHost('create', { method: 'POST', body: payload });
            setSelectedId(newId);
            return next;
          }, t.created);
          return;
        }
        run(() => callHost('update', { method: 'POST', body: payload }), t.saved);
      }, [draft, run]);

      const removeFrom = useCallback(
        (row) => {
          const id = row.id;
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm(t.confirmDelete(row.name || id))) return;
          }
          run(async () => {
            const next = await callHost('delete', { method: 'POST', body: { id } });
            if (selectedId === id) {
              setSelectedId(null);
              setDraft(null);
            }
            return next;
          }, t.deleted);
        },
        [run, selectedId],
      );

      const duplicate = useCallback(() => {
        if (selected === null) return;
        openNew({
          id: '',
          name: `${selected.name} copy`,
          description: selected.description,
          order: nextOrder,
          // A profile-declared preset carries its plugins inline and has no base
          // to copy from, so the copy starts from the first shipped preset and
          // gets its own tool surface — the only way a copy can be saved here.
          basePreset: selected.basePreset ?? builtin[0]?.id ?? '',
          basePresetLocked: false,
          persona: selected.persona,
          isNew: true,
        });
      }, [selected, builtin, nextOrder, openNew]);

      const copyAsNew = useCallback(
        (row) => {
          openNew({
            id: '',
            name: `${row.name ?? row.id} copy`,
            description: row.description ?? '',
            order: nextOrder,
            basePreset: row.id,
            basePresetLocked: false,
            persona: '',
            isNew: true,
          });
        },
        [openNew, nextOrder],
      );

      /**
       * Load a bundled sample into a fresh draft.
       *
       * It opens the editor rather than creating a preset, for the same reason a
       * Markdown import does: a sample has no id of its own, and inventing one
       * would add a preset the user never named.
       */
      const loadExample = useCallback(
        (row) => {
          run(async () => {
            const payload = await callHost('example', { method: 'POST', body: { name: row.name } });
            openNew({
              id: '',
              name: payload.name,
              description: row.summary ?? '',
              order: nextOrder,
              basePreset: shipped[0]?.id ?? '',
              basePresetLocked: false,
              persona: payload.persona,
              isNew: true,
            });
            setNotice(t.loadedExample(payload.name));
            return null;
          }, null);
        },
        [run, openNew, nextOrder, shipped],
      );

      /**
       * Download a generated file without touching the host's filesystem.
       *
       * The page cannot choose where a file lands, so the browser's own download
       * path is used: a Blob URL plus a synthetic anchor click, revoked shortly
       * after so the blob does not stay alive for the whole session.
       */
      const download = useCallback((filename, text, type) => {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, []);

      const startExport = useCallback(() => {
        setNotice(null);
        setError(null);
        setExportScope('');
        setExportFormat('json');
        setExportOpen(true);
      }, []);

      /**
       * Write the chosen preset(s) out in the chosen format.
       *
       * Two shapes, because they answer different questions:
       *
       *   - JSON is a backup. It carries the metadata a preset needs to exist
       *     again (id, name, description, order, base preset) plus the persona
       *     body, and `import` reads it straight back.
       *   - Markdown is a document. It carries only the persona prose, which is
       *     what a person actually reads or hands to someone else, so it makes
       *     sense for one preset at a time and nothing else.
       */
      const runExport = useCallback(() => {
        const format = exportFormat;
        const scope = exportScope;
        if (format === 'markdown' && scope === '') {
          setError(t.exportMarkdownAll);
          return;
        }
        run(async () => {
          const payload = await callHost('export', scope === '' ? {} : { method: 'POST', body: { id: scope } });
          const rows = Array.isArray(payload.presets) ? payload.presets : [];
          if (rows.length === 0) throw new Error(t.emptyOwn);
          if (format === 'markdown') {
            const row = rows[0];
            download(`${row.id}.md`, `${row.persona}\n`, 'text/markdown');
            setExportOpen(false);
            return null;
          }
          download(
            scope === '' ? 'persona-presets.json' : `${scope}.json`,
            `${JSON.stringify(payload, null, 2)}\n`,
            'application/json',
          );
          setExportOpen(false);
          return null;
        }, t.exported);
      }, [exportFormat, exportScope, run, download]);

      /**
       * Import either a preset bundle (`.json`) or a persona document (`.md`).
       *
       * A Markdown file carries only prose, so there is nothing to merge into the
       * library directly: no id, no display name, no tool surface. It opens the
       * new-preset editor with the text already in the persona field, and the user
       * picks the id, name and base preset. Silently inventing an id would create
       * a preset nobody asked for under a name nobody chose.
       */
      const importFile = useCallback(
        (event) => {
          const input = event.target;
          const file = input.files && input.files[0];
          if (!file) return;
          const isMarkdown = /\.(md|markdown|txt)$/i.test(file.name);
          const reader = new FileReader();
          reader.onload = () => {
            const text = String(reader.result ?? '');
            if (isMarkdown) {
              const suggested = file.name.replace(/\.(md|markdown|txt)$/i, '');
              openNew({
                id: '',
                name: suggested,
                description: '',
                order: 100,
                basePreset: builtin[0]?.id ?? '',
                persona: text.replace(/\r\n/g, '\n'),
                isNew: true,
              });
              setNotice(t.importedMarkdown(file.name));
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch (err) {
              setError(t.badJson(err.message));
              return;
            }
            run(() => callHost('import', { method: 'POST', body: parsed }), t.imported);
          };
          reader.readAsText(file);
          input.value = '';
        },
        [run, openNew, builtin],
      );

      /* -------------------------------------------------------------- render */

      const rows = [];
      const editingId = draft !== null && !draft.isNew ? draft.id : null;

      rows.push(h('h2', { key: 'title', style: S.title }, t.title));
      rows.push(h('p', { key: 'intro', style: S.intro }, t.intro));
      rows.push(
        h(
          'div',
          { key: 'toolbar', style: S.toolbar },
          h('button', { type: 'button', style: S.primary, onClick: startNew, disabled: busy }, t.newPreset),
          h('button', { type: 'button', style: merge(S.btn, S.btnQuiet), onClick: () => refresh(), disabled: busy }, t.refresh),
          h('button', { type: 'button', style: merge(S.btn, S.btnQuiet), onClick: startExport, disabled: busy }, t.export),
          h('button', { type: 'button', style: merge(S.btn, S.btnQuiet), onClick: () => importRef.current?.click(), disabled: busy }, t.import),
          h('input', {
            ref: importRef,
            type: 'file',
            accept: '.json,.md,.markdown,.txt,application/json,text/markdown,text/plain',
            style: { display: 'none' },
            onChange: importFile,
          }),
          h('span', { style: S.spacer }),
        ),
      );

      if (error !== null) rows.push(h('p', { key: 'error', style: S.error }, error));
      if (notice !== null) rows.push(h('p', { key: 'notice', style: S.hint }, notice));
      if (state?.warnings?.length) {
        rows.push(h('p', { key: 'warn', style: S.warn }, state.warnings.join('\n')));
      }

      // The export panel sits directly under the toolbar so it opens in place of
      // the list, not on top of it: choosing a scope needs the preset names that
      // are already on this page.
      if (exportOpen) {
        rows.push(
          h(
            'div',
            { key: 'export', style: S.panel },
            h(
              'div',
              { style: S.panelHead },
              h('p', { style: S.panelTitle }, t.exportTitle),
            ),
            h(
              Field,
              { styles: S, stacked: true, label: t.exportScope },
              h(
                'select',
                {
                  style: S.input,
                  value: exportScope,
                  onChange: (event) => setExportScope(event.target.value),
                },
                h('option', { value: '' }, t.exportAll),
                managed.map((row) =>
                  h('option', { key: row.id, value: row.id }, `${row.name || row.id} (${row.id})`),
                ),
              ),
            ),
            h(
              Field,
              { styles: S, stacked: true, label: t.exportFormat },
              h(
                'select',
                {
                  style: S.input,
                  value: exportFormat,
                  onChange: (event) => setExportFormat(event.target.value),
                },
                h('option', { value: 'json' }, t.formatJson),
                h('option', { value: 'markdown' }, t.formatMarkdown),
              ),
            ),
            h('p', { style: S.hint }, t.exportHintAll),
            h(
              'div',
              { style: S.actions },
              h('button', { type: 'button', style: S.primary, onClick: runExport, disabled: busy }, t.exportOne),
              h(
                'button',
                {
                  type: 'button',
                  style: merge(S.btn, S.btnQuiet),
                  onClick: () => setExportOpen(false),
                },
                t.cancelExport,
              ),
            ),
          ),
        );
      }

      if (draft !== null) {
        rows.push(
          h(
            'div',
            { key: 'editor', style: S.panel },
            h(
              'div',
              { style: S.panelHead },
              h('p', { style: S.panelTitle }, draft.isNew ? t.newTitle : t.editTitle(selected?.name ?? draft.id)),
              h('span', { style: S.count }, draft.persona === '' ? '' : t.chars(draft.persona.length)),
            ),
            h(
              'div',
              { style: S.row },
              h(
                Field,
                { styles: S, label: t.idLabel, tail: draft.isNew ? t.idHint : undefined },
                h('input', {
                  style: S.input,
                  value: draft.id,
                  spellCheck: false,
                  disabled: !draft.isNew,
                  placeholder: 'my-persona',
                  onChange: (event) => setDraft(Object.assign({}, draft, { id: event.target.value })),
                }),
              ),
              h(
                Field,
                { styles: S, label: t.nameLabel },
                h('input', {
                  style: S.input,
                  value: draft.name,
                  onChange: (event) => setDraft(Object.assign({}, draft, { name: event.target.value })),
                }),
              ),
              h(
                Field,
                { styles: S, label: t.orderLabel, narrow: true },
                h('input', {
                  style: S.input,
                  type: 'number',
                  value: draft.order,
                  onChange: (event) => setDraft(Object.assign({}, draft, { order: event.target.value })),
                }),
              ),
            ),
            h(
              Field,
              { styles: S, stacked: true, label: t.descriptionLabel },
              h('input', {
                style: S.input,
                value: draft.description,
                onChange: (event) => setDraft(Object.assign({}, draft, { description: event.target.value })),
              }),
            ),
            h(
              Field,
              { styles: S, stacked: true, label: t.baseLabel },
              draft.basePresetLocked === true
                ? h(
                    'div',
                    { style: S.stack },
                    h(
                      'select',
                      { style: merge(S.input, S.inputLocked), value: '', disabled: true },
                      h('option', { value: '' }, t.baseLockedOption),
                    ),
                    h('p', { style: S.hint }, t.baseLockedHint),
                  )
                : h(
                    'select',
                    {
                      style: S.input,
                      value: draft.basePreset,
                      onChange: (event) => setDraft(Object.assign({}, draft, { basePreset: event.target.value })),
                    },
                    h('option', { value: '' }, t.basePlaceholder),
                    // A copy of a bundled preset keeps that preset as its base,
                    // and it is not one of the shipped four, so it needs its own
                    // entry or the selector would show a value it cannot display.
                    draft.basePreset !== '' && !shipped.some((row) => row.id === draft.basePreset)
                      ? h('option', { value: draft.basePreset }, draft.basePreset)
                      : null,
                    // Only the shipped presets are offered as a base. A base supplies
                    // the tool surface, and a bundled add-on's preset is often a
                    // narrow one (a QQ chat preset carries four to nine plugins), so
                    // copying it would give a general persona a restricted toolset.
                    shipped.map((row) =>
                      h('option', { key: row.id, value: row.id }, `${row.name ?? row.id} (${row.id})`),
                    ),
                  ),
            ),
            h(
              Field,
              { styles: S, stacked: true, label: t.personaLabel },
              h('textarea', {
                style: S.textarea,
                value: draft.persona,
                spellCheck: false,
                placeholder: t.personaPlaceholder,
                onChange: (event) => setDraft(Object.assign({}, draft, { persona: event.target.value })),
              }),
            ),
            h(
              'div',
              { style: S.actions },
              h('button', { type: 'button', style: S.primary, onClick: save, disabled: busy }, t.save),
              draft.isNew ? null : h('button', { type: 'button', style: merge(S.btn, S.btnQuiet), onClick: duplicate, disabled: busy }, t.duplicate),
              draft.isNew
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      style: merge(S.btn, merge(S.btnQuiet, S.btnDanger)),
                      onClick: () => removeFrom({ id: draft.id, name: draft.name }),
                      disabled: busy,
                    },
                    t.remove,
                  ),
              h(
                'button',
                {
                  type: 'button',
                  style: merge(S.btn, S.btnQuiet),
                  onClick: () => {
                    setDraft(null);
                    setSelectedId(null);
                  },
                },
                t.cancel,
              ),
            ),
          ),
        );
      }

      rows.push(
        h(
          'section',
          { key: 'own', style: S.group },
          h('h3', { style: S.groupHead }, t.ownTitle),
          managed.length === 0
            ? h('p', { style: S.hint }, t.emptyOwn)
            : h(
                'ul',
                { style: S.cards },
                managed.map((row) =>
                  h(PresetCard, {
                    key: row.id,
                    row: Object.assign({}, row, { active: editingId === row.id || row.active === true }),
                    styles: S,
                    managed: true,
                    onEdit: () => {
                      setSelectedId(row.id);
                      setNotice(null);
                    },
                    onDelete: () => removeFrom(row),
                  }),
                ),
              ),
        ),
      );

      // Two read-only groups. They are separated because where a preset comes
      // from is what decides how it can be changed: the harness ships its own,
      // and an installed plugin ships others. Neither is this plugin's to edit.
      const readOnlyGroups = [
        { key: 'shipped', title: t.shippedTitle, label: t.builtIn, rows: shipped },
        { key: 'bundled', title: t.bundledTitle, label: t.custom, rows: bundled },
      ];
      for (const group of readOnlyGroups) {
        if (group.rows.length === 0) continue;
        rows.push(
          h(
            'section',
            { key: group.key, style: S.group },
            h('h3', { style: S.groupHead }, group.title),
            h(
              'ul',
              { style: S.cards },
              group.rows.map((row) =>
                h(PresetCard, {
                  key: row.id,
                  row,
                  managed: false,
                  styles: S,
                  groupLabel: group.label,
                  onCopy: () => copyAsNew(row),
                }),
              ),
            ),
          ),
        );
      }

      // Bundled samples: offered last, because they are a starting point, not
      // something already on this machine. Nothing is registered until the user
      // saves, so a sample never shows up in the session preset picker uninvited.
      if (examples.length > 0) {
        rows.push(
          h(
            'section',
            { key: 'examples', style: S.group },
            h('h3', { style: S.groupHead }, t.examples),
            h('p', { style: S.hint }, t.examplesHint),
            h(
              'ul',
              { style: S.cards },
              examples.map((row) =>
                h(
                  'li',
                  { key: row.name, style: S.card },
                  h(
                    'div',
                    { style: S.cardMain },
                    h(
                      'span',
                      { style: S.cardHead },
                      h(
                        'span',
                        { style: S.cardIdentity },
                        h('span', { style: S.cardName, title: row.name }, row.name),
                        h(Tag, { styles: S, extra: S.tagOwn }, t.examples),
                      ),
                    ),
                    h('span', { style: S.cardDesc }, row.summary !== '' ? row.summary : ' '),
                  ),
                  h(
                    'div',
                    { style: S.cardFoot },
                    h('span', { style: S.cardMeta }),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.btn,
                        title: t.loadExampleInto(row.name),
                        onClick: () => loadExample(row),
                        disabled: busy,
                      },
                      t.loadExample,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }

      if (draft !== null) {
      }

      if (state?.libraryPath) {
        rows.push(
          h(
            'div',
            { key: 'path', style: S.footer },
            h('p', { style: S.hint }, t.libraryFile(state.libraryPath)),
            // Say where the data lives AND that uninstalling leaves it alone. A
            // user cannot tell "not listed any more" from "deleted", and the two
            // have very different outcomes, so this must not be left to a README.
            h('p', { style: S.hint }, t.libraryKeep),
          ),
        );
      }

      return h('div', { style: S.root }, rows);
    }

    /* ------------------------------------------------------------- register */

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 46,
            label: () => t.section,
            inject: () => ({}),
          },
          PersonaManagerPage,
        ),
      );
    }

    return { inject: ['slots'], apply };
  },
});

