#!/usr/bin/env node
/*
 * ブラウザなしでアニメーションのフレームを書き出す (プレビュー GIF 作成・動作確認用)。
 *
 *   node tools/render_frames.js <outdir> [--wings] [scenario ...]
 *
 * <outdir>/<scenario>/000.ppm, 001.ppm ... を出力する (PPM は PIL でそのまま読める)。
 * scenario を省略すると全部出す。--wings で羽付き版 (ディレクトリ名は wings_<scenario>)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SPRITE = require('../web/sprite_data.js');
const WINGS = require('../web/sprite_wings.js');
const { Animator } = require('../web/koudaioh_anim.js');

// 各シナリオは (animator, push) を受け取り、push(n) で n フレーム書き出す
const SCENARIOS = {
  idle: (a, push) => { a.setState('idle'); push(10); },
  can_dead: (a, push) => { a.setState('can_dead'); push(15); },
  auto: (a, push) => { a.setState('auto'); push(20); },
  fire: (a, push) => { push(3); a.fire(); push(5 + 5); },
  no_link: (a, push) => { a.setState('no_link'); push(20); },
  enter_exit: (a, push) => {
    a.present = false;             // 椅子だけの状態から始める
    push(3);
    a.enter('right');
    push(9 + 5);
    a.exit('left');
    push(7 + 3);
  },
  demo: (a, push) => {
    a.present = false;
    push(2);
    a.enter('right'); push(9 + 5);
    a.setState('auto'); push(10);
    a.fire(); push(5 + 3);
    a.setState('can_dead'); push(10);
    a.setState('no_link'); push(10);
    a.setState('idle'); push(5);
    a.exit('left'); push(7 + 2);
  },
};

function writePPM(file, raster) {
  const { w, h, data } = raster;
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    body[j] = data[i]; body[j + 1] = data[i + 1]; body[j + 2] = data[i + 2];
  }
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

function run(name, outdir, wings) {
  const a = new Animator(SPRITE, { seed: 7, wings: wings ? WINGS : null });
  const dir = path.join(outdir, (wings ? 'wings_' : '') + name);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const push = (count) => {
    for (let i = 0; i < count; i++) {
      const r = a.step();
      writePPM(path.join(dir, String(n++).padStart(3, '0') + '.ppm'), r);
    }
  };
  SCENARIOS[name](a, push);
  return n;
}

function main() {
  const args = process.argv.slice(2);
  const wings = args.includes('--wings');
  const rest = args.filter((x) => x !== '--wings');
  const outdir = rest[0];
  if (!outdir) {
    console.error('usage: node tools/render_frames.js <outdir> [--wings] [scenario ...]');
    process.exit(1);
  }
  const names = rest.length > 1 ? rest.slice(1) : Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) throw new Error('unknown scenario: ' + name);
    const n = run(name, outdir, wings);
    console.log(`${wings ? 'wings_' : ''}${name}: ${n} frames`);
  }
}

main();
