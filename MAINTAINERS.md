# MAINTAINERS.md

面向维护者的工程细节。用户向的说明在 [README.md](README.md)。

## 两个平面，两次安装

| 平面 | 内容 | 挂载方式 |
|---|---|---|
| host | `jev_features` 常驻；`decision` 加 3 个工具 + 技能，`review` 加 2 个工具 + 技能 | profile bundle（`dsh plugin add`，或桌面 app 的「安装外部组合包」） |
| preset | `ctx.compaction` 提供方 | 新增一个预设（`jev-preset.patch.yml`），由 `tools/make-preset-patch.mjs` 生成 |

**压缩提供方没法用 bundle 装。** 它要替换的那一行嵌在预设行的 `config.plugins` 里，而 patch 只有「按 id 覆盖」和「`- insert:` 新增」两种动作。三条近路都被 loader 堵死（0.2.0 实测）：

| 试过的写法 | loader 的反应 | 结论 |
|---|---|---|
| 覆盖 `- id: compaction-basic` 并换 `name` | `name mismatch for "compaction-basic", skipping` | 覆盖已有 id 时不能改 name |
| 覆盖父组 `- id: compaction` | `entry "compaction" not found` | 组嵌在预设行的 `config.plugins` 里，顶层 patch 够不到 |
| overlay 里直接写 `- id: preset-jev` | `entry "preset-jev" not found` | 顶层 `- id:` 是覆盖；新增必须包在 `- insert:` 里 |

正解是生成一个并排预设：读 harness 自己的 `--dump-default-config`，照抄 `preset-standard` 的成员列表、只换压缩组成员。官方预设一行都不改，选回标准模式就是原样。

`dsh` 对 `--profile desktop` 一律拒绝（`profile "desktop" is managed exclusively by the Electron application`），连只读的 `--dump-*` 也一样。预设行由 harness 决定、与 profile 无关，所以生成脚本 `--profile desktop` 时会自动改用 `web` 取同一份 runtime 的底稿，并把实际用的 profile 打进产物注释。

## 桌面端的 harness 版本错位

app 跑的 harness 在 `resources/app.asar` 里。普通 Node 进程读不了 asar，但 Electron 注册过 asar 支持，所以从 `process.resourcesPath` 拼出来的路径**能 import**。绕过它的话，插件装在 `$DSH_HOME/profiles/<p>/node_modules/…`，bare `@deepseek-ai/*` 会一路上溯到 `$DSH_HOME/profiles/node_modules`——所有 profile 共享的目录，谁最后装过东西就是谁的版本。`extends BasicCompactionEngine` 走 bare import 时继承到的可能是旧那份，harness 不认它是压缩引擎，接缝静默绑错。

应对：

- **host 平面零 harness import**（连 `schemastery` 都不用，配置是纯 JS 的 `TUNING_FIELDS` 表）。
- **provider 在运行时解析基类**（`lib/compaction.js` → `lib/harness.mjs`）：按 `process.resourcesPath` 的 asar → 宿主 `profileContext` 的 install anchor → 自身位置依次尝试，第一个拿到类的算数；全部失败**不挂载并写日志**，DSH 继续用自己的摘要，而不是绑一个错的类。
- 挂载时把基类来源写进 `mount.json`，`tools/mount-report.mjs` 读它（桌面 app 没有控制台）。

`tools/link-deps.mjs` 是「asar 锚点也拿不到类」时的兜底：把 app 自带的那三个包 junction 到 `$DSH_HOME/profiles/node_modules`。`install.mjs` 会自动跑（`--no-deps` 可跳过）。

注意这个兜底**没法自动发现桌面 app 自带的 runtime**：那些包在 `resources/app.asar` 里，普通 Node 连 stat 都做不到（只有 Electron 能读），而同目录的 `app.asar.unpacked` 只放原生包、不含 harness。所以桌面-only 的机器要用这条路，必须显式给 `DSH_RUNTIME_ROOT=<解包后的 harness 目录>`（或装上 npm CLI）；provider 本身不需要它，它优先走 `process.resourcesPath`。工具因此**不再**猜测打包 app 的安装路径——猜错只会打印一个永远不会命中的根。

