/**
 * Review pipeline test: the read-only compaction analysis behind `jev_context_review`.
 *
 * Drives it with a fake session shaped like DSH's surface (nodes + eventAt) and a fake
 * Jev asker, so nothing reaches the network or a real session log. Covers the projection
 * fallback, every refusal path, the protected-result rule, the report text, and the
 * JSONL round trip including key redaction.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = resolve(mkdtempSync(join(tmpdir(), 'jev-manager-review-')));
process.env.DSH_HOME = sandbox;

const review = await import(pathToFileURL(resolve(pluginRoot, 'lib/review.mjs')).href);
const { reviewLogPath } = await import(pathToFileURL(resolve(pluginRoot, 'lib/features.mjs')).href);
const { reviewSession, renderReview, readReviewLog, appendReview, surfaceMessages, redact } = review;

const LONG = 'x'.repeat(4_000);
const CONFIG = {
  keepThreshold: 0.4,
  preserveRecentMessages: 0,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  minReductionRatio: 0.15,
  minTokensSaved: 500,
  jevModel: 'jev-latest',
};

const call = (id) => ({ type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ path: `/${id}.txt` }) });
const result = (id, text = LONG) => ({ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }] });

/** A session whose surface yields these messages, in surface order. */
function fakeSession(blocks, { id = 'sess-1', throwOnDerive = false } = {}) {
  const events = blocks.map((message, index) => ({
    seq: index + 1,
    type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
    data: { message },
  }));
  return {
    id,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    throwOnDerive,
  };
}

const SPAN = [
  { role: 'assistant', content: [call('a')] },
  { role: 'user', content: [result('a')] },
  { role: 'assistant', content: [call('b')] },
  { role: 'user', content: [result('b')] },
  { role: 'assistant', content: [call('c')] },
  { role: 'user', content: [result('c')] },
  { role: 'assistant', content: [{ type: 'text', text: 'All three read.' }] },
];

/** @param {(id:string)=>number} probability */
function fakeJev(probability = () => 0.99) {
  const seen = [];
  return {
    seen,
    evaluate: async (input) => ({
      model: 'jev-test',
      latencyMs: 7,
      usage: { input_tokens: 120, output_tokens: 9 },
      answers: Object.fromEntries(
        Object.keys(input.questions).map((id) => {
          seen.push(id);
          return [id, { type: 'noul', noul: probability(id) }];
        }),
      ),
    }),
  };
}

/** Questions are keyed by the core's sequential call id (`t1`, `t2`…), not the tool_use_id. */
const stale = (tIds) => (id) => (tIds.includes(id.split('_')[1]) ? 0.01 : 0.99);

let key = 'sk-secret-abcdef123456';
const deps = (jev) => ({ jev, config: CONFIG, apiKey: async () => key });

