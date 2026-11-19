(function (root) {
  'use strict';
  var palettes = {
    night: {
      bg: '#07121b',
      water: '#07121b',
      land: '#1a272d',
      shore: '#52666b',
      ring: '#43565f',
      ink: '#c4d1cf',
      muted: '#75919a',
      arrival: '#edb568',
      near: '#f0d4a1',
      departure: '#70c7cf',
      go: '#d58da9',
      other: '#77929e',
      runway: '#a8beb9',
      strip: '#0b1a23'
    },
    day: {
      bg: '#f3f0e8',
      water: '#dce5e8',
      land: '#f3f0e8',
      shore: '#95aaa9',
      ring: '#a9b7b6',
      ink: '#30494c',
      muted: '#667e7e',
      arrival: '#a65029',
      near: '#8e421c',
      departure: '#176f78',
      go: '#a83b62',
      other: '#7f9192',
      runway: '#607b76',
      strip: '#eeeae0'
    }
  };
  // NOAA's fractional-year declination / equation-of-time approximation; longitude supplies local solar time.
  function elevation(now, lat, lng) {
    var d = new Date(now);
    var start = Date.UTC(d.getUTCFullYear(), 0, 0);
    var day = (now - start) / 86400000;
    var g = 2 * Math.PI / 365 * (day - 1);
    var dec = .006918 - .399912 * Math.cos(g) + .070257 * Math.sin(g) - .006758 * Math.cos(2 * g) +
      .000907 * Math.sin(2 * g) -
      .002697 * Math.cos(3 * g) +
      .00148 * Math.sin(3 * g);
    var eq = 229.18 *
      (.000075 + .001868 * Math.cos(g) - .032077 * Math.sin(g) - .014615 * Math.cos(2 * g) -
        .040849 * Math.sin(2 * g));
    var minute = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    var h = ((minute + eq + 4 * lng) / 4 - 180) * Math.PI / 180;
    var p = lat * Math.PI / 180;
    return Math.asin(Math.sin(p) * Math.sin(dec) + Math.cos(p) * Math.cos(dec) * Math.cos(h)) * 180 / Math.PI;
  }
  function palette(mode, now, field) {
    var t = mode === 'night'
      ? 0
      : mode === 'day'
        ? 1
        : Math.max(0, Math.min(1, (elevation(now, field.lat, field.lng) + 4) / 8));
    // Quantize auto transitions to 64 steps, so static paint stays static between twilight changes.
    t = Math.round(t * 64) / 64;
    if (t === 0)
      return palettes.night;
    if (t === 1)
      return palettes.day;
    var out = {};
    Object.keys(palettes.night).forEach(function (k) {
      var a = parseInt(palettes.night[k].slice(1), 16);
      var b = parseInt(palettes.day[k].slice(1), 16);
      var n = 0;
      [16, 8, 0].forEach(function (s) {
        n |= Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
      });
      out[k] = '#' + n.toString(16).padStart(6, '0');
    });
    return out;
  }
  (root.Watch = root.Watch || {}).Theme = { palettes: palettes, elevation: elevation, palette: palette };
})(globalThis);
