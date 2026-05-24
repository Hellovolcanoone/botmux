# allowedChatGroups Spec

## Overview

本功能为 botmux 增加 `allowedChatGroups` 配置字段，把一个或多个飞书群聊作为“成员授权源”。daemon 启动时用当前 bot 的 Lark App 视角拉取这些群聊的成员 open_id 并缓存；缓存命中的用户获得普通使用权限，可在群聊、话题或私聊入口向 bot 提问或继续会话。敏感操作权限不变，仍只由 `allowedUsers` 控制。

## User Stories

### Story 1: 通过群聊成员关系批量授予普通使用权限

- **Acceptance**: 当某 bot 配置了 `allowedChatGroups: ["oc_team"]`，且发送人是 `oc_team` 的成员时，即使发送人不在 `allowedUsers` 中，`canTalk` 也允许该用户向该 bot 提问或继续会话。
- **Technical implementation**: `src/bot-registry.ts` 扩展 `BotConfig` / `BotState`，daemon 启动阶段在 `src/daemon.ts` 解析授权群成员，`src/im/lark/event-dispatcher.ts` 的 `canTalk` 读取解析后的成员集合。

### Story 2: 群成员权限跟随用户身份而不是群聊入口

- **Acceptance**: 授权群成员在私聊、普通群、话题群等入口发起普通请求时，只要消息路由规则本身满足，权限判断都因群成员缓存命中而通过。
- **Technical implementation**: 授权判断只以 `senderOpenId` 是否在当前 bot 的已解析授权成员集合中为准，不把当前消息的 `chatId` 与 `allowedChatGroups` 做白名单匹配。

### Story 3: 敏感操作仍由 allowedUsers 管理

- **Acceptance**: 授权群成员不在 `allowedUsers` 中时，普通提问可通过；卡片敏感操作和 daemon 命令仍被 `canOperate` 拒绝。
- **Technical implementation**: `canOperate` 保持只读取 `resolvedAllowedUsers`；`src/im/lark/card-handler.ts` 与 daemon command gate 继续复用 `canOperate`。

### Story 4: 群成员授权是启动时快照

- **Acceptance**: daemon 启动时解析 `allowedChatGroups`；运行期间不启动定时刷新任务，不在每条消息到达时查询群成员。群成员变更需要重启 daemon 才影响权限判断。
- **Technical implementation**: 在 daemon per-bot 初始化阶段调用 Lark 群成员 API，写入当前进程内存状态；不新增 scheduler/interval。

### Story 5: 配置编辑与文档可发现

- **Acceptance**: README、`bots.json.example` 和 setup 编辑器都展示 `allowedChatGroups`，用户能通过手动编辑或 setup 编辑现有 bot 配置维护该字段。
- **Technical implementation**: 更新 `README.md`、`README.en.md`、`bots.json.example`、`src/setup/bot-config-editor.ts`、`src/cli.ts` 的配置展示/编辑路径，并补充对应测试。

