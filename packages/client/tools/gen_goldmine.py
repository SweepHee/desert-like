"""캠페인 15 새 금광 고원 배경/마스크 생성기.

완성.png는 배치 참고용일 뿐 읽지 않는다. 지형.png와 오브젝트.png만 합성한다.
실행: python packages/client/tools/gen_goldmine.py
"""
from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / '신15라운드'
MAP_OUT = ROOT / 'packages/client/public/assets/maps/goldmine.png'
NEXUS_OUT = ROOT / 'packages/client/public/assets/units/nexus_goldkeep.png'
MASK_OUT = ROOT / 'packages/client/tools/goldmine_mask.txt'
LEN_T, HALF_T, CPT = 74, 16, 2
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT

BLUE_KEEP = (0, 0, 320, 320)
RED_KEEP = (310, 0, 620, 320)
MINES = [(610, 35, 835, 305), (810, 30, 1055, 310), (1015, 25, 1270, 310),
         (1235, 25, 1480, 310), (1440, 25, 1672, 310)]
PLACEMENTS = [
    (RED_KEEP, 1772, 527, 1.0),
    (MINES[0], 397, 276, .82), (MINES[1], 956, 280, .82),
    (MINES[2], 1472, 279, .82), (MINES[3], 423, 724, .82),
    (MINES[4], 966, 720, .82), (MINES[1], 1480, 721, .82),
]
LANDMARKS = [(5.2, 0), (68.4, 0), (15.3, -9.2), (36.9, -8.9),
             (56.8, -9), (16.3, 8.8), (37.3, 8.6), (57.1, 8.7), (36.9, 0)]


def extract(sheet, box):
    """불투명 콘셉트 시트에서 따뜻한 물체만 남기고 무채색 바탕을 지운다."""
    im = sheet.crop(box).convert('RGBA')
    pix = im.load(); alpha = Image.new('L', im.size); ap = alpha.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, _ = pix[x, y]
            warm, light = max(0, r - b) + max(0, r - g), max(r, g, b)
            ap[x, y] = max(0, min(255, max(warm * 12 - 18, (light - 42) * 5)))
    alpha = alpha.filter(ImageFilter.GaussianBlur(.7)); im.putalpha(alpha)
    bbox = alpha.getbbox()
    return im.crop(bbox) if bbox else im


def terrain_mask(im):
    """따뜻한 흙길/광산 터는 길, 차갑고 어두운 능선은 벽으로 분류한다."""
    blur = im.convert('L').filter(ImageFilter.GaussianBlur(55))
    px, bp = im.load(), blur.load(); grid = [[False] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        for c in range(COLS):
            x = min(im.width - 1, int((r + .5) * im.width / ROWS))
            y = min(im.height - 1, int((c + .5) * im.height / COLS))
            rr, gg, bb = px[x, y][:3]; base = max(10, bp[x, y])
            grid[r][c] = (rr - bb) * 48 / base > 12 and (rr + gg + bb) / 3 * 48 / base > 38
    # 성·광산·중앙 집결지는 충분히 넓은 통행 원으로 보장한다.
    for xt, yt in LANDMARKS:
        rr, cc = int(xt / LEN_T * ROWS), int((yt + HALF_T) / (HALF_T * 2) * COLS)
        rad = 8 if xt in (5.2, 68.4) else 6
        for dr in range(-rad, rad + 1):
            for dc in range(-rad, rad + 1):
                if dr * dr + dc * dc <= rad * rad and 0 <= rr + dr < ROWS and 0 <= cc + dc < COLS:
                    grid[rr + dr][cc + dc] = True
    return grid


def largest_island(grid):
    seen, best = set(), []
    for r0 in range(ROWS):
        for c0 in range(COLS):
            if not grid[r0][c0] or (r0, c0) in seen: continue
            q, cur = deque([(r0, c0)]), []; seen.add((r0, c0))
            while q:
                r, c = q.popleft(); cur.append((r, c))
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    p = (r + dr, c + dc)
                    if 0 <= p[0] < ROWS and 0 <= p[1] < COLS and grid[p[0]][p[1]] and p not in seen:
                        seen.add(p); q.append(p)
            if len(cur) > len(best): best = cur
    return set(best)


def main():
    terrain = Image.open(SRC / '지형.png').convert('RGBA')
    sheet = Image.open(SRC / '오브젝트.png').convert('RGBA'); bg = terrain.copy()
    for box, foot_x, foot_y, scale in PLACEMENTS:
        obj = extract(sheet, box)
        obj = obj.resize((round(obj.width * scale), round(obj.height * scale)), Image.Resampling.LANCZOS)
        bg.alpha_composite(obj, (round(foot_x - obj.width / 2), round(foot_y - obj.height)))
    MAP_OUT.parent.mkdir(parents=True, exist_ok=True); bg.convert('RGB').save(MAP_OUT)
    keep = extract(sheet, BLUE_KEEP); NEXUS_OUT.parent.mkdir(parents=True, exist_ok=True); keep.save(NEXUS_OUT)
    grid = terrain_mask(terrain); island = largest_island(grid)
    data = ''.join('.' if grid[r][c] and (r, c) in island else '#'
                   for r in range(ROWS) for c in range(COLS))
    MASK_OUT.write_text(data, encoding='utf-8')
    print(f'background {terrain.width}x{terrain.height}; nexus {keep.width}x{keep.height}')
    print(f'mask {ROWS}x{COLS}: {data.count(".")}/{len(data)} walkable')


if __name__ == '__main__':
    main()
