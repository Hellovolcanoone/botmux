# 主动开工 Review

分支：`feat/proactive-auto-start`（worktree）。高强度多 agent code review（7 finder 角度 × 验证）后，对发现的问题分类处理如下。

## 🔴 已修复（真 bug）

| # | 问题 | 修复 |
|---|---|---|
| R1 | **场景① 在话题群里坏掉**：`handleBotAdded` 原来硬编码 chat-scope、`createSession(chatId, chatId,…)` 把 `rootMessageId` 设成 `oc_` 群 id；话题群里 `sessionReply` 会 `replyMessage(oc_…)`，被飞书拒绝 → 入群后首条输出/repo 卡发不出去。话题群是本 bot 主力场景，必须修。 | `handleBotAdded` 改为 **mode-aware**：`getChatMode` 判定；话题群 → 先发一条种子消息开新话题、anchor 到该 message_id 走 thread-scope；普通群 → 仍 chat-scope。 |
| R2 | **去重用进程级 Set + TOCTOU**：原 `autoStartedJoinChats` 进程常驻，导致 `/close` 后再拉群无法重新触发；且标记在 `await` 之后，两个并发 added 事件可双双 spawn。 | 改为 **in-flight 锁**（`autoStartJoinInFlight`，进入即同步占位、`finally` 释放）；存活去重交给 `activeSessions`。修掉 TOCTOU，且 `/close` 后再拉群能重新开工。 |

## 🟡 已加固

| # | 问题 | 处理 |
|---|---|---|
| R3 | FR-12：`bot.added` 事件若没在飞书后台订阅，handler 根本不触发，运行时毫无信号。 | daemon 启动时若 `autoStartOnGroupJoin` 开启，打一条 INFO 日志提醒去订阅事件 + 开权限（运行时 + 启动双提示）。 |

## ⚪ 已评估，按设计保留 / 记录

- **场景② 不校验发起人**（任何群成员开新话题都触发，绕过 allowlist）：这是 D4「不限定范围」的用户明确决定，非 bug。但确实扩大了「谁能驱动 CLI」的范围——已在下方向 owner 复述确认。
- **card-prefs 里放路由开关 + prompt 字符串**：语义上略不贴，但属 spec 既定「复用 card-prefs 套路」，收益是零新增传输管线。保留。
- **`handleBotAdded` 与 `handleNewTopic` ~80 行 spawn 样板重复**：抽公共函数有收益，但会牵动经充分测试的 `handleNewTopic`，本次保持聚焦不动，记录为后续可重构项。
- **`listChatMemberOpenIds` 20 页（~2000 成员）上限**：超大群且 allowedUser 恰好排在 2000 之后会漏判，极低频，记录。
- **`resolvedAllowedUsers` 若启动解析失败仍是 email**：会导致场景①静默不触发；属既有基础设施行为，已有日志「群内无 allowedUser 成员」。

## 🔴 Codex 二轮 review 修复（合入前）

| # | 问题 | 修复 |
|---|---|---|
| P1a | **场景②在普通群被 `/t` 误放行**：`/t` override 会把普通群 chat-scope 翻成 thread+anchor=messageId，auto-topic 判定看 override 后的 routing 就会在普通群误开工（违反 FR-7）。 | 在 `/t` override **之前**捕获 `autoTopicSeedScope/Anchor`，auto-topic 只认 override 前的真实 routing。补回归测试（含「revert 即 fail」验证）。 |
| P1b | **话题群去重不完整**：话题群会话 keyed 在 seed message id，原 `activeSessions.has(chatId)` 抓不到串行重投 → 会再发一个 seed 再开一会话。 | 新增自愈映射 `groupJoinAnchorByChat`（`appId:chatId → dsKey`）：存活则去重、目标已 close 则视为 stale 放行（re-add 仍可重触发）；配合 in-flight 锁覆盖并发。 |
| P2 | **R1 mode 缓存边界**：`getChatMode` 读 5 分钟缓存，曾缓存为 group 的群转话题群后入群会走回 chat-scope，R1 复现。 | 入群判定改 `getChatMode(..., { forceRefresh: true })`。 |

Codex 复核 `listChatMemberOpenIds` 与 card-prefs 字符串字段无功能问题；bot.added `chat_id/operator_id`、群成员 `items[].member_id` 字段方向经官方文档核对正确。

## 测试

- 新增单测 30 个（`test/auto-start.test.ts` 13 + `test/card-prefs-auto-start.test.ts` 17 含纯策略 + 持久化往返）。
- 触达模块单测全绿：event-dispatcher 68 / dashboard-ipc 23 / bot-registry 35 / dashboard-i18n 2 / session-store 36。
- `tsc --noEmit`、`pnpm build`（含 dashboard 打包）均通过。
- 全量套件：17 文件 fail / 10 test fail，**全部为环境型/既有**（`bridge-final-output-retry` 既有、`write-input-all-cli` mira、15× `e2e-browser/feishu-*` 需真实浏览器/飞书），无一属本次改动模块。
