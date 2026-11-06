#!/usr/bin/env python3
"""元画像から 8bit 風スプライトを生成する。

入力:
  assets/source/koudaioh.jpg           目が点灯している絵 (本体の基準)
  assets/source/koudaioh_eyes_off.jpg  同じ絵で目を消灯したもの (顔の素の画素と目の形の判定に使う)

出力: web/sprite_data.js
  - body  : ロボット本体 (96x128 の文字グリッド。手で直接ドット修正してよい)
  - stand : 椅子。元画像からは切り出さず楕円で描き直す (本体が離れても欠けないように)
  - anchors: 目・胸・額マーク・足元など、エフェクトの基準座標

文字の意味 (body / stand 共通):
  '.'      透明
  '0'-'6'  グレー系パレット (暗 -> 明)
  'o'      アウトライン
  'F' 'E' 'd'  目 (芯 / 赤 / 暗赤)。描画時に状態ごとの色へ置き換わる
  'm'      額のセンサーマーク。描画時に状態ごとの色へ置き換わる

処理の流れ:
  1. 8x8 ブロック中央値で 96x128 に縮小
  2. 背景 (外周とつながった黒) と元の椅子を除去
  3. 顔は消灯版の画素を使い、目は手打ちのスタンプを置く
  4. 左右対称化 (左右の色を平均して鏡映)。軸をキャンバス中央へ
  5. k-means で 7 階調に減色、孤立点除去、額マークの描き直し、1px アウトライン

使い方:
  python3 tools/build_sprite.py [--sym avg|left|right]
"""
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 96, 128          # 論理解像度 (元画像 765x1024 のほぼ 1/8)
N_GRAYS = 7             # 本体のグレー階調数
BG_LUM = 30             # これ未満で外周とつながった画素は背景
FEET_CUT_ROW = 116      # 本体として残す最下行 (靴底)
MIN_PART = 30           # これより小さい連結成分は切り抜きの残骸として捨てる
AXIS = 44               # 元絵での左右対称軸の列 (シルエットの鏡映 IoU が最大になる列)
SHIFT = 3               # 対称化後、軸をキャンバス中央 (列 47) へ寄せる量
FACE_BOX = (30, 44, 58, 66)   # 消灯版の画素を使う範囲 x0, y0, x1, y1

ROOT = Path(__file__).resolve().parent.parent
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
N8 = N4 + ((1, 1), (1, -1), (-1, 1), (-1, -1))


# --------------------------------------------------------------------------
# 1. 縮小と背景除去
# --------------------------------------------------------------------------
def load_small(src: Path) -> np.ndarray:
    """8x8 ブロックごとの中央値で縮小する。平均 (BOX) より輪郭が立ち、ドット絵らしくなる。"""
    im = Image.open(src).convert("RGB").resize((W * 8, H * 8), Image.NEAREST)
    a = np.asarray(im).astype(np.int32)
    blocks = a.reshape(H, 8, W, 8, 3).transpose(0, 2, 1, 3, 4).reshape(H, W, 64, 3)
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
#    (座標は 96x128 グリッド上で目視確認したもの。対称化前の座標)
#      左の靴: x=18..25 / y=107..115   脛の先: x=25..31 で y=113 まで
# --------------------------------------------------------------------------
def is_original_stand(x: int, y: int, lum: float) -> bool:
    if y > FEET_CUT_ROW:
        return True
    if y < 108:
        return False
    if x <= 17 or x >= 72:          # 座面の左右端
        return True
    if 32 <= x <= 56:               # 両脚の間 (座面の奥側が見えている)
        return y >= 111
    if x <= 19 or x >= 70:          # 端と靴の境目: 明るければ座面
        return lum > 140
    return y >= 114 and lum > 140   # 靴まわり: 明るい画素は座面


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
# 目は 1/8 縮小だと芯と赤が交互に並んでギザギザになるので、元絵 (点灯版) の向かって左の目を
# 8x8 セルごとの赤み (r - max(g,b)) で読み取り、手で整えたものを置く。右目は対称化で鏡映される。
#   赤み >= 145: 'F'   90..145: 'E'   55..90 かつ暗い: 'd'   (明るいセルは照り返しなので目に含めない)
#   輝度 < 35 のセルは '0' (バイザー下の黒い楔)
# 対称化前の座標で x=35..44, y=56..61。外側が高く、上辺が内側へ下がる。
#   'F''E''d' 目 (芯/赤/暗赤)   '0' バイザーの黒   '.' 消灯版の画素のまま
EYE_ORIGIN = (35, 56)
EYE_STAMP = [
    ".EE.......",
    ".EFFEd....",
    ".EFFFFEd00",
    ".dEFFFd000",
    "......0000",
    ".......000",
]

