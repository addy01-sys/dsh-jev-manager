# dsh-jev-manager

**简体中文** | [English](README.en.md)

DeepSeek Harness 插件：把 [TypeSafe Jev](https://docs.typesafe.ai/api)（快速结构化判断模型，不是 LLM）接进 DSH，提供两样东西——

1. **给模型的只读决策工具**：在几个真实可用、已获准的能力之间选一个，或按明确标准给输出打分；
2. **上下文压缩后端**：把「让模型重写摘要」的后端换成「逐条判断哪些工具输出已过期」，只删有把握的，其余逐字保留。

两者共用同一把 `TYPESAFE_API_KEY` 和同一个端点。

---

## 一、它做什么

### 1. 给模型的工具（默认全关）

冷启动时模型只看得见一个工具 `jev_features`（开关）。开哪个，注册哪个：

| 开关 | 开出来的东西 | 用途 |
|---|---|---|
| `decision` | `jev_status`、`jev_check_connection`、`jev_evaluate` + 技能 `jev-decision` | 用 Jev 做有界选择、按标准评分 |
| `review` | `jev_context_review`、`jev_review_report` + 技能 `jev-context-review` | 只读分析：当前会话里哪些工具输出已过期、能回收多少 token |
| `provider` | `jev_provider_status` | 只记录「让压缩后端工作」的意图，真正挂载由装配层决定 |

`jev_evaluate` 是核心：对同一段 `state` 一次问最多 64 个问题，三种题型——

- **choice**：2–255 个候选里选一个，返回选中项 + 概率分布 + 置信度；
- **score**：2–10 个等级上打分，返回加权分值 + 等级说明 + 概率；
- **noul**：是/否概率。**接近 0.5 表示不确定**，不是「中等水平」。

它只回答、不动手：不装插件、不授予权限、不调用子 Agent、不执行任何推荐动作。

### 2. 压缩后端

DSH 自带的压缩是**让模型把一段历史改写成散文摘要**（有损）。这个插件换成：

    历史区间 ──▶ 每个工具调用问两个 noul 问题 ──▶ 只删 Jev 确信过期的 ──▶ 其余逐字保留
                （「这次调用还要吗」「它的完整输出还要逐字保留吗」）   └─ 任何不确定 ─▶ 交回 DSH 原生摘要

它只覆盖 `@deepseek-ai/dsh-compaction-basic` 文档里唯一允许覆盖的那个钩子 `summarize(input, agent, signal)`；触发时机、保留策略、日志事务和 surface 替换全部沿用原版。

**永远保留**：用户与 assistant 的正文逐字进入 checkpoint，不改写不浓缩；带图片或文件的结果永不删除（重跑工具复现不出那些字节），而且这类调用不会再发给 Jev——不为注定丢弃的答案付费。

默认 `adopt: false`（shadow）：整条管线照跑、决策与节省量写日志，但 DSH 提交的仍是它自己的摘要。所以打开它行为与原来完全一致，只是多一份日志；看够了再改 `adopt: true`。

## 二、装到 DSH

需要 DSH（0.1.5 / 0.2 均可）和一把 TypeSafe key。

### 1. 配 key

| 放哪 | 怎么放 | 谁读得到 |
|---|---|---|
| **启动环境变量**（优先级最高） | `setx TYPESAFE_API_KEY "apikey_…"`（Windows）或 `export TYPESAFE_API_KEY=…`，然后重启 DSH | 工具 **和** 压缩后端 |
| **凭据文件** | `~/.dsh/.credentials.yaml` 的 `refs:` 下加一行 `TYPESAFE_API_KEY: apikey_…`（文件被监听，自动热加载） | 只有工具 |

压缩后端跑在隔离的 compaction realm 里，拿不到凭据接缝，**只认启动环境变量**。想省事就两处都放。

### 2. 装插件

**桌面 app**：侧栏「插件」→ 安装外部组合包 → 选本目录。app 不允许 CLI 操作 desktop profile，所以这一步只能在界面里点。

**npm CLI**：

    node tools/install.mjs --profile web      # 备份 → 安装 → 桥接依赖 → 核对绑定
    # 或直接： dsh plugin --profile web add <本目录>

### 3. 开功能

    node tools/features.mjs enable decision
    node tools/features.mjs enable review

也可以不改文件，在会话里让模型调 `jev_features { action: "enable", feature: "decision" }`。开关状态存在 `~/.dsh/jev-manager/features.json`，**不写你的 profile 配置**；关掉 = 真的注销对应工具与技能。

### 4. 挂压缩后端（可选）

压缩后端是**预设里的一行**，组合包够不到它，所以要新增一个并排的预设：

    node tools/make-preset-patch.mjs --profile web    # 生成 jev-preset.patch.yml

- **CLI**：`dsh --profile <p> --patch ./jev-preset.patch.yml`
- **桌面 app**（不给传 `--patch`）：把 `jev-preset.patch.yml` 的内容并进 `~/.dsh/profiles/desktop/cordis.patch.yml`，然后重启 DSH
- **DSH 0.1.5**（目录式 preset）：改用 `node tools/install-preset.mjs`

重启后新开会话，在预设列表里选 **`jev`**。官方四个预设一行都不改；不选它，行为与装之前完全一致。确认后端真的挂上了：

    node tools/mount-report.mjs      # 绑到哪份基类、schemastery、realm 能不能拿到凭据

## 三、怎么用

**工具**：会话里正常说话即可（技能会触发），或直接点名 `jev_evaluate`。检查 key 用 `jev_status`（只读本地，不联网）；验证连通用 `jev_check_connection`（发一次真实请求，会产生少量用量）。

**压缩后端**：按上面的步骤挂上、选预设后，`/compact` 与自动压缩就会走 Jev。先按默认的 shadow 跑一段时间，确认日志里的判断合理，再把预设里那行改成 `adopt: true`：

    - id: jev-compaction
      name: 'dsh-jev-manager/compaction'
      config:
        adopt: false      # 改成 true 才真的替换摘要

## 四、配置项

写在预设那一行的 `config:` 下。

| 键 | 默认 | 含义 |
|---|---|---|
| `adopt` | `false` | `false` = shadow（只记录）；`true` = 真的用 Jev 的 checkpoint |
| `keepThreshold` | `0.4` | 调用/输出存活所需的最低概率 |
| `preserveRecentMessages` | `6` | 最近多少条不碰；区间首条永远保留 |
| `maxStateTokens` | `25000` | 送给 Jev 的 state 估算上限 |
| `maxRequestTokens` | `30000` | state + 一批问题的单次上限 |
| `truncateHeadChars` | `300` | 被删输出保留的头部字符数，`0` = 只留提示 |
| `minReductionRatio` | `0.15` | 压不到这个比例就不值得改写历史 |
| `minTokensSaved` | `500` | 以及绝对节省量下限 |
| `jevTimeoutMs` | `5000` | 单次 Jev 请求时限（实现里下限 20000ms，调小于它无效） |
| `jevModel` | `jev-latest` | TypeSafe 模型名或别名 |

`keepThreshold` 故意不用上游的 0.5：Jev 的概率刻度里 0.5 表示「不确定」而不是「中等有用」，而这里的语义是「低于阈值就删」，所以取低阈值 = 不确信就保留。保留只会多花 token，删错无法挽回。

## 五、什么时候回退给 DSH 原生压缩

任何一个条件成立，这次压缩就交回 DSH 自己的摘要，行为与没装插件完全一致，Agent 不会察觉：

| 原因 | 触发条件 |
|---|---|
| `shadow_mode` | `adopt: false`（默认） |
| `feature_off` | `provider` 开关关着 |
| `empty_span` | 这段区间没有可处理的消息 |
| `pairing_risk` | 孤儿结果、重复结果、结果早于调用 |
| `no_candidates` | 所有调用都被 pin 或受保护 |
| `no_key` | 找不到 `TYPESAFE_API_KEY` |
| `jev_timeout` / `jev_busy` / `jev_error` | Jev 超时 / 429·529 / 返回结构不合法 |
| `low_reduction` / `not_smaller` | 没达到上面两个收益门槛 |
| `cancelled` | 压缩被取消 |
| `internal_error` | 插件自身异常 |

崩溃、超时、坏响应一律降级成「没整理」，永远不降级成「会话坏了」。

## 六、成本

1. **Jev 调用**：按输入 token 计费（Jev 1.13 为 $42 / 十亿输入 token，输出免费）。`state` 每次重发，所以随历史长度增长；`maxStateTokens` / `maxRequestTokens` 是刹车，`minReductionRatio` + `minTokensSaved` 保证「省得不够就不折腾」。
2. **Prompt cache 反噬**：替换较早的历史会让 provider 的 KV cache 从第一个被改动的 token 起失效。少传 context 省下的钱，可能被 cache 重写吃掉。

## 七、明确不做的事

不每轮主动 pruning · 不在每个 tool result 上单独调 Jev · 不后台周期整理 · 不接管主 Agent、不改 agent loop、不做自动路由 · 不注册 LLM 适配器、不拦截或路由任何请求 · 不返回文字推理 · 不改长期 session 文件（原始事件仍在日志里，回放仍能还原真相）。

## 开发

    node --test                      # 全部用例，0 API 用量（网络层是桩）
    node tools/features.mjs          # 看开关状态（可用 DSH_HOME 隔离）
    node tools/mount-report.mjs      # 压缩后端实际绑了哪份基类
    node tools/guard.mjs compare     # 卸载后核对配置层是否逐字节回到安装前

依赖桥接的版本错位、`--remove` 的归属判据、卸载/还原语义、以及已真机验证过什么，见 [MAINTAINERS.md](MAINTAINERS.md)。

## 来源与授权

- 压缩核心（`lib/vendor/`、`lib/adapter.js`）源自 [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)（MIT）与 [LXBWOW/dsh-context-curator](https://github.com/LXBWOW/dsh-context-curator)（MIT），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- Jev 接口按 [TypeSafe AI 官方 API 文档](https://docs.typesafe.ai/api)实现，固定发往 `https://api.typesafe.ai/v1/systemone`。
- 本项目独立维护，与 DeepSeek、TypeSafe AI 无隶属关系，也未获其背书。

**MIT** — 见 [LICENSE](LICENSE)。
