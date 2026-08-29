"""
「에메랄드 숲의 값」(캠페인 15) 지형 파이프라인 — 금광 고원.

작가가 준 15라운드/ 를 게임 에셋으로 굽는다. **완성.png 는 참고만 하고 쓰지 않는다** —
지형.png 위에 오브젝트.png 에서 오려낸 조각을 우리가 직접 얹어 배경을 만든다.
그래야 갱 소유 표시(깃발)를 배경에서 떼어 스프라이트로 얹을 수 있다.

  지형.png + 오브젝트 조각 -> assets/maps/goldmine.png  (MapDef.bgImage)
  지형.png                 -> 통행 마스크               (data.ts MASK_GOLDMINE)
  깃발 조각                -> assets/tiles/gm_flag_*.png (소유 표시 — 렌더러가 얹는다)

배경에 굽는 것: 양쪽 넥서스 + 중립 갱구 6 + 자잘한 금광석·수레.
배경에 굽지 않는 것: 갱 소유 깃발 (경기 중에 바뀐다).

공터 중심은 손으로 찍지 않고 「벽에서 가장 먼 점」으로 찾는다 — 작가가 그림을
조금 손봐도 좌표가 따라간다.

실행: python packages/client/tools/gen_goldmine.py
"""
import os
from collections import deque

from PIL import Image, ImageFilter

SRC_TERRAIN = '15라운드/지형.png'
OBJ = 'packages/client/tools/objdump/goldmine'
MAPS = 'packages/client/public/assets/maps'
TILES = 'packages/client/public/assets/tiles'
OUT_MASK = 'packages/client/tools/goldmine_mask.txt'

LEN_T, HALF_T = 56, 21           # MapDef 와 반드시 같아야 한다 (1448x1086 = 56x42 타일)
CPT = 2
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT   # 112 x 84

# 공터를 찾을 대략적인 구역 (x0, y0, x1, y1 — 화면 비율). 이 안에서 가장 넓은 곳을 잡는다.
REGIONS = [
    ('base_ally', 0.00, 0.32, 0.20, 0.72),
    ('base_foe', 0.80, 0.32, 1.00, 0.72),
    ('mine_tl', 0.19, 0.14, 0.37, 0.40),
    ('mine_tc', 0.41, 0.14, 0.59, 0.40),
    ('mine_tr', 0.63, 0.14, 0.81, 0.40),
    ('mine_bl', 0.19, 0.60, 0.37, 0.88),
    ('mine_bc', 0.41, 0.60, 0.59, 0.88),
    ('mine_br', 0.63, 0.60, 0.81, 0.88),
    ('cross', 0.44, 0.44, 0.56, 0.58),
]

# 배경에 구울 오브젝트: (조각, 어느 구역에, 발밑 기준 y 보정, 크기 배율)
PLACE = [
    # 아군 요새는 배경에 굽지 않는다 — 넥서스 엔티티(nexus_goldkeep)로 세워야
    # 부술 수 있고 체력바도 붙는다. 적 요새는 못 치는 그림이라 그대로 굽는다.
    ('gm_01.png', 'base_foe', 0.30, 0.43),
    ('gm_09.png', 'mine_tl', 0.28, 0.85),
    ('gm_09.png', 'mine_tc', 0.28, 0.85),
    ('gm_09.png', 'mine_tr', 0.28, 0.85),
    ('gm_09.png', 'mine_bl', 0.28, 0.85),
    ('gm_09.png', 'mine_bc', 0.28, 0.85),
    ('gm_09.png', 'mine_br', 0.28, 0.85),
]

# 소유 깃발 — 배경에 굽지 않고 따로 떨궈 렌더러가 갱 위에 얹는다
FLAGS = [('gm_28.png', 'gm_flag_ally.png'), ('gm_29.png', 'gm_flag_foe.png')]


