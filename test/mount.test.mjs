/**
 * Mount test for the host plane: the switches must really add and remove model-facing
 * registrations, and a fresh install must expose nothing but the control tool.
 *
 * Runs against the installed DSH packages (cordis + dsh-tools + dsh-skill +
 * dsh-system-prompt) with `globalThis.fetch` stubbed, so it proves the plugin loads
 * in a real runtime without spending any API usage. DSH_HOME is redirected to a temp
 * directory so the switches cannot touch the user's own state.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(resolve(tmpdir(), 'jev-manager-mount-'));
process.env.DSH_HOME = resolve(sandbox);

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot =
  process.env.DSH_RUNTIME_ROOT ??
  resolve(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh');
const require_ = createRequire(resolve(dshRoot, 'package.json'));
const load = (name) => import(pathToFileURL(require_.resolve(name)).href);

const { Context } = await load('@deepseek-ai/cordis');
const { default: Tools } = await load('@deepseek-ai/dsh-tools');
const { default: Skills } = await load('@deepseek-ai/dsh-skill');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const plugin = await import(pathToFileURL(resolve(pluginRoot, 'lib/host.mjs')).href);
const features = await import(pathToFileURL(resolve(pluginRoot, 'lib/features.mjs')).href);
const { featuresPath, writeFeatures } = features;

const realFetch = globalThis.fetch;
const signal = () => new AbortController().signal;

async function harness(key = 'fixture-key') {
  // Switch state is machine-wide and persists on purpose, so each case starts clean.
  writeFeatures(Object.fromEntries(Object.keys(features.FEATURES).map((name) => [name, false])));
  const ctx = new Context();
  ctx.provide('credentials', {
    resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' && key ? { value: key, source: 'test' } : undefined),
  });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, {});
  await ctx.plugin(Skills, {});

  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, auth: options.headers.authorization, questions: Object.keys(body.questions) });
    return Response.json({
      model: 'jev-test',
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  };

  const mount = await ctx.plugin(plugin, {});
  return {
    ctx,
    mount,
    requests,
    tools: () => ctx.tools.schemas().map((tool) => tool.name).sort(),
    skillNames: async () => (await ctx.skills.list()).map((skill) => skill.name).sort(),
    /** The only way a user can move a switch from inside a session. */
    toggle: async (action, feature) =>
      ctx.tools.get('jev_features').execute({ action, feature }, { signal: signal() }),
    async dispose() {
      globalThis.fetch = realFetch;
      await mount.dispose();
      await ctx.fiber.dispose();
    },
  };
}

/** @returns {string[]} registered tools starting with jev_ but not the control tool */
const optional = (names) => names.filter((name) => name !== 'jev_features');

after(() => {
  globalThis.fetch = realFetch;
  rmSync(resolve(sandbox), { recursive: true, force: true });
});

test('a fresh install exposes only jev_features, and writes nothing to DSH config', async () => {
  const h = await harness();
  try {
    assert.equal(h.mount.state, 2, 'plugin must be ACTIVE');
    assert.deepEqual(h.tools(), ['jev_features']);
    assert.deepEqual(await h.skillNames(), []);
    assert.equal(h.requests.length, 0, 'no network on a cold install');
    // The only file this plugin may create is its own switchboard, all off.
    assert.deepEqual(JSON.parse(readFileSync(featuresPath(), 'utf8')), { decision: false, review: false, provider: false });
    assert.deepEqual(
      readdirSync(resolve(sandbox)).filter((name) => name !== 'jev-manager'),
      [],
      'the plugin must not write anywhere else in DSH_HOME',
    );
  } finally {
    await h.dispose();
  }
});

test('enabling decision registers three tools and the skill', async () => {
  const h = await harness();
  try {
    const report = await h.toggle('enable', 'decision');
    assert.match(report, /已开启 decision/);
    assert.deepEqual(optional(h.tools()), ['jev_check_connection', 'jev_evaluate', 'jev_status']);
    assert.deepEqual(await h.skillNames(), ['jev-decision']);

    const status = await tool(h, 'jev_status').execute({}, { signal: signal() });
    assert.equal(status.model, 'jev-latest');
    assert.equal(status.remoteVerified, false, 'a local check must never claim remote verification');
  } finally {
    await h.dispose();
  }
});