before(() => {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

test('the surface projection falls back to the event payload and reports which it used', async () => {
  const projected = await surfaceMessages(fakeSession(SPAN));
  assert.ok(projected.messages.length >= 5, `应投影出消息，实际 ${projected.messages.length}`);
  assert.ok(['deriveEventMessage', 'event-payload'].includes(projected.source));
  const empty = await surfaceMessages({ id: 'x', surface: { nodes: [] }, eventAt: () => undefined });
  assert.deepEqual(empty.messages, []);
});

test('a review reports the stale calls, the reclaimable tokens, and touches nothing', async () => {
  const jev = fakeJev(stale(['t2']));
  const row = await reviewSession(deps(jev), fakeSession(SPAN));
  assert.equal(row.fallback, undefined, `不应回退：${row.fallback ?? row.fallback_detail}`);
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.calls, 3);
  assert.equal(row.candidates, 2, 't1 是区间首条，永远不参与判断');
  assert.equal(row.drop_call, 1, 'b 判定为过期');
  assert.equal(row.kept, 1);
  assert.ok(row.tokens_reclaimable > 500, `应能估出可回收 token，实际 ${row.tokens_reclaimable}`);
  assert.ok(row.reduction_ratio > 0.1 && row.reduction_ratio < 1);
  assert.deepEqual(row.jev, { requests: 1, latency_ms: 7, model: 'jev-test', input_tokens: 120, output_tokens: 9 });
  assert.equal(row.would_pass_gates, true);
  assert.ok(jev.seen.some((id) => id.startsWith('call_t')), '问题按调用编号成对发出');
  assert.ok(!('kept' in row) || typeof row.kept === 'number');
});

test('thresholds decide whether it is even worth compacting', async () => {
  const jev = fakeJev(stale(['t2']));
  const row = await reviewSession(deps(jev), fakeSession(SPAN));
  const tight = { ...CONFIG, minReductionRatio: 0.99 };
  const strict = await reviewSession({ jev, config: tight, apiKey: async () => key }, fakeSession(SPAN));
  assert.equal(strict.would_pass_gates, false, '门槛提高后应判为不值得动手');
  assert.ok(row.would_pass_gates !== strict.would_pass_gates);
});

test('a result that cannot be reproduced (image) is never deleted, even at 0.01', async () => {
  // The span's first message is always pinned, so the protected call has to sit in the
  // middle or the protection path is never reached.
  const blocks = [
    { role: 'assistant', content: [{ type: 'text', text: 'starting up' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'shot', name: 'screenshot', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'shot', content: [{ type: 'image', source: { data: 'aaa' } }] }] },
    { role: 'assistant', content: [call('b')] },
    { role: 'user', content: [result('b')] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const jev = fakeJev(() => 0.01);
  const row = await reviewSession(deps(jev), fakeSession(blocks));
  assert.equal(row.fallback, undefined, '仍有可删候选时应照常分析');
  assert.equal(row.protected_results, 1, '图片结果要被数出来');
  assert.equal(row.candidates, 1, '受保护的那条不进候选');
  assert.equal(row.protected, 1, '它即便被判过期也会改判保留');
  assert.equal(row.drop_call, 1);
  // The screenshot call is t1: it must cost no questions at all, or the reported
  // candidate count would disagree with what was actually sent.
  assert.deepEqual([...jev.seen].sort(), ['call_t2', 'result_t2'], '受保护的调用不得提问');
  const screenshot = row.decisions.find((d) => d.tool === 'screenshot');
  assert.equal(screenshot.action, 'keep', '截图那条不得被删');
  assert.equal(screenshot.reason, 'protected');
});

test('the session’s own projection wins over the module-level fallback', async () => {
  const projectedSeqs = [];
  const session = fakeSession(SPAN);
  // Stands in for the live instance method: it applies the session's registered message
  // projections, which the bare module-level function cannot (it needs the fold's map).
  session.deriveEventMessage = (event) => {
    projectedSeqs.push(event.seq);
    const message = event.data?.message ?? event.data;
    if (event.type !== 'user/message' || !Array.isArray(message?.content)) return message;
    return {
      ...message,
      content: message.content.map((block) =>
        block?.type === 'tool-result' ? { ...block, content: [{ type: 'text', text: 'projected body' }] } : block,
      ),
    };
  };

  const projected = await surfaceMessages(session);
  assert.equal(projected.source, 'session.deriveEventMessage');
  assert.equal(projectedSeqs.length, SPAN.length, '每一条 surface 节点都要走实例方法');
  assert.ok(
    projected.messages.every((message) => !JSON.stringify(message).includes(LONG)),
    '拿到的必须是投影后的内容，而不是事件里的原始正文',
  );
  assert.ok(JSON.stringify(projected.messages).includes('projected body'));
});

test('refusals name a reason and never call Jev', async () => {
  const jev = fakeJev();
  const noKey = await reviewSession({ jev, config: CONFIG, apiKey: async () => '' }, fakeSession(SPAN));
  assert.equal(noKey.fallback, 'no_key');
  const empty = await reviewSession(deps(jev), fakeSession([]));
  assert.equal(empty.fallback, 'empty_surface');
  assert.equal(jev.seen.length, 0, '拒绝路径不应消耗判断');
});

test('unpairable history is refused rather than guessed at', async () => {
  const orphan = [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: LONG }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ];
  const row = await reviewSession(deps(fakeJev()), fakeSession(orphan));
  assert.equal(row.fallback, 'pairing_risk');
});

test('the report text is readable and states it changed nothing', async () => {
  const row = await reviewSession(deps(fakeJev(stale(['t2']))), fakeSession(SPAN));
  const text = renderReview(row);
  assert.match(text, /只读，未改写历史/);
  assert.match(text, /Jev: 1 次请求|jev-test/);
  assert.match(text, /可回收/);
  assert.match(text, /将被处理的调用/);
  const refused = renderReview({ fallback: 'no_key', fallback_detail: '在 DSH 凭据中配置 TYPESAFE_API_KEY' });
  assert.match(refused, /未产出判断/);
  assert.match(refused, /no_key/);
});

test('decisions land in the plugin-owned JSONL with the key redacted, and read back newest first', async () => {
  const row = await reviewSession(deps(fakeJev(stale(['t2']))), fakeSession(SPAN));
  row.note = `ran with ${key}`;
  const path = appendReview(row, key);
  assert.equal(path, reviewLogPath());
  const body = readFileSync(path, 'utf8');
  assert.ok(!body.includes(key), '日志里不得出现密钥');
  assert.match(body, /\[redacted\]/);

  // A second pass, then a corrupt line that must not hide the good rows.
  appendReview({ ...row, at: 'NEWER', tokens_reclaimable: 999 }, key);
  const written = readFileSync(path, 'utf8');
  assert.ok(!written.includes(key), '日志里不得出现密钥');
  writeFileSync(path, `${written}not-json\n`, 'utf8');
  const rows = readReviewLog(10);
  assert.equal(rows.length, 2, '坏行跳过，好行保留');
  assert.equal(rows[0].at, 'NEWER', '最近优先');
  assert.ok(readReviewLog(1).length === 1, 'limit 生效');
});

test('redact is a no-op for short or absent keys', () => {
  assert.equal(redact('text', ''), 'text');
  assert.equal(redact('text', 'short'), 'text');
  assert.equal(redact('k=abcdefghijklmnop', 'abcdefghijklmnop'), 'k=[redacted]');
});
