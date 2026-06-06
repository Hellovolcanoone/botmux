/**
 * `/botconfig` 跨机器中转传输层。
 *
 * 「只能出站(NAT 后)」拓扑下,hub 够不到远程机器,但每台机器的 bot 都常驻一条
 * 飞书出站 WS。于是用一个「控制 bot」在共享群里 @ 目标 bot 下发 `/botconfig` 子命令;
 * 目标 bot 把控制 bot 视作 allowedUser(信任已建立)后,按 Phase 1 的 `/botconfig`
 * 闸正常应用。这条传输后续会被 dashboard 跨机器编辑直接复用(dashboard → 控制
 * bot 的 daemon IPC → 本函数 → 飞书 → 目标 bot)。
 *
 * 纯逻辑(目标发现 + 解析 + 消息构造)放这里便于单测;真正发送由调用方
 * (command-handler / 未来的 IPC route)调 `sendMessage` 完成。
 */
import { getBotOpenId } from '../bot-registry.js';
import { listChatBotMembers } from '../im/lark/client.js';

export interface RelayTarget {
  /** 目标 bot 在「控制 bot 这个 app」视角下的 open_id(@mention 用)。 */
  openId: string;
  /** 展示名(优先 displayName,回退 name)。 */
  name: string;
  /**
   * 控制 bot 能否可靠地 @mention 该目标。飞书 open_id 是 per-app 的,只有经
   * cross-ref(@mention 事件学到)或 /introduce 观察到的 open_id 才可用;否则
   * 中转消息 @ 不到目标。见 {@link listChatBotMembers} 的 mentionable 字段。
   */
  mentionable: boolean;
}

/** 列出本群里可作为中转目标的其它 bot(排除控制 bot 自己)。 */
export async function listRelayTargets(controllerAppId: string, chatId: string): Promise<RelayTarget[]> {
  const selfOpenId = getBotOpenId(controllerAppId);
  const members = await listChatBotMembers(controllerAppId, chatId);
  return members
    .filter(m => !!m.openId && m.openId !== selfOpenId && m.larkAppId !== controllerAppId)
    .map(m => ({ openId: m.openId, name: m.displayName || m.name, mentionable: m.mentionable }));
}

export type ResolveTargetResult =
  | { ok: true; target: RelayTarget }
  | { ok: false; reason: 'not_found'; candidates: string[] }
  | { ok: false; reason: 'not_mentionable'; target: RelayTarget };

/**
 * 把用户给的目标标识(bot 展示名,或从 `/botconfig targets` 复制的 `ou_` open_id)
 * 解析成一个可中转的目标。名字匹配:先精确(忽略大小写),再前缀/包含。
 */
export async function resolveRelayTarget(
  controllerAppId: string,
  chatId: string,
  query: string,
): Promise<ResolveTargetResult> {
  const targets = await listRelayTargets(controllerAppId, chatId);
  const q = query.trim();
  let match: RelayTarget | undefined;
  if (q.startsWith('ou_')) {
    match = targets.find(t => t.openId === q);
  } else {
    const lq = q.toLowerCase();
    match = targets.find(t => t.name.toLowerCase() === lq)
      ?? targets.find(t => t.name.toLowerCase().startsWith(lq))
      ?? targets.find(t => t.name.toLowerCase().includes(lq));
  }
  if (!match) return { ok: false, reason: 'not_found', candidates: targets.map(t => t.name) };
  if (!match.mentionable) return { ok: false, reason: 'not_mentionable', target: match };
  return { ok: true, target: match };
}

/**
 * 构造中转消息文本:`<at user_id="ou_target"></at> /botconfig <subcommand>`。
 * 目标 bot 的 dispatcher 解析 @mention 后,把剩余文本当作 `/botconfig <subcommand>`
 * 路由到它自己的 `/botconfig` 处理(权限按目标的 allowedUsers 判,控制 bot 须在内)。
 */
export function buildRelayContent(targetOpenId: string, subcommand: string): string {
  return `<at user_id="${targetOpenId}"></at> /botconfig ${subcommand.trim()}`;
}

/**
 * 是否禁止中转该 `/botconfig` 子命令。与 command-handler 的「humans-only」守卫同口径:
 * 改信任根(`set allowedUsers` / `trust` / `untrust`)绝不允许经控制 bot 中转——
 * dashboard 下发本质也是控制 bot 发消息,目标侧 fromBot=true 会拒,这里在**下发侧**
 * 也提前挡掉,给出清晰报错而不是让它默默被目标拒绝。入参是不含 `/botconfig` 前缀的子命令。
 */
export function isRelayForbidden(subcommand: string): boolean {
  const s = subcommand.trim().toLowerCase();
  return /^set\s+allowedusers\b/.test(s) || /^trust\b/.test(s) || /^untrust\b/.test(s);
}
