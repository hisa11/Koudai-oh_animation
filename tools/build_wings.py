#!/usr/bin/env python3
"""羽付き版の羽 5 コマを、羽のシートから切り出す。

入力:
  web/sprite_data.js                    羽なし版のスプライト (本体。位置合わせの基準)
  assets/source/koudaioh_wings_sheet.png  羽ばたき 5 コマ (01 上げ -> 05 下げ)

出力: web/sprite_wings.js
  羽 5 コマと、羽付き版のキャンバスの大きさ。本体と椅子は sprite_data.js を共有する
  (羽付き版のキャンバスは羽が収まるように横に広く、本体は ox だけ右に置く)

処理:
  1. 各コマのロボットを羽なし版の本体に位置合わせする (縮尺と位置)。
     本体の画素だけを使うマスク付き正規化相互相関を numpy の FFT で計算し、縮尺を振って最大を取る
  2. 各コマを本体と同じ縮尺に取り込み (1px ごとにブロック中心の画素)、本体と椅子の外にある
     前景 (輝度 >= FG_LUM) を羽とする。
     本体の際 (DILATE px) は、羽の色 (暗い膜か金) のときだけ羽にする (白は本体のはみ出し)
  3. 向かって左の羽を右へ鏡映する (本体と同じ軸)
  4. k-means で減色

使い方:
  python3 tools/build_wings.py      # 先に tools/build_sprite.py で sprite_data.js を作っておく
"""
from __future__ import annotations

import argparse
import json
import re
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# シート上の各コマの範囲 (x0, y0, x1, y1)。灰色の枠線から 4px 内側
PANELS = [(16, 16, 505, 466), (523, 16, 1013, 466), (1031, 16, 1521, 466),
          (198, 501, 756, 947), (780, 501, 1339, 947)]
SCALES = np.arange(1.58, 1.79, 0.01)   # 本体 1px あたりのシートの px 数の探索範囲
FG_LUM = 8              # 背景 (純黒) と羽の黒い膜 (輝度 11〜20) の境目
DILATE = 2              # 本体の際の幅
MIN_PART = 25           # これより小さい羽の破片は捨てる
MIN_GOLD = 3            # 金の画素がこれより少ない破片は捨てる (羽は必ず金の骨とつながっている。
                        # アンテナや頭のずれた輪郭など、本体のはみ出しはここで落ちる)
STAND_ZONE = (20, 210, 171)   # 椅子のあたり (x0, y0, x1)。ここより下の前景は羽にしない
N_COLORS = 7
PAD = 160               # 羽が本体の外へはみ出す分の余白 (本体座標で左右に)


def load_sprite(path: Path):
    src = path.read_text(encoding="utf-8")
    pal = json.loads(re.search(r"palette: (\{.*?\})", src).group(1))
    anchors = json.loads(re.search(r"anchors: (\{.*?\})", src).group(1))
    rows = re.findall(r'"([^"]*)"', re.search(r"body: \[(.*?)\]", src, re.S).group(1))
    return pal, anchors, rows


def body_template(pal, rows):
    eye = {"F": 140, "E": 100, "D": 70, "d": 60, "m": 60}
    h, w = len(rows), len(rows[0])
    lum = np.zeros((h, w))
    solid = np.zeros((h, w), bool)
    core = np.zeros((h, w), bool)
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c == ".":
                continue
            solid[y, x] = True
            if c == "o":
                continue
            core[y, x] = True
            lum[y, x] = np.mean([int(pal[c][i:i + 2], 16) for i in (1, 3, 5)]) if c in pal else eye.get(c, 60)
    return lum, core, solid


def xcorr(a: np.ndarray, k: np.ndarray) -> np.ndarray:
    """a と k の相互相関 (k が a の中に収まる位置だけ)。"""
    shape = (a.shape[0] + k.shape[0], a.shape[1] + k.shape[1])
    r = np.fft.irfft2(np.fft.rfft2(a, shape) * np.fft.rfft2(k[::-1, ::-1], shape), shape)
    return r[k.shape[0] - 1:a.shape[0], k.shape[1] - 1:a.shape[1]]


