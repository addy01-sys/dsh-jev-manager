/**
 * Context review: read the current session's surface, ask Jev which tool calls are
 * already stale, and report what could be reclaimed — without touching history.
 *
 * This is the read-only counterpart of the compaction provider. It exists because
 * the provider can only run when it is mounted as `ctx.compaction` (a composition
 * concern), while the same decisions are useful on demand: "before you compact, tell
 * me what you would drop and how much it saves". Nothing here writes the session
 * log, replaces a surface span, or calls the summarizer.
 *
 * Decisions are appended to this plugin's own JSONL so a user can compare several
 * passes; the file lives under `~/.dsh/jev-manager/` and uninstall deletes it.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fromDsh, pairingRisks, renderCompacted } from './adapter.js';
import { loadFromAnchors } from './harness.mjs';
import { applyDecisions, compact } from './vendor/compact.js';
import { collectToolCalls, estimateTokens } from './vendor/state.js';
import { reviewLogPath } from './features.mjs';

export const REVIEW_LOG_VERSION = 1;

/**
 * Project the session surface onto LLM messages.
 *
 * `session.deriveEventMessage(event)` is the canonical projection — the same frozen message
 * used by delivery, durable history, model requests, and the provider's own
 * `buildSummarizationInput` — and it applies the session's registered message projections
 * (image offload and friends). The module-level export of the same name is the fallback for
 * a session object without that method; it projects original event content, because its
 * `projectedMessages` argument comes from a surface fold this module does not run.
 *
 * `@deepseek-ai/dsh-session` must be resolved from the harness the CURRENT process runs
 * (see `lib/harness.mjs`), not by walking up from this file: on a desktop install the
 * walk-up reaches another runtime's copy or nothing at all. If no projection is available,
 * fall back to the message nested in the event payload and keep working with the same shape.
 * @param {object} session
 * @param {object|null} [ctx]
 * @returns {Promise<{messages: object[], source: string}>}
 */
export async function surfaceMessages(session, ctx = null) {
  const nodes = session?.surface?.nodes ?? [];
  // The instance method applies the session's registered message projections — the very
  // projection the model request and the provider's own `buildSummarizationInput` see. The
  // module-level function needs the surface fold's `projectedMessages` map passed in, so
  // calling it bare reads original event content instead.
  const live = typeof session?.deriveEventMessage === 'function' ? session.deriveEventMessage.bind(session) : null;
  let derive = null;
  if (live === null) {
    try {
      const hit = await loadFromAnchors(ctx, '@deepseek-ai/dsh-session', (mod) => mod?.deriveEventMessage);
      derive = hit?.value ?? null;
    } catch {
      derive = null;
    }
  }
  const project = live ?? derive;
  const source = live !== null ? 'session.deriveEventMessage' : derive === null ? 'event-payload' : 'deriveEventMessage';
  const messages = [];
  for (const seq of nodes) {
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    let message = null;
    // The canonical projection first; its result is the same frozen message the model
    // request is built from. A projection that throws or yields an unusable shape must
    // not sink the whole review, so fall through to the payload shape.
    if (project !== null) {
      try {
        message = project(event);
      } catch {
        message = null;
      }
      if (!isMessage(message)) message = null;
    }
    if (message === null) {
      const nested = event?.data?.message ?? event?.data;
      message = isMessage(nested) ? nested : null;
    }
    if (message !== null) messages.push(message);
  }
  return { messages, source };
}

/** The shape `fromDsh` needs; anything else would surface as a bogus pairing risk. */
function isMessage(value) {
  return typeof value?.role === 'string' && Array.isArray(value?.content);
}

/** Replace the key wherever it appears in a string, so logs and reports leak nothing. */
export function redact(text, key) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (typeof key !== 'string' || key.length < 8) return text;
  return text.split(key).join('[redacted]');
}

/**
 * @param {{jev: {evaluate: Function}, apiKey: () => Promise<string>, config: object}} deps
 * @param {object} session
 * @returns {Promise<object>} a row of the durable report
 */
