/**
 * Host-plane entry: the only part of this plugin that is always mounted.
 *
 * Exactly one tool is registered unconditionally — `jev_features`. Every other
 * capability lives behind a switch, and switching it off really unregisters it:
 * no tool schema the model can see, no skill in the catalogue, no network path.
 * That is what makes "关闭后恢复原样" observable rather than aspirational, and it
 * works without `patchReload`, which the desktop profile does not enable.
 *
 * Switch state is NOT stored in the plugin row's config or in cordis.patch.yml —
 * both are the user's configuration files, and turning a feature off would leave a
 * line behind. It lives in this plugin's own directory; see `lib/features.mjs`.
 *
 * NO HARNESS IMPORTS ON THIS PLANE. The two plugins actually running in this
 * machine's desktop profile (`dsh-plugin`, `dsh-whale-widget`) declare the harness
 * only as a peer and import nothing from it: every profile shares
 * `$DSH_HOME/profiles/node_modules` as a module ancestor, and that copy can be a
 * different harness version from the one the running app executes. This plane loads on
 * every boot, so it must not depend on resolution succeeding. The compaction provider,
 * which by definition subclasses the host's engine, keeps its harness imports.
 *
 * The compaction provider (`lib/compaction.js`) is a separate row that a
 * composition layer mounts; it is not registered from here.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTuning } from './config.mjs';
import { FEATURES, featuresPath, readFeatures, renderFeatures, writeFeatures } from './features.mjs';
import { createJev, MAX_QUESTIONS, MODEL } from './jev.mjs';
import { appendReview, readReviewLog, renderReview, reviewSession } from './review.mjs';

export const name = 'dsh-jev-manager';
export const inject = ['tools', 'credentials', 'skills'];

const here = dirname(fileURLToPath(import.meta.url));

const EVALUATE_DESCRIPTION =
  `对同一个 state 批量评估独立问题。questions 为问题 ID 到问题对象的映射：type 为 choice、score 或 noul。` +
  `choice.criteria 是 2–255 个候选 ID 到描述（字符串、对象、数组或 null）的映射；score.criteria 是 2–10 个从低到高的等级描述（从 0 索引）；` +
  `noul.criteria 可省略，或提供 true/false 两侧的描述。返回选中项、评分、概率分布、置信度与 token 用量，不执行任何推荐动作。` +
  `最多 ${MAX_QUESTIONS} 个问题、请求 256 KiB。` +
  `候选必须由你从当前宿主真实发现且已获准使用的能力构成——Jev 不会发现工具、装插件、授予权限或调用子 Agent。` +
  `noul 接近 0.5 表示不确定，不是「中等水平」。`;

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const noArgs = { type: 'object', properties: {}, additionalProperties: false };

export async function apply(ctx, config) {
  const tuning = resolveTuning(config);
  const jev = createJev({
    // Resolved per call, so a rotated key takes effect without a restart.
    getApiKey: async () => (await ctx.credentials.resolve('TYPESAFE_API_KEY'))?.value,
    timeoutMs: Math.max(tuning.jevTimeoutMs, 20_000),
  });
  ctx.effect(() => jev.dispose);

  /** feature -> its disposers, so disabling really removes the registrations. */
  const mounted = new Map();

  const skills = {
    'jev-decision': {
      file: resolve(here, '..', 'skills', 'jev-decision', 'SKILL.md'),
      description:
        'Use Jev to choose among the tools, skills, or agents that are actually available and permitted right now, or to score an output against an explicit rubric. Use when the user asks for Jev or when a bounded decision would help; not for open-ended writing or research.',
    },
    'jev-context-review': {
      file: resolve(here, '..', 'skills', 'jev-context-review', 'SKILL.md'),
      description:
        'Use jev_context_review before a session gets long, to see which tool outputs Jev considers stale and how many tokens compaction would reclaim. Read-only: it never rewrites history. Use when the user asks about context size, compaction, or what can be safely dropped.',
    },
  };

  const registerSkill = async (name) => {
    const meta = skills[name];
    const body = await readFile(meta.file, 'utf8');
    return ctx.skills.register({
      name,
      description: meta.description,
      content: body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim(),
      source: 'bundled',
    });
  };

  /** The capability table: what each switch registers, and how to undo it. */
  const builders = {
    decision: () => [
      ctx.tools.register({
        name: 'jev_status',
        description: '检查本地是否已配置 TYPESAFE_API_KEY。只读、不发起网络请求；返回 configured=true 不代表密钥已通过远端验证。',
        parameters: noArgs,
        output: objectOutput,
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        execute: () => jev.status(),
      }),
      ctx.tools.register({
        name: 'jev_check_connection',
        description: '发送一个最小评估请求，验证 API Key 与 Jev 服务可用，会产生少量 TypeSafe 用量。',
        parameters: noArgs,
        output: objectOutput,
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: (_args, exec) => jev.checkConnection({ signal: exec.signal }),
      }),
      ctx.tools.register({
        name: 'jev_evaluate',
        description: EVALUATE_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            state: {
              description: '判断所需的最小任务上下文，不要包含密钥或无关私密资料。',
              oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }, { type: 'array', items: {} }],
            },
            questions: { type: 'object', additionalProperties: true, description: '问题 ID 到 {type, instructions, criteria?} 的映射。' },
          },
          required: ['state', 'questions'],
          additionalProperties: false,
        },
        output: objectOutput,
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: (args, exec) => jev.evaluate(args, { signal: exec.signal }),
      }),
      registerSkill('jev-decision'),
    ],

    review: () => [
      ctx.tools.register({
        name: 'jev_context_review',
        description:
          '读取当前会话，对每个工具调用问 Jev 两个问题（这个调用还需要吗 / 它的完整输出还需要逐字保留吗），返回将被处理的调用与可回收 token 数。' +
          '只读：不改写会话历史、不替换 surface 区间、不产生 compaction 事件。判断记录写入插件自己的 review.jsonl，可用 jev_review_report 复查。',
        parameters: {
          type: 'object',
          properties: {
            include_decisions: { type: 'boolean', description: '是否返回逐条判断表，默认 true。' },
          },
          additionalProperties: false,
        },
        output: textOutput,
        // A long session needs a batched Jev call per group of calls.
        timeoutMs: 120_000,
        isConcurrencySafe: () => true,
        execute: async (_args, exec) => {
          const session = exec?.agent?.session;
          if (session === undefined || session === null) {
            return 'Jev 上下文整理分析：当前工具调用没有携带会话上下文（缺少 exec.agent.session），无法读取 surface。';
          }
          const key = (await ctx.credentials.resolve('TYPESAFE_API_KEY'))?.value ?? '';
          const row = await reviewSession({ jev, config: tuning, apiKey: async () => key, ctx }, session);
          appendReview(row, key);
          const text = renderReview(row);
          return _args?.include_decisions === false
            ? text.split('\n将被处理的调用：')[0].trim()
            : text;
        },
      }),
      ctx.tools.register({
        name: 'jev_review_report',
        description:
          '汇总本插件历史 jev_context_review 的判断记录（最近优先）：每次的候选数、保留/删除计数、可回收 token、Jev 请求与 token 用量、失败回退原因分布。只读本地 JSONL，不联网、不重新判断。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: '读多少条记录，默认 20，最多 200。' },
          },
          additionalProperties: false,
        },
        output: textOutput,
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        execute: (args) => renderReport(readReviewLog(args?.limit ?? 20)),
      }),
      registerSkill('jev-context-review'),
    ],

    // The provider is a composition-layer row; the switch only reports the truth so a
    // user cannot believe enabling it is enough.
    provider: () => [
      ctx.tools.register({
        name: 'jev_provider_status',
        description:
          '报告 Jev 压缩后端是否真的被装配为 ctx.compaction。开关本身只记录意图：后端需要 --patch overlay 或 preset 行挂载才生效，本工具用来确认到底挂上了没有。',
        parameters: noArgs,
        output: objectOutput,
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        execute: () => ({
          requested: readFeatures().provider === true,
          mounted_here: false,
          note: 'ctx.compaction 由装配层决定；本插件的 host 行不注册它。要确认请看 jev_context_review 的结果或 dsh --dump-config。',
        }),
      }),
    ],
  };

  /**
   * A registry's `register()` returns its disposer; `registerSkill` is async because
   * it reads the SKILL.md first. Await every handle here, otherwise a pending skill
   * registration is both invisible to the caller and un-disposable later.
   */
  async function setMount(feature) {
    const handles = [];
    for (const item of builders[feature]()) handles.push(await item);
    mounted.set(feature, handles);
  }

  async function unmount(feature) {
    const handles = mounted.get(feature) ?? [];
    mounted.delete(feature);
    for (const handle of handles) {
      try {
        const dispose = typeof handle === 'function' ? handle : (handle?.dispose ?? handle?.unbind);
        if (typeof dispose === 'function') await dispose.call(handle);
        else await dispose;
      } catch (error) {
        ctx.logger?.warn?.(`dsh-jev-manager: 关闭 ${feature} 时某个注销失败：${error?.message ?? error}`);
      }
    }
  }

  /** Bring the live registrations in line with the stored switches. */
  async function sync() {
    const enabled = readFeatures();
    for (const feature of Object.keys(builders)) {
      const want = enabled[feature] === true;
      const has = mounted.has(feature);
      if (want && !has) await setMount(feature);
      else if (!want && has) await unmount(feature);
    }
    return enabled;
  }

  ctx.tools.register({
    name: 'jev_features',
    description:
      '列出或切换本插件的功能开关。action=list 查看状态；action=enable/disable 配合 feature=decision|review|provider 开合某一功能。' +
      '开关状态存在插件自己的目录（~/.dsh/jev-manager/features.json），不写 DSH 的 profile 配置，因此关闭后你的配置文件不会有残留行。' +
      '关闭的功能会立即注销其工具与技能，不再出现在模型可见的工具表里。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'enable', 'disable'], description: '默认 list。' },
        feature: { type: 'string', enum: Object.keys(FEATURES), description: 'enable/disable 时必填。' },
      },
      additionalProperties: false,
    },
    output: textOutput,
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = args?.action ?? 'list';
      if (action === 'list') {
        const enabled = await sync();
        return renderFeatures(Object.keys(enabled).filter((name) => enabled[name])) + `\n状态文件: ${featuresPath()}`;
      }
      const feature = args?.feature;
      if (!Object.hasOwn(FEATURES, feature)) {
        return `用法: jev_features { action: "${action}", feature: "${Object.keys(FEATURES).join('|')}" }`;
      }
      writeFeatures({ [feature]: action === 'enable' });
      const enabled = await sync();
      const on = Object.keys(enabled).filter((name) => enabled[name]);
      const tools = on.flatMap((name) => FEATURES[name].tools);
      return [
        `${action === 'enable' ? '已开启' : '已关闭'} ${feature} — ${FEATURES[feature].label}`,
        '',
        `当前注册的工具: ${tools.length > 0 ? tools.join(', ') : '（只有 jev_features 与 jev_provider_status 这类控制面）'}`,
        `技能: ${on.flatMap((name) => FEATURES[name].skills).join(', ') || '无'}`,
        '',
        action === 'disable'
          ? '该功能已从模型可见工具表中注销，不会发起任何网络请求。'
          : FEATURES[feature].summary,
        feature === 'provider' && action === 'enable'
          ? '注意：这只记录了意图。ctx.compaction 的后端由装配层决定，需要 --patch overlay 或 preset 行才会真的挂上。'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  const initial = await sync();
  ctx.logger?.info?.(
    `dsh-jev-manager: jev_features registered; ${Object.keys(initial).filter((name) => initial[name]).join(',') || 'no optional feature'} active`,
  );

  // Unloading the plugin removes every registration this module made, including the
  // control tool — DSH owns that reversion; we only guarantee our own file is clean.
  ctx.effect(() => async () => {
    for (const feature of [...mounted.keys()]) await unmount(feature);
  });
}

