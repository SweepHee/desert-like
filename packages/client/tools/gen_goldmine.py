"""캠페인 15의 유기적인 금광 고원 배경과 통행 마스크를 굽는다.

goldmine_organic_base.png는 13라운드의 굽은 숲길 구성과 15라운드의 금광
지형을 참조해 만든 무건물 원화다. 완성.png를 복사하지 않는다. 최종 배경에는
15라운드·신15라운드 오브젝트를 섞고, 원화의 길과 같은 연결망을 마스크로 굽는다.
"""
from collections import deque
from heapq import heappop, heappush
from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'packages/client/tools/goldmine_organic_base.png'
MAP_OUT = ROOT / 'packages/client/public/assets/maps/goldmine.png'
NEXUS_OUT = ROOT / 'packages/client/public/assets/units/nexus_goldkeep.png'
MASK_OUT = ROOT / 'packages/client/tools/goldmine_mask.txt'
MASK_TS_OUT = ROOT / 'packages/sim/src/goldmine-mask.ts'

LEN_T, HALF_T, CPT = 120, 27, 2
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT
OUT_W, OUT_H = 2880, 1296
MINES = [(34, -18), (65, -18), (98, -17),
         (36, 15), (68, 15), (113, 2)]
LANDMARKS = [(4, 1), (118, 1), (52, 1), *MINES]
BRIDGES = [(29, 3), (46, -3), (52, -14), (53, 19), (86, -6), (83, 11)]

# 원화 위 길의 중심선. 직선 격자가 아니라 굴곡의 샘플점이며, 색상 판독이
# 다리 그림자에서 끊겨도 통행 연결이 유지되게 하는 안전 골격이다.
ROUTES = [
    # 서부: 기지 → 첫 다리 → 서부 갈림길 → 북서/남서 갱.
    [(4, 1), (11, 4), (20, 6), (27, 4), (29, 3),
     (34, 1), (37, -4), (38, -10), (34, -18)],
    [(4, 1), (11, 4), (20, 6), (27, 4), (29, 3),
     (34, 1), (38, 5), (42, 10), (39, 14), (36, 15)],
    # 북서→남중은 표시선대로 남서 갱과 남쪽 나무다리를 탄다.
    [(34, -18), (38, -10), (37, -4), (34, 1), (38, 5), (42, 10),
     (36, 15), (44, 16), (49, 19), (53, 19), (57, 13), (59, 7),
     (64, 10), (68, 15)],
    # 서부 갈림길→중앙 상단. 산을 직선으로 자르지 않고 실제 왼쪽 다리와 굽은 길을 돈다.
    [(34, 1), (40, -2), (46, -3), (53, -1), (58, -5), (61, -10), (65, -12)],
    # 북중→남중 중앙 폐광 우회로.
    [(65, -18), (65, -12), (61, -10), (58, -5), (60, -1),
     (57, 4), (59, 7), (64, 10), (68, 15)],
    # 북부 동쪽 길: 북중→북동.
    [(65, -18), (65, -12), (73, -10), (80, -10), (86, -6),
     (91, -11), (95, -14), (98, -17)],
    # 남부 동쪽 길: 남중→남동.
    [(68, 15), (75, 13), (83, 11), (89, 7), (97, 8), (105, 7), (113, 2)],
    # 동부: 북동→남동. 북쪽 다리와 동부 굽은 길을 따른다.
    [(98, -17), (95, -14), (91, -11), (86, -6), (92, -2),
     (99, 0), (105, 1), (113, 2)],
    [(113, 2), (118, 1)],
]

