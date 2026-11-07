/**
 * Unit tests for the text-level patch surgery.
 *
 * This module is the only place that touches a file the user wrote by hand, so
 * it is tested directly rather than through the Host half: a wrong result here
 * corrupts a profile, and a profile is not something a user can easily rebuild.
 *
 * The rule under test: rewrite exactly the persona block of exactly one preset
 * row, or refuse and say why. Never write something that reads back differently
 * from what the user typed.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  replacePersonaInFile,
  readPersonaFromFile,
  updateRowFieldsInFile,
  readRowFieldsFromText,
} from '../lib/profile-patch.js';

/* `yaml` is what the assertions parse files back with.
 *
 * Resolve it the ordinary way first — a checkout with the dev dependency
 * installed, which is what CI does — then fall back to the deployment's copy, so
 * a working copy without `node_modules` can still run these tests. Trying the
 * machine-specific paths first would mean CI exercises a different branch than
 * the one a maintainer tests locally. */
let YAML = null;
try {
  YAML = createRequire(import.meta.url)('yaml');
} catch {
  YAML = null;
}
if (YAML === null) {
  for (const root of [
    'C:/Users/lenovo/.dsh/profiles/desktop',
    'C:/Users/lenovo/.dsh/profiles/web',
  ]) {
    try {
      YAML = createRequire(join(root, '__t.cjs'))('yaml');
      break;
    } catch {
      /* try the next root */
    }
  }
}
if (YAML === null) {
  // A skip here would be a green CI run that tested nothing. The round trip is
  // the entire point of these tests, so not having the parser is a failure.
  console.log('FAIL  the "yaml" package could not be resolved, so nothing was verified');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'persona-patch-test-'));
let failures = 0;

const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

