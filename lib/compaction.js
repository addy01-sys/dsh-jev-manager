/**
 * Compaction provider entry point.
 *
 * This file has NO static harness import. It resolves the harness's own
 * `BasicCompactionEngine` at runtime, from the module tree the running process actually
 * loaded, and builds the subclass against that class — see `lib/harness.mjs` for why a
 * bare specifier is the wrong question to ask on a desktop install.
 *
 * Two failure modes, and neither one may mount a wrong thing:
 *   - nothing resolves → do not mount; DSH keeps its own backend and says so.
 *   - something resolves but it belongs to a DIFFERENT harness than the app we are
 *     running in → do not mount either. Subclassing a stale copy raises no error; the
 *     seam just binds a class the running harness does not recognise, and compaction
 *     quietly stops behaving like DSH's.
 */

import { PLUGIN, makeEngine } from './engine.mjs';
import { readFeatures, writeMountRecord } from './features.mjs';
import { foreignHarnessReason, loadFromAnchors, resolutionAnchors } from './harness.mjs';

export const name = 'dsh-jev-manager/compaction';
/** Nothing required up front: the base class is discovered, not declared. */
export const inject = [];

const BASE_PACKAGE = '@deepseek-ai/dsh-compaction-basic';
const SCHEMA_PACKAGE = '@deepseek-ai/schemastery';

export async function apply(ctx, config = {}) {
  const base = await loadFromAnchors(ctx, BASE_PACKAGE, (mod) => mod?.BasicCompactionEngine);
  if (base === null) {
    writeMountRecord({ mounted: false, reason: 'no BasicCompactionEngine reachable', anchors: resolutionAnchors(ctx) });
    ctx.logger?.warn?.(`${PLUGIN}: 找不到正在运行的 harness 的 BasicCompactionEngine，压缩后端未挂载；DSH 继续使用自己的摘要。`);
    return;
  }

  const reason = foreignHarnessReason(base.resolved);
  if (reason !== null) {
    writeMountRecord({ mounted: false, reason, base: base.resolved, anchor: base.from });
    ctx.logger?.warn?.(`${PLUGIN}: ${reason} — 不挂载，避免把接缝绑到另一份 harness 的类上；DSH 继续用自己的摘要。`);
    return;
  }

  const schema = await loadFromAnchors(ctx, SCHEMA_PACKAGE, (mod) => mod?.default ?? mod?.z);
  if (schema === null) {
    // No declared schema without schemastery. resolveTuning still coerces every field to
    // its default, so the row's `config:` keys keep working; only validation is weaker.
    ctx.logger?.warn?.(`${PLUGIN}: 未解析到 schemastery，provider 以默认调参运行。`);
  }

  const Engine = makeEngine(base.value, schema?.value);
  await ctx.plugin(Engine, config);
  // `credentials` is read with ctx.get(), not declared in inject — record whether this
  // realm can actually serve it, because that decides if the key ever resolves.
  writeMountRecord({
    mounted: true,
    base: base.resolved,
    base_class: base.value?.name ?? null,
    anchor: base.from,
    schemastery: schema !== null,
    credentials_seam: ctx.get?.('credentials') !== null && ctx.get?.('credentials') !== undefined,
    adopt: config?.adopt === true,
    provider_feature: readFeatures().provider,
  });
  ctx.logger?.info?.(`${PLUGIN}: 已挂载，基类来自 ${base.resolved}`);
}

export { PLUGIN, makeEngine } from './engine.mjs';
export default apply;