test('disabling unregisters them again, and no state file survives as on', async () => {
  const h = await harness();
  try {
    await h.toggle('enable', 'decision');
    assert.equal(optional(h.tools()).length, 3);
    await h.toggle('disable', 'decision');
    assert.deepEqual(h.tools(), ['jev_features'], 'the model must stop seeing the tools');
    assert.deepEqual(await h.skillNames(), [], 'and stop seeing the skill');

    const stored = JSON.parse(readFileSync(featuresPath(), 'utf8'));
    assert.equal(stored.decision, false, 'the switch file records off');
    const report = await h.toggle('list');
    assert.match(report, /\[off\] decision/);
  } finally {
    await h.dispose();
  }
});

test('enabling review registers read-only tools and the review skill', async () => {
  const h = await harness();
  try {
    await h.toggle('enable', 'review');
    assert.deepEqual(optional(h.tools()), ['jev_context_review', 'jev_review_report']);
    assert.deepEqual(await h.skillNames(), ['jev-context-review']);

    // No session attached must produce a stated limitation, not a fabricated report.
    const text = await tool(h, 'jev_context_review').execute({}, { signal: signal() });
    assert.match(text, /没有携带会话上下文/);
    assert.equal(h.requests.length, 0, 'a review without a session must not call Jev');

    const report = await tool(h, 'jev_review_report').execute({}, { signal: signal() });
    assert.match(report, /还没有判断记录/);
  } finally {
    await h.dispose();
  }
});

test('the provider switch cannot pretend to mount a backend', async () => {
  const h = await harness();
  try {
    const report = await h.toggle('enable', 'provider');
    assert.match(report, /这只记录了运行时意图|注意/);
    assert.deepEqual(optional(h.tools()), ['jev_provider_status']);
    const state = await tool(h, 'jev_provider_status').execute({}, { signal: signal() });
    assert.equal(state.requested, true);
    assert.equal(state.mounted_here, false, 'ctx.compaction is a composition concern, not ours to claim');
  } finally {
    await h.dispose();
  }
});

test('jev_status reports configured=false and never calls the network', async () => {
  const h = await harness('');
  try {
    await h.toggle('enable', 'decision');
    const status = await tool(h, 'jev_status').execute({}, { signal: signal() });
    assert.equal(status.configured, false);
    assert.equal(h.requests.length, 0);
  } finally {
    await h.dispose();
  }
});

test('jev_evaluate fails closed without a key, then sends the current key per call', async () => {
  let key = '';
  const ctx = new Context();
  ctx.provide('credentials', { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' && key ? { value: key } : undefined) });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, {});
  await ctx.plugin(Skills, {});
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(options.headers.authorization);
    return Response.json({
      model: 'jev-test',
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const mount = await ctx.plugin(plugin, {});
  try {
    await ctx.tools.get('jev_features').execute({ action: 'enable', feature: 'decision' }, { signal: signal() });
    const ask = () =>
      ctx.tools.get('jev_evaluate').execute(
        { state: 't', questions: { a: { type: 'noul', instructions: 'Yes?' } } },
        { signal: signal() },
      );
    await assert.rejects(ask(), /TYPESAFE_API_KEY/);
    assert.equal(requests.length, 0, 'a missing key must not reach the network');

    key = 'first';
    assert.equal((await ask()).answers.a.noul, 0.9);
    key = 'second';
    await ask();
    assert.deepEqual(requests, ['Bearer first', 'Bearer second'], 'the key must be re-read every call');
  } finally {
    globalThis.fetch = realFetch;
    await mount.dispose();
    await ctx.fiber.dispose();
  }
});

test('unmounting the plugin removes every registration including the control tool', async () => {
  const h = await harness();
  await h.toggle('enable', 'decision');
  await h.toggle('enable', 'review');
  assert.equal(h.tools().length, 6);
  globalThis.fetch = realFetch;
  await h.mount.dispose();
  try {
    assert.deepEqual(h.tools(), [], 'nothing may survive an unload');
    assert.deepEqual(await h.skillNames(), []);
  } finally {
    await h.ctx.fiber.dispose();
  }
});

/** @returns {import('node:test')} helper: reach a registered tool or fail with the list */
function tool(h, name) {
  const found = h.ctx.tools.get(name);
  if (found === undefined) throw new Error(`工具未注册: ${name}（当前 ${h.tools().join(', ')}）`);
  return found;
}
