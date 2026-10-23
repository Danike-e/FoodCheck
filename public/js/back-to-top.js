/**
 * "Back to top" button for phones and tablets, shared by every page.
 *
 * It appears in the bottom-right corner once you've scrolled about a screen
 * and a half down, and scrolls smoothly back to the top (instantly with
 * reduced motion). Focus moves to the logo at the top, so keyboard and
 * screen-reader users land in the same place. It's hidden on desktop by CSS:
 * there the results list scrolls inside its own panel.
 */

const SHOW_AFTER = () => window.innerHeight * 1.5;

const button = document.createElement('button');
button.type = 'button';
button.className = 'to-top';
button.setAttribute('aria-label', 'Back to top');
button.title = 'Back to top';
button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4.5M4.5 9.5L10 4l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
document.body.append(button);

let ticking = false;
function update() {
  ticking = false;
  button.classList.toggle('is-visible', window.scrollY > SHOW_AFTER());
}

window.addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(update);
  }
}, { passive: true });
window.addEventListener('resize', update, { passive: true });

button.addEventListener('click', () => {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  document.querySelector('.brand')?.focus({ preventScroll: true });
});

update();
