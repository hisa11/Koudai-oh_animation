#!/usr/bin/env node
/*
 * web/index.html と、それが読み込む .js をすべて埋め込んだ 1 ファイル版を作る。
 *
 *   node tools/build_standalone.js        -> dist/koudaioh.html
 *
 * 1 ファイル版は、隣のファイルを読めない環境 (アプリのプレビュー、HTML 単体のコピー、
 * 一部の組み込みブラウザ) でもそのまま動く。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web', 'index.html');
const OUT = path.join(ROOT, 'dist', 'koudaioh.html');

function build() {
  const html = fs.readFileSync(SRC, 'utf8');
  let count = 0;
  const out = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const code = fs.readFileSync(path.join(ROOT, 'web', src), 'utf8');
    if (/<\/script/i.test(code)) throw new Error(src + ' に </script が含まれていて埋め込めない');
    count++;
    return '<script>/* ---- ' + src + ' ---- */\n' + code + '\n</script>';
  });
  if (count === 0) throw new Error('埋め込む <script src> が見つからない');
  // doctype の直後に生成物である旨を入れる
  return out.replace(/^(<!doctype html>\n)/i,
    '$1<!-- 生成物: node tools/build_standalone.js (web/ の 1 ファイル版。直接編集しない) -->\n');
}

module.exports = { build, OUT };

if (require.main === module) {
  const html = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(html.length / 1024) + ' KB)');
}
