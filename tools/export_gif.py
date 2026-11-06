#!/usr/bin/env python3
"""tools/render_frames.js でフレームを書き出し、プレビュー GIF と一覧画像を作る。

  python3 tools/export_gif.py [--out docs/preview] [--scale 4] [--fps 5] [scenario ...]

出力:
  <out>/<scenario>.gif        5fps のループ GIF
  <out>/<scenario>_sheet.png  全フレームを横に並べた一覧 (コマ割りの確認用)
"""
from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios", nargs="*")
    ap.add_argument("--out", type=Path, default=ROOT / "docs/preview")
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("--fps", type=float, default=5)
    ap.add_argument("--sheet-scale", type=int, default=2)
    a = ap.parse_args()

    a.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["node", str(ROOT / "tools/render_frames.js"), tmp, *a.scenarios], check=True)
        for d in sorted(Path(tmp).iterdir()):
            frames = [Image.open(p).convert("RGB") for p in sorted(d.glob("*.ppm"))]
            big = [f.resize((f.width * a.scale, f.height * a.scale), Image.NEAREST) for f in frames]
            gif = a.out / f"{d.name}.gif"
            big[0].save(gif, save_all=True, append_images=big[1:], duration=int(1000 / a.fps), loop=0,
                        optimize=False, disposal=1)
            s = a.sheet_scale
            w, h = frames[0].width * s, frames[0].height * s
            sheet = Image.new("RGB", (len(frames) * (w + 2), h), (60, 0, 60))
            for i, f in enumerate(frames):
                sheet.paste(f.resize((w, h), Image.NEAREST), (i * (w + 2), 0))
            sheet.save(a.out / f"{d.name}_sheet.png")
            print(f"wrote {gif} ({len(frames)} frames)")


if __name__ == "__main__":
    main()
