/**
 * Text-level persona replacement inside a profile patch file.
 *
 * Kept in its own module so it can be unit-tested without a Cordis context, and
 * so the Host half stays readable.
 *
 * The rule this module enforces: it either rewrites exactly the persona block of
 * exactly one `preset-<id>` row, or it reports why it refused. It never
 * re-serializes the document, so the user's comments, quoting style, ordering,
 * and `!!js` expressions survive untouched.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

/** Indentation of a line, in spaces. Tabs are treated as one column. */
function indentOf(line) {
  return line.match(/^[ \t]*/)[0].length;
}

/**
 * Find the line range of one `- id: preset-<id>` row.
 *
 * A row ends at the next non-blank line indented no deeper than the row's own
 * `- id:` line, which is how the loader itself nests these lists.
 */
function findRow(lines, presetId) {
  const wanted = `preset-${presetId}`;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^[ \t]*-[ \t]*id:[ \t]*(\S+)[ \t]*$/);
    if (match === null || match[1] !== wanted) continue;
    const rowIndent = indentOf(lines[i]);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '') continue;
      if (indentOf(lines[j]) <= rowIndent) {
        end = j;
        break;
      }
    }
    return { start: i, end, indent: rowIndent };
  }
  return null;
}

/**
 * Find the `prefix:` block of the persona plugin inside one row.
 *
 * Only the persona row is considered: a `prefix:` that belongs to another plugin
 * would rewrite the wrong text, so the walk stops at the next sibling row.
 *
 * Returns the block style alongside the line range. The style matters: a `|-`
 * block keeps newlines as newlines, while a `>` block folds them into spaces.
 * Writing ordinary lines under a `>` would silently collapse the user's
 * paragraphs, so the caller must refuse rather than proceed.
 */
function findPersonaPrefix(lines, row) {
  let insidePersona = false;
  for (let i = row.start; i < row.end; i += 1) {
    const line = lines[i];
    const idMatch = line.match(/^[ \t]*-[ \t]*id:[ \t]*(\S+)[ \t]*$/);
    if (idMatch !== null) {
      const depth = indentOf(line);
      if (depth > row.indent) insidePersona = idMatch[1] === 'persona';
      continue;
    }
    if (!insidePersona) continue;
    // A block scalar: `prefix: |`, `prefix: |-`, `prefix: >`, `prefix: >-` …
    const block = line.match(/^([ \t]*)prefix:[ \t]*([|>])([+-]?)[ \t]*$/);
    if (block !== null) {
      const prefixIndent = block[1].length;
      // The body is every following line indented deeper than `prefix:`.
      let bodyEnd = i + 1;
      while (bodyEnd < row.end) {
        const candidate = lines[bodyEnd];
        if (candidate.trim() === '') {
          bodyEnd += 1;
          continue;
        }
        if (indentOf(candidate) <= prefixIndent) break;
        bodyEnd += 1;
      }
      // Trailing blank lines belong to the document's spacing, not to the value:
      // including them made an identical rewrite look like a change.
      while (bodyEnd > i + 1 && lines[bodyEnd - 1].trim() === '') bodyEnd -= 1;
      return {
        line: i,
        bodyStart: i + 1,
        bodyEnd,
        prefixIndent,
        indicator: block[2],
        chomp: block[3],
      };
    }
    // A `prefix:` that is not a block scalar — an inline value, or nothing at
    // all. Writing a block body under it would change the meaning of the line,
    // so record it and let the caller refuse.
    const inline = line.match(/^([ \t]*)prefix:[ \t]*(\S.*)$/);
    if (inline !== null) {
      return {
        line: i,
        bodyStart: i + 1,
        bodyEnd: i + 1,
        prefixIndent: inline[1].length,
        indicator: null,
        chomp: '',
        inlineValue: inline[2].trim(),
      };
    }
  }
  return null;
}

/** Indent every non-empty line of the replacement body by `indent` spaces. */
function indentBody(text, indent) {
  const pad = ' '.repeat(indent);
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line));
}

/**
 * Replace one preset's persona text in one patch file.
 *
 * @returns {{status: 'written'|'unchanged'|'no-row'|'no-persona'|'unsupported-scalar', backup?: string, detail?: string}}
 *
 * `unsupported-scalar` is a refusal, not a failure: the row is found, but its
 * `prefix:` uses a form this module cannot rewrite without changing what the
 * text means (a `>` folded scalar, or an inline value). Refusing leaves the file
 * bytes untouched, which is the only safe outcome — a "successful" write there
 * would silently collapse the user's paragraphs.
 */
export async function replacePersonaInFile(file, presetId, personaText) {
  if (!existsSync(file)) return { status: 'no-row' };
  const original = await readFile(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);

  const row = findRow(lines, presetId);
  if (row === null) return { status: 'no-row' };

  const prefix = findPersonaPrefix(lines, row);
  if (prefix === null) return { status: 'no-persona' };

  if (prefix.indicator === null) {
    return {
      status: 'unsupported-scalar',
      detail: `the persona uses an inline value instead of a block ("prefix: ${prefix.inlineValue}"), so rewriting it as a block would change its meaning`,
    };
  }
  if (prefix.indicator === '>') {
    return {
      status: 'unsupported-scalar',
      detail: 'the persona is a ">" folded block, which joins every newline into a space; writing it back would collapse the paragraphs',
    };
  }

  const body = indentBody(personaText, prefix.prefixIndent + 2);
  const next = [
    ...lines.slice(0, prefix.bodyStart),
    ...body,
    ...lines.slice(prefix.bodyEnd),
  ].join(eol);

  if (next === original) return { status: 'unchanged' };

  const backup = `${file}.bak-personamanager-${Date.now()}`;
  await writeFile(backup, original, 'utf8');
  await writeFile(file, next, 'utf8');
  return { status: 'written', backup };
}

