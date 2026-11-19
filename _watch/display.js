/* Pure display lists. No DOM, canvas, wall clock, randomness, or font dependencies. */
(function (W) {
  'use strict';
  var P = W.Project;
  function coarse(a, t) {
    return a.countdown?.coarse && t < a.countdown.coarseUntilMs;
  }
  function etaMinutes(a, t, fallback) {
    if (!a.countdown)
      return fallback;
    return Math.max(0, a.countdown.remainingSec - (t - a.countdown.atMs) / 1000) / 60;
  }
  function stripMinutes(a, t, fallback) {
    var minutes = etaMinutes(a, t, fallback);
    if (!coarse(a, t)) return minutes;
    return minutes < 1 ? .5 : minutes < 3 ? Math.round(minutes * 2) / 2
      : minutes >= 60 ? Math.round(minutes / 30) * 30 : Math.round(minutes);
  }
  function text(list, x, y, value, color, size, extra) {
    list.push(Object.assign({
      kind: 'text',
      x: x,
      y: y,
      text: String(value),
      color: color,
      size: size || 10
    }, extra));
  }
  function line(list, points, color, width, alpha, extra) {
    list.push(Object.assign(
      {
        kind: 'path',
        points: points,
        color: color,
        width: width || 1,
        alpha: alpha == null ? 1 : alpha
      },
      extra
    ));
  }
  function pt(lat, lng, v) {
    var p = P.project(lat, lng, v);
    return [p.x, p.y];
  }
  function boundaryEdge(a, b, bbox) {
    return bbox.some(function (bound, i) {
      var axis = i % 2;
      return Math.abs(a[axis] - bound) < .00001 && Math.abs(b[axis] - bound) < .00001;
    });
  }
  function geography(geo, v) {
    var polygons = [];
    var shores = [];
    if (geo)
      geo.polygons.forEach(function (poly) {
        polygons.push(poly.map(function (ring) {
          var points = [];
          for (var i = 0; i < ring.length; i++) {
            var a = ring[i];
            var b = ring[(i + 1) % ring.length];
            var segment = [];
            // A straight bbox edge becomes a curve under radial projection. Subdivide before projecting
            // so its fill boundary cannot take a shortcut across the visible Bay.
            var steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .02));
            for (var j = 0; j <= steps; j++) {
              segment.push(pt(a[1] + (b[1] - a[1]) * j / steps, a[0] + (b[0] - a[0]) * j / steps, v));
            }
            points = points.concat(segment.slice(0, -1));
            // Only real coastline is stroked; artificial polygon closures contribute to the fill alone.
            if (!boundaryEdge(a, b, geo.bbox))
              shores.push(segment);
          }
          return points;
        }));
      });
    return {
      kind: 'geography',
      polygons: polygons,
      shores: shores,
      x: v.cx,
      y: v.cy,
      r: P.radial(40 * 1.852, v) * 1.04,
      water: v.palette.water,
      land: v.palette.land,
      shore: v.palette.shore
    };
  }
  function runwayLabels(v) {
    var placed = [];
    return core.runwayApproachEnds(v.runways || [], { designators: true }).map(function (e) {
      var a = pt(e.thresholdLat, e.thresholdLon, v);
      var b = pt(e.farEndLat, e.farEndLon, v);
      var dx = a[0] - b[0];
      var dy = a[1] - b[1];
      var d = Math.hypot(dx, dy);
      var side = /L$/.test(e.designator) ? 1 : -1;
      var x = a[0] + dx / d * 20 - dy / d * side * 8;
      var y = a[1] + dy / d * 20 + dx / d * side * 8;
      // Stagger close parallels along their own outward axis; never move an end label to another runway.
      while (placed.some(function (q) {
        return Math.abs(q.x - x) < 25 && Math.abs(q.y - y) < 14;
      })) {
        x += dx / d * 14;
        y += dy / d * 14;
      }
      placed.push({ x: x, y: y });
      return {
        kind: 'runwayLabel',
        x: x - 12,
        y: y - 6,
        w: 24,
        h: 12,
        text: e.designator.padStart(3, '0'),
        anchorX: a[0],
        anchorY: a[1],
        color: v.palette.muted,
        halo: v.palette.water,
        zone: 'chart'
      };
    });
  }
  function staticList(scene, v, geo) {
    var list = [];
    var c = v.palette;
    list.push({ kind: 'rect', x: 0, y: 0, w: v.width, h: v.height, fill: c.bg });
    list.push(geography(geo, v));
    [5, 10, 20, 40].forEach(function (n) {
      var r = P.radial(n * 1.852, v);
      list.push({
        kind: 'circle',
        x: v.cx,
        y: v.cy,
        r: r,
        color: c.ring,
        width: .65,
        alpha: .5
      });
      var angle = -132 * Math.PI / 180;
      text(
        list,
        v.cx + Math.cos(angle) * r - 7,
        v.cy + Math.sin(angle) * r - 5,
        n + ' NM',
        c.muted,
        8,
        { alpha: .8 }
      );
    });
    var entries = v.runways || [];
    var ends = core.runwayApproachEnds(entries, { designators: true });
    var active = scene.board.activeArrivalRunways || [];
    ends.forEach(function (e) {
      var bearing = core.bearingDegrees(e.thresholdLat, e.thresholdLon, e.farEndLat, e.farEndLon);
      var p = pt(e.thresholdLat, e.thresholdLon, v);
      var far = pt(e.farEndLat, e.farEndLon, v);
      var dx = far[0] - p[0];
      var dy = far[1] - p[1];
      var length = Math.hypot(dx, dy);
      if (active.includes(e.designator)) {
        var center = [];
        var sides = [[], []];
        for (var km = 0; km <= 35; km++) {
          var mid = core.projectLatLng(e.thresholdLat, e.thresholdLon, bearing + 180, km * 1000);
          var q = pt(mid[0], mid[1], v);
          var halfWidth = .7 + 13 * Math.pow(km / 35, .7);
          center.push(q);
          sides[0].push([q[0] - dy / length * halfWidth, q[1] + dx / length * halfWidth]);
          sides[1].push([q[0] + dy / length * halfWidth, q[1] - dx / length * halfWidth]);
        }
        // The cone describes the direction of final, not a painted hard boundary of the detector.
        list.push({
          kind: 'cone',
          points: sides[0].concat(sides[1].reverse()),
          start: p,
          end: center[center.length - 1],
          color: c.arrival,
          alpha: .14
        });
        line(list, center, c.arrival, .6, .16, { dash: [1, 7] });
        for (var n = 5; n * 1.852 <= 35; n += 5) {
          var q = core.projectLatLng(e.thresholdLat, e.thresholdLon, bearing + 180, n * 1852);
          var a = pt(q[0], q[1], v);
          line(
            list,
            [
              [a[0] - dy / length * 3, a[1] + dx / length * 3],
              [a[0] + dy / length * 3, a[1] - dx / length * 3]
            ],
            c.arrival,
            .7,
            .3
          );
        }
      }
      if (scene.departureRunways.some(function (r) {
        return r.replace(/^0/, '') === e.designator.replace(/^0/, '');
      })) {
        for (var i = 1; i <= 3; i++) {
          var q = core.projectLatLng(e.farEndLat, e.farEndLon, bearing, i * 600);
          var a = pt(q[0], q[1], v);
          var h = bearing * Math.PI / 180;
          line(
            list,
            [
              [
                a[0] - Math.sin(h) * 3 - Math.cos(h) * 2,
                a[1] + Math.cos(h) * 3 - Math.sin(h) * 2
              ],
              a,
              [
                a[0] - Math.sin(h) * 3 + Math.cos(h) * 2,
                a[1] + Math.cos(h) * 3 + Math.sin(h) * 2
              ]
            ],
            c.departure,
            .8,
            .5 - i * .1
          );
        }
      }
    });
    entries.forEach(function (e) {
      var a = pt(e[0], e[1], v);
      var b = pt(e[3], e[4], v);
      line(list, [a, b], c.runway, 2.6, .85, { semantic: 'runway', glow: c.bg === '#07121b' ? 3 : 0 });
    });
    ends.forEach(function (e) {
      if (!active.includes(e.designator))
        return;
      var a = pt(e.thresholdLat, e.thresholdLon, v);
      var b = pt(e.farEndLat, e.farEndLon, v);
      var dx = b[0] - a[0];
      var dy = b[1] - a[1];
      var d = Math.hypot(dx, dy);
      line(
        list,
        [
          [a[0] - dy / d * 3.2, a[1] + dx / d * 3.2],
          [a[0] + dy / d * 3.2, a[1] - dx / d * 3.2]
        ],
        c.near,
        1.6,
        .9,
        { glow: 7 }
      );
    });
    var nx = v.width - 46;
    var ny = 140;
    text(list, nx, ny - 17, 'N', c.muted, 9, { align: 'center' });
    line(list, [[nx, ny + 13], [nx, ny - 4]], c.muted, .8, .8);
    line(list, [[nx - 3, ny], [nx, ny - 4], [nx + 3, ny]], c.muted, .8, .8);
    text(
      list,
      38,
      v.height > v.width ? 193 : 142,
      scene.field.iata === 'SFO' ? 'SAN FRANCISCO BAY' : scene.field.name.toUpperCase(),
      c.muted,
      8,
      { spacing: 2, alpha: .6 }
    );
    var coordinates = scene.field.iata === 'SFO'
      ? '37° 37′ N   122° 23′ W'
      :
      Math.abs(scene.field.lat).toFixed(2) + '° ' + (scene.field.lat >= 0 ? 'N' : 'S') + '   ' +
      Math.abs(scene.field.lng).toFixed(2) + '° ' + (scene.field.lng >= 0 ? 'E' : 'W');
    text(list, 38, v.height > v.width ? 209 : 158, coordinates, c.muted, 8, { alpha: .6 });
    return list;
  }
  function labels(list, candidates, v, measure, bounds, obstacles) {
    if (!candidates.length)
      return;
    var maxWidth = 0;
    candidates.forEach(function (a) {
      a.w = Math.ceil(measure(a.text, 10)) + (a.seq ? 28 : 12);
      a.h = 22;
      maxWidth = Math.max(maxWidth, a.w);
    });
    // Shift only labels into clear slots. The authoritative point never moves.
    var placed = [];
    candidates.sort(function (a, b) {
      return b.rank - a.rank;
    }).forEach(function (a) {
      var found = null;
      var offsets = [
        [14, -23],
        [14, 3],
        [-a.w - 14, -23],
        [-a.w - 14, 3],
        [14, -50],
        [14, 30],
        [-a.w - 14, 30],
        [14, -77]
      ];
      for (var j = 0; j < offsets.length; j++) {
        var x = Math.max(bounds.left, Math.min(bounds.right - maxWidth, a.anchorX + offsets[j][0]));
        var y = Math.max(bounds.top, Math.min(bounds.bottom - 22, a.anchorY + offsets[j][1]));
        var tryLabel = Object.assign({}, a, { x: x, y: y });
        var collision = (obstacles || []).some(function (b) {
          return x < b.x + b.w + 5 && x + a.w + 5 > b.x && y < b.y + b.h + 4 && y + a.h + 4 > b.y;
        });
        if (!collision &&
          core.declutterLabels(placed.concat([tryLabel]), { w: maxWidth + 5, h: 26 }).length === placed.length + 1) {
          found = tryLabel;
          break;
        }
      }
      if (found)
        placed.push(found);
    });
    core.declutterLabels(placed, { w: maxWidth + 5, h: 26 }).forEach(function (a) {
      line(list, [[a.anchorX, a.anchorY], [a.x + (a.x > a.anchorX ? 0 : a.w), a.y + 11]], a.color, .6, .3);
      list.push({
        kind: 'label',
        x: a.x,
        y: a.y,
        w: a.w,
        h: a.h,
        text: a.text,
        seq: a.seq,
        color: a.color,
        halo: v.palette.bg,
        alpha: a.alpha,
        hex: a.hex,
        zone: a.zone
      });
    });
  }
  function buildDisplayList(scene, v, tMs, measureText) {
    var out = [];
    var c = v.palette;
    var t = tMs - scene.delay;
    var chartLabels = [];
    var stripLabels = [];
    var positions = {};
    var beads = {};
    var reserved = v.runwayLabels || runwayLabels(v);
    // State and countdowns share playback time, so a zero countdown meets its dart at the threshold.
    var items = scene.items.map(function (a) {
      var state = a.states && a.states[0];
      for (var i = 0; a.states && i < a.states.length; i++) {
        if (a.states[i].atMs <= t)
          state = a.states[i];
      }
      return state ? Object.assign({}, a, state) : a;
    });
    var ladder = core.layoutApproachLadder(
      items.filter(function (a) {
        return a.role === 'arrival';
      }).map(function (a) {
        return {
          hex: a.hex,
          runway: a.runway,
          runwayAssumed: a.runwayAssumed,
          etaMin: stripMinutes(a, t, 15)
        };
      }),
      { runways: scene.ladder.runways }
    );
    var staleAge = tMs - (scene.lastNew || scene.atMs);
    var fade = Math.max(.08, 1 - Math.max(0, staleAge - 15000) / 60000);
    out.push({ kind: 'clipCircle', x: v.cx, y: v.cy, r: P.radial(40 * 1.852, v) * 1.04 });
    if (scene.quiet && !v.reduced) {
      out.push({
        kind: 'circle',
        x: v.cx,
        y: v.cy,
        r: P.radial(20 * 1.852, v),
        color: c.ring,
        width: 1.2,
        alpha: .13 + .07 * Math.sin(tMs / 10000 * Math.PI * 2)
      });
    }
    items.forEach(function (a) {
      var pose = core.interpolatePlaybackPose(a.samples, t, { maxExtrapolationMs: 0 });
      if (!pose)
        return;
      var ground = pose.prev.ground && pose.next.ground || pose.progress >= 1 && pose.next.ground;
      var alt = (pose.prev.altFt || 0) + ((pose.next.altFt || 0) - (pose.prev.altFt || 0)) * pose.progress;
      var heading = (pose.prev.trackDeg || 0) +
        (((pose.next.trackDeg || 0) - (pose.prev.trackDeg || 0) + 540) % 360 - 180) * pose.progress;
      var loc = P.project(pose.lat, pose.lng, v);
      var role = a.role;
      if (loc.x < 12 || loc.x > v.width - 12 || loc.y < 100 || loc.y > v.chartH - 15)
        return;
      var cast = ['arrival', 'departure', 'go-around'].includes(role);
      var eta = etaMinutes(a, t, 15);
      var color = role === 'arrival'
        ? (eta < 2 ? c.near : c.arrival)
        : role === 'departure' ? c.departure : role === 'go-around' ? c.go : c.other;
      var alpha = fade * (cast ? .95 : ground ? .38 * (v.reduced ? 1 : 1 + .1 * Math.sin(t / 10000)) : .2);
      var lift = ground ? 0 : Math.min(14, Math.sqrt(Math.max(0, alt - scene.field.elev)) * .16);
      var dist = core.haversineKm(pose.lat, pose.lng, scene.field.lat, scene.field.lng);
      var lane = role === 'arrival' && !a.runwayAssumed
        ? P.laneOffset(a.runway, dist, heading)
        : { x: 0, y: 0 };
      var x = loc.x + lane.x;
      var y = loc.y - lift + lane.y;
      positions[a.hex] = [x, y];
      if (role === 'departure' && ground && a.status === 'Departing' && a.runway) {
        var rolling = core.matchRunwayDesignator(v.runways, scene.field.iata, a.runway);
        if (rolling)
          line(
            out,
            [
              pt(rolling.thresholdLat, rolling.thresholdLon, v),
              pt(rolling.farEndLat, rolling.farEndLon, v)
            ],
            c.departure,
            2,
            Math.min(.6, (a.speedKts || 0) / 240) * fade
          );
      }
      if (!v.reduced && a.history.length > 1) {
        var windowMs = cast ? 240000 : 90000;
        var points = [];
        for (var i = 0; i < a.history.length; i++) {
          var h = a.history[i];
          if (h[2] > t || h[2] < t - windowMs)
            continue;
          if (h[5]) {
            points = [];
          }
          if (!cast && i % 3 !== 0 && i < a.history.length - 2)
            continue;
          var p = P.project(h[0], h[1], v);
          points.push([
            p.x + lane.x,
            p.y - (h[4] ? 0 : Math.min(14, Math.sqrt(Math.max(0, (h[3] || 0) - scene.field.elev)) * .16)) + lane.y
          ]);
        }
        points.push([x, y]);
        if (points.length > 1)
          out.push({
            kind: 'trail',
            points: points,
            color: color,
            alpha: alpha,
            cast: cast,
            avoid: reserved
          });
      }
      out.push({
        kind: 'circle',
        x: loc.x,
        y: loc.y,
        r: ground ? 1.6 : 2.2,
        fill: color,
        alpha: alpha * .25,
        semantic: 'shadow',
        hex: a.hex
      });
      if (lift > 3)
        line(out, [[loc.x, loc.y], [x, y]], color, .6, alpha * .16);
      var sizes = {
        quadjet: 7,
        widebody: 6.5,
        narrowbody: 5.5,
        bizjet: 4.6,
        turboprop: 4.2,
        light: 3.8
      };
      out.push({
        kind: 'dart',
        x: x,
        y: y,
        angle: heading,
        size: ground ? 3 : sizes[core.sizeClass(a.aircraftType, a.category)] || 4,
        color: color,
        alpha: alpha,
        hex: a.hex,
        role: role,
        seq: a.seq
      });
      if (cast && (role !== 'arrival' || a.seq)) {
        var caption = a.callsign || a.hex;
        if (a.seq === 1 && role === 'arrival')
          caption += '  ' + (coarse(a, t) || eta >= 10
            ? formatLandingEta(eta) : core.formatArrivalCountdown(eta * 60));
        if (role === 'go-around')
          caption += ' ↗';
        chartLabels.push({
          anchorX: x,
          anchorY: y,
          text: caption,
          seq: a.seq,
          color: color,
          alpha: alpha,
          rank: role === 'go-around' ? 110 : a.seq ? 100 - a.seq : 50,
          hex: a.hex,
          zone: 'chart'
        });
      }
    });
    out.push({ kind: 'restore' });
    // A quiet translucent tide band, with continuous time horizontally and altitude vertically.
    out.push({
      kind: 'rect',
      x: 0,
      y: v.chartH,
      w: v.width,
      h: v.stripH,
      fill: c.strip,
      alpha: .97
    });
    line(out, [[30, v.chartH], [v.width - 30, v.chartH]], c.shore, .65, .55);
    var left = 58;
    var right = v.width - 58;
    var nowX = v.width * .74;
    var base = v.height - 61;
    var top = v.chartH + 44;
    var span = Math.max(30, base - top);
    text(out, left, v.chartH + 23, 'ARRIVALS', c.arrival, 9, { spacing: 2 });
    text(out, left + 105, v.chartH + 23, 'ALTITUDE / FT', c.muted, 7, { alpha: .7 });
    [0, 5000, 10000].forEach(function (alt) {
      var y = base - Math.sqrt(alt / 10000) * span;
      text(out, left - 17, y + 3, alt ? alt / 1000 + 'k' : '0', c.muted, 7, { align: 'right', alpha: .65 });
      line(out, [[left - 11, y], [left - 6, y]], c.muted, .5, .4);
    });
    text(out, nowX + 25, v.chartH + 23, 'DEPARTURES', c.departure, 9, { spacing: 2 });
    [15, 10, 5, 0].forEach(function (m) {
      var x = nowX - m / 15 * (nowX - left);
      line(out, [[x, top + 5], [x, base + 7]], c.ring, .6, .6, { dash: m ? [2, 5] : [] });
      text(out, x, base + 22, m ? m + ' MIN' : 'NOW / RUNWAY', c.muted, 8, { align: m ? 'center' : 'right' });
    });
    [1, 3, 5].forEach(function (m) {
      var x = nowX + m / 5 * (right - nowX);
      text(out, x, base + 22, '+' + m, c.muted, 8, { align: 'center' });
    });
    line(out, [[left, base], [right, base]], c.ring, .8, .8);
    line(out, [[nowX, top], [nowX, base + 8]], c.runway, 1, .6);
    var byHex = {};
    items.forEach(function (a) {
      byHex[a.hex] = a;
    });
    ladder.beads.forEach(function (b) {
      var a = byHex[b.hex];
      if (!a)
        return;
      var eta = stripMinutes(a, t, b.etaMin);
      var pose = core.interpolatePlaybackPose(a.samples, t);
      var alt = pose
        ? (pose.prev.altFt || 0) + ((pose.next.altFt || 0) - (pose.prev.altFt || 0)) * pose.progress
        : a.altFt;
      var x = nowX - Math.min(15, eta) / 15 * (nowX - left);
      var y = base - Math.min(1, Math.sqrt(Math.max(0, alt || 0) / 10000)) * span - (b.lane % 2) * 9;
      beads[a.hex] = [x, y];
      out.push({
        kind: 'circle',
        x: x,
        y: y,
        r: 3.4,
        fill: eta < 2 ? c.near : c.arrival,
        alpha: fade,
        semantic: 'bead',
        hex: a.hex
      });
      stripLabels.push({
        anchorX: x,
        anchorY: y,
        text: (a.callsign || a.hex) + (coarse(a, t) ? ' · ' + formatLandingEta(etaMinutes(a, t, b.etaMin)) : ''),
        seq: a.seq,
        color: c.arrival,
        alpha: fade,
        rank: 100 - (a.seq || 10),
        hex: a.hex,
        zone: 'strip'
      });
    });
    var goIndex = 0;
    items.forEach(function (a) {
      if (a.role === 'departure' && (a.departureAtMs == null || t >= a.departureAtMs)) {
        var pose = core.interpolatePlaybackPose(a.samples, t, { maxExtrapolationMs: 0 });
        if (!pose || (pose.prev.ground && pose.next.ground))
          return;
        var alt = (pose.prev.altFt || 0) + ((pose.next.altFt || 0) - (pose.prev.altFt || 0)) * pose.progress;
        var estimated = a.departureAtMs == null;
        // Unknown liftoff: use observed distance for a clearly marked estimated position.
        var mins = estimated
          ? core.haversineKm(pose.lat, pose.lng, scene.field.lat, scene.field.lng) / 5
          : (t - a.departureAtMs) / 60000;
        var x = nowX + Math.min(5, mins) / 5 * (right - nowX);
        var y = base - Math.min(1, Math.sqrt(Math.max(0, alt) / 10000)) * span;
        out.push({
          kind: 'dart',
          x: x,
          y: y,
          size: 4,
          angle: 55,
          color: c.departure,
          alpha: fade,
          semantic: 'bead',
          hex: a.hex
        });
        stripLabels.push({
          anchorX: x,
          anchorY: y,
          text: (a.callsign || a.hex) + (estimated ? ' · EST' : ''),
          seq: null,
          color: c.departure,
          alpha: fade,
          rank: 45,
          hex: a.hex,
          zone: 'strip'
        });
      }
      else if (a.role === 'go-around') {
        var x = right - 30;
        var y = v.chartH - 42 - goIndex++ * 28;
        out.push({
          kind: 'circle',
          x: x + 15,
          y: y - 3,
          r: 3,
          color: c.go,
          width: 1,
          alpha: fade
        });
        text(
          out,
          x,
          y,
          '↗ ' + (a.callsign || a.hex) + ' · GOING AROUND',
          c.go,
          9,
          { align: 'right', alpha: fade }
        );
      }
    });
    ladder.pairs.forEach(function (pair) {
      if (beads[pair.a] && beads[pair.b])
        line(out, [beads[pair.a], beads[pair.b]], c.arrival, 1, .4, { semantic: 'pair' });
      if (positions[pair.a] && positions[pair.b])
        line(out, [positions[pair.a], positions[pair.b]], c.arrival, .7, .3);
    });
    labels(
      out,
      chartLabels,
      v,
      measureText,
      { left: 26, right: v.width - 30, top: 180, bottom: v.chartH - 28 },
      reserved
    );
    labels(
      out,
      stripLabels,
      v,
      measureText,
      { left: left - 12, right: right, top: v.chartH + 31, bottom: base + 3 }
    );
    if (!v.reduced)
      W.Moments.active(scene, t).forEach(function (e) {
        var p = P.project(e.lat, e.lng, v);
        var f = (t - e.atMs) / e.duration;
        var col = e.type === 'touchdown' ? c.arrival : e.type === 'takeoff' ? c.departure : c.go;
        out.push({
          kind: 'circle',
          x: p.x,
          y: p.y,
          r: 4 + (1 - Math.pow(1 - f, 2)) * 27,
          color: col,
          width: .85,
          glow: 4,
          alpha: Math.sin(Math.PI * f) * .45,
          semantic: 'moment',
          event: e.type,
          hex: e.hex
        });
        if (e.type === 'takeoff') {
          var h = e.track * Math.PI / 180;
          line(
            out,
            [[p.x, p.y], [p.x - Math.sin(h) * 20 * f, p.y + Math.cos(h) * 20 * f]],
            col,
            1.6,
            Math.sin(Math.PI * f) * .5,
            { glow: 4 }
          );
        }
        if (e.type === 'touchdown' || e.type === 'takeoff') {
          var r = core.matchRunwayDesignator(v.runways, scene.field.iata, e.runway);
          if (r) {
            var a = pt(r.thresholdLat, r.thresholdLon, v);
            var b = pt(r.farEndLat, r.farEndLon, v);
            line(
              out,
              [
                a,
                [a[0] + (b[0] - a[0]) * Math.min(1, f * 3), a[1] + (b[1] - a[1]) * Math.min(1, f * 3)]
              ],
              col,
              2.5,
              Math.sin(Math.PI * f) * .65,
              { glow: 6 }
            );
          }
          out.push({
            kind: 'circle',
            x: nowX + f * (e.type === 'takeoff' ? 24 : 0),
            y: base + (e.type === 'touchdown' ? f * 17 : -f * 25),
            r: 3,
            fill: col,
            alpha: Math.sin(Math.PI * f)
          });
        }
      });
    // End designators are painted last and reserved during flight-label placement.
    reserved.forEach(function (label) {
      out.push(label);
    });
    return out;
  }
  W.Display = {
    buildDisplayList: buildDisplayList,
    staticList: staticList,
    runwayLabels: runwayLabels
  };
})(globalThis.Watch);
