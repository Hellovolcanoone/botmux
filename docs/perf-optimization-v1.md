# Botmux 性能优化设计（v1）

## 基线信息

**源码仓库**：`github.com/deepcoldy/botmux`  
**当前 commit**：`98a67af` (origin/master, 2026-05-29)  
**已安装版本**：2.45.0 (tag `v2.45.0`)  
**npm latest**：2.46.1 (tag `v2.46.1`)  
**关系**：origin/master 在 v2.46.1 之后，包含最新修复

## 优化目标

收敛到 2 个低风险、可验证的小改动，明天交付：

1. **sessionId 二级索引** — 解决 `findActiveBySessionId` 线性扫描 O(n)
2. **screen_update 内容去重** — 避免重复构建 `buildStreamingCard`

## 瓶颈分析

### 1. findActiveBySessionId 线性扫描

**位置**：`src/core/worker-pool.ts:82-86`

```typescript
export function findActiveBySessionId(sessionId: string): DaemonSession | undefined {
  if (!activeSessionsRegistry) return undefined;
  for (const s of activeSessionsRegistry.values()) 
    if (s.session.sessionId === sessionId) return s;
  return undefined;
}
```

**问题**：
- `activeSessionsRegistry` 的 key 是 `sessionKey(rootId, larkAppId)` 复合键
- `findActiveBySessionId` 按 `sessionId` 查找，必须线性扫描
- 每次 IPC 调用（如 `/adopt`、`/relay`、dashboard SSE）都会触发
- 如果有 100 个会话，每次查找遍历 100 次

**调用点**：
- `src/core/dashboard-ipc-server.ts` — dashboard API
- `src/im/lark/card-handler.ts` — 卡片按钮处理
- `src/daemon.ts` — 消息路由

### 2. screen_update 重复构建卡片

**位置**：`src/core/worker-pool.ts:1432-1520` (screen_update handler)

**现状**：
- Worker 每 2 秒发送一次 `screen_update`（`SCREEN_UPDATE_INTERVAL_MS = 2000`）
- Worker 端有 `changed` 检测（hash 比较），只有内容/状态变化时才发送
- Daemon 端每次收到 `screen_update` 都会：
  1. 更新 `ds.lastScreenContent` 和 `lastScreenStatus`
  2. 如果状态变化，发布 dashboard 事件
  3. 调用 `buildStreamingCard` 重建完整 JSON
  4. 调用 `scheduleCardPatch` 发送 PATCH

**问题**：
- `buildStreamingCard` 每次都重建完整卡片 JSON（包括 i18n、URL、按钮）
- 即使 `msg.content` 和 `msg.status` 与上次相同，仍会重建
- 高频场景（多个 CLI 同时工作）会导致 CPU 和内存开销

**scheduleCardPatch 队列**：
- 已有 `cardPatchInFlight` 防止并发 PATCH
- `pendingCardJson` 只保留最新（latest wins）
- 但没有内容去重，相同 JSON 仍会触发 `updateMessage`

## 优化方案

### 优化 1：sessionId 二级索引

**改动**：维护 `sessionId → Map key` 的二级索引

**文件**：`src/core/worker-pool.ts`

```typescript
// 新增：sessionId → sessionKey 的二级索引
let sessionIdIndex: Map<string, string> | undefined;

export function setActiveSessionsRegistry(m: Map<string, DaemonSession>): void {
  activeSessionsRegistry = m;
  sessionIdIndex = new Map();
  // 初始化索引
  for (const [key, ds] of m) {
    sessionIdIndex.set(ds.session.sessionId, key);
  }
}

export function findActiveBySessionId(sessionId: string): DaemonSession | undefined {
  if (!activeSessionsRegistry || !sessionIdIndex) return undefined;
  const key = sessionIdIndex.get(sessionId);
  if (!key) return undefined;
  return activeSessionsRegistry.get(key);
}

// 新增：注册 session 时更新索引
export function indexSession(key: string, sessionId: string): void {
  if (!sessionIdIndex) return;
  sessionIdIndex.set(sessionId, key);
}

// 新增：删除 session 时清理索引
export function unindexSession(sessionId: string): void {
  if (!sessionIdIndex) return;
  sessionIdIndex.delete(sessionId);
}
```

**调用点更新**：
- `src/daemon.ts` — `activeSessions.set()` 后调用 `indexSession`
- `src/daemon.ts` — `activeSessions.delete()` 后调用 `unindexSession`

**收益**：
- 查找复杂度 O(n) → O(1)
- 内存开销：每个 session 多存一个 sessionId 字符串（约 50 bytes × 100 = 5KB）

**风险**：
- 低风险：索引与主 Map 同步，不会出现不一致
- 如果索引更新失败，`findActiveBySessionId` 返回 undefined，与现有行为一致

