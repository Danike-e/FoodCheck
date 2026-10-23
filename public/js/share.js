/**
 * Share panel with a QR code, shared by every page.
 *
 *   openShare({ heading, title, text, url, note })
 *
 * shows a dialog with a QR code for the link, a copy-link box, the device's
 * own share sheet (where supported), quick links to Messages, WhatsApp,
 * Email, Facebook and X, and a "Download QR code" PNG for printing.
 *
 * Any element with [data-share-app] opens it for FoodCheck itself.
 *
 * The QR encoder (vendor/qrcode, MIT) is loaded the first time the panel
 * opens, so pages don't pay for it up front. The code is drawn dark on
 * white with a full quiet zone in both themes, so it always scans.
 */

const QR_SCRIPT = 'vendor/qrcode/qrcode.js';
let qrLoading = null;
let dialog = null;
let current = null; // { url, title, ... } being shared

function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  qrLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = QR_SCRIPT;
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => { qrLoading = null; reject(new Error('QR encoder failed to load')); };
    document.head.append(s);
  });
  return qrLoading;
}

/** Encode text as a QR matrix: { size, dark(row, col) }. Medium error correction. */
async function encode(text) {
  const qrcode = await loadQr();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return { size: qr.getModuleCount(), dark: (r, c) => qr.isDark(r, c) };
}

const QUIET = 4; // modules of white border, per the QR spec

/** SVG markup for a QR matrix, merging runs of dark modules into one path. */
function qrSvg({ size, dark }) {
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!dark(r, c)) { c++; continue; }
      const start = c;
      while (c < size && dark(r, c)) c++;
      d += `M${start + QUIET} ${r + QUIET}h${c - start}v1h-${c - start}z`;
    }
  }
  const full = size + QUIET * 2;
  return `<svg viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${full}" height="${full}" fill="#fff"/><path d="${d}" fill="#141413"/></svg>`;
}

/** A PNG data URL of the QR code, large enough to print. */
function qrPng({ size, dark }, px = 1200) {
  const full = size + QUIET * 2;
  const scale = Math.floor(px / full);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = full * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#141413';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark(r, c)) ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}

const ICONS = {
  share: '<path d="M10 2.5v10M6 6l4-3.5L14 6M4.5 9.5v6.5h11V9.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 6.5V4.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  message: '<path d="M3 9.2C3 5.8 6.1 3.5 10 3.5s7 2.3 7 5.7-3.1 5.7-7 5.7c-.9 0-1.8-.1-2.6-.4L4 16l.9-3.2C3.7 11.8 3 10.6 3 9.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  whatsapp: '<path d="M10 2.8a7.2 7.2 0 0 0-6.2 10.9L2.8 17.2l3.6-1a7.2 7.2 0 1 0 3.6-13.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.4 6.9c.2-.4.5-.4.7-.4h.4c.2 0 .4.1.5.4l.6 1.4c.1.2 0 .4-.1.6l-.5.6c.6 1.1 1.5 2 2.6 2.6l.6-.5c.2-.1.4-.2.6-.1l1.4.6c.3.1.4.3.4.5v.4c0 .3-.1.6-.4.7-.5.3-1.2.5-1.9.3-1.9-.6-3.6-2.3-4.3-4.3-.2-.7 0-1.4.3-1.9z" fill="currentColor"/>',
  email: '<rect x="2.5" y="4.5" width="15" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 5.5l7 5.2 7-5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  facebook: '<path d="M11.2 17.5v-6.3h2.1l.3-2.5h-2.4V7.2c0-.7.2-1.2 1.2-1.2h1.3V3.8c-.2 0-1-.1-1.9-.1-1.9 0-3.2 1.2-3.2 3.3v1.8H6.5v2.5h2.1v6.3" fill="currentColor"/>',
  x: '<path d="M4 3.5h3.6l3.1 4.4 3.8-4.4h1.9l-4.8 5.5 5.4 7.5h-3.6l-3.4-4.7-4.1 4.7H4l5.1-5.9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  download: '<path d="M10 3v9.5M6 9l4 3.8L14 9M4 16.5h12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (name) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`;

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'dialog share';
  dialog.setAttribute('aria-labelledby', 'share-title');
  dialog.innerHTML = `
    <div class="dialog__inner">
      <div class="dialog__head">
        <h2 class="dialog__title" id="share-title">Share</h2>
        <button type="button" class="icon-btn icon-btn--round" data-share-close aria-label="Close">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <p class="share__subject"></p>
      <figure class="share__qr-wrap">
        <div class="share__qr" role="img"></div>
        <figcaption class="share__hint">Scan with a phone camera to open</figcaption>
      </figure>
      <p class="share__note" hidden></p>
      <div class="share__link">
        <label class="visually-hidden" for="share-url">Link to share</label>
        <input id="share-url" type="text" readonly spellcheck="false">
        <button type="button" class="btn btn--primary share__copy">${icon('copy')}<span>Copy</span></button>
      </div>
      <p class="share__status" role="status"></p>
      <button type="button" class="btn btn--outline share__native" hidden>${icon('share')}Share using your device</button>
      <ul class="share__targets" aria-label="Share to">
        <li><a class="share__target" data-target="sms">${icon('message')}<span>Messages</span></a></li>
        <li><a class="share__target" data-target="whatsapp" target="_blank" rel="noopener noreferrer">${icon('whatsapp')}<span>WhatsApp</span></a></li>
        <li><a class="share__target" data-target="email">${icon('email')}<span>Email</span></a></li>
        <li><a class="share__target" data-target="facebook" target="_blank" rel="noopener noreferrer">${icon('facebook')}<span>Facebook</span></a></li>
        <li><a class="share__target" data-target="x" target="_blank" rel="noopener noreferrer">${icon('x')}<span>X</span></a></li>
        <li><a class="share__target" data-target="download" download="foodcheck-qr.png">${icon('download')}<span>QR code</span></a></li>
      </ul>
    </div>`;
  document.body.append(dialog);

  const status = dialog.querySelector('.share__status');
  const input = dialog.querySelector('#share-url');

  dialog.querySelector('[data-share-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  input.addEventListener('focus', () => input.select());

  dialog.querySelector('.share__copy').addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(current.url);
      ok = true;
    } catch {
      input.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    status.textContent = ok ? 'Link copied.' : 'Couldn’t copy automatically. The link is selected, so copy it from there.';
  });

  dialog.querySelector('.share__native').addEventListener('click', async () => {
    try {
      await navigator.share({ title: current.title, text: current.text, url: current.url });
    } catch (err) {
      if (err.name !== 'AbortError') status.textContent = 'Sharing didn’t work here. Try copying the link instead.';
    }
  });
}

