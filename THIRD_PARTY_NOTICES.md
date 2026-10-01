# Third-party notices

This plugin incorporates MIT-licensed work from two upstream projects. Both license
texts are reproduced in full below, as those licenses require.

## 1. fast-jev-compaction

Parts of the compaction core are a direct port of
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT, `Copyright (c) 2025`), taken at commit
`e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (version 0.2.0). They reached this
checkout through the MIT-licensed port in `dsh-context-curator` (section 2).

Ported into `lib/vendor/` (TypeScript types removed, JSDoc kept):

| Upstream | Here | Content |
|---|---|---|
| `src/state.ts` | `lib/vendor/state.js` | token estimate, tool-call collection and pairing, `fitState`, `truncate` |
| `src/compact.ts` | `lib/vendor/compact.js` | batching, the two `noul` questions per call, `decideCall` (keep / drop_result / drop_call), `applyDecisions`, `messageChars`, `reductionRatio` |
| `src/request.ts` | `lib/vendor/request.js` | Jev request envelope, response validation, `noulAnswer` |

NOT ported: `hooks/fast-jev.ts` and `.claude-plugin/` (the Claude Code hook adapter,
which this plugin replaces with its own cordis row), `src/client.ts` /
`src/messages.ts` (thin fetch wrappers — this plugin uses its own client in
`lib/jev.mjs`), and `vendor.types.js` (typedefs only; unused here).

**Two changes inside the ported code**, both marked `LOCAL CHANGE` where they sit:

1. `compact()` accepts `protectedCallIds`. Calls whose result holds an image or a file
   cannot be reproduced by re-running the tool, so they are excluded from the questions
   (no spend on an answer that would be discarded), excluded from the candidate count, and
   decided `keep` with reason `protected`. Upstream has no such concept and asks about
   them; this plugin protected them only *after* paying for the answers.
2. The note that replaces a trimmed tool result names this plugin
   (`[dsh-jev-manager dropped … chars …]`) rather than upstream's project name, because it
   is the model reading it.

## 2. dsh-context-curator

[dsh-context-curator](https://github.com/LXBWOW/dsh-context-curator)
(MIT, `Copyright (c) 2026 LXBWOW`) at commit
`24428471da1836aafd7fa3b6ce5e5f23af25b7ef` (version 0.1.0).

| Upstream | Here |
|---|---|
| `lib/adapter.js` | `lib/adapter.js` — DSH message ↔ core vocabulary: `fromDsh`, `pairingRisks`, `renderCompacted`, `resultText`, `plainText` |

`tools/link-deps.mjs` and `tools/install-preset.mjs` were written for this plugin but
follow the same approach upstream documented for the same two DSH constraints
(junctioned harness dependencies; a copied preset rather than a patch). They are
derivative in structure and are attributed here for that reason.

## What this plugin changes on top of the ported core

The core's decision structure, fitting stages and batching rule are unmodified — the one
exception is the `protected` outcome described above, which removes questions the caller
already knew it would discard. Everything below lives in the code that *calls* it, or in
this plugin's own modules:

- **Protected calls are never asked about.** See change 1 above: the guarantee lives in
  `decideCall`/`compact()` rather than in a post-hoc rewrite of their decisions, so the
  reported candidate count matches the questions actually sent.

- **`keepThreshold` default 0.4**, not upstream's 0.5. On Jev's scale 0.5 means
  "uncertain", and the threshold here gates *deletion*, so a lower value means
  "keep unless quite sure".
- **Key resolution per call through DSH's `credentials` service**
  (`ctx.credentials.resolve('TYPESAFE_API_KEY')`), so a rotated key takes effect
  without a restart. Upstream resolved the key once at construction, from
  environment or a supervisor's dotenv file.
- **The fallback summary no longer sets `llmStreamCall: false`.** The official
  `SummaryResult` union declares that field as `never` for a non-LLM-seam result, so
  the field is omitted rather than given a wrong value.
- **The fallback summary no longer fabricates `usage: { inputTokens: 0, outputTokens: 0 }`.**
  `usage` means "provider usage for the LLM seam call"; this is not one, so it is
  omitted. The Jev spend is reported under this plugin's own `curator` field.
- **`stats.last` merges instead of replacing**, so the decisions and sizes recorded
  before a fallback survive — in shadow mode they are the only evidence the run left.
- **No `#private` methods anywhere on the hook path.** `ctx.compaction` is a cordis proxy
  and a service accessor passes *itself* as the receiver, so `this.#log()` throws
  `Cannot read private member … from an object whose class did not declare it` whenever the
  hook is reached through it — which would make the *fallback path itself* the reason
  compaction failed. Looking the base hook up through the prototype does not change the
  receiver (`.call(this)` and `super.x()` pass the same object); it only keeps the lookup
  from depending on the proxy. Neither this class nor `dsh-compaction-basic` has a private
  member in that path. See the note in `lib/compaction.js`.
- **Preset discovery also covers a global npm install** (`%APPDATA%/npm/node_modules/
  @deepseek-ai/dsh/node_modules/…`), not only a packaged Desktop app.

## fast-jev-compaction license

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## dsh-context-curator license

```
MIT License

Copyright (c) 2026 LXBWOW

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Not derived from any third party

`lib/jev.mjs`, `lib/host.mjs`, `lib/compaction.js`, `skills/jev-decision/SKILL.md`
and the tests are original to this plugin. `lib/jev.mjs` follows the behaviour
described in [Devin-AXIS/jev-dsh-decision](https://github.com/Devin-AXIS/jev-dsh-decision),
which **carries no license**, so nothing was copied from it; the tool surface,
validation rules and error handling were re-implemented from its documented
behaviour.
