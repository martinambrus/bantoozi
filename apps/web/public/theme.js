/* global window, document -- a classic script, run by the browser before the app starts */
(function () {
  try {
    const stored = window.localStorage.getItem('bantoozi:theme');
    const dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch {
    // Without readable storage the app applies the theme once it has started.
  }
})();
