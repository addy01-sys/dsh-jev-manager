/**
 * Uninstall must fail loudly, and must not throw away the only copy of the bytes it is
 * supposed to restore.
 *
 * The bug this pins: `dsh plugin remove` failing was a log line, a restore that could not
 * complete was a `⚠`, and the state directory — the pre-images live inside it — was deleted
 * unconditionally right after. Every path exited 0, so a half-removed profile looked like a
 * successful uninstall with nothing left to retry from.
 *
 * The CLI is run from a copy of the package inside a temp directory, so the checkout's own
 * junctions and DSH_HOME are never touched.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = resolve(mkdtempSync(join(tmpdir(), 'jev-manager-uninstall-')));

after(() => rmSync(sandbox, { recursive: true, force: true }));

/** A copy of the package whose own `node_modules` does not exist, so link cleanup is a no-op. */
const copy = join(sandbox, 'plugin');
cpSync(pluginRoot, copy, {
  recursive: true,
  filter: (source) => !/[\\/](node_modules|\.dsh-state|\.git)([\\/]|$)/.test(source),
});

/**
 * A stand-in for the `dsh` CLI: a package whose bin exits with `code`.
 * @returns {string} a DSH_RUNTIME_ROOT for it
 */
function fakeCli(name, code) {
  const root = join(sandbox, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0', bin: { dsh: 'bin.js' } }));
  writeFileSync(join(root, 'bin.js'), `process.exit(${code});\n`);
  return root;
}

/** @returns {{status: number, stdout: string, stderr: string}} */
function run(args, env) {
  const outPath = join(sandbox, `out-${Math.random().toString(36).slice(2)}.txt`);
  const errPath = `${outPath}.err`;
  const out = openSync(outPath, 'w');
  const err = openSync(errPath, 'w');
  try {
    const result = spawnSync(process.execPath, [join(copy, 'tools/uninstall.mjs'), ...args], {
      cwd: copy,
      env: { ...process.env, ...env },
      stdio: ['ignore', out, err],
    });
    return { status: result.status, stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(outPath, { force: true });
    rmSync(errPath, { force: true });
  }
}

/** A DSH_HOME carrying recorded pre-images, so a restore has something to do. */
function preparedHome(name) {
  const dshHome = join(sandbox, name);
  const backup = join(dshHome, 'jev-manager', 'install-backup', 'web');
  mkdirSync(backup, { recursive: true });
  const profile = join(dshHome, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(dshHome, 'jev-manager', 'features.json'), JSON.stringify({ decision: false, review: false, provider: false }));
  writeFileSync(join(backup, 'profiles__web__package.json'), '{"name":"dsh-profile-web"}\n');
  writeFileSync(
    join(backup, 'manifest.json'),
    `${JSON.stringify({ profile: 'web', manifest: { 'profiles__web__package.json': join(profile, 'package.json') } }, null, 2)}\n`,
  );
  // The install left a file the restore deletes, and rewrote the profile manifest.
  writeFileSync(join(profile, 'package.json'), '{"name":"dsh-profile-web","dependencies":{"dsh-jev-manager":"0.1.0"}}\n');
  return { dshHome, backup: join(dshHome, 'jev-manager'), profile };
}

test('--profile without a value is refused instead of guessing a profile', () => {
  const result = run(['--profile'], { DSH_HOME: join(sandbox, 'unused-home') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--profile 需要一个值/);
});

test('a failing plugin remove reports the failure, exits 1, and keeps the backup', () => {
  const { dshHome, backup } = preparedHome('failing');
  const result = run(['--profile', 'web'], { DSH_HOME: dshHome, DSH_RUNTIME_ROOT: fakeCli('cli-fail', 3) });

  assert.equal(result.status, 1, `卸载失败必须非 0 退出：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /remove 失败/);
  assert.match(result.stderr, /卸载没有完整完成/);
  assert.match(result.stderr, /dsh plugin remove 失败/);
  assert.ok(existsSync(backup), '未完成时不得删除自有状态与备份');
  assert.ok(existsSync(join(backup, 'install-backup', 'web', 'manifest.json')), '原始字节备份必须还在，好让重跑能收敛');
  assert.doesNotMatch(result.stdout, /已删除：/, '不能一边说失败一边报“已删除”');
});

test('a clean run restores, exits 0, and only then deletes its own state', () => {
  const { dshHome, backup, profile } = preparedHome('clean');
  const result = run(['--profile', 'web'], { DSH_HOME: dshHome, DSH_RUNTIME_ROOT: fakeCli('cli-ok', 0) });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), '{"name":"dsh-profile-web"}\n', '必须逐字节还原');
  assert.ok(!existsSync(backup), '全部成功之后才收掉自有状态');
  assert.match(result.stdout, /已删除：/);
});
