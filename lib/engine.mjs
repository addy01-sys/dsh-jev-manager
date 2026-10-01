/**
 * Build the compaction provider class against whatever `BasicCompactionEngine` the
 * running harness actually loaded.
 *
 * Why this is a factory and not a plain `class … extends BasicCompactionEngine`:
 * the desktop app runs the harness out of `resources/app.asar`, which Node's resolver
 * cannot reach from a plugin file on disk. A plugin under
 * `$DSH_HOME/profiles/<p>/node_modules/…` resolves `@deepseek-ai/*` by walking UP to
 * `$DSH_HOME/profiles/node_modules` — and on a machine that has also used the npm CLI,
 * that directory holds the npm versions. Measured here: the app runs 0.2.0-rc.2 while
 * the resolution root holds `dsh-compaction-basic@0.1.5-rc.2` and `cordis@4.0.2`.
 * Subclassing that copy produces a class the harness does not recognise, so the seam
 * silently binds the wrong engine. This is the same reason the plugins already running
 * in this desktop profile import nothing from the harness at all.
 *
 * @param {typeof import('@deepseek-ai/dsh-compaction-basic').BasicCompactionEngine} Base
 *        the engine class from the running harness
 * @param {object} [z] schemastery from the same resolution family; without it the class
 *        declares no schema and the raw row config is coerced instead, which is safe
 *        because every field falls back to a default.
 * @returns {typeof Base & {new(ctx: object, config?: object): object}}
 */

import { TUNING_FIELDS, resolveTuning } from './config.mjs';
import { readFeatures } from './features.mjs';

export const PLUGIN = 'dsh-jev-manager/compaction';

/** The same rule the schema encodes, kept here so a missing schemastery is not fatal. */
const schemaFor = {
  number: (def) => (z) => z.number().default(def),
  natural: (def) => (z) => z.natural().default(def),
  string: (def) => (z) => z.string().default(def),
};

