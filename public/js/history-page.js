/**
 * History page: lists searches saved by js/history.js, grouped by day, with
 * "search again" links, per-entry delete, clear all, and the on/off switch.
 */

import {
  getHistory, removeFromHistory, clearHistory, historyUrl, describeEntry,
  isHistoryEnabled, setHistoryEnabled,
} from './history.js';

const list = document.getElementById('history-list');
const toggle = document.getElementById('history-toggle');
const clearBtn = document.getElementById('history-clear');
const status = document.getElementById('history-status');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dayFormat.format(d);
}

const ICON = {
  postcode: '<path d="M3.5 3.5h13v13h-13z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 8h6M7 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  device: '<circle cx="10" cy="10" r="3" fill="currentColor"/><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  map: '<path d="M10 17.5s-5.5-5-5.5-9a5.5 5.5 0 0 1 11 0c0 4-5.5 9-5.5 9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="8.5" r="2" fill="currentColor"/>',
};

function render() {
  const enabled = isHistoryEnabled();
  toggle.checked = enabled;
  const entries = getHistory();
  clearBtn.hidden = !entries.length;

  if (!entries.length) {
    list.innerHTML = `
      <div class="callout history-empty">
        <p><strong>${enabled ? 'No searches yet' : 'Search history is off'}</strong></p>
        <p>${enabled
          ? 'Places you search for will appear here, so you can check them again quickly.'
          : 'Turn on “Save search history” above to keep a list of places you search for on this device.'}</p>
        <p><a class="btn btn--primary" href="./">Search for ratings</a></p>
      </div>`;
    return;
  }

  // Group by day, keeping newest-first order
  const groups = [];
  for (const e of entries) {
    const label = dayLabel(e.at);
    if (!groups.length || groups.at(-1).label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(e);
  }

  list.innerHTML = groups.map((g, gi) => `
    <section class="history-day" aria-labelledby="day-${gi}">
      <h2 class="history-day__title" id="day-${gi}">${escapeHtml(g.label)}</h2>
      <ul class="history-list">
        ${g.items.map((e) => {
          const d = describeEntry(e);
          const idx = entries.indexOf(e);
          const meta = [d.area, d.filters].filter(Boolean).join(' · ');
          const count = e.total == null ? '' : `${e.total.toLocaleString('en-GB')} ${e.total === 1 ? 'place' : 'places'}`;
          return `<li class="history-item">
            <a class="history-item__link" href="${escapeHtml(historyUrl(e))}">
              <svg class="history-item__icon" viewBox="0 0 20 20" aria-hidden="true">${ICON[e.source]}</svg>
              <span class="history-item__text">
                <span class="history-item__title">${escapeHtml(d.title)}</span>
                <span class="history-item__meta">${escapeHtml(meta)}</span>
              </span>
              <span class="history-item__side">
                <time datetime="${new Date(e.at).toISOString()}">${timeFormat.format(e.at)}</time>
                ${count ? `<span>${escapeHtml(count)}</span>` : ''}
              </span>
            </a>
            <button type="button" class="icon-btn icon-btn--round history-item__remove" data-index="${idx}" aria-label="Remove ${escapeHtml(d.title)} from history">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            </button>
          </li>`;
        }).join('')}
      </ul>
    </section>`).join('');
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('.history-item__remove');
  if (!btn) return;
  const entries = getHistory();
  const entry = entries[Number(btn.dataset.index)];
  if (!entry) return;
  // Keep keyboard focus nearby: on the next item's remove button, else the previous one.
  const buttons = [...list.querySelectorAll('.history-item__remove')];
  const pos = buttons.indexOf(btn);
  removeFromHistory(entry);
  status.textContent = `Removed ${describeEntry(entry).title} from history.`;
  render();
  const after = [...list.querySelectorAll('.history-item__remove')];
  (after[pos] || after[pos - 1] || toggle).focus();
});

clearBtn.addEventListener('click', () => {
  if (!window.confirm('Clear your whole search history on this device?')) return;
  clearHistory();
  status.textContent = 'Search history cleared.';
  render();
  toggle.focus();
});

toggle.addEventListener('change', () => {
  setHistoryEnabled(toggle.checked);
  if (!toggle.checked) clearHistory();
  status.textContent = toggle.checked ? 'Search history is on.' : 'Search history is off, and saved searches were deleted.';
  render();
});

// Stay in sync if another tab adds or clears history.
window.addEventListener('storage', (e) => {
  if (e.key === null || e.key?.startsWith('foodcheck:history')) render();
});

render();
