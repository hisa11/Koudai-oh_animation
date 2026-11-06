#!/usr/bin/env python3
"""元画像から 8bit 風スプライトを生成する。

入力:
  assets/source/koudaioh.jpg           目が点灯している絵 (本体の基準)
  assets/source/koudaioh_eyes_off.jpg  同じ絵で目を消灯したもの (顔の素の画素と目の範囲の判定に使う)

出力: web/sprite_data.js
  - body  : ロボット本体 (192x256 の文字グリッド。手で直接ドット修正してよい)
  - stand : 椅子。元画像からは切り出さず楕円で描き直す (本体が離れても欠けないように)
  - anchors: 目・胸・額マーク・足元など、エフェクトの基準座標

文字の意味 (body / stand 共通):
  '.'          透明
  '0'-'9'      グレー系パレット (暗 -> 明)
  'o'          アウトライン
  'F' 'E' 'D' 'd'  目 (芯 / 明赤 / 赤 / 暗赤)。描画時に状態ごとの色へ置き換わる
  'm'          額のセンサーマーク。描画時に状態ごとの色へ置き換わる

処理の流れ:
  1. 元画像のドット格子 (4px) ごとの中央値で 192x256 に取り込む (= 元絵の実解像度)
  2. 背景 (外周とつながった黒) と元の椅子を除去
  3. 顔は消灯版の画素を使う。点灯版で赤く、消灯版で暗い画素 (バイザーの中) を目とする
     -> 目の外の装甲への照り返しは入らない
  4. 左右対称化: 向かって左半分を右へ鏡映し、軸をキャンバス中央へ寄せる
  5. k-means で減色、1px アウトライン

使い方:
  python3 tools/build_sprite.py
"""
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 192, 256         # 論理解像度 = 元画像 (765x1024) のドット格子 4px ぶん
CELL = 4                # 元画像の 1 ドット
PHASE = (0, 1)          # ドット格子の位相 (x, y)。4x4 ブロック内の分散が最小になるずれ
N_GRAYS = 10            # 本体のグレー階調数
BG_LUM = 30             # これ未満で外周とつながった画素は背景
FEET_CUT_ROW = 233      # 本体として残す最下行 (靴底)
MIN_PART = 120          # これより小さい連結成分は切り抜きの残骸として捨てる
# 左右対称の軸: x と MIRROR - x を対にする。
# 元絵は輪郭の軸が列 88、額マーク・胸の線など内側の模様の軸が列 87 付近とずれている。
# 顔の模様を崩さないことを優先して列 87 を軸にする (額マークの縦線 3px がそのまま残る)
MIRROR = 174
HALF = MIRROR // 2      # 左半分の最後の列 (= 軸の列 87)
SHIFT = 8               # 対称化後、軸をキャンバス中央 (列 95) へ寄せる量

FACE_BOX = (60, 88, 117, 133)   # 消灯版の画素を使う範囲 x0, y0, x1, y1
EYE_BOX = (64, 104, 92, 128)    # 目を探す範囲
MARK_BOX = (78, 74, 88, 104)    # 額マークを探す範囲 (左半分だけ。鏡映される)

ROOT = Path(__file__).resolve().parent.parent
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
N8 = N4 + ((1, 1), (1, -1), (-1, 1), (-1, -1))


# --------------------------------------------------------------------------
# 1. 取り込みと背景除去
# --------------------------------------------------------------------------
def load_native(src: Path) -> np.ndarray:
    """元画像を 4x4 ドットごとの中央値で 192x256 に取り込む。"""
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.int32)
    ph, pw = H * CELL + CELL, W * CELL + CELL
    pad = np.empty((ph, pw, 3), np.int32)
    h, w = min(a.shape[0], ph), min(a.shape[1], pw)
    pad[:h, :w] = a[:h, :w]
    pad[:h, w:] = a[:h, w - 1:w]
    pad[h:] = pad[h - 1:h]
    px, py = PHASE
    b = pad[py:py + H * CELL, px:px + W * CELL]
    blocks = b.reshape(H, CELL, W, CELL, 3).transpose(0, 2, 1, 3, 4).reshape(H, W, CELL * CELL, 3)
    return np.median(blocks, axis=2).astype(np.int32)


