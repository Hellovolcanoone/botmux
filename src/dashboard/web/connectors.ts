// Connectors (webhook 接入点) page: let external systems (alerts / CI / tickets…)
// trigger a bot via an inbound webhook. Lists connectors + a clean create form.
// All webhook sources are treated uniformly (no source-type). Dashboard-token
// authed (cookie). Backend: handleConnectorApi (/api/connectors*).
import { escapeHtml } from './ui.js';

interface Connector {
  id: string; name: string; enabled: boolean;
  verify?: { type: 'token' | 'hmac-sha256' };
  target: { mode: 'dynamic' | 'fixed' | 'new-group'; kind: 'turn' | 'workflow'; botId: string; chatId?: string; allowChats?: string[]; workflowId?: string };
  promptEnvelope: { sourceName: string; instruction?: string };
}
interface BotOpt { larkAppId: string; botName: string; }
interface GroupOpt { chatId: string; name: string; bots: string[] }

async function jget(u: string) { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({} as any)) }; }
async function jsend(method: string, u: string, b?: unknown) {
  const r = await fetch(u, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}
function $(id: string): HTMLElement { return document.getElementById(id)!; }
function val(id: string): string { return (($(id) as HTMLInputElement).value || '').trim(); }

let bots: BotOpt[] = [];
let groups: GroupOpt[] = [];

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">Webhook</p>
    <h1>Webhook</h1>
    <p>让外部系统（监控告警、CI、工单…）通过一个 webhook 触发机器人在群里说话或跑工作流。</p>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">新建 Webhook</h2>
  <div class="cn-form" style="display:grid;grid-template-columns:140px 1fr;gap:10px 14px;align-items:center;max-width:680px">
    <label>名称</label><input id="cn-name" placeholder="如：线上告警">
    <label>触发的机器人</label><select id="cn-bot"></select>
    <label>触发方式</label>
    <select id="cn-kind"><option value="turn">单轮对话（让机器人回应一次）</option><option value="workflow">工作流</option></select>
    <label class="cn-wf" style="display:none">工作流 ID</label><input class="cn-wf" id="cn-wf" style="display:none" placeholder="workflowId">
    <label>投递到哪个群</label>
    <select id="cn-mode">
      <option value="dynamic">由请求指定（群随请求传入）</option>
      <option value="fixed">固定群</option>
      <option value="new-group">每次新建群</option>
    </select>
    <label class="cn-fixed" style="display:none">投递到的群</label>
    <div class="cn-fixed" style="display:none">
      <select id="cn-chat-sel" style="width:100%;box-sizing:border-box"></select>
      <input id="cn-chat" placeholder="手动填群 ID：oc_…" style="display:none;width:100%;box-sizing:border-box;margin-top:6px">
      <a href="#" id="cn-chat-manual" style="font-size:12px;display:inline-block;margin-top:4px">找不到群？手动填 ID →</a>
    </div>
    <label class="cn-allow">允许的群<span class="muted" style="font-weight:400">（可选）</span></label>
    <div class="cn-allow">
      <select id="cn-allow-sel" multiple size="4" style="width:100%;box-sizing:border-box"></select>
      <div class="muted" style="font-size:12px;margin-top:4px">按住 Ctrl/⌘ 多选；留空 = 不限。只用于校验请求传入的群是否被允许。</div>
    </div>
    <div class="cn-dyn" style="display:none;grid-column:1 / -1">
      <div class="muted" style="font-size:12px;line-height:1.7;background:var(--bg-soft,#f6f7f9);padding:8px 10px;border-radius:6px">
        <b>动态模式</b>：群 ID 随每次请求传入，三选一 —— 查询参数 <code>?chatId=&lt;群ID&gt;</code> · 请求头 <code>x-botmux-chat-id: &lt;群ID&gt;</code> · 请求体 <code>{"chatId":"&lt;群ID&gt;"}</code>。<br>想"一个 URL 直接触发、不带参数"，请改选「固定群」。
      </div>
    </div>
    <label class="cn-life" style="display:none">去重字段<span class="muted" style="font-weight:400">（可选）</span></label>
    <div class="cn-life" style="display:none">
      <input id="cn-dedup" placeholder="如 alert.id（从事件 body 取值）" style="width:100%;box-sizing:border-box">
      <div class="muted" style="font-size:12px;margin-top:4px">填了：命中相同值的事件都投到<b>同一个群</b>。留空：每个事件<b>新建一个群</b>。</div>
    </div>
    <label style="align-self:start">处理指令<span class="muted" style="font-weight:400">（可选）</span></label>
    <textarea id="cn-instruction" rows="3" placeholder="事件触发时让机器人做什么。如：总结这条告警的严重程度，@相关 oncall，给出排查建议。留空 = 只把事件原样交给模型自由发挥。" style="width:100%;box-sizing:border-box;font-family:inherit;font-size:13px"></textarea>
    <label>校验方式</label>
    <select id="cn-verify">
      <option value="token">令牌（简单：密钥放进 URL，一条 curl 就能触发）</option>
      <option value="hmac-sha256">HMAC 签名（高级：更安全，需自行对请求签名）</option>
    </select>
    <label>密钥 / 令牌</label><input id="cn-secret" placeholder="留空自动生成（只显示一次）">
  </div>
  <div style="margin-top:14px"><button id="cn-create" class="primary">创建</button>
    <span class="muted" id="cn-create-out" style="margin-left:10px;font-size:13px"></span></div>
  <div id="cn-created" style="display:none;margin-top:12px"></div>
</div>

<div class="card">
  <h2 style="margin-top:0">已有 Webhook <span class="muted" id="cn-count" style="font-size:13px"></span></h2>
  <div id="cn-list">加载中…</div>
</div>
</section>`;
}

function syncFormVisibility(): void {
  const kind = ($('cn-kind') as HTMLSelectElement).value;
  const mode = ($('cn-mode') as HTMLSelectElement).value;
  document.querySelectorAll<HTMLElement>('.cn-wf').forEach(e => { e.style.display = kind === 'workflow' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-fixed').forEach(e => { e.style.display = mode === 'fixed' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-allow').forEach(e => { e.style.display = mode === 'fixed' ? 'none' : ''; });
  document.querySelectorAll<HTMLElement>('.cn-dyn').forEach(e => { e.style.display = mode === 'dynamic' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-life').forEach(e => { e.style.display = mode === 'new-group' ? '' : 'none'; });
}

function webhookUrl(id: string): string { return `${location.origin}/webhook/${encodeURIComponent(id)}`; }

function modeLabel(m: string): string { return m === 'fixed' ? '固定群' : m === 'new-group' ? '每次新建群' : '请求指定群'; }
function kindLabel(k: string): string { return k === 'workflow' ? '工作流' : '单轮'; }

function groupName(chatId: string): string {
  const g = groups.find(x => x.chatId === chatId);
  return g?.name || chatId;
}

function botGroups(botId: string): GroupOpt[] {
  return groups.filter(g => g.bots.includes(botId));
}

// (Re)populate the fixed-group select + allowlist multi-select from the chats
// the currently-selected bot is a member of. Preserves prior selection.
function fillGroupPickers(): void {
  const botId = ($('cn-bot') as HTMLSelectElement).value;
  const gs = botGroups(botId);
  const opt = (g: GroupOpt) => `<option value="${escapeHtml(g.chatId)}">${escapeHtml(g.name || g.chatId)}</option>`;
  const sel = $('cn-chat-sel') as HTMLSelectElement;
  const prev = sel.value;
  sel.innerHTML = gs.length ? gs.map(opt).join('') : '<option value="">（该机器人暂无可见群，点右侧手动填 ID）</option>';
  if (prev && gs.some(g => g.chatId === prev)) sel.value = prev;
  const asel = $('cn-allow-sel') as HTMLSelectElement;
  const prevAllow = new Set(Array.from(asel.selectedOptions).map(o => o.value));
  asel.innerHTML = gs.map(opt).join('');
  Array.from(asel.options).forEach(o => { if (prevAllow.has(o.value)) o.selected = true; });
}

function renderList(connectors: Connector[]): void {
  const el = $('cn-list');
  $('cn-count').textContent = connectors.length ? `· ${connectors.length} 个` : '';
  if (!connectors.length) { el.innerHTML = '<p class="muted">还没有 Webhook。用上面的表单创建一个。</p>'; return; }
  el.innerHTML = connectors.map(c => {
    const bot = bots.find(b => b.larkAppId === c.target.botId);
    const url = webhookUrl(c.id);
    const isToken = (c.verify?.type ?? 'token') === 'token';
    const verifyBadge = isToken ? '令牌' : '签名';
    const destLabel = c.target.mode === 'fixed' && c.target.chatId
      ? ` · 投递「${escapeHtml(groupName(c.target.chatId))}」`
      : '';
    return `<div class="card" style="margin:0 0 10px;padding:12px 14px;background:var(--bg-soft,#f6f7f9)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-size:15px">${escapeHtml(c.name)}</b>
        <span class="${c.enabled ? 'ok' : 'muted'}" style="font-size:12px">${c.enabled ? '已启用' : '已停用'}</span>
        <span class="muted" style="font-size:12px">· ${escapeHtml(bot?.botName || c.target.botId)} · ${kindLabel(c.target.kind)} · ${modeLabel(c.target.mode)}${destLabel} · ${verifyBadge}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="cn-toggle ghost" data-id="${escapeHtml(c.id)}" data-on="${c.enabled}" style="font-size:12px">${c.enabled ? '停用' : '启用'}</button>
          <button class="cn-del ghost" data-id="${escapeHtml(c.id)}" style="font-size:12px">删除</button>
        </span>
      </div>
      <div style="margin-top:6px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="muted">Webhook URL：</span><code style="font-size:12px;word-break:break-all">${escapeHtml(url)}${isToken ? '/&lt;令牌&gt;' : ''}</code>
        <button class="cn-copy ghost" data-url="${escapeHtml(url)}" style="font-size:12px">复制</button>
      </div>${isToken ? '<div class="muted" style="font-size:12px;margin-top:4px">令牌模式：调用时在 URL 末尾追加 <code>/&lt;令牌&gt;</code>（令牌仅创建/轮换时显示一次）。</div>' : ''}${c.target.mode === 'dynamic' ? '<div class="muted" style="font-size:12px;margin-top:4px">动态模式：请求需带目标群 —— <code>?chatId=&lt;群ID&gt;</code> 或头 <code>x-botmux-chat-id</code> 或 body <code>{"chatId":"…"}</code>。</div>' : ''}${c.promptEnvelope?.instruction ? `<div class="muted" style="font-size:12px;margin-top:4px">处理指令：${escapeHtml(c.promptEnvelope.instruction)}</div>` : ''}</div>`;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('.cn-copy').forEach(b => { b.onclick = () => { navigator.clipboard?.writeText(b.dataset.url!); b.textContent = '已复制'; setTimeout(() => b.textContent = '复制', 1200); }; });
  el.querySelectorAll<HTMLButtonElement>('.cn-toggle').forEach(b => {
    b.onclick = async () => { await jsend('PATCH', '/api/connectors/' + encodeURIComponent(b.dataset.id!), { enabled: b.dataset.on !== 'true' }); load(); };
  });
  el.querySelectorAll<HTMLButtonElement>('.cn-del').forEach(b => {
    b.onclick = async () => { if (!confirm('删除这个 Webhook？它的 URL 会立即失效。')) return; await jsend('DELETE', '/api/connectors/' + encodeURIComponent(b.dataset.id!)); load(); };
  });
}

async function load(): Promise<void> {
  const [bl, cl, gl] = await Promise.all([jget('/api/bots'), jget('/api/connectors'), jget('/api/groups')]);
  bots = (bl.body?.bots || []).map((b: any) => ({ larkAppId: b.larkAppId, botName: b.botName || b.larkAppId }));
  groups = (gl.body?.chats || []).map((c: any) => ({
    chatId: c.chatId,
    name: c.name || '',
    bots: (c.memberBots || []).filter((mb: any) => mb.inChat).map((mb: any) => mb.larkAppId),
  }));
  const sel = $('cn-bot') as HTMLSelectElement; const cur = sel.value;
  sel.innerHTML = bots.map(b => `<option value="${escapeHtml(b.larkAppId)}">${escapeHtml(b.botName)}</option>`).join('') || '<option value="">（没有在线机器人）</option>';
  if (cur) sel.value = cur;
  fillGroupPickers();
  renderList(cl.body?.connectors || []);
}

export function renderConnectorsPage(root: HTMLElement): void {
  root.innerHTML = pageHtml();
  ($('cn-kind') as HTMLSelectElement).onchange = syncFormVisibility;
  ($('cn-mode') as HTMLSelectElement).onchange = syncFormVisibility;
  ($('cn-bot') as HTMLSelectElement).onchange = fillGroupPickers;
  $('cn-chat-manual').onclick = (e) => {
    e.preventDefault();
    const inp = $('cn-chat') as HTMLInputElement;
    const sel = $('cn-chat-sel') as HTMLSelectElement;
    const showManual = inp.style.display === 'none';
    inp.style.display = showManual ? '' : 'none';
    sel.style.display = showManual ? 'none' : '';
    $('cn-chat-manual').textContent = showManual ? '从群列表选择 ←' : '找不到群？手动填 ID →';
  };
  syncFormVisibility();

  $('cn-create').onclick = async () => {
    const out = $('cn-create-out');
    const name = val('cn-name');
    const botId = ($('cn-bot') as HTMLSelectElement).value;
    if (!name) { out.innerHTML = '<span class="err">请填名称</span>'; return; }
    if (!botId) { out.innerHTML = '<span class="err">请选机器人</span>'; return; }
    const kind = ($('cn-kind') as HTMLSelectElement).value;
    const mode = ($('cn-mode') as HTMLSelectElement).value;
    const body: any = {
      name, enabled: true,
      target: { kind, mode, botId },
      promptEnvelope: { sourceName: name },
    };
    const instruction = val('cn-instruction');
    if (instruction) body.promptEnvelope.instruction = instruction;
    if (kind === 'workflow') { if (!val('cn-wf')) { out.innerHTML = '<span class="err">请填工作流 ID</span>'; return; } body.target.workflowId = val('cn-wf'); }
    if (mode === 'fixed') {
      const manualVisible = ($('cn-chat') as HTMLInputElement).style.display !== 'none';
      const chatId = manualVisible ? val('cn-chat') : ($('cn-chat-sel') as HTMLSelectElement).value;
      if (!chatId) { out.innerHTML = '<span class="err">请选择（或手动填）投递的群</span>'; return; }
      body.target.chatId = chatId;
    } else {
      const picked = Array.from(($('cn-allow-sel') as HTMLSelectElement).selectedOptions).map(o => o.value).filter(Boolean);
      if (picked.length) body.target.allowChats = picked;
    }
    if (mode === 'new-group') {
      const dedup = val('cn-dedup');
      body.lifecycleExtractors = dedup ? { dedupKey: dedup } : null;
    }
    body.verify = { type: ($('cn-verify') as HTMLSelectElement).value };
    const secret = val('cn-secret'); if (secret) body.secret = secret;
    out.innerHTML = '<span class="muted">创建中…</span>';
    const r = await jsend('POST', '/api/connectors', body);
    if (r.status === 201 && r.body?.ok) {
      out.innerHTML = '';
      const created = $('cn-created'); created.style.display = '';
      const url = r.body.webhookUrl || webhookUrl(r.body.connector.id);
      const sec = r.body.secret;
      const isToken = (r.body.connector?.verify?.type ?? 'token') === 'token';
      const isDynamic = mode === 'dynamic';
      // For dynamic connectors the caller must pass a chat per request — build a
      // concrete example using a chosen allowed group (name shown for clarity).
      const exampleChat = isDynamic ? (body.target.allowChats?.[0] || '<群ID>') : '';
      const callUrl = isDynamic ? `${escapeHtml(url)}?chatId=${escapeHtml(exampleChat)}` : escapeHtml(url);
      let usage: string;
      if (isToken && isDynamic) {
        const gn = exampleChat !== '<群ID>' ? `（${escapeHtml(groupName(body.target.allowChats![0]))}）` : '';
        usage = `<p class="muted" style="font-size:12px;margin:6px 0 0">动态模式：URL 已含令牌，调用时再带上目标群 ID${gn}：</p>
        <pre style="margin:6px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-all"><code>curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'</code></pre>
        <p class="muted" style="font-size:12px;margin:6px 0 0">群也可放请求头 <code>x-botmux-chat-id</code> 或 body <code>{"chatId":"…"}</code>。⚠️ URL 即凭证，勿泄漏。</p>`;
      } else if (isToken) {
        usage = `<p class="muted" style="font-size:12px;margin:6px 0 0">此 URL 已含令牌、且固定投递到所选群，直接 POST 即可触发：</p>
        <pre style="margin:6px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-all"><code>curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'</code></pre>
        <p class="muted" style="font-size:12px;margin:6px 0 0">⚠️ URL 即凭证，请勿公开泄漏；可在下方列表删除或轮换。</p>`;
      } else {
        usage = `<p class="muted" style="font-size:12px;margin:6px 0 0">外部系统需对 <code>timestamp.body</code> 做 HMAC-SHA256 签名，并带上 <code>x-botmux-timestamp</code> / <code>x-botmux-nonce</code> / <code>x-botmux-signature</code> 头调用${isDynamic ? '，同时按上面方式带目标群 ID' : ''}。</p>`;
      }
      created.innerHTML = `<div class="card" style="padding:12px 14px;background:var(--bg-soft,#f6f7f9)">
        <p class="ok" style="margin:0 0 6px">已创建「${escapeHtml(name)}」${mode === 'fixed' && body.target.chatId ? `<span class="muted" style="font-weight:400;font-size:13px"> · 投递到「${escapeHtml(groupName(body.target.chatId))}」</span>` : ''}</p>
        <p style="margin:4px 0;font-size:13px"><span class="muted">Webhook URL：</span><code style="word-break:break-all">${escapeHtml(url)}</code></p>
        ${sec ? `<p style="margin:4px 0;font-size:13px"><span class="muted">${isToken ? '访问令牌' : '签名密钥'}（只显示这一次，请保存）：</span><code>${escapeHtml(sec)}</code></p>` : ''}
        ${usage}</div>`;
      (['cn-name', 'cn-wf', 'cn-chat', 'cn-dedup', 'cn-secret', 'cn-instruction'] as const).forEach(id => { ($(id) as HTMLInputElement).value = ''; });
      ($('cn-allow-sel') as HTMLSelectElement).selectedIndex = -1;
      load();
    } else {
      const e = r.body?.error || r.status;
      out.innerHTML = `<span class="err">创建失败：${escapeHtml(String(e))}</span>`;
    }
  };

  void load();
}