# 手修正 (対称化前の座標、左半分のみ)。縮小で途切れた線が孤立した黒点に見える箇所など。
TOUCHUP = {
    # 頬の下の斜め線の末端が 2x2 の黒い塊になり「鼻の穴」に見えるので暗いグレーに
    (37, 62): "1", (38, 62): "1", (37, 63): "1", (38, 63): "1",
}


# 額のセンサーマーク (照準風の十字＋円)。1/8 縮小では潰れるので描き直す。
# '#' がマーク、'+' は下地を塗り直す。中心列が AXIS に来るように置く。
MARK_ORIGIN = (AXIS - 3, 38)
MARK_STAMP = [
    "+++#+++",
    "+++#+++",
    "++###++",
    "+#+++#+",
    "##+#+##",
    "+#+++#+",
    "++###++",
    "+++#+++",
    "+++#+++",
]


# --------------------------------------------------------------------------
# 4. 左右対称化
# --------------------------------------------------------------------------
def symmetrize(rgb: np.ndarray, mask: np.ndarray, roles: dict, mode: str):
    """左半分 (x <= AXIS) を基準に右へ鏡映する。
    mode='avg'  : 左右とも本体の画素は色を平均する (片側だけの陰影が平らにならない)
    mode='left' : 左半分をそのまま鏡映
    mode='right': 右半分を左へ鏡映してから同様に扱う"""
    rgb = rgb.copy()
    mask = mask.copy()
    if mode == "right":
        for x in range(0, AXIS):
            xm = 2 * AXIS - x
            rgb[:, x] = rgb[:, xm]
            mask[:, x] = mask[:, xm]
        roles = {(2 * AXIS - x if x > AXIS else x, y): r for (x, y), r in roles.items() if x >= AXIS}
    elif mode == "avg":
        for x in range(0, AXIS):
            xm = 2 * AXIS - x
            both = mask[:, x] & mask[:, xm]
            rgb[both, x] = (rgb[both, x] + rgb[both, xm]) // 2
    for x in range(AXIS + 1, W):
        xm = 2 * AXIS - x
        if xm >= 0:
            rgb[:, x] = rgb[:, xm]
            mask[:, x] = mask[:, xm]
        else:
            mask[:, x] = False
    left_roles = {(x, y): r for (x, y), r in roles.items() if x <= AXIS}
    roles = dict(left_roles)
    for (x, y), r in left_roles.items():
        roles[(2 * AXIS - x, y)] = r
    return rgb, mask, roles


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


def nearest(pal: np.ndarray, px: np.ndarray) -> int:
    return int(((pal - px) ** 2).sum(axis=1).argmin())


def despeckle(grid: list[list[str]]) -> None:
    """周囲 4 近傍と 1 つも同じ色を持たず、3 つ以上が同じ色に囲まれた孤立点を潰す。"""
    src = [row[:] for row in grid]
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            c = src[y][x]
            if not c.isdigit():
                continue
            ns = [src[y + dy][x + dx] for dx, dy in N4]
            if c in ns:
                continue
            for cand in sorted(set(ns)):
                if cand.isdigit() and ns.count(cand) >= 3:
                    grid[y][x] = cand
                    break


def mirror_grid(grid: list[list[str]]) -> None:
    for y in range(H):
        for x in range(AXIS + 1, W):
            xm = 2 * AXIS - x
            grid[y][x] = grid[y][xm] if xm >= 0 else "."


# --------------------------------------------------------------------------
# 6. 椅子 (描き直し)。最終座標 (中央寄せ後) で描く。中心列 = AXIS + SHIFT = 47
# --------------------------------------------------------------------------
STAND = dict(cx=47.5, cy=113.5, rx=33.5, ry=5.6, legs=((15, 18), (45, 49), (76, 79)))