# 사용자가 표시한 통행 그래프. 각 간선의 실제 픽셀 경로는 원화의 황토길 질감을
# 비용으로 삼는 다익스트라가 찾는다. 따라서 좌표 사이를 직선으로 잘라 산을 넘지 않는다.
ROUTE_EDGES = [
    ((4, 1), (34, -18)), ((4, 1), (36, 15)),
    ((34, -18), (65, -18)), ((36, 15), (68, 15)),
    ((65, -18), (68, 15)), ((65, -18), (98, -17)),
    ((68, 15), (113, 2)), ((98, -17), (113, 2)),
    ((113, 2), (118, 1)),
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
    """사용자가 표시한 길과 원화의 다리·흙길을 직접 따라가는 통행망."""
    # 물은 절대 경로 후보가 아니다. 아래의 다리 여섯 주변만 다시 후보로 연다.
    water_src = _base.convert('RGB').resize((ROWS, COLS), Image.Resampling.BOX)
    water = Image.new('L', (ROWS, COLS), 0)
    wp, srcp = water.load(), water_src.load()
    for r in range(ROWS):
        for c in range(COLS):
            red, green, blue = srcp[r, c]
            if blue >= 18 and blue * 100 >= red * 125 and blue * 100 >= green * 108:
                wp[r, c] = 255
    water = water.filter(ImageFilter.MaxFilter(3))
    wp = water.load()
    bridge_cells = [grid_xy(x, y) for x, y in BRIDGES]

    # 길은 산보다 밝고 매끈하다. 작은 표본의 평균 밝기와 명암 분산으로 비용을
    # 만들면, 금빛 산맥과 황토길의 색이 비슷해도 경로는 자연스럽게 길을 택한다.
    sample = _base.convert('RGB').resize((ROWS * 4, COLS * 4), Image.Resampling.BOX)
    sp = sample.load()
    costs = [0] * (ROWS * COLS)
    for r in range(ROWS):
        for c in range(COLS):
            vals = []
            sr = sg = sb = 0
            for yy in range(c * 4, c * 4 + 4):
                for xx in range(r * 4, r * 4 + 4):
                    red, green, blue = sp[xx, yy]
                    sr += red; sg += green; sb += blue
                    vals.append((red * 3 + green * 5 + blue * 2) // 10)
            red, green, blue = sr // 16, sg // 16, sb // 16
            mean = sum(vals) // 16
            variance = sum((v - mean) * (v - mean) for v in vals) // 16
            dark = max(0, 72 - mean)
            rough = max(0, variance - 150)
            cool = max(0, blue * 145 - red * 100) // 20
            costs[r * COLS + c] = 8 + dark * 5 + rough // 3 + cool

    def bridge_cell(r, c):
        return any(abs(r - br) <= 2 and abs(c - bc) <= 2 for br, bc in bridge_cells)

    def shortest(a, b):
        sr, sc = grid_xy(*a); tr, tc = grid_xy(*b)
        start, goal = sr * COLS + sc, tr * COLS + tc
        dist = [10**12] * (ROWS * COLS)
        prev = [-1] * (ROWS * COLS)
        dist[start] = 0
        heap = [(0, start)]
        while heap:
            cur, idx = heappop(heap)
            if cur != dist[idx]: continue
            if idx == goal: break
            r, c = divmod(idx, COLS)
            for dr, dc, step in ((-1,0,10),(1,0,10),(0,-1,10),(0,1,10),
                                 (-1,-1,14),(-1,1,14),(1,-1,14),(1,1,14)):
                nr, nc = r + dr, c + dc
                if nr < 0 or nr >= ROWS or nc < 0 or nc >= COLS: continue
                if wp[nr, nc] and not bridge_cell(nr, nc): continue
                ni = nr * COLS + nc
                nd = cur + step * costs[ni]
                if nd < dist[ni]:
                    dist[ni] = nd; prev[ni] = idx; heappush(heap, (nd, ni))
        if prev[goal] < 0 and goal != start:
            raise RuntimeError(f'통행 경로를 찾지 못했습니다: {a} -> {b}')
        out = []
        at = goal
        while at >= 0:
            out.append(divmod(at, COLS))
            if at == start: break
            at = prev[at]
        out.reverse()
        return out

    grid = Image.new('L', (ROWS, COLS), 0)
    draw = ImageDraw.Draw(grid)
    for a, b in ROUTE_EDGES:
        # 다익스트라가 찾은 흙길 중심을 2.5타일 폭으로 연다.
        draw.line(shortest(a, b), fill=255, width=5, joint='curve')
    for x, y in LANDMARKS:
        gx, gy = grid_xy(x, y)
        rad = 7 if (x, y) in MINES else 5
        draw.ellipse((gx - rad, gy - rad, gx + rad, gy + rad), fill=255)
    # 물색 픽셀은 모두 닫는다. 다리는 아래 좌표에서만 다시 열기 때문에 배경의
    # 강을 아무 데서나 건너는 일은 없다.
    gp, wp = grid.load(), water.load()
    for r in range(ROWS):
        for c in range(COLS):
            if wp[r, c]: gp[r, c] = 0
    draw = ImageDraw.Draw(grid)
    for x, y in BRIDGES:
        gx, gy = grid_xy(x, y)
        # 물 위에서는 다리 중심의 한 타일 폭만 다시 연다. 넓은 원으로 열면
        # 다리 난간 바깥 강바닥까지 통행 가능해진다.
        draw.ellipse((gx - 2, gy - 2, gx + 2, gy + 2), fill=255)
    return grid


def main():
    old_dir, new_dir = source_dirs()
    base = Image.open(BASE).convert('RGBA').resize((OUT_W, OUT_H), Image.Resampling.LANCZOS)
    mask_im = terrain_mask(base)
    # 통행 마스크는 시뮬레이션 판정에만 사용한다. 배경 원화에 마스크를 칠하면
    # 길이 단색 띠처럼 보여 원래의 자연스러운 지형과 물길이 훼손된다.
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
    MASK_TS_OUT.write_text(
        '// gen_goldmine.py가 생성한다. 직접 수정하지 말 것.\n'
        f"export const MASK_GOLDMINE = '{data}';\n",
        encoding='utf-8',
    )
    print(f'background {OUT_W}x{OUT_H}; world {LEN_T}x{HALF_T * 2} tiles')
    print(f'mask {ROWS}x{COLS}: {data.count(".")}/{len(data)} walkable')


if __name__ == '__main__':
    main()
