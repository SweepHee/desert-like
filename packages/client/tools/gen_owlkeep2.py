"""
「올빼미 성채」(캠페인 5) 지형 파이프라인 — 절벽·언덕·계단 판.

작가가 준 5라운드수정-폴더/ 를 게임 에셋으로 굽는다.

  5라운드수정완성.png -> assets/maps/owlkeep.png  (배경 한 장 — MapDef.bgImage)
                     -> 통행 마스크              (data.ts MASK_OWLKEEP)

통행 판정
  이 그림은 「따뜻한 길·언덕」과 「푸른 숲·늪·절벽」으로 깔끔하게 갈린다.
    길 r-b +3~+7 / 언덕 상면 -5~-1 / 계단 -4   ← 다닐 수 있는 곳
    숲 -28 / 늪 -17 / 절벽면 -13               ← 막힌 곳
  덩굴 장판(-8)만 길 위에 얹혀 있어 색으로는 막힌 곳으로 보인다. 그래서
  색으로 1차 판정한 뒤 닫힘 연산(팽창→침식)으로 길 위의 작은 구멍을 메운다.
  마지막으로 두 진영이 들어 있는 연결 요소만 남겨 숲 속 잡티를 버린다.

좌표 규약 (render.ts 와 반드시 일치)
  세로 맵이라 월드가 -90도 돌아간다. 월드 (0,0) 이 화면 좌하단.
    월드 x(진행축) 0→length : 화면 아래→위  = 그림 아래→위
    월드 y(폭) -halfW→+halfW : 화면 왼→오른 = 그림 왼→오른
  마스크는 행 0 = 진행축 시작(우리 쪽 = 그림 아래), 열 0 = y 최소(그림 왼쪽).

실행: python packages/client/tools/gen_owlkeep2.py
"""
import os
from PIL import Image

SRC = '5라운드수정-폴더/5라운드수정완성.png'
MAPS = 'packages/client/public/assets/maps'

LEN_T, HALF_T = 70, 28           # MapDef 와 반드시 같아야 한다 (길이 70타일 / 반폭 28)
CPT = 4                          # 타일당 격자 칸 (0.25타일 해상도 — 길 가장자리를 정밀하게 깎으려고)
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT   # 140 x 112

WARM_MIN = -6                    # r-b 가 이 값 이상이면 다닐 수 있는 곳
ERODE = 2                        # 가장자리 깎기 (칸 단위 — CPT 4 이면 1칸 = 0.25타일)


def sample(px, W, H, ix, iy):
    """그림 픽셀 (ix,iy) 주변 3x3 평균 — 한 점만 보면 잡티에 흔들린다."""
    tr = tg = tb = n = 0
    for dy in (-2, 0, 2):
        for dx in (-2, 0, 2):
            x = min(W - 1, max(0, ix + dx))
            y = min(H - 1, max(0, iy + dy))
            r, g, b = px[x, y][:3]
            tr += r; tg += g; tb += b; n += 1
    return tr // n, tg // n, tb // n


