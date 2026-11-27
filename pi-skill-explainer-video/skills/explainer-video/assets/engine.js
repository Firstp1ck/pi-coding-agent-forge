/*
 * Explainer video engine.
 *
 * Renders a storyboard at any time `t` (seconds) with no hidden animation state,
 * so the renderer can capture frame N without playing frames 0..N-1 first.
 * Loaded as a classic script in the browser (exposes globalThis.ExplainerVideo)
 * and with require() in Node, where only the pure helpers are used.
 */
(function (root) {
  'use strict';

  // Overlap between neighbouring steps. Both scenes are visible for this long,
  // which reads as a crossfade instead of a dip to black.
  var CROSSFADE = 0.5;
  var OUTRO_DEFAULT = 4;
  var VIEW = { x: 150, y: 60, w: 1620, h: 820 };
  var MAX_ZOOM = 3.2;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeInOut(k) { k = clamp(k, 0, 1); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
  function easeOut(k) { k = clamp(k, 0, 1); return 1 - Math.pow(1 - k, 3); }
  function ramp(t, start, dur) { return dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur, 0, 1); }

  /**
   * Compute absolute start/end times for every step and the outro.
   * @param {object} sb storyboard
   * @returns {{steps: {index:number,start:number,end:number}[], outro: {start:number,end:number}|null, total:number}}
   */
  function buildTimeline(sb) {
    var t = 0;
    var steps = (sb.steps || []).map(function (step, index) {
      var entry = { index: index, start: t, end: t + Number(step.duration) };
      t = entry.end;
      return entry;
    });
    var outro = null;
    if (sb.outro) {
      var d = Number(sb.outro.duration || OUTRO_DEFAULT);
      outro = { start: t, end: t + d };
      t += d;
    }
    return { steps: steps, outro: outro, total: t };
  }

  /** Visibility (0..1) of a segment at time t, fading in and out across its edges. */
  function segmentOpacity(t, start, end, fadeIn, fadeOut) {
    var half = CROSSFADE / 2;
    var a = fadeIn ? ramp(t, start - half, CROSSFADE) : (t >= start ? 1 : 0);
    var b = fadeOut ? 1 - ramp(t, end - half, CROSSFADE) : (t < end ? 1 : 0);
    return Math.min(a, b);
  }

  /** The incoming shot chooses the transition for both sides of its edit. */
  function stepOpacity(t, seg, sb) {
    var next = sb.steps[seg.index + 1];
    if (!next && !sb.outro && sb.framing === 'full-app' && t === seg.end) return 1;
    var fadeIn = seg.index > 0 && sb.steps[seg.index].transition !== 'cut';
    var fadeOut = next ? next.transition !== 'cut' : !!sb.outro;
    return segmentOpacity(t, seg.start, seg.end, fadeIn, fadeOut);
  }

  /**
   * Interpolate a keyframe track at local time t. Keys must be sorted by `at`.
   * A key's value is reached at its own `at`. The move toward it starts after the
   * previous key and takes `key.move` seconds (default: the whole gap), eased in and out.
   * @param {{at:number, move?:number}[]} keys
   * @param {number} t
   * @param {(key:object) => number[]} valueOf
   * @returns {number[]|null} null when the track is empty
   */
  function sampleTrack(keys, t, valueOf) {
    if (!keys.length) return null;
    if (t <= keys[0].at) return valueOf(keys[0]);
    for (var i = 1; i < keys.length; i++) {
      var prev = keys[i - 1];
      var next = keys[i];
      if (t < next.at) {
        var move = next.move != null ? Number(next.move) : next.at - prev.at;
        var k = easeInOut(ramp(t, next.at - move, move));
        var a = valueOf(prev);
        var b = valueOf(next);
        return a.map(function (v, j) { return lerp(v, b[j], k); });
      }
    }
    return valueOf(keys[keys.length - 1]);
  }

  // Distance under a smoothstep velocity ramp, normalized to end at one.
  function rampDistance(u) { return u * u * u * (2 - u); }

  function captionProgress(p, continuous, captionEase) {
    if (captionEase === 'fast-slow') {
      var peakAt = 0.14;
      if (p < peakAt) return peakAt * rampDistance(p / peakAt);
      return 1 - (1 - peakAt) * rampDistance((1 - p) / (1 - peakAt));
    }
    return continuous ? p * p * (3 - 2 * p) : easeInOut(p);
  }

  /** The caption keeps its line breaks while its left and top edges follow the action. */
  function captionPlacement(caption, t, continuous, captionEase) {
    var x = caption.box[0], y = caption.box[1], previousTime = 0;
    var track = caption.track || [];
    for (var i = 0; i < track.length; i++) {
      var key = track[i];
      var move = Math.min(key.move == null ? 0.55 : key.move, key.at - previousTime);
      if (t < key.at) {
        var progress = ramp(t, key.at - move, move);
        if (!continuous && key.transition === 'fade') {
          var outgoing = progress < 0.5;
          return { x: outgoing ? x : key.x, y: outgoing ? y : key.y, alpha: easeInOut(Math.abs(1 - 2 * progress)) };
        }
        var k = captionProgress(progress, continuous, captionEase);
        return { x: lerp(x, key.x, k), y: lerp(y, key.y, k), alpha: 1 };
      }
      x = key.x;
      y = key.y;
      previousTime = key.at;
    }
    return { x: x, y: y, alpha: 1 };
  }

  /** Scale and offset that fit scene rect r = [x,y,w,h] into the view box. */
  function fitCamera(r, view, maxZoom) {
    view = view || VIEW;
    var s = Math.min(view.w / r[2], view.h / r[3], maxZoom || MAX_ZOOM);
    var cx = r[0] + r[2] / 2;
    var cy = r[1] + r[3] / 2;
    return { s: s, tx: view.x + view.w / 2 - cx * s, ty: view.y + view.h / 2 - cy * s };
  }

  /**
   * Keep the scene covering the frame area so a camera aimed near an edge never
   * reveals the scene's border. A scene smaller than the area on an axis is centred.
   * The edge may come `margin` px into the frame: the stage mask fades that band to
   * black, and the slack keeps edge elements away from the very rim of the frame.
   * @param {{s:number,tx:number,ty:number}} cam
   * @param {number[]} size scene [width, height]
   * @param {{w:number,h:number,margin?:number}} area frame region to cover, from the top-left corner
   */
  function clampCamera(cam, size, area) {
    var m = area.margin || 0;
    function axis(t, sceneLen, areaLen) {
      var len = sceneLen * cam.s;
      if (len <= areaLen - 2 * m) return (areaLen - len) / 2;
      return clamp(t, areaLen - len - m, m);
    }
    return { s: cam.s, tx: axis(cam.tx, size[0], area.w), ty: axis(cam.ty, size[1], area.h) };
  }

  function sortByAt(list) {
    return (list || []).slice().sort(function (a, b) { return Number(a.at) - Number(b.at); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- browser

  /**
   * Build the DOM for a storyboard inside a page made from player.html.
   * @param {Document} doc page that contains #ev-stage, #ev-scenes, #ev-overlay and the scene templates
   * @param {object} sb validated storyboard
   * @throws {Error} when a scene template or action selector is missing
   */
  function Player(doc, sb) {
    this.doc = doc;
    this.sb = sb;
    this.timeline = buildTimeline(sb);
    this.fullApp = sb.framing === 'full-app';
    this.view = this.fullApp ? { x: 0, y: 0, w: sb.width || 1920, h: sb.height || 1080 } : Object.assign({}, VIEW, sb.view || {});
    this.maxZoom = Number(sb.maxZoom || MAX_ZOOM);
    // Everything above the caption band; the stage mask fades the rest to black.
    this.coverArea = { w: Number(sb.width || 1920), h: this.view.y + this.view.h + 20, margin: 60 };
    this.sceneLayer = doc.getElementById('ev-scenes');
    if (this.fullApp) this.sceneLayer.classList.add('ev-full-app');
    this.overlay = doc.getElementById('ev-overlay');
    this.steps = [];
    this._build();
  }

  Player.prototype._build = function () {
    var self = this;
    var doc = this.doc;
    this.sb.steps.forEach(function (step, index) {
      var host = doc.createElement('div');
      host.className = 'ev-step';
      var scene = doc.createElement('div');
      scene.className = 'ev-scene';
      var size = null;
      if (step.image) {
        var img = doc.createElement('img');
        img.src = step.image;
        img.alt = '';
        img.className = 'ev-shot';
        scene.appendChild(img);
        size = step.imageSize || null;
      } else {
        var tpl = doc.getElementById(step.scene);
        if (!tpl || tpl.tagName !== 'TEMPLATE') throw new Error('Step ' + (index + 1) + ': no <template id="' + step.scene + '"> in the scenes file');
        scene.appendChild(tpl.content.cloneNode(true));
        size = [Number(tpl.dataset.width || 1920), Number(tpl.dataset.height || 1080)];
      }
      if (size) {
        scene.style.width = size[0] + 'px';
        scene.style.height = size[1] + 'px';
      }
      var shade = null;
      if (step.spotlights && step.spotlights.length) {
        shade = doc.createElement('canvas');
        shade.className = 'ev-shade';
        scene.appendChild(shade);
      }
      host.appendChild(scene);
      self.sceneLayer.appendChild(host);

      var highlights = (step.highlights || []).map(function () {
        var el = doc.createElement('div');
        el.className = 'ev-ring';
        self.overlay.appendChild(el);
        return el;
      });
      var cursor = doc.createElement('div');
      cursor.className = 'ev-cursor';
      cursor.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2.5v17.2l4.6-4.3 3 6.9 3.1-1.3-3-6.8h6.3z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="ev-click"></span>';
      self.overlay.appendChild(cursor);

      var actions = sortByAt(step.actions);
      var targets = new Map();
      function track(a) {
        var selector = a.target;
        var entry = targets.get(selector);
        if (!entry) {
          var el = scene.querySelector(selector);
          if (!el) throw new Error('Step ' + (index + 1) + ': selector "' + selector + '" matches nothing in scene "' + (step.scene || step.image) + '"');
          entry = { selector: selector, el: el, html: null, className: el.className, opacityActions: [] };
          targets.set(selector, entry);
        }
        // Only content actions snapshot innerHTML: restoring it recreates child
        // nodes, which other actions may target.
        if ((a.type === 'type' || a.type === 'text') && entry.html == null) entry.html = entry.el.innerHTML;
        return entry;
      }
      (step.setup || []).forEach(track);
      actions.forEach(function (a) {
        var entry = track(a);
        if (a.type === 'show' || a.type === 'hide') entry.opacityActions.push(a);
      });

      self.steps.push({
        def: step,
        host: host,
        shade: shade,
        scene: scene,
        size: size,
        highlights: highlights,
        cursor: cursor,
        actions: actions,
        targets: targets,
        camera: sortByAt(step.camera),
        cursorKeys: sortByAt(step.cursor),
        cam: { s: 1, tx: 0, ty: 0 }
      });
    });

    this.caption = doc.getElementById('ev-caption');
    if (this.sb.captionMotion === 'continuous') this.caption.classList.add('ev-continuous');
    this.keycap = doc.getElementById('ev-keys');
    this.outro = doc.getElementById('ev-outro');
    this._buildOutro();
  };

  Player.prototype._buildOutro = function () {
    var o = this.sb.outro;
    if (!o) { this.outro.remove(); this.outro = null; return; }
    var title = (o.title || []).map(function (line, i) {
      return '<div class="ev-o-line' + (i ? ' ev-o-dim' : '') + '">' + escapeHtml(line) + '</div>';
    }).join('');
    var logo = '';
    if (o.logo) logo = '<div class="ev-o-logo"><img src="' + escapeHtml(o.logo) + '" alt=""></div>';
    else if (o.logoText) logo = '<div class="ev-o-logo ev-o-logotext">' + escapeHtml(o.logoText) + '</div>';
    var avail = '';
    if (o.product) {
      avail = '<div class="ev-o-avail">' + escapeHtml(o.lead || 'Available now in') + ' <b>' + escapeHtml(o.product) + '</b>' +
        (o.version ? ' <span class="ev-o-ver">' + escapeHtml(o.version) + '</span>' : '') + '</div>';
    }
    var url = o.url ? '<div class="ev-o-url">' + escapeHtml(o.url) + '</div>' : '';
    this.outro.innerHTML = '<div class="ev-o-glow"></div><div class="ev-o-inner">' + logo + '<div class="ev-o-title">' + title + '</div>' + avail + url + '</div>';
  };

  /**
   * Resolve a rect spec to scene coordinates.
   * Arrays are used as-is; {target, pad} measures the element and inverts the
   * camera transform that is currently applied to the scene.
   */
  Player.prototype._rect = function (st, spec) {
    if (Array.isArray(spec)) return spec.map(Number);
    var el = st.scene.querySelector(spec.target);
    if (!el) throw new Error('Rect target "' + spec.target + '" matches nothing in scene "' + (st.def.scene || st.def.image) + '"');
    var b = el.getBoundingClientRect();
    var c = st.cam;
    var pad = spec.pad != null ? Number(spec.pad) : 10;
    return [(b.left - c.tx) / c.s - pad, (b.top - c.ty) / c.s - pad, b.width / c.s + pad * 2, b.height / c.s + pad * 2];
  };

  /** Reset every touched element, then replay setup and the actions that started by local time tl. */
  Player.prototype._applyActions = function (st, tl) {
    st.targets.forEach(function (entry) {
      if (entry.html != null) entry.el.innerHTML = entry.html;
    });
    // A content reset above may have replaced nested targets, so resolve them again.
    st.targets.forEach(function (entry) {
      if (!entry.el.isConnected) entry.el = st.scene.querySelector(entry.selector);
      entry.el.className = entry.className;
      var first = entry.opacityActions[0];
      entry.el.style.opacity = first && first.type === 'show' ? '0' : '';
      entry.el.style.transform = '';
    });
    function apply(a, k, instant) {
      var el = st.targets.get(a.target).el;
      switch (a.type) {
        case 'type': {
          var n = instant ? a.text.length : Math.floor((tl - Number(a.at)) * Number(a.cps || 16));
          el.textContent = a.text.slice(0, clamp(n, 0, a.text.length));
          break;
        }
        case 'text':
          el.innerHTML = a.html != null ? a.html : escapeHtml(a.text);
          break;
        case 'class':
          if (a.add) a.add.split(/\s+/).forEach(function (c) { if (c) el.classList.add(c); });
          if (a.remove) a.remove.split(/\s+/).forEach(function (c) { if (c) el.classList.remove(c); });
          break;
        case 'show':
        case 'hide': {
          var v = a.type === 'show' ? easeOut(k) : 1 - easeOut(k);
          var dx = Number(a.dx || 0);
          var dy = Number(a.dy != null ? a.dy : 10);
          el.style.opacity = String(v);
          var offset = (1 - v) * (a.type === 'show' ? 1 : -1);
          el.style.transform = (dx || dy) && k < 1
            ? 'translate(' + (offset * dx).toFixed(2) + 'px,' + (offset * dy).toFixed(2) + 'px)' : '';
          break;
        }
        default:
          throw new Error('Unknown action type "' + a.type + '"');
      }
    }
    (st.def.setup || []).forEach(function (a) { apply(a, 1, true); });
    st.actions.forEach(function (a) {
      var at = Number(a.at);
      if (tl < at) return;
      var dur = a.type === 'show' || a.type === 'hide' ? Number(a.dur != null ? a.dur : 0.35) : 0;
      apply(a, ramp(tl, at, dur), false);
    });
  };

  /** Paint the union of the lit regions onto a single scrim in scene coordinates. */
  Player.prototype._renderSpotlights = function (st, t) {
    if (!st.shade) return;
    var active = st.def.spotlights.filter(function (spot) {
      return t >= spot.from && t < (spot.to == null ? st.def.duration : spot.to);
    });
    st.shade.hidden = !active.length;
    if (!active.length) return;
    var canvas = st.shade;
    // Rasterize full-window outlines at playback resolution even for a small source image.
    var resolution = this.fullApp && this.sb.spotlightOutline ? st.cam.s : 1;
    var width = Math.max(1, Math.round(st.size[0] * resolution));
    var height = Math.max(1, Math.round(st.size[1] * resolution));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(width / st.size[0], 0, 0, height / st.size[1], 0, 0);
    ctx.clearRect(0, 0, st.size[0], st.size[1]);
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(0, 0, st.size[0], st.size[1]);
    var self = this;
    var regions = active.map(function (spot) { return self._rect(st, spot.rect); });
    regions.forEach(function (r) { ctx.clearRect(r[0], r[1], r[2], r[3]); });
    if (this.sb.spotlightOutline === true) {
      // Trace outside the lit pixels so even a one-line label stays readable.
      var px = 1 / st.cam.s;
      ctx.beginPath();
      regions.forEach(function (r) {
        ctx.roundRect(r[0] - 2 * px, r[1] - 2 * px, r[2] + 4 * px, r[3] + 4 * px, 5 * px);
      });
      ctx.lineWidth = 14 * px;
      ctx.strokeStyle = 'rgba(78,205,255,.24)';
      ctx.stroke();
      ctx.lineWidth = 7 * px;
      ctx.strokeStyle = '#102330';
      ctx.stroke();
      ctx.lineWidth = 4 * px;
      ctx.strokeStyle = '#70dcff';
      ctx.stroke();
    }
  };

  Player.prototype._renderStep = function (st, seg, t) {
    var tl = t - seg.start;
    var opacity = stepOpacity(t, seg, this.sb);
    var visible = opacity > 0.001;
    st.host.style.opacity = String(opacity);
    st.host.style.visibility = visible ? 'visible' : 'hidden';
    st.cursor.style.opacity = '0';
    st.highlights.forEach(function (el) { el.style.opacity = '0'; });
    if (!visible) return;
    var tc = clamp(tl, 0, st.def.duration);

    this._applyActions(st, tc);

    var self = this;
    var cam;
    if (this.fullApp) {
      cam = fitCamera([0, 0, st.size[0], st.size[1]], this.view, Infinity);
    } else if (st.camera.length) {
      var rect = sampleTrack(st.camera, tc, function (key) { return self._rect(st, key.rect); });
      cam = fitCamera(rect, this.view, this.maxZoom);
    } else {
      cam = fitCamera([0, 0, st.size[0], st.size[1]], this.view, this.maxZoom);
    }
    var drift = this.fullApp || st.def.drift === false ? 1 : 1 + 0.012 * ramp(tl, 0, st.def.duration);
    var cx = this.view.x + this.view.w / 2;
    var cy = this.view.y + this.view.h / 2;
    cam = { s: cam.s * drift, tx: cx - (cx - cam.tx) * drift, ty: cy - (cy - cam.ty) * drift };
    if (!this.fullApp && st.def.clamp !== false) cam = clampCamera(cam, st.size, this.coverArea);
    st.cam = cam;
    st.scene.style.transform = 'translate(' + cam.tx.toFixed(2) + 'px,' + cam.ty.toFixed(2) + 'px) scale(' + cam.s.toFixed(5) + ')';

    this._renderSpotlights(st, tc);
    (st.def.highlights || []).forEach(function (h, i) {
      var from = Number(h.from);
      var to = Number(h.to != null ? h.to : st.def.duration);
      var a = Math.min(ramp(tc, from, 0.35), 1 - ramp(tc, to - 0.3, 0.3));
      if (a <= 0) return;
      var r = self._rect(st, h.rect);
      var pop = 1 + 0.04 * (1 - easeOut(ramp(tc, from, 0.45)));
      var w = r[2] * cam.s;
      var hgt = r[3] * cam.s;
      var el = st.highlights[i];
      el.style.opacity = String(a * opacity);
      el.style.left = (r[0] * cam.s + cam.tx - (w * (pop - 1)) / 2).toFixed(2) + 'px';
      el.style.top = (r[1] * cam.s + cam.ty - (hgt * (pop - 1)) / 2).toFixed(2) + 'px';
      el.style.width = (w * pop).toFixed(2) + 'px';
      el.style.height = (hgt * pop).toFixed(2) + 'px';
    });

    this._renderCursor(st, tc, cam, opacity);
  };

  Player.prototype._renderCursor = function (st, tc, cam, opacity) {
    var keys = st.cursorKeys;
    if (!keys.length || tc < keys[0].at - 0.3) return;
    var p = sampleTrack(keys, tc, function (key) { return [Number(key.x), Number(key.y)]; });
    var lastKey = keys[keys.length - 1];
    var fade = Math.min(ramp(tc, keys[0].at - 0.3, 0.3), lastKey.hide ? 1 - ramp(tc, lastKey.at, 0.3) : 1);
    var press = 0;
    var ring = 0;
    keys.forEach(function (key) {
      if (!key.click) return;
      var d = tc - key.at;
      if (d >= 0 && d < 0.5) {
        ring = d / 0.5;
        press = Math.max(press, 1 - Math.abs(d - 0.08) / 0.12);
      }
    });
    st.cursor.style.opacity = String(fade * opacity);
    st.cursor.style.transform = 'translate(' + (p[0] * cam.s + cam.tx).toFixed(2) + 'px,' + (p[1] * cam.s + cam.ty).toFixed(2) + 'px) scale(' + (1 - 0.12 * clamp(press, 0, 1)).toFixed(3) + ')';
    var clickEl = st.cursor.lastChild;
    clickEl.style.opacity = ring > 0 ? String(1 - ring) : '0';
    clickEl.style.transform = 'translate(-50%,-50%) scale(' + (0.3 + ring * 1.2).toFixed(3) + ')';
  };

  Player.prototype._renderCaption = function (t) {
    var sb = this.sb;
    var html = '';
    this.timeline.steps.forEach(function (seg, i) {
      var c = sb.steps[i].caption;
      if (!c) return;
      var continuous = sb.captionMotion === 'continuous';
      var lastFrame = !sb.outro && i === sb.steps.length - 1 && t === seg.end;
      var a = continuous ? Number(t >= seg.start && (t < seg.end || lastFrame)) : stepOpacity(t, seg, sb);
      if (a <= 0.001) return;
      var dy = (1 - easeOut(ramp(t - seg.start, -0.1, 0.5))) * 8;
      var num = c.number != null ? c.number : i + 1;
      var placement = '';
      if (c.box) {
        var position = captionPlacement(c, t - seg.start, continuous, sb.captionEase);
        a *= position.alpha;
        if (continuous || (c.track && c.track.length)) dy = 0;
        placement = 'left:' + position.x + 'px;top:' + position.y + 'px;width:' + Number(c.box[2]) + 'px;';
      }
      var shift = c.box ? 'translateY(' + dy.toFixed(2) + 'px)' : 'translate(-50%,' + dy.toFixed(2) + 'px)';
      html += '<div class="ev-cap' + (c.box ? ' ev-cap-placed' : '') + '" style="' + placement + 'opacity:' + a.toFixed(3) + ';transform:' + shift + '">' +
        (num ? '<span class="ev-num">' + escapeHtml(num) + '</span>' : '') +
        '<span class="ev-bold">' + escapeHtml(c.bold) + '</span>' +
        (c.rest ? ' <span class="ev-rest">' + escapeHtml(c.rest) + '</span>' : '') + '</div>';
    });
    this.caption.innerHTML = html;
  };

  Player.prototype._renderKeys = function (t) {
    var sb = this.sb;
    var html = '';
    this.timeline.steps.forEach(function (seg, i) {
      if (sb.steps[i + 1] && sb.steps[i + 1].transition === 'cut' && t >= seg.end) return;
      (sb.steps[i].keys || []).forEach(function (k) {
        var at = seg.start + Number(k.at);
        var dur = Number(k.dur || 1.1);
        var a = Math.min(ramp(t, at, 0.15), 1 - ramp(t, at + dur - 0.25, 0.25));
        if (a <= 0) return;
        var press = clamp(1 - Math.abs(t - at - 0.12) / 0.12, 0, 1);
        html += '<div class="ev-key" style="opacity:' + a.toFixed(3) + ';transform:translate(-50%,' + (press * 3).toFixed(2) + 'px)">' +
          '<kbd>' + escapeHtml(k.label) + '</kbd>' + (k.hint ? '<span>' + escapeHtml(k.hint) + '</span>' : '') + '</div>';
      });
    });
    this.keycap.innerHTML = html;
  };

  Player.prototype._renderOutro = function (t) {
    if (!this.outro) return;
    var seg = this.timeline.outro;
    var a = segmentOpacity(t, seg.start, seg.end, true, false);
    this.outro.style.opacity = String(a);
    this.outro.style.visibility = a > 0.001 ? 'visible' : 'hidden';
    var k = easeOut(ramp(t, seg.start - 0.1, 0.9));
    this.outro.firstChild.style.opacity = String(k);
    this.outro.lastChild.style.transform = 'translateY(' + ((1 - k) * 18).toFixed(2) + 'px) scale(' + (0.97 + 0.03 * k).toFixed(4) + ')';
  };

  /** Render the frame at time t (seconds). Synchronous; returns the clamped time. */
  Player.prototype.seek = function (t) {
    t = clamp(Number(t), 0, this.timeline.total);
    var self = this;
    this.timeline.steps.forEach(function (seg, i) { self._renderStep(self.steps[i], seg, t); });
    this._renderCaption(t);
    this._renderKeys(t);
    this._renderOutro(t);
    return t;
  };

  /**
   * Resolve once fonts and every image have loaded, then render frame 0.
   * Rejects with the failing image path so the renderer can stop early.
   */
  Player.prototype.ready = function () {
    var doc = this.doc;
    var self = this;
    var waits = Array.prototype.slice.call(doc.images).map(function (img) {
      var fail = new Error('Image failed to load: ' + img.getAttribute('src'));
      if (img.complete) return img.naturalWidth ? Promise.resolve() : Promise.reject(fail);
      return new Promise(function (resolve, reject) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', function () { reject(fail); }, { once: true });
      });
    });
    return Promise.all(waits.concat([doc.fonts ? doc.fonts.ready : Promise.resolve()])).then(function () {
      self.steps.forEach(function (st) {
        if (st.size) return;
        var img = st.scene.querySelector('img');
        st.size = [img.naturalWidth, img.naturalHeight];
        st.scene.style.width = st.size[0] + 'px';
        st.scene.style.height = st.size[1] + 'px';
      });
      self.seek(0);
      return { total: self.timeline.total, fps: Number(self.sb.fps || 30) };
    });
  };

  /** Real-time playback for the preview page. Space pauses, arrows seek two seconds, Home restarts. */
  Player.prototype.play = function (win) {
    var self = this;
    var total = self.timeline.total;
    var t = 0;
    var playing = true;
    var last = null;
    var bar = self.doc.getElementById('ev-progress');
    function frame(now) {
      if (last != null && playing) t += (now - last) / 1000;
      last = now;
      if (t > total + 1) t = 0;
      self.seek(t);
      if (bar) bar.style.width = (100 * Math.min(t, total) / total) + '%';
      win.requestAnimationFrame(frame);
    }
    win.addEventListener('keydown', function (e) {
      if (e.key === ' ') { playing = !playing; e.preventDefault(); }
      if (e.key === 'ArrowRight') t = Math.min(t + 2, total);
      if (e.key === 'ArrowLeft') t = Math.max(t - 2, 0);
      if (e.key === 'Home') t = 0;
    });
    win.requestAnimationFrame(frame);
  };

  var api = {
    CROSSFADE: CROSSFADE,
    VIEW: VIEW,
    buildTimeline: buildTimeline,
    segmentOpacity: segmentOpacity,
    sampleTrack: sampleTrack,
    captionPlacement: captionPlacement,
    fitCamera: fitCamera,
    clampCamera: clampCamera,
    Player: Player
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExplainerVideo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
