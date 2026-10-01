---
name: jev-context-review
description: Use jev_context_review before a session gets long, to see which tool outputs Jev considers stale and how many tokens compaction would reclaim. Read-only — it never rewrites history. Use when the user asks about context size, compaction, or what can safely be dropped.
---

# Jev 上下文整理

判断「哪些历史已经过期」，产出可核对的报告。**不改写会话**：不替换 surface 区间，不产生 compaction 事件，原始事件仍完整留在日志里。

## 什么时候用

- 用户问「上下文太大了 / 能省多少 / 什么可以丢」
- 在按 `/compact` 之前先预估代价
- 想知道某次工具输出是不是已经没用了

## 怎么读结果

`jev_context_review` 对区间里每个工具调用问两个 `noul`：这个调用本身还需要留在历史里吗、它的完整输出还需要逐字保留吗。低于 `keepThreshold`（默认 **0.4**）才处理，所以默认取向是**不确信就保留**。

三档动作：

- `keep` — 调用和输出都留着，原样
- `drop_result` — 调用和入参留着，输出换成头部若干字符加一条说明
- `drop_call` — 调用和输出一起走

报告里的 `可回收 token` 是**估算**，用来排序，不是账单。`是否达到压缩门槛` 说明这次改动值不值得动手——省得不够就不该改写历史。

## 两条必看的安全线

**带图片或文件的工具结果永不删除**，不管 Jev 多有把握——重跑工具复现不出它们。报告里它们计入 `受保护`。

**区间第一条消息和最近 N 条消息（默认 6）不参与判断**。第一条是续接锚点，最近的是当前工作现场。

## 复查历史判断

`jev_review_report { limit }` 读本插件自己的 `~/.dsh/jev-manager/review.jsonl`（最近优先），给出每次的候选数、删除计数、可回收 token、Jev 请求与 token 用量、以及回退原因分布。只读本地文件，不联网、不重新判断。

## 回退情况

没有密钥、surface 为空、调用与结果配对关系不像一对、没有候选、Jev 超时或返回畸形概率——这些都只返回一句原因，不会给出半份判断，也不会改任何东西。

要真的压缩：`/compact`（走 DSH 自己的摘要），或者把本插件的 provider 行挂进会话，让 Jev 直接产出检查点文本。
