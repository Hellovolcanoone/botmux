/**
 * Per-anchor async serializer for Lark event handling.
 *
 * botmux's message handlers (handleThreadReply / handleNewTopic) are invoked
 * fire-and-forget from the WSClient event callback, so two messages addressed to
 * the SAME conversational unit (thread root or chat) are otherwise processed
 * concurrently. A fast second message then interleaves with the first's async
 * session-spawn. The concrete failure this fixes: `botmux dispatch` seeds a
 * thread, sends a `/repo <path>` prime (which creates the session and forks the
 * CLI worker — several awaits), then immediately sends the brief kickoff. The
 * kickoff's handler runs mid-spawn, finds `worker === null` with `pendingRepo`
 * already cleared, and falls into daemon.ts's "worker not running → re-fork with
 * resume" branch, which clobbers the in-flight spawn and drops the kickoff.
 *
 * Serializing per anchor makes the kickoff wait until the prime's handler fully
 * completes (worker live), so it routes as an ordinary follow-up that the worker
 * queues. Distinct anchors keep running concurrently, so unrelated threads/chats
 * are unaffected.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Queue `work` so it runs only after any previously-queued work for the same
 * `anchor` has settled (resolved OR rejected — a failing handler never blocks
 * the next message). Returns a promise that settles with `work`'s outcome, so
 * callers can still attach `.catch` for logging. Different anchors are
 * independent and run concurrently.
 */
export function serializeByAnchor(anchor: string, work: () => Promise<void>): Promise<void> {
  const prev = queues.get(anchor) ?? Promise.resolve();
  // `prev.then(work, work)` runs `work` regardless of whether `prev` resolved or
  // rejected — one handler's failure must not stall the anchor's queue.
  const next = prev.then(work, work);
  queues.set(anchor, next);
  // Garbage-collect the entry once this call is the tail of the chain, so the
  // map doesn't grow unbounded across the daemon's lifetime. Swallow `next`'s
  // outcome on a *separate* chain (so this cleanup never surfaces as an
  // unhandled rejection); the rejection itself is still delivered to the caller
  // via the returned `next`.
  void next.then(() => {}, () => {}).then(() => {
    if (queues.get(anchor) === next) queues.delete(anchor);
  });
  return next;
}

/** Test-only: clear all queues between cases. */
export function __resetAnchorQueues(): void {
  queues.clear();
}