/** Fill the quick links for the current item. */
function setTargets() {
  const { url, title, text } = current;
  const message = text ? `${text} ${url}` : `${title} ${url}`;
  const e = encodeURIComponent;
  const hrefs = {
    sms: `sms:?&body=${e(message)}`,
    whatsapp: `https://wa.me/?text=${e(message)}`,
    email: `mailto:?subject=${e(title)}&body=${e(`${text || title}\n\n${url}`)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${e(url)}`,
    x: `https://x.com/intent/post?text=${e(text || title)}&url=${e(url)}`,
  };
  dialog.querySelectorAll('.share__target[data-target]').forEach((a) => {
    const target = a.dataset.target;
    if (hrefs[target]) a.href = hrefs[target];
  });
}

/**
 * Open the share panel.
 * @param {object} opts
 * @param {string} opts.heading  dialog heading, e.g. "Share these results"
 * @param {string} opts.title    short title (email subject, share sheet title)
 * @param {string} [opts.text]   message to go with the link
 * @param {string} opts.url      absolute URL to share
 * @param {string} [opts.note]   privacy note shown above the link (e.g. "includes your approximate location")
 */
export async function openShare(opts) {
  if (!dialog) buildDialog();
  current = opts;
  const qrBox = dialog.querySelector('.share__qr');
  const download = dialog.querySelector('[data-target="download"]');
  const note = dialog.querySelector('.share__note');

  dialog.querySelector('#share-title').textContent = opts.heading || 'Share';
  dialog.querySelector('.share__subject').textContent = opts.text || opts.title;
  dialog.querySelector('#share-url').value = opts.url;
  dialog.querySelector('.share__status').textContent = '';
  note.hidden = !opts.note;
  note.textContent = opts.note || '';
  dialog.querySelector('.share__native').hidden = !(navigator.share && (!navigator.canShare || navigator.canShare({ url: opts.url })));
  qrBox.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  qrBox.setAttribute('aria-label', 'QR code loading');
  download.removeAttribute('href');
  setTargets();

  if (!dialog.open) dialog.showModal();

  try {
    const matrix = await encode(opts.url);
    if (current !== opts) return; // another share was opened meanwhile
    qrBox.innerHTML = qrSvg(matrix);
    qrBox.setAttribute('aria-label', `QR code for ${opts.url}`);
    download.href = qrPng(matrix);
    download.download = `foodcheck-qr-${(opts.title || 'link').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.png`;
  } catch {
    qrBox.innerHTML = '<p class="share__qr-error">QR code unavailable offline. You can still copy the link.</p>';
    qrBox.setAttribute('aria-label', 'QR code unavailable');
  }
}

/** The app's own address (the folder FoodCheck is served from). */
export function appUrl() {
  return new URL('./', document.baseURI).href;
}

// "Share FoodCheck" buttons anywhere on the page
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-share-app]');
  if (!btn) return;
  e.preventDefault();
  openShare({
    heading: 'Share FoodCheck',
    title: 'FoodCheck: food hygiene ratings near you',
    text: 'Check the food hygiene rating of anywhere near you, free, on a map and in a list.',
    url: appUrl(),
  });
});
