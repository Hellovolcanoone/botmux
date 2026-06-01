/**
 * Phase 0 keystone — `botmux dispatch` pure core.
 *
 * The orchestrator dispatches a sub-project to a small group of bots (often a
 * coder + a reviewer) by seeding a fresh Lark thread and @-mentioning them so
 * each spawns its own thread-scoped session. These tests pin the message
 * construction: the right bots get @-ed (so they actually trigger), the brief
 * reaches the thread, and per-bot roles are surfaced.
 *
 * Run: pnpm vitest run test/dispatch.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  parseDispatchBotSpec,
  buildDispatchMessages,
  buildRepoPrimeText,
  buildReportContent,
  findSubBotTopic,
} from '../src/core/dispatch.js';

describe('parseDispatchBotSpec', () => {
  it('parses a bare open_id', () => {
    expect(parseDispatchBotSpec('ou_123')).toEqual({ openId: 'ou_123' });
  });
  it('parses open_id:name', () => {
    expect(parseDispatchBotSpec('ou_123:Alice')).toEqual({ openId: 'ou_123', name: 'Alice' });
  });
  it('parses open_id:name:role', () => {
    expect(parseDispatchBotSpec('ou_123:Alice:coder')).toEqual({
      openId: 'ou_123',
      name: 'Alice',
      role: 'coder',
    });
  });
  it('throws on an empty spec', () => {
    expect(() => parseDispatchBotSpec('   ')).toThrow();
  });
});

describe('buildDispatchMessages', () => {
  const bots = [
    { openId: 'ou_a', name: 'Alice', role: 'coder' },
    { openId: 'ou_b', name: 'Bob', role: 'reviewer' },
  ];

  const flatNodes = (content: Array<Array<{ tag: string; text?: string; user_id?: string }>>) =>
    content.flat();
  const allText = (content: Array<Array<{ tag: string; text?: string; user_id?: string }>>) =>
    flatNodes(content)
      .filter(n => n.tag === 'text')
      .map(n => n.text)
      .join('\n');

  it('seed message carries the sub-project title', () => {
    const r = buildDispatchMessages({ title: '实现登录模块', brief: 'x', bots });
    expect(r.seedText).toContain('实现登录模块');
  });

  it('@-mentions every assigned bot so they get triggered', () => {
    const r = buildDispatchMessages({ title: 't', brief: 'b', bots });
    expect(r.mentionedOpenIds).toEqual(['ou_a', 'ou_b']);
    const ats = flatNodes(r.threadContent)
      .filter(n => n.tag === 'at')
      .map(n => n.user_id);
    expect(ats).toEqual(['ou_a', 'ou_b']);
  });

  it('includes the brief text in the thread kickoff', () => {
    const r = buildDispatchMessages({ title: 't', brief: '把登录接口写完并自测', bots });
    expect(allText(r.threadContent)).toContain('把登录接口写完并自测');
  });

  it('surfaces each bot role for the coder+reviewer pattern', () => {
    const r = buildDispatchMessages({ title: 't', brief: 'b', bots });
    const text = allText(r.threadContent);
    expect(text).toContain('coder');
    expect(text).toContain('reviewer');
  });

  it('throws when no bots are assigned', () => {
    expect(() => buildDispatchMessages({ title: 't', brief: 'b', bots: [] })).toThrow();
  });

  it('throws on an empty title', () => {
    expect(() => buildDispatchMessages({ title: '   ', brief: 'b', bots })).toThrow();
  });
});

describe('buildRepoPrimeText', () => {
  const bots = [
    { openId: 'ou_a', name: 'Alice', role: 'coder' },
    { openId: 'ou_b', name: 'Bob', role: 'reviewer' },
  ];

  // The prime must be a TEXT message (with inline <at> tags), exactly like a
  // human typing "@bot /repo <path>". A structured `post` loses the path in the
  // live event (renderPostNode path); text goes through resolveMentions cleanly.
  it('@-mentions every bot via <at> tags so the text prime triggers each session', () => {
    const r = buildRepoPrimeText({ path: '/root/iserver/botmux', bots });
    expect(r.mentionedOpenIds).toEqual(['ou_a', 'ou_b']);
    expect(r.text).toContain('<at user_id="ou_a">');
    expect(r.text).toContain('<at user_id="ou_b">');
  });

  it('emits `/repo <path>` after the mentions (parses like a human-typed @bot /repo)', () => {
    const r = buildRepoPrimeText({ path: '/root/iserver/botmux', bots });
    expect(r.text).toContain('/repo /root/iserver/botmux');
    // /repo must come after the last <at> so that, post mention-strip, the
    // receiving daemon sees "/repo <path>" as the command.
    expect(r.text.indexOf('/repo')).toBeGreaterThan(r.text.lastIndexOf('</at>'));
  });

  it('throws on an empty path', () => {
    expect(() => buildRepoPrimeText({ path: '   ', bots })).toThrow();
  });

  it('throws when no bots are given', () => {
    expect(() => buildRepoPrimeText({ path: '/x', bots: [] })).toThrow();
  });
});

describe('buildReportContent', () => {
  it('@-mentions the orchestrator then carries the report on the first line', () => {
    const paras = buildReportContent({ orchOpenId: 'ou_orch', content: '子项目X 完成' });
    expect(paras).toHaveLength(1);
    expect(paras[0]).toEqual([
      { tag: 'at', user_id: 'ou_orch' },
      { tag: 'text', text: ' ' },
      { tag: 'text', text: '子项目X 完成' },
    ]);
  });

  it('keeps the @ on the first line and puts later lines in their own paragraphs', () => {
    const paras = buildReportContent({ orchOpenId: 'ou_orch', content: '完成\n产出在 /tmp/out' });
    expect(paras).toHaveLength(2);
    expect(paras[0][0]).toEqual({ tag: 'at', user_id: 'ou_orch' });
    expect(paras[0][2]).toEqual({ tag: 'text', text: '完成' });
    expect(paras[1]).toEqual([{ tag: 'text', text: '产出在 /tmp/out' }]);
  });

  it('throws on empty content', () => {
    expect(() => buildReportContent({ orchOpenId: 'ou_orch', content: '   ' })).toThrow();
  });

  it('throws on empty orchestrator open_id', () => {
    expect(() => buildReportContent({ orchOpenId: '  ', content: 'x' })).toThrow();
  });
});

describe('findSubBotTopic', () => {
  const registry = {
    'om_seedA': { orchChatId: 'oc_main', bots: ['ou_coder', 'ou_reviewer'] },
    'om_seedB': { orchChatId: 'oc_main', bots: ['ou_other'] },
    'om_seedC': { orchChatId: 'oc_else', bots: ['ou_coder'] },
  };
  const activeSeeds = new Set(['om_seedA', 'om_seedC']); // seedB's topic finished

  it('returns the topic seed when @-ing a dispatched sub-bot in an active topic of this chat', () => {
    expect(findSubBotTopic({ mentionOpenId: 'ou_coder', chatId: 'oc_main', registry, activeSeeds })).toBe('om_seedA');
  });

  it('returns null for a bot not dispatched anywhere', () => {
    expect(findSubBotTopic({ mentionOpenId: 'ou_stranger', chatId: 'oc_main', registry, activeSeeds })).toBeNull();
  });

  it('returns null when the dispatched topic is no longer active (stale registry entry)', () => {
    expect(findSubBotTopic({ mentionOpenId: 'ou_other', chatId: 'oc_main', registry, activeSeeds })).toBeNull();
  });

  it('does not fire across a different chat', () => {
    // ou_coder is also in seedC, but that topic is in oc_else, not oc_main
    expect(findSubBotTopic({ mentionOpenId: 'ou_coder', chatId: 'oc_zzz', registry, activeSeeds })).toBeNull();
  });
});