def build(im):
    W, H = im.size
    px = im.load()
    walk = [[False] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        # 행 0 = 월드 x 시작 = 그림 아래쪽
        iy = int((1 - (r + 0.5) / ROWS) * H)
        for c in range(COLS):
            ix = int((c + 0.5) / COLS * W)
            rr, gg, bb = sample(px, W, H, ix, min(H - 1, iy))
            walk[r][c] = (rr - bb) >= WARM_MIN
    return walk


def close(grid, rounds=1):
    """팽창 → 침식. 길 위의 덩굴 구멍처럼 작은 빈틈을 메운다."""
    def dil(g):
        o = [[False] * COLS for _ in range(ROWS)]
        for r in range(ROWS):
            for c in range(COLS):
                if g[r][c]:
                    o[r][c] = True
                    continue
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < ROWS and 0 <= cc < COLS and g[rr][cc]:
                        o[r][c] = True
                        break
        return o

    def ero(g):
        o = [[False] * COLS for _ in range(ROWS)]
        for r in range(ROWS):
            for c in range(COLS):
                if not g[r][c]:
                    continue
                ok = True
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < ROWS and 0 <= cc < COLS and not g[rr][cc]:
                        ok = False
                        break
                o[r][c] = ok
        return o

    for _ in range(rounds):
        grid = dil(grid)
    for _ in range(rounds):
        grid = ero(grid)
    return grid



def erode(grid, rounds=1):
    """가장자리를 깎는다 — 길 옆 돌무더기를 통행에서 빼 부대가 한가운데로 걷게 한다."""
    for _ in range(rounds):
        o = [row[:] for row in grid]
        for r in range(ROWS):
            for c in range(COLS):
                if not grid[r][c]:
                    continue
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    rr, cc = r + dr, c + dc
                    if not (0 <= rr < ROWS and 0 <= cc < COLS) or not grid[rr][cc]:
                        o[r][c] = False
                        break
        grid = o
    return grid


def bfs_path(grid, a, b):
    """grid 위에서 a -> b 최단 경로 칸 목록 (없으면 None)."""
    from collections import deque
    if not grid[a[0]][a[1]] or not grid[b[0]][b[1]]:
        return None
    prev = {a: None}
    q = deque([a])
    while q:
        cur = q.popleft()
        if cur == b:
            break
        r, c = cur
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rr, cc = r + dr, c + dc
            if 0 <= rr < ROWS and 0 <= cc < COLS and grid[rr][cc] and (rr, cc) not in prev:
                prev[(rr, cc)] = cur
                q.append((rr, cc))
    if b not in prev:
        return None
    out = []
    cur = b
    while cur is not None:
        out.append(cur)
        cur = prev[cur]
    return out


def tighten(full, seeds, rounds):
    """
    넓은 구간은 깎고(가장자리 돌무더기 제거), 좁은 목은 원래 폭으로 되살린다.

    그냥 깎으면 계단처럼 1~2칸짜리 길목이 통째로 막혀 두 언덕이 끊긴다.
    그래서 깎은 뒤, 원래 마스크에서 두 언덕을 잇는 최단 경로를 찾아 그 둘레를
    다시 열어 준다 — 넓은 길에서는 한가운데로 걷고, 좁은 목은 그대로 지나간다.
    """
    tight = erode(full, rounds)
    a, b = seeds[0], seeds[1]
    path = bfs_path(full, a, b)
    if not path:
        print('  ! 원본 마스크에서도 두 언덕이 안 이어진다')
        return keep_main(tight, seeds)
    # 최단 경로 둘레를 원래 마스크 범위 안에서 되살린다 (부대가 지나갈 폭 확보)
    back = rounds + 1
    for (r, c) in path:
        for dr in range(-back, back + 1):
            for dc in range(-back, back + 1):
                rr, cc = r + dr, c + dc
                if 0 <= rr < ROWS and 0 <= cc < COLS and full[rr][cc]:
                    tight[rr][cc] = True
    return keep_main(tight, seeds)

def keep_main(grid, seeds):
    """seeds 가 들어 있는 연결 요소만 남긴다 (숲 속 잡티 제거)."""
    seen = [[False] * COLS for _ in range(ROWS)]
    keep = [[False] * COLS for _ in range(ROWS)]
    for sr, sc in seeds:
        if not (0 <= sr < ROWS and 0 <= sc < COLS) or not grid[sr][sc] or seen[sr][sc]:
            continue
        stack = [(sr, sc)]
        seen[sr][sc] = True
        while stack:
            r, c = stack.pop()
            keep[r][c] = True
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                rr, cc = r + dr, c + dc
                if 0 <= rr < ROWS and 0 <= cc < COLS and grid[rr][cc] and not seen[rr][cc]:
                    seen[rr][cc] = True
                    stack.append((rr, cc))
    return keep


def to_world(fx, fy):
    """그림 비율 (fx 왼→오른, fy 위→아래) → 월드 타일 (x 진행축, y 폭)."""
    return (1 - fy) * LEN_T, (fx - 0.5) * HALF_T * 2


def main():
    im = Image.open(SRC).convert('RGB')
    grid = close(build(im), 1)
    # 두 언덕(진영) 자리를 씨앗으로 — 그림에서 잰 비율
    seeds = []
    for fx, fy in ((0.146, 0.517), (0.812, 0.083)):
        x, y = to_world(fx, fy)
        seeds.append((int(x * CPT), int((y / (HALF_T * 2) + 0.5) * COLS)))
    grid = keep_main(grid, seeds)
    # 길 가장자리(돌무더기)를 깎아 낸다. 다만 계단처럼 좁은 목은 깎으면 끊기므로,
    # 원래 마스크에서 두 언덕을 잇는 최단 경로를 다시 새겨 넣어 통행을 보장한다.
    grid = tighten(grid, seeds, ERODE)
    data = ''.join('.' if grid[r][c] else '#' for r in range(ROWS) for c in range(COLS))
    walkable = data.count('.')
    print('마스크 %dx%d (행=진행축) 통행 %d칸 (%.1f%%)'
          % (COLS, ROWS, walkable, 100 * walkable / len(data)))

    os.makedirs(MAPS, exist_ok=True)
    im.save(os.path.join(MAPS, 'owlkeep.png'))
    print('배경 저장: %s/owlkeep.png' % MAPS)

    with open('packages/client/tools/owlkeep_mask.txt', 'w', encoding='utf-8') as f:
        f.write(data)
    print('마스크 저장: packages/client/tools/owlkeep_mask.txt')

    # 진영·씨앗이 실제로 통행 가능한지 확인
    for name, (fx, fy) in (('우리 언덕', (0.146, 0.517)), ('적 언덕', (0.812, 0.083))):
        x, y = to_world(fx, fy)
        r = int(x * CPT); c = int((y / (HALF_T * 2) + 0.5) * COLS)
        ok = grid[r][c] if 0 <= r < ROWS and 0 <= c < COLS else False
        print('  %s: 월드(x %.1f, y %+.1f) 격자(r%d,c%d) %s'
              % (name, x, y, r, c, '통행 OK' if ok else '★막힘'))


if __name__ == '__main__':
    main()