export async function reviewSession(deps, session) {
  const started = Date.now();
  const { config } = deps;
  const at = new Date().toISOString();
  const key = (await deps.apiKey()) ?? '';

  const projected = await surfaceMessages(session, deps?.ctx ?? null);
  const row = {
    v: REVIEW_LOG_VERSION,
    at,
    session_id: typeof session?.id === 'string' ? session.id : null,
    projection: projected.source,
    keep_threshold: config.keepThreshold,
    preserve_recent: config.preserveRecentMessages,
    jev_model: config.jevModel,
    adopted: false,
  };

  const refuse = (reason, detail) => {
    row.fallback = reason;
    row.fallback_detail = detail ?? null;
    row.ms = Date.now() - started;
    return row;
  };

  if (key.length === 0) return refuse('no_key', '在 DSH 凭据中配置 TYPESAFE_API_KEY');
  if (projected.messages.length === 0) return refuse('empty_surface');

  const converted = fromDsh(projected.messages);
  if (converted.messages.length === 0) return refuse('no_projectable_messages');
  const risks = [...converted.risks, ...pairingRisks(converted.messages)];
  if (risks.length > 0) return refuse('pairing_risk', risks[0]);

  const calls = collectToolCalls(converted.messages, config.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned && !converted.protectedCallIds.has(call.tool_use_id));
  row.messages = converted.messages.length;
  row.calls = calls.length;
  row.pinned = calls.filter((call) => call.pinned).length;
  row.protected_results = converted.protectedCallIds.size;
  row.candidates = candidates.length;
  if (candidates.length === 0) return refuse('no_candidates', `${calls.length} 个配对调用全部被 pin 或受保护`);

  const jev = { requests: 0, latency_ms: 0, model: null, input_tokens: 0, output_tokens: 0 };
  const asker = {
    ask: async (state, questions) => {
      const answered = await deps.jev.evaluate({ state, questions });
      jev.requests += 1;
      jev.latency_ms += answered.latencyMs ?? 0;
      jev.input_tokens += answered.usage.input_tokens;
      jev.output_tokens += answered.usage.output_tokens;
      if (answered.model) jev.model = answered.model;
      return { answers: answered.answers };
    },
  };

  const result = await compact(converted.messages, asker, {
    preserveRecentMessages: config.preserveRecentMessages,
    keepThreshold: config.keepThreshold,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    truncateHeadChars: config.truncateHeadChars,
    // A result holding an image or a file cannot be reproduced by re-running the tool,
    // so those calls are protected: Jev is never asked about them, and they always decide
    // `keep`. Passing them in also keeps this count equal to the questions actually sent.
    protectedCallIds: converted.protectedCallIds,
  });

  const decisions = result.decisions;
  const kept = applyDecisions(converted.messages, decisions, calls, config.truncateHeadChars);
  const tokensBefore = estimateTokens(renderCompacted(converted.messages));
  const tokensAfter = estimateTokens(renderCompacted(kept));

  row.jev = jev;
  row.state_tokens = result.stats.stateTokens;
  row.state_stage = result.stats.stateStage;
  row.requests = result.stats.requests;
  row.decisions = decisions.map((decision) => ({
    id: decision.id,
    tool: decision.tool,
    keep_call: decision.keepCall,
    keep_result: decision.keepResult,
    action: decision.action,
    reason: decision.reason,
  }));
  row.kept = decisions.filter((d) => d.reason === 'kept').length;
  row.drop_result = decisions.filter((d) => d.reason === 'result_dropped').length;
  row.drop_call = decisions.filter((d) => d.reason === 'call_dropped').length;
  row.protected = decisions.filter((d) => d.reason === 'protected').length;
  row.tokens_before = tokensBefore;
  row.tokens_after = tokensAfter;
  row.tokens_reclaimable = tokensBefore - tokensAfter;
  row.reduction_ratio = tokensBefore === 0 ? 0 : Number(((tokensBefore - tokensAfter) / tokensBefore).toFixed(4));
  row.would_pass_gates =
    row.reduction_ratio >= config.minReductionRatio && row.tokens_reclaimable >= config.minTokensSaved;
  row.gate_ratio = config.minReductionRatio;
  row.gate_tokens = config.minTokensSaved;
  row.ms = Date.now() - started;
  return row;
}

