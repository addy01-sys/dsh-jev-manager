/**
 * Clean uninstall: remove the bundle from a profile AND put the profile's files back
 * byte for byte, then delete everything this plugin created.
 *
 * The harness makes no promise about files a plugin wrote: its own reversibility
 * guarantee covers effects registered through `ctx.effect` / `ctx.on`, and
 * `dsh plugin remove` restores only two snapshots. Measured on this machine, a full
 * add/remove cycle left `package.json` reflowed (207 B → 185 B), the lock file created
 * where none existed, and `node_modules` populated — hence the backup restore here.
 *
 *   node tools/uninstall.mjs --profile web            # remove + restore + clean state
 *   node tools/uninstall.mjs --profile web --check     # report only
 *
 * A step that fails is named, the backup is kept, and the exit code is 1 — the state
 * directory is deleted only after every step succeeded.
 *
 * Afterwards verify: node tools/guard.mjs compare
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearStateDir, featuresPath, readFeatures, stateDir } from '../lib/features.mjs';
import { restoreBackup } from './restore.mjs';

const require_ = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'));
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = resolve(process.env.DSH_HOME ?? join(require_('node:os').homedir(), '.dsh'));
const list = process.argv.slice(2);
const profileIndex = list.indexOf('--profile');
const profileValue = profileIndex >= 0 ? (list[profileIndex + 1] ?? '') : null;
if (profileValue !== null && profileValue.trim().length === 0) {
  console.error('--profile 需要一个值（例如 --profile desktop）');
  process.exit(1);
}
const profile = profileValue ?? 'web';
const packageName = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).name;

function locateCli() {
  for (const root of [process.env.DSH_RUNTIME_ROOT, join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh')].filter(Boolean)) {
    for (const candidate of [resolve(root), join(resolve(root), 'node_modules/@deepseek-ai/dsh')]) {
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

const ownedState = existsSync(stateDir());
const junctions = existsSync(join(pluginRoot, 'node_modules')) ? readdirSync(join(pluginRoot, 'node_modules')) : [];
const hasBackup = existsSync(join(stateDir(), 'install-backup', profile, 'manifest.json'));

console.log(`profile : ${profile}\nDSH_HOME: ${dshHome}`);
console.log(`自有状态: ${stateDir()}${ownedState ? '' : '（不存在）'}`);
if (ownedState) console.log(`  开关: ${JSON.stringify(readFeatures())}  @ ${relative(pluginRoot, featuresPath())}`);
console.log(`配置备份: ${hasBackup ? '有（可还原到安装前字节）' : '无（只能依赖 dsh plugin remove 的还原）'}`);
console.log(`依赖 junction: ${junctions.length > 0 ? junctions.join(', ') : '（无）'}`);

if (list.includes('--check')) {
  console.log('\n--check：没有删除或还原任何东西。');
  process.exit(0);
}

const cli = locateCli();
if (cli === null) {
  console.error('找不到 dsh CLI：设 DSH_RUNTIME_ROOT 后重试，或在 app 内卸载。');
  process.exit(1);
}
// Every step below can fail on its own, and each failure is a reason to stop short of
// deleting the backup: rerunning this command is the documented fix, and the pre-images
// are the only copy of the bytes a restore needs. A failure that reports success would
// leave the profile half-removed with nothing left to restore from.
const failures = [];

try {
  execFileSync(process.execPath, [cli, 'plugin', '--profile', profile, 'remove', packageName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`✓ dsh plugin --profile ${profile} remove ${packageName}`);
} catch (error) {
  failures.push('dsh plugin remove 失败');
  console.error(`remove 失败：${String(error.stderr ?? error.message).split('\n')[0]}`);
}

const result = restoreBackup({ profile, dshHome });
if (result.reason !== undefined) {
  failures.push('配置层未还原');
  console.log(`⚠ ${result.reason}`);
} else {
  console.log(`✓ 还原 ${result.restored.length} 个文件${result.deleted.length > 0 ? `，删除安装新建的 ${result.deleted.length} 个` : ''}`);
  if (result.missing.length > 0) {
    failures.push(`还原缺 ${result.missing.length} 项`);
    console.log(`⚠ 无法处理: ${result.missing.join(', ')}`);
  }
}

// Junctions point into one specific harness install. Left in place they would resolve
// the harness packages from the WRONG copy — a second `@deepseek-ai/cordis` and a second
// `BasicCompactionEngine`, which breaks the provider's subclassing. Both layouts go:
// this checkout's, and the `$DSH_HOME/profiles/node_modules` pair install.mjs created.
// link-deps proves ownership by target before deleting anything; a link belonging to
// another harness is reported and left alone, which is not a failure here.
for (const extra of [[], ['--shared']]) {
  try {
    execFileSync(
      process.execPath,
      [join(pluginRoot, 'tools/link-deps.mjs'), '--remove', ...extra],
      { stdio: 'inherit', env: { ...process.env, DSH_HOME: dshHome } },
    );
  } catch (error) {
    failures.push(`junction 清理失败（${extra.join(' ') || 'checkout'}）`);
    console.error(`✗ junction 清理失败：${String(error.message).split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`\n✗ 卸载没有完整完成：${failures.join('；')}`);
  console.error(`  自有状态与备份保留在 ${stateDir()}（安装前的原始字节在里面）。`);
  console.error('  修掉上面的问题后重跑本命令；成功之前不要手工删这个目录。');
  process.exitCode = 1;
} else {
  const cleared = clearStateDir();
  console.log(`\n已删除：${cleared !== null ? cleared : '（无自有状态）'}`);
}
console.log('核对配置层是否逐字节回到安装前：node tools/guard.mjs compare');
