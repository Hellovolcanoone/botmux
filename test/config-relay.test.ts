/**
 * Unit tests for the /config cross-machine relay helper: target discovery
 * (excludes self), name/ou_ resolution, mentionable gating, and the relay
 * message construction. listChatBotMembers is mocked — no network.
 *
 * Run: pnpm vitest run test/config-relay.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { opts: Record<string, unknown>; constructor(o: Record<string, unknown>) { this.opts = o; } }
  return { Client: FakeClient };
});

const h = vi.hoisted(() => ({ members: [] as any[] }));
vi.mock('../src/im/lark/client.js', () => ({
  listChatBotMembers: async () => h.members,
}));

function member(over: Partial<any>): any {
  return {
    larkAppId: '', openId: '', name: '', displayName: '', source: 'introduce',
    hasTeamRole: false, mentionable: true, mentionSource: 'observed', ...over,
  };
}

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const relay = await import('../src/services/config-relay.js');
  registry.registerBot({ larkAppId: 'ctrl', larkAppSecret: 's', cliId: 'claude-code' } as any);
  registry.getBot('ctrl').botOpenId = 'ou_self';
  return { registry, relay };
}

describe('config-relay', () => {
  beforeEach(() => { h.members = []; });

  it('listRelayTargets excludes self (by openId and by larkAppId) and maps fields', async () => {
    const { relay } = await fresh();
    h.members = [
      member({ larkAppId: 'ctrl', openId: 'ou_self', name: 'Ctrl', displayName: 'Ctrl', source: 'configured' }),
      member({ openId: 'ou_t1', name: 'codexbot', displayName: 'Codex Bot', mentionable: true }),
      member({ openId: 'ou_t2', name: 'geminibot', displayName: 'Gemini Bot', mentionable: false }),
    ];
    const targets = await relay.listRelayTargets('ctrl', 'oc_room');
    expect(targets).toEqual([
      { openId: 'ou_t1', name: 'Codex Bot', mentionable: true },
      { openId: 'ou_t2', name: 'Gemini Bot', mentionable: false },
    ]);
  });

  it('resolveRelayTarget matches exact name, prefix, and ou_ id', async () => {
    const { relay } = await fresh();
    h.members = [
      member({ openId: 'ou_t1', displayName: 'Codex Bot', mentionable: true }),
      member({ openId: 'ou_t2', displayName: 'Gemini Bot', mentionable: true }),
    ];
    const exact = await relay.resolveRelayTarget('ctrl', 'oc', 'Codex Bot');
    expect(exact.ok && exact.target.openId).toBe('ou_t1');
    const prefix = await relay.resolveRelayTarget('ctrl', 'oc', 'gem');
    expect(prefix.ok && prefix.target.openId).toBe('ou_t2');
    const byId = await relay.resolveRelayTarget('ctrl', 'oc', 'ou_t1');
    expect(byId.ok && byId.target.openId).toBe('ou_t1');
  });

  it('resolveRelayTarget returns not_found with candidate names', async () => {
    const { relay } = await fresh();
    h.members = [member({ openId: 'ou_t1', displayName: 'Codex Bot', mentionable: true })];
    const r = await relay.resolveRelayTarget('ctrl', 'oc', 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'not_found') expect(r.candidates).toEqual(['Codex Bot']);
  });

  it('resolveRelayTarget flags a known-but-unmentionable target', async () => {
    const { relay } = await fresh();
    h.members = [member({ openId: 'ou_t2', displayName: 'Gemini Bot', mentionable: false })];
    const r = await relay.resolveRelayTarget('ctrl', 'oc', 'gemini');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_mentionable');
  });

  it('buildRelayContent wraps the subcommand with an @mention of the target', async () => {
    const { relay } = await fresh();
    expect(relay.buildRelayContent('ou_t1', 'set model opus'))
      .toBe('<at user_id="ou_t1"></at> /botconfig set model opus');
  });

  it('isRelayForbidden blocks trust-root edits, allows operational ones', async () => {
    const { relay } = await fresh();
    for (const bad of ['set allowedUsers a@b.com', 'SET   AllowedUsers x', 'trust foo', 'untrust foo']) {
      expect(relay.isRelayForbidden(bad)).toBe(true);
    }
    for (const ok of ['set model opus', 'get', 'unset model', 'set lang en', 'targets']) {
      expect(relay.isRelayForbidden(ok)).toBe(false);
    }
  });
});
