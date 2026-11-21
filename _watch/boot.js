/* Ordered classic scripts: airlines must exist before the core factory executes. */
(async function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var test = params.get('test') === '1';
  var watchNow = 0;
  if (test)
    Date.now = function () {
      return watchNow;
    };
  async function json(url) {
    var r = await fetch(url);
    if (!r.ok)
      throw new Error('Unable to load ' + url);
    return r.json();
  }
  async function script(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Unable to load ' + src));
      };
      document.head.appendChild(s);
    });
  }
  try {
    window.AIRLINES_DATA = await json('../airlines.json');
    for (var src of [
      '../contrails-core.js',
      'shim.js',
      'project.js',
      'theme.js',
      'scene.js',
      'feed.js',
      'moments.js',
      'display.js',
      'paint.js',
      'kiosk.js'
    ])
      await script(src);
    var data = await Promise.all([json('../airports.json'), json('../runways.json')]);
    airportData = data[0];
    runwayData = data[1];
    var code = (params.get('airport') || 'SFO').trim().toUpperCase();
    var row = airportData.find(function (a) {
      return a[0] === code;
    });
    if (!row) {
      document.getElementById('airport-code').textContent = code || '—';
      document.getElementById('airport-name').textContent = '';
      document.getElementById('operations').textContent = 'A little beyond this chart';
      document.getElementById('sky-note').textContent = '';
      var message = document.getElementById('message');
      message.textContent = 'This airport is not in the atlas.';
      var link = document.createElement('a');
      link.href = '?airport=SFO';
      link.textContent = 'Return to San Francisco';
      var small = document.createElement('small');
      small.appendChild(link);
      message.appendChild(small);
      message.hidden = false;
      window.__watch = { ready: true, unknown: true, stop: function () { } };
      return;
    }
    var field = {
      iata: code,
      lat: row[1],
      lng: row[2],
      name: row[4] || row[3],
      elev: row[6] || 0
    };
    var geo = code === 'SFO' ? await json('geo/SFO.json').catch(function () {
      return null;
    }) : null;
    // Other airports need no artwork to render.
    var W = window.Watch;
    var scene = null;
    var view;
    var painter = new W.Paint.Painter(document.getElementById('chart'), document.getElementById('traffic'));
    var mode = params.get('theme');
    if (!['night', 'day', 'auto'].includes(mode)) {
      try {
        mode = localStorage.getItem('watch-theme');
      }
      catch (_) { }
    }
    if (!['night', 'day', 'auto'].includes(mode))
      mode = 'auto';
    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var raf = 0;
    var stopped = false;
    var lastFrame = 0;
    var lastHeader = -Infinity;
    var themeKey = '';
    var kiosk = W.Kiosk.init(test);
    var fps = params.get('fps') === '30' ? 30 : 60;
    var feed = new W.Feed(field, function (board, now) {
      var previous = scene;
      scene = W.Scene.build(board, aircraft, previous, field, now, feed.delay, feed.datis);
      W.Moments.update(previous, scene);
      scene.lastNew = feed.lastNew;
      api.lastBoard = board;
      api.scene = scene;
      lastHeader = -Infinity;
    }, function () {
      return test ? watchNow : Date.now();
    });
    function resize() {
      view = W.Project.view(innerWidth, innerHeight, field);
      view.runways = runwayData[code] || [];
      view.reduced = reduced;
      painter.resize(view);
      if (scene)
        frame(test ? watchNow : Date.now());
    }
    function clockText(element, value) {
      // Mono digits keep a steady width; the colon gets a narrower cell rather than letter tracking.
      element.replaceChildren();
      value.split(':').forEach(function (part, index) {
        if (index) {
          var separator = document.createElement('span');
          separator.className = 'time-colon';
          separator.textContent = ':';
          element.appendChild(separator);
        }
        element.appendChild(document.createTextNode(part));
      });
    }
    function header(now) {
      var timezone = ['SFO', 'OAK', 'SJC', 'LAX', 'SEA', 'SAN', 'PDX'].includes(code)
        ? 'America/Los_Angeles'
        : 'UTC';
      var time = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: timezone
      }).format(now);
      clockText(document.getElementById('local-time'), time);
      document.getElementById('local-time').dateTime = new Date(now).toISOString();
      document.getElementById('operations').textContent = 'LANDING ' +
        (scene.board.activeArrivalRunways.map(function (r) {
          return r.padStart(3, '0');
        }).join(' ') || '—') +
        '  ·  DEPARTING ' +
        (scene.departureRunways.map(function (r) {
          return r.padStart(3, '0');
        }).join(' ') || '—');
      document.getElementById('sky-note').textContent = scene.quiet
          ? 'Quiet sky · ' + nextArrival(now)
          : 'The arrivals, the departures, the space between.';
      var health = feed.health(now);
      document.getElementById('health').dataset.state = health;
      document.getElementById('health-label').textContent = health === 'stale'
          ? 'FEED DELAYED'
          : health === 'live' ? 'LIVE · ' + (timezone === 'UTC' ? 'UTC' : 'LOCAL') : 'CONNECTING';
      document.getElementById('empty').hidden = !scene.quiet;
      document.getElementById('next-arrival').textContent = nextArrival(now);
      var events = scene.moments.filter(function (e) {
        return now - scene.delay >= e.atMs;
      }).slice(-5).reverse();
      var log = document.getElementById('moment-log');
      log.replaceChildren();
      events.forEach(function (e) {
        var li = document.createElement('li');
        var at = document.createElement('span');
        clockText(at, new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit', minute: '2-digit', timeZone: timezone
        }).format(e.atMs));
        li.appendChild(at);
        li.appendChild(document.createTextNode(e.callsign + ' ' + (e.type === 'go-around' ? '↗' : e.runway || '↗')));
        li.title = e.type;
        log.appendChild(li);
      });
    }
    function nextArrival(now) {
      var next = feed.schedule?.arrivals?.filter(function (a) {
        return (a.est_arr || a.sched_arr || 0) * 1000 > now;
      }).sort(function (a, b) {
        return (a.est_arr || a.sched_arr) - (b.est_arr || b.sched_arr);
      })[0];
      return next
        ? 'Next expected · ' + (next.callsign || next.flight) + ' · ' +
        Math.max(1, Math.ceil(((next.est_arr || next.sched_arr) * 1000 - now) / 60000)) +
        ' min'
        : 'The runways are waiting.';
    }
    function frame(t) {
      if (test)
        watchNow = t;
      if (!scene)
        return [];
      var start = performance.now();
      view.palette = W.Theme.palette(mode, t, field);
      var key = view.palette.bg;
      if (key !== themeKey) {
        Object.keys(view.palette).forEach(function (k) {
          document.documentElement.style.setProperty('--' + k, view.palette[k]);
        });
        themeKey = key;
      }
      api.displayList = painter.draw(scene, view, geo, t);
      api.view = view;
      api.staticList = painter.staticList;
      if (t - lastHeader >= 1000 || t < lastHeader) {
        header(t);
        lastHeader = t;
      }
      kiosk.drift(t, reduced);
      api.frameTime = t;
      api.frameMs = performance.now() - start;
      return api.displayList;
    }
    function loop(ts) {
      if (stopped || document.hidden)
        return;
      if (ts - lastFrame >= 1000 / fps - .5) {
        frame(Date.now());
        lastFrame = ts;
      }
      raf = requestAnimationFrame(loop);
    }
    var api = window.__watch = {
      ready: false,
      stop: function () {
        stopped = true;
        feed.stop();
        cancelAnimationFrame(raf);
        kiosk.stop();
      },
      ingest: function (p, t) {
        watchNow = t;
        return feed.ingest(p, t);
      },
      frame: frame,
      lastBoard: null,
      displayList: [],
      scene: null,
      feed: feed,
      setTheme: function (value) {
        mode = value;
        document.getElementById('theme').textContent =
          mode === 'day' ? 'Paper' : mode === 'night' ? 'Nocturne' : 'Auto light';
        frame(test ? watchNow : Date.now());
      },
      start: function () {
        stopped = false;
        feed.start();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      },
      resize: resize
    };
    document.getElementById('airport-code').textContent = code;
    document.getElementById('airport-name').textContent = field.name;
    document.getElementById('theme').addEventListener(
      'click',
      function () {
        api.setTheme(mode === 'night' ? 'day' : mode === 'day' ? 'auto' : 'night');
        try {
          localStorage.setItem('watch-theme', mode);
        }
        catch (_) { }
      }
    );
    addEventListener('resize', resize);
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener(
      'change',
      function (e) {
        reduced = e.matches;
        resize();
      }
    );
    document.addEventListener(
      'visibilitychange',
      function () {
        if (test || stopped)
          return;
        if (document.hidden) {
          feed.stop();
          cancelAnimationFrame(raf);
        }
        else {
          feed.start();
          lastFrame = 0;
          raf = requestAnimationFrame(loop);
        }
      }
    );
    feed.ingest({}, test ? 0 : Date.now());
    resize();
    api.setTheme(mode);
    await document.fonts.ready;
    painter.widths.clear();
    frame(test ? watchNow : Date.now());
    api.ready = true;
    if (!test)
      api.start();
  }
  catch (err) {
    document.getElementById('message').hidden = false;
    document.getElementById('message').textContent = 'The chart could not open. Please reload to try again.';
    console.error(err);
  }
})();
