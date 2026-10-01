/**
 * Regression guard for the resolver, which is the part that decided desktop viability.
 *
 * `import.meta.resolve(specifier, parentURL)` accepts a second argument and IGNORES it:
 * Node resolves from the importing module. A whole anchor ladder built on that call looks
 * right, logs a confident source path, and actually binds whatever sits above `lib/`. This
 * file fails if that ever comes back.
 *
 * It builds a throwaway "app.asar" tree containing a stub BasicCompactionEngine, points
 * process.resourcesPath at it, and asserts the provider mounts THAT class — even though
 * this checkout's own node_modules sits somewhere else entirely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The provider reads its switch from $DSH_HOME, so keep it out of the operator's state dir.
const stateSandbox = mkdtempSync(join(tmpdir(), 'jev-manager-resolve-state-'));
process.env.DSH_HOME = stateSandbox;
const features = await import(pathToFileURL(resolve(pluginRoot, 'lib/features.mjs')).href);

/** A minimal stand-in for the harness package, exported as a real ESM module. */
function fakeAsar(root) {
  const pkg = join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-compaction-basic');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh-compaction-basic', version: '9.9.9-fake', type: 'module', main: 'lib/index.js', exports: { '.': './lib/index.js' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(pkg, 'lib', 'index.js'),
    'export class BasicCompactionEngine {\n' +
      '  static inject = ["llm", "tokenMeter", "sessions"];\n' +
      '  constructor(ctx, config = {}) { this.ctx = ctx; this.config = config; }\n' +
      '  async summarize(input) { return { summary: "from the fake asar copy" }; }\n' +
      '}\n',
  );
  writeFileSync(join(root, 'app.asar', 'dsh', 'package.json'), `${JSON.stringify({ name: 'runtime-anchor', version: '1.0.0' }, null, 2)}\n`);
  return pkg;
}

const baseDir = mkdtempSync(join(tmpdir(), 'jev-manager-resolve-'));
const asarPkg = fakeAsar(baseDir);

test.after(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(stateSandbox, { recursive: true, force: true });
});

test('import.meta.resolve ignores its parent argument, so the resolver must not use it', async () => {
  const parent = pathToFileURL(join(baseDir, 'app.asar', 'dsh', 'package.json')).href;
  let fromParent = null;
  try {
    fromParent = import.meta.resolve('@deepseek-ai/dsh-compaction-basic', parent);
  } catch {
    /* expected on this machine: the argument changes nothing */
  }
  // If Node DID honor it, this assertion would be the wrong shape — say so rather than
  // pass silently, because the whole design decision rests on which behaviour is real.
  if (fromParent !== null) {
    assert.ok(
      fromParent.includes('app.asar') || !fromParent.includes(pluginRoot),
      `parent argument was honored (${fromParent}); revisit lib/compaction.js's resolveFrom`,
    );
  }
});

test('the provider binds the class under process.resourcesPath, not the one above lib/', async () => {
  const original = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', { value: baseDir, configurable: true, writable: true });
  try {
    features.writeFeatures({ provider: true, decision: false, review: false });
    const { apply } = await import(pathToFileURL(resolve(pluginRoot, 'lib/compaction.js')).href);

    const logs = [];
    const mounted = [];
    const ctx = {
      get: () => undefined,
      logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: () => {} },
      plugin: async (Engine) => {
        mounted.push(Engine);
        return { state: 2 };
      },
    };
    await apply(ctx, {});

    assert.equal(mounted.length, 1, 'the row must mount inside the simulated app');
    const record = features.readMountRecord();
    assert.equal(record.mounted, true, `refused: ${record?.reason}`);
    assert.ok(
      record.base.replace(/\\/g, '/').toLowerCase().includes('app.asar/dsh/node_modules'),
      `基类应来自 app.asar，实际是 ${record.base}`,
    );
    const norm = (u) => decodeURIComponent(u).replace(/\\/g, '/').toLowerCase().replace(/^file:?\/+/, '');
    assert.equal(norm(record.base), norm(pathToFileURL(join(asarPkg, 'lib', 'index.js')).href));
  } finally {
    Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true, writable: true });
  }
});