def draw_stand() -> list[list[str]]:
    """座面 (楕円) + リム + 脚 3 本。色は 0..6 の 7 段階で指定し、N_GRAYS に合わせて読み替える。"""
    g = [["." for _ in range(W)] for _ in range(H)]
    cx, cy, rx, ry = STAND["cx"], STAND["cy"], STAND["rx"], STAND["ry"]

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
        g[top][x] = "3"                      # 奥側の縁
        if top + 1 < bot:
            g[top + 1][x] = "4"
        g[bot][x] = "6"                      # 手前の縁のハイライト
        for i, c in enumerate("321"):        # 側面 (リム)
            g[bot + 1 + i][x] = c
        g[bot + 4][x] = "0"
    xs = sorted(bottom)
    for x in (xs[0], xs[-1]):                # 左右端は 1 段暗く
        for y in range(H):
            if g[y][x] in "56":
                g[y][x] = "4"
    for x0, x1 in STAND["legs"]:
        y_start = min(bottom[x] for x in range(x0, x1 + 1)) + 4
        for y in range(y_start, H):
            for x in range(x0, x1 + 1):
                mid = (x0 + x1) / 2
                g[y][x] = "1" if x in (x0, x1) else "5" if abs(x - mid) < 1 else "4"
    lv = {str(i): str(round(i * (N_GRAYS - 1) / 6)) for i in range(7)}
    return [[lv.get(c, c) for c in row] for row in g]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def build(src: Path, src_off: Path, out: Path, sym: str) -> None:
    lit = load_small(src)
    unlit = load_small(src_off)
    bg = background_mask(lit)
    lum = lit.mean(axis=2)

    body = np.zeros((H, W), bool)
    for y in range(H):
        for x in range(W):
            body[y, x] = not bg[y, x] and not is_original_stand(x, y, lum[y, x])
    body = keep_large_parts(body)

    # 顔: 消灯版の画素 (赤の照り返しがない素の装甲) を使い、目は手打ちのスタンプを置く
    rgb = lit.copy()
    fx0, fy0, fx1, fy1 = FACE_BOX
    rgb[fy0:fy1 + 1, fx0:fx1 + 1] = unlit[fy0:fy1 + 1, fx0:fx1 + 1]
    roles: dict[tuple[int, int], str] = {}
    ox, oy = EYE_ORIGIN
    for j, row in enumerate(EYE_STAMP):
        for i, c in enumerate(row):
            if c != ".":
                roles[(ox + i, oy + j)] = c

    rgb, body, roles = symmetrize(rgb, body, roles, sym)

    gray = [rgb[y, x] for y in range(H) for x in range(W) if body[y, x] and (x, y) not in roles]
    pal = kmeans_palette(np.array(gray), N_GRAYS)
    grid = [[str(nearest(pal, rgb[y, x])) if body[y, x] else "." for x in range(W)] for y in range(H)]
    for _ in range(2):
        despeckle(grid)
    for (x, y), r in roles.items():
        grid[y][x] = r
    for (x, y), c in TOUCHUP.items():
        grid[y][x] = c

    # 額マーク: 下地は軸の左を明るく、軸上を中間に
    mx0, my0 = MARK_ORIGIN
    for j, row in enumerate(MARK_STAMP):
        for i, c in enumerate(row):
            x, y = mx0 + i, my0 + j
            if grid[y][x] != ".":
                grid[y][x] = "m" if c == "#" else ("5" if x < AXIS else "4")
    mirror_grid(grid)                         # despeckle の向き依存を消して厳密に対称へ

    # 軸をキャンバス中央へ寄せる
    grid = [["."] * SHIFT + row[: W - SHIFT] for row in grid]
    cx = AXIS + SHIFT

    # 1px アウトライン (4 近傍)。椅子やエフェクトと重なったときに輪郭が立つ
    for y in range(H):
        for x in range(W):
            if grid[y][x] == "." and any(
                0 <= x + dx < W and 0 <= y + dy < H and grid[y + dy][x + dx] not in ".o" for dx, dy in N4
            ):
                grid[y][x] = "o"

    stand = draw_stand()

    def box(pts):
        return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]

    solid = [(x, y) for y in range(H) for x in range(W) if grid[y][x] != "."]
    eyes = [(x, y) for (x, y) in solid if grid[y][x] in "FEd"]
    anchors = {
        "bbox": box(solid),
        "eyeL": box([p for p in eyes if p[0] < cx]),
        "eyeR": box([p for p in eyes if p[0] > cx]),
        "mark": [cx, my0 + 4],
        "head": [cx, 48],
        "chest": [cx, 79],
        "feet": [[21 + SHIFT, FEET_CUT_ROW], [2 * AXIS - 21 + SHIFT, FEET_CUT_ROW]],
        "seatY": int(STAND["cy"]),
    }

    palette = {str(i): "#%02x%02x%02x" % tuple(int(v) for v in c) for i, c in enumerate(pal)}
    palette["o"] = "#07080d"

    lines = [
        "// 生成元: tools/build_sprite.py  (body / stand の文字グリッドは手で直してもよい)",
        "// '.'透明  '0'-'6'グレー  'o'輪郭  'F''E''d'目(芯/赤/暗赤)  'm'額マーク",
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
        "  if (typeof module !== 'undefined' && module.exports) module.exports = SPRITE;",
        "  else root.KOUDAIOH_SPRITE = SPRITE;",
        "})(typeof self !== 'undefined' ? self : this);",
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
    ap.add_argument("--sym", choices=("avg", "left", "right"), default="avg")
    a = ap.parse_args()
    build(a.src, a.src_off, a.out, a.sym)


if __name__ == "__main__":
    main()
