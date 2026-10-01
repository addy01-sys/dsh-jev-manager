# dsh-jev-manager

[简体中文](README.md) | **English**

A DeepSeek Harness plugin that wires [TypeSafe Jev](https://docs.typesafe.ai/api) — a fast structured-decision model, not an LLM — into DSH and adds two things:

1. **Read-only decision tools for the model**: pick one of the tools, skills, or agents that are actually available and permitted right now, or score an output against an explicit rubric.
2. **A context-compaction backend**: replaces "have the model rewrite the history as a summary" with "decide, tool call by tool call, which outputs are stale" — dropping only what Jev is confident about and keeping everything else verbatim.

Both share one `TYPESAFE_API_KEY` and one endpoint.

---

## What it does

### 1. Tools for the model (all off by default)

On a cold start the model sees exactly one tool, `jev_features` (the switchboard). Each switch registers its own tools and skill:

| Switch | What it registers | What it is for |
|---|---|---|
| `decision` | `jev_status`, `jev_check_connection`, `jev_evaluate` + skill `jev-decision` | Bounded choices and rubric scoring through Jev |
| `review` | `jev_context_review`, `jev_review_report` + skill `jev-context-review` | Read-only analysis: which tool outputs in this session are stale, and how many tokens that would reclaim |
| `provider` | `jev_provider_status` | Records the intent to run the compaction backend; the actual mount is a composition concern |

`jev_evaluate` is the core: up to 64 questions asked against one `state`, in three question types —

- **choice**: pick one of 2–255 options; returns the choice, the full probability distribution, and confidence;
- **score**: rate on 2–10 ordered levels; returns the weighted score, the level legend, and probabilities;
- **noul**: a yes/no probability. **Near 0.5 means "uncertain"**, not "medium".

It only answers. It does not install plugins, grant permissions, call subagents, or perform any recommended action.

### 2. Compaction backend

DSH's stock compaction asks a model to **rewrite a span of history as prose** (lossy). This plugin replaces that step:

    span ──▶ two noul questions per tool call ──▶ drop only what Jev is sure about ──▶ keep the rest verbatim
             ("is this call still needed?" / "must its full output stay verbatim?")
                                              └─ any uncertainty ─▶ hand the span back to DSH

It overrides only `summarize(input, agent, signal)`, the single hook `@deepseek-ai/dsh-compaction-basic` documents as its customization point; trigger policy, retention, the durable log transaction, and the surface replacement all stay the stock ones.

**Always kept**: user and assistant prose enters the checkpoint verbatim — never rewritten, never condensed. A tool result holding an image or a file is never deleted (re-running the tool cannot reproduce those bytes), and such calls are not even sent to Jev — you do not pay for an answer that could only be discarded.

`adopt: false` (shadow) is the default: the whole pipeline runs and logs its decisions and savings, but DSH still stores its own summary. Turning it on therefore changes nothing until you change `adopt`.

## Install

You need DSH (0.1.5 or 0.2) and a TypeSafe key.

### 1. Credentials

| Where | How | Who can read it |
|---|---|---|
| **Launch environment** (highest precedence) | `setx TYPESAFE_API_KEY "apikey_…"` (Windows) or `export TYPESAFE_API_KEY=…`, then restart DSH | the tools **and** the compaction backend |
| **Credential file** | add `TYPESAFE_API_KEY: apikey_…` under `refs:` in `~/.dsh/.credentials.yaml` (the file is watched and hot-reloaded) | the tools only |

The compaction backend runs inside an isolated `compaction` realm that cannot reach the credentials seam, so it **only reads the launch environment**. Putting the key in both places is the low-friction option.

### 2. Install the plugin

**Desktop app**: sidebar → Plugins → install an external bundle → pick this directory. The app does not let the CLI touch the desktop profile, so this step has to be clicked.

**npm CLI**:

    node tools/install.mjs --profile web      # back up → install → bridge deps → verify binding
    # or simply: dsh plugin --profile web add <this directory>

### 3. Enable features

    node tools/features.mjs enable decision
    node tools/features.mjs enable review

Or leave the files alone and let the model call `jev_features { action: "enable", feature: "decision" }` inside a session. Switch state lives in `~/.dsh/jev-manager/features.json` and **never in your profile configuration**; switching a feature off really unregisters its tools and skill.

### 4. Mount the compaction backend (optional)

The backend is **one row inside a preset**, which a bundle patch cannot reach, so it is mounted by adding a sibling preset:

    node tools/make-preset-patch.mjs --profile web    # writes jev-preset.patch.yml

- **CLI**: `dsh --profile <p> --patch ./jev-preset.patch.yml`
- **Desktop app** (which cannot take `--patch`): append the contents of `jev-preset.patch.yml` to `~/.dsh/profiles/desktop/cordis.patch.yml`, then restart DSH
- **DSH 0.1.5** (directory-style presets): use `node tools/install-preset.mjs` instead

Start a new session afterwards and pick the **`jev`** preset. None of the shipped presets are modified; without picking it, behaviour is exactly what it was before installing. To confirm the backend really mounted:

    node tools/mount-report.mjs      # which base class, schemastery, credentials seam

## Usage

**Tools**: just talk to the agent (the skill triggers on its own), or name `jev_evaluate` directly. Use `jev_status` to check the key locally without a network call, and `jev_check_connection` to prove the key and service work (one real request, a little usage).

**Compaction backend**: once mounted and selected, `/compact` and automatic pressure compaction go through Jev. Stay in the default shadow mode for a while, confirm the logged decisions look right, then flip `adopt` in the preset row:

    - id: jev-compaction
      name: 'dsh-jev-manager/compaction'
      config:
        adopt: false      # true replaces DSH's summary

## Configuration

Written under the `config:` of that preset row.

| Key | Default | Meaning |
|---|---|---|
| `adopt` | `false` | `false` = shadow (log only); `true` = use Jev's checkpoint |
| `keepThreshold` | `0.4` | Minimum probability for a call or its result to survive |
| `preserveRecentMessages` | `6` | How many trailing messages are never touched; the span's first message is always kept |
| `maxStateTokens` | `25000` | Estimated ceiling for the `state` sent to Jev |
| `maxRequestTokens` | `30000` | Ceiling for `state` plus one batch of questions |
| `truncateHeadChars` | `300` | Head kept from a dropped result; `0` keeps only the note |
| `minReductionRatio` | `0.15` | Below this ratio, rewriting the history is not worth it |
| `minTokensSaved` | `500` | …nor below this absolute saving |
| `jevTimeoutMs` | `5000` | Per-request Jev deadline (the implementation floors it at 20000 ms, so smaller values have no effect) |
| `jevModel` | `jev-latest` | TypeSafe model name or alias |

`keepThreshold` is deliberately not upstream's 0.5: on Jev's scale 0.5 reads as "uncertain" rather than "moderately useful", and this threshold gates *deletion*, so a lower value means "keep unless quite sure". Keeping only costs tokens; dropping the wrong thing cannot be undone.

## When it falls back to DSH

Any one of these hands the span to DSH's own summarizer; behaviour is then identical to not having the plugin installed, and the agent cannot tell:

| Reason | Trigger |
|---|---|
| `shadow_mode` | `adopt: false` (the default) |
| `feature_off` | the `provider` switch is off |
| `empty_span` | nothing projectable in the span |
| `pairing_risk` | orphan result, duplicated result, or a result before its call |
| `no_candidates` | every call is pinned or protected |
| `no_key` | `TYPESAFE_API_KEY` not found |
| `jev_timeout` / `jev_busy` / `jev_error` | Jev timed out, returned 429/529, or answered with a malformed structure |
| `low_reduction` / `not_smaller` | below the two saving thresholds |
| `cancelled` | compaction was cancelled |
| `internal_error` | a bug in this plugin |

A crash, a timeout, or a bad response always degrades to "no curation", never to "broken session".

## Cost

1. **Jev calls**: billed per input token (Jev 1.13 is $42 per billion input tokens; output tokens are free). The `state` is resent on every request, so cost grows with history length; `maxStateTokens` / `maxRequestTokens` are the brakes, and `minReductionRatio` + `minTokensSaved` keep it from rewriting history for a negligible saving.
2. **Prompt-cache backlash**: replacing older history invalidates the provider's KV cache from the first changed token. What you save on context may be paid back in cache rewrites.

## What it deliberately does not do

No per-step proactive pruning · no per-tool-result Jev call · no background periodic curation · does not take over the main agent, change the agent loop, or route requests · does not register an LLM adapter or intercept any request · does not return prose reasoning · does not rewrite long-term session files (the original events stay in the log, so replay still reconstructs the truth).

## Development

    node --test                      # all tests, 0 API usage (the network layer is stubbed)
    node tools/features.mjs          # switch state (isolate with DSH_HOME)
    node tools/mount-report.mjs      # which base class the provider actually bound
    node tools/guard.mjs compare     # byte-for-byte config check after uninstall

Harness version skew, the junction-ownership rule behind `--remove`, uninstall/restore semantics, and what has been verified against the live API are documented in [MAINTAINERS.md](MAINTAINERS.md).

## Credits and license

- The compaction core (`lib/vendor/`, `lib/adapter.js`) is derived from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) and [LXBWOW/dsh-context-curator](https://github.com/LXBWOW/dsh-context-curator) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The Jev client follows the [TypeSafe AI API reference](https://docs.typesafe.ai/api) and always posts to `https://api.typesafe.ai/v1/systemone`.
- Maintained independently; not affiliated with or endorsed by DeepSeek or TypeSafe AI.

**MIT** — see [LICENSE](LICENSE).
