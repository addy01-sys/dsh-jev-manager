/**
 * Provider test: mounts JevCompactionEngine on a real cordis Context with stubbed
 * services, then drives every decision path with a stubbed Jev endpoint and a
 * spied `super.summarize`. It never touches api.typesafe.ai or a real DSH session.
 */

import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot =
  process.env.DSH_RUNTIME_ROOT ??
  resolve(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh');
const require_ = createRequire(resolve(dshRoot, 'package.json'));
const load = (name) => import(pathToFileURL(require_.resolve(name)).href);

/**
 * Fail fast, in one line, instead of ten.
 *
 * The provider binds its base class by walking up from `lib/`, while this file loads the
 * runtime named by DSH_RUNTIME_ROOT. When the checkout's junctions point at a different
 * install, every provider case dies somewhere inside the base class with an error that
 * says nothing about the cause — which is how this was rediscovered three times.
 */
{
  const fromUrl = pathToFileURL(resolve(pluginRoot, 'lib', 'compaction.js')).href;
  let fromLib;
  try {
    fromLib = import.meta.resolve('@deepseek-ai/dsh-compaction-basic', fromUrl);
  } catch {
    fromLib = null;
  }
  const a = fromLib === null ? '(lib 解析不到基类)' : realpathSync(fileURLToPath(fromLib));
  const b = realpathSync(require_.resolve('@deepseek-ai/dsh-compaction-basic'));
  if (a !== b) {
    throw new Error(
      `双副本：lib/ 解析到 ${a}\n  而测试加载的是 ${b}\n` +
        `修法: DSH_RUNTIME_ROOT="${dshRoot}" node tools/link-deps.mjs`,
    );
  }
}

// The provider consults the feature switch on every call, so these tests need their
// own DSH_HOME instead of the operator's real state directory.
const sandbox = resolve(mkdtempSync(join(tmpdir(), 'jev-manager-provider-')));
process.env.DSH_HOME = sandbox;
const features = await import(pathToFileURL(resolve(pluginRoot, 'lib/features.mjs')).href);
const { writeFeatures } = features;

const { Context } = await load('@deepseek-ai/cordis');
const { BasicCompactionEngine } = await load('@deepseek-ai/dsh-compaction-basic');
const { default: Engine } = await import(pathToFileURL(resolve(pluginRoot, 'lib/compaction.js')).href);

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A span with four tool calls; two of them will be judged stale. */
function span() {
  const long = 'x'.repeat(4_000);
  const call = (id) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ path: `/${id}.txt` }) }] });
  const result = (id, content) => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: id, content }] });
  return [
    { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
    call('a'), result('a', [{ type: 'text', text: long }]),
    call('b'), result('b', [{ type: 'text', text: long }]),
    call('c'), result('c', [{ type: 'text', text: long }]),
    call('d'), result('d', [{ type: 'text', text: long }]),
    { role: 'assistant', content: [{ type: 'text', text: 'All four files read.' }] },
  ];
}

const signal = () => new AbortController().signal;
const realFetch = globalThis.fetch;
const realSummarize = BasicCompactionEngine.prototype.summarize;

// Each test replaces the base hook to count DSH fallbacks; never leak that into the next one.
afterEach(() => {
  BasicCompactionEngine.prototype.summarize = realSummarize;
  globalThis.fetch = realFetch;
});

