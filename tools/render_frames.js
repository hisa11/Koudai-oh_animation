#!/usr/bin/env node
/*
 * ブラウザなしでアニメーションのフレームを書き出す (プレビュー GIF 作成・動作確認用)。
 *
 *   node tools/render_frames.js <outdir> [--wings | --glide] [scenario ...]
 *
 * <outdir>/<scenario>/000.ppm, 001.ppm ... を出力する (PPM は PIL でそのまま読める)。
 * scenario を省略すると全部出す。--wings で羽付き版 (羽ばたき。ディレクトリ名は wings_<scenario>)、
 * --glide で羽付き版の滑空 (glide_<scenario>)。
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
  // 変身 (羽のデータがあるときだけ): 羽なし → 光 → 羽あり → 光 → 羽なし
  transform: (a, push) => {
    a.setWings(false, true);
    push(4);
    a.setWings(true); push(9 + 8);
    a.setWings(false); push(9 + 4);
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

function run(name, outdir, mode) {
  const a = new Animator(SPRITE, { seed: 7, wings: mode ? WINGS : null, fly: mode === 'glide' ? 'glide' : 'flap' });
  const dir = path.join(outdir, (mode ? mode + '_' : '') + name);
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
  const mode = args.includes('--glide') ? 'glide' : args.includes('--wings') ? 'wings' : '';
  const rest = args.filter((x) => x !== '--wings' && x !== '--glide');
  const outdir = rest[0];
  if (!outdir) {
    console.error('usage: node tools/render_frames.js <outdir> [--wings | --glide] [scenario ...]');
    process.exit(1);
  }
  const names = rest.length > 1 ? rest.slice(1)
    : Object.keys(SCENARIOS).filter((n) => mode || n !== 'transform');   // 変身は羽付きのときだけ
  for (const name of names) {
    if (!SCENARIOS[name]) throw new Error('unknown scenario: ' + name);
    const n = run(name, outdir, mode);
    console.log(`${mode ? mode + '_' : ''}${name}: ${n} frames`);
  }
}

main();
