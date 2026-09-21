"""一次性脚本:由 favicon 的四叶草造型导出 PWA 图标(192/512/maskable/Apple touch)。
用 PIL 手工绘制并按 4 倍超采样缩回,不引入新依赖。产物入库,脚本本身不入依赖。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)

SS = 4  # 超采样倍数
PETAL_A = (53, 164, 101, 255)   # #35a465
PETAL_B = (91, 188, 130, 255)   # #5bbc82
STEM = (38, 133, 82, 255)       # #268552
CORE = (31, 106, 68, 255)       # #1f6a44
CREAM = (250, 246, 232, 255)    # #faf6e8


def draw_clover(img, size, cx, cy, scale, core=True):
    d = ImageDraw.Draw(img)
    r = size * 0.155 * scale
    d_off = size * 0.20 * scale
    # 草茎:沿二次贝塞尔撒圆点,从中心下方弯向右下
    import math
    p0 = (cx - size * 0.03 * scale, cy + size * 0.24 * scale)
    p1 = (cx + size * 0.02 * scale, cy + size * 0.42 * scale)
    p2 = (cx + size * 0.16 * scale, cy + size * 0.52 * scale)
    steps = 80
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
        rad = size * 0.035 * scale * (1.15 - 0.35 * t)
        d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=STEM)
    # 四片叶子:十字排布,双色交替
    for i, (dx, dy) in enumerate([(0, -1), (1, 0), (0, 1), (-1, 0)]):
        x = cx + dx * d_off
        y = cy + dy * d_off
        d.ellipse([x - r, y - r, x + r, y + r], fill=PETAL_A if i % 2 == 0 else PETAL_B)
    if core:
        rc = size * 0.045 * scale
        d.ellipse([cx - rc, cy - rc, cx + rc, cy + rc], fill=CORE)


def make(size, scale=1.0, background=None):
    big = size * SS
    img = Image.new('RGBA', (big, big), background or (0, 0, 0, 0))
    draw_clover(img, big, big / 2, big * 0.44, scale)
    return img.resize((size, size), Image.LANCZOS)


make(192).save(os.path.join(OUT, 'icon-192.png'))
make(512).save(os.path.join(OUT, 'icon-512.png'))
# maskable:安全区留白,底必须是实色
make(512, scale=0.72, background=CREAM).save(os.path.join(OUT, 'icon-maskable-512.png'))
# Apple touch:iOS 不支持透明,统一奶油底
make(180, scale=0.86, background=CREAM).save(os.path.join(OUT, 'apple-touch-icon-180.png'))
print('icons written to', os.path.abspath(OUT))
