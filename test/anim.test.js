// npm test  (= node --test)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SPRITE = require('../web/sprite_data.js');
const { Animator, ACTION_LEN } = require('../web/koudaioh_anim.js');

const W = SPRITE.w, H = SPRITE.h;
const MIRROR = SPRITE.anchors.mirror;       // x と MIRROR - x が左右対称の対

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

test('本体と椅子は左右対称', () => {
  for (const key of ['body', 'stand']) {
    SPRITE[key].forEach((row, y) => {
      for (let x = 0; x < W; x++) {
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
