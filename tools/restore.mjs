/**
 * Put the profile's configuration files back exactly as `tools/install.mjs` found them.
 *
 * Needed because `dsh plugin remove` restores only two snapshots and reflows what it
 * rewrites — measured here as `package.json` 207 B → 185 B, a lock file going from
 * absent to a 115 B stub, and leftover `node_modules` entries. Byte-level "恢复原样"
 * therefore has to come from a pre-install copy, which is what this restores.
 *
 *   node tools/restore.mjs --profile web
 *
 * It only ever touches the files recorded in the backup manifest — paths under
 * `$DSH_HOME/profiles/<profile>/` plus the two patch layers — and deletes nothing else.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDir } from '../lib/features.mjs';

/**
 * @param {{profile: string, dshHome?: string}} options
 * @returns {{restored: string[], deleted: string[], missing: string[], reason?: string}}
 */
export function restoreBackup({ profile, dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh')) }) {
  const backupDir = join(stateDir(), 'install-backup', profile);
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { restored: [], deleted: [], missing: [], reason: `没有 ${profile} 的备份（${manifestPath}）` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')).manifest ?? {};
  const restored = [];
  const deleted = [];
  const missing = [];
  for (const [name, entry] of Object.entries(manifest)) {
    const target = typeof entry === 'string' ? entry : entry?.path;
    if (typeof target !== 'string' || !join(dshHome).startsWith(resolve(dshHome))) {
      missing.push(name);
      continue;
    }
    if (typeof entry === 'object' && entry.absent === true) {
      // The install created this file: removing it is the restore.
      if (existsSync(target)) {
        rmSync(target, { force: true });
        deleted.push(target);
      }
      continue;
    }
    const image = join(backupDir, name);
    if (!existsSync(image)) {
      missing.push(name);
      continue;
    }
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(image, target);
    restored.push(target);
  }
  return { restored, deleted, missing };
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const list = process.argv.slice(2);
  const index = list.indexOf('--profile');
  const profile = index >= 0 ? list[index + 1] : 'web';
  if (!profile) {
    console.error('--profile 需要一个值');
    process.exit(1);
  }
  const result = restoreBackup({ profile });
  if (result.reason !== undefined) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(`还原 ${result.restored.length} 个文件${result.deleted.length > 0 ? `，删除安装新建的 ${result.deleted.length} 个` : ''}`);
  for (const path of result.restored) console.log(`  ← ${path}`);
  for (const path of result.deleted) console.log(`  ✗ ${path}`);
  if (result.missing.length > 0) {
    console.error(`⚠ ${result.missing.length} 项无法处理: ${result.missing.join(', ')}`);
    process.exitCode = 1;
  }
  console.log('\n核对：node tools/guard.mjs compare');
}
