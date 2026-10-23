/**
 * "See how it works" animation on the About page.
 *
 * Real screenshots of FoodCheck, shown in an iPhone frame, with a finger
 * marker that taps and presses where a person would. Each scene shows one
 * screenshot, waits, then moves the finger to the next control and taps
 * (or presses and holds), which leads to the next screenshot.
 *
 * Accessibility: the steps are a real list beside the phone, and selecting
 * one jumps to it. There's a Pause / Play button (WCAG 2.2.2). The animation
 * doesn't autoplay when the device asks for reduced motion, and it stops
 * while off screen or in a background tab.
 */

// x / y are percentages of the app screen (captured from the real layout).
const SCENES = [
  { frame: 0, step: 0, dwell: 1100, action: { x: 37, y: 18.3, kind: 'tap' } },     // tap the postcode box
  { frame: 1, step: 0, dwell: 800, action: { x: 84.1, y: 18.3, kind: 'tap' } },    // tap Search
  { frame: 2, step: 1, dwell: 2200, action: { x: 46.3, y: 85.3, kind: 'tap' } },   // tap a place in the list
  { frame: 3, step: 2, dwell: 2000, action: { x: 12, y: 21, kind: 'hold' } },      // press and hold the map
  { frame: 4, step: 3, dwell: 2000, action: { x: 92.5, y: 3.8, kind: 'tap' } },    // tap full screen
  { frame: 5, step: 4, dwell: 3200, action: null },
];

const MOVE_MS = 650;   // finger travel (matches the CSS transition)
const TAP_MS = 380;
const HOLD_MS = 1100;

const root = document.getElementById('how');
const frames = [...root.querySelectorAll('.demo-frame')];
const touch = document.getElementById('demo-touch');
const steps = [...root.querySelectorAll('.demo-steps__item')];
const toggle = document.getElementById('demo-toggle');
const caption = document.getElementById('demo-caption');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let scene = 0;
let runId = 0;                     // bumping this cancels the running timeline
let userPaused = reducedMotion;    // reduced motion: start paused, the person can press Play
let onScreen = false;
let tabVisible = !document.hidden;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showFrame(i) {
  frames.forEach((img, n) => img.classList.toggle('is-active', n === i));
}

function showStep(stepIndex) {
  steps.forEach((li, n) => {
    if (n === stepIndex) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  caption.textContent = `${stepIndex + 1}. ${steps[stepIndex].querySelector('strong').textContent}`;
}

function placeTouch(action, { visible = true } = {}) {
  if (!action) { touch.classList.remove('is-visible'); return; }
  touch.style.left = `${action.x}%`;
  touch.style.top = `${action.y}%`;
  touch.classList.toggle('is-visible', visible);
}

/** Show a scene without animating (used when paused, or when jumping to a step). */
function renderStatic(i) {
  scene = i;
  const s = SCENES[i];
  showFrame(s.frame);
  showStep(s.step);
  touch.classList.add('no-move');
  placeTouch(s.action);
  touch.offsetWidth; // apply the position before re-enabling the transition
  touch.classList.remove('no-move');
}

async function play(from) {
  const id = ++runId;
  const alive = () => id === runId;
  let i = from;
  for (;;) {
    const s = SCENES[i];
    scene = i;
    showFrame(s.frame);
    showStep(s.step);
    await sleep(s.dwell);
    if (!alive()) return;

    if (s.action) {
      placeTouch(s.action); // CSS transition moves the finger there
      await sleep(MOVE_MS);
      if (!alive()) return;
      const cls = s.action.kind === 'hold' ? 'is-holding' : 'is-tapping';
      touch.classList.add(cls);
      await sleep(s.action.kind === 'hold' ? HOLD_MS : TAP_MS);
      touch.classList.remove(cls);
      if (!alive()) return;
    }

    i = (i + 1) % SCENES.length;
    if (i === 0) {
      // Loop: fade the finger out and start again from the first screen.
      touch.classList.remove('is-visible');
      await sleep(600);
      if (!alive()) return;
    }
  }
}

function stop() {
  runId++;
  touch.classList.remove('is-tapping', 'is-holding');
}

function shouldRun() {
  return !userPaused && onScreen && tabVisible;
}

function update() {
  if (shouldRun()) {
    if (!root.classList.contains('is-playing')) {
      root.classList.add('is-playing');
      play(scene);
    }
  } else if (root.classList.contains('is-playing')) {
    root.classList.remove('is-playing');
    stop();
    renderStatic(scene);
  }
}

function setUserPaused(paused) {
  userPaused = paused;
  toggle.querySelector('span').textContent = paused ? 'Play animation' : 'Pause animation';
  root.classList.toggle('is-paused', paused);
  update();
}

toggle.addEventListener('click', () => setUserPaused(!userPaused));

steps.forEach((li, n) => {
  li.querySelector('button').addEventListener('click', () => {
    const first = SCENES.findIndex((s) => s.step === n);
    stop();
    root.classList.remove('is-playing');
    renderStatic(first);
    // Let the chosen step sit for a moment before the animation carries on.
    if (shouldRun()) setTimeout(update, 1200);
  });
});

new IntersectionObserver(([entry]) => {
  onScreen = entry.isIntersecting;
  update();
}, { threshold: 0.35 }).observe(root.querySelector('.iphone'));

document.addEventListener('visibilitychange', () => {
  tabVisible = !document.hidden;
  update();
});

renderStatic(0);
setUserPaused(userPaused);
