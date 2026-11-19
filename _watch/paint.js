(function (W) {
  'use strict';
  function path(ctx, points, close) {
    ctx.beginPath();
    points.forEach(function (q, i) {
      if (i)
        ctx.lineTo(q[0], q[1]);
      else
        ctx.moveTo(q[0], q[1]);
    });
    if (close)
      ctx.closePath();
  }
  function geography(ctx, p) {
    // An isolated alpha layer fades both land and water into the page without tinting their inner colours.
    var layer = document.createElement('canvas');
    layer.width = ctx.canvas.width;
    layer.height = ctx.canvas.height;
    var g = layer.getContext('2d');
    g.setTransform(ctx.getTransform());
    g.save();
    g.beginPath();
    g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = p.water;
    g.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    g.fillStyle = p.land;
    p.polygons.forEach(function (poly) {
      g.beginPath();
      poly.forEach(function (ring) {
        ring.forEach(function (q, i) {
          if (i)
            g.lineTo(q[0], q[1]);
          else
            g.moveTo(q[0], q[1]);
        });
        g.closePath();
      });
      g.fill('evenodd');
    });
    g.strokeStyle = p.shore;
    g.lineWidth = .55;
    g.globalAlpha = .65;
    g.beginPath();
    p.shores.forEach(function (shore) {
      shore.forEach(function (q, i) {
        if (i)
          g.lineTo(q[0], q[1]);
        else
          g.moveTo(q[0], q[1]);
      });
    });
    g.stroke();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    var mask = g.createRadialGradient(p.x, p.y, p.r * .65, p.x, p.y, p.r);
    mask.addColorStop(0, '#000');
    mask.addColorStop(.4, '#000000e0');
    mask.addColorStop(.8, '#00000040');
    mask.addColorStop(1, '#00000000');
    g.fillStyle = mask;
    g.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    g.restore();
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }
  function trail(ctx, p) {
    ctx.save();
    // Keep departure tails out of the runway designators, without moving either the aircraft or the end labels.
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    p.avoid.forEach(function (b) {
      ctx.rect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
    });
    ctx.clip('evenodd');
    if (p.cast) {
      // Segment widths and opacity both rise toward the dart. Only the short luminous head needs a glow.
      for (var i = 1; i < p.points.length; i++) {
        var weight = i / (p.points.length - 1);
        ctx.lineWidth = .3 + weight * 1.3;
        ctx.globalAlpha = p.alpha * weight * weight * .5;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = weight > .8 ? 3 : 0;
        path(ctx, [p.points[i - 1], p.points[i]]);
        ctx.stroke();
      }
    }
    else {
      var a = p.points[0];
      var b = p.points[p.points.length - 1];
      var gradient = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      gradient.addColorStop(0, p.color + '00');
      gradient.addColorStop(1, p.color + '50');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = .5;
      path(ctx, p.points);
      ctx.stroke();
    }
    ctx.restore();
  }
  function numericText(ctx, method, text, x, y) {
    if (!/\d:\d/.test(text)) {
      ctx[method](text, x, y);
      return;
    }
    // Keep mono numeral advances and the original label bounds, but use a compact punctuation cell.
    text.split(':').forEach(function (part, i, parts) {
      ctx[method](part, x, y);
      x += ctx.measureText(part).width;
      if (i < parts.length - 1) {
        var colonWidth = ctx.measureText(':').width;
        ctx[method](':', x - colonWidth * .22, y);
        x += colonWidth * .56;
      }
    });
  }
  function haloText(ctx, text, x, y, color) {
    // Soft text-shaped ink clearance replaces rectangular plates, keeping the geography visible between letters.
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    numericText(ctx, 'strokeText', text, x, y);
    numericText(ctx, 'fillText', text, x, y);
    ctx.shadowBlur = 0;
  }
  function label(ctx, p) {
    ctx.save();
    ctx.letterSpacing = '0px';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = p.color;
    if (p.kind === 'runwayLabel') {
      ctx.font = '8px "B612 Mono", monospace';
      ctx.textAlign = 'center';
      haloText(ctx, p.text, p.x + p.w / 2, p.y + p.h / 2, p.halo);
    }
    else {
      ctx.font = '10px "B612 Mono", monospace';
      ctx.textAlign = 'left';
      var tx = p.x + 6;
      if (p.seq) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = .65;
        ctx.beginPath();
        ctx.arc(p.x + 11, p.y + 11, 7.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.font = '9px "B612 Mono", monospace';
        haloText(ctx, String(p.seq), p.x + 11, p.y + 11, p.halo);
        ctx.textAlign = 'left';
        ctx.font = '10px "B612 Mono", monospace';
        tx = p.x + 24;
      }
      haloText(ctx, p.text, tx, p.y + 11, p.halo);
    }
    ctx.restore();
  }
  function paint(ctx, list) {
    var alpha = -1;
    var width = -1;
    var stroke = null;
    var fill = null;
    var dash = null;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.letterSpacing = '0px';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var a = p.alpha == null ? 1 : p.alpha;
      var w = p.width || 1;
      var s = p.color || 'transparent';
      var f = p.fill || p.color || 'transparent';
      var d = p.dash ? p.dash.join(',') : '';
      if (alpha !== a) {
        ctx.globalAlpha = a;
        alpha = a;
      }
      if (width !== w) {
        ctx.lineWidth = w;
        width = w;
      }
      if (stroke !== s) {
        ctx.strokeStyle = s;
        stroke = s;
      }
      if (fill !== f) {
        ctx.fillStyle = f;
        fill = f;
      }
      if (dash !== d) {
        ctx.setLineDash(p.dash || []);
        dash = d;
      }
      ctx.shadowColor = s;
      ctx.shadowBlur = p.glow || 0;
      if (p.kind === 'clipCircle') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.clip();
      }
      else if (p.kind === 'restore') {
        ctx.restore();
        alpha = width = -1;
        stroke = fill = dash = null;
      }
      else if (p.kind === 'rect') {
        ctx.fillRect(p.x, p.y, p.w, p.h);
      }
      else if (p.kind === 'geography') {
        geography(ctx, p);
      }
      else if (p.kind === 'cone') {
        var gradient = ctx.createLinearGradient(p.start[0], p.start[1], p.end[0], p.end[1]);
        gradient.addColorStop(0, p.color);
        gradient.addColorStop(.45, p.color + '80');
        gradient.addColorStop(1, p.color + '00');
        ctx.fillStyle = gradient;
        path(ctx, p.points, true);
        ctx.fill();
        fill = null;
      }
      else if (p.kind === 'path') {
        path(ctx, p.points, p.closed);
        if (p.fill)
          ctx.fill();
        if (p.color)
          ctx.stroke();
      }
      else if (p.kind === 'trail') {
        trail(ctx, p);
      }
      else if (p.kind === 'circle') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (p.fill)
          ctx.fill();
        else
          ctx.stroke();
      }
      else if (p.kind === 'dart') {
        var h = p.angle * Math.PI / 180;
        var sine = Math.sin(h);
        var cosine = Math.cos(h);
        var r = p.size;
        var points = [[0, -r * 1.3], [r * .5, r * .75], [0, r * .3], [-r * .5, r * .75]];
        path(
          ctx,
          points.map(function (q) {
            return [
              p.x + q[0] * cosine - q[1] * sine, p.y + q[0] * sine + q[1] * cosine
            ];
          }),
          true
        );
        ctx.fill();
      }
      else if (p.kind === 'text') {
        ctx.font = (p.size || 10) + 'px "B612 Mono", monospace';
        ctx.textAlign = p.align || 'left';
        ctx.textBaseline = p.baseline || 'alphabetic';
        // Canvas inherits CSS tracking in some browsers. Explicitly reset it for every numeric string.
        ctx.letterSpacing = /[0-9]/.test(p.text) ? '0px' : (p.spacing || 0) + 'px';
        ctx.fillText(p.text, p.x, p.y);
        ctx.letterSpacing = '0px';
      }
      else if (p.kind === 'label' || p.kind === 'runwayLabel') {
        label(ctx, p);
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
  function Painter(staticCanvas, dynamicCanvas) {
    this.staticCanvas = staticCanvas;
    this.dynamicCanvas = dynamicCanvas;
    this.staticCtx = staticCanvas.getContext('2d', { alpha: false });
    this.ctx = dynamicCanvas.getContext('2d');
    this.key = '';
    this.widths = new Map();
  }
  Painter.prototype.resize = function (v) {
    var dpr = Math.min(2, devicePixelRatio || 1);
    [this.staticCanvas, this.dynamicCanvas].forEach(function (c) {
      c.width = Math.round(v.width * dpr);
      c.height = Math.round(v.height * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    this.key = '';
  };
  Painter.prototype.draw = function (scene, v, geo, t) {
    var key = [
      v.width,
      v.height,
      v.palette.bg,
      scene.board.activeArrivalRunways.join(','),
      scene.departureRunways.join(',')
    ].join('|');
    if (key !== this.key) {
      this.staticList = W.Display.staticList(scene, v, geo);
      v.runwayLabels = W.Display.runwayLabels(v);
      paint(this.staticCtx, this.staticList);
      this.key = key;
    }
    var self = this;
    var list = W.Display.buildDisplayList(
      scene,
      v,
      t,
      function (text, size) {
        var key = size + text;
        if (!self.widths.has(key)) {
          if (self.widths.size >= 512)
            self.widths.delete(self.widths.keys().next().value);
          self.ctx.font = size + 'px "B612 Mono", monospace';
          self.ctx.letterSpacing = '0px';
          self.widths.set(key, self.ctx.measureText(text).width);
        }
        return self.widths.get(key);
      }
    );
    this.ctx.clearRect(0, 0, v.width, v.height);
    paint(this.ctx, list);
    return list;
  };
  W.Paint = { paint: paint, Painter: Painter };
})(globalThis.Watch);