/** Write a throwaway patch file and return its path. */
function makeFile(name, lines) {
  const file = join(dir, name);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/** Parse a patch file and return the persona prefix of the given preset. */
function readBack(file, index = 0) {
  const doc = YAML.parse(readFileSync(file, 'utf8'));
  return doc[0].insert[index].config.plugins[0].config.prefix;
}

/* ------------------------------------------------------- basic round trips */

{
  const file = makeFile('literal.yml', [
    '- insert:',
    '    - id: preset-a',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: a',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                OLD TEXT',
    '',
  ]);
  const text = '第一行\n\n第二行\n第三行';
  const r = await replacePersonaInFile(file, 'a', text);
  check('a literal block is written', r.status === 'written', r.status);
  check('a literal block round-trips exactly', readBack(file) === text, JSON.stringify(readBack(file)));
  check('reading it back gives the same text', (await readPersonaFromFile(file, 'a')) === text);
}

/* --------------------------------- folded scalars must be refused, not broken */

{
  // `>` folds every newline into a space. Overwriting its body with ordinary
  // lines would silently collapse the user's paragraphs, so this module must
  // refuse outright. Status `written` here would be a data-loss bug.
  const file = makeFile('folded.yml', [
    '- insert:',
    '    - id: preset-folded',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: folded',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: >',
    '                第一段。',
    '                第二行。',
    '',
  ]);
  const before = readFileSync(file, 'utf8');
  const r = await replacePersonaInFile(file, 'folded', '全新正文\n第二行\n第三行');
  check('a folded scalar is refused', r.status === 'unsupported-scalar', r.status);
  check('a refused write changes nothing', readFileSync(file, 'utf8') === before);
  check('the refusal names the scalar', String(r.detail).includes('>'), JSON.stringify(r.detail));
}

{
  // The same hazard applies to the chomping indicator and to a plain inline
  // value: writing a block body under either would change what the user wrote.
  const file = makeFile('inline.yml', [
    '- insert:',
    '    - id: preset-inline',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: inline',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: 原来的正文',
    '',
  ]);
  const r = await replacePersonaInFile(file, 'inline', '新正文');
  check('an inline scalar is refused', r.status === 'unsupported-scalar', r.status);
}

/* --------------------------------------- quote styles must survive a rewrite */

{
  const file = makeFile('quoted.yml', [
    '- insert:',
    '    - id: preset-q',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: q',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                旧正文',
    '',
  ]);
  // A colon inside the text is common in persona prose and is harmless inside a
  // block scalar; the point is that the surrounding file stays byte-identical
  // apart from the body.
  const before = readFileSync(file, 'utf8').split('\n');
  await replacePersonaInFile(file, 'q', '第一行: 带冒号\n第二行');
  const after = readFileSync(file, 'utf8').split('\n');
  const prefixLine = before.findIndex((line) => line.includes('prefix: |-'));
  check('the prefix line keeps its indicator', after[prefixLine].includes('prefix: |-'), after[prefixLine]);
  check('a colon in the body round-trips', readBack(file) === '第一行: 带冒号\n第二行', JSON.stringify(readBack(file)));
}

/* ------------------------------------- the rest of the document is untouched */

{
  const file = makeFile('surgical.yml', [
    '# a comment the user wrote',
    '- insert:',
    '    - id: preset-s',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: s',
    '        name: 名字',
    '        order: 3',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                旧',
    '          - id: tool-fs',
    "            name: '@deepseek-ai/dsh-tool-fs'",
    '            config:',
    '              applyPatch: false',
    '',
  ]);
  await replacePersonaInFile(file, 's', '新正文\n两行');
  const text = readFileSync(file, 'utf8');
  check('comments survive', text.includes('# a comment the user wrote'));
  check('sibling plugins survive', text.includes('dsh-tool-fs') && text.includes('applyPatch: false'));
  check('display fields survive', text.includes('name: 名字') && text.includes('order: 3'));
  check('exactly one preset row', (text.match(/^\s*-\s*id:\s*preset-s\s*$/gm) || []).length === 1);
}

/* ------------------------------------------- refusals for the wrong targets */

{
  const file = makeFile('norow.yml', ['- insert:', '    - id: preset-x', '']);
  const r = await replacePersonaInFile(file, 'missing', 'x');
  check('an unknown preset is refused', r.status === 'no-row', r.status);
}
{
  const file = makeFile('nopersona.yml', [
    '- insert:',
    '    - id: preset-n',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        plugins:',
    '          - id: tool-fs',
    "            name: '@deepseek-ai/dsh-tool-fs'",
    '',
  ]);
  const r = await replacePersonaInFile(file, 'n', 'x');
  check('a preset without a persona block is refused', r.status === 'no-persona', r.status);
}
{
  const r = await replacePersonaInFile(join(dir, 'absent.yml'), 'a', 'x');
  check('a missing file is refused', r.status === 'no-row', r.status);
}

/* ------------------------------------ writing the same text is not a rewrite */

{
  const file = makeFile('idempotent.yml', [
    '- insert:',
    '    - id: preset-i',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                同样的正文',
    '',
  ]);
  const before = readFileSync(file, 'utf8');
  const r = await replacePersonaInFile(file, 'i', '同样的正文');
  check('an identical write reports unchanged', r.status === 'unchanged', r.status);
  check('an unchanged write touches nothing', readFileSync(file, 'utf8') === before);
}

/* ----------------------------------------------- display field replacement */

{
  const file = makeFile('fields.yml', [
    '- insert:',
    '    - id: preset-f',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: f',
    '        name: 旧名字',
    '        description: 旧说明',
    '        order: 3',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                正文',
    '',
  ]);
  const fields = readRowFieldsFromText(readFileSync(file, 'utf8'), 'f');
  check('display fields are read', fields.name === '旧名字' && fields.order === '3', JSON.stringify(fields));

  const r = await updateRowFieldsInFile(file, 'f', { name: '新名字', order: 7 });
  check('display fields are written', r.status === 'written', r.status);
  const text = readFileSync(file, 'utf8');
  check('the new name landed', /^\s*name: 新名字\s*$/m.test(text));
  check('the new order landed', /^\s*order: 7\s*$/m.test(text));
  // The row's own `name:` names the PLUGIN PACKAGE; rewriting it would repoint
  // the preset at nothing.
  check('the plugin package name is untouched', text.includes("name: '@deepseek-ai/dsh-agent-preset'"));
  check('the persona package name is untouched', text.includes("name: '@deepseek-ai/dsh-persona'"));
  check('the description survives an unrelated write', text.includes('description: 旧说明'));
  check('the persona body survives', text.includes('正文'));
}

{
  // A value needs quoting when reading it back bare would change its meaning.
  const file = makeFile('quoting.yml', [
    '- insert:',
    '    - id: preset-q2',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: q2',
    '        name: old',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                正文',
    '',
  ]);
  await updateRowFieldsInFile(file, 'q2', { name: '带: 冒号的名字' });
  const text = readFileSync(file, 'utf8');
  const doc = YAML.parse(text);
  check(
    'a value with a colon is quoted so it reads back whole',
    doc[0].insert[0].config.name === '带: 冒号的名字',
    JSON.stringify(doc[0].insert[0].config.name),
  );
}

{
  // A field the row does not declare is reported, never invented: guessing the
  // indentation and neighbour of a new key is how a patch stops loading.
  const file = makeFile('missingfield.yml', [
    '- insert:',
    '    - id: preset-m',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: m',
    '        name: only-name',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                正文',
    '',
  ]);
  const r = await updateRowFieldsInFile(file, 'm', { name: 'renamed', order: 9 });
  check('an absent field is reported', Array.isArray(r.missing) && r.missing.includes('order'), JSON.stringify(r.missing));
  check('the declared field still lands', /^\s*name: renamed\s*$/m.test(readFileSync(file, 'utf8')));
  check('the absent field was not invented', !/^\s*order:/m.test(readFileSync(file, 'utf8')));
}

/* ------------------------------------------------------ backups on write */

{
  const file = makeFile('backup.yml', [
    '- insert:',
    '    - id: preset-b',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                旧',
    '',
  ]);
  const original = readFileSync(file, 'utf8');
  const r = await replacePersonaInFile(file, 'b', '新');
  check('a backup path is returned', typeof r.backup === 'string', String(r.backup));
  if (typeof r.backup === 'string') {
    check('the backup exists', existsSync(r.backup));
    check('the backup holds the original bytes', readFileSync(r.backup, 'utf8') === original);
  }
}

for (const name of ['literal.yml', 'folded.yml', 'inline.yml', 'quoted.yml', 'surgical.yml', 'norow.yml', 'nopersona.yml', 'idempotent.yml', 'fields.yml', 'quoting.yml', 'missingfield.yml', 'backup.yml']) {
  const file = join(dir, name);
  if (existsSync(file)) unlinkSync(file);
}

console.log(failures === 0 ? '\nall patch checks passed' : `\n${failures} patch check(s) failed`);
if (failures !== 0) process.exitCode = 1;
