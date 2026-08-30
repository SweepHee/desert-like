"""캠페인 15의 유기적인 금광 고원 배경과 통행 마스크를 굽는다.

goldmine_organic_base.png는 13라운드의 굽은 숲길 구성과 15라운드의 금광
지형을 참조해 만든 무건물 원화다. 완성.png를 복사하지 않는다. 최종 배경에는
15라운드·신15라운드 오브젝트를 섞고, 원화의 길과 같은 연결망을 마스크로 굽는다.
"""
from collections import deque
from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'packages/client/tools/goldmine_organic_base.png'
MAP_OUT = ROOT / 'packages/client/public/assets/maps/goldmine.png'
NEXUS_OUT = ROOT / 'packages/client/public/assets/units/nexus_goldkeep.png'
MASK_OUT = ROOT / 'packages/client/tools/goldmine_mask.txt'

LEN_T, HALF_T, CPT = 120, 27, 2
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT
OUT_W, OUT_H = 2880, 1296
MINES = [(34, -18), (65, -18), (98, -17),
         (36, 15), (68, 15), (113, 2)]
LANDMARKS = [(4, 1), (118, 1), (61, 0), *MINES]

# 원화 위 길의 중심선. 직선 격자가 아니라 굴곡의 샘플점이며, 색상 판독이
# 다리 그림자에서 끊겨도 통행 연결이 유지되게 하는 안전 골격이다.
ROUTES = [
    [(4, 1), (9, -5), (16, -10), (24, -8), (29, -13), (34, -18)],
    [(4, 1), (12, 5), (20, 8), (28, 9), (32, 13), (36, 15)],
    # 북서와 북중 사이의 원화 속 옛길은 무너진 폐광 구간이다. 통행망에는 넣지
    # 않고 아래의 바위 소품으로 막는다 — 남중으로 갈 때 남서를 타는 이유다.
    [(34, -18), (28, -9), (24, -2), (28, 6), (36, 15)],
    [(36, 15), (46, 13), (55, 18), (62, 17), (68, 15)],
    # 중앙 폐광 우회로 — 북중↔남중의 가장 짧은 세로 통로
    [(65, -18), (62, -10), (56, -5), (54, 1), (59, 7), (62, 12), (68, 15)],
    [(65, -18), (73, -12), (81, -10), (87, -3), (91, -10), (98, -17)],
    [(68, 15), (77, 9), (87, 8), (96, 5), (105, 8), (113, 2)],
    [(98, -17), (104, -11), (106, -4), (110, -1), (113, 2)],
    [(113, 2), (118, 1)],
]


def source_dirs():
    old = new = None
    for directory in ROOT.iterdir():
        if not directory.is_dir():
            continue
        sizes = {}
        for path in directory.glob('*.png'):
            try:
                sizes[path] = Image.open(path).size
            except OSError:
                pass
        if any(p.name.startswith('Wang') and s == (1254, 1254) for p, s in sizes.items()) \
                and sum(s == (1254, 1254) for s in sizes.values()) >= 2 \
                and (1448, 1086) in sizes.values():
            old = directory
        if (1916, 821) in sizes.values() and (1672, 941) in sizes.values():
            new = directory
    if old is None or new is None:
        raise FileNotFoundError('15라운드 원본 폴더를 찾지 못했습니다.')
    return old, new


def image_of(directory, size, alpha=None):
    for path in directory.glob('*.png'):
        im = Image.open(path)
        if im.size == size and (alpha is None or ('A' in im.mode) == alpha):
            return im.convert('RGBA')
    raise FileNotFoundError(f'{directory}: {size} 원본을 찾지 못했습니다.')


