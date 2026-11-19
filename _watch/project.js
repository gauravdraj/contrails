/* Pure north-up radial projection. Distances in km; the four labelled rings disclose compression. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object')
    module.exports = api;
  (root.Watch = root.Watch || {}).Project = api;
})(
  typeof globalThis === 'undefined' ? this : globalThis,
  function () {
    'use strict';
    function view(width, height, field) {
      var stripH = Math.round(height * (height > width ? .20 : .195));
      var chartH = height - stripH;
      // A smaller asinh core enlarges the field while keeping the 40 NM ring in view.
      return {
        width: width,
        height: height,
        chartH: chartH,
        stripH: stripH,
        cx: width * (height > width ? .5 : .55),
        cy: height > width ? chartH * .56 : chartH * .505,
        radius: Math.min(width * .515, chartH * .51),
        dMax: 100,
        k: 2.1,
        field: field
      };
    }
    function local(lat, lng, field) {
      return {
        east: (lng - field.lng) * 111.195 * Math.cos(field.lat * Math.PI / 180),
        north: (lat - field.lat) * 111.195
      };
    }
    function radial(d, v) {
      return v.radius * Math.asinh(d / v.k) / Math.asinh(v.dMax / v.k);
    }
    function project(lat, lng, v) {
      var p = local(lat, lng, v.field);
      var d = Math.hypot(p.east, p.north);
      var r = d ? radial(d, v) / d : 0;
      return { x: v.cx + p.east * r, y: v.cy - p.north * r };
    }
    // Five pixels per measured parallel lane, tapering to zero at the threshold. Shadows stay geographic.
    function laneOffset(runway, distanceKm, track) {
      var sign = /L$/.test(runway || '') ? -1 : /R$/.test(runway || '') ? 1 : 0;
      var offset = sign * 5 * Math.min(1, Math.max(0, distanceKm) / 2);
      var h = (track || 0) * Math.PI / 180;
      return { x: Math.cos(h) * offset, y: Math.sin(h) * offset };
    }
    return {
      view: view,
      local: local,
      radial: radial,
      project: project,
      laneOffset: laneOffset
    };
  }
);
