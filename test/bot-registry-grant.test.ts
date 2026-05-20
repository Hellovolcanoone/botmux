import { describe, it, expect } from 'vitest';
import { parseBotConfigsFromText, getOwnerOpenId, registerBot } from '../src/bot-registry.js';

describe('bot-registry grant additions', () => {
  it('parseBotConfigsFromText preserves & filters chatGrants', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a1', larkAppSecret: 's',
      chatGrants: { oc_1: ['ou_a', 'ou_b', 123], oc_2: 'bad', oc_3: ['ou_c'], oc_4: [] },
    }]));
    expect(cfgs[0].chatGrants).toEqual({ oc_1: ['ou_a', 'ou_b'], oc_3: ['ou_c'] });
  });

  it('parseBotConfigsFromText leaves chatGrants undefined when absent', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'a1b', larkAppSecret: 's' }]));
    expect(cfgs[0].chatGrants).toBeUndefined();
  });

  it('getOwnerOpenId returns first ou_ in resolvedAllowedUsers', () => {
    registerBot({ larkAppId: 'a2', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['x@y.com', 'ou_owner', 'ou_2'] });
    expect(getOwnerOpenId('a2')).toBe('ou_owner');
  });

  it('getOwnerOpenId undefined when no resolved ou_', () => {
    registerBot({ larkAppId: 'a3', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['x@y.com'] });
    expect(getOwnerOpenId('a3')).toBeUndefined();
  });
});
