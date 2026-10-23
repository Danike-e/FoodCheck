/**
 * Settings dialog: appearance (match device / light / dark) and clearing the
 * data FoodCheck keeps on this device. Uses the native <dialog> element, which
 * handles focus trapping, Escape to close and returning focus to the opener.
 */

import { isHistoryEnabled, setHistoryEnabled, clearHistory } from './history.js';

const THEME_KEY = 'foodcheck:theme';
// Clearing data must not quietly switch history back on.
const KEEP_ON_CLEAR = ['foodcheck:historyOff'];
const THEME_COLOURS = { light: '#FAF9F5', dark: '#1F1E1D' };

function readTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Apply a theme choice to the page and remember it. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');

  // Keep the browser / iOS status bar colour in step with the choice.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = THEME_COLOURS[theme === 'system' ? scheme : theme];
  }

  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* storage blocked: the choice lasts for this visit */ }
}

/** Remove everything FoodCheck stores on this device (except the offline app files). */
async function clearSavedData() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('foodcheck:') && !KEEP_ON_CLEAR.includes(k))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* nothing stored */ }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('foodcheck-runtime')).map((k) => caches.delete(k)));
  }
  applyTheme('system');
}

/**
 * @param {{ onHistoryChange?: () => void }} [opts]  called when history is cleared or switched off
 */
export function initSettings({ onHistoryChange = () => {} } = {}) {
  const dialog = document.getElementById('settings');
  const openers = document.querySelectorAll('[data-open-settings]');
  const radios = dialog.querySelectorAll('input[name="theme"]');
  const clearBtn = document.getElementById('clear-data');
  const clearStatus = document.getElementById('clear-status');
  const historyToggle = document.getElementById('history-toggle');

  const syncRadios = () => {
    const current = readTheme();
    radios.forEach((r) => { r.checked = r.value === current; });
  };

  openers.forEach((btn) => btn.addEventListener('click', () => {
    syncRadios();
    historyToggle.checked = isHistoryEnabled();
    clearStatus.textContent = '';
    dialog.showModal();
  }));

  radios.forEach((r) => r.addEventListener('change', () => applyTheme(r.value)));

  historyToggle.addEventListener('change', () => {
    setHistoryEnabled(historyToggle.checked);
    if (!historyToggle.checked) clearHistory(); // turning it off also forgets what was saved
    clearStatus.textContent = historyToggle.checked
      ? 'Search history is on.'
      : 'Search history is off, and your saved searches have been deleted.';
    onHistoryChange();
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    await clearSavedData();
    syncRadios();
    onHistoryChange();
    clearBtn.disabled = false;
    clearStatus.textContent = 'Done. Your settings, search history and saved results have been removed from this device.';
  });

  // Clicking the dimmed backdrop closes the dialog (the dialog box itself is the only child area).
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  // Follow the device if it switches while "Match device" is selected.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (readTheme() === 'system') applyTheme('system');
  });

  applyTheme(readTheme());
}
