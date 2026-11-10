// npm test  (= node --test)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SPRITE = require('../web/sprite_data.js');
const WINGS = require('../web/sprite_wings.js');
const { Animator, ACTION_LEN } = require('../web/koudaioh_anim.js');

const W = SPRITE.w, H = SPRITE.h;
const MIRROR = SPRITE.anchors.mirror;       // x と MIRROR - x が左右対称の対
const AXIS_X = MIRROR / 2;

function frameAt(state, t, opts) {
  const a = new Animator(SPRITE, Object.assign({ seed: 1, state }, opts));
  let r;
  for (let i = 0; i <= t; i++) r = a.step();
  return Buffer.from(r.data);
}
function px(buf, x, y) {
  const i = (y * W + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2]];
}

test('スプライトの寸法', () => {
  for (const key of ['body', 'stand']) {
    assert.strictEqual(SPRITE[key].length, H, key);
    for (const row of SPRITE[key]) assert.strictEqual(row.length, W, key);
  }
});

test('本体と椅子は左右対称 (肩の KO-02 の範囲だけ例外)', () => {
  const [dx0, dy0, dx1, dy1] = SPRITE.anchors.decal;
  const inDecal = (x, y) => x >= dx0 && x <= dx1 && y >= dy0 && y <= dy1;
  for (const key of ['body', 'stand']) {
    SPRITE[key].forEach((row, y) => {
      for (let x = 0; x < W; x++) {
        if (inDecal(x, y) || inDecal(MIRROR - x, y)) continue;
        const m = MIRROR - x;
        const mirror = m >= 0 && m < W ? row[m] : '.';
        assert.strictEqual(row[x], mirror, `${key} (${x},${y})`);
      }
    });
  }
});

test('目の外 (装甲) に光が漏れない: 平時の本体画素はパレット色そのまま', () => {
  const pal = Object.fromEntries(Object.entries(SPRITE.palette).map(([k, h]) =>
    [k, [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))]));
  for (const t of [0, 4]) {                 // 通常フレームと「パッと明るく」フレーム
    const buf = frameAt('idle', t);
    const dy = [0, 0, -1, -1, 0][t] * SPRITE.anchors.unit;
    SPRITE.body.forEach((row, y) => {
      for (let x = 0; x < W; x++) {
        const c = row[x];
        if (!pal[c] || y + dy < 0) continue;
        assert.deepStrictEqual(px(buf, x, y + dy), pal[c], `t=${t} (${x},${y}) '${c}'`);
      }
    });
  }
});

test('平時は 5 コマでループする', () => {
  assert.ok(frameAt('idle', 1).equals(frameAt('idle', 6)));
  assert.ok(!frameAt('idle', 0).equals(frameAt('idle', 2)));   // 1px 上がっている
});

test('全状態がエラーなく描ける', () => {
  for (const s of Animator.STATES) for (const style of ['shake', 'slump']) {
    const a = new Animator(SPRITE, { seed: 2, state: s, canDeadStyle: style });
    for (let i = 0; i < 30; i++) a.step();
  }
});

test('発射は 5 コマで元の状態に戻る', () => {
  const a = new Animator(SPRITE, { seed: 1, state: 'auto' });
  a.step();
  assert.strictEqual(a.fire(), true);
  assert.strictEqual(a.fire(), false, '再生中の発射は無視');
  for (let i = 0; i < ACTION_LEN.fire; i++) {
    assert.strictEqual(a.snapshot().action, 'fire');
    a.step();
  }
  assert.deepStrictEqual([a.snapshot().action, a.snapshot().state], [null, 'auto']);
});

test('発射中に状態を変えると、発射後はその状態になる', () => {
  const a = new Animator(SPRITE, { seed: 1 });
  a.fire();
  a.step();
  a.setState('no_link');
  for (let i = 0; i < ACTION_LEN.fire; i++) a.step();
  assert.strictEqual(a.snapshot().state, 'no_link');
  assert.strictEqual(a.snapshot().action, null);
});

test('退場 → 不在 → 登場', () => {
  const a = new Animator(SPRITE, { seed: 1 });
  assert.strictEqual(a.enter(), false, '乗っている間は登場できない');
  assert.strictEqual(a.exit('left'), true);
  for (let i = 0; i < ACTION_LEN.exit; i++) a.step();
  assert.strictEqual(a.snapshot().present, false);
  assert.strictEqual(a.fire(), false, '不在のときは発射しない');
  assert.strictEqual(a.exit(), false);

  // 不在のフレームは椅子だけ (本体の目の位置が背景色)
  const buf = Buffer.from(a.step().data);
  const [ex, ey] = SPRITE.anchors.eyeL;
  assert.deepStrictEqual(px(buf, ex + 2, ey + 2), [0, 0, 0]);

  assert.strictEqual(a.enter('left'), true);
  for (let i = 0; i < ACTION_LEN.enter; i++) a.step();
  assert.deepStrictEqual([a.snapshot().present, a.snapshot().action], [true, null]);
});

test('登場の最初のコマは指定した側から来る', () => {
  for (const [from, sign] of [['right', 1], ['left', -1]]) {
    const a = new Animator(SPRITE, { seed: 1, present: false });
    a.enter(from);
    const p = a.pose();
    assert.ok(Math.sign(p.dx) === sign && p.dy > 0, `${from}: dx=${p.dx} dy=${p.dy}`);
  }
});

