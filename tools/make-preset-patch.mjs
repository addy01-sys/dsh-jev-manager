/**
 * Generate the patch layer that mounts the Jev compaction provider on DSH 0.2.
 *
 * Why this exists, in the order the loader taught us:
 *   1. Overriding an existing id may not change its `name` — a bundle patch that
 *      renamed `compaction-basic` was skipped with
 *      `patch: name mismatch for "compaction-basic" … skipping`.
 *   2. The `compaction` group is not a top-level entry; it is nested inside a
 *      preset row's `config.plugins`, so `patch: entry "compaction" not found`.
 *   3. The top-level entries ARE the presets (`- id: preset-standard`,
 *      `name: '@deepseek-ai/dsh-agent-preset'`), and "declare a new preset" is a
 *      supported move. So we add a preset beside `standard` rather than editing it.
 *
 * The source of truth is the harness's OWN composed default config
 * (`dsh --dump-default-config`), not a file in a package — so what we copy is exactly
 * what this version runs, including the `!!js` platform conditions. Re-run this after
 * a harness upgrade to regenerate the layer.
 *
 *   node tools/make-preset-patch.mjs                 # write jev-preset.patch.yml
 *   node tools/make-preset-patch.mjs --profile web   # compose from another profile
 *   node tools/make-preset-patch.mjs --check         # regenerate and compare only
 *
 * Using it (no user file is modified — it is a launch overlay):
 *   dsh --profile desktop --patch ./jev-preset.patch.yml
 * then pick the「Jev 上下文整理」preset for the session.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(pluginRoot, 'jev-preset.patch.yml');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

/** Locate a dsh CLI: an explicit runtime root, then the npm global install, then PATH. */
function cliPath() {
  const roots = [
    process.env.DSH_RUNTIME_ROOT,
    // The npm global install IS the dsh package.
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh'),
  ].filter(Boolean);
  for (const root of new Set(roots.map((r) => resolve(r)))) {
    for (const candidate of [root, join(root, 'node_modules/@deepseek-ai/dsh')]) {
      const manifest = join(candidate, 'package.json');
      if (!existsSync(manifest)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      } catch {
        continue;
      }
      if (parsed.name !== '@deepseek-ai/dsh') continue;
      const entry = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.dsh;
      if (typeof entry !== 'string') continue;
      const bin = join(candidate, entry);
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

const profile = value('profile', 'web');
const cli = cliPath();
if (cli === null) {
  console.error('找不到 dsh CLI。设 DSH_RUNTIME_ROOT 指向 dsh 安装目录（含 package.json）。');
  process.exit(1);
}

// `dsh` refuses to touch the desktop profile at all — `profile "desktop" is managed
// exclusively by the Electron application` — and it refuses even for a read-only dump.
// That does not block this tool: the preset rows come from the harness bundle, so any
// CLI-readable profile on the SAME runtime composes an identical `preset-standard` block.
const dump = (name) =>
  execFileSync(process.execPath, [cli, '--profile', name, '--dump-default-config'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

let composed;
let used = profile;
try {
  composed = dump(profile);
} catch (error) {
  const refused = /managed exclusively by the Electron application/.test(String(error.stderr ?? error.message));
  const fallback = refused ? (profile === 'web' ? 'default' : 'web') : null;
  if (fallback === null) throw error;
  console.error(`! profile "${profile}" 由 app 独占，CLI 连只读 dump 都拒绝；改用 ${fallback} 取同一份 runtime 的 preset-standard 块。`);
  composed = dump(fallback);
  used = fallback;
}

const lines = composed.split(/\r?\n/);
const start = lines.findIndex((line) => /^- id: preset-standard\s*$/.test(line));
if (start < 0) {
  console.error(`这份 dsh 的组合结果里没有 preset-standard 行（profile=${profile}）。`);
  console.error('它可能仍是目录式 preset（<0.2）；那种版本请用 tools/install-preset.mjs。');
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^- id: \S/.test(lines[i])) { end = i; break; }
}
const block = lines.slice(start, end);
console.log(`来源: ${cli}\nprofile: ${used} | preset-standard 行 ${start + 1}–${end}（${block.length} 行）`);

/** The compaction group member that names the stock backend. */
const memberIndex = block.findIndex((line) => /^ +- id: compaction-basic\s*$/.test(line));
if (memberIndex < 0) {
  console.error('这个 preset 里没有 compaction-basic 成员，形状变了；请人工核对后再改本脚本。');
  process.exit(1);
}
const memberLine = block[memberIndex];
const nameLine = block[memberIndex + 1];
if (!/^\s+name: '@deepseek-ai\/dsh-compaction-basic'\s*$/.test(nameLine)) {
  console.error(`compaction-basic 的成员形状不符预期: ${JSON.stringify(nameLine)}`);
  process.exit(1);
}
// Indentation comes from the lines themselves, so a harness that re-nests the preset
// tree still produces a valid layer instead of a silently mis-indented YAML file.
const memberPad = ' '.repeat(memberLine.search(/\S/));
const pad = ' '.repeat(nameLine.search(/\S/));

const replaced = [
  ...block.slice(0, memberIndex),
  `${memberPad}- id: jev-compaction`,
  `${pad}name: 'dsh-jev-manager/compaction'`,
  `${pad}config:`,
  `${pad}  # 默认 shadow：跑完整判断、写日志，仍采用 DSH 自己的摘要。`,
  `${pad}  adopt: false`,
  ...block.slice(memberIndex + 2),
];

const renamed = replaced.map((line, index) => {
  if (index === 0) return '- id: preset-jev';
  if (/^ {4}id: \S+\s*$/.test(line)) return '    id: jev';
  if (/^ {4}order: \d+\s*$/.test(line)) return '    order: 90';
  return line;
});

// A top-level `- id:` line in a patch layer means "override the existing entry with
// this id" — declaring a brand-new preset needs the `insert` wrapper, or the loader
// reports `patch: entry "preset-jev" not found`.
const wrapped = ['- insert:', ...renamed.map((line) => (line.length === 0 ? '' : `  ${line}`))];

const banner = [
  '# 由 tools/make-preset-patch.mjs 生成，底稿是这台机器上 dsh 自己的组合默认配置。',
  '# 不要手改：升级 harness 后重跑生成脚本。',
  '#',
  '# 它在 official preset 旁边新增一个可选预设「Jev 上下文整理」，唯一的差异是把',
  '# compaction 组里的 compaction-basic 成员换成本插件的 provider。不覆盖、不停用任何',
  '# 官方 preset；不选它，行为与安装本插件前完全一致。',
  '#',
  '# 用法（叠加层，不写你的 profile 文件）：',
  '#   dsh --profile desktop --patch ./jev-preset.patch.yml',
  '#   dsh --profile web     --patch ./jev-preset.patch.yml',
  '#',
  `# 生成时间: ${new Date().toISOString()}  来源 profile: ${used}  底稿行: preset-standard (${start + 1}–${end})`,
  '',
].join('\n');

const body = `${banner}${wrapped.join('\n')}\n`;

if (flag('check')) {
  const payload = (text) => text.slice(text.indexOf('- insert:')).join('\n');
  const before = existsSync(outPath) ? payload(readFileSync(outPath, 'utf8').split('\n')) : null;
  const same = before === payload(body.split('\n'));
  console.log(same ? '✓ jev-preset.patch.yml 与当前 harness 组合一致' : '✗ 已漂移：重跑 node tools/make-preset-patch.mjs');
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(outPath, body, 'utf8');
  console.log(`✓ 写出 ${outPath}\n  行数 ${body.split('\n').length}，压缩成员: compaction-basic → jev-compaction`);
  console.log('  下一步: dsh --profile ' + used + ' --patch ./jev-preset.patch.yml --dump-config  确认新 preset 出现');
}
