import { describe, it, expect } from 'vitest';
import { findLaunchedCliPid } from '../src/core/session-discovery.js';

// findLaunchedCliPid sees through a wrapperCli launcher (`aiden x claude`) to the
// real CLI process it forks. The OS-probing is injected so the BFS is tested
// deterministically. Models the real tree: launcher(aiden,node) → claude child.
describe('findLaunchedCliPid()', () => {
  // tree: 100 launcher → [200 claude child, 201 auth-rpc child], 200 → 300 (bash)
  const tree: Record<number, number[]> = { 100: [200, 201], 200: [300], 201: [], 300: [] };
  const comm: Record<number, string> = { 100: 'node', 200: 'claude', 201: 'bytecloud-auth', 300: 'bash' };
  const probes = {
    childrenOf: (pid: number) => tree[pid] ?? [],
    commOf: (pid: number) => comm[pid],
  };

  it('finds the real CLI descendant by comm, not the launcher', () => {
    expect(findLaunchedCliPid(100, 'claude-code', 6, probes)).toBe(200);
  });

  it('does NOT match the launcher even though its argv would contain "claude" — comm-only', () => {
    // The launcher (pid 100) comm is "node"; "claude" only lives in its argv.
    // comm-only matching means the launcher is never mistaken for the CLI.
    // (Regression guard: argv-scanning would have returned 100 here.)
    const launcherCommIsBin = { ...comm, 100: 'aiden' }; // even if comm mapped, BFS starts at children
    expect(findLaunchedCliPid(100, 'claude-code', 6, { childrenOf: probes.childrenOf, commOf: (p) => launcherCommIsBin[p] }))
      .toBe(200);
  });

  it('returns null when the launcher has not forked the CLI yet', () => {
    expect(findLaunchedCliPid(100, 'claude-code', 6, { childrenOf: () => [], commOf: probes.commOf })).toBeNull();
  });

  it('returns null when no descendant matches the target cliId', () => {
    expect(findLaunchedCliPid(100, 'codex', 6, probes)).toBeNull();
  });

  it('respects maxDepth — a CLI deeper than the limit is not found', () => {
    // claude at depth 2 (100 → 200 → 250), maxDepth 1 stops before it.
    const deep: Record<number, number[]> = { 100: [200], 200: [250], 250: [] };
    const deepComm: Record<number, string> = { 100: 'node', 200: 'sh', 250: 'claude' };
    const p = { childrenOf: (pid: number) => deep[pid] ?? [], commOf: (pid: number) => deepComm[pid] };
    expect(findLaunchedCliPid(100, 'claude-code', 1, p)).toBeNull();
    expect(findLaunchedCliPid(100, 'claude-code', 6, p)).toBe(250);
  });

  it('resolves the wrapperCli=aiden x codex case to the codex child', () => {
    const t: Record<number, number[]> = { 1: [2], 2: [] };
    const c: Record<number, string> = { 1: 'node', 2: 'codex' };
    expect(findLaunchedCliPid(1, 'codex', 6, { childrenOf: (pid) => t[pid] ?? [], commOf: (pid) => c[pid] })).toBe(2);
  });

  it('terminates on cycles in the reported tree (seen guard)', () => {
    const cyc: Record<number, number[]> = { 1: [2], 2: [1] }; // 2 points back to 1
    const c: Record<number, string> = { 1: 'node', 2: 'sh' };
    expect(findLaunchedCliPid(1, 'claude-code', 6, { childrenOf: (pid) => cyc[pid] ?? [], commOf: (pid) => c[pid] })).toBeNull();
  });
});