test('文字列コマンド', () => {
  const a = new Animator(SPRITE, { seed: 1 });
  assert.strictEqual(a.command('can_dead'), true);
  assert.strictEqual(a.snapshot().state, 'can_dead');
  assert.throws(() => a.command('dance'));
});

test('ブラウザで module が定義されていてもグローバルに登録される (Electron など)', () => {
  const fs = require('fs');
  const vm = require('vm');
  for (const [file, name] of [['web/koudaioh_anim.js', 'KoudaiohAnim'], ['web/sprite_data.js', 'KOUDAIOH_SPRITE'],
                              ['web/player.js', 'KoudaiohPlayer'], ['web/sprite_wings.js', 'KOUDAIOH_WINGS']]) {
    const win = {};
    const ctx = { window: win, module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
    assert.ok(win[name], `${file} -> window.${name}`);
  }
});

test('肩に KO-02 が入っている (右肩だけ)', () => {
  const [x0, y0, x1, y1] = SPRITE.anchors.decal;
  assert.ok(x0 > AXIS_X, '向かって右の肩');
  let dark = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (SPRITE.body[y][x] === '0') dark++;
  assert.ok(dark >= 40, `文字の画素 ${dark}`);
});

test('羽 5 コマ: 左右対称で、本体の外へ広がる', () => {
  assert.strictEqual(WINGS.frames.length, 5);
  for (const [k, f] of WINGS.frames.entries()) {
    const cells = new Set();
    f.rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.') cells.add(`${f.x + i},${f.y + j},${row[i]}`); });
    for (const c of cells) {
      const [x, y, ch] = c.split(',');
      assert.ok(cells.has(`${WINGS.mirror - Number(x)},${y},${ch}`), `frame ${k + 1} (${x},${y})`);
    }
    const xs = [...cells].map((c) => Number(c.split(',')[0]));
    assert.ok(Math.min(...xs) < WINGS.ox + SPRITE.anchors.bbox[0], `frame ${k + 1} は本体より外まで広がる`);
  }
});

test('羽付き版: 椅子の上に浮いて羽ばたく (平時)', () => {
  const a = new Animator(SPRITE, { seed: 1, wings: WINGS });
  assert.deepStrictEqual([a.raster.w, a.raster.h], [WINGS.w, WINGS.h]);
  const wings = new Set();
  for (let t = 0; t < 8; t++) {
    const p = a.pose();
    assert.ok(p.dy < -8 * SPRITE.anchors.unit, `t=${t} 浮いている dy=${p.dy}`);
    wings.add(p.wing);
    a.step();
  }
  assert.deepStrictEqual([...wings].sort(), [0, 1, 2, 3, 4], '5 コマすべて使う');
});

test('羽付き版: 全状態と動作がエラーなく描け、退場→登場で椅子に戻る (羽ばたき / 滑空)', () => {
  for (const [style, fly] of [['shake', 'flap'], ['slump', 'flap'], ['shake', 'glide'], ['slump', 'glide']]) {
    const a = new Animator(SPRITE, { seed: 3, wings: WINGS, canDeadStyle: style, fly });
    for (const s of Animator.STATES) { a.setState(s); for (let i = 0; i < 12; i++) a.step(); }
    a.fire(); for (let i = 0; i < ACTION_LEN.fire; i++) a.step();
    a.exit('left'); for (let i = 0; i < ACTION_LEN.exit; i++) a.step();
    assert.strictEqual(a.snapshot().present, false);
    a.enter('right'); for (let i = 0; i < ACTION_LEN.enter; i++) a.step();
    assert.deepStrictEqual([a.snapshot().present, a.snapshot().action], [true, null]);
  }
});

test('滑空: 羽は動かさず、噴射と光で飛ぶ。体はぷかぷか上下する', () => {
  const a = new Animator(SPRITE, { seed: 1, wings: WINGS, fly: 'glide' });
  const wings = new Set(), dys = new Set();
  for (let t = 0; t < 12; t++) {
    const p = a.pose();
    wings.add(p.wing); dys.add(p.dy);
    assert.ok(p.thrust >= 2, `t=${t} 噴射 ${p.thrust}`);
    assert.ok(p.pulse > 0, '羽根筋に光が流れる');
    assert.ok(p.dy < -10 * SPRITE.anchors.unit, `t=${t} 浮いている dy=${p.dy}`);
    a.step();
  }
  assert.strictEqual(wings.size, 1, '羽のコマは固定 (バタつかない)');
  assert.ok(dys.size >= 4, `上下に動く (${[...dys]})`);
  // 登場の最後と平時の最初で高さがつながる
  const b = new Animator(SPRITE, { seed: 1, wings: WINGS, fly: 'glide', present: false });
  b.enter('right');
  for (let i = 0; i < ACTION_LEN.enter - 1; i++) b.step();
  const last = b.pose().dy; b.step();
  assert.strictEqual(b.pose().dy, last);
});

test('1 ファイル版 dist/ が web/ と一致している (羽なし / 羽付き / 滑空)', () => {
  const fs = require('fs');
  const { build, VARIANTS } = require('../tools/build_standalone.js');
  for (const v of VARIANTS) {
    assert.ok(fs.existsSync(v.out), 'node tools/build_standalone.js で生成する: ' + v.out);
    assert.strictEqual(fs.readFileSync(v.out, 'utf8'), build(v), 'web/ を変えたら node tools/build_standalone.js を実行する');
  }
  assert.ok(!fs.readFileSync(VARIANTS[0].out, 'utf8').includes('KOUDAIOH_WINGS = WINGS'), '羽なし版に羽のデータは入れない');
});
