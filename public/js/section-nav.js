/**
 * "Where am I on this page" indicator, shared by every page.
 *
 *  - A pill in the top-right corner shows the current section's name and a
 *    ring that fills as you scroll. When you reach a new section, the name
 *    slides out and the new one slides in (up or down, matching your scroll
 *    direction). Tapping it opens a list of every section to jump to.
 *  - On wide screens, text pages (privacy, terms, …) get an "On this page"
 *    sidebar instead, with the current section highlighted and a progress line.
 *
 * Sections are elements marked with data-section="Label", or, on pages
 * without any, the main h1/h2 headings. They're re-read on every update, so
 * content that changes (like the History list) is picked up automatically.
 *
 * Accessibility: nothing is announced while scrolling (it would be noisy).
 * The pill is a button with a descriptive name; the list is a normal set of
 * links; Escape or a click outside closes it and focus returns to the pill.
 */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isAppPage = !!document.querySelector('.layout'); // the search page

// ---------- Build the UI ----------

const root = document.createElement('div');
root.className = 'secnav';
if (isAppPage) root.classList.add('secnav--app');
root.innerHTML = `
  <button type="button" class="secnav__pill" aria-expanded="false" aria-controls="secnav-menu">
    <svg class="secnav__ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="secnav__track" cx="12" cy="12" r="9"/>
      <circle class="secnav__bar" cx="12" cy="12" r="9"/>
    </svg>
    <span class="secnav__label" aria-hidden="true"><span class="secnav__text"></span></span>
    <svg class="secnav__chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <nav class="secnav__menu" id="secnav-menu" aria-label="Sections on this page" hidden>
    <p class="secnav__menu-title" aria-hidden="true">On this page</p>
    <ol class="secnav__list"></ol>
  </nav>`;
document.body.append(root);

const rail = document.createElement('nav');
rail.className = 'secrail';
rail.setAttribute('aria-label', 'On this page');
rail.innerHTML = '<p class="secrail__title">On this page</p><ol class="secrail__list"></ol>';
const useRail = document.body.classList.contains('doc-page') && !document.body.classList.contains('landing-page');
if (useRail) {
  document.body.classList.add('has-secrail');
  document.body.append(rail);
}

const pill = root.querySelector('.secnav__pill');
const menu = root.querySelector('.secnav__menu');
const menuList = root.querySelector('.secnav__list');
const railList = rail.querySelector('.secrail__list');
const label = root.querySelector('.secnav__label');
const bar = root.querySelector('.secnav__bar');
const CIRC = 2 * Math.PI * 9;
bar.style.strokeDasharray = `${CIRC}`;

// ---------- Sections ----------

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';

function getSections() {
  let els = [...document.querySelectorAll('[data-section]')];
  if (!els.length) els = [...document.querySelectorAll('main h1, main h2')];
  return els
    .filter((el) => el.getClientRects().length) // skip hidden ones
    .map((el) => {
      if (!el.id) el.id = `sec-${slug(el.textContent)}`;
      return { el, id: el.id, label: (el.dataset.section || el.textContent).trim().replace(/\s+/g, ' ') };
    });
}

/** Height covered at the top of the screen by sticky things (the map on the phone search page). */
function stickyTop() {
  const map = document.querySelector('.map-pane');
  if (map && getComputedStyle(map).position === 'sticky') return Math.max(0, map.getBoundingClientRect().bottom);
  return 0;
}

let sections = [];
let currentIndex = -1;
let lastY = window.scrollY;
let listKey = '';
// After a jump from the menu or sidebar, keep that section marked until the person scrolls
// themselves (otherwise a short last section can't be selected: reaching the bottom of the
// page would mark the final section instead).
let pinnedId = null;
for (const type of ['wheel', 'touchstart', 'keydown']) {
  window.addEventListener(type, () => { pinnedId = null; }, { passive: true });
}

function renderLists() {
  const key = sections.map((s) => s.id + s.label).join('|');
  if (key === listKey) return;
  listKey = key;
  const items = sections.map((s) => `<li><a href="#${s.id}" data-id="${s.id}"></a></li>`).join('');
  menuList.innerHTML = items;
  railList.innerHTML = items;
  // Labels set as text (they come from page content)
  for (const list of [menuList, railList]) {
    list.querySelectorAll('a').forEach((a, i) => { a.textContent = sections[i].label; });
  }
  currentIndex = -1; // force the current marker to be re-applied
}

// ---------- Label animation ----------