/** @param {{answers: object, key?: string, config?: object}} options */
async function harness({ answers, key = 'fixture-key', config = {}, credentialsService = true, broken = false, envKey = null }) {
  // The provider only acts while its feature switch is on.
  writeFeatures({ provider: true, decision: false, review: false });
  const ctx = new Context();
  if (credentialsService) {
    ctx.provide('credentials', {
      resolve: async (ref) => {
        if (broken) throw new Error('realm cannot serve the credentials seam');
        return ref === 'TYPESAFE_API_KEY' && key ? { value: key } : undefined;
      },
    });
  }
  if (envKey !== null) process.env.TYPESAFE_API_KEY = envKey;
  // `resolveApiKey` now falls back to the launch environment, so the ambient value would
  // decide whether these cases reach the network. Pin it: a developer who exported a real
  // key must not turn "missing key" tests into live requests.
  else if ('TYPESAFE_API_KEY' in process.env) delete process.env.TYPESAFE_API_KEY;
  ctx.provide('llm', { stream: () => { throw new Error('the base summarizer must not run in these tests'); } });
  ctx.provide('tokenMeter', { measure: () => ({ tokens: 0 }) });
  ctx.provide('sessions', { get: () => undefined });

  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, auth: options.headers.authorization, questions: Object.keys(body.questions) });
    return Response.json({
      model: 'jev-test',
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: answers[id] ?? 0.99 }])),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  };

  const mount = await ctx.plugin(Engine, config);
  return {
    engine: ctx.compaction,
    mount,
    ctx,
    requests,
    async dispose() {
      globalThis.fetch = realFetch;
      if (envKey !== null) delete process.env.TYPESAFE_API_KEY;
      await mount.dispose();
      await ctx.fiber.dispose();
    },
  };
}

test('the provider mounts ACTIVE without declaring credentials in inject', async () => {
  const h = await harness({ answers: {} });
  try {
    assert.equal(h.mount.state, 2, 'provider must be ACTIVE');
    assert.ok(h.engine instanceof BasicCompactionEngine, "provider 必须继承自正在运行的那份基类（版本错位就等于没继承）");
    assert.ok(Object.hasOwn(Object.getPrototypeOf(h.engine.constructor.prototype), "summarize"), "summarize 必须由本插件覆盖");
    assert.equal(h.engine.curator.adopt, false, 'must default to shadow');
    assert.equal(h.engine.curator.keepThreshold, 0.4, 'must not ship upstream 0.5');
    assert.ok(!h.engine.constructor.inject.includes('credentials'),
      'credentials 只能 ctx.get，不能写进 inject：隔离 realm 里解析不到会让整行挂载失败');
  } finally {
    await h.dispose();
  }
});

/**
 * The desktop realm is the case that used to be hypothetical: the isolated `compaction`
 * group may not be able to serve `credentials` at all. The row must still mount, and the
 * key must still resolve from the launcher's environment — the same ladder
 * `dsh-llm-deepseek-api-key` walks.
 */
test('the row mounts and finds the key when no credentials service exists', async () => {
  const h = await harness({ answers: {}, credentialsService: false, envKey: 'env-fixture-key' });
  try {
    assert.equal(h.mount.state, 2, 'a realm without credentials must not break mounting');
    assert.equal(await h.engine.resolveApiKey(), 'env-fixture-key', 'must fall back to the launch environment');
  } finally {
    await h.dispose();
  }
});

test('a credentials service that cannot serve the reference still reaches the environment', async () => {
  const h = await harness({
    answers: {},
    key: null,
    envKey: 'env-fixture-key',
    broken: true,
  });
  try {
    assert.equal(await h.engine.resolveApiKey(), 'env-fixture-key', 'a throwing resolve must not lose the key');
  } finally {
    await h.dispose();
  }
});

test('an empty span falls back to DSH without calling Jev', async () => {
  const h = await harness({ answers: {} });
  try {
    BasicCompactionEngine.prototype.summarize = async () => ({ summary: [], provider: 'dsh', model: 'm' });
    const result = await h.engine.summarize({ messages: [] }, { session: { id: 's' } }, signal());
    assert.deepEqual(result, { summary: [], provider: 'dsh', model: 'm' });
    assert.equal(h.engine.stats.last.reason, 'empty_span');
    assert.equal(h.requests.length, 0);
  } finally {
    await h.dispose();
  }
});

