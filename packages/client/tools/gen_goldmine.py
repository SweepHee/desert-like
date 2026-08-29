"""
「에메랄드 숲의 값」(캠페인 15) 지형 파이프라인 — 금광 고원.

작가가 준 15라운드/ 를 게임 에셋으로 굽는다.

  완성.png -> assets/maps/goldmine.png   (배경 한 장 — MapDef.bgImage)
           -> 통행 마스크                (data.ts MASK_GOLDMINE)

Wang타일.png 는 쓰지 않는다 — 6라운드와 같은 이유(엣지형 ↔ 코너형 규약 불일치).
이미 배치까지 끝난 완성.png 를 통째로 배경으로 깐다.

통행 판정: 길·광산 바닥은 따뜻한 황토(r>b)이고, 바위 능선은 차가운 회청색이다.
원본 비네팅이 세서 가장자리 길이 까맣게 죽으므로, 크게 흐린 복사본으로 밝기를
나눠 비네팅을 걷어낸 뒤 색조로 가른다 (gen_village.py 와 같은 방식).

실행: python packages/client/tools/gen_goldmine.py
"""
import os
import shutil
from collections import deque

from PIL import Image, ImageFilter

SRC = '15라운드/완성.png'
MAPS = 'packages/client/public/assets/maps'
OUT_MASK = 'packages/client/tools/goldmine_mask.txt'

LEN_T, HALF_T = 56, 21           # MapDef 와 반드시 같아야 한다
CPT = 2                          # 타일당 격자 칸
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT   # 112 x 84

# 화면 비율(0~1) 로 잰 자리 — (가로 x, 세로 y)
CAMP_ALLY = (0.095, 0.42)
CAMP_FOE = (0.875, 0.42)
MINES = [
    ('1시 갱', 0.300, 0.215),
    ('12시 갱', 0.515, 0.345),
    ('11시 갱', 0.715, 0.205),
    ('7시 갱', 0.280, 0.700),
    ('6시 갱', 0.500, 0.605),
    ('5시 갱', 0.745, 0.680),
]


def unvignette(im):
    return im.convert('L').filter(ImageFilter.GaussianBlur(70))


def build_mask(im):
    W, H = im.size
    blur = unvignette(im)
    px, bp = im.load(), blur.load()
    grid = [['#'] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        for c in range(COLS):
            x = min(W - 1, int((r + 0.5) * W / ROWS))
            y = min(H - 1, int((c + 0.5) * H / COLS))
            rr, gg, bb = px[x, y][:3]
            base = max(8, bp[x, y])
            warm = (rr - bb) * 40 / base
            lum = (rr + gg + bb) / 3 * 40 / base
            if warm > 18 and lum > 42:
                grid[r][c] = '.'
    return grid


def carve_disc(grid, fx, fy, tiles_r):
    cr, cc = fx * ROWS, fy * COLS
    rad = tiles_r * CPT
    for r in range(max(0, int(cr - rad)), min(ROWS, int(cr + rad) + 1)):
        for c in range(max(0, int(cc - rad)), min(COLS, int(cc + rad) + 1)):
            if (r - cr) ** 2 + (c - cc) ** 2 <= rad * rad:
                grid[r][c] = '.'


def carve_line(grid, a, b, tiles_r):
    """두 지점을 잇는 통로를 강제로 뚫는다 (섬이 생기면 이걸로 잇는다)."""
    steps = 400
    for i in range(steps + 1):
        t = i / steps
        carve_disc(grid, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, tiles_r)


def largest_island(grid):
    seen = [[False] * COLS for _ in range(ROWS)]
    best = []
    for r0 in range(ROWS):
        for c0 in range(COLS):
            if grid[r0][c0] != '.' or seen[r0][c0]:
                continue
            q, cur = deque([(r0, c0)]), []
            seen[r0][c0] = True
            while q:
                r, c = q.popleft()
                cur.append((r, c))
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < ROWS and 0 <= nc < COLS and not seen[nr][nc] and grid[nr][nc] == '.':
                        seen[nr][nc] = True
                        q.append((nr, nc))
            if len(cur) > len(best):
                best = cur
    return best


def main():
    im = Image.open(SRC).convert('RGB')
    os.makedirs(MAPS, exist_ok=True)
    shutil.copyfile(SRC, os.path.join(MAPS, 'goldmine.png'))

    grid = build_mask(im)
    # 진영과 갱구는 반드시 밟혀야 한다 — 못 닿으면 점령도 파괴도 못 한다
    carve_disc(grid, *CAMP_ALLY, 3.0)
    carve_disc(grid, *CAMP_FOE, 3.0)
    for _, fx, fy in MINES:
        carve_disc(grid, fx, fy, 2.2)

    island = set(largest_island(grid))
    # 큰 섬에 못 붙은 갱은 길을 뚫어 잇는다
    hub = (0.5, 0.47)
    for name, fx, fy in MINES:
        rc = (int(fx * ROWS), int(fy * COLS))
        if rc not in island:
            carve_line(grid, (fx, fy), hub, 1.0)
    for camp in (CAMP_ALLY, CAMP_FOE):
        rc = (int(camp[0] * ROWS), int(camp[1] * COLS))
        if rc not in island:
            carve_line(grid, camp, hub, 1.2)

    island = set(largest_island(grid))
    for r in range(ROWS):
        for c in range(COLS):
            if grid[r][c] == '.' and (r, c) not in island:
                grid[r][c] = '#'   # 떨어진 섬은 막아 둔다 (거기 서면 못 나온다)

    walk = sum(row.count('.') for row in grid)
    print(f'통행 칸 {walk} / {ROWS * COLS} ({walk * 100 // (ROWS * COLS)}%)')
    for name, fx, fy in MINES:
        rc = (int(fx * ROWS), int(fy * COLS))
        print(f'  {name}: {"연결" if rc in island else "고립!"}  x={fx * LEN_T:.1f}타일 y={(fy - 0.5) * HALF_T * 2:+.1f}타일')
    for label, camp in (('아군 진영', CAMP_ALLY), ('적 진영', CAMP_FOE)):
        rc = (int(camp[0] * ROWS), int(camp[1] * COLS))
        print(f'  {label}: {"연결" if rc in island else "고립!"}  x={camp[0] * LEN_T:.1f}타일 y={(camp[1] - 0.5) * HALF_T * 2:+.1f}타일')

    with open(OUT_MASK, 'w', encoding='utf-8') as f:
        f.write(''.join(''.join(row) for row in grid))
    print('마스크 저장:', OUT_MASK)

    # 눈으로 보는 미리보기 (2칸을 1글자로 줄여 출력)
    print()
    for r in range(0, ROWS, 2):
        print(''.join(grid[r][c] for c in range(0, COLS, 2)))


if __name__ == '__main__':
    main()
