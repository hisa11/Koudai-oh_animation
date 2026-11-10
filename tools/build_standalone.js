#!/usr/bin/env node
/*
 * web/index.html と、それが読み込む .js をすべて埋め込んだ 1 ファイル版を作る。
 *
 *   node tools/build_standalone.js
 *     -> dist/koudaioh.html        羽なし版 (羽のデータは入れない)
 *     -> dist/koudaioh_wings.html  羽付き版 (既定で羽付き。?wings=0 で羽なしにもできる)
 *
 * 1 ファイル版は、隣のファイルを読めない環境 (アプリのプレビュー、HTML 単体のコピー、
 * 一部の組み込みブラウザ) でもそのまま動く。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web', 'index.html');

const VARIANTS = [
  { out: path.join(ROOT, 'dist', 'koudaioh.html'), drop: ['sprite_wings.js'], wings: false },
  { out: path.join(ROOT, 'dist', 'koudaioh_wings.html'), drop: [], wings: true },
];

function build(variant) {
  const html = fs.readFileSync(SRC, 'utf8');
  let count = 0;
  let out = html.replace(/<script src="([^"]+)"><\/script>\n?/g, (_, src) => {
    if (variant.drop.includes(src)) return '';
    const code = fs.readFileSync(path.join(ROOT, 'web', src), 'utf8');
    if (/<\/script/i.test(code)) throw new Error(src + ' に </script が含まれていて埋め込めない');
    count++;
    return '<script>/* ---- ' + src + ' ---- */\n' + code + '\n</script>\n';
  });
  if (count === 0) throw new Error('埋め込む <script src> が見つからない');
  if (variant.wings) {
    out = out.replace('<script>/* ---- ', '<script>window.KOUDAIOH_DEFAULT_WINGS = true;</script>\n<script>/* ---- ');
  }
  // doctype の直後に生成物である旨を入れる
  return out.replace(/^(<!doctype html>\n)/i,
    '$1<!-- 生成物: node tools/build_standalone.js (web/ の 1 ファイル版。直接編集しない) -->\n');
}

module.exports = { build, VARIANTS };

if (require.main === module) {
  for (const v of VARIANTS) {
    const html = build(v);
    fs.mkdirSync(path.dirname(v.out), { recursive: true });
    fs.writeFileSync(v.out, html);
    console.log('wrote ' + path.relative(ROOT, v.out) + ' (' + Math.round(html.length / 1024) + ' KB)');
  }
}
