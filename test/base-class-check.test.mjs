/**
 * The post-install self-check, tested directly instead of through an install.
 *
 * The bug this pins: `install.mjs` built the check as
 * `fileURLToPath(createRequire(entry).resolve(spec))`. `require.resolve()` returns a PATH,
 * and `fileURLToPath()` demands a file: URL, so it threw on every platform
 * (`ERR_INVALID_URL_SCHEME` on Windows, `ERR_INVALID_URL` elsewhere) — inside a `catch`
 * that returned null. Every install therefore ended with "✗ provider 解析不到基类" and exit
 * code 1, on installs that had in fact succeeded. The same `catch` also turned a
 * `DSH_RUNTIME_ROOT` pointing nowhere into "cannot resolve the base class".
 *
 * The fixture mirrors the real layout: the installed copy under
 * `profiles/<p>/node_modules/dsh-jev-manager/`, and the bridge packages one level up under
 * `profiles/node_modules/@deepseek-ai/` — the directory every profile shares.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { compareWithRuntime, resolveInstalledBase } = await import(
  pathToFileURL(join(pluginRoot, 'tools/base-class-check.mjs')).href
);

const sandbox = resolve(mkdtempSync(join(tmpdir(), 'jev-manager-basecheck-')));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const SPEC = '@deepseek-ai/dsh-compaction-basic';
/** The shared ancestor every profile resolves through. */
const sharedRoot = () => join(sandbox, 'profiles', 'node_modules');
const scopeOf = (root) => join(root, '@deepseek-ai');

/** A harness package that resolves like the real one. */
function fakePackage(root) {
  const dir = join(scopeOf(root), ...SPEC.split('/').slice(1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: SPEC, version: '0.0.0', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), 'export class BasicCompactionEngine {}\n');
  return join(dir, 'index.js');
}

/** The installed copy, in the layout a bundle install creates. */
function fakeInstall(profile) {
  const entry = join(sandbox, 'profiles', profile, 'node_modules', 'dsh-jev-manager', 'lib', 'compaction.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '// installed copy\n');
  return entry;
}

test('the installed copy resolves its base class instead of throwing', () => {
  const base = fakePackage(sharedRoot());
  const found = resolveInstalledBase(fakeInstall('web'), SPEC);
  assert.equal(typeof found, 'string', '必须返回路径，而不是被 catch 吞成 null');
  assert.equal(found, base, '应当解析到共享目录里那份桥接包');
});

test('wrapping that path in fileURLToPath is the bug, and it throws', () => {
  fakePackage(sharedRoot());
  const found = resolveInstalledBase(fakeInstall('wrap'), SPEC);
  assert.equal(typeof found, 'string');
  // Documents why the extra wrapper must not come back. Windows reports
  // ERR_INVALID_URL_SCHEME, POSIX ERR_INVALID_URL — both mean the same thing here.
  assert.throws(() => fileURLToPath(found), /scheme|Invalid URL/i);
});

test('an unresolvable spec or entry yields null rather than a wrong guess', () => {
  fakePackage(sharedRoot());
  const entry = fakeInstall('missing');
  assert.equal(resolveInstalledBase(entry, '@deepseek-ai/definitely-not-installed'), null);
  assert.equal(resolveInstalledBase(join(sandbox, 'nope', 'lib', 'compaction.js'), SPEC), null);
});

test('an install that cannot see the shared ancestor does not resolve', () => {
  const lonely = join(sandbox, 'isolated', 'node_modules', 'dsh-jev-manager', 'lib', 'compaction.js');
  mkdirSync(dirname(lonely), { recursive: true });
  writeFileSync(lonely, '// no bridge above me\n');
  assert.equal(resolveInstalledBase(lonely, SPEC), null);
});

test('no named runtime is "not compared", never "same"', () => {
  fakePackage(sharedRoot());
  const found = resolveInstalledBase(fakeInstall('unset'), SPEC);
  assert.equal(compareWithRuntime(found, undefined).status, 'unset');
  assert.equal(compareWithRuntime(found, '   ').status, 'unset', '空字符串不算命名了一个 runtime');
});

test('a runtime pointing nowhere is unresolvable, not a mismatch', () => {
  fakePackage(sharedRoot());
  const found = resolveInstalledBase(fakeInstall('bogus'), SPEC);
  const bogus = join(sandbox, 'no-such-runtime', '@deepseek-ai', 'dsh');
  const result = compareWithRuntime(found, bogus);
  assert.equal(result.status, 'unresolvable');
  assert.equal(result.runtime, bogus);
});

test('the same scope reads as same, and another tree reads as different', () => {
  fakePackage(sharedRoot());
  const found = resolveInstalledBase(fakeInstall('compare'), SPEC);

  const ownScopeRuntime = join(scopeOf(sharedRoot()), 'dsh');
  mkdirSync(ownScopeRuntime, { recursive: true });
  assert.equal(compareWithRuntime(found, ownScopeRuntime).status, 'same');

  const otherRuntime = join(sandbox, 'elsewhere', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(otherRuntime, { recursive: true });
  assert.equal(compareWithRuntime(found, otherRuntime).status, 'different');
});