def alpha_parts(sheet, min_px=900):
    w, h = sheet.size
    alpha, seen, parts = sheet.getchannel('A').load(), bytearray(w * h), []
    for y0 in range(h):
        for x0 in range(w):
            if seen[y0 * w + x0] or alpha[x0, y0] < 24:
                continue
            q, cells = deque([(x0, y0)]), []
            seen[y0 * w + x0] = 1
            while q:
                x, y = q.popleft(); cells.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and alpha[nx, ny] >= 24:
                        seen[ny * w + nx] = 1; q.append((nx, ny))
            if len(cells) >= min_px:
                xs, ys = [p[0] for p in cells], [p[1] for p in cells]
                parts.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
    parts.sort(key=lambda p: (p[1] // 40, p[0]))
    return [sheet.crop(box) for box in parts]


def extract_opaque(sheet, box):
    im = sheet.crop(box).convert('RGBA')
    pix, alpha = im.load(), Image.new('L', im.size)
    ap = alpha.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, _ = pix[x, y]
            warm = max(0, r - b) + max(0, r - g)
            ap[x, y] = max(0, min(255, max(warm * 12 - 18, (max(r, g, b) - 42) * 5)))
    alpha = alpha.filter(ImageFilter.GaussianBlur(.7)); im.putalpha(alpha)
    bbox = alpha.getbbox()
    return im.crop(bbox) if bbox else im


def at_px(x_tile, y_tile):
    return round(x_tile / LEN_T * OUT_W), round((y_tile + HALF_T) / (HALF_T * 2) * OUT_H)


def place(bg, obj, x_tile, y_tile, scale=1.0, y_lift=0):
    obj = obj.resize((round(obj.width * scale), round(obj.height * scale)), Image.Resampling.LANCZOS)
    x, y = at_px(x_tile, y_tile)
    bg.alpha_composite(obj, (round(x - obj.width / 2), round(y - obj.height + y_lift)))


def decorate(bg, old_sheet, new_sheet):
    old = alpha_parts(old_sheet)
    place(bg, old[1], 118, 1, .78, 28)
    new_mines = [extract_opaque(new_sheet, box) for box in
                 ((610, 35, 835, 305), (810, 30, 1055, 310), (1015, 25, 1270, 310))]
    mines = [(old[8], .62), (new_mines[0], .82), (old[9], .62),
             (new_mines[1], .82), (old[10], .62), (new_mines[2], .82)]
    for (x, y), (obj, scale) in zip(MINES, mines):
        place(bg, obj, x, y, scale, 34)
    # Wang/특수타일 시트에서 가져온 오브젝트와 구형 소품을 능선에 흩뿌려
    # 원화와 실제 제공 재료가 한 화면 안에서 자연스럽게 이어지게 한다.
    for obj, x, y, scale in [(old[2], 18, -20, .35), (old[2], 50, -22, .46),
                              (old[40], 47, 23, .48),
                              (old[49], 82, 20, .52), (old[2], 103, -24, .32)]:
        place(bg, obj, x, y, scale)


def grid_xy(x, y):
    return round(x * CPT), round((y + HALF_T) * CPT)


def smooth_route(points, samples=10):
    """Catmull–Rom 보간으로 꺾은점 사이를 자연스러운 곡선으로 잇는다."""
    out = []
    padded = [points[0], *points, points[-1]]
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1:i + 3]
        for n in range(samples):
            t = n / samples; t2 = t * t; t3 = t2 * t
            x = .5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t
                      + (2*p0[0] - 5*p1[0] + 4*p2[0] - p3[0]) * t2
                      + (-p0[0] + 3*p1[0] - 3*p2[0] + p3[0]) * t3)
            y = .5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
                      + (2*p0[1] - 5*p1[1] + 4*p2[1] - p3[1]) * t2
                      + (-p0[1] + 3*p1[1] - 3*p2[1] + p3[1]) * t3)
            out.append(grid_xy(x, y))
    out.append(grid_xy(*points[-1]))
    return out


def terrain_mask(_base):
    """원화와 같은 굴곡을 갖는 6~8타일 폭의 명시적 통행망."""
    grid = Image.new('L', (ROWS, COLS), 0)
    draw = ImageDraw.Draw(grid)
    for route in ROUTES:
        draw.line(smooth_route(route), fill=255, width=13, joint='curve')
    for x, y in LANDMARKS:
        gx, gy = grid_xy(x, y)
        rad = 11 if (x, y) in MINES else 9
        draw.ellipse((gx - rad, gy - rad, gx + rad, gy + rad), fill=255)
    return grid


def main():
    old_dir, new_dir = source_dirs()
    base = Image.open(BASE).convert('RGBA').resize((OUT_W, OUT_H), Image.Resampling.LANCZOS)
    mask_im = terrain_mask(base)
    bg = base.copy()
    old_objects, new_objects = image_of(old_dir, (1448, 1086), True), image_of(new_dir, (1672, 941))
    decorate(bg, old_objects, new_objects)
    MAP_OUT.parent.mkdir(parents=True, exist_ok=True)
    bg.convert('RGB').save(MAP_OUT, quality=94)
    blue_keep = extract_opaque(new_objects, (0, 0, 320, 320))
    NEXUS_OUT.parent.mkdir(parents=True, exist_ok=True); blue_keep.save(NEXUS_OUT)
    px = mask_im.load()
    data = ''.join('.' if px[r, c] else '#' for r in range(ROWS) for c in range(COLS))
    MASK_OUT.write_text(data, encoding='utf-8')
    print(f'background {OUT_W}x{OUT_H}; world {LEN_T}x{HALF_T * 2} tiles')
    print(f'mask {ROWS}x{COLS}: {data.count(".")}/{len(data)} walkable')


if __name__ == '__main__':
    main()