def register(panel_lum: np.ndarray, lum: np.ndarray, core: np.ndarray):
    """本体 (lum, core) がコマのどこに何倍で写っているか。返り値 (ncc, s, u, v):
    本体の (x, y) がコマを 1/s に縮めた画像の (x+u, y+v) に重なる。"""
    ys, xs = np.where(core)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    t = lum[y0:y1, x0:x1]
    m = core[y0:y1, x0:x1].astype(float)
    n = m.sum()
    tz = (t - (t * m).sum() / n) * m
    tnorm = np.sqrt((tz ** 2).sum())
    best = None
    img = Image.fromarray(panel_lum.astype(np.uint8))
    for s in SCALES:
        p = np.asarray(img.resize((int(img.width / s), int(img.height / s)), Image.BOX)).astype(float)
        num = xcorr(p, tz)
        s1 = xcorr(p, m)
        s2 = xcorr(p ** 2, m)
        ncc = num / (np.sqrt(np.maximum(s2 - s1 ** 2 / n, 1e-6)) * tnorm)
        v, u = np.unravel_index(np.argmax(ncc), ncc.shape)
        if best is None or ncc[v, u] > best[0]:
            best = (float(ncc[v, u]), float(s), int(u - x0), int(v - y0))
    return best


def sample(panel: np.ndarray, s: float, u: int, v: int, w: int, h: int):
    """本体座標 (x, y) (x は -PAD..w+PAD) の 1px に当たるコマの画素 (ブロックの中心) の色と、前景かどうか。"""
    ph, pw = panel.shape[:2]
    px = np.floor((np.arange(-PAD, w + PAD) + u + 0.5) * s).astype(int)
    py = np.floor((np.arange(h) + v + 0.5) * s).astype(int)
    okx = (px >= 0) & (px < pw)
    oky = (py >= 0) & (py < ph)
    rgb = panel[np.clip(py, 0, ph - 1)][:, np.clip(px, 0, pw - 1)].copy()
    ok = oky[:, None] & okx[None, :]
    rgb[~ok] = 0
    fg = (rgb.mean(axis=2) >= FG_LUM) & ok
    return rgb, fg


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def components(mask: np.ndarray):
    seen = np.zeros_like(mask)
    h, w = mask.shape
    for y, x in zip(*np.where(mask)):
        if seen[y, x]:
            continue
        part = [(y, x)]
        seen[y, x] = True
        q = deque(part)
        while q:
            cy, cx = q.popleft()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        part.append((ny, nx))
                        q.append((ny, nx))
        yield part