export function makeEngine(Base, z) {
  const Config = z?.object?.({
    /** false = shadow: run everything, log the decisions, return DSH's summary. */
    adopt: z.boolean().default(false),
    ...Object.fromEntries(TUNING_FIELDS.map((field) => [field.key, schemaFor[field.kind](field.def)(z)])),
  });

  /**
   * The provider overrides the ONE hook `BasicCompactionEngine` documents as its
   * customization point, so trigger policy, retention, the durable log transaction and
   * the surface replacement all stay the official ones. Where the stock backend asks a
   * model to rewrite the span, two `noul` questions are asked about every tool call and
   * only what Jev is confident about is dropped; everything kept stays verbatim.
   *
   * FALLS BACK, NEVER HALF-WAY. No key, no candidates, an unpairable span, a timeout,
   * a malformed answer, a saving below either threshold, or anything thrown internally
   * all hand the span to the base `summarize()`, exactly as if this plugin were absent.
   *
   * SHADOW FIRST. `adopt: false` runs the whole pipeline and logs the decisions but
   * still returns DSH's summary. What shadow cannot measure: a smaller context,
   * retained key context, and "the agent keeps working" only exist once adopted.
   */
  class JevCompactionEngine extends Base {
    // NOT `credentials`: the official consumer of that seam (`dsh-llm-deepseek-api-key`)
    // reads it with `ctx.get()` and an absence branch rather than declaring it, because a
    // declared dependency cordis must satisfy — and inside the isolated `compaction` realm
    // there is no guarantee it can. Demanding it would fail the whole row, which is worse
    // than degrading to the launch environment the way the harness itself does.
    static inject = [...(Base.inject ?? [])];
    static Config = Config ?? Base.Config;

    constructor(ctx, config = {}) {
      // Hand the base its own schema's defaults, not `{}`, so trigger thresholds,
      // retry counts and `auto` stay byte-identical to the stock row this replaces.
      // Enabling this must not move the moment DSH decides to compact.
      super(ctx, Base.Config ? Base.Config({}) : {});
      this.engineCtx = ctx;
      this.curator = { adopt: config.adopt === true, ...resolveTuning(config) };
      this.stats = { attempts: 0, adopted: 0, fallbacks: 0, last: null };
      this.logSink = ctx.logger ?? null;
      this.logRow(
        `${this.curator.adopt ? 'ACTIVE (may replace DSH summaries)' : 'SHADOW (logs only, DSH still summarizes)'}` +
          ` · provider feature ${readFeatures().provider ? 'on' : 'off'}`,
      );
    }

    /**
     * Where the Jev key comes from, in the order the harness itself uses.
     *
     * `dsh-llm-deepseek-api-key` reads `ctx.get('credentials')`, and when that service is
     * not in reach it falls back to the launcher's environment snapshot — whose own
     * fallback is `process.env`. Copying that ladder rather than declaring `credentials`
     * in `inject` is what keeps this row mountable inside the isolated `compaction` realm:
     * a declared service cordis cannot resolve fails the row, and a failed row means DSH
     * has no compaction backend at all.
     *
     * @returns {Promise<string|undefined>}
     */
    async resolveApiKey() {
      const ref = 'TYPESAFE_API_KEY';
      const credentials = this.engineCtx?.get?.('credentials');
      if (credentials !== null && credentials !== undefined) {
        try {
          const hit = await credentials.resolve(ref);
          if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value;
        } catch {
          /* a realm that cannot serve the seam is not a reason to skip the env fallback */
        }
      }
      const snapshot = this.engineCtx?.get?.('launchEnvironment');
      const ambient = snapshot?.get?.(ref)?.value ?? process.env[ref];
      return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined;
    }

    /**
     * Not a `#private` method: `ctx.compaction` is a cordis proxy, and private methods
     * brand-check their receiver, so `this.#log()` throws whenever this hook is reached
     * through the proxy instead of the instance. A diagnostic must never be the reason
     * compaction fails.
     */
    logRow(line) {
      try {
        this.logSink?.debug?.(`${PLUGIN}: ${line}`);
      } catch {
        /* logging is best-effort */
      }
    }

    async summarize(input, agent, signal) {
      const started = Date.now();
      this.stats.attempts += 1;
      // Reach the base hook through the prototype, so the lookup does not depend on `this`
      // being the instance rather than cordis's service proxy. The receiver is the same
      // object either way (`.call(this)` and `super.summarize()` agree on that); what makes
      // the hook safe through the proxy is that neither this class nor the base keeps a
      // private member in the path — see the note above `logRow`.
      const base = (i, a, s) => Object.getPrototypeOf(Object.getPrototypeOf(this)).summarize.call(this, i, a, s);
      const toDsh = (reason, detail) =>
        base(input, agent, signal).then((summary) => {
          this.stats.fallbacks += 1;
          this.stats.last = { ...this.stats.last, reason, detail: detail ?? null, ms: Date.now() - started };
          this.logRow(`fallback=${reason}${detail ? ` detail=${String(detail).slice(0, 200)}` : ''} ms=${Date.now() - started}`);
          return summary;
        });

      // The feature switch is read per call, so disabling needs no restart.
      if (!readFeatures().provider) return toDsh('feature_off');

      const { fromDsh, pairingRisks, renderCompacted } = await import('./adapter.js');
      const { applyDecisions, compact, messageChars } = await import('./vendor/compact.js');
      const { collectToolCalls, estimateTokens } = await import('./vendor/state.js');
      // Built on first use, so this module's static import graph stays free of harness
      // packages and the client can be created inside an async context.
      this.jev ??= (await import('./jev.mjs')).createJev({
        // Resolved per call, so a rotated key takes effect without a restart.
        getApiKey: () => this.resolveApiKey(),
        timeoutMs: Math.max(this.curator.jevTimeoutMs, 20_000),
      });

      try {
        const converted = fromDsh(input?.messages ?? []);
        if (converted.messages.length === 0) return await toDsh('empty_span');
        const risks = [...converted.risks, ...pairingRisks(converted.messages)];
        if (risks.length > 0) return await toDsh('pairing_risk', risks[0]);
        if (signal?.aborted === true) return await toDsh('cancelled');

        const calls = collectToolCalls(converted.messages, this.curator.preserveRecentMessages);
        const candidates = calls.filter((call) => !call.pinned && !converted.protectedCallIds.has(call.tool_use_id));
        this.stats.last = {
          calls: calls.length,
          candidates: candidates.length,
          pinned: calls.filter((call) => call.pinned).length,
          protected_results: converted.protectedCallIds.size,
        };
        if (candidates.length === 0) {
          return await toDsh('no_candidates', `${calls.length} 个配对调用全部被 pin 或受保护`);
        }

        const jevUsage = { requests: 0, latency_ms: 0, model: null, input_tokens: 0, output_tokens: 0 };
        const asker = {
          ask: async (state, questions) => {
            const answered = await this.jev.evaluate({ state, questions }, { signal });
            jevUsage.requests += 1;
            jevUsage.latency_ms += answered.latencyMs ?? 0;
            jevUsage.input_tokens += answered.usage.input_tokens;
            jevUsage.output_tokens += answered.usage.output_tokens;
            if (answered.model !== null && answered.model !== undefined) jevUsage.model = answered.model;
            return { answers: answered.answers };
          },
        };

        const result = await compact(converted.messages, asker, {
          ...this.curator,
          // A result holding an image or a file cannot be reproduced by re-running the
          // tool, so those calls are protected: never asked about (which would be paid
          // for and discarded), never eligible for deletion, and always decided `keep`.
          protectedCallIds: converted.protectedCallIds,
        });

        const decisions = result.decisions;
        const kept = applyDecisions(converted.messages, decisions, calls, this.curator.truncateHeadChars);
        const charsBefore = converted.messages.reduce((sum, message) => sum + messageChars(message), 0);
        const charsAfter = kept.reduce((sum, message) => sum + messageChars(message), 0);
        const ratio = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
        const view = renderCompacted(kept);
        const tokensBefore = estimateTokens(renderCompacted(converted.messages));
        const tokensAfter = estimateTokens(view);
        const saved = tokensBefore - tokensAfter;

        this.stats.last = {
          ...this.stats.last,
          adopted: this.curator.adopt === true,
          kept: decisions.filter((d) => d.reason === 'kept').length,
          resultDropped: decisions.filter((d) => d.reason === 'result_dropped').length,
          callDropped: decisions.filter((d) => d.reason === 'call_dropped').length,
          protected: decisions.filter((d) => d.reason === 'protected').length,
          reduction_ratio: Number(ratio.toFixed(4)),
          tokens_saved: saved,
          jev: jevUsage,
        };

        if (ratio < this.curator.minReductionRatio) {
          return await toDsh('low_reduction', `${(ratio * 100).toFixed(1)}% < ${(this.curator.minReductionRatio * 100).toFixed(1)}%`);
        }
        if (saved < this.curator.minTokensSaved) return await toDsh('not_smaller', `估算节省 ${saved} token`);
        if (!this.curator.adopt) return await toDsh('shadow_mode', `${decisions.length} 条判断已记录，仍采用 DSH 摘要`);

        this.stats.adopted += 1;
        this.logRow(`adopted tokens ${tokensBefore}→${tokensAfter} (-${saved}) ratio=${ratio.toFixed(3)} jev=${jevUsage.requests}`);
        // `usage` is deliberately omitted: the type means "provider usage for the LLM
        // seam call", and this is not one. Jev's own spend is in the log row above.
        return {
          summary: [{ type: 'text', text: view }],
          provider: 'typesafe',
          model: jevUsage.model ?? this.curator.jevModel,
          curator: { jevRequests: jevUsage.requests, inputTokens: jevUsage.input_tokens, outputTokens: jevUsage.output_tokens },
        };
      } catch (error) {
        const kind =
          error?.name === 'JevError'
            ? { no_key: 'no_key', timeout: 'jev_timeout', cancelled: 'cancelled', busy: 'jev_busy' }[error.kind] ?? 'jev_error'
            : 'internal_error';
        return await toDsh(kind, error?.message);
      }
    }
  }

  return JevCompactionEngine;
}