### 优化 2：screen_update 内容去重

**改动**：在 daemon 端检测 `msg.content` 是否变化，避免重复构建卡片

**文件**：`src/core/worker-pool.ts`

```typescript
case 'screen_update': {
  if (!ds.workerPort) break;
  const prevStatus = ds.lastScreenStatus;
  updateUsageLimitState(ds, msg.usageLimit);
  
  // 新增：内容去重
  const contentChanged = msg.content !== ds.lastScreenContent;
  const statusChanged = prevStatus !== ((msg.usageLimit ?? ds.usageLimit) ? 'limited' : msg.status);
  
  ds.lastScreenContent = msg.content;
  ds.lastScreenStatus = (msg.usageLimit ?? ds.usageLimit) ? 'limited' : msg.status;

  // Dashboard: publish a patch only when status truly transitioned
  if (statusChanged) {
    dashboardEventBus.publish({
      type: 'session.update',
      body: {
        sessionId: ds.session.sessionId,
        patch: {
          status: ds.lastScreenStatus,
          lastMessageAt: ds.lastMessageAt,
        },
      },
    });
  }

  if (streamingCardDisabled(ds)) break;

  // 新增：如果内容和状态都没变，跳过卡片构建
  if (!contentChanged && !statusChanged) break;

  const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
  const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
  const mode: DisplayMode = ds.displayMode ?? 'hidden';

  // ... 后续逻辑不变
}
```

**收益**：
- 减少 `buildStreamingCard` 调用次数（预计 50-80%）
- 减少 `scheduleCardPatch` 调用次数
- 降低 CPU 和内存开销

**风险**：
- 低风险：只跳过完全相同的更新，不影响功能
- Worker 端已有 `changed` 检测，daemon 端再加一层是双重保险

## 基线采集与验证

### 基线指标

在优化前，采集以下指标（10 分钟样本）：

```bash
# 1. screen_update 频率
botmux logs | grep -c "screen_update"

# 2. card PATCH 次数
botmux logs | grep -c "Failed to update streaming card\|Stream card withdrawn"

# 3. findActiveBySessionId 调用次数（需加日志）
grep -n "findActiveBySessionId" src/core/dashboard-ipc-server.ts src/im/lark/card-handler.ts src/daemon.ts

# 4. 事件循环延迟（需加 performance.now()）
node --trace-event-categories=v8.compile src/index-daemon.ts
```

### 验证命令

优化后，对比以下指标：

```bash
# 1. 构建并重启
pnpm build && pnpm daemon:restart

# 2. 运行测试套件
pnpm test

# 3. 压测：同时开启 10 个 CLI 会话，观察日志
for i in {1..10}; do
  botmux send --bot test$i "echo hello"
done

# 4. 对比 screen_update 和 PATCH 次数
botmux logs | grep -c "screen_update"
botmux logs | grep -c "Failed to update streaming card"
```

### 预期收益

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| findActiveBySessionId 复杂度 | O(n) | O(1) | 100x (n=100) |
| buildStreamingCard 调用次数 | 每次 screen_update | 仅内容/状态变化时 | 减少 50-80% |
| card PATCH 次数 | 每次 screen_update | 仅内容/状态变化时 | 减少 50-80% |

## 改动文件范围

1. `src/core/worker-pool.ts` — 新增 sessionId 索引、screen_update 去重
2. `src/daemon.ts` — 调用 `indexSession` / `unindexSession`
3. `test/worker-pool.test.ts` — 新增索引测试用例

## 回归测试范围

1. **功能测试**：
   - 开启 CLI 会话，发送消息，验证卡片更新
   - 多 bot 场景，验证消息路由正确
   - `/adopt`、`/relay` 命令，验证 session 查找正确

2. **性能测试**：
   - 同时开启 10+ 个 CLI 会话，观察日志和 CPU 使用
   - 长时间运行（1 小时），观察内存泄漏

3. **边界测试**：
   - session 创建/删除，验证索引同步
   - screen_update 内容不变，验证跳过逻辑
   - screen_update 状态变化，验证卡片更新

## 实施计划

1. **Day 1**：实现 + 本地测试
   - 上午：实现 sessionId 索引
   - 下午：实现 screen_update 去重
   - 晚上：本地测试 + 修复 bug

2. **Day 2**：验证 + 提交
   - 上午：压测 + 对比指标
   - 下午：写 commit message + 提交 PR
   - 晚上：review 反馈 + 修复

## 后续优化（不在本轮范围）

- 异步 I/O：session-store、message-queue 的 sync 操作改为 async
- 卡片增量更新：只 patch 变化的部分，不重建完整 JSON
- Worker thread：卡片渲染移到 worker thread
- 分离关注点：daemon 拆分为事件分发、会话管理、卡片渲染