## `--remove` 的归属判据

`$DSH_HOME/profiles/node_modules` 是每个 profile 共用的祖先目录，**harness 自己也会往里放 junction**，其中三个恰好就叫 `dsh-session` / `schemastery` / `dsh-compaction-basic`。所以判据既不是「它是不是链接」，也不是「它指向哪」——`DSH_RUNTIME_ROOT` 没设时（`uninstall.mjs` 调它时就是这样）`locate()` 退到 npm 全局那份，而那三个 junction 指的正是同一份，**比目标会把它们全删掉**（已复现）。

判据是**作者身份**（`tools/link-ownership.mjs` + 本插件自己的账本 `$DSH_HOME/jev-manager/links.json`）：

- checkout 自己的 `node_modules` 归我们（只有这个工具往里写）；
- 共享目录里的链接要能在账本里查到，且现在仍指向当初记录的目标（被改指过 = 别人的选择，不动）；
- 失效链接若指向 app 的 `app.asar` 里，那是本插件的桌面桥接（普通 Node stat 不到那个路径，harness 也不会把 junction 建进归档）；
- 其余一律打印一行、原样留下；`--force` 才是删除别人链接的开关。

账本随其余自有状态一起被 `uninstall.mjs` 删掉。`guard.mjs` 看不见这个目录，这条判据是唯一的护栏。

## 卸载与还原语义

- `install.mjs` 动手前备份会被改写的文件；**备份只认第一次**（第二次安装看到的已是我们改过的字节，照抄会把「还原」钉在已安装态），所以已有的原始字节永不覆盖，只补记没见过的路径；安装会**新建**的文件记成 `{absent:true}`，还原时删除。
- `dsh plugin remove` 失败、还原报缺项、junction 清理抛错 → `uninstall.mjs` 退出码 1，并**保留** `~/.dsh/jev-manager`（原始字节备份在里面），因为重跑同一条命令是收敛手段。全部成功后才收掉自有状态。
- **`--adopt` 记不到「安装前不存在」的文件**：这条路只把当下字节记成原始态，没有 `absent` 记录，所以 app 安装时新建的文件（例如 profile 里原本没有的 `pnpm-lock.yaml`）卸载时会被还原成残留而不是删掉。用 `--adopt` 的桌面端不要指望 `guard compare` 报零差异。
- `guard.mjs` 的盲区：`profiles/node_modules` 被整目录跳过；目录指纹只记一层名字（不记链接目标），所以「重指链接」它看不出来。

## 开关为什么存在插件自己的文件里

`dsh-plugin-manager` 的官方开关会往 profile 的 `cordis.patch.yml` 追加/翻转 `disabled` 行，而 `dsh plugin remove` 只还原两个快照。用 `disabled` 关我们的 provider 更危险：那个组里就一个压缩后端都没有了，`/compact` 会坏。所以插件常驻挂载，用 `~/.dsh/jev-manager/features.json` 决定动作与否，关闭时逐字透传官方摘要。

桌面 profile 没开 `patchReload`，所以热开关只能靠运行时注册/注销，不能靠改配置行。

## 两个 JS 坑

**一、`ctx.compaction` 是 cordis 的 Proxy，而访问器把 Proxy 自己当接收者。** 一个真把 `this.#secret` 读出来的方法经它调用会抛 `Cannot read private member #secret from an object whose class did not declare it`——回退路径自己崩掉，压缩就真失败了。**换调用写法救不了它**：`Object.getPrototypeOf(…).summarize.call(this, …)` 与 `super.summarize(…)` 传的是同一个接收者，`.call(this)` 一样抛。真正管用的是钩子路径上（本类与 `dsh-compaction-basic`）一个私有成员都不留，诊断写成普通方法。

**二、`import.meta.resolve(specifier, parentURL)` 会收第二个参数，但 Node 直接忽略它**，永远按「当前模块文件的位置」解析。在它上面搭「从别处解析」的逻辑会得到：代码看着按锚点顺序试、日志自信地打印锚点路径、实际一直落在 `lib/` 上方那份副本上。要指定位置解析，用 `createRequire(baseFileOrDir).resolve(spec)` 再转 URL 去 `import()`。`test/resolution.test.mjs` 钉这条。

