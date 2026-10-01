/**
 * Install into a DSH profile and remember enough to undo it byte for byte.
 *
 * `dsh plugin add` rewrites the profile's `package.json` (dependencies plus the
 * ordered `dsh.profile.bundles` list) and its `pnpm-lock.yaml`, and measured on this
 * machine it does NOT give those bytes back on remove: after a full add/remove cycle
 * `package.json` came back at 185 B where it had been 207 B (pnpm reflows it), the lock
 * file went from absent to a 115 B stub, and the profile's `node_modules` kept entries.
 * That is the harness's own documented limit, not a bug to report upstream.
 *
 * So this tool snapshots the files the install will touch BEFORE running it, and
 * `tools/uninstall.mjs` restores them. The backup lives in this plugin's own state
 * directory, and holds only the files being replaced — never a credential file.
 *
 *   node tools/install.mjs --profile web
 *   node tools/install.mjs --profile desktop --dry-run
 *
 * The desktop app refuses CLI management; on desktop, install through the app's own
 * plugin page and then run `node tools/install.mjs --profile desktop --adopt` to record
 * a backup of what it changed.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDir } from '../lib/features.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
const args = new Set(process.argv.slice(2));
const value = (name, fallback) => {
  const list = process.argv.slice(2);
  const index = list.indexOf(`--${name}`);
  return index >= 0 && list[index + 1] !== undefined ? list[index + 1] : fallback;
};
const profile = value('profile', 'web');
const packageName = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).name;

/** Only these are rewritten by a bundle install; credentials and sessions are never touched. */
const touched = [
  join(dshHome, 'profiles', profile, 'package.json'),
  join(dshHome, 'profiles', profile, 'pnpm-lock.yaml'),
  join(dshHome, 'profiles', profile, 'cordis.patch.yml'),
  join(dshHome, 'profiles', profile, 'pnpm-workspace.yaml'),
  join(dshHome, 'profiles', profile, 'cordis.yml'),
  join(dshHome, 'cordis.patch.yml'),
];
const backupDir = join(stateDir(), 'install-backup', profile);
const manifestPath = join(backupDir, 'manifest.json');