test('a missing key falls back and never reaches the network', async () => {
  const h = await harness({ answers: {}, key: '', config: { preserveRecentMessages: 0 } });
  try {
    let called = 0;
    BasicCompactionEngine.prototype.summarize = async () => { called += 1; return { summary: [{ type: 'text', text: 'dsh summary' }], provider: 'dsh', model: 'm' }; };
    const result = await h.engine.summarize({ messages: span() }, { session: { id: 's' } }, signal());
    assert.equal(called, 1, 'DSH must summarize the span');
    assert.equal(h.engine.stats.last.reason, 'no_key');
    assert.equal(h.requests.length, 0, 'no key, no request');
    assert.equal(result.provider, 'dsh');
  } finally {
    await h.dispose();
  }
});

test('shadow mode asks Jev, logs the decisions, and still returns DSH summary', async () => {
  const h = await harness({
    answers: { call_t2: 0.01, result_t2: 0.01, call_t3: 0.01, result_t3: 0.01 },
    config: { preserveRecentMessages: 0 },
  });
  try {
    let called = 0;
    BasicCompactionEngine.prototype.summarize = async () => { called += 1; return { summary: [{ type: 'text', text: 'dsh summary' }], provider: 'dsh', model: 'm' }; };
    const result = await h.engine.summarize({ messages: span() }, { session: { id: 's' } }, signal());
    assert.equal(called, 1, 'shadow must still use DSH summary');
    assert.equal(result.provider, 'dsh');
    assert.equal(h.engine.stats.last.reason, 'shadow_mode');
    assert.equal(h.requests.length, 1, 'one batched request for all calls');
    assert.equal(h.engine.stats.last.callDropped, 2, 'two stale calls identified');
    assert.ok(h.engine.stats.last.reduction_ratio > 0.4, `可度量的节省应被记录，实际 ${h.engine.stats.last.reduction_ratio}`);
    assert.equal(h.engine.stats.adopted, 0);
  } finally {
    await h.dispose();
  }
});

test('adopted: the Jev checkpoint keeps surviving text verbatim and is not marked an LLM-seam call', async () => {
  const h = await harness({
    answers: { call_t2: 0.01, result_t2: 0.01, call_t3: 0.01, result_t3: 0.01 },
    config: { adopt: true, preserveRecentMessages: 0 },
  });
  try {
    let called = 0;
    BasicCompactionEngine.prototype.summarize = async () => { called += 1; return { summary: [], provider: 'dsh', model: 'm' }; };
    const result = await h.engine.summarize({ messages: span() }, { session: { id: 's' } }, signal());
    assert.equal(called, 0, 'adopted run must not call the base summarizer');
    assert.equal(h.engine.stats.adopted, 1);
    assert.equal(result.provider, 'typesafe');
    assert.equal(result.model, 'jev-test');

    const text = result.summary[0].text;
    // Kept content survives byte for byte; nothing is paraphrased. (The system head
    // is not part of the checkpoint — the base summarizer's prose isn't either.)
    assert.ok(text.includes('All four files read.'), 'assistant prose must survive verbatim');
    assert.ok(!text.includes('/b.txt') && !text.includes('/c.txt'), 'stale calls b/c must be gone');
    assert.ok(text.includes('/a.txt') && text.includes('/d.txt'), 'kept calls must be present');
    assert.ok(text.includes('x'.repeat(400)), 'kept results must be verbatim');
    // llmStreamCall is a discriminated field: an outside summarizer must not set it.
    assert.ok(!('llmStreamCall' in result), 'must omit llmStreamCall, not set it false');
    assert.ok(!('usage' in result), 'must not fabricate zero LLM usage');
    assert.equal(result.curator.jevRequests, 1);
    assert.equal(result.curator.inputTokens, 100, 'Jev spend is reported by our own field');
  } finally {
    await h.dispose();
  }
});

