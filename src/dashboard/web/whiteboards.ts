import { escapeHtml } from './ui.js';

interface WhiteboardRow {
  id: string;
  title: string;
  scope: string;
  larkAppId?: string;
  chatId?: string;
  workingDir?: string;
  updatedAt: string;
  path: string;
  preview: string;
  logCount: number;
}

interface SelectedBoard { id: string; content: string; row?: WhiteboardRow }

function rel(ts: string): string {
  const t = Date.parse(ts);
  if (!t) return ts || '-';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function groupKey(r: WhiteboardRow): string {
  return r.chatId?.trim() || '__local__';
}

function groupLabel(chatId: string): string {
  return chatId === '__local__' ? '未绑定群 / 本地白板' : chatId;
}

function groupedRows(rows: WhiteboardRow[]): Array<{ chatId: string; label: string; rows: WhiteboardRow[] }> {
  const map = new Map<string, WhiteboardRow[]>();
  for (const r of rows) {
    const key = groupKey(r);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([chatId, list]) => ({
      chatId,
      label: groupLabel(chatId),
      rows: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function boardItem(r: WhiteboardRow, selectedId?: string): string {
  const active = r.id === selectedId;
  return `<a class="wb-item${active ? ' active' : ''}" href="#/whiteboards/${encodeURIComponent(r.id)}" style="display:block;text-decoration:none;color:inherit;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:10px;padding:10px 12px;margin:8px 0 8px 18px;background:${active ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'var(--surface-2,#fff)'}">
    <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
      <strong>${escapeHtml(r.title || r.id)}</strong>
      <code>${escapeHtml(r.id)}</code>
    </div>
    <div style="margin-top:6px;color:var(--muted);font-size:12px">${escapeHtml(r.scope)} · ${escapeHtml(r.workingDir || '-')} · ${escapeHtml(rel(r.updatedAt))} · log ${r.logCount}</div>
  </a>`;
}

function pageHtml(enabled: boolean, rows: WhiteboardRow[], selected?: SelectedBoard): string {
  const groups = groupedRows(rows);
  const selectedRow = selected?.row;
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">Whiteboards</p>
        <h1>本地白板</h1>
        <p>项目级本地上下文与跨 agent 交接记录。开关关闭时仅只读展示历史白板，不注入 prompt、不允许 agent CLI 读写。</p>
      </div>
      <span class="pill ${enabled ? 'ok' : 'warn'}">${enabled ? 'Enabled' : 'Disabled'}</span>
    </div>
    ${enabled ? '' : '<p class="hint-warn">白板能力当前关闭：不会自动创建/绑定白板，也不会注入到 agent prompt。历史白板仅在 dashboard 中只读可见，可在此清理。</p>'}
    <div class="wb-split" style="display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:16px;align-items:start">
      <article class="bd-card settings-card">
        <h3 class="bd-section-title">群组 / 白板</h3>
        ${groups.length === 0 ? '<p class="empty">暂无白板。打开能力后，首次需要白板时才会创建默认白板。</p>' : groups.map(g => `
          <details class="wb-group" open>
            <summary style="cursor:pointer;font-weight:700;margin:12px 0 6px;display:flex;justify-content:space-between;gap:8px">
              <span>${escapeHtml(g.label)}</span><small>${g.rows.length}</small>
            </summary>
            ${g.rows.map(r => boardItem(r, selected?.id)).join('')}
          </details>`).join('')}
      </article>
      <article class="bd-card settings-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <h3 class="bd-section-title">白板详情</h3>
          ${selected ? '<button type="button" class="danger" data-delete-whiteboard>删除白板</button>' : ''}
        </div>
        ${selected ? `
          <dl class="wb-meta" style="display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;font-size:13px">
            <dt>ID</dt><dd><code>${escapeHtml(selected.id)}</code></dd>
            <dt>Title</dt><dd>${escapeHtml(selectedRow?.title ?? '-')}</dd>
            <dt>Scope</dt><dd>${escapeHtml(selectedRow?.scope ?? '-')}</dd>
            <dt>Chat</dt><dd>${escapeHtml(selectedRow?.chatId ?? '未绑定群 / 本地白板')}</dd>
            <dt>App</dt><dd>${escapeHtml(selectedRow?.larkAppId ?? '-')}</dd>
            <dt>WorkingDir</dt><dd style="word-break:break-all">${escapeHtml(selectedRow?.workingDir ?? '-')}</dd>
            <dt>Updated</dt><dd>${escapeHtml(selectedRow?.updatedAt ? rel(selectedRow.updatedAt) : '-')}</dd>
            <dt>Path</dt><dd style="word-break:break-all"><code>${escapeHtml(selectedRow?.path ?? '')}</code></dd>
          </dl>
          <h4 style="margin-top:18px">board.md</h4>
          <pre style="white-space:pre-wrap;max-height:70vh;overflow:auto">${escapeHtml(selected.content)}</pre>` : '<p class="empty">选择左侧白板查看 meta 和 board.md。</p>'}
      </article>
    </div>
  </section>`;
}

export async function renderWhiteboardsPage(root: HTMLElement): Promise<void> {
  root.innerHTML = '<p class="empty">Loading whiteboards…</p>';
  const selectedId = decodeURIComponent((location.hash.match(/^#\/whiteboards\/([^/]+)/)?.[1] ?? '').trim());
  try {
    const r = await fetch('/api/whiteboards');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    const rows: WhiteboardRow[] = Array.isArray(body.whiteboards) ? body.whiteboards : [];
    let selected: SelectedBoard | undefined;
    if (selectedId) {
      const sr = await fetch(`/api/whiteboards/${encodeURIComponent(selectedId)}`);
      const sb = await sr.json().catch(() => ({}));
      if (sr.ok) selected = { id: selectedId, content: String(sb.content ?? ''), row: rows.find(r => r.id === selectedId) };
    }
    root.innerHTML = pageHtml(body.enabled === true, rows, selected);
    wireDelete(root, selectedId);
  } catch (err: any) {
    root.innerHTML = `<section class="page"><p class="hint-warn">加载白板失败：${escapeHtml(err?.message ?? String(err))}</p></section>`;
  }
}

function wireDelete(root: HTMLElement, selectedId: string): void {
  const btn = root.querySelector<HTMLButtonElement>('[data-delete-whiteboard]');
  if (!btn || !selectedId) return;
  btn.addEventListener('click', async () => {
    if (!window.confirm(`确认删除白板 ${selectedId}？此操作会删除 board/log/meta，并清理绑定。`)) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/api/whiteboards/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      location.hash = '#/whiteboards';
      await renderWhiteboardsPage(root);
    } catch (err: any) {
      alert(`删除失败：${err?.message ?? String(err)}`);
      btn.disabled = false;
    }
  });
}
