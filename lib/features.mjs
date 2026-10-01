/**
 * Feature switches, held in a file this plugin owns — never in DSH's configuration.
 *
 * WHY NOT plugin `Config` or a `disabled:` patch row: both live in
 * `~/.dsh/profiles/<p>/package.json` or `cordis.patch.yml`. Turning a feature off
 * would then leave a trace in the user's own configuration files, which is exactly
 * what the "关闭后恢复原样" requirement forbids. `dsh plugin remove` does not undo
 * those either — the official rollback only restores two snapshots, and the harness
 * makes no promise about files a plugin wrote.
 *
 * So state lives under `~/.dsh/jev-manager/`, this plugin's own directory: enabling or
 * disabling touches nothing the user authored, and `tools/uninstall.mjs` deletes the
 * whole directory.
 *
 * Every feature defaults to OFF. A fresh install registers exactly one tool
 * (`jev_features`) and one skill-free, network-free runtime.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The switchable capabilities. `control` is not one of them: it is always on. */
export const FEATURES = Object.freeze({
  decision: {
    label: 'Jev 决策工具',
    tools: ['jev_status', 'jev_check_connection', 'jev_evaluate'],
    skills: ['jev-decision'],
    summary: '让当前 Agent 用 Jev 在真实可用的工具/Skill/Agent 之间做选择、按标准评分。只读，不执行推荐动作。',
  },
  review: {
    label: '上下文整理分析',
    tools: ['jev_context_review', 'jev_review_report'],
    skills: ['jev-context-review'],
    summary: '读取当前会话，逐条判断哪些工具输出已过期、能省多少 token，产出可核对的报告。只分析，不改写历史。',
  },
  provider: {
    label: 'Jev 压缩后端（需装配层挂载）',
    tools: ['jev_provider_status'],
    skills: [],
    summary: '把 ctx.compaction 的摘要器换成 Jev 逐条判断。开关本身只控制运行时；真正生效还需要用 --patch overlay 或 preset 挂载 provider 行。',
  },
});

const NAMES = Object.keys(FEATURES);

export const stateDir = () => resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'jev-manager');
export const featuresPath = () => join(stateDir(), 'features.json');
export const reviewLogPath = () => join(stateDir(), 'review.jsonl');
export const mountRecordPath = () => join(stateDir(), 'mount.json');

/**
 * Record how the compaction row actually came up, for the one question no log plumbing
 * answers on desktop: which `BasicCompactionEngine` did we bind, and did the realm give
 * us a credentials seam at all? Read back with `node tools/mount-report.mjs`.
 *
 * Best-effort by design — a read-only or full state directory must not turn a successful
 * mount into a failed one.
 *
 * @param {Record<string, unknown>} record
 * @returns {boolean} whether it landed
 */
export function writeMountRecord(record) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const path = mountRecordPath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), ...record }, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Record<string, unknown>|null} */
export function readMountRecord() {
  try {
    return JSON.parse(readFileSync(mountRecordPath(), 'utf8'));
  } catch {
    return null;
  }
}

const empty = Object.fromEntries(NAMES.map((name) => [name, false]));

/**
 * @returns {Record<string, boolean>} missing or unreadable state means "all off",
 *   which is the same thing a first install is.
 */
export function readFeatures() {
  try {
    const stored = JSON.parse(readFileSync(featuresPath(), 'utf8'));
    const out = { ...empty };
    for (const name of NAMES) out[name] = stored?.[name] === true;
    return out;
  } catch {
    return { ...empty };
  }
}

/**
 * Atomic write to a temp file then rename, so a crash mid-write cannot leave a
 * half-written switchboard that reads as "everything off".
 * @param {Record<string, boolean>} next
 */
export function writeFeatures(next) {
  const unknown = Object.keys(next).filter((key) => !NAMES.includes(key));
  if (unknown.length > 0) throw new Error(`未知功能: ${unknown.join(', ')}`);
  const value = { ...readFeatures(), ...next };
  mkdirSync(stateDir(), { recursive: true });
  const temp = `${featuresPath()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, featuresPath());
  return value;
}

/**
 * Delete everything this plugin created under DSH_HOME. The harness's own
 * `dsh plugin remove` does not undo files a plugin wrote, so uninstall has to do it.
 * @returns {string|null} the directory removed, or null when there was nothing
 */
export function clearStateDir() {
  const dir = stateDir();
  if (!existsSync(dir)) return null;
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** @param {string[]} [enabled] @returns {string} one line per feature, for a human or a model */
export function renderFeatures(enabled = Object.keys(readFeatures()).filter((name) => readFeatures()[name])) {
  const on = new Set(enabled);
  const lines = [
    `Jev manager 功能状态  (state: ${featuresPath()})`,
    '',
    ...NAMES.map(
      (name) => `${on.has(name) ? '[on] ' : '[off]'} ${name} — ${FEATURES[name].label}\n       ${FEATURES[name].summary}`,
    ),
    '',
    '开: jev_features { action: "enable", feature: "decision" }   关: action: "disable"',
    '关闭的功能不会注册任何工具或技能，也不会发起网络请求。',
  ];
  return lines.join('\n');
}
