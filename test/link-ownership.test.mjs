/**
 * Ownership rule for junction removal, and the CLI wiring that uses it.
 *
 * The bug this pins: `--remove` used to delete any entry whose *name* matched, in a
 * directory every profile shares. On this machine `$DSH_HOME/profiles/node_modules` holds
 * 249 junctions the harness made itself, three of them with the very names this tool
 * wants — so an uninstall took another runtime's dependencies away, and `guard.mjs` cannot
 * see it because it skips that directory.
 *
 * A target comparison is not enough either, and that is the case worth pinning: with
 * `DSH_RUNTIME_ROOT` unset — which is how `uninstall.mjs` calls this tool — the runtime
 * this tool would link to IS the npm install those harness junctions already point at.
 * Ownership has to come from authorship: the ledger written when the link is created.
 *
 * The rule is pure and tested directly; the CLI is then run for real against temporary
 * directories, with stdout going to a file rather than a pipe so the suite still works
 * where child-process pipes are restricted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { foreignLinkReason, canonicalPath } = await import(pathToFileURL(join(pluginRoot, 'tools/link-ownership.mjs')).href);

const WANTED = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-session'];
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const NPM = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-session';

/** @param {object} overrides */
const decide = (overrides = {}) =>
  foreignLinkReason({
    link: join('C:\\runtime', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-session'),
    current: null,
    raw: null,
    ownsDestination: false,
    recorded: null,
    ...overrides,
  });

test('the checkout’s own node_modules is ours outright', () => {
  assert.equal(decide({ ownsDestination: true, current: 'D:\\elsewhere' }), null);
});

test('a link the ledger records, still pointing where it was recorded, is ours', () => {
  assert.equal(decide({ current: 'C:\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-session', recorded: { target: 'c:/APP/dsh/node_modules/@deepseek-ai/dsh-session' } }), null,
    '比较必须忽略大小写与分隔符：Windows 同一个目录会有多种拼写');
});

test('a ledger entry whose link was re-pointed is not ours to delete', () => {
  const reason = decide({ current: 'D:\\other\\dsh-session', recorded: { target: 'C:\\app\\dsh-session' } });
  assert.match(reason, /记录里它指向/);
  assert.match(reason, /现在却指向/);
});

test('the harness’s own junction is left alone even though it points where we would link', () => {
  // This is the real shape: the harness's batch and this tool both resolve to the same npm
  // install when DSH_RUNTIME_ROOT is unset, so only the ledger can separate them.
  const reason = decide({ current: NPM, raw: NPM, recorded: null });
  assert.match(reason, /它指向 .*npm/);
});

test('a dangling link into app.asar is the desktop bridge, which nothing else creates', () => {
  const raw = 'C:\\app\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-session';
  assert.equal(decide({ raw }), null);
  assert.match(decide({ raw: NPM }), /已经不存在/, '失效的 npm 链接仍然不是我们的');
});

test('a dangling link with no evidence at all is foreign', () => {
  assert.match(decide({ raw: 'C:\\somewhere\\else\\dsh-session' }), /已经不存在/);
  assert.match(decide({ raw: null }), /读不到它的链接目标/);
});

test('the rule survives a Windows junction prefix and a trailing separator', () => {
  assert.equal(decide({ current: '\\\\?\\C:\\runtime\\node_modules\\@deepseek-ai\\dsh-session\\', recorded: { target: 'c:/runtime/node_modules/@deepseek-ai/dsh-session' } }), null);
  assert.equal(canonicalPath('\\\\?\\C:\\Runtime\\X\\'), 'c:/runtime/x');
});

/**
 * The CLI half, run for real: create establishes the ledger, remove is judged by it, and a
 * junction belonging to "another runtime" survives both.
 */
const sandbox = resolve(mkdtempSync(join(tmpdir(), 'jev-manager-links-')));
const shared = join(sandbox, 'shared');
const runtime = join(sandbox, 'runtime');
const foreignRuntime = join(sandbox, 'foreign-runtime');
const home = join(sandbox, 'home');

function packageAt(root, name) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  return dir;
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { recursive: true, force: true });
  rmSync(path, { force: true });
  symlinkSync(target, path, LINK_TYPE);
}

/** Run the CLI with stdout/stderr on files: no pipes, so this works under confinement too. */
function runCli(args, env = {}) {
  const outPath = join(sandbox, `out-${Math.random().toString(36).slice(2)}.txt`);
  const errPath = `${outPath}.err`;
  const out = openSync(outPath, 'w');
  const err = openSync(errPath, 'w');
  try {
    const result = spawnSync(process.execPath, [join(pluginRoot, 'tools/link-deps.mjs'), ...args], {
      cwd: pluginRoot,
      env: { ...process.env, DSH_HOME: home, ...env },
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

test('the CLI: create then remove takes ours and leaves another runtime’s alone', () => {
  for (const name of WANTED) packageAt(runtime, name);
  const foreignTarget = join(foreignRuntime, 'schemastery');
  mkdirSync(foreignTarget, { recursive: true });
  writeFileSync(join(foreignTarget, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery' }));

  // The foreign junction is placed first, exactly like the harness's batch: a name that
  // matches, a target that is not ours, and no ledger entry.
  const theirs = join(shared, '@deepseek-ai', 'schemastery');
  link(foreignTarget, theirs);

  const created = runCli(['--dest', shared], { DSH_RUNTIME_ROOT: runtime });
  assert.equal(created.status, 0, created.stderr);
  const ours = join(shared, '@deepseek-ai', 'dsh-session');
  assert.ok(existsSync(ours), `创建应当成功：\n${created.stdout}`);
  assert.ok(existsSync(theirs), '已存在的链接不得被顶掉');
  assert.match(created.stdout, /已指向另一套 harness|already linked/);

  const removed = runCli(['--remove', '--dest', shared], { DSH_RUNTIME_ROOT: runtime });
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(ours), '本工具建的链接应当被删掉');
  assert.ok(existsSync(theirs), '没有记录的链接必须原样保留');
  assert.match(removed.stdout, /未改动/);
  assert.match(removed.stdout, /另有 1 个同名链接/);
  assert.ok(existsSync(join(shared, '@deepseek-ai')), '还有别人的链接时不得顺手删掉整个 scope 目录');
});

test('the CLI: --remove without a ledger touches nothing, even when the target matches', () => {
  for (const name of WANTED) packageAt(runtime, name);
  // Point at the runtime this run would also choose, but record nothing: the harness's own
  // junction has exactly this shape, and deleting it is the bug being pinned.
  const mine = join(shared, '@deepseek-ai', 'dsh-compaction-basic');
  link(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic'), mine);
  rmSync(join(home, 'jev-manager', 'links.json'), { force: true });

  const result = runCli(['--remove', '--dest', shared], { DSH_RUNTIME_ROOT: runtime });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(mine), '没有 authorship 证据就不能删，哪怕目标一模一样');
  assert.match(result.stdout, /未改动/);
});

test('the CLI: --force removes what the rule refuses', () => {
  for (const name of WANTED) packageAt(runtime, name);
  const theirs = join(shared, '@deepseek-ai', 'dsh-session');
  link(join(foreignRuntime, 'schemastery'), theirs);
  rmSync(join(home, 'jev-manager', 'links.json'), { force: true });

  const result = runCli(['--remove', '--dest', shared, '--force'], { DSH_RUNTIME_ROOT: runtime });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(theirs), '--force 才是删除别人链接的开关');
});
