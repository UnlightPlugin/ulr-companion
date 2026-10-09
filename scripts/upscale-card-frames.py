"""把內建空框 168x240 用 AI 放大成 336x480
==========================================
接在 scripts/extract-card-frames.ts 後面跑（那支檔頭有完整流程）：

    pip install spandrel torch pillow scipy
    python scripts/upscale-card-frames.py realesr-animevideov3.pth

模型：Real-ESRGAN 的 realesr-animevideov3（2.5 MB），
https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth

2026-09-17 比過三種：bigjpg（網頁）、RealESRGAN_x4plus_anime_6B、animevideov3。
anime_6B 把頂端的菱形花紋抹平了；animevideov3 跟 bigjpg 幾乎一樣，花紋、R 徽章、
HP/ATK/DEF 字都留著，而且能在本機跑。

- RGB 跟 alpha 分開放大。透明像素的 RGB 是黑的，直接放大黑色會滲進邊緣，
  所以先用最近的不透明顏色往外填。
- 模型是 4 倍，放大完用 Lanczos 縮成 2 倍（比直接 2 倍乾淨）。
- 原圖完全不透明／完全透明的區域，放大後 alpha 直接定成 255／0 ——
  模型在直線邊緣會留一點點雜訊，疊在玩家的圖上會看得出來。
- 用 CPU 跑：一張 168x240 不到一秒，而 torch 的 CUDA 版不一定支援新顯卡。
"""

import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy import ndimage
from spandrel import ModelLoader

if len(sys.argv) not in (2, 3):
    sys.exit("用法：python scripts/upscale-card-frames.py <realesr-animevideov3.pth> [檔名開頭，例如 R]")
prefix = sys.argv[2] if len(sys.argv) == 3 else ""

root = Path(__file__).resolve().parent.parent / "apps" / "tray" / "assets" / "card-frames"
src, dst = root / "168x240", root / "336x480"
dst.mkdir(parents=True, exist_ok=True)
model = ModelLoader().load_from_file(sys.argv[1]).eval()


def run(rgb: np.ndarray) -> np.ndarray:
    t = torch.from_numpy(rgb.astype(np.float32) / 255).permute(2, 0, 1)[None]
    with torch.no_grad():
        y = model(t)
    return y[0].permute(1, 2, 0).clamp(0, 1).numpy() * 255


def bleed(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    known = alpha > 0
    if known.all() or not known.any():
        return rgb
    _, (iy, ix) = ndimage.distance_transform_edt(~known, return_indices=True)
    return rgb[iy, ix]


def u8(a: np.ndarray) -> np.ndarray:
    return a.round().clip(0, 255).astype(np.uint8)


for p in sorted(src.glob(f"{prefix}*.png")):
    img = np.array(Image.open(p).convert("RGBA"))
    h, w = img.shape[:2]
    size = (w * 2, h * 2)
    rgb, a = img[..., :3], img[..., 3]
    big_rgb = run(bleed(rgb, a))
    big_a = run(np.repeat(a[..., None], 3, axis=2)).mean(axis=2)
    r = np.array(Image.fromarray(u8(big_rgb)).resize(size, Image.LANCZOS))
    al = np.array(Image.fromarray(u8(big_a)).resize(size, Image.LANCZOS))
    near = np.array(Image.fromarray(a).resize(size, Image.NEAREST))
    al[ndimage.binary_erosion(near == 255, iterations=2)] = 255
    al[ndimage.binary_erosion(near == 0, iterations=2)] = 0
    r[al == 0] = 0  # 透明處的填色只是給模型看的，留著檔案大 6 倍
    Image.fromarray(np.dstack([r, al])).save(dst / p.name, optimize=True)
    print(f"{p.name} -> {size[0]}x{size[1]}")