def sand_mask(im):
    """모래길 = 따뜻하고 밝다. 비네팅은 크게 흐린 밝기로 나눠 걷어낸다."""
    W, H = im.size
    blur = im.convert('L').filter(ImageFilter.GaussianBlur(70))
    px, bp = im.load(), blur.load()
    grid = [[False] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        for c in range(COLS):
            x = min(W - 1, int((r + 0.5) * W / ROWS))
            y = min(H - 1, int((c + 0.5) * H / COLS))
            rr, gg, bb = px[x, y][:3]
            base = max(8, bp[x, y])
            warm = (rr - bb) * 40 / base
            lum = (rr + gg + bb) / 3 * 40 / base
            grid[r][c] = warm > 16 and lum > 42
    return grid


def wall_dist(grid):
    """각 통행 칸이 벽에서 몇 칸 떨어졌나 (BFS)."""
    d = [[-1] * COLS for _ in range(ROWS)]
    q = deque()
    for r in range(ROWS):
        for c in range(COLS):
            if not grid[r][c]:
                d[r][c] = 0
                q.append((r, c))
    while q:
        r, c = q.popleft()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < ROWS and 0 <= nc < COLS and d[nr][nc] < 0:
                d[nr][nc] = d[r][c] + 1
                q.append((nr, nc))
    return d


def centers(grid):
    """
    구역마다 공터 한복판.

    「벽에서 가장 먼 칸」 하나만 쓰면 길게 뻗은 공터에서 한쪽으로 치우친다
    (요새를 절반으로 줄이자 공터 밖 바위에 얹혀 보였다). 벽에서 먼 정도를
    제곱해 가중치로 준 무게중심을 쓰면 둥근 공터의 눈에 보이는 가운데에 앉는다.
    """
    d = wall_dist(grid)
    out = {}
    for name, fx0, fy0, fx1, fy1 in REGIONS:
        sw = sr = sc = 0.0
        best = 0
        for r in range(int(fx0 * ROWS), min(ROWS, int(fx1 * ROWS) + 1)):
            for c in range(int(fy0 * COLS), min(COLS, int(fy1 * COLS) + 1)):
                w = d[r][c]
                if w <= 1:
                    continue
                best = max(best, w)
                w = w * w
                sw += w
                sr += w * (r + 0.5)
                sc += w * (c + 0.5)
        if sw == 0:
            out[name] = ((fx0 + fx1) / 2, (fy0 + fy1) / 2, 0)
        else:
            out[name] = (sr / sw / ROWS, sc / sw / COLS, best)
    return out


def largest_island(grid):
    seen = [[False] * COLS for _ in range(ROWS)]
    best = []
    for r0 in range(ROWS):
        for c0 in range(COLS):
            if not grid[r0][c0] or seen[r0][c0]:
                continue
            q, cur = deque([(r0, c0)]), []
            seen[r0][c0] = True
            while q:
                r, c = q.popleft()
                cur.append((r, c))
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < ROWS and 0 <= nc < COLS and not seen[nr][nc] and grid[nr][nc]:
                        seen[nr][nc] = True
                        q.append((nr, nc))
            if len(cur) > len(best):
                best = cur
    return set(best)


def main():
    os.makedirs(MAPS, exist_ok=True)
    os.makedirs(TILES, exist_ok=True)
    terrain = Image.open(SRC_TERRAIN).convert('RGBA')
    W, H = terrain.size

    grid = sand_mask(terrain)
    ctr = centers(grid)

    # ── 배경 합성 ──
    bg = terrain.copy()
    for piece, region, foot, scale in PLACE:
        obj = Image.open(os.path.join(OBJ, piece)).convert('RGBA')
        if scale != 1.0:
            obj = obj.resize((int(obj.width * scale), int(obj.height * scale)), Image.LANCZOS)
        fx, fy, _ = ctr[region]
        cx, cy = int(fx * W), int(fy * H)
        # 발밑이 공터 중심에 오도록: 가로 가운데, 세로는 아래에서 foot 만큼 올린 지점
        x = cx - obj.width // 2
        y = cy - int(obj.height * (1 - foot))
        bg.alpha_composite(obj, (max(0, x), max(0, y)))
    bg.convert('RGB').save(os.path.join(MAPS, 'goldmine.png'))

    # ── 소유 깃발 ──
    for piece, out_name in FLAGS:
        Image.open(os.path.join(OBJ, piece)).convert('RGBA').save(os.path.join(TILES, out_name))

    # ── 통행 마스크 ──
    island = largest_island(grid)
    cells = [['#'] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        for c in range(COLS):
            if grid[r][c] and (r, c) in island:
                cells[r][c] = '.'
    walk = sum(row.count('.') for row in cells)
    print(f'통행 칸 {walk} / {ROWS * COLS} ({walk * 100 // (ROWS * COLS)}%)')
    print()
    print('구역          x타일   y타일   여유(칸)')
    for name, _, _, _, _ in REGIONS:
        fx, fy, rad = ctr[name]
        xt = fx * LEN_T
        yt = (fy - 0.5) * HALF_T * 2
        ok = cells[int(fx * ROWS)][int(fy * COLS)] == '.'
        print(f'  {name:11} {xt:6.1f} {yt:+7.1f} {rad:6}  {"연결" if ok else "고립!"}')

    with open(OUT_MASK, 'w', encoding='utf-8') as f:
        f.write(''.join(''.join(row) for row in cells))
    print('\n마스크 저장:', OUT_MASK)
    print('배경 저장:', os.path.join(MAPS, 'goldmine.png'))


if __name__ == '__main__':
    main()