function locateCli() {
  const roots = [process.env.DSH_RUNTIME_ROOT, join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh')].filter(Boolean);
  for (const root of roots.map((r) => resolve(r))) {
    for (const candidate of [root, join(root, 'node_modules/@deepseek-ai/dsh')]) {
      const manifest = join(candidate, 'package.json');
      if (!existsSync(manifest)) continue;
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        if (parsed.name !== '@deepseek-ai/dsh') continue;
        const entry = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.dsh;
        if (typeof entry === 'string' && existsSync(join(candidate, entry))) return join(candidate, entry);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const present = touched.filter((path) => existsSync(path));
console.log(`profile: ${profile}\nDSH_HOME: ${dshHome}\n将备份 ${present.length} 个文件：`);
for (const path of present) console.log(`  ${relative(dshHome, path)}`);

if (args.has('--dry-run')) {
  console.log('\n--dry-run：没有改动任何东西。');
  process.exit(0);
}

if (args.has('--adopt')) {
  // The app already installed the bundle; just record the current bytes so uninstall
  // can put them back. Nothing is verified about whether the bundle is ours. Same rule
  // as below: a recorded pre-image is never overwritten by a later, already-modified one.
  mkdirSync(backupDir, { recursive: true });
  const manifest = {};
  try {
    Object.assign(manifest, JSON.parse(readFileSync(manifestPath, 'utf8')).manifest ?? {});
  } catch {
    /* first record for this profile */
  }
  for (const path of present) {
    const name = relative(dshHome, path).replace(/[\\/]/g, '__');
    if (name in manifest) continue;
    copyFileSync(path, join(backupDir, name));
    manifest[name] = path;
  }
  writeFileSync(manifestPath, `${JSON.stringify({ adopted: true, taken: new Date().toISOString(), manifest }, null, 2)}\n`);
  console.log(`\n✓ 已记录现有字节（${Object.keys(manifest).length} 个文件），卸载时可还原`);
  process.exit(0);
}

mkdirSync(backupDir, { recursive: true });
// A second `install` must not destroy the pre-image the first one took: by then the files
// already carry our own edits, so re-backing-up would pin "restore" to the installed state
// instead of the original. Earlier entries win; only paths never recorded get a new one.
const manifest = {};
let previous = null;
try {
  previous = JSON.parse(readFileSync(manifestPath, 'utf8')).manifest ?? null;
} catch {
  /* first install for this profile */
}
let kept = 0;
for (const [name, record] of Object.entries(previous ?? {})) {
  const preImage = join(backupDir, name);
  const stillThere = record?.absent === true ? true : existsSync(preImage);
  if (stillThere) {
    manifest[name] = record;
    kept += 1;
  }
}
for (const path of present) {
  const name = relative(dshHome, path).replace(/[\\/]/g, '__');
  if (name in manifest) continue;
  copyFileSync(path, join(backupDir, name));
  manifest[name] = path;
}
// A file the install will CREATE has no pre-image; record that so restore deletes it.
for (const path of touched.filter((candidate) => !existsSync(candidate))) {
  const name = relative(dshHome, path).replace(/[\\/]/g, '__');
  if (!(name in manifest)) manifest[name] = { path, absent: true };
}
writeFileSync(manifestPath, `${JSON.stringify({ taken: new Date().toISOString(), profile, package: packageName, keptFromPrevious: kept, manifest }, null, 2)}\n`);
console.log(`✓ 备份写入 ${relative(pluginRoot, manifestPath)}（沿用早前 ${kept} 份原始字节）`);

const cli = locateCli();
if (cli === null) {
  console.error('找不到 dsh CLI：设 DSH_RUNTIME_ROOT，或先在 app 内安装。');
  process.exit(1);
}
const run = (mode) => {
  const out = execFileSync(process.execPath, [cli, 'plugin', '--profile', profile, mode, ...(mode === 'add' ? [pluginRoot] : [packageName])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3).join('\n');
};
try {
  console.log(run('add'));
} catch (error) {
  console.error(`dsh plugin add 失败：${String(error.stderr ?? error.message).split('\n')[0]}`);
  console.error('备份仍在，可用 node tools/restore.mjs 还原。');
  process.exit(1);
}

const composed = execFileSync(process.execPath, [cli, '--profile', profile, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const landed = composed.split(/\r?\n/).filter((line) => /jev-manager/.test(line));
console.log(landed.length > 0 ? `✓ 组合结果出现 ${landed.length} 行：\n  ${landed.slice(0, 4).join('\n  ')}` : '✗ 组合结果里没有我们的行，检查 cordis.patch.yml');
const skipped = composed.split(/\r?\n/).filter((line) => line.startsWith('dsh: ') && /skip|mismatch|not found/.test(line));
if (skipped.length > 0) console.log(`⚠ loader 警告：\n  ${skipped.join('\n  ')}`);

// The desktop install has no node_modules of its own, so the provider resolves its base
// class by walking up into `$DSH_HOME/profiles/node_modules`. Nothing else puts the
// harness's own copies there; without this the compaction row degrades to passthrough.
if (!args.has('--no-deps')) {
  console.log('\n建立 provider 依赖链接（$DSH_HOME/profiles/node_modules）：');
  try {
    const out = execFileSync(process.execPath, [join(pluginRoot, 'tools/link-deps.mjs'), '--shared'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Not creating a link can be the RIGHT answer: `profiles/node_modules` is shared by
    // every profile, so a link already aimed at another harness is left alone unless the
    // operator asks with --force. Say which case we are in instead of claiming success.
    console.log(/个链接已指向另一套 harness/.test(out)
      ? '  ! 共享目录里这三个链接指向另一套 harness，未改动（provider 会优先解析 app 自带那份）'
      : '  ✓ 链接完成');
  } catch (error) {
    console.error(`  ✗ 链接失败：provider 将退回 DSH 自带压缩（其余功能不受影响）`);
    console.error(String(error.stdout ?? error.stderr ?? error.message).split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n'));
  }
  // A `link:` install resolves from THIS checkout instead of the profile tree, so both
  // paths must end at the same harness copy. Aligning the checkout junctions to the same
  // runtime is what keeps the two from silently diverging.
  try {
    execFileSync(process.execPath, [join(pluginRoot, 'tools/link-deps.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('  ✓ 本地 checkout 链接已对齐到同一 runtime');
  } catch {
    console.log('  ! 未能对齐本地 checkout 链接（未设 DSH_RUNTIME_ROOT 时属正常）');
  }
}

// A directory install is a `link:` into this checkout, and Node resolves bare names from
// the module's REAL path — so the junctions sitting next to `lib/` win over the profile
// bridge above. Two different harnesses on those two paths is the double-copy bug: the
// provider mounts and reports success while subclassing a class the running harness does
// not recognise. Ask the installed file which copy it actually gets, and say so out loud
// if it disagrees with the runtime we were told about. This check runs even with
// `--no-deps`, because it is the safety net, not part of the repair.
// The mechanics (and the two Node behaviours that used to make this check lie) live in
// tools/base-class-check.mjs.
const installedEntry = join(dshHome, 'profiles', profile, 'node_modules', packageName, 'lib', 'compaction.js');
try {
  const { compareWithRuntime, resolveInstalledBase } = await import('./base-class-check.mjs');
  if (!existsSync(installedEntry)) {
    throw new Error(`找不到已安装副本 ${installedEntry} —— 这一步的 plugin add 可能没有真的装上`);
  }
  const found = resolveInstalledBase(installedEntry, '@deepseek-ai/dsh-compaction-basic');
  if (found === null) throw new Error(`已安装副本解析不到 @deepseek-ai/dsh-compaction-basic：${installedEntry}`);
  const comparison = compareWithRuntime(found, process.env.DSH_RUNTIME_ROOT);
  if (comparison.status === 'same' || comparison.status === 'different') {
    const same = comparison.status === 'same';
    console.log(`  ${same ? '✓' : '⚠'} provider 实际加载的基类: ${found}`);
    if (!same) {
      console.log('    ⚠ 已安装副本按裸名解析到的是另一份 harness。app 里 provider 会优先用 process.resourcesPath 取 app 自带那份，所以这条多半不影响桌面运行；但用 npm CLI 跑同一份副本时会绑错类。');
      console.log('    修法: 同一 DSH_RUNTIME_ROOT 下，link-deps.mjs --shared 与不带 --shared 各跑一次');
      process.exitCode = 1;
    }
  } else {
    // Not a comparison — say so instead of printing a tick nobody earned.
    console.log(`  · provider 实际加载的基类: ${found}`);
    console.log(
      comparison.status === 'unset'
        ? '    未设 DSH_RUNTIME_ROOT：只报出它绑了哪一份，没有和任何 runtime 比对。要核对就带上 DSH_RUNTIME_ROOT 重跑。'
        : `    DSH_RUNTIME_ROOT 指到的路径不可用（${comparison.runtime}），没做成比对。`,
    );
  }
} catch (error) {
  console.error(`  ✗ 装完自检未通过，provider 将退回 DSH 自带压缩：${String(error.message).split('\n')[0]}`);
  console.error('    修法: DSH_RUNTIME_ROOT=<harness 目录> node tools/link-deps.mjs --shared && 同前不带 --shared');
  process.exitCode = 1;
}

console.log('\n下一步：node tools/features.mjs enable decision');