function setLabel(text, direction) {
  const current = label.querySelector('.secnav__text:not(.is-leaving)');
  if (current && current.textContent === text) return;
  if (!current || reducedMotion() || !label.animate) {
    label.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'secnav__text';
    span.textContent = text;
    label.append(span);
    return;
  }
  const from = label.getBoundingClientRect().width;
  const next = document.createElement('span');
  next.className = 'secnav__text';
  next.textContent = text;
  current.classList.add('is-leaving');
  label.append(next);
  const to = next.getBoundingClientRect().width;
  const ease = 'cubic-bezier(.2, .8, .2, 1)';
  label.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 280, easing: ease });
  current.animate(
    [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-direction * 100}%)`, opacity: 0 }],
    { duration: 200, easing: 'ease-in', fill: 'forwards' },
  ).onfinish = () => current.remove();
  next.animate(
    [{ transform: `translateY(${direction * 100}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
    { duration: 280, easing: ease },
  );
}

// ---------- Scroll tracking ----------

function update() {
  ticking = false;
  sections = getSections();
  renderLists();

  const docH = document.documentElement.scrollHeight;
  const maxScroll = Math.max(1, docH - window.innerHeight);
  const y = window.scrollY;
  const progress = Math.min(1, Math.max(0, y / maxScroll));
  bar.style.strokeDashoffset = `${CIRC * (1 - progress)}`;
  rail.style.setProperty('--progress', progress.toFixed(4));

  // Only worth showing on pages that scroll a fair way, once you've started scrolling.
  const worthIt = sections.length >= 2 && docH > window.innerHeight * 1.6;
  // On the phone search page, wait until the map has stuck to the top, so the pill sits
  // over the map (between its buttons) rather than over the search form.
  const map = isAppPage && document.querySelector('.map-pane');
  const ready = map ? map.getBoundingClientRect().top <= 1 && stickyTop() > 0 : y > 140;
  root.classList.toggle('is-visible', worthIt && ready);
  if (!(worthIt && ready)) closeMenu({ focusPill: false });
  rail.classList.toggle('is-visible', worthIt && sections.length >= 3);
  if (!worthIt || !sections.length) return;

  // The current section is the last one whose top has passed a reading line
  // a little below the top of the visible area (below any sticky map).
  const top = stickyTop();
  const line = top + (window.innerHeight - top) * 0.3;
  let index = 0;
  sections.forEach((s, i) => { if (s.el.getBoundingClientRect().top <= line) index = i; });
  if (y >= maxScroll - 2) index = sections.length - 1; // at the very bottom
  const pinned = pinnedId ? sections.findIndex((s) => s.id === pinnedId) : -1;
  if (pinned !== -1) index = pinned;

  const direction = y >= lastY ? 1 : -1;
  lastY = y;
  if (index !== currentIndex) {
    currentIndex = index;
    const s = sections[index];
    setLabel(s.label, direction);
    pill.setAttribute('aria-label', `On this page: ${s.label}, section ${index + 1} of ${sections.length}. Show all sections`);
    for (const list of [menuList, railList]) {
      list.querySelectorAll('a').forEach((a, i) => {
        if (i === index) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    }
  }
}

let ticking = false;
const schedule = () => {
  if (!ticking) { ticking = true; requestAnimationFrame(update); }
};
window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', schedule, { passive: true });
// Content that changes height (results loading, History edits) shifts sections.
new ResizeObserver(schedule).observe(document.body);

// ---------- Menu ----------

function openMenu() {
  menu.hidden = false;
  pill.setAttribute('aria-expanded', 'true');
  (menu.querySelector('[aria-current]') || menu.querySelector('a'))?.focus();
  document.addEventListener('click', onOutside, true);
}

function closeMenu({ focusPill = true } = {}) {
  if (menu.hidden) return;
  menu.hidden = true;
  pill.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onOutside, true);
  if (focusPill) pill.focus();
}

function onOutside(e) {
  if (!root.contains(e.target)) closeMenu({ focusPill: false });
}

pill.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
root.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    e.stopPropagation();
    closeMenu();
  }
});

/** Jump to a section: smooth scroll (instant with reduced motion), then move focus there. */
function jumpTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (!target.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: true });
}

for (const list of [menuList, railList]) {
  list.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-id]');
    if (!a) return;
    e.preventDefault(); // keep the URL as it is (the search page stores its state there)
    closeMenu({ focusPill: false });
    pinnedId = a.dataset.id;
    jumpTo(a.dataset.id);
    schedule();
  });
}

update();
