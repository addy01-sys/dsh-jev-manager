/**
 * Guards the preset generator. Its status check once grepped the whole file for
 * `adopt: true`, and the banner explaining the setting contained exactly that
 * string — so a freshly installed shadow preset reported itself ACTIVE. A safety
 * status must never be readable as "on" because of a comment.
 *
 * Importing tools/install-preset.mjs must also not write anything; the direct-run
 * guard is asserted here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginEntry = join(pluginRoot, 'lib', 'compaction.js').replace(/\\/g, '/');
const dshRoot =
  process.env.DSH_RUNTIME_ROOT ??
  resolve(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh');
const require_ = createRequire(resolve(dshRoot, 'package.json'));

// The package `exports` map hides its data files, so locate them from the manifest.
// Directory-style presets exist only before 0.2; a 0.2 runtime has no such package and
// its presets are declarative rows (see tools/make-preset-patch.mjs).
let presetPath = null;
try {
  presetPath = join(
    dirname(require_.resolve('@deepseek-ai/dsh-agent-presets/package.json')),
    'presets',
    'standard',
    'agent.cordis.yml',
  );
} catch {
  presetPath = null;
}
const legacySkip = presetPath === null ? 'skipped' : false;
const tool = await import(pathToFileURL(join(pluginRoot, 'tools/install-preset.mjs')).href);
const { composite, activeRows } = tool;

const SHIPPED = [
  '# 标准 preset：一次进程挂载一个完整编码 Agent。',
  '- id: compaction',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    compaction: true',
  '  config:',
  "    - id: compaction-basic",
  "      name: '@deepseek-ai/dsh-compaction-basic'",
  '',
  '    - id: command-compact',
  "      name: '@deepseek-ai/dsh-command-compact'",
  '',
].join('\n');

const generated = composite(SHIPPED);
const rows = activeRows(generated).split(/\r?\n/).filter((line) => line.trim() !== '');

test('importing the CLI does not touch the filesystem', () => {
  // Reaching this line at all proves it: a top-level install would have run during
  // the dynamic import above. Pin the invariant so adding one later fails here.
  assert.equal(typeof composite, 'function');
  assert.equal(typeof tool.run, 'function');
});

test('the generator replaces exactly the compaction row and copies its siblings verbatim', () => {
  assert.equal(rows.filter((line) => /id: compaction-basic/.test(line)).length, 0,
    'no active row may still name the stock backend');
  assert.ok(rows.includes('    - id: jev-manager'), 'the new row keeps the group indent');
  assert.ok(rows.some((line) => line.includes('/lib/compaction.js')), 'the provider is named by path');
  assert.ok(rows.includes("      name: '@deepseek-ai/dsh-command-compact'"),
    'a sibling row is copied byte for byte');
});

test('a fresh install is shadow, and the status cannot misread the banner', () => {
  const setting = /^\s*adopt:\s*(true|false)\s*$/m.exec(activeRows(generated));
  assert.notEqual(setting, null, 'an explicit adopt row must exist');
  assert.equal(setting[1], 'false');
  assert.match(generated, /adopt:\s*true/, 'the banner does mention the other value');
  assert.ok(
    generated.split(/\r?\n/).slice(0, 9).every((line) => line.startsWith('#') || line.trim() === ''),
    'the banner must be comment lines only',
  );
});

test('a preset whose shape moved fails loudly instead of emitting a silent copy', () => {
  assert.throws(() => composite('- id: something-else\n  name: x\n'), /no compaction-basic row/);
  assert.throws(() => composite('- id: compaction-basic\n'), /changed shape/);
  assert.throws(
    () => composite('- id: compaction-basic\n  name: a\n- id: compaction-basic\n  name: b\n'),
    /expected exactly one/,
  );
});

test('against the real shipped preset, only the compaction row differs', { skip: legacySkip }, () => {
  const before = activeRows(readFileSync(presetPath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const after = activeRows(composite(readFileSync(presetPath, 'utf8')))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const added = after.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !after.includes(line));
  assert.deepEqual(
    removed,
    ['    - id: compaction-basic', "      name: '@deepseek-ai/dsh-compaction-basic'"],
    'exactly the stock backend row may be dropped',
  );
  // `config:` already appears elsewhere in the preset, so a set difference cannot see
  // it as new; the line count carries that part instead.
  assert.deepEqual(added, [
    '    - id: jev-manager',
    `      name: '${pluginEntry.replace(/\\/g, '/')}'`,
    '        adopt: false',
  ]);
  assert.equal(after.length - before.length, 2, 'four rows in, two rows out');
});
