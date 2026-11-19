(function (W) {
  'use strict';
  function update(previous, scene) {
    var before = {};
    if (previous)
      previous.items.forEach(function (a) {
        before[a.hex] = a;
      });
    var events = previous ? previous.moments.slice() : [];
    scene.items.forEach(function (a) {
      var p = before[a.hex];
      if (!p || a.reportTs <= p.reportTs)
        return;
      // Celebrate only an observed transition. Playback time decides when it becomes visible, never prediction.
      var type = !p.ground && a.ground && (p.role === 'arrival' || p.role === 'landed')
        ? 'touchdown'
        : p.ground && !a.ground && a.role === 'departure'
          ? 'takeoff'
          : p.role !== 'go-around' && a.role === 'go-around' ? 'go-around' : null;
      if (type)
        events.push({
          type: type,
          hex: a.hex,
          callsign: a.callsign,
          runway: a.runway || p.runway,
          atMs: a.reportTs,
          lat: a.lat,
          lng: a.lng,
          track: a.track,
          duration: 7000
        });
    });
    scene.moments = events.filter(function (e) {
      return scene.atMs - e.atMs < 3600000;
    }).slice(-24);
  }
  function active(scene, t) {
    return scene.moments.filter(function (e) {
      return t >= e.atMs && t < e.atMs + e.duration;
    });
  }
  W.Moments = { update: update, active: active };
})(globalThis.Watch);