## Functional Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| FR-1 | `BotConfig` MUST accept optional `allowedChatGroups: string[]` values from `bots.json`. | `test/bot-registry.test.ts` covers parsing and preserving `allowedChatGroups`. |
| FR-2 | `BotState` MUST store the resolved member open_ids for `allowedChatGroups` separately from `resolvedAllowedUsers`. | Unit test asserts group-derived members do not mutate `resolvedAllowedUsers`. |
| FR-3 | daemon startup MUST resolve each configured `allowedChatGroups` chat_id through the current bot's Lark client and cache member open_ids in memory. | Unit test or integration-style mock verifies startup resolution calls the client per configured chat and stores returned open_ids. |
| FR-4 | If resolving an allowed chat group fails, the daemon MUST log the failure, skip that group's members, and continue startup without granting access from that failed group. | Test with mocked failure verifies no throw and no group-derived allow entry. |
| FR-5 | `canTalk` MUST allow a sender when the sender is in `resolvedAllowedUsers` OR in the resolved `allowedChatGroups` member cache. | `test/event-dispatcher.test.ts` covers allowedUsers hit, allowedChatGroups hit, and miss. |
| FR-6 | `canTalk` MUST NOT treat `allowedChatGroups` as a chat whitelist; a cached member is allowed regardless of the current message chat_id. | Test calls `canTalk` with a different current `chatId` and a cached group member sender. |
| FR-7 | `canOperate` MUST continue to allow only empty `allowedUsers` or `senderOpenId` in `resolvedAllowedUsers`; it MUST NOT consult group-derived members. | Existing card/command permission tests plus new group-member negative case. |
| FR-8 | When `allowedChatGroups` is absent or empty, existing behavior MUST remain unchanged. | Regression tests for empty `allowedUsers`, restricted `allowedUsers`, oncall relaxed talk, and peer-bot allowance still pass. |
| FR-9 | The implementation MUST NOT add periodic refresh or per-message group-member API calls. | Code review check: no new interval/scheduler for this feature; tests exercise permission checks without API calls. |
| FR-10 | README, README.en, `bots.json.example`, setup editing, and config editor tests MUST document and support `allowedChatGroups`. | Documentation diff plus `test/bot-config-editor.test.ts` coverage. |

## Success Criteria

1. A bot configured with `allowedChatGroups` lets members of those groups use the bot normally without listing each member in `allowedUsers`.
2. Group-derived users can use the bot from any entry point supported by existing routing, including private chat, because the permission follows the user identity.
3. Group-derived users cannot perform sensitive operations unless they are also in `allowedUsers`.
4. Existing deployments without `allowedChatGroups` behave exactly as before.
5. Group membership is resolved once at daemon startup and remains an in-memory snapshot until daemon restart.
6. Users can discover and edit the new field through examples, README, and setup editing.

## Key Entities

- `BotConfig`: per-bot persisted config shape; lives in `src/bot-registry.ts`; gains optional `allowedChatGroups?: string[]`.
- `BotState`: runtime per-bot state; lives in `src/bot-registry.ts`; stores resolved group-member open_ids separately from `resolvedAllowedUsers`.
- `canTalk`: ordinary usage permission gate; lives in `src/im/lark/event-dispatcher.ts`; becomes user OR group-member based.
- `canOperate`: sensitive-operation permission gate; lives in `src/im/lark/event-dispatcher.ts`; remains user-only.
- Lark client group-member resolver: API wrapper in `src/im/lark/client.ts` that lists members for a chat_id using the current bot's app scope.
- setup config editor: configuration mutation path in `src/setup/bot-config-editor.ts` and `src/cli.ts`; gains edit/display support for `allowedChatGroups`.

## Assumptions

- The bot app has or can request the Lark permission needed to list group members for configured chat_ids.
- `allowedChatGroups` values are Lark `chat_id` strings such as `oc_xxx`.
- The configured bot is a member of each authorized group, or the Lark API otherwise allows the bot app to read that group's members.
- Startup-time snapshot semantics are acceptable: membership changes require daemon restart to take effect.
- `allowedUsers` empty continues to mean unrestricted operation, including sensitive operations, matching current behavior.

## Clarifications

- `allowedChatGroups` is a member authorization source, not a group/chat whitelist.
- Group-derived authorization grants ordinary usage only; it does not grant card button, daemon command, terminal write, restart, close, resume, or similar sensitive capabilities.
- Oncall semantics stay separate: `oncallChats` binds a chat to a working directory and can relax talking in that chat; `allowedChatGroups` authorizes users by membership.
- Resolution failures for a group are fail-closed for that group and do not block `allowedUsers` from working.

## Out of Scope

- Department, organization, role, or user-group authorization outside Lark chat membership.
- Runtime automatic refresh, webhook-driven refresh, or per-message member lookup.
- Changing `oncallChats` behavior or migrating existing oncall config into `allowedChatGroups`.
- Granting sensitive operation permission based on group membership.
- Building a dashboard UI for editing `allowedChatGroups` beyond existing setup/config editing paths.
