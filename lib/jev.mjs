/**
 * Shared Jev transport for both planes of this plugin: the model-facing tools in
 * `host.mjs` and the compaction provider in `compaction.mjs`. One endpoint, one
 * key source (`TYPESAFE_API_KEY` through the host's credentials service), so a
 * machine configures Jev in exactly one place.
 *
 * Instances are cheap and hold no connection state, so each plane builds its own
 * rather than reaching across the preset realm boundary for a service object.
 */

import { setTimeout as delay } from 'node:timers/promises';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const MAX_QUESTIONS = 64;
export const MAX_REQUEST_BYTES = 256 * 1024;

export class JevError extends Error {
  constructor(message, kind = 'request', options) {
    super(message, options);
    this.name = 'JevError';
    this.kind = kind;
  }
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const hasText = (value) =>
  typeof value === 'string' ? value.trim().length > 0 : isRecord(value) || Array.isArray(value);

const isProbability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function assert(condition, message) {
  if (!condition) throw new JevError(message, 'invalid_input');
}

/**
 * Validate at the boundary and serialize. Rejects unknown keys, non-JSON values,
 * circular state, oversized requests, and any question shape the provider cannot
 * answer, so nothing malformed reaches the network.
 * @param {{state: unknown, questions: Record<string, object>}} input
 * @returns {string} request body
 */
export function requestBody(input) {
  assert(
    isRecord(input) && Object.keys(input).every((key) => key === 'state' || key === 'questions'),
    '只接受 state 和 questions 两个顶层键。',
  );
  assert(hasText(input.state), 'state 必须是非空文本、对象或数组。');
  assert(isRecord(input.questions), 'questions 必须是问题 ID 到问题对象的映射。');
  const questions = Object.entries(input.questions);
  assert(
    questions.length >= 1 && questions.length <= MAX_QUESTIONS,
    `每次评估需要 1–${MAX_QUESTIONS} 个问题。`,
  );
  for (const [id, question] of questions) {
    assert(id.trim().length > 0 && id.length <= 160, '问题 ID 需要 1–160 个字符。');
    assert(
      isRecord(question) &&
        Object.keys(question).every((key) => key === 'type' || key === 'instructions' || key === 'criteria'),
      '问题只接受 type、instructions 和 criteria。',
    );
    assert(hasText(question.instructions), '每个问题需要完整的 instructions。');
    const { criteria } = question;
    if (question.type === 'choice') {
      assert(isRecord(criteria), 'choice.criteria 必须是候选项映射。');
      const options = Object.entries(criteria);
      assert(options.length >= 2 && options.length <= 255, 'choice 需要 2–255 个候选项。');
      assert(
        options.every(([key, value]) => key.trim() && (value === null || hasText(value))),
        'choice 候选需要有效 ID 和描述。',
      );
    } else if (question.type === 'score') {
      assert(
        Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 10 && criteria.every(hasText),
        'score.criteria 需要 2–10 个从低到高的等级描述。',
      );
    } else if (question.type === 'noul') {
      assert(
        criteria === undefined ||
          (isRecord(criteria) &&
            Object.entries(criteria).every(
              ([key, value]) => (key === 'true' || key === 'false') && hasText(value),
            )),
        'noul.criteria 只能包含 true 和 false 的描述。',
      );
    } else {
      throw new JevError('问题类型必须是 choice、score 或 noul。', 'invalid_input');
    }
  }
  let body;
  try {
    body = JSON.stringify(
      { state: input.state, questions: input.questions, model: MODEL },
      (_key, value) => {
        if (
          value === undefined ||
          typeof value === 'function' ||
          typeof value === 'symbol' ||
          (typeof value === 'number' && !Number.isFinite(value))
        ) {
          throw new TypeError('non-JSON value');
        }
        return value;
      },
    );
  } catch {
    throw new JevError('评估内容必须是可序列化的 JSON。', 'invalid_input');
  }
  assert(
    Buffer.byteLength(body) <= MAX_REQUEST_BYTES,
    '评估请求超过 256 KiB，请只保留与判断相关的上下文。',
  );
  return body;
}

/**
 * Project the provider answer onto the questions we actually asked. Extra upstream
 * fields are dropped, and an incomplete, out-of-range, or non-normalized answer
 * throws instead of being patched with a invented value.
 */
function parseAnswer(value, questions) {
  const invalid = new JevError('Jev 返回了不完整或无效的结构化结果。', 'malformed');
  if (!(isRecord(value) && typeof value.model === 'string' && isRecord(value.answers))) throw invalid;
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(value.answers, id) ? value.answers[id] : null;
    if (!(isRecord(answer) && answer.type === question.type)) throw invalid;
    if (answer.type === 'noul') {
      if (!isProbability(answer.noul)) throw invalid;
      answers[id] = { type: 'noul', noul: answer.noul };
      continue;
    }
    const levels =
      question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_item, index) => String(index));
    if (!(isProbability(answer.confidence) && isRecord(answer.probabilities))) throw invalid;
    if (
      Object.keys(answer.probabilities).length !== levels.length ||
      !levels.every((key) => Object.hasOwn(answer.probabilities, key) && isProbability(answer.probabilities[key]))
    ) {
      throw invalid;
    }
    const total = Object.values(answer.probabilities).reduce((sum, item) => sum + item, 0);
    if (Math.abs(total - 1) >= 0.02) throw invalid;
    const shared = { type: answer.type, confidence: answer.confidence, probabilities: answer.probabilities };
    if (answer.type === 'choice') {
      if (!(typeof answer.choice === 'string' && levels.includes(answer.choice))) throw invalid;
      answers[id] = { ...shared, choice: answer.choice };
      continue;
    }
    if (!(Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= levels.length - 1)) throw invalid;
    if (
      !(
        isRecord(answer.legend) &&
        Object.keys(answer.legend).length === levels.length &&
        levels.every((key) => Object.hasOwn(answer.legend, key) && hasText(answer.legend[key]))
      )
    ) {
      throw invalid;
    }
    answers[id] = { ...shared, score: answer.score, legend: answer.legend };
  }
  if (!(isRecord(value.usage) && ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0))) {
    throw invalid;
  }
  return {
    provider: 'TypeSafe AI',
    model: value.model,
    answers,
    usage: { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens },
  };
}