test('an image result is neither asked about nor billed for', async () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'starting up' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'shot', name: 'screenshot', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'shot', content: [{ type: 'image', source: { data: 'aaa' } }] }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'r', name: 'read', arguments: JSON.stringify({ path: '/r.txt' }) }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'r', content: [{ type: 'text', text: 'x'.repeat(4_000) }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  // The image call is t1, the readable one t2. Only t2 may be judged.
  const h = await harness({ answers: { call_t2: 0.01, result_t2: 0.01 }, config: { adopt: true, preserveRecentMessages: 0 } });
  try {
    // The base summarizer throws in this harness, so an accidental fallback fails loudly.
    const result = await h.engine.summarize({ messages }, { session: { id: 's' } }, signal());
    const asked = h.requests.flatMap((request) => request.questions);
    assert.deepEqual([...asked].sort(), ['call_t2', 'result_t2'], '受保护的调用一个问题都不该问：问出来的答案只会被丢掉');
    assert.equal(h.engine.stats.last.calls, 2);
    assert.equal(h.engine.stats.last.candidates, 1, '候选数必须等于真正问出去的调用数');
    assert.equal(h.engine.stats.last.protected, 1, '它仍要被数成 protected，而不是悄悄变成 kept');

    const text = result.summary[0].text;
    assert.ok(text.includes('[image]'), '图片结果必须原样留下');
    assert.ok(!text.includes('/r.txt'), '被判过期的调用照样删掉');
  } finally {
    await h.dispose();
  }
});

test('a saving below either threshold falls back instead of rewriting history', async () => {
  const h = await harness({
    answers: { call_t2: 0.01, result_t2: 0.01 },
    config: { adopt: true, preserveRecentMessages: 0, minReductionRatio: 0.9 },
  });
  try {
    let called = 0;
    BasicCompactionEngine.prototype.summarize = async () => { called += 1; return { summary: [], provider: 'dsh', model: 'm' }; };
    await h.engine.summarize({ messages: span() }, { session: { id: 's' } }, signal());
    assert.equal(called, 1);
    assert.equal(h.engine.stats.last.reason, 'low_reduction');
    assert.equal(h.engine.stats.adopted, 0);
  } finally {
    await h.dispose();
  }
});

test('a switched-off provider is a pure passthrough and issues no request', async () => {
  const h = await harness({ answers: {} });
  try {
    let called = 0;
    BasicCompactionEngine.prototype.summarize = async () => { called += 1; return { summary: [], provider: 'dsh', model: 'm' }; };
    // Turn it off without restarting: the switch is read on every call.
    writeFeatures({ provider: false });
    await h.engine.summarize({ messages: span() }, { session: { id: 's' } }, signal());
    assert.equal(called, 1);
    assert.equal(h.engine.stats.last.reason, 'feature_off');
    assert.equal(h.requests.length, 0);
  } finally {
    await h.dispose();
  }
});

test('a malformed Jev answer falls back rather than inventing a decision', async () => {
  writeFeatures({ provider: true, decision: false, review: false });
  const ctx = new Context();
  ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-key' }) });
  ctx.provide('llm', { stream: () => { throw new Error('unused'); } });
  ctx.provide('tokenMeter', { measure: () => ({}) });
  ctx.provide('sessions', { get: () => undefined });
  const original = BasicCompactionEngine.prototype.summarize;
  let called = 0;
  BasicCompactionEngine.prototype.summarize = async () => { called += 1; return { summary: [], provider: 'dsh', model: 'm' }; };
  globalThis.fetch = async () => Response.json({ model: 'jev-test', answers: { call_t1: { type: 'noul', noul: 7 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  const mount = await ctx.plugin(Engine, { adopt: true, preserveRecentMessages: 0 });
  try {
    await ctx.compaction.summarize({ messages: span() }, { session: { id: 's' } }, signal());
    assert.equal(called, 1, 'must hand the span to DSH');
    assert.equal(ctx.compaction.stats.last.reason, 'jev_error');
  } finally {
    BasicCompactionEngine.prototype.summarize = original;
    globalThis.fetch = realFetch;
    await mount.dispose();
    await ctx.fiber.dispose();
  }
});
