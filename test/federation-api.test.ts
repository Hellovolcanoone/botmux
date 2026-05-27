/**
 * Federation hub roster aggregation + hub HTTP endpoints (join/sync/roster).
 * Run: pnpm vitest run test/federation-api.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return state.dataDir; } } },
}));

import { handleFederationApi } from '../src/dashboard/federation-api.js';
import { buildFederatedRoster } from '../src/services/federation-roster.js';
import { registerDeployment } from '../src/services/federation-store.js';
import { ensureDefaultTeam, addMember, DEFAULT_TEAM_ID } from '../src/services/team-store.js';
import { createInvite } from '../src/services/invite-store.js';
import { addMembership } from '../src/services/federation-membership-store.js';
import { getDeploymentIdentity } from '../src/services/deployment-identity.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-fedapi-')); state.dataDir = dataDir; });

function writeBots(entries: any[]) { writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(entries)); }
function makeReq(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): any {
  const req: any = { method, url: path, headers };
  req[Symbol.asyncIterator] = async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {}, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res._headers[k.toLowerCase()];
  res.writeHead = (s: number, h?: any) => { res.statusCode = s; if (h) Object.assign(res._headers, h); };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
const call = (req: any, res: any, path: string) => handleFederationApi(req, res, new URL('http://x' + path), { dataDir });
const callWithGroup = (req: any, res: any, path: string, createTeamGroup: any) => handleFederationApi(req, res, new URL('http://x' + path), { dataDir, createTeamGroup });
const json = (res: any) => JSON.parse(res._body);

describe('buildFederatedRoster', () => {
  it('merges local bots (tagged local) with federated deployments\' bots', () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地Bot', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, {
      deploymentId: 'dep_remote', name: '同事的部署',
      bots: [{ larkAppId: 'cli_remote', botName: '远端Bot', cliId: 'codex' }],
    });
    const r = buildFederatedRoster(dataDir, DEFAULT_TEAM_ID);
    expect(r.bots.map(b => b.name).sort()).toEqual(['本地Bot', '远端Bot']);
    const local = r.bots.find(b => b.larkAppId === 'cli_local')!;
    const remote = r.bots.find(b => b.larkAppId === 'cli_remote')!;
    expect(local.deployment.local).toBe(true);
    expect(remote.deployment.local).toBe(false);
    expect(remote.deployment.name).toBe('同事的部署');
    // deployments list: local first, then remote
    expect(r.deployments[0].local).toBe(true);
    expect(r.deployments.find(d => d.id === 'dep_remote')?.botCount).toBe(1);
  });
});

describe('handleFederationApi', () => {
  it('returns false for unrelated paths', async () => {
    expect(await call(makeReq('GET', '/api/sessions'), makeRes(), '/api/sessions')).toBe(false);
  });

  it('join → sync → roster full flow', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'HubBot', cliId: 'claude' }]);
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');

    // join with invite
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', {
      inviteCode: code,
      deployment: { deploymentId: 'dep_b', name: 'B部署', bots: [{ larkAppId: 'cli_b1', botName: 'B1', cliId: 'codex' }] },
    }), res, '/api/federation/join');
    expect(res.statusCode).toBe(200);
    const { syncToken, teamId } = json(res);
    expect(teamId).toBe(DEFAULT_TEAM_ID);
    expect(syncToken.length).toBeGreaterThan(20);

    // sync updates bots
    res = makeRes();
    await call(makeReq('POST', '/api/federation/sync', { syncToken, bots: [{ larkAppId: 'cli_b1', botName: 'B1', cliId: 'codex' }, { larkAppId: 'cli_b2', botName: 'B2', cliId: 'gemini' }] }), res, '/api/federation/sync');
    expect(res.statusCode).toBe(200);

    // roster reflects hub local + B's two bots (token in Authorization header)
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster', undefined, bearer(syncToken)), res, '/api/federation/roster');
    expect(res.statusCode).toBe(200);
    expect(json(res).bots.map((b: any) => b.larkAppId).sort()).toEqual(['cli_b1', 'cli_b2', 'cli_hub']);

    // a second deployment can't re-bind by re-joining with the same id → 409
    const { code: code2 } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code2, deployment: { deploymentId: 'dep_b', name: 'B', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toBe('deployment_already_joined');

    // leave (authed by syncToken) drops the deployment; roster then 403s
    res = makeRes();
    await call(makeReq('POST', '/api/federation/leave', { syncToken }), res, '/api/federation/leave');
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster', undefined, bearer(syncToken)), res, '/api/federation/roster');
    expect(res.statusCode).toBe(403);
  });

  it('roster still accepts ?syncToken= as a short-term compat fallback', async () => {
    writeBots([]);
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code, deployment: { deploymentId: 'dep_c', name: 'C', bots: [] } }), res, '/api/federation/join');
    const { syncToken } = json(res);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster?syncToken=' + syncToken), res, '/api/federation/roster?syncToken=' + syncToken);
    expect(res.statusCode).toBe(200);
  });

  it('join rejects self-join (same deploymentId) with cannot_join_self', async () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    const me = getDeploymentIdentity(dataDir); // this deployment's own id
    const res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code, deployment: { deploymentId: me.deploymentId, name: 'self', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('cannot_join_self');
  });

  it('join rejects a bad invite code (403)', async () => {
    const res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: 'NOPE', deployment: { deploymentId: 'dep_b', name: 'B', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_not_found');
  });

  it('sync / roster reject an unknown token (403)', async () => {
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/sync', { syncToken: 'bogus', bots: [] }), res, '/api/federation/sync');
    expect(res.statusCode).toBe(403);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster?syncToken=bogus'), res, '/api/federation/roster');
    expect(res.statusCode).toBe(403);
  });

  it('delegate-group: valid token → creates via createTeamGroup; idempotent on requestId; guardrails', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]); // our local bot
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'st', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    let calls = 0; let captured: any = null;
    const createTeamGroup = vi.fn(async (args: any) => { calls++; captured = args; return { ok: true, chatId: 'oc_deleg', shareLink: 'https://x', invalidBotIds: [] }; });
    // valid token + involves our local bot cli_a → creates
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { name: 'g', larkAppIds: ['cli_a', 'cli_b'], ownerUnionIds: ['on_1'], requestId: 'req1' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_deleg');
    expect(captured).toMatchObject({ name: 'g', larkAppIds: ['cli_a', 'cli_b'], ownerUnionIds: ['on_1'] });
    // replay same requestId → cached, createTeamGroup NOT called again (no dup group)
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'], requestId: 'req1' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_deleg');
    expect(calls).toBe(1); // idempotent
    // guardrail: no local bot in selection → 400 no_local_bot
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_remote_only'], requestId: 'r2' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('no_local_bot');
    // unknown token → 403
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('NOPE')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(403);
    // no createTeamGroup dep → 501
    res = makeRes();
    await call(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('DTOK')), res, '/api/federation/delegate-group');
    expect(res.statusCode).toBe(501);
  });

  it('federation/group: spoke initiates; operator is hub-derived from syncToken; requestId required + idempotent', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]); // hub local bot
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_spoke', name: 'S', ownerUnionId: 'on_spoke', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' }] });
    const list = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID);
    const syncToken = list[0].syncToken;
    let calls = 0; let captured: any = null;
    const createTeamGroup = vi.fn(async (a: any) => { calls++; captured = a; return { ok: true, chatId: 'oc_g', invalidBotIds: [] }; });
    // missing requestId → 400
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub'] }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(json(res).error).toBe('request_id_required');
    // valid → orchestrates; operator (spoke owner, hub-derived) in invitees
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub'], requestId: 'r1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_g');
    expect(captured.ownerUnionIds).toContain('on_spoke'); // operator from syncToken, NOT request body
    // replay same requestId → idempotent (createTeamGroup not called again)
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub'], requestId: 'r1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_g');
    expect(calls).toBe(1);
    // unknown token → 403
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_hub'], requestId: 'r2' }, bearer('NOPE')), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(403);
  });

  it('federation/group: token is header-only (rejects ?syncToken= and body token)', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_s', name: 'S', ownerUnionId: 'on_s', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' }] });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    const createTeamGroup = vi.fn(async () => ({ ok: true, chatId: 'oc', invalidBotIds: [] }));
    // token in query string → NOT accepted (would leak into access logs)
    const qp = '/api/federation/group?syncToken=' + syncToken;
    let res = makeRes();
    await callWithGroup(makeReq('POST', qp, { larkAppIds: ['cli_hub'], requestId: 'q1' }), res, qp, createTeamGroup);
    expect(res.statusCode).toBe(403);
    // token in body → NOT accepted either
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { syncToken, larkAppIds: ['cli_hub'], requestId: 'b1' }), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(403);
    expect(createTeamGroup).not.toHaveBeenCalled();
  });

  it('federation/group: a FAILED terminal result is cached too (replay never re-orchestrates)', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_s', name: 'S', ownerUnionId: 'on_s', bots: [] });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    let calls = 0;
    const createTeamGroup = vi.fn(async () => { calls++; return { ok: false, error: 'group_create_proxy_failed' }; });
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_hub'], requestId: 'f1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toBe('group_create_proxy_failed');
    // replay same requestId → cached 502 returned verbatim, createTeamGroup NOT called again
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_hub'], requestId: 'f1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toBe('group_create_proxy_failed');
    expect(calls).toBe(1);
  });

  it('join requires inviteCode + deployment', async () => {
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { deployment: { deploymentId: 'd', name: 'n', bots: [] } }), res, '/api/federation/join');
    expect(json(res).error).toBe('code_required');
    res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: 'x' }), res, '/api/federation/join');
    expect(json(res).error).toBe('deployment_required');
  });
});
