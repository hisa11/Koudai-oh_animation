/*
 * Koudai-oh 8bit アニメーション コア
 *
 * DOM に依存しない。スプライトの解像度 (192x256) の RGBA バッファにフレームを描くだけなので、
 * ブラウザ (web/index.html) でも Node (tools/render_frames.js) でも同じ絵が出る。
 *
 * 状態 (持続):  idle / can_dead / auto / no_link
 * アクション (単発、終わると元の状態に戻る): fire / enter / exit
 *
 *   const anim = new KoudaiohAnim.Animator(KOUDAIOH_SPRITE, { seed: 1 });
 *   anim.setState('auto');
 *   anim.fire();
 *   const raster = anim.step();   // 1 フレーム描いて時間を 1 コマ進める (5fps なら 200ms ごとに呼ぶ)
 *
 * 動きとエフェクトの寸法は unit (= sprite.anchors.unit px) 単位で書いてある。
 * 「1 ピクセル上げる」は 1 unit 動かすこと。
 */
(function (root, factory) {
  // ブラウザでは常にグローバル (window.KoudaiohAnim) に登録する。
  // Electron などで module が定義されていても、ブラウザ側から見えなくならないように
  var lib = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = lib;
  if (root) root.KoudaiohAnim = lib;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null, function () {
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
    greenBg: [0, 24, 12],
    markBlue: [40, 170, 255],
    markGreen: [60, 255, 130],
    red: [255, 48, 56],
    redDim: [120, 20, 28],
    iconGray: [210, 216, 228],
    smoke: [150, 156, 168],
    smokeDim: [86, 92, 104],
    ghost: [26, 36, 70],
    fireBg: [52, 22, 6]
  };

  // 目の色ランプ。F=芯 E=明赤 D=赤 d=暗赤。赤は元絵の目の色。目の外 (装甲) には光を漏らさない
  var EYE_RAMPS = {
    red:    { F: [242, 24, 34],   E: [180, 18, 30],  D: [130, 20, 36], d: [94, 26, 44] },
    yellow: { F: [255, 244, 110], E: [246, 196, 20], D: [176, 118, 0], d: [104, 66, 0] },
    purple: { F: [238, 130, 255], E: [186, 60, 240], D: [120, 24, 170], d: [66, 12, 92] },
    off:    { F: [14, 18, 28],    E: [14, 18, 28],   D: [14, 18, 28],  d: [26, 32, 44] }   // 消灯: バイザーの黒
  };
  var EYE_CODES = 'FEDd';

  // ------------------------------------------------------------------------
  // ピクセルフォント / アイコン (unit 倍で描く)
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
  // Raster: RGBA バッファと描画プリミティブ。s は点の大きさ (s x s のブロック)
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
  Raster.prototype.dot = function (x, y, c, s) {
    s = s || 1;
    x = Math.round(x) - ((s - 1) >> 1); y = Math.round(y) - ((s - 1) >> 1);
    for (var j = 0; j < s; j++) for (var i = 0; i < s; i++) this.px(x + i, y + j, c);
  };
  Raster.prototype.line = function (x0, y0, x1, y1, c, s) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    var dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    for (;;) {
      this.dot(x0, y0, c, s);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  Raster.prototype.circle = function (cx, cy, r, c, s) {    // 輪郭のみ (midpoint)
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    var x = r, y = 0, err = 1 - r;
    while (x >= y) {
      this.dot(cx + x, cy + y, c, s); this.dot(cx - x, cy + y, c, s);
      this.dot(cx + x, cy - y, c, s); this.dot(cx - x, cy - y, c, s);
      this.dot(cx + y, cy + x, c, s); this.dot(cx - y, cy + x, c, s);
      this.dot(cx + y, cy - x, c, s); this.dot(cx - y, cy - x, c, s);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  };
  Raster.prototype.disc = function (cx, cy, r, c) {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    for (var y = -r; y <= r; y++)
      for (var x = -r; x <= r; x++)
        if (x * x + y * y <= r * r + r * 0.8) this.px(cx + x, cy + y, c);
  };
  Raster.prototype.fillRect = function (x0, y0, x1, y1, c) {
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) this.px(x, y, c);
  };
  Raster.prototype.frame = function (x0, y0, x1, y1, c, s) {  // 枠 (太さ s)
    this.fillRect(x0, y0, x1, y0 + s - 1, c); this.fillRect(x0, y1 - s + 1, x1, y1, c);
    this.fillRect(x0, y0, x0 + s - 1, y1, c); this.fillRect(x1 - s + 1, y0, x1, y1, c);
  };
  Raster.prototype.bitmap = function (rows, x, y, colors, s) {
    s = s || 1;
    for (var j = 0; j < rows.length; j++)
      for (var i = 0; i < rows[j].length; i++) {
        var c = colors[rows[j][i]];
        if (c) this.fillRect(x + i * s, y + j * s, x + i * s + s - 1, y + j * s + s - 1, c);
      }
  };
  Raster.prototype.text = function (str, x, y, c, s) {
    s = s || 1;
    for (var k = 0; k < str.length; k++) {
      var g = FONT3x5[str[k]];
      if (g) this.bitmap(g, x + k * 4 * s, y, { '#': c }, s);
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
      if (!pal[p.c] && (EYE_CODES + 'm').indexOf(p.c) < 0)
        throw new Error('sprite: unknown char "' + p.c + '" at ' + p.x + ',' + p.y);
    });
    var a = sprite.anchors;
    var U = a.unit || 1;
    // スパークの発生位置候補: 輪郭 (足元は除く)
    var edges = body.filter(function (p) { return p.c === 'o' && p.y < a.feet[0][1] - 6 * U; });
    // 目のスキャン位置: 左目→右目→左目と往復 (各目 3 点)
    function three(b) { return [b[0], Math.round((b[0] + b[2]) / 2) - (U >> 1), b[2] - U + 1]; }
    var L = three(a.eyeL), Rr = three(a.eyeR);
    var scan = L.concat(Rr, [Rr[1], Rr[0], L[2], L[1]]);
    return { w: sprite.w, h: sprite.h, pal: pal, body: body, stand: stand, edges: edges, a: a, U: U, scan: scan };
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

  var STATE_FN = {
    // ① 平時: 5 コマ (1 秒) で 1 周。1 unit 上下＋目を少し暗くしてからパッと明るく
    idle: function (t, ctx) {
      var p = basePose();
      var k = t % 5;
      p.dy = [0, 0, -1, -1, 0][k] * ctx.U;
      p.eye.gain = [1, 1, 1, 0.45, 1.6][k];
      return p;
    },

    // ② CAN 通信死: ランダム振動 / 目の高速点滅と変色 / 目にノイズ線 / スパーク
    can_dead: function (t, ctx) {
      var p = basePose();
      var rnd = ctx.rng, U = ctx.U, a = ctx.a;
      if (ctx.opts.canDeadStyle === 'slump' && t > 0) {
        p.dy = U;                                     // ガクッと下がって静止
      } else {
        do {
          p.dx = (Math.floor(rnd() * 3) - 1) * U;
          p.dy = (Math.floor(rnd() * 3) - 1) * U;
        } while (p.dx === 0 && p.dy === 0);
      }
      p.eye.ramp = ['red', 'yellow', 'purple'][Math.floor(rnd() * 3)];
      p.eye.gain = t % 2 === 0 ? 1.4 : 0.15;
      if (rnd() < 0.7) p.eye.noise = a.eyeL[1] + Math.floor(rnd() * (a.eyeL[3] - a.eyeL[1]));
      if (rnd() < 0.35) {
        var y0 = (30 + Math.floor(rnd() * 70)) * U;
        p.glitch = { y0: y0, y1: y0 + (1 + Math.floor(rnd() * 3)) * U, dx: (rnd() < 0.5 ? -2 : 2) * U };
      }
      var n = 2 + Math.floor(rnd() * 3);
      var sparks = [];
      for (var i = 0; i < n; i++) sparks.push(makeSpark(ctx, rnd));
      p.front.push(function (R, pose) {
        sparks.forEach(function (s) { drawSpark(R, s, pose, U); });
      });
      return p;
    },

    // ③ 自動運転: 2 コマ周期の軽快な上下 / 目のスキャン / 額マーク点滅 / AUTO 表示とレーダー
    auto: function (t, ctx) {
      var p = basePose();
      var U = ctx.U, a = ctx.a;
      p.dy = t % 2 === 0 ? 0 : -U;
      p.eye.scan = ctx.scan[t % ctx.scan.length];
      p.eye.gain = 0.7;
      p.mark = t % 2 === 0 ? C.markBlue : C.markGreen;
      var r = (10 + (t % 5) * 8) * U;
      p.back.push(function (R, pose) {
        var cx = a.head[0] + pose.dx, cy = a.head[1] + pose.dy;
        if (r - 8 * U >= 10 * U) R.circle(cx, cy, r - 8 * U, C.greenDim, U);
        R.circle(cx, cy, r, C.green, U);
      });
      p.hud.push(function (R) {
        var w = 19 * U, h = 9 * U;
        var x = a.head[0] - (w >> 1), y = 5 * U;
        R.fillRect(x, y, x + w - 1, y + h - 1, C.greenBg);
        R.frame(x, y, x + w - 1, y + h - 1, t % 2 === 0 ? C.green : C.greenDim, U);
        R.text('AUTO', x + 3 * U, y + 2 * U, C.green, U);
      });
      return p;
    },

    // ⑤ 通信切断: 10 コマに 1 回だけゆっくり動く / 目消灯 / ? とアンテナ×が浮遊 / 全体を減光
    no_link: function (t, ctx) {
      var p = basePose();
      var U = ctx.U, cx = ctx.a.head[0];
      var k = t % 10;
      p.dy = k < 6 ? U : 0;
      p.eye.ramp = 'off';
      p.dim = true;
      var bob = [0, 0, -1, -1, -1, 0, 0, 1, 1, 1][k] * U;
      p.hud.push(function (R) {
        R.bitmap(ICON_NO_ANTENNA, cx - 17 * U, 8 * U, { '#': C.iconGray, 'x': k % 2 === 0 ? C.red : C.redDim }, U);
        R.bitmap(ICON_QUESTION, cx + 9 * U, 7 * U + bob, { '#': C.yellow }, U);
      });
      return p;
    }
  };

  // ---- アクション ----------------------------------------------------------
  // 椅子に飛び乗る放物線 (床は画面の下の外にある想定)。単位は unit
  // s=0.2..0.8 の位置。x は進行方向の符号を掛けて使う
  var JUMP = [[51, 54], [38, 19], [26, -2], [13, -8]];

  var ACTION_LEN = { fire: 5, enter: 9, exit: 7 };

  var ACTION_FN = {
    // ④ 発射: 溜め → 発射 (跳ね上がり＋マズルフラッシュ) → 余韻 2 コマ → 復帰
    fire: function (p, t, ctx) {
      var ch = ctx.a.chest, U = ctx.U;
      p.dx = 0; p.dy = 0;
      if (p.eye.ramp === 'off') p.eye.ramp = 'red';
      p.eye.scan = null; p.eye.noise = null; p.glitch = null;
      if (t === 0) {
        p.dy = U;
        p.eye.gain = 1.9;                         // 目が強く発光 (目の中だけ。外には漏らさない)
        p.front.push(function (R, pose) {
          sparkle(R, ch[0] + pose.dx, ch[1] + pose.dy, 2, C.white, C.yellow, U);
        });
      } else if (t === 1) {
        p.dy = -2 * U;
        p.eye.gain = 1.3;
        p.bg = C.fireBg;
        p.front.push(function (R, pose) { muzzleFlash(R, ch[0] + pose.dx, ch[1] + pose.dy, U); });
      } else if (t === 2) {
        p.dy = -U; p.dx = U;
        p.front.push(function (R, pose) {
          var x = ch[0] + pose.dx, y = ch[1] + pose.dy;
          R.circle(x, y, 13 * U, C.orange, U);
          R.circle(x, y, 12 * U, C.yellow, U);
          R.disc(x, y, 3 * U, C.orange);
          R.disc(x, y, U, C.yellow);
          smoke(R, x, y, 10 * U, C.smoke, ctx.rng, U);
        });
      } else if (t === 3) {
        p.dx = -U;
        p.front.push(function (R, pose) {
          var x = ch[0] + pose.dx, y = ch[1] + pose.dy;
          R.circle(x, y, 21 * U, C.darkOrange, U);
          smoke(R, x, y, 15 * U, C.smokeDim, ctx.rng, U);
        });
      }
      return p;
    },

    // 画面外 (下の床) から椅子に飛び乗る
    enter: function (p, t, ctx, act) {
      var U = ctx.U;
      p.glitch = null;
      if (t < 4) {
        p.dx = JUMP[t][0] * act.dir * U;
        p.dy = JUMP[t][1] * U;
        if (t > 0) p.trail = { dx: JUMP[t - 1][0] * act.dir * U, dy: JUMP[t - 1][1] * U };
      } else if (t === 4) {                       // 着地: 2 unit 沈む＋土煙
        p.dx = 0; p.dy = 2 * U;
        p.trail = { dx: JUMP[3][0] * act.dir * U, dy: JUMP[3][1] * U };
        p.front.push(function (R, pose) { dust(R, ctx, pose, 0); });
      } else if (t === 5) {
        p.dx = 0; p.dy = U;
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
      var U = ctx.U;
      p.glitch = null;
      var J = [[0, 0]].concat(JUMP.slice().reverse());    // [0,0],[13,-8],[26,-2],[38,19],[51,54]
      if (t === 0) {                                      // 屈んで溜める
        p.dx = 0; p.dy = 2 * U;
        if (p.eye.ramp !== 'off') p.eye.gain = 1.6;
      } else if (t <= 4) {
        p.dx = J[t][0] * act.dir * U;
        p.dy = J[t][1] * U;
        p.trail = { dx: J[t - 1][0] * act.dir * U, dy: (t === 1 ? 2 : J[t - 1][1]) * U };
        if (t === 1) p.front.push(function (R) { dust(R, ctx, { dx: 0, dy: 0 }, 0); });
        if (t === 2) p.front.push(function (R) { dust(R, ctx, { dx: 0, dy: 0 }, 1); });
      } else {
        p.hidden = true;                                  // 画面外
        p.trail = t === 5 ? { dx: J[4][0] * act.dir * U, dy: J[4][1] * U } : null;
      }
      return p;
    }
  };

  // ------------------------------------------------------------------------
  // エフェクト
  // ------------------------------------------------------------------------
  function makeSpark(ctx, rnd) {
    var U = ctx.U;
    var e = ctx.edges[Math.floor(rnd() * ctx.edges.length)];
    var vx = e.x - ctx.a.chest[0], vy = e.y - (ctx.a.chest[1] - 15 * U);
    var len = Math.sqrt(vx * vx + vy * vy) || 1;
    vx /= len; vy /= len;
    return {
      x: e.x, y: e.y, vx: vx, vy: vy,
      color: rnd() < 0.5 ? C.yellow : C.blue,
      jag: rnd() < 0.5 ? 1 : -1,
      len: (3 + Math.floor(rnd() * 3)) * U
    };
  }
  function drawSpark(R, s, pose, U) {
    // 外向きのジグザグ稲妻
    var px = -s.vy, py = s.vx;
    var x0 = s.x + pose.dx, y0 = s.y + pose.dy;
    var pts = [[x0, y0]];
    for (var i = 1; i <= 3; i++) {
      var j = (i % 2 === 1 ? 1.5 : -1.5) * s.jag * U;
      pts.push([x0 + s.vx * s.len * i + px * j, y0 + s.vy * s.len * i + py * j]);
    }
    for (var k = 0; k < pts.length - 1; k++) R.line(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], s.color, U);
    R.dot(x0, y0, C.white, U);
    var end = pts[pts.length - 1];
    R.dot(end[0] + s.vx * 2 * U, end[1] + s.vy * 2 * U, s.color, U);
  }
  function sparkle(R, x, y, len, core, arm, U) {
    R.dot(x, y, core, U);
    for (var i = 1; i <= len; i++) {
      var d = i * U;
      R.dot(x + d, y, arm, U); R.dot(x - d, y, arm, U); R.dot(x, y + d, arm, U); R.dot(x, y - d, arm, U);
    }
  }
  function muzzleFlash(R, x, y, U) {
    // ドカン: 8 方向のスパイク＋白い芯
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    dirs.forEach(function (d, i) {
      var L = (i < 4 ? 24 : 15) * U;
      R.line(x, y, x + d[0] * L, y + d[1] * L, C.orange, 2 * U);
      R.line(x, y, x + d[0] * (L - 7 * U), y + d[1] * (L - 7 * U), C.yellow, U);
    });
    R.disc(x, y, 10 * U, C.orange);
    R.disc(x, y, 8 * U, C.yellow);
    R.disc(x, y, 5 * U, C.white);
  }
  function smoke(R, x, y, r, c, rnd, U) {
    for (var i = 0; i < 6; i++) {
      var a = (i / 6) * Math.PI * 2 + rnd() * 0.5;
      R.disc(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8, (1 + Math.floor(rnd() * 2)) * U, c);
    }
  }
  function dust(R, ctx, pose, phase) {
    var U = ctx.U;
    ctx.a.feet.forEach(function (f, i) {
      var s = i === 0 ? -1 : 1;
      var x = f[0] + pose.dx, y = f[1] + pose.dy - U;
      if (phase === 0) {
        R.disc(x + s * 5 * U, y, U, C.smoke);
        R.disc(x + s * 9 * U, y - U, U, C.smoke);
      } else {
        R.disc(x + s * 8 * U, y - U, 2 * U, C.smokeDim);
        R.disc(x + s * 13 * U, y - 3 * U, U, C.smokeDim);
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
    var S = this.spr;
    return { rng: this.rng, a: S.a, U: S.U, edges: S.edges, scan: S.scan, opts: this.opts };
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
    var S = this.spr, U = S.U;
    var ramp = EYE_RAMPS[p.eye.ramp] || EYE_RAMPS.red;
    var eyeOn = p.eye.ramp !== 'off';
    var scan = p.eye.scan;
    var noise = p.eye.noise;

    for (var i = 0; i < S.body.length; i++) {
      var b = S.body[i];
      var col;
      if (EYE_CODES.indexOf(b.c) >= 0) {
        col = ramp[b.c];
        if (eyeOn) {
          var dxs = scan == null ? null : b.x - scan;
          if (dxs !== null && dxs >= 0 && dxs < U) col = C.white;                       // スキャンの芯
          else if (dxs !== null && dxs >= -U && dxs < 2 * U) col = lerp(ramp.F, C.white, 0.6);
          else col = gainColor(col, p.eye.gain);
        }
        if (noise != null && b.y >= noise && b.y < noise + U) col = C.bg;              // ノイズ線
      } else if (b.c === 'm') {
        col = p.mark || S.pal.m || S.pal['1'];
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
