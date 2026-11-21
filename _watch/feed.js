(function (W) {
  'use strict';
  function Feed(field, changed, clock) {
    this.field = field;
    this.changed = changed;
    this.clock = clock || Date.now;
    this.delay = core.computePlaybackDelayMs(5000, 0, { minMs: 3200, maxMs: 8000 });
    this.boardState = core.createAirportBoardState();
    this.routeCache = {};
    this.scheduleDataCache = {};
    this.routeEvidenceMemo = new Map();
    this.feedClockOffsetMs = null;
    this.schedule = null;
    this.datis = null;
    this.datisCache = { datisTs: 0, datisActiveRunways: null };
    this.lastOk = 0;
    this.lastNew = 0;
    this.failures = 0;
    this.rawReports = {};
    this.lastSeen = {};
    this.timers = {};
    this.pending = {};
    this.running = false;
  }
  Feed.prototype.ingest = function (payload, now) {
    var env = { core: core, now: now, state: this.boardState,
      airportData: airportData, runwayData: runwayData, posHistory: posHistory, extraState: extraState,
      routeCache: this.routeCache, scheduleDataCache: this.scheduleDataCache,
      routeEvidenceMemo: this.routeEvidenceMemo, scheduleCacheTtl: SCHEDULE_CACHE_TTL,
      isPrivate: core.isPrivateAircraft, airportDisplayName: function (iata) { return iata; } };
    if (payload.schedule) {
      this.schedule = payload.schedule;
      this.scheduleDataCache[this.field.iata] = { data: payload.schedule, ts: now };
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'datis')) {
      this.datisCache.datisActiveRunways = payload.datis
        ? core.parseDatisActiveRunways(payload.datis.datis || payload.datis.text || payload.datis.raw) : null;
      this.datisCache.datisTs = now;
    }
    this.datis = getCachedDatisActiveRunways(this.datisCache);
    if (payload.traffic) {
      var traffic = payload.traffic;
      var feedNow = Number.isFinite(traffic.now) ? traffic.now : now;
      this.feedClockOffsetMs = core.updateClockOffset(this.feedClockOffsetMs, now, feedNow);
      if (this.lastFeedNow == null || feedNow > this.lastFeedNow) {
        this.lastNew = now;
        this.lastFeedNow = feedNow;
      }
      var positionNow = Math.min(now, feedNow + this.feedClockOffsetMs);
      var snap = core.buildTrafficSnapshot(env, traffic.ac || [], {
        includeProximity: false, now: now, positionNow: positionNow
      });
      var self = this;
      snap.aircraft.forEach(function (a) {
        var hex = a.icao24;
        var rawTs = feedNow - Math.max(0, a.seenPos || 0) * 1000;
        self.lastSeen[hex] = now;
        // The cache can repeat an observation while the receive clock advances. Do not invent motion samples.
        if (self.rawReports[hex] != null && rawTs <= self.rawReports[hex]) {
          var old = extraState[hex];
          if (old)
            Object.assign(a, old.observation);
          return;
        }
        self.rawReports[hex] = rawTs;
        self.lastNew = now;
        var h = posHistory[hex] || (posHistory[hex] = []);
        var prev = h[h.length - 1];
        var broken = !!prev && (a.reportTs - prev[2] > 30000 || core.haversineKm(prev[0], prev[1], a.lat, a.lng) > 10);
        h.push([a.lat, a.lng, a.reportTs, a.altFt, a.ground, broken, false]);
        if (h.length > 120)
          h.shift();
        var state = extraState[hex] || (extraState[hex] = { samples: [] });
        if (broken)
          state.samples.length = 0;
        state.samples.push({
          lat: a.lat,
          lng: a.lng,
          ts: a.reportTs,
          spdMs: (a.speedKts || 0) * .514444,
          trackDeg: a.track,
          altFt: a.altFt,
          ground: a.ground
        });
        if (state.samples.length > 120)
          state.samples.shift();
        state.observation = Object.assign({}, a);
      });
      Object.keys(this.lastSeen).forEach(function (hex) {
        if (now - self.lastSeen[hex] > 360000) {
          delete posHistory[hex];
          delete extraState[hex];
          delete self.lastSeen[hex];
          delete self.rawReports[hex];
        }
      });
      aircraft = snap.aircraft;
      this.lastOk = now;
      this.failures = 0;
    }
    core.applyAirportScheduleIn(env, this.field.iata, this.schedule, aircraft);
    var board = core.buildAirportBoard(env, this.field.iata, this.field.lat, this.field.lng, aircraft, this.datis);
    W.Scene.syncCountdowns(board, now - this.delay);
    this.board = board;
    this.changed(board, now);
    return board;
  };
  Feed.prototype.health = function (now) {
    return core.trafficOutage(this.failures, this.lastOk, now) || (this.lastNew && now - this.lastNew > 30000)
      ? 'stale'
      : this.lastOk ? 'live' : 'connecting';
  };
  Feed.prototype.refresh = async function (kind) {
    if (this.pending[kind] || document.hidden)
      return;
    var controller = new AbortController();
    var self = this;
    this.pending[kind] = controller;
    try {
      var url = kind === 'traffic'
        ? trafficUrl(this.field.lat, this.field.lng, 120)
        : WORKER_URL + '/' + kind + '/' + this.field.iata;
      if (kind === 'datis') {
        // Give the D-ATIS helper a feed-owned cache entry.
        // Its in-flight request can finish while hidden, but the aborted generation is never applied.
        var cache = Object.assign({}, this.datisCache);
        await fetchAirportDatisActiveRunways(this.field.iata, cache);
        if (!controller.signal.aborted) {
          this.datisCache = cache;
          this.ingest({}, this.clock());
        }
      }
      else {
        var response = await fetchWithTimeout(url, { signal: controller.signal });
        if (!response.ok)
          throw new Error('HTTP ' + response.status);
        var data = await response.json();
        if (!controller.signal.aborted) {
          var p = {};
          p[kind] = data;
          this.ingest(p, this.clock());
        }
      }
    }
    catch (err) {
      if (!controller.signal.aborted && kind === 'traffic')
        this.failures++;
    }
    finally {
      delete this.pending[kind];
      if (this.running && !document.hidden) {
        clearTimeout(this.timers[kind]);
        var interval = kind === 'traffic'
          ? core.trafficRetryDelayMs(REFRESH_MS, this.failures)
          : kind === 'datis' ? 60000 : SCHEDULE_CACHE_TTL;
        this.timers[kind] = setTimeout(function () {
          self.refresh(kind);
        }, interval);
      }
    }
  };
  Feed.prototype.start = function () {
      this.running = true;
      var self = this;
      ['traffic', 'datis', 'schedule'].forEach(function (k) {
        clearTimeout(self.timers[k]);
        self.refresh(k);
      });
    };
  Feed.prototype.stop = function () {
      this.running = false;
      var self = this;
      Object.keys(this.timers).forEach(function (k) {
        clearTimeout(self.timers[k]);
      });
      Object.keys(this.pending).forEach(function (k) {
        self.pending[k].abort();
      });
    };
  W.Feed = Feed;
})(window.Watch = window.Watch || {});
