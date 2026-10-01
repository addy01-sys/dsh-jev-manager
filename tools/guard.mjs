/**
 * Reversibility guard.
 *
 * The requirement this exists for: any feature can be turned on, and turning it off
 * must leave DSH's configuration exactly as it was. "Exactly as it was" is not a
 * feeling, so this records a baseline of the files a plugin install can touch and
 * compares later. Only paths, sizes and SHA-256 digests are stored — never contents,
 * because the watched tree sits next to credential files that must not be copied.
 *
 *   node tools/guard.mjs snapshot          # record the current state
 *   node tools/guard.mjs compare           # exit 1 on any drift
 *   node tools/guard.mjs status            # show what is watched, read-only
 *
 * Typical use is around an install/uninstall or an on/off toggle:
 *   node tools/guard.mjs snapshot
 *   node tools/install.mjs --enable review
 *   node tools/install.mjs --disable review
 *   node tools/guard.mjs compare           # must be silent
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const baselinePath = join(pluginRoot, '.dsh-state', 'baseline.json');

/**
 * An explicit allowlist, never a recursive scan of `~/.dsh`: sessions, storages and
 * `.credentials.yaml` live there and are not this plugin's business.
 */
function watched() {
  const paths = [
    join(dshHome, 'cordis.patch.yml'),
    join(dshHome, 'pnpm-workspace.yaml'),
    join(dshHome, '.agent-presets'),
    join(dshHome, 'plugins'),
  ];
  const profiles = join(dshHome, 'profiles');
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      // A profile's own bundle list, its user patch layer, and the dependency
      // manifests `dsh plugin add` rewrites.
      for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml']) {
        paths.push(join(profiles, entry.name, file));
      }
      paths.push(join(profiles, entry.name, 'node_modules'));
    }
  }
  // This plugin's own junctions: an upgrade that moves the harness must not leave
  // them pointing at a deleted path.
  paths.push(join(pluginRoot, 'node_modules'));
  return paths;
}

/** @returns {Record<string, {kind: string, size: number, digest: string|null}>} */
function fingerprint() {
  const state = {};
  for (const path of watched()) {
    const key = relative(join(dshHome, '..'), path).replace(/\\/g, '/') || '.';
    if (!existsSync(path)) {
      state[key] = { kind: 'absent', size: 0, digest: null };
      continue;
    }
    const info = statSync(path);
    if (info.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true })
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''}`)
        .sort();
      state[key] = {
        kind: 'dir',
        size: entries.length,
        digest: createHash('sha256').update(entries.join('\n')).digest('hex'),
      };
      continue;
    }
    state[key] = {
      kind: 'file',
      size: info.size,
      digest: createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16),
    };
  }
  return state;
}

const mode = process.argv[2];
const state = fingerprint();

if (mode === 'snapshot') {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ dshHome: dshHome.replace(/\\/g, '/'), taken: new Date().toISOString(), state }, null, 2)}\n`,
    'utf8',
  );
  console.log(`✓ baseline recorded: ${Object.keys(state).length} paths → ${relative(pluginRoot, baselinePath)}`);
} else if (mode === 'status') {
  console.log(`DSH_HOME  : ${dshHome}`);
  console.log(`baseline  : ${existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).taken : 'none — run: node tools/guard.mjs snapshot'}`);
  for (const [key, value] of Object.entries(state)) {
    console.log(`  ${value.kind === 'absent' ? '·' : value.kind === 'dir' ? 'd' : 'f'} ${key}${value.kind === 'file' ? `  ${value.size}B ${value.digest}` : ''}`);
  }
} else if (mode === 'compare') {
  if (!existsSync(baselinePath)) {
    console.error('no baseline. run: node tools/guard.mjs snapshot');
    process.exit(1);
  }
  const recorded = JSON.parse(readFileSync(baselinePath, 'utf8'));
  // A baseline taken under another DSH_HOME describes a different tree. Refusing beats
  // reporting dozens of "differences" that mean nothing — this gate is only worth
  // trusting if it cannot be fooled about which tree it is checking.
  if (recorded.dshHome !== undefined && resolve(recorded.dshHome) !== resolve(dshHome)) {
    console.error(`基线属于另一个 DSH_HOME：\n  基线: ${recorded.dshHome}\n  当前: ${dshHome.replace(/\\/g, '/')}\n用同一棵树重新 snapshot，或清掉 DSH_HOME 变量。`);
    process.exit(1);
  }
  const baseline = recorded.state;
  const drift = [];
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(state)])) {
    const before = baseline[key];
    const after = state[key];
    if (!before) drift.push(`+ 新增     ${key}`);
    else if (!after) drift.push(`- 消失     ${key}`);
    else if (before.digest !== after.digest || before.kind !== after.kind) {
      drift.push(`~ 内容变化 ${key}  (${before.size}→${after.size}B, ${before.digest}→${after.digest})`);
    }
  }
  if (drift.length === 0) {
    console.log(`✓ 与基线逐字节一致，${Object.keys(state).length} 个路径无残留`);
  } else {
    console.log(`✗ 相对基线有 ${drift.length} 处差异：`);
    for (const line of drift) console.log(`  ${line}`);
    console.log('\n关掉功能后不应出现任何一行。若只剩「· 消失」以外的差异，说明卸载没还原。');
    process.exit(1);
  }
} else {
  console.log('用法: node tools/guard.mjs <snapshot|compare|status>');
  process.exitCode = mode ? 1 : 0;
}