def flood(seed_mask: np.ndarray, passable: np.ndarray, nbrs=N4) -> np.ndarray:
    out = seed_mask & passable
    q = deque(zip(*np.where(out)))
    while q:
        y, x = q.popleft()
        for dx, dy in nbrs:
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and passable[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                q.append((ny, nx))
    return out


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """外周から暗い画素を flood fill したものを背景とする。
    内側の黒 (肩の関節穴、目の間の影) は外周とつながらないので残る。"""
    dark = rgb.mean(axis=2) < BG_LUM
    border = np.zeros((H, W), bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    return flood(border, dark)


# --------------------------------------------------------------------------
# 2. 本体と元の椅子の分離
#    元画像の椅子は靴と重なっているので、行・列・明るさで切り分ける。
#    (対称化前の座標。左半分だけ効けばよい)
#      左の靴: x=36..51 / y=214..231   脛の先: x=50..63 で y=227 まで
# --------------------------------------------------------------------------
def is_original_stand(x: int, y: int, lum: float) -> bool:
    if y > FEET_CUT_ROW:
        return True
    if y < 216:
        return False
    if x <= 35 or x >= 144:         # 座面の左右端
        return True
    if 64 <= x <= 113:              # 両脚の間 (座面の奥側が見えている)
        return y >= 222
    if x <= 39 or x >= 140:         # 端と靴の境目: 明るければ座面
        return lum > 140
    return y >= 228 and lum > 140   # 靴まわり: 明るい画素は座面


def keep_large_parts(mask: np.ndarray) -> np.ndarray:
    seen = np.zeros_like(mask)
    keep = np.zeros_like(mask)
    for y, x in zip(*np.where(mask)):
        if seen[y, x]:
            continue
        seed = np.zeros_like(mask)
        seed[y, x] = True
        part = flood(seed, mask, N8)
        seen |= part
        if part.sum() >= MIN_PART:
            keep |= part
    return keep


# --------------------------------------------------------------------------
# 3. 目と額マーク
# --------------------------------------------------------------------------
def eye_role(lit: np.ndarray, unlit: np.ndarray) -> str | None:
    """点灯版で赤く、消灯版で暗い (= バイザーのスリット内) 画素だけを目にする。
    消灯版で明るい画素は装甲への照り返しなので目に含めない。"""
    if unlit.mean() >= 90:
        return None
    r, g, b = (int(v) for v in lit)
    red = r - max(g, b)
    if red >= 170:
        return "F"
    if red >= 120:
        return "E"
    if red >= 70:
        return "D"
    if red >= 35:
        return "d"
    return None


MARK_LUM = 75           # 額マーク: これより暗い画素をマークとする


# --------------------------------------------------------------------------
# 4. 左右対称化 (向かって左半分を右へ鏡映)
# --------------------------------------------------------------------------
def mirror_left(arr: np.ndarray, fill) -> np.ndarray:
    out = arr.copy()
    for x in range(HALF + 1, W):
        xm = MIRROR - x
        out[:, x] = arr[:, xm] if xm >= 0 else fill
    return out


# --------------------------------------------------------------------------
# 5. 減色 (k-means, 輝度順に並べて '0'..)
# --------------------------------------------------------------------------
def kmeans_palette(colors: np.ndarray, k: int, iters: int = 30) -> np.ndarray:
    colors = colors.astype(np.float64)
    order = np.argsort(colors.mean(axis=1))
    centers = np.stack([colors[order[int((i + 0.5) / k * len(order))]] for i in range(k)])
    for _ in range(iters):
        lab = ((colors[:, None, :] - centers[None]) ** 2).sum(axis=2).argmin(axis=1)
        for i in range(k):
            sel = colors[lab == i]
            if len(sel):
                centers[i] = sel.mean(axis=0)
    centers = centers[np.argsort(centers.mean(axis=1))]
    return np.clip(np.round(centers), 0, 255).astype(int)


def quantize(rgb: np.ndarray, pal: np.ndarray) -> np.ndarray:
    d = ((rgb[:, :, None, :] - pal[None, None]) ** 2).sum(axis=3)
    return d.argmin(axis=2)


# --------------------------------------------------------------------------
# 6. 椅子 (描き直し)。最終座標 (中央寄せ後) で、本体と同じ軸で左右対称に描く
# --------------------------------------------------------------------------
STAND = dict(cy=227.0, rx=67.0, ry=11.0, rim=6, leg=(30, 37), center_leg_w=9)


def draw_stand(mirror: int) -> list[list[str]]:
    """座面 (楕円) + リム + 脚 3 本。x と mirror - x が対称。
    色は 0..6 の 7 段階で指定し、N_GRAYS に合わせて読み替える。"""
    g = [["." for _ in range(W)] for _ in range(H)]
    cx = (mirror + 1) / 2                     # 画素中心 (x + 0.5) で見た対称軸
    cy, rx, ry, rim = STAND["cy"], STAND["rx"], STAND["ry"], STAND["rim"]
    l0, l1 = STAND["leg"]
    c0 = (mirror - STAND["center_leg_w"] + 1) // 2
    legs = ((l0, l1), (c0, mirror - c0), (mirror - l1, mirror - l0))

    def inside(x: int, y: int) -> bool:
        return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1.0

    bottom: dict[int, int] = {}
    for x in range(W):
        rows = [y for y in range(H) if inside(x, y)]
        if not rows:
            continue
        top, bot = rows[0], rows[-1]
        bottom[x] = bot
        for y in rows:
            g[y][x] = "5"
        for i in range(2):                   # 奥側の縁
            if top + i < bot:
                g[top + i][x] = "3" if i == 0 else "4"
        g[bot][x] = g[bot - 1][x] = "6"      # 手前の縁のハイライト
        for i in range(rim):                 # 側面 (リム)
            g[bot + 1 + i][x] = "3" if i < 2 else "2" if i < 4 else "1"
        g[bot + rim + 1][x] = "0"
    xs = sorted(bottom)
    for x in (xs[0], xs[1], xs[-2], xs[-1]):  # 左右端は 1 段暗く
        for y in range(H):
            if g[y][x] in "56":
                g[y][x] = "4"
    for x0, x1 in legs:
        y_start = min(bottom[x] for x in range(x0, x1 + 1)) + rim + 2
        mid = (x0 + x1) / 2
        for y in range(y_start, H):
            for x in range(x0, x1 + 1):
                g[y][x] = "1" if x in (x0, x1) else "5" if abs(x - mid) < 1 else "4"
    lv = {str(i): str(round(i * (N_GRAYS - 1) / 6)) for i in range(7)}
    return [[lv.get(c, c) for c in row] for row in g]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def build(src: Path, src_off: Path, out: Path) -> None:
    lit = load_native(src)
    unlit = load_native(src_off)
    bg = background_mask(lit)
    lum = lit.mean(axis=2)

    body = np.zeros((H, W), bool)
    for y in range(H):
        for x in range(W):
            body[y, x] = not bg[y, x] and not is_original_stand(x, y, lum[y, x])
    body = keep_large_parts(body)

    # 顔: 消灯版の画素 (赤の照り返しがない素の装甲) を使い、目の位置に役割を付ける
    rgb = lit.copy()
    fx0, fy0, fx1, fy1 = FACE_BOX
    rgb[fy0:fy1 + 1, fx0:fx1 + 1] = unlit[fy0:fy1 + 1, fx0:fx1 + 1]
    role = np.full((H, W), "", dtype=object)
    ex0, ey0, ex1, ey1 = EYE_BOX
    for y in range(ey0, ey1 + 1):
        for x in range(ex0, min(ex1, HALF) + 1):
            if body[y, x]:
                r = eye_role(lit[y, x], unlit[y, x])
                if r:
                    role[y, x] = r
    mx0, my0, mx1, my1 = MARK_BOX
    for y in range(my0, my1 + 1):
        for x in range(mx0, mx1 + 1):
            if body[y, x] and lum[y, x] < MARK_LUM:
                role[y, x] = "m"

    # 左右対称化 (向かって左半分を正とする)
    rgb = mirror_left(rgb, 0)
    body = mirror_left(body, False)
    role = mirror_left(role, "")

    plain = body & (role == "")
    pal = kmeans_palette(rgb[plain], N_GRAYS)
    idx = quantize(rgb, pal)
    grid = [["." for _ in range(W)] for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if body[y, x]:
                grid[y][x] = role[y, x] or str(idx[y, x])

    # 軸をキャンバス中央へ寄せる
    grid = [["."] * SHIFT + row[: W - SHIFT] for row in grid]
    mirror = MIRROR + 2 * SHIFT          # 最終座標で x と mirror - x が対 (= 191)
    cx = mirror // 2                     # 中央の左側の列 (95)。エフェクトの基準

    # 1px アウトライン (4 近傍)。椅子やエフェクトと重なったときに輪郭が立つ
    for y in range(H):
        for x in range(W):
            if grid[y][x] == "." and any(
                0 <= x + dx < W and 0 <= y + dy < H and grid[y + dy][x + dx] not in ".o" for dx, dy in N4
            ):
                grid[y][x] = "o"

    stand = draw_stand(mirror)

    def box(pts):
        return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]

    solid = [(x, y) for y in range(H) for x in range(W) if grid[y][x] != "."]
    eyes = [(x, y) for (x, y) in solid if grid[y][x] in "FEDd"]
    mark = box([(x, y) for (x, y) in solid if grid[y][x] == "m"])
    anchors = {
        "unit": 2,                       # エフェクト寸法の基準 (1 unit = 2px)
        "mirror": mirror,                # 左右対称: x と mirror - x が同じ
        "bbox": box(solid),
        "eyeL": box([p for p in eyes if p[0] < cx]),
        "eyeR": box([p for p in eyes if p[0] > cx]),
        "mark": [cx, (mark[1] + mark[3]) // 2],
        "head": [cx, 96],
        "chest": [cx, 158],
        "feet": [[44 + SHIFT, FEET_CUT_ROW], [mirror - 44 - SHIFT, FEET_CUT_ROW]],
        "seatY": int(STAND["cy"]),
    }

    palette = {str(i): "#%02x%02x%02x" % tuple(int(v) for v in c) for i, c in enumerate(pal)}
    palette["o"] = "#07080d"
    # 額マークの通常色 (元絵のマーク画素の平均)。AUTO のときは描画側で青/緑に置き換わる
    mc = rgb[role == "m"].mean(axis=0)
    palette["m"] = "#%02x%02x%02x" % tuple(int(round(v)) for v in mc)

    lines = [
        "// 生成元: tools/build_sprite.py  (body / stand の文字グリッドは手で直してもよい)",
        "// '.'透明  '0'-'9'グレー  'o'輪郭  'F''E''D''d'目(芯/明赤/赤/暗赤)  'm'額マーク (palette.m は通常色)",
        "(function (root) {",
        "  var SPRITE = {",
        f"    w: {W}, h: {H},",
        f"    palette: {json.dumps(palette)},",
        f"    anchors: {json.dumps(anchors)},",
        "    body: [",
        *[f'      "{"".join(r)}",' for r in grid],
        "    ],",
        "    stand: [",
        *[f'      "{"".join(r)}",' for r in stand],
        "    ]",
        "  };",
        "  if (typeof module === 'object' && module && module.exports) module.exports = SPRITE;",
        "  if (root) root.KOUDAIOH_SPRITE = SPRITE;   // ブラウザでは常にグローバルに登録",
        "})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);",
        "",
    ]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out}")
    print(f"palette={palette}")
    print(f"anchors={anchors}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=ROOT / "assets/source/koudaioh.jpg")
    ap.add_argument("--src-off", type=Path, default=ROOT / "assets/source/koudaioh_eyes_off.jpg")
    ap.add_argument("--out", type=Path, default=ROOT / "web/sprite_data.js")
    a = ap.parse_args()
    build(a.src, a.src_off, a.out)


if __name__ == "__main__":
    main()
