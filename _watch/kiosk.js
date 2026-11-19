(function (W) {
  'use strict';
  function init(test) {
    var button = document.getElementById('fullscreen');
    var wanted = false;
    var lock = null;
    var waking = false;
    var idle = 0;
    var lastTap = 0;
    var disabled = false;
    var lastDrift = null;
    var sceneElement = document.getElementById('scene');
    function label() {
      button.textContent = wanted
        ? (document.fullscreenElement ? 'Exit full screen ↙' : lock ? 'Keeping awake · turn off' : 'Awake mode · turn off')
        : 'Full screen ↗';
      button.setAttribute('aria-pressed', String(wanted));
    }
    async function release() {
      var current = lock;
      if (current) {
        await current.release();
        if (lock === current)
          lock = null;
      }
      label();
    }
    async function wake() {
      if (!wanted || document.hidden || !navigator.wakeLock || lock || waking)
        return;
      waking = true;
      try {
        var current = await navigator.wakeLock.request('screen');
        lock = current;
        current.addEventListener('release', function () {
          if (lock === current)
            lock = null;
          label();
        });
        if (!wanted || document.hidden)
          await release();
      }
      catch (_) {
        button.title = 'Keep-awake is unavailable in this browser';
      }
      finally {
        waking = false;
        label();
      }
    }
    async function toggle() {
      wanted = !wanted;
      label();
      try {
        if (wanted) {
          await document.documentElement.requestFullscreen?.();
        }
        else if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
      }
      catch (_) { }
      if (wanted)
        await wake();
      else
        await release();
    }
    button.addEventListener('click', toggle);
    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(e.target.tagName))
          toggle();
      }
    );
    document.getElementById('traffic').addEventListener(
      'pointerup',
      function (e) {
        if (e.pointerType === 'touch') {
          var now = performance.now();
          if (now - lastTap < 350)
            toggle();
          lastTap = now;
        }
      }
    );
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden)
        wake();
    });
    document.addEventListener(
      'fullscreenchange',
      function () {
        if (!document.fullscreenElement) {
          wanted = false;
          release();
        }
        label();
      }
    );
    function active() {
      if (disabled)
        return;
      document.body.classList.remove('idle');
      clearTimeout(idle);
      if (!test)
        idle = setTimeout(function () {
          document.body.classList.add('idle');
        }, 3500);
    }
    ['pointermove', 'pointerdown', 'keydown', 'focusin'].forEach(function (n) {
      document.addEventListener(n, active);
    });
    active();
    return {
      drift: function (t, reduced) {
        if (test || reduced)
          return;
        var n = Math.floor(t / 180000);
        if (n === lastDrift)
          return;
        lastDrift = n;
        sceneElement.style.transform = 'translate(' + (n % 3 - 1) + 'px,' + (Math.floor(n / 3) % 3 - 1) + 'px)';
      },
      stop: function () {
        disabled = true;
        wanted = false;
        clearTimeout(idle);
        release();
      }
    };
  }
  W.Kiosk = { init: init };
})(globalThis.Watch);
