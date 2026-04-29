import { store } from './store.js';

const PAGE_HTML = `
<form id="sched-filters" class="filters">
  <input type="search" name="q" placeholder="search name / prompt / workingDir" />
  <select name="kind">
    <option value="">any kind</option>
    <option>cron</option>
    <option>interval</option>
    <option>once</option>
  </select>
  <label><input type="checkbox" name="enabled"> enabled only</label>
</form>
<table>
  <thead><tr>
    <th>name</th><th>bot</th><th>schedule</th><th>next</th><th>last</th>
    <th>repeat</th><th>enabled</th><th>actions</th>
  </tr></thead>
  <tbody id="schedules-tbody"></tbody>
</table>
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch { return s; }
}

export function renderSchedulesPage(root: HTMLElement) {
  root.innerHTML = PAGE_HTML;
  const tbody = root.querySelector<HTMLElement>('#schedules-tbody')!;
  const form = root.querySelector<HTMLFormElement>('#sched-filters')!;

  function filtered(): any[] {
    const f = new FormData(form);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const kind = f.get('kind') as string;
    const enabledOnly = !!f.get('enabled');
    return [...store.schedules.values()]
      .filter(s => !kind || s.parsed?.kind === kind)
      .filter(s => !enabledOnly || s.enabled)
      .filter(s => !q || JSON.stringify(s).toLowerCase().includes(q))
      .sort((a, b) => {
        // enabled first, then earliest nextRunAt
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const aN = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
        const bN = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
        return aN - bN;
      });
  }

  function rerender() {
    tbody.innerHTML = filtered().map(s => `<tr data-id="${escapeHtml(s.id)}">
      <td>${escapeHtml(s.name ?? s.id)}</td>
      <td>${escapeHtml(s.botName ?? s.larkAppId ?? '-')}</td>
      <td><code>${escapeHtml(s.parsed?.display ?? '?')}</code></td>
      <td>${fmtDate(s.nextRunAt)}</td>
      <td>${fmtDate(s.lastRunAt)} ${s.lastStatus === 'error' ? '⚠️' : ''}</td>
      <td>${s.repeat ? `${s.repeat.completed}/${s.repeat.times ?? '∞'}` : '—'}</td>
      <td>${s.enabled ? '✓' : '✗'}</td>
      <td class="actions-cell">
        <button data-op="run" type="button">Run now</button>
        ${s.enabled
          ? `<button data-op="pause" type="button">Pause</button>`
          : `<button data-op="resume" type="button">Resume</button>`}
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No schedules.</td></tr>';
  }

  tbody.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-op]');
    if (!btn) return;
    const tr = btn.closest<HTMLTableRowElement>('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id!;
    const op = btn.dataset.op!;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '...';
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        alert(`Failed: ${r.status} ${body?.error ?? ''}`.trim());
      }
    } catch (err) {
      alert('Network error: ' + err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  form.addEventListener('input', rerender);
  store.on(rerender);
  rerender();
}