def gold(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (r > 120) & (g > 80) & (b < 0.6 * g)


def wing_colored(rgb: np.ndarray) -> np.ndarray:
    """本体の際で羽として残す色: 暗い膜か金 (白・灰は本体のはみ出し)。"""
    return (rgb.max(axis=2) < 70) | gold(rgb)


def kmeans(colors: np.ndarray, k: int, iters: int = 30) -> np.ndarray:
    colors = colors.astype(np.float64)
    order = np.argsort(colors.mean(axis=1))
    centers = np.stack([colors[order[int((i + 0.5) / k * len(order))]] for i in range(k)])
    for _ in range(iters):
        lab = ((colors[:, None, :] - centers[None]) ** 2).sum(axis=2).argmin(axis=1)
        for i in range(k):
            sel = colors[lab == i]
            if len(sel):
                centers[i] = sel.mean(axis=0)
    return np.clip(np.round(centers[np.argsort(centers.mean(axis=1))]), 0, 255).astype(int)


def build(sprite_path: Path, sheet_path: Path, out: Path) -> None:
    pal, anchors, rows = load_sprite(sprite_path)
    lum, core, solid = body_template(pal, rows)
    h, w = core.shape
    mirror = anchors["mirror"]
    half = mirror // 2                       # 左半分の最後の列 (軸)
    sheet = np.asarray(Image.open(sheet_path).convert("RGB")).astype(np.int32)

    body_pad = np.zeros((h, w + 2 * PAD), bool)
    body_pad[:, PAD:PAD + w] = solid
    near = dilate(body_pad, DILATE)
    sx0, sy0, sx1 = STAND_ZONE
    xs = np.arange(-PAD, w + PAD)[None, :]
    ys = np.arange(h)[:, None]
    stand = (ys >= sy0) & (xs >= sx0) & (xs <= sx1)
    left = np.broadcast_to(xs <= half, (h, w + 2 * PAD))

    frames_rgb, frames_mask = [], []
    for i, (x0, y0, x1, y1) in enumerate(PANELS):
        panel = sheet[y0:y1, x0:x1]
        ncc, s, u, v = register(panel.mean(axis=2), lum, core)
        print(f"frame {i + 1}: ncc={ncc:.3f} scale={s:.2f} offset=({u},{v})")
        rgb, fg = sample(panel, s, u, v, w, h)
        cand = fg & ~body_pad & ~stand & left
        wing = cand & ~near
        # 本体の際: 羽の色で、羽本体とつながっているものだけ残す
        ring = cand & near
        ring &= wing_colored(rgb)
        mask = np.zeros_like(wing)
        is_gold = gold(rgb)
        for part in components(wing | ring):
            if len(part) < MIN_PART or not any(wing[p] for p in part):
                continue
            if sum(is_gold[p] for p in part) < MIN_GOLD:
                continue
            for p in part:
                mask[p] = True
        # 左右対称化 (向かって左を右へ)
        for x in range(w + 2 * PAD):
            xb = x - PAD
            if xb > half:
                xm = mirror - xb + PAD
                rgb[:, x] = rgb[:, xm] if 0 <= xm < rgb.shape[1] else 0
                mask[:, x] = mask[:, xm] if 0 <= xm < mask.shape[1] else False
        frames_rgb.append(rgb)
        frames_mask.append(mask)

    colors = np.concatenate([r[m] for r, m in zip(frames_rgb, frames_mask)])
    wpal = kmeans(colors, N_COLORS)
    chars = "abcdefghij"[:N_COLORS]

    # 羽付き版のキャンバス: 羽が収まる幅 (8 の倍数)、本体は ox だけ右へ
    xs_used = np.where(np.any(np.stack(frames_mask), axis=(0, 1)))[0] - PAD
    ext = max(-xs_used.min(), xs_used.max() - (w - 1), 0)
    ox = int(ext + 4)
    cw = w + 2 * ox
    if cw % 8:
        ox += (8 - cw % 8 + 1) // 2
        cw = w + 2 * ox
    frames = []
    for rgb, mask in zip(frames_rgb, frames_mask):
        ys_m, xs_m = np.where(mask)
        fx0, fx1 = xs_m.min(), xs_m.max()
        fy0, fy1 = ys_m.min(), ys_m.max()
        idx = ((rgb[:, :, None, :] - wpal[None, None]) ** 2).sum(axis=3).argmin(axis=2)
        grid = []
        for y in range(fy0, fy1 + 1):
            grid.append("".join(chars[idx[y, x]] if mask[y, x] else "." for x in range(fx0, fx1 + 1)))
        frames.append({"x": int(fx0 - PAD + ox), "y": int(fy0), "rows": grid})

    data = {
        "w": cw, "h": h, "ox": ox,
        "mirror": mirror + 2 * ox,           # 羽付き版のキャンバスで x と mirror - x が対
        "palette": {c: "#%02x%02x%02x" % tuple(int(t) for t in wpal[i]) for i, c in enumerate(chars)},
    }
    lines = [
        "// 生成元: tools/build_wings.py  (羽 5 コマ。01 上げ -> 05 下げ。文字グリッドは手で直してもよい)",
        "// '.'透明  'a'-'" + chars[-1] + "' 羽の色 (暗 -> 明)。本体と椅子は sprite_data.js を共有し、ox だけ右に置く",
        "(function (root) {",
        "  var WINGS = {",
        f"    w: {data['w']}, h: {data['h']}, ox: {data['ox']}, mirror: {data['mirror']},",
        f"    palette: {json.dumps(data['palette'])},",
        "    frames: [",
    ]
    for f in frames:
        lines.append(f"      {{ x: {f['x']}, y: {f['y']}, rows: [")
        lines += [f'        "{r}",' for r in f["rows"]]
        lines.append("      ] },")
    lines += [
        "    ]",
        "  };",
        "  if (typeof module === 'object' && module && module.exports) module.exports = WINGS;",
        "  if (root) root.KOUDAIOH_WINGS = WINGS;   // ブラウザでは常にグローバルに登録",
        "})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);",
        "",
    ]
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out}  canvas={cw}x{h} ox={ox} palette={data['palette']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sprite", type=Path, default=ROOT / "web/sprite_data.js")
    ap.add_argument("--sheet", type=Path, default=ROOT / "assets/source/koudaioh_wings_sheet.png")
    ap.add_argument("--out", type=Path, default=ROOT / "web/sprite_wings.js")
    a = ap.parse_args()
    build(a.sprite, a.sheet, a.out)


if __name__ == "__main__":
    main()