/** @param {object[]} rows most recent first @returns {string} */
function renderReport(rows) {
  if (rows.length === 0) {
    return 'Jev 上下文整理报告：还没有判断记录。先启用 review 功能并调用 jev_context_review。';
  }
  const judged = rows.filter((row) => !row.fallback);
  const failures = new Map();
  for (const row of rows.filter((item) => item.fallback)) {
    failures.set(row.fallback, (failures.get(row.fallback) ?? 0) + 1);
  }
  const reclaimable = judged.reduce((sum, row) => sum + (row.tokens_reclaimable ?? 0), 0);
  const requests = judged.reduce((sum, row) => sum + (row.jev?.requests ?? 0), 0);
  const inTokens = judged.reduce((sum, row) => sum + (row.jev?.input_tokens ?? 0), 0);
  const outTokens = judged.reduce((sum, row) => sum + (row.jev?.output_tokens ?? 0), 0);
  const lines = [
    `Jev 上下文整理报告  (最近 ${rows.length} 次，${judged.length} 次产出判断)`,
    '',
    `累计可回收 ${reclaimable} token · Jev 请求 ${requests} 次 · in ${inTokens} / out ${outTokens} token`,
    judged.length > 0
      ? `平均每次判定 ${Math.round(judged.reduce((sum, r) => sum + (r.candidates ?? 0), 0) / judged.length)} 个候选，回收 ${Math.round(reclaimable / judged.length)} token`
      : '',
    '',
    '最近记录：',
    ...rows.slice(0, 8).map(
      (row) =>
        `  ${row.at} ${row.fallback ? `回退 ${row.fallback}` : `候选 ${row.candidates} → 删输出 ${row.drop_result} / 删调用 ${row.drop_call} / 保留 ${row.kept}`} · ${row.tokens_reclaimable ?? 0} token · ${(row.ms ?? 0) / 1000}s · 会话 ${row.session_id ?? '?'}`,
    ),
    failures.size > 0
      ? `\n回退原因分布: ${[...failures].map(([reason, count]) => `${reason}×${count}`).join(', ')}`
      : '',
    '',
    '这些只是分析结果，历史未被改写。要真的压缩：按 /compact，或把 provider 行挂进会话。',
  ];
  return lines.filter(Boolean).join('\n');
}
