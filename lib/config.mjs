/**
 * The one home for the tunables shared by the review tool and the compaction provider,
 * so the two halves of this plugin cannot drift to different defaults for one knob.
 *
 * Deliberately free of any harness import, including `@deepseek-ai/schemastery`: the
 * host plane is mounted on every boot and must not depend on a harness package
 * resolving — the plugins actually running in this machine's desktop profile declare
 * the harness only as a peer and import nothing from it. The provider, which must
 * subclass the host's engine by definition, builds the schema from this table.
 */

/**
 * Deliberately NOT upstream's 0.5. On Jev's scale 0.5 reads as "uncertain", and this
 * threshold gates *deletion*, so a lower value means "keep unless quite sure".
 * Keeping is always safe and only costs tokens; dropping is the risky direction.
 *
 * `doc` is what a user reads in the preset row; `kind` maps to a schemastery helper
 * in the provider.
 */
export const TUNING_FIELDS = [
  { key: 'keepThreshold', kind: 'number', def: 0.4, doc: '调用/输出存活所需的最低 Jev 概率。' },
  { key: 'preserveRecentMessages', kind: 'natural', def: 6, doc: '最近多少条不碰；区间首条永远保留。' },
  { key: 'maxStateTokens', kind: 'natural', def: 25_000, doc: '送给 Jev 的 state 估算 token 上限。' },
  { key: 'maxRequestTokens', kind: 'natural', def: 30_000, doc: 'state + 单次问题批量的估算上限。' },
  { key: 'truncateHeadChars', kind: 'natural', def: 300, doc: '被删输出保留的头部字符数，0 = 只留提示。' },
  { key: 'minReductionRatio', kind: 'number', def: 0.15, doc: '压缩比例低于此值就不改写历史。' },
  { key: 'minTokensSaved', kind: 'natural', def: 500, doc: '以及绝对节省量下限。' },
  { key: 'jevTimeoutMs', kind: 'natural', def: 5_000, doc: '单次 Jev 请求时限。' },
  { key: 'jevModel', kind: 'string', def: 'jev-latest', doc: 'TypeSafe Jev 模型名。' },
];

export const KEEP_THRESHOLD_DEFAULT = TUNING_FIELDS.find((field) => field.key === 'keepThreshold').def;

const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * Coerce a raw config object into the shape both features read. Missing, NaN and
 * wrongly typed values fall back to the table's default rather than throwing, so a
 * typo in one knob cannot stop the harness from booting.
 * @param {object} [settings]
 * @returns {Record<string, number|string>}
 */
export function resolveTuning(settings = {}) {
  const out = {};
  for (const { key, kind, def } of TUNING_FIELDS) {
    const value = settings[key];
    if (kind === 'string') out[key] = typeof value === 'string' && value.length > 0 ? value : def;
    else if (kind === 'natural') out[key] = Number.isInteger(value) && value >= 0 ? value : def;
    else out[key] = num(value, def);
  }
  return out;
}
