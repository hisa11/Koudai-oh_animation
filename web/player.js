/*
 * ブラウザ用プレーヤー: Animator を一定 fps で回し、canvas に整数倍で拡大表示する。
 *
 *   const player = new KoudaiohPlayer(canvas, animator, { fps: 5, scale: 'auto' });
 *   player.start();
 */
(function (root) {
  'use strict';

  function KoudaiohPlayer(canvas, animator, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.anim = animator;
    this.fps = opts.fps || 5;
    this.scale = opts.scale || 'auto';
    this.fit = opts.fit || null;            // 'auto' のとき収める要素 (既定は window)
    this.onFrame = opts.onFrame || null;

    var r = animator.raster;
    this.buf = document.createElement('canvas');
    this.buf.width = r.w;
    this.buf.height = r.h;
    this.bctx = this.buf.getContext('2d');
    this.img = this.bctx.createImageData(r.w, r.h);
    this.ctx = canvas.getContext('2d');

    this._raf = null;
    this._last = 0;
    this._acc = 0;
    var self = this;
    this._tick = function (ts) { self._loop(ts); };
    window.addEventListener('resize', function () { self.resize(); self.draw(); });
    this.resize();
  }

  KoudaiohPlayer.prototype.resize = function () {
    var r = this.anim.raster;
    var s = this.scale;
    if (s === 'auto') {
      var box = this.fit ? this.fit.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
      s = Math.max(1, Math.floor(Math.min(box.width / r.w, box.height / r.h)));
    }
    this.canvas.width = r.w * s;
    this.canvas.height = r.h * s;
    this.ctx.imageSmoothingEnabled = false;
  };

  KoudaiohPlayer.prototype.draw = function () {
    this.img.data.set(this.anim.raster.data);
    this.bctx.putImageData(this.img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buf, 0, 0, this.canvas.width, this.canvas.height);
  };

  /** 1 コマ進めて描く */
  KoudaiohPlayer.prototype.stepOnce = function () {
    this.anim.step();
    this.draw();
    if (this.onFrame) this.onFrame(this.anim.snapshot());
  };

  KoudaiohPlayer.prototype._loop = function (ts) {
    var dt = 1000 / this.fps;
    if (!this._last) this._last = ts;
    this._acc += ts - this._last;
    this._last = ts;
    if (this._acc > dt * 5) this._acc = dt;   // タブ復帰時などに一気に進めない
    while (this._acc >= dt) {
      this._acc -= dt;
      this.stepOnce();
    }
    this._raf = requestAnimationFrame(this._tick);
  };

  KoudaiohPlayer.prototype.start = function () {
    if (this._raf) return;
    this._last = 0;
    this._acc = 1000 / this.fps;               // 開始直後に 1 コマ描く
    this._raf = requestAnimationFrame(this._tick);
  };

  KoudaiohPlayer.prototype.stop = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  };

  root.KoudaiohPlayer = KoudaiohPlayer;
})(typeof window !== 'undefined' ? window : self);
