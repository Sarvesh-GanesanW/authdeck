// The home page's behaviour (colorway.js handles the colours): the download button that matches the
// visitor's system, the sample deck in the hero (with its opening press and idle demo), the sample
// codes, the env section's one-time replay, and copying checksums.
// Everything here is a demo: no code on this page talks to a computer or makes real 2FA codes.
'use strict';

(function () {
  var CODE_PERIOD_S = 30;
  var TIMER_STEP_S = 2;
  var ENDING_S = 5;
  var STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
  var ACTIVITY_ROWS = 3;
  var COPIED_MS = 1600;
  // Key motion, matching --press and the spring-back animation in style.css.
  var PRESS_MS = 60;
  var RELEASE_MS = 120;
  // The deck powers on in CSS (three rows, about 420 ms); then the first key presses itself.
  var INTRO_PRESS_MS = 460;
  // The idle demo: how long the deck must sit untouched on screen, the pace, and when it gives up.
  var IDLE_START_MS = 3000;
  var IDLE_STEP_MS = 2500;
  var IDLE_MAX_PRESSES = 12;
  // Keys the idle demo presses, by position in the deck; hidden keys (small screens) are skipped.
  var IDLE_ORDER = [1, 2, 4, 3, 5, 9, 6, 11, 0, 7, 8, 10];
  // The env section's replay.
  var TYPE_MS = 16;
  var ENV_VISIBLE_RATIO = 0.5;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var live = document.createElement('p');
  live.className = 'sr';
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);

  function announce(text) {
    live.textContent = '';
    window.setTimeout(function () { live.textContent = text; }, 50);
  }

  // ---------- The download button ----------

  /** The visitor's system, as far as the browser says: mac, windows, linux, android, ios or null. */
  function detectSystem() {
    var ua = navigator.userAgent || '';
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/CrOS/.test(ua) || /Chrome OS/.test(platform)) return null;
    if (/Mac/.test(platform) || /Mac OS X/.test(ua)) return 'mac';
    if (/Win/.test(platform) || /Windows/.test(ua)) return 'windows';
    if (/Linux|X11/.test(platform) || /Linux|X11/.test(ua)) return 'linux';
    return null;
  }

  /** The graphics chip's name, which tells Intel Macs from Apple silicon; empty when the browser won't say. */
  function webglRenderer() {
    var gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    var info = gl.getExtension('WEBGL_debug_renderer_info');
    var renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    var lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return renderer;
  }

  /** 'intel' when the graphics chip is Intel or AMD; otherwise 'arm', since every Mac sold since 2023 is Apple silicon. */
  function macChip() {
    return /Intel|AMD|Radeon/i.test(webglRenderer()) ? 'intel' : 'arm';
  }

  var MAC = {
    arm: { file: 'mac-arm64', rows: ['mac-arm64'], label: 'Download for macOS', other: 'Intel Macs, other systems and the phone app' },
    intel: { file: 'mac-x64', rows: ['mac-x64'], label: 'Download for macOS (Intel)', other: 'Apple silicon Macs, other systems and the phone app' },
  };

  var PRIMARY = {
    windows: { file: 'win-x64', rows: ['win-x64'], label: 'Download for Windows', other: 'Other systems and the phone app' },
    linux: { file: 'linux-appimage', rows: ['linux-appimage', 'linux-deb'], label: 'Download for Linux', other: 'The .deb, other systems and the phone app' },
    android: { file: 'android-arm64', rows: ['android-arm64', 'android-universal'], label: 'Download for Android', other: 'The agent for your computer and other systems' },
    ios: { file: null, rows: ['ios-unsigned'], label: 'See the downloads', other: null },
  };

  function setupPrimaryDownload() {
    var data = JSON.parse(document.getElementById('downloads-data').textContent);
    var system = detectSystem();
    var choice = system === 'mac' ? MAC[macChip()] : PRIMARY[system];
    if (!choice) return;
    var button = document.getElementById('primary-download');
    var other = document.getElementById('primary-other');
    document.getElementById('primary-label').textContent = choice.label;
    if (choice.file && data[choice.file]) {
      button.setAttribute('href', data[choice.file].href);
      button.setAttribute('download', '');
      button.setAttribute('aria-label', choice.label + ', ' + data[choice.file].size);
    }
    if (choice.other) other.textContent = choice.other;
    else other.hidden = true;
    choice.rows.forEach(function (id) {
      var row = document.getElementById('dl-' + id);
      if (row) row.classList.add('is-yours');
    });
  }

  // ---------- Sample codes ----------

  /** A 32-bit FNV-1a hash, to turn an account and a time window into a repeatable seed. */
  function seedFor(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  /** A small seeded generator (mulberry32), so every visitor sees codes that change together. */
  function randomFrom(seed) {
    var state = seed;
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampleCode(account, steam, period) {
    var random = randomFrom(seedFor(account + ':' + period));
    var code = '';
    if (steam) {
      for (var i = 0; i < 5; i++) code += STEAM_ALPHABET.charAt(Math.floor(random() * STEAM_ALPHABET.length));
      return code;
    }
    for (var j = 0; j < 6; j++) code += String(Math.floor(random() * 10));
    return code;
  }

  function spaced(code) {
    return code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
  }

  function currentCode(element) {
    var period = Math.floor(Date.now() / 1000 / CODE_PERIOD_S);
    return sampleCode(element.getAttribute('data-account'), element.getAttribute('data-steam') === 'true', period);
  }

  function updateCodes() {
    var seconds = Date.now() / 1000;
    var left = CODE_PERIOD_S - (seconds % CODE_PERIOD_S);
    var steps = CODE_PERIOD_S / TIMER_STEP_S;
    var width = (Math.ceil(left / TIMER_STEP_S) / steps) * 100 + '%';
    var holders = document.querySelectorAll('[data-account]');
    for (var i = 0; i < holders.length; i++) {
      var holder = holders[i];
      var text = holder.querySelector('.key-digits, .vault-code');
      var timer = holder.querySelector('.key-timer, .vault-timer');
      text.textContent = spaced(currentCode(holder));
      timer.firstElementChild.style.width = width;
      timer.classList.toggle('is-ending', left <= ENDING_S);
    }
  }

  function setupCodes() {
    updateCodes();
    window.setInterval(updateCodes, 1000);
  }

  // ---------- Activity ----------

  var activity = document.getElementById('activity');

  function clockTime() {
    var now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }

  function span(className, text) {
    var element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
  }

  var emptyRow = null;

  /**
   * Adds a row at the top of the activity list and returns a function that updates its status.
   * Rows the page adds by itself are quiet: screen readers hear only what the visitor pressed.
   */
  function logActivity(title, detail, status, state, quiet) {
    if (emptyRow && emptyRow.parentNode) emptyRow.parentNode.removeChild(emptyRow);
    var row = document.createElement('li');
    var what = document.createElement('span');
    what.className = 'a-what';
    what.appendChild(span('a-title', title));
    what.appendChild(span('a-detail', detail));
    var statusText = span('a-status', status);
    row.appendChild(span('a-time', clockTime()));
    row.appendChild(what);
    row.appendChild(statusText);
    row.className = 'is-' + state;
    activity.insertBefore(row, activity.firstChild);
    while (activity.children.length > ACTIVITY_ROWS) activity.removeChild(activity.lastChild);
    if (!quiet) announce(title + ': ' + status);
    return function (nextStatus, nextState) {
      statusText.textContent = nextStatus;
      row.className = 'is-' + nextState;
      if (!quiet) announce(title + ': ' + nextStatus);
    };
  }

  // ---------- The deck ----------

  function setLight(key, state) {
    key.classList.remove('is-running', 'is-ok', 'is-fail');
    if (state) key.classList.add('is-' + state);
  }

  function finishRun(key, update, done, state) {
    setLight(key, state);
    update(done, state);
    key.removeAttribute('aria-busy');
  }

  function runKey(key, waitingText, failing, quiet) {
    var ms = Number(key.getAttribute('data-ms'));
    var done = key.getAttribute('data-done');
    key.setAttribute('aria-busy', 'true');
    setLight(key, 'running');
    var update = logActivity(key.getAttribute('data-title'), key.getAttribute('data-detail'), waitingText, 'run', quiet);
    window.setTimeout(function () { finishRun(key, update, done, failing ? 'fail' : 'ok'); }, ms);
  }

  var ACTIONS = {
    press: function (key, quiet) {
      setLight(key, 'ok');
      logActivity(key.getAttribute('data-title'), key.getAttribute('data-detail'), 'Done', 'ok', quiet);
    },
    run: function (key, quiet) { runKey(key, 'Running', false, quiet); },
    fail: function (key, quiet) { runKey(key, 'Running', true, quiet); },
    env: function (key, quiet) { runKey(key, 'Asking your phone', false, quiet); },
    code: function (key, quiet) {
      setLight(key, 'ok');
      logActivity(key.getAttribute('data-account'), 'Typed ' + currentCode(key) + ' where you were typing', 'Typed', 'ok', quiet);
    },
  };

  function isBusy(key) {
    return key.getAttribute('aria-busy') === 'true';
  }

  /** Restarts a one-shot CSS animation class, even when it is already on the element. */
  function replayClass(element, className) {
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }

  // ---------- Pressing raised blocks ----------

  function pressDown(block) {
    block.classList.remove('is-up');
    block.classList.add('is-down');
    if (block.classList.contains('key')) replayClass(block, 'is-flash');
  }

  function release(block) {
    if (!block.classList.contains('is-down')) return;
    block.classList.remove('is-down');
    replayClass(block, 'is-up');
    window.setTimeout(function () { block.classList.remove('is-up'); }, RELEASE_MS);
  }

  /** Presses a key or button the way a finger would: down, a short hold, then the spring back. */
  function pressBriefly(block, then) {
    pressDown(block);
    window.setTimeout(function () {
      release(block);
      if (then) then();
    }, PRESS_MS);
  }

  /** The page pressing a key by itself, for the opening and the idle demo. */
  function autoPress(key) {
    if (isBusy(key)) return;
    pressBriefly(key, function () { ACTIONS[key.getAttribute('data-act')](key, true); });
  }

  /** The visitor's own presses: down on pointer or Space/Enter, the spring back on letting go. */
  function followPresses(deck) {
    function keyFrom(event) { return event.target.closest('.key'); }
    deck.addEventListener('pointerdown', function (event) {
      var key = keyFrom(event);
      if (key) pressDown(key);
    });
    ['pointerup', 'pointercancel'].forEach(function (type) {
      deck.addEventListener(type, function (event) {
        var key = keyFrom(event);
        if (key) release(key);
      });
    });
    // pointerout also fires between a key's own parts; only leaving the key lets it go.
    deck.addEventListener('pointerout', function (event) {
      var key = keyFrom(event);
      if (key && !key.contains(event.relatedTarget)) release(key);
    });
    deck.addEventListener('keydown', function (event) {
      var key = keyFrom(event);
      if (key && !event.repeat && (event.key === ' ' || event.key === 'Enter')) pressDown(key);
    });
    deck.addEventListener('keyup', function (event) {
      var key = keyFrom(event);
      if (key && (event.key === ' ' || event.key === 'Enter')) release(key);
    });
    deck.addEventListener('focusout', function (event) {
      var key = keyFrom(event);
      if (key) release(key);
    });
  }

  function isShown(element) {
    return element.offsetParent !== null;
  }

  /**
   * While the deck is on screen and nobody has touched it, it presses a key every few seconds and
   * logs it. It pauses off screen and in hidden tabs, and stops for good at the first touch.
   */
  function startIdleDemo(deck) {
    var keys = deck.querySelectorAll('.key');
    var timer = null;
    var onScreen = false;
    var stopped = false;
    var presses = 0;
    var next = 0;

    function nextKey() {
      for (var tries = 0; tries < IDLE_ORDER.length; tries++) {
        var key = keys[IDLE_ORDER[next]];
        next = (next + 1) % IDLE_ORDER.length;
        if (key && isShown(key) && !isBusy(key)) return key;
      }
      return null;
    }

    function pause() {
      window.clearTimeout(timer);
      timer = null;
    }

    function schedule(delay) {
      pause();
      if (stopped || !onScreen || document.hidden) return;
      timer = window.setTimeout(step, delay);
    }

    function step() {
      var key = nextKey();
      if (key) autoPress(key);
      presses += 1;
      if (presses >= IDLE_MAX_PRESSES) stop();
      else schedule(IDLE_STEP_MS);
    }

    function stop() {
      stopped = true;
      pause();
    }

    new IntersectionObserver(function (entries) {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (onScreen) schedule(presses ? IDLE_STEP_MS : IDLE_START_MS);
      else pause();
    }).observe(deck);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause();
      else schedule(IDLE_STEP_MS);
    });
    deck.addEventListener('pointerdown', stop);
    deck.addEventListener('keydown', stop);
  }

  function setupDeck() {
    var deck = document.getElementById('deck');
    emptyRow = document.createElement('li');
    emptyRow.className = 'activity-empty';
    emptyRow.textContent = 'Nothing yet. Tap a key above.';
    activity.appendChild(emptyRow);

    deck.querySelectorAll('.key-face').forEach(function (face) {
      ['key-flash', 'key-march'].forEach(function (className) {
        var layer = document.createElement('span');
        layer.className = className;
        layer.setAttribute('aria-hidden', 'true');
        face.appendChild(layer);
      });
    });

    deck.addEventListener('click', function (event) {
      var key = event.target.closest('.key');
      if (!key || isBusy(key)) return;
      ACTIONS[key.getAttribute('data-act')](key, false);
    });
    followPresses(deck);
    // iOS Safari only shows :active on buttons when the page listens for touches.
    document.addEventListener('touchstart', function () {}, { passive: true });

    if (reduceMotion || !('IntersectionObserver' in window)) return;
    window.setTimeout(function () { autoPress(deck.querySelector('.key')); }, INTRO_PRESS_MS);
    startIdleDemo(deck);
  }

  // ---------- The env section's replay ----------

  /** Runs each step after the given pause, one after another. */
  function runTimeline(steps) {
    var at = 0;
    steps.forEach(function (step) {
      at += step.after;
      window.setTimeout(step.run, at);
    });
  }

  function typeInto(element, text, done) {
    var typed = 0;
    element.classList.add('is-typing');
    var timer = window.setInterval(function () {
      typed += 1;
      element.textContent = text.slice(0, typed);
      if (typed < text.length) return;
      window.clearInterval(timer);
      element.classList.remove('is-typing');
      done();
    }, TYPE_MS);
  }

  /** Hides the parts the replay will bring in; the page as written is the replay's last frame. */
  function stageEnv(show) {
    var command = show.querySelector('.term-cmd');
    var text = command.textContent;
    var line = function (name) { return show.querySelector('[data-play="' + name + '"]'); };
    var reveal = function (element) { return function () { element.classList.add('is-shown'); }; };
    var allow = document.getElementById('sheet-allow');

    show.classList.add('is-staged');
    command.textContent = '';
    line('command').classList.add('is-shown');

    return function play() {
      typeInto(command, text, function () {
        runTimeline([
          { after: 120, run: reveal(line('check')) },
          { after: 180, run: reveal(line('ask')) },
          { after: 120, run: reveal(document.getElementById('sheet')) },
          { after: 420, run: function () { pressBriefly(allow); } },
          { after: 220, run: reveal(line('allowed')) },
          { after: 220, run: reveal(line('output')) },
          { after: 200, run: reveal(line('server')) },
          { after: 200, run: function () { show.classList.remove('is-staged'); } },
        ]);
      });
    };
  }

  function setupEnvReplay() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    var show = document.getElementById('env-show');
    var play = stageEnv(show);
    var observer = new IntersectionObserver(function (entries) {
      if (!entries[entries.length - 1].isIntersecting) return;
      observer.disconnect();
      play();
    }, { threshold: ENV_VISIBLE_RATIO });
    observer.observe(show);
  }

  // ---------- Checksums ----------

  function selectText(element) {
    var range = document.createRange();
    range.selectNodeContents(element);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function setupHashes() {
    document.querySelectorAll('.hash').forEach(function (button) {
      var label = button.querySelector('span');
      var short = label.textContent;
      var hash = button.getAttribute('data-hash');
      button.addEventListener('click', function () {
        var copying = navigator.clipboard ? navigator.clipboard.writeText(hash) : Promise.reject(new Error('No clipboard'));
        copying.then(
          function () {
            label.textContent = 'Copied';
            button.classList.add('is-copied');
            announce('SHA-256 copied');
            window.setTimeout(function () {
              label.textContent = short;
              button.classList.remove('is-copied');
            }, COPIED_MS);
          },
          function () {
            // Without clipboard access, show the whole checksum selected so it can be copied by hand.
            label.textContent = hash;
            selectText(label);
          }
        );
      });
    });
  }

  setupPrimaryDownload();
  setupCodes();
  setupDeck();
  setupEnvReplay();
  setupHashes();
})();