/**
 * @param {{getApiKey: () => (string|undefined|Promise<string|undefined>),
 *          fetcher?: typeof fetch, timeoutMs?: number}} options
 * @returns {{evaluate: Function, status: () => object, checkConnection: Function, dispose: () => void}}
 */
export function createJev({ getApiKey, fetcher = globalThis.fetch, timeoutMs = 20_000 }) {
  const lifetime = new AbortController();
  const readKey = async () => {
    const raw = await getApiKey();
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0) {
      throw new JevError('请先在 DSH 凭据中配置 TYPESAFE_API_KEY。', 'no_key');
    }
    if (/[\r\n]/.test(value)) throw new JevError('TYPESAFE_API_KEY 含有换行，无法作为请求头。', 'no_key');
    return value;
  };

  const evaluate = async (input, options = {}) => {
    const body = requestBody(input);
    const key = await readKey();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([lifetime.signal, deadline, ...(options.signal ? [options.signal] : [])]);
    const questions = JSON.parse(body).questions;
    const started = Date.now();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        signal.throwIfAborted();
        const response = await fetcher(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body,
        });
        if (response.ok) {
          let payload;
          try {
            payload = await response.json();
          } catch {
            throw new JevError('Jev 返回了无法解析的响应。', 'malformed');
          }
          return { ...parseAnswer(payload, questions), latencyMs: Date.now() - started };
        }
        await response.body?.cancel().catch(() => {});
        const busy = response.status === 429 || response.status === 529;
        if (busy && attempt < 2) {
          const header = response.headers.get('retry-after');
          const seconds = header === null ? NaN : Number(header);
          const backoff = Number.isFinite(seconds) ? seconds * 1000 : 250 * 2 ** attempt;
          if (backoff >= timeoutMs) throw new JevError('Jev 暂时繁忙，请稍后重试。', 'busy');
          await delay(Math.max(250 * 2 ** attempt, backoff), undefined, { signal });
          continue;
        }
        if (busy) throw new JevError('Jev 暂时繁忙，请稍后重试。', 'busy');
        if (response.status === 401) throw new JevError('Jev API Key 无效。', 'unauthorized');
        if (response.status === 422) throw new JevError('Jev 不接受此评估请求，请检查问题和判断标准。', 'rejected');
        throw new JevError(`Jev 请求失败（HTTP ${response.status}）。`, 'http');
      }
    } catch (error) {
      if (error instanceof JevError) {
        if (error.message.includes(key)) throw new JevError('Jev 请求失败。', error.kind);
        throw error;
      }
      if (lifetime.signal.aborted || options.signal?.aborted) throw new JevError('Jev 评估已取消。', 'cancelled');
      if (deadline.aborted) throw new JevError('Jev 评估超时，请稍后重试。', 'timeout');
      // 原始 fetch 错误可能带 URL 或请求上下文，只保留分类，不转发正文。
      throw new JevError('Jev 网络请求失败，请检查网络连接。', 'network');
    }
  };

  return {
    dispose: () => lifetime.abort(),
    status: async () => ({
      provider: 'TypeSafe AI',
      model: MODEL,
      endpoint: ENDPOINT,
      configured: Boolean((await getApiKey())?.trim()),
      remoteVerified: false,
      primitives: ['choice', 'score', 'noul'],
    }),
    checkConnection: async (options) => {
      const result = await evaluate(
        {
          state: 'Connection check.',
          questions: { connected: { type: 'noul', instructions: 'Does this text describe a connection check?' } },
        },
        options,
      );
      return { connected: true, provider: result.provider, model: result.model, usage: result.usage };
    },
    evaluate,
  };
}
