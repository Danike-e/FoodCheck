/*
 * Applies the saved Light/Dark choice before the page paints, so there is no
 * flash of the wrong theme. Loaded as a tiny blocking script in <head> (the
 * Content Security Policy doesn't allow inline scripts). "System" = no attribute.
 */
(function () {
  try {
    var theme = localStorage.getItem('foodcheck:theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* storage blocked: follow the device */ }
})();
