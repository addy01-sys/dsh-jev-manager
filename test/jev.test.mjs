import assert from 'node:assert/strict';
import { requestBody, createJev, MODEL, MAX_QUESTIONS } from '../lib/jev.mjs';

const ok = { state: 't', questions: { a: { type: 'noul', instructions: 'Yes?' } } };
assert.equal(JSON.parse(requestBody(ok)).model, MODEL);
assert.equal(MAX_QUESTIONS, 64);

// 拒绝：未知顶层键 / 空 state / 0 题 / 非法 type / 循环引用 / 超限
const bad = [
  null, {}, { ...ok, extra: 1 }, { ...ok, state: '' }, { ...ok, questions: {} },
  { ...ok, questions: { x: { type: 'unknown', instructions: 'x' } } },
  { ...ok, questions: { x: { type: 'choice', instructions: 'x', criteria: { a: 'x' } } } },
  { ...ok, questions: { x: { type: 'score', instructions: 'x', criteria: ['x'] } } },
  { ...ok, state: { bad: Infinity } },
];
for (const value of bad) assert.throws(() => requestBody(value), /Jev|接受|必须|需要|超过/, `应被拒绝: ${JSON.stringify(value)}`);
const cyc = {}; cyc.self = cyc;
assert.throws(() => requestBody({ ...ok, state: cyc }), /JSON/);
console.log('✓ requestBody 校验：' + bad.length + ' 个非法输入全部拦下，合法输入通过');

// 不联网：key 缺失时报 no_key，不发起 fetch
let calls = 0;
let key;
const jev = createJev({ getApiKey: () => key, fetcher: async () => { calls++; return Response.json(RESP); } });
assert.equal((await jev.status()).configured, false);
assert.equal((await jev.status()).remoteVerified, false);
await assert.rejects(jev.evaluate(ok), /TYPESAFE_API_KEY/, '缺 key 应报错');
assert.equal(calls, 0, '缺 key 时不应联网');

const RESP = { model: 'jev-test', answers: { a: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } };
key = 'first';
let got = await jev.evaluate(ok);
assert.equal(got.answers.a.noul, 0.9);
assert.equal(got.provider, 'TypeSafe AI');
assert.ok(got.latencyMs >= 0 && typeof got.latencyMs === 'number', 'latencyMs 应是真实耗时');

// 热轮换：换 key 不重启，且请求头跟着变
const seen = [];
const jev2 = createJev({ getApiKey: () => key, fetcher: async (_u, o) => { seen.push(o.headers.authorization); assert.equal(o.redirect, 'error'); return Response.json(RESP); } });
key = 'second';
await jev2.evaluate(ok);
key = 'third';
await jev2.evaluate(ok);
assert.deepEqual(seen, ['Bearer second', 'Bearer third'], 'key 应每次重取');
console.log('✓ key 每次调用重取（可热轮换），redirect:error 已设');

// 上游畸形：概率越界 / 不归一 / 选项不在候选里 → 拒绝而非编造
const clone = () => structuredClone(RESP);
for (const mutate of [r => r.answers.a.noul = 2, r => delete r.answers.a, r => r.usage.input_tokens = -1, r => r.answers.a.type = 'choice']) {
  const body = clone(); mutate(body);
  await assert.rejects(createJev({ getApiKey: () => 'k', fetcher: async () => Response.json(body) }).evaluate(ok), /无效|不完整/);
}
const choiceOk = { state: 't', questions: { c: { type: 'choice', instructions: 'Which?', criteria: { x: 'X', y: 'Y' } } } };
for (const mutate of [
  r => r.answers.c.choice = 'nonexistent',
  r => r.answers.c.probabilities = { x: 0.9, y: 0.9 },        // 和不为 1
  r => r.answers.c.confidence = 3,                             // 越界
  r => { delete r.answers.c.probabilities.y; r.answers.c.probabilities.z = 0.1; },
]) {
  const body = clone(); body.answers.c = { type: 'choice', choice: 'x', confidence: 0.9, probabilities: { x: 0.5, y: 0.5 } };
  mutate(body);
  await assert.rejects(createJev({ getApiKey: () => 'k', fetcher: async () => Response.json(body) }).evaluate(choiceOk), /无效|不完整/);
}
console.log('✓ 畸形上游回答被拒绝（概率越界/不归一/候选不存在/缺 legend），未编造值');

// 错误脱敏：上游正文或异常里含 key 不外泄
const leaked = 'sk-secret-abcdef123456';
for (const responder of [
  async () => new Response(leaked, { status: 500 }),
  async () => { throw new Error(`connect to ${leaked} failed`); },
]) {
  const api = createJev({ getApiKey: () => leaked, fetcher: responder });
  await assert.rejects(api.evaluate(ok), e => !e.message.includes(leaked), '错误消息不得含密钥');
}
console.log('✓ 密钥不出现在任何错误消息里');

// 重试有界：529 两次后放弃；retry-after 超时限直接失败
let n = 0;
const busy = createJev({ getApiKey: () => 'k', fetcher: async () => (++n < 3 ? new Response('', { status: 529 }) : Response.json(RESP)) });
assert.equal((await busy.evaluate(ok)).answers.a.noul, 0.9);
assert.equal(n, 3, '应重试且上限为 3 次尝试');
await assert.rejects(
  createJev({ getApiKey: () => 'k', fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) }).evaluate(ok),
  /繁忙/);
console.log('✓ 仅 429/529 重试，最多 3 次尝试；retry-after 过大会立即放弃');

// 三路中止
const slow = (api) => api.evaluate(ok);
const api3 = createJev({ getApiKey: () => 'k', timeoutMs: 30, fetcher: async (_u, o) => { await new Promise((r, j) => { o.signal.addEventListener('abort', j); setTimeout(r, 5000); }); return Response.json(RESP); } });
await assert.rejects(slow(api3), /超时/);
const c = new AbortController();
const api4 = createJev({ getApiKey: () => 'k', timeoutMs: 5000, fetcher: async (_u, o) => { await new Promise((r, j) => { o.signal.addEventListener('abort', j); setTimeout(r, 5000); }); return Response.json(RESP); } });
const p = api4.evaluate(ok, { signal: c.signal }); c.abort();
await assert.rejects(p, /取消/);
console.log('✓ 超时与调用方取消都能中断在途请求');

// check-connection 确实发一次真请求
let cc = 0;
const api5 = createJev({ getApiKey: () => 'k', fetcher: async (_u, o) => { cc++; assert.equal(JSON.parse(o.body).questions.connected.type, 'noul'); return Response.json({ model: 'jev-x', answers: { connected: { type: 'noul', noul: 0.98 } }, usage: { input_tokens: 10, output_tokens: 2 } }); } });
assert.equal((await api5.checkConnection()).connected, true);
assert.equal(cc, 1);
console.log('✓ check_connection 发一次真实 noul 请求（会计费）');
api3.dispose(); api4.dispose();
console.log('\n全部通过 ✅');