/** Read one preset's current persona text without modifying anything. */
export async function readPersonaFromFile(file, presetId) {
  if (!existsSync(file)) return null;
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  const row = findRow(lines, presetId);
  if (row === null) return null;
  const prefix = findPersonaPrefix(lines, row);
  if (prefix === null) return null;
  const bodyIndent = Math.min(
    ...lines.slice(prefix.bodyStart, prefix.bodyEnd)
      .filter((line) => line.trim() !== '')
      .map((line) => indentOf(line)),
  );
  if (!Number.isFinite(bodyIndent)) return '';
  return lines
    .slice(prefix.bodyStart, prefix.bodyEnd)
    .map((line) => (line.trim() === '' ? '' : line.slice(bodyIndent)))
    .join('\n')
    .replace(/\n+$/, '');
}

/* -------------------------------------------------------- metadata fields */

/**
 * Render a scalar YAML value so it reads back as the same string.
 *
 * A plain value is written bare — that is how a hand-written patch looks — but
 * anything containing a colon, a leading indicator character, a `#`, or leading
 * or trailing space has to be quoted, or the loader would parse it differently
 * than what the user typed.
 */
function yamlScalar(value) {
  const text = String(value);
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^:#]*$/.test(text)
    && !/\s$/.test(text)
    && !/^(true|false|null|yes|no|on|off|~)$/i.test(text);
  return plain ? text : JSON.stringify(text);
}

/**
 * Find the preset's `config:` block, which is where its display fields live.
 *
 * These keys are ambiguous: the row has its own `name:` (the plugin package) and
 * the config block has another one (the display name). Only the config block is
 * the preset's identity, so the search starts there and stops at the first
 * dedent, which is how the loader nests these mappings.
 */
function findConfigBlock(lines, row) {
  for (let i = row.start + 1; i < row.end; i += 1) {
    const match = lines[i].match(/^([ \t]*)config:[ \t]*$/);
    if (match === null) continue;
    const configIndent = match[1].length;
    let end = row.end;
    for (let j = i + 1; j < row.end; j += 1) {
      if (lines[j].trim() === '') continue;
      if (indentOf(lines[j]) <= configIndent) {
        end = j;
        break;
      }
    }
    return { start: i, end, indent: configIndent };
  }
  return null;
}

/**
 * Find one scalar field that is a *direct* child of the config block.
 *
 * Only direct children count: a deeper `name:` belongs to a plugin row inside
 * `plugins:` (`- id: persona` / `name: '@deepseek-ai/dsh-persona'`), and
 * rewriting that would repoint the plugin at a different package.
 */
function findRowField(lines, row, key) {
  const block = findConfigBlock(lines, row);
  if (block === null) return null;

  // The indent of direct children: the shallowest non-blank line in the block.
  let childIndent = Infinity;
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (lines[i].trim() === '') continue;
    childIndent = Math.min(childIndent, indentOf(lines[i]));
  }
  if (!Number.isFinite(childIndent)) return null;

  const pattern = new RegExp('^([ \\t]*)' + key + ':[ \\t]*(.*)$');
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (indentOf(lines[i]) !== childIndent) continue;
    const match = lines[i].match(pattern);
    if (match === null) continue;
    if (match[2].trim() === '') {
      // An empty value is only a scalar slot if nothing is nested under it; a
      // `plugins:`-style block must never be flattened into text.
      const next = i + 1 < block.end ? lines[i + 1] : '';
      if (next.trim() !== '' && indentOf(next) > match[1].length) return null;
    }
    return { line: i, indent: match[1].length, value: match[2].trim() };
  }
  return null;
}

/**
 * Rewrite the preset's own scalar fields (`name`, `description`, `order`) in
 * place, as text.
 *
 * Only lines that already exist are touched: a field the row does not declare is
 * left alone rather than inserted, because guessing the right indentation and
 * neighbour would risk producing a patch the loader reads differently.
 *
 * @returns {{status: 'written'|'unchanged'|'no-row'|'not-found', changed: string[], backup?: string}}
 */
export async function updateRowFieldsInFile(file, presetId, fields) {
  if (!existsSync(file)) return { status: 'no-row', changed: [] };
  const original = await readFile(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);

  const row = findRow(lines, presetId);
  if (row === null) return { status: 'no-row', changed: [] };

  const changed = [];
  const missing = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    const found = findRowField(lines, row, key);
    if (found === null) {
      missing.push(key);
      continue;
    }
    const next = yamlScalar(raw);
    if (found.value === next) continue;
    lines[found.line] = `${' '.repeat(found.indent)}${key}: ${next}`;
    changed.push(key);
  }

  if (changed.length === 0) {
    return { status: 'unchanged', changed, missing };
  }

  const backup = `${file}.bak-personamanager-${Date.now()}`;
  await writeFile(backup, original, 'utf8');
  await writeFile(file, lines.join(eol), 'utf8');
  return { status: 'written', changed, missing, backup };
}

/** Read the preset's own scalar fields, for building a diff. */
export function readRowFieldsFromText(text, presetId) {
  const lines = text.split(/\r?\n/);
  const row = findRow(lines, presetId);
  if (row === null) return null;
  const out = {};
  for (const key of ['name', 'description', 'order']) {
    const found = findRowField(lines, row, key);
    if (found !== null) out[key] = found.value;
  }
  return out;
}