## 凭据为什么不能写进 `inject`

压缩行跑在 `isolate: { compaction: true }` 的 realm 里。写进 `inject` 就等于要求 cordis 必须解析到它，**解析不到是整行挂载失败**，比拿不到 key 严重得多。所以照搬官方 `dsh-llm-deepseek-api-key` 那条梯子：`ctx.get('credentials')` → `ctx.get('launchEnvironment')` → `process.env`。

实测确认了这个 realm 确实拿不到凭据接缝（`mount.json` 的 `credentials_seam: false`，且可复现：平铺挂载时 `resolveApiKey()` 能拿到存储里的值，放进 `isolate('compaction')` 后同一个 ctx 就 `undefined`）。所以**只把 key 写进凭据文件时，工具可用、provider 会一直 `no_key` 回退**。

## 开发与验证

    node --test                                 # 全部用例，网络层是桩，0 API 用量
    node tools/guard.mjs snapshot|compare       # 配置层基线
    node tools/make-preset-patch.mjs --profile web --check
    node tools/link-deps.mjs --check [--shared]
    node tools/mount-report.mjs

测试跑在真实 cordis Context + 真实 DSH 包上，只有网络那一层是桩。两个 runtime 都要跑，因为 harness 副本可能不同版本：

| runtime | 结果 |
|---|---|
| dsh 0.1.5-rc.2 / cordis 4.0.2（npm 全局） | 50 通过 / 0 失败 |
| dsh 0.2.0-rc.2 / cordis 4.0.4（桌面 app 自带，解包后跑） | 49 通过 / 0 失败 / 1 跳过（目录式 preset 专属用例） |

验 0.2 那份又不想动 checkout 的 junction：把插件目录**复制**一份，在副本里给 `node_modules/@deepseek-ai/{schemastery,dsh-compaction-basic,dsh-session}` 建三个指向解包目录的 junction，然后 `DSH_RUNTIME_ROOT=<解包目录>/dsh/node_modules/@deepseek-ai/dsh node --test` 跑在副本里。`compaction.test.mjs` 的「双副本」自检就是靠这两处指向同一份通过的。

### 真机（真实 TypeSafe 端点）验证记录

5 次真实请求、3522 输入 token ≈ **$0.000148**（Jev 1.13：$42 / 十亿输入 token，输出免费）：

| 验证 | 结果 |
|---|---|
| 接口与解析（一次请求含 noul + choice + score） | `model=jev-1.13.0`，三种回包全部通过 `parseAnswer`（choice 概率精确和为 1；score 1.27 落在等级之间、legend 完整） |
| review 平面 | 真实答案驱动 2 条删除决策，门槛判定正确 |
| provider shadow | `shadow_mode`，reduction 0.7407 / 节省 806 token，返回 DSH 摘要 |
| provider adopt | 无回退；返回 `provider=typesafe`、`model=jev-1.13.0`、`curator` 用量；`llmStreamCall` 与 `usage` 均不存在（符合契约） |
| 受保护调用 | 图片调用既未被提问、也未进候选（`candidates=1 protected=1`），且不删除 |
| 门槛 | 结果短于截断阈值时报 `low_reduction` 回退，不假装省了钱 |

**尚未真机验证**：真实会话里的 `/compact` 全链路（`compactNow` / `compactIfNeeded` 触发 + 会话日志写入）、多批次（长历史拆多个请求）、429/529 重试（未触发过限流）、`adopt: true` 的实际使用效果。

## 与参考插件的关系

对照 `dsh-plugin@1.4.9`、`dsh-whale-widget@0.3.16`（桌面 profile 里实跑）与 `jev-dsh-decision`：本插件 `dependencies` 为空、harness 只写 `peerDependencies`、host 平面静态 import harness 0 条、零构建产物、无客户端 UI。有意不同的是：**「关掉后是否真回到原样」是可检验的**（`guard.mjs` 基线比对 + `uninstall.mjs` 还原），代价是它必须子类化压缩引擎，所以 `link-deps.mjs` 是桌面安装的必需环节而不是测试便利。
