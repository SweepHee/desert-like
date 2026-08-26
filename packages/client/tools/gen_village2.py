"""
「자정의 마을」 2단계 — 배경 합성 + 건물 잘라내기 + 마스크 정리.

gen_village.py 가 잡아 둔 오브젝트 경계 상자를 받아,
  · 건물 4채 -> assets/tiles/vg_house_{a..d}.png  (게임 안에서 부술 수 있는 실물)
  · 나무·덤불·바위 -> 지형.png 의 숲 구역에 합성  -> assets/maps/village.png
로 나눈다. 「완성.png」를 그대로 배경으로 쓰지 않는 이유는 건물이 그림에 박혀
버리면 부서져도 계속 서 있기 때문이다 — 건물만 떼어 내고 나머지를 굽는다.

배치는 시드 난수(결정론 무관 — 굽는 시점에만 쓴다)로 흩되, 통행 가능한 칸에는
절대 심지 않는다.

실행: python packages/client/tools/gen_village2.py
"""
import os
import random
import sys
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_village as G  # noqa: E402

TILES = G.TILES
MAPS = G.MAPS

# gen_village.cut_objects() 정렬 순서 기준 인덱스
HOUSES = {'a': 0, 'b': 1, 'c': 3, 'd': 2}   # 11시 / 1시 / 7시 / 5시
BIG_TREES = [4, 5, 6, 9]
PINES = [7, 8]
BURNT = [10]
BUSHES = [12, 16, 17, 20, 23, 11, 13]
ROCKS = [32, 33, 34, 35, 31]


def largest_regions(data, min_cells=40):
    """작은 섬을 지운다 — 갇힌 칸이 있으면 유닛이 그 안에서 못 나온다."""
    grid = [list(data[r * G.COLS:(r + 1) * G.COLS]) for r in range(G.ROWS)]
    seen = [[False] * G.COLS for _ in range(G.ROWS)]
    for r in range(G.ROWS):
        for c in range(G.COLS):
            if grid[r][c] != '.' or seen[r][c]:
                continue
            stack = [(r, c)]
            seen[r][c] = True
            comp = []
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < G.ROWS and 0 <= nx < G.COLS and not seen[ny][nx] and grid[ny][nx] == '.':
                        seen[ny][nx] = True
                        stack.append((ny, nx))
            if len(comp) < min_cells:
                for y, x in comp:
                    grid[y][x] = '#'
    return grid


def main():
    im, boxes = G.cut_objects()
    crop = lambda i: im.crop(boxes[i][:4])

    for name, idx in HOUSES.items():
        c = crop(idx)
        c.save(os.path.join(TILES, f'vg_house_{name}.png'))
        print(f'vg_house_{name}.png <- obj{idx} {c.size}')

    terr = Image.open(os.path.join(G.SRC, '지형.png')).convert('RGBA')
    W, H = terr.size
    grid = largest_regions(open('packages/client/tools/village_mask.txt').read())
    walk = lambda x, y: grid[min(G.ROWS - 1, int(x * G.ROWS / W))][min(G.COLS - 1, int(y * G.COLS / H))] == '.'

    rng = random.Random(606)
    plan = []   # (y_bottom, sprite, x, y, scale)

    # 북쪽 두 진입로가 내려오는 목 — gen_village3 이 여기까지 길을 뚫으므로
    # 나무를 심어 두면 넓힌 숲길 위에 나무가 얹힌다 (부대가 나무를 밟고 지난다).
    LANE_FX = (0.215, 0.790)
    LANE_R = 3.4 * 1.3 / 56 * W      # gen_village3 의 LANE_HALF_T 와 같은 값
    LANE_DEPTH = int(H * 0.25)

    def in_lane(x, y):
        return y < LANE_DEPTH and any(abs(x - fx * W) < LANE_R for fx in LANE_FX)

    def scatter(idxs, count, lo, hi, only=None):
        tries = 0
        placed = 0
        while placed < count and tries < count * 60:
            tries += 1
            x, y = rng.randrange(W), rng.randrange(H)
            if walk(x, y) or in_lane(x, y):
                continue
            if only and not only(x, y):
                continue
            s = crop(rng.choice(idxs))
            sc = rng.uniform(lo, hi)
            plan.append((y, s, x, y, sc))
            placed += 1
        return placed

    # 불타는 숲은 위쪽 두 모서리에만 (적이 밀고 들어오는 길목)
    scatter(BURNT, 14, 0.5, 0.8, only=lambda x, y: y < H * 0.30 and (x < W * 0.32 or x > W * 0.68))
    scatter(BIG_TREES, 150, 0.55, 0.95)
    scatter(PINES, 90, 0.5, 0.85)
    scatter(BUSHES, 130, 0.5, 0.9)
    scatter(ROCKS, 70, 0.45, 0.8)

    plan.sort(key=lambda p: p[0])   # 위에 있는 것부터 — 아래 것이 위를 덮는다
    for _, s, x, y, sc in plan:
        w, h = int(s.width * sc), int(s.height * sc)
        t = s.resize((max(1, w), max(1, h)), Image.LANCZOS)
        terr.alpha_composite(t, (x - w // 2, y - h))   # 발밑 기준
    terr.convert('RGB').save(os.path.join(MAPS, 'village.png'))
    print(f'-> {MAPS}/village.png  소품 {len(plan)}개 합성')

    data = ''.join(''.join(r) for r in grid)
    with open('packages/client/tools/village_mask.txt', 'w') as f:
        f.write(data)
    print(f'마스크 정리 후 통행 {data.count(".") * 100 // len(data)}%')


if __name__ == '__main__':
    main()
