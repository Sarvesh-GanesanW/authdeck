// The page colours, on every page. Runs in the head, before the page paints, so it opens in the
// right colours: the visitor's last choice, otherwise Paper for a light system and Graphite for a
// dark one. Once the page is parsed, the swatches in the header switch colourways and remember
// the choice in localStorage (the only thing the site stores).
(function () {
  var KEY = 'authdeck-colorway';
  var THEME_COLORS = { graphite: '#22262E', paper: '#D9D3C5', tide: '#1D2B33' };

  function savedColorway() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function applyColorway(id) {
    document.documentElement.setAttribute('data-colorway', id);
    var swatches = document.querySelectorAll('[data-set-colorway]');
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].setAttribute('aria-checked', String(swatches[i].getAttribute('data-set-colorway') === id));
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[id]);
  }

  function setupSwatches() {
    applyColorway(document.documentElement.getAttribute('data-colorway'));
    document.querySelector('.colorways').addEventListener('click', function (event) {
      var swatch = event.target.closest('[data-set-colorway]');
      if (!swatch) return;
      var id = swatch.getAttribute('data-set-colorway');
      applyColorway(id);
      try {
        window.localStorage.setItem(KEY, id);
      } catch (e) {
        // Private windows can refuse storage; the choice then lasts until the page closes.
      }
    });
  }

  var chosen = savedColorway();
  if (!Object.prototype.hasOwnProperty.call(THEME_COLORS, chosen)) {
    var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    chosen = light ? 'paper' : 'graphite';
  }
  document.documentElement.setAttribute('data-colorway', chosen);
  document.addEventListener('DOMContentLoaded', setupSwatches);
})();
