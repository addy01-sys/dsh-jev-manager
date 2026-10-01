---
name: jev-decision
description: Use Jev to choose among the tools, skills, or agents that are actually available and permitted right now, or to score an output against an explicit rubric. Use when the user asks for Jev or when a bounded decision would help; not for open-ended writing or research.
---

# Jev 决策

Jev 返回结构化判断，不返回文字推理。规划、参数构造、执行、子 Agent 协作仍然由当前 Agent 负责。

## 调用

`jev_status` 查本地是否已配密钥（不联网，`configured: true` 不等于远端已验证）；`jev_check_connection` 发一个最小请求真实验证，会产生少量用量；`jev_evaluate` 是唯一干决策的。缺 key 时引导用户去 DSH 凭据里配 `TYPESAFE_API_KEY`，不要在对话中索要密钥。

## 先准备候选

从宿主或当前可见的工具/技能目录**实际发现**候选，尊重用户已明确选定的项。只放入当前真实可用、且已获准使用的候选，附稳定 ID、简短描述与相关约束。Jev 不会自己发现工具、安装插件、授予权限或调用另一个 Agent——候选集是否如实完全取决于你。

`state` 放任务与最小相关上下文，不要放密钥、整段对话记录或完整文件。问题 ID 只用于对应结果，不是给模型的指令。

## 三种原语

- `choice`：从 2–255 个候选中选一个；必要时补一个 `other` / `none` 候选。
- `score`：对 2–10 个有序等级评分，**从 0 索引**。多个独立 `score` 可以用来给候选排序。
- `noul`：估计一个明确是非条件为真的概率。**要同时选多个互补的技能，就为每个候选发一个独立 `noul`，不要塞进一个 `choice`。** 接近 0.5 表示不确定，不是中等水平。

共享同一 `state` 的独立问题合并成一次请求（上限 64 题、256 KiB）；依赖前一个结果的问题放到下一次请求。

```json
{
  "state": { "task": "整理已收集的竞品资料，制作汇报 PPT", "available": ["research", "slides"] },
  "questions": {
    "use_research": { "type": "noul", "instructions": "这项任务是否需要分析竞品资料？" },
    "use_slides": { "type": "noul", "instructions": "这项任务是否需要制作演示文稿？" }
  }
}
```

## 用结果

汇报时保留返回的概率、置信度、model 与 usage。你的解释和 Jev 的结构化输出要分开表述，不要把前者说成后者。执行前重新确认候选仍然可用，读取被选中的 Skill 正文，用宿主的 schema 构造工具参数。

阈值和权重来自用户的任务或应用策略，不存在通用魔法数字。置信度低、候选缺失、或接口失败时，回到正常的 Agent 推理或向用户澄清，并说明 Jev 当时不可用——不要编造它的结果。推荐不构成执行授权，不覆盖用户的选择，也不绕过审批。

## 本插件的压缩部分

同一个 key 还驱动会话压缩：`ctx.compaction` 的提供方在 agent preset 内，逐条判断历史里的工具调用是否仍需要，只删 Jev 确信过期的部分，其余内容逐字保留；任何不确定都交回 DSH 原生摘要。它默认 `adopt: false`（shadow：只记录判断、仍采用 DSH 的摘要）。这部分由 preset 装配，不经过这里的工具，也不需要你主动调用。

参考：https://docs.typesafe.ai/api
