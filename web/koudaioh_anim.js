/*
 * Koudai-oh 8bit アニメーション コア
 *
 * DOM に依存しない。96x128 の RGBA バッファにフレームを描くだけなので、
 * ブラウザ (web/index.html) でも Node (tools/render_frames.js) でも同じ絵が出る。
 *
 * 状態 (持続):  idle / can_dead / auto / no_link
 * アクション (単発、終わると元の状態に戻る): fire / enter / exit
 *
 *   const anim = new KoudaiohAnim.Animator(KOUDAIOH_SPRITE, { seed: 1 });
 *   anim.setState('auto');
 *   anim.fire();
 *   const raster = anim.step();   // 1 フレーム描いて時間を 1 コマ進める (5fps なら 200ms ごとに呼ぶ)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KoudaiohAnim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATES = ['idle', 'can_dead', 'auto', 'no_link'];
  var ACTIONS = ['fire', 'enter', 'exit'];

  // ------------------------------------------------------------------------
  // 色
  // ------------------------------------------------------------------------
  var C = {
    bg: [0, 0, 0],
    white: [255, 255, 255],
    yellow: [255, 226, 60],
    orange: [255, 136, 24],
    darkOrange: [176, 72, 16],
    blue: [80, 200, 255],
    green: [60, 255, 130],
    greenDim: [24, 110, 64],
    markBlue: [40, 170, 255],
    markGreen: [60, 255, 130],
    red: [255, 48, 56],
    iconGray: [210, 216, 228],
    smoke: [150, 156, 168],
    smokeDim: [86, 92, 104],
    ghost: [26, 36, 70],
    fireBg: [52, 22, 6]
  };

  // 目の色ランプ。F=芯 E=赤 d=暗赤。目の外 (装甲) には光を漏らさない
  var EYE_RAMPS = {
    red:    { F: [255, 52, 60],   E: [206, 18, 42],  d: [112, 10, 28] },
    yellow: { F: [255, 244, 96],  E: [236, 180, 8],  d: [122, 84, 0] },
    purple: { F: [238, 124, 255], E: [160, 40, 222], d: [82, 14, 118] },
    off:    { F: [14, 18, 28],    E: [14, 18, 28],   d: [24, 30, 42] }   // 消灯: バイザーの黒
  };

  // ------------------------------------------------------------------------
  // ピクセルフォント / アイコン
  // ------------------------------------------------------------------------
  var FONT3x5 = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'],
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    O: ['###', '#.#', '#.#', '#.#', '###']
  };
  var ICON_QUESTION = [
    '.###.',
    '#...#',
    '....#',
    '..##.',
    '..#..',
    '.....',
    '..#..'
  ];
  // '#' アンテナ, 'x' バツ印
  var ICON_NO_ANTENNA = [
    '#.....#......',
    '.#...#.......',
    '..#.#........',
    '...#.........',
    '...#...x...x.',
    '...#....x.x..',
    '...#.....x...',
    '...#....x.x..',
    '..###..x...x.'
  ];

  // ------------------------------------------------------------------------
  // 乱数 (シード固定できるように)
  // ------------------------------------------------------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  // gain > 1 で白へ寄せる (パッと光る)、gain < 1 で暗くする
  function gainColor(c, g) {
    if (g >= 1) return lerp(c, C.white, Math.min(1, g - 1));
    return [c[0] * g, c[1] * g, c[2] * g];
  }

  // ------------------------------------------------------------------------
  // Raster: 論理解像度の RGBA バッファと描画プリミティブ
  // ------------------------------------------------------------------------
  function Raster(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  Raster.prototype.fill = function (c) {
    var d = this.data;
    for (var i = 0; i < d.length; i += 4) {
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  };
  Raster.prototype.px = function (x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    var i = (y * this.w + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = 255;
  };
  Raster.prototype.line = function (x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    var dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  Raster.prototype.circle = function (cx, cy, r, c) {       // 輪郭のみ (midpoint)
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    var x = r, y = 0, err = 1 - r;
    while (x >= y) {
      this.px(cx + x, cy + y, c); this.px(cx - x, cy + y, c);
      this.px(cx + x, cy - y, c); this.px(cx - x, cy - y, c);
      this.px(cx + y, cy + x, c); this.px(cx - y, cy + x, c);
      this.px(cx + y, cy - x, c); this.px(cx - y, cy - x, c);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  };
  Raster.prototype.disc = function (cx, cy, r, c) {
    for (var y = -r; y <= r; y++)
      for (var x = -r; x <= r; x++)
        if (x * x + y * y <= r * r + r * 0.8) this.px(cx + x, cy + y, c);
  };
  Raster.prototype.rect = function (x0, y0, x1, y1, c) {      // 枠のみ
    this.line(x0, y0, x1, y0, c); this.line(x0, y1, x1, y1, c);
    this.line(x0, y0, x0, y1, c); this.line(x1, y0, x1, y1, c);
  };
  Raster.prototype.fillRect = function (x0, y0, x1, y1, c) {
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) this.px(x, y, c);
  };
  Raster.prototype.bitmap = function (rows, x, y, colors) {
    for (var j = 0; j < rows.length; j++)
      for (var i = 0; i < rows[j].length; i++) {
        var c = colors[rows[j][i]];
        if (c) this.px(x + i, y + j, c);
      }
  };
  Raster.prototype.text = function (str, x, y, c) {
    for (var k = 0; k < str.length; k++) {
      var g = FONT3x5[str[k]];
      if (g) this.bitmap(g, x + k * 4, y, { '#': c });
    }
  };
  Raster.prototype.darken = function (kr, kg, kb) {
    var d = this.data;
    for (var i = 0; i < d.length; i += 4) { d[i] *= kr; d[i + 1] *= kg; d[i + 2] *= kb; }
  };

  // ------------------------------------------------------------------------
  // スプライトの前処理
  // ------------------------------------------------------------------------
  function prepareSprite(sprite) {
    var pal = {};
    Object.keys(sprite.palette).forEach(function (k) { pal[k] = hexToRgb(sprite.palette[k]); });
    function cells(rows) {
      var out = [];
      for (var y = 0; y < rows.length; y++)
        for (var x = 0; x < rows[y].length; x++)
          if (rows[y][x] !== '.') out.push({ x: x, y: y, c: rows[y][x] });
      return out;
    }
    var body = cells(sprite.body);
    var stand = cells(sprite.stand);
    body.concat(stand).forEach(function (p) {
      if (!pal[p.c] && 'FEdm'.indexOf(p.c) < 0)
        throw new Error('sprite: unknown char "' + p.c + '" at ' + p.x + ',' + p.y);
    });
    // スパークの発生位置候補: 輪郭 (足元は除く)
    var edges = body.filter(function (p) {
      return p.c === 'o' && p.y < sprite.anchors.feet[0][1] - 6;
    });
    return { w: sprite.w, h: sprite.h, pal: pal, body: body, stand: stand, edges: edges, a: sprite.anchors };
  }

  // ------------------------------------------------------------------------
  // ポーズ: 1 フレームの見た目の記述
  // ------------------------------------------------------------------------
  function basePose() {
    return {
      dx: 0, dy: 0, hidden: false,
      eye: { ramp: 'red', gain: 1, scan: null, noise: null },
      mark: null,          // null なら通常色
      glitch: null,        // { y0, y1, dx } 本体の一部の行を横にずらす
      trail: null,         // { dx, dy } 残像
      bg: C.bg,
      back: [],            // 本体より奥に描くエフェクト
      front: [],           // 本体より手前
      dim: false,          // 画面全体を暗くする
      hud: []              // 減光の後に描く (暗くならない)
    };
  }

  // 目のスキャン位置 (AUTO): 左目→右目→左目と往復
  var SCAN_X = [36, 39, 42, 48, 51, 54, 51, 48, 42, 39];

  var STATE_FN = {
    // ① 平時: 5 コマ (1 秒) で 1 周。1px 上下＋目を少し暗くしてからパッと明るく
    idle: function (t) {
      var p = basePose();
      var k = t % 5;
      p.dy = [0, 0, -1, -1, 0][k];
      p.eye.gain = [1, 1, 1, 0.45, 1.6][k];
      return p;
    },

    // ② CAN 通信死: ランダム振動 / 目の高速点滅と変色 / 目にノイズ線 / スパーク
    can_dead: function (t, ctx) {
      var p = basePose();
      var rnd = ctx.rng;
      if (ctx.opts.canDeadStyle === 'slump' && t > 0) {
        p.dy = 1;                                     // ガクッと下がって静止
      } else {
        do {
          p.dx = Math.floor(rnd() * 3) - 1;
          p.dy = Math.floor(rnd() * 3) - 1;
        } while (p.dx === 0 && p.dy === 0);
      }
      p.eye.ramp = ['red', 'yellow', 'purple'][Math.floor(rnd() * 3)];
      p.eye.gain = t % 2 === 0 ? 1.4 : 0.15;
      if (rnd() < 0.7) p.eye.noise = ctx.a.eyeL[1] + Math.floor(rnd() * (ctx.a.eyeL[3] - ctx.a.eyeL[1] + 1));
      if (rnd() < 0.35) {
        var y0 = 30 + Math.floor(rnd() * 70);
        p.glitch = { y0: y0, y1: y0 + 1 + Math.floor(rnd() * 3), dx: rnd() < 0.5 ? -2 : 2 };
      }
      var n = 2 + Math.floor(rnd() * 3);
      var sparks = [];
      for (var i = 0; i < n; i++) sparks.push(makeSpark(ctx, rnd));
      p.front.push(function (R, pose) {
        sparks.forEach(function (s) { drawSpark(R, s, pose); });
      });
      return p;
    },

    // ③ 自動運転: 2 コマ周期の軽快な上下 / 目のスキャン / 額マーク点滅 / AUTO 表示とレーダー
    auto: function (t, ctx) {
      var p = basePose();
      var k = t % 10;
      p.dy = t % 2 === 0 ? 0 : -1;
      p.eye.scan = SCAN_X[k];
      p.eye.gain = 0.7;
      p.mark = t % 2 === 0 ? C.markBlue : C.markGreen;
      var r = 10 + (t % 5) * 8;
      p.back.push(function (R, pose) {
        var cx = ctx.a.head[0] + pose.dx, cy = ctx.a.head[1] + pose.dy;
        if (r - 8 >= 10) R.circle(cx, cy, r - 8, C.greenDim);
        R.circle(cx, cy, r, C.green);
      });
      p.hud.push(function (R) {
        var x = 36, y = 5;
        R.fillRect(x, y, x + 18, y + 8, [0, 24, 12]);
        R.rect(x, y, x + 18, y + 8, t % 2 === 0 ? C.green : C.greenDim);
        R.text('AUTO', x + 3, y + 2, C.green);
      });
      return p;
    },

    // ⑤ 通信切断: 10 コマに 1 回だけゆっくり動く / 目消灯 / ? とアンテナ×が浮遊 / 全体を減光
    no_link: function (t) {
      var p = basePose();
      var k = t % 10;
      p.dy = k < 6 ? 1 : 0;
      p.eye.ramp = 'off';
      p.dim = true;
      var bob = [0, 0, -1, -1, -1, 0, 0, 1, 1, 1][k];
      p.hud.push(function (R) {
        R.bitmap(ICON_NO_ANTENNA, 30, 8, { '#': C.iconGray, 'x': k % 2 === 0 ? C.red : [120, 20, 28] });
        R.bitmap(ICON_QUESTION, 56, 7 + bob, { '#': C.yellow });
      });
      return p;
    }
  };

  // ---- アクション ----------------------------------------------------------
  // 椅子に飛び乗る放物線 (床は画面の下の外にある想定)
  // s=0.2..1.0 の位置。x は進行方向の符号を掛けて使う
  var JUMP = [[51, 54], [38, 19], [26, -2], [13, -8]];

  var ACTION_LEN = { fire: 5, enter: 9, exit: 7 };

  var ACTION_FN = {
    // ④ 発射: 溜め → 発射 (跳ね上がり＋マズルフラッシュ) → 余韻 2 コマ → 復帰
    fire: function (p, t, ctx) {
      var ch = ctx.a.chest;
      p.dx = 0; p.dy = 0;
      if (p.eye.ramp === 'off') p.eye.ramp = 'red';
      p.eye.scan = null; p.eye.noise = null; p.glitch = null;
      if (t === 0) {
        p.dy = 1;
        p.eye.gain = 1.9;                         // 目が強く発光 (目の中だけ。外には漏らさない)
        p.front.push(function (R, pose) {
          sparkle(R, ch[0] + pose.dx, ch[1] + pose.dy, 2, C.white, C.yellow);
        });
      } else if (t === 1) {
        p.dy = -2;
        p.eye.gain = 1.3;
        p.bg = C.fireBg;
        p.front.push(function (R, pose) { muzzleFlash(R, ch[0] + pose.dx, ch[1] + pose.dy); });
      } else if (t === 2) {
        p.dy = -1; p.dx = 1;
        p.front.push(function (R, pose) {
          var x = ch[0] + pose.dx, y = ch[1] + pose.dy;
          R.circle(x, y, 13, C.orange);
          R.circle(x, y, 12, C.yellow);
          R.disc(x, y, 3, C.orange);
          R.disc(x, y, 1, C.yellow);
          smoke(R, x, y, 10, C.smoke, ctx.rng);
        });
      } else if (t === 3) {
        p.dx = -1;
        p.front.push(function (R, pose) {
          var x = ch[0] + pose.dx, y = ch[1] + pose.dy;
          R.circle(x, y, 21, C.darkOrange);
          smoke(R, x, y, 15, C.smokeDim, ctx.rng);
        });
      }
      return p;
    },

    // 画面外 (下の床) から椅子に飛び乗る
    enter: function (p, t, ctx, act) {
      p.glitch = null;
      if (t < 4) {
        p.dx = JUMP[t][0] * act.dir;
        p.dy = JUMP[t][1];
        if (t > 0) p.trail = { dx: JUMP[t - 1][0] * act.dir, dy: JUMP[t - 1][1] };
      } else if (t === 4) {                       // 着地: 2px 沈む＋土煙
        p.dx = 0; p.dy = 2;
        p.trail = { dx: JUMP[3][0] * act.dir, dy: JUMP[3][1] };
        p.front.push(function (R, pose) { dust(R, ctx, pose, 0); });
      } else if (t === 5) {
        p.dx = 0; p.dy = 1;
        p.front.push(function (R, pose) { dust(R, ctx, pose, 1); });
      } else if (t === 6) {                       // 起動: 目が一度暗く
        p.dx = 0; p.dy = 0;
        if (p.eye.ramp !== 'off') p.eye.gain = 0.3;
      } else if (t === 7) {                       // パッと点灯
        p.dx = 0; p.dy = 0;
        if (p.eye.ramp !== 'off') p.eye.gain = 1.9;
      } else {
        p.dx = 0; p.dy = 0;
      }
      return p;
    },

    // 椅子から飛び降りて画面外 (下の床) へ
    exit: function (p, t, ctx, act) {
      p.glitch = null;
      var J = [[0, 0]].concat(JUMP.slice().reverse());    // [0,0],[13,-8],[26,-2],[38,19],[51,54]
      if (t === 0) {                                      // 屈んで溜める
        p.dx = 0; p.dy = 2;
        if (p.eye.ramp !== 'off') p.eye.gain = 1.6;
      } else if (t <= 4) {
        p.dx = J[t][0] * act.dir;
        p.dy = J[t][1];
        p.trail = { dx: J[t - 1][0] * act.dir, dy: t === 1 ? 2 : J[t - 1][1] };
        if (t === 1) p.front.push(function (R, pose) { dust(R, ctx, { dx: 0, dy: 0 }, 0); });
        if (t === 2) p.front.push(function (R, pose) { dust(R, ctx, { dx: 0, dy: 0 }, 1); });
      } else {
        p.hidden = true;                                  // 画面外
        p.trail = t === 5 ? { dx: J[4][0] * act.dir, dy: J[4][1] } : null;
      }
      return p;
    }
  };

  // ------------------------------------------------------------------------
  // エフェクト
  // ------------------------------------------------------------------------
  function makeSpark(ctx, rnd) {
    var e = ctx.edges[Math.floor(rnd() * ctx.edges.length)];
    var vx = e.x - ctx.a.chest[0], vy = e.y - (ctx.a.chest[1] - 15);
    var len = Math.sqrt(vx * vx + vy * vy) || 1;
    vx /= len; vy /= len;
    return {
      x: e.x, y: e.y, vx: vx, vy: vy,
      color: rnd() < 0.5 ? C.yellow : C.blue,
      jag: rnd() < 0.5 ? 1 : -1,
      len: 3 + Math.floor(rnd() * 3)
    };
  }
  function drawSpark(R, s, pose) {
    // 外向きのジグザグ稲妻
    var px = -s.vy, py = s.vx;
    var x0 = s.x + pose.dx, y0 = s.y + pose.dy;
    var pts = [[x0, y0]];
    for (var i = 1; i <= 3; i++) {
      var j = (i % 2 === 1 ? 1.5 : -1.5) * s.jag;
      pts.push([x0 + s.vx * s.len * i + px * j, y0 + s.vy * s.len * i + py * j]);
    }
    for (var k = 0; k < pts.length - 1; k++) R.line(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], s.color);
    R.px(x0, y0, C.white);
    var end = pts[pts.length - 1];
    R.px(end[0] + s.vx * 2, end[1] + s.vy * 2, s.color);
  }
  function sparkle(R, x, y, len, core, arm) {
    R.px(x, y, core);
    for (var i = 1; i <= len; i++) {
      R.px(x + i, y, arm); R.px(x - i, y, arm); R.px(x, y + i, arm); R.px(x, y - i, arm);
    }
  }
  function muzzleFlash(R, x, y) {
    // ドカン: 8 方向のスパイク＋白い芯
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    dirs.forEach(function (d, i) {
      var L = i < 4 ? 24 : 15;
      R.line(x, y, x + d[0] * L, y + d[1] * L, C.orange);
      R.line(x + 1, y, x + d[0] * L + 1, y + d[1] * L, C.orange);
      R.line(x, y, x + d[0] * (L - 7), y + d[1] * (L - 7), C.yellow);
    });
    R.disc(x, y, 10, C.orange);
    R.disc(x, y, 8, C.yellow);
    R.disc(x, y, 5, C.white);
  }
  function smoke(R, x, y, r, c, rnd) {
    for (var i = 0; i < 6; i++) {
      var a = (i / 6) * Math.PI * 2 + rnd() * 0.5;
      R.disc(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8, 1 + Math.floor(rnd() * 2), c);
    }
  }
  function dust(R, ctx, pose, phase) {
    ctx.a.feet.forEach(function (f, i) {
      var s = i === 0 ? -1 : 1;
      var x = f[0] + pose.dx, y = f[1] + pose.dy - 1;
      if (phase === 0) {
        R.disc(x + s * 5, y, 1, C.smoke);
        R.disc(x + s * 9, y - 1, 1, C.smoke);
      } else {
        R.disc(x + s * 8, y - 1, 2, C.smokeDim);
        R.disc(x + s * 13, y - 3, 1, C.smokeDim);
      }
    });
  }

  // ------------------------------------------------------------------------
  // Animator
  // ------------------------------------------------------------------------
  function Animator(sprite, opts) {
    opts = opts || {};
    this.spr = prepareSprite(sprite);
    this.raster = new Raster(sprite.w, sprite.h);
    this.opts = { canDeadStyle: opts.canDeadStyle === 'slump' ? 'slump' : 'shake' };
    this.rng = mulberry32(opts.seed != null ? opts.seed : (Date.now() & 0xffffffff));
    this.base = STATES.indexOf(opts.state) >= 0 ? opts.state : 'idle';
    this.present = opts.present !== false;
    this.t = 0;
    this.action = null;
    this.frame = 0;
    this.listeners = [];
  }

  Animator.STATES = STATES;
  Animator.ACTIONS = ACTIONS;
  Animator.ACTION_LEN = ACTION_LEN;

  Animator.prototype.on = function (fn) { this.listeners.push(fn); };
  Animator.prototype._emit = function (ev) {
    this.listeners.forEach(function (fn) { fn(ev); });
  };

  /** 持続状態を切り替える。アクション再生中なら、終わった後にこの状態へ戻る */
  Animator.prototype.setState = function (name) {
    if (STATES.indexOf(name) < 0) throw new Error('unknown state: ' + name);
    if (name === this.base) return false;
    this.base = name;
    this.t = 0;
    this._emit({ type: 'state', state: name });
    return true;
  };

  Animator.prototype._startAction = function (type, dir) {
    this.action = { type: type, t: 0, dir: dir };
    this._emit({ type: 'action_start', action: type });
    return true;
  };
  /** 発射。椅子に乗っていて、他のアクション中でなければ再生する */
  Animator.prototype.fire = function () {
    if (!this.present || this.action) return false;
    return this._startAction('fire', 1);
  };
  /** 画面外から椅子に乗る。from: 'right' | 'left' (どちら側の床から跳んでくるか) */
  Animator.prototype.enter = function (from) {
    if (this.present || this.action) return false;
    return this._startAction('enter', from === 'left' ? -1 : 1);
  };
  /** 椅子から画面外へ。to: 'left' | 'right' */
  Animator.prototype.exit = function (to) {
    if (!this.present || this.action) return false;
    return this._startAction('exit', to === 'right' ? 1 : -1);
  };

  /** 文字列コマンド (WebSocket やキー入力から使う) */
  Animator.prototype.command = function (cmd, arg) {
    if (STATES.indexOf(cmd) >= 0) return this.setState(cmd);
    if (cmd === 'fire') return this.fire();
    if (cmd === 'enter') return this.enter(arg);
    if (cmd === 'exit') return this.exit(arg);
    throw new Error('unknown command: ' + cmd);
  };

  Animator.prototype.snapshot = function () {
    return {
      state: this.base,
      present: this.present,
      action: this.action ? this.action.type : null,
      frame: this.frame
    };
  };

  Animator.prototype._ctx = function () {
    return { rng: this.rng, a: this.spr.a, edges: this.spr.edges, opts: this.opts };
  };

  Animator.prototype.pose = function () {
    var ctx = this._ctx();
    if (!this.present && !this.action) {
      var away = basePose();
      away.hidden = true;
      return away;
    }
    var p = STATE_FN[this.base](this.t, ctx);
    if (this.action) p = ACTION_FN[this.action.type](p, this.action.t, ctx, this.action);
    return p;
  };

  /** 現在のフレームを描いて、時間を 1 コマ進める */
  Animator.prototype.step = function () {
    this.render(this.pose());
    this.frame++;
    this.t++;
    if (this.action) {
      this.action.t++;
      if (this.action.t >= ACTION_LEN[this.action.type]) {
        var type = this.action.type;
        if (type === 'enter') this.present = true;
        if (type === 'exit') this.present = false;
        this.action = null;
        if (type !== 'fire') this.t = 0;
        this._emit({ type: 'action_end', action: type });
      }
    }
    return this.raster;
  };

  Animator.prototype.render = function (p) {
    var R = this.raster, S = this.spr, i;
    R.fill(p.bg);
    for (i = 0; i < p.back.length; i++) p.back[i](R, p);

    // 椅子
    for (i = 0; i < S.stand.length; i++) {
      var s = S.stand[i];
      R.px(s.x, s.y, S.pal[s.c]);
    }

    // 残像
    if (p.trail) {
      for (i = 0; i < S.body.length; i++) {
        var b = S.body[i];
        if (b.c !== 'o') R.px(b.x + p.trail.dx, b.y + p.trail.dy, C.ghost);
      }
    }

    // 本体
    if (!p.hidden) this._drawBody(R, p);

    for (i = 0; i < p.front.length; i++) p.front[i](R, p);
    if (p.dim) R.darken(0.42, 0.45, 0.58);
    for (i = 0; i < p.hud.length; i++) p.hud[i](R, p);
    return R;
  };

  Animator.prototype._drawBody = function (R, p) {
    var S = this.spr;
    var ramp = EYE_RAMPS[p.eye.ramp] || EYE_RAMPS.red;
    var eyeOn = p.eye.ramp !== 'off';
    var scan = p.eye.scan;

    for (var i = 0; i < S.body.length; i++) {
      var b = S.body[i];
      var col;
      if (b.c === 'F' || b.c === 'E' || b.c === 'd') {
        col = ramp[b.c];
        if (eyeOn) {
          if (scan != null) {
            var dxs = b.x - scan;
            if (dxs === 0 || dxs === 1) col = C.white;
            else if (dxs === -1 || dxs === 2) col = lerp(ramp.F, C.white, 0.6);
            else col = gainColor(col, p.eye.gain);
          } else {
            col = gainColor(col, p.eye.gain);
          }
        }
        if (p.eye.noise === b.y) col = C.bg;
      } else if (b.c === 'm') {
        col = p.mark || S.pal['1'];
      } else {
        col = S.pal[b.c];
      }
      var x = b.x + p.dx;
      if (p.glitch && b.y >= p.glitch.y0 && b.y <= p.glitch.y1) x += p.glitch.dx;
      R.px(x, b.y + p.dy, col);
    }
  };

  return {
    Animator: Animator,
    Raster: Raster,
    STATES: STATES,
    ACTIONS: ACTIONS,
    ACTION_LEN: ACTION_LEN
  };
});
