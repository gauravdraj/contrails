(function (W) {
  'use strict';
  // The caller passes playback time, so the countdown and the interpolated threshold crossing agree.
  function syncCountdowns(board, now) {
    var next = {};
    board.arrivals.forEach(function (r) {
      if (!r.goAround && Number.isFinite(r.etaMin))
        next[r.hex || r.callsign] = core.updateArrivalCountdown(
            _airportCountdowns[r.hex || r.callsign],
            r.touchdownAtMs || now + r.etaMin * 60000,
            now
          );
    });
    _airportCountdowns = next;
    board.arrivals = core.sequenceAirportArrivals(board.arrivals.map(function (r) {
      var s = next[r.hex || r.callsign];
      return Object.assign({}, r, { displayEtaMin: s ? s.remainingSec / 60 : r.etaMin });
    }).sort(function (a, b) {
      var x = Number.isFinite(a.displayEtaMin) ? a.displayEtaMin : Infinity;
      var y = Number.isFinite(b.displayEtaMin) ? b.displayEtaMin : Infinity;
      return (x === y ? 0 : x - y) ||
        (Number.isFinite(a.pathKm) && Number.isFinite(b.pathKm) ? a.pathKm - b.pathKm : 0) ||
        String(a.hex || a.callsign).localeCompare(String(b.hex || b.callsign));
    }));
  }
  function build(board, planes, previous, field, now, delay, datis) {
    // Board departure rows disappear after climb-out. Remember their colour until they leave this feed.
    var departed = previous ? previous.departed : {};
    var rows = {};
    var items = [];
    var prior = {};
    if (previous)
      previous.items.forEach(function (a) {
        prior[a.hex] = a;
      });
    ['arrivals', 'departures', 'landed'].forEach(function (tab) {
      board[tab].forEach(function (r) {
        rows[r.hex] = { row: r, tab: tab };
      });
    });
    planes.forEach(function (a) {
      var match = rows[a.icao24];
      var r = match ? match.row : {};
      var role = 'other';
      if (match)
        role = r.goAround
            ? 'go-around'
            : match.tab === 'arrivals'
              ? 'arrival'
              : match.tab === 'landed'
                ? (r.taxiingIn ? 'taxi' : 'landed')
                : ['Departing', 'Climbing'].includes(r.status) ? 'departure' : 'taxi';
      if (role === 'departure' && !departed[a.icao24])
        departed[a.icao24] = { atMs: null, runway: r.runway };
      if (departed[a.icao24] && prior[a.icao24]?.ground && !a.ground && departed[a.icao24].atMs == null)
        departed[a.icao24].atMs = a.reportTs;
      if (role === 'other' && departed[a.icao24])
        role = 'departure';
      var e = extraState[a.icao24];
      var states = prior[a.icao24] ? prior[a.icao24].states.slice(-3) : [];
      var state = {
        atMs: a.reportTs,
        role: role,
        runway: r.runway || departed[a.icao24]?.runway || null,
        runwayAssumed: !!r.runwayAssumed,
        seq: r.sequence || null,
        countdown: _airportCountdowns[a.icao24] || null,
        touchdownAtMs: r.touchdownAtMs
      };
      if (states.length && states[states.length - 1].atMs === state.atMs)
        states[states.length - 1] = state;
      else
        states.push(state);
      items.push(Object.assign(
        {},
        a,
        {
          hex: a.icao24,
          role: role,
          runway: r.runway || departed[a.icao24]?.runway || null,
          runwayAssumed: !!r.runwayAssumed,
          seq: r.sequence || null,
          countdown: _airportCountdowns[a.icao24] || null,
          touchdownAtMs: r.touchdownAtMs,
          status: r.status || null,
          states: states,
          departureAtMs: departed[a.icao24]?.atMs,
          samples: e ? e.samples : [],
          history: posHistory[a.icao24] || []
        }
      ));
    });
    Object.keys(departed).forEach(function (hex) {
      if (!items.some(function (a) {
        return a.hex === hex;
      }))
        delete departed[hex];
    });
    return {
      items: items,
      departed: departed,
      field: field,
      atMs: now,
      delay: delay,
      board: board,
      ladder: core.layoutApproachLadder(board.arrivals, { runways: board.activeArrivalRunways }),
      departureRunways: datis?.departing_runways || [],
      moments: previous ? previous.moments : [],
      quiet: !items.some(function (a) {
        return !a.ground && a.role !== 'other';
      })
    };
  }
  W.Scene = { build: build, syncCountdowns: syncCountdowns };
})(typeof window === 'undefined' ? globalThis.Watch : window.Watch);