/** Append one review row to the plugin's own log. Best-effort: never fail a review over logging. */
export function appendReview(row, key) {
  try {
    const path = reviewLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(redactRows(row, key))}\n`, 'utf8');
    return path;
  } catch {
    /* logging is best-effort */
    return null;
  }
}

/**
 * Redact every string in the row, not just one field: a review row carries tool names
 * and derived notes that can echo request content, and the key must never reach disk.
 */
function redactRows(value, key) {
  if (typeof value === 'string') return redact(value, key);
  if (Array.isArray(value)) return value.map((item) => redactRows(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, key), redactRows(v, key)]));
  }
  return value;
}

/** @returns {object[]} most recent rows first; a corrupt line is skipped, not fatal */
export function readReviewLog(limit = 20) {
  let body = '';
  try {
    body = readFileSync(reviewLogPath(), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a half-written line must not hide every earlier row */
    }
  }
  return rows.reverse().slice(0, Math.max(1, Math.min(limit, 200)));
}

/** Delete the plugin's own state. Used by uninstall so removing the plugin leaves nothing. */
export function clearReviewLog() {
  try {
    rmSync(reviewLogPath(), { force: true });
  } catch {
    /* nothing to clean */
  }
}

/** @param {object} row @returns {string} the text a model or person reads */
export function renderReview(row) {
  if (row.fallback !== undefined && row.fallback !== null) {
    return [
      'Jev 上下文整理分析：未产出判断',
    '',
      `原因: ${row.fallback}${row.fallback_detail ? ` — ${row.fallback_detail}` : ''}`,
      `消息 ${row.messages ?? 0} · 工具调用 ${row.calls ?? 0} · 候选 ${row.candidates ?? 0}`,
    ].join('\n');
  }
  const lines = [
    'Jev 上下文整理分析（只读，未改写历史）',
    '',
    `会话 ${row.session_id ?? '未知'} · 投影 ${row.projection} · 阈值 ${row.keep_threshold} · ${row.ms}ms`,
    `消息 ${row.messages} · 配对调用 ${row.calls}（pin ${row.pinned}，受保护结果 ${row.protected_results}）· 候选 ${row.candidates}`,
    `Jev: ${row.jev.model ?? row.jev_model} · ${row.requests} 次请求 · ${row.jev.latency_ms}ms · in ${row.jev.input_tokens} / out ${row.jev.output_tokens} tokens`,
    '',
    `保留 ${row.kept} · 只删输出 ${row.drop_result} · 连调用一起删 ${row.drop_call} · 因受保护改判保留 ${row.protected}`,
    `token ${row.tokens_before} → ${row.tokens_after}，可回收 ${row.tokens_reclaimable}（${(row.reduction_ratio * 100).toFixed(1)}%）`,
    `是否达到压缩门槛: ${row.would_pass_gates ? '是' : '否'}（需 ≥ ${(row.gate_ratio * 100).toFixed(0)}% 且 ≥ ${row.gate_tokens} token）`,
    '',
  ];
  const notable = row.decisions.filter((d) => d.action !== 'keep').slice(0, 12);
  if (notable.length > 0) {
    lines.push('将被处理的调用：');
    for (const decision of notable) {
      lines.push(
        `  ${decision.id} ${decision.tool}  留调用 ${decision.keep_call.toFixed(2)} / 留输出 ${decision.keep_result.toFixed(2)}  → ${decision.action}`,
      );
    }
  } else {
    lines.push('没有调用被判定为过期。');
  }
  lines.push('', '要真的压缩：按 /compact（仍走 DSH 自己的摘要），或把 provider 行挂进会话。');
  return lines.join('\n');
}
