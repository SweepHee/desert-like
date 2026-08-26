"""
「자정의 마을」 2단계 — 작가 지형을 그대로 굽는다.

받은 자료(6라운드지형자료)는 이렇게 쓴다:
  · 지형.png   — 길·빈터가 그려진 바닥. 통행 마스크는 여기서 나온다(gen_village.py).
  · 오브젝트.png — 집·나무·바위 스프라이트 시트. 집 4채만 잘라 쓴다.
  · 완성.png   — 작가가 직접 배치를 끝낸 그림. **이게 곧 맵 배경이다.**

한때 지형.png 위에 나무를 난수로 흩뿌려 배경을 만들었는데, 작가가 그려 놓은
구도(길 여덟 갈래·집 네 채가 광장을 둘러싼 별 모양)가 통째로 뭉개졌다.
지금은 완성.png 를 그대로 쓰고, 집 네 채 자리만 지형.png 로 되메운다 —
집은 부술 수 있는 실물이라 그림에 박혀 있으면 무너져도 계속 서 있기 때문이다.

실행: python packages/client/tools/gen_village2.py
"""
import os
import sys
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_village as G  # noqa: E402

TILES = G.TILES
MAPS = G.MAPS
LEN_T = 56.0        # 진행축(x) 타일 수
HALF_T = 21.0       # 반폭(y) — 그림 세로 절반

# gen_village.cut_objects() 정렬 순서의 집 인덱스와, 완성.png 안에서 잰 자리.
# (px 상자는 오브젝트 스프라이트를 배율별로 맞춰 본 결과 — gen_village2 주석 참고)
HOUSES = [
    ('a', 0, (480, 360, 708, 604)),   # 11시
    ('b', 1, (768, 340, 968, 568)),   # 1시
    ('c', 3, (472, 664, 660, 860)),   # 7시
    ('d', 2, (844, 632, 1072, 868)),  # 5시
]


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
    obj, boxes = G.cut_objects()

    # ── 집 스프라이트: 시트에서 잘라 그대로 (게임 안에서 부술 수 있는 실물) ──
    for name, idx, _ in HOUSES:
        c = obj.crop(boxes[idx][:4])
        c.save(os.path.join(TILES, f'vg_house_{name}.png'))
        print(f'vg_house_{name}.png <- obj{idx} {c.size}')

    # ── 배경: 완성.png 그대로. 집 자리만 지형.png 로 되메운다 ──
    done = Image.open(os.path.join(G.SRC, '완성.png')).convert('RGB')
    ground = Image.open(os.path.join(G.SRC, '지형.png')).convert('RGB')
    W, H = done.size
    assert ground.size == (W, H), (done.size, ground.size)
    for name, _, (x0, y0, x1, y1) in HOUSES:
        pad = 14
        bx = (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))
        patch = ground.crop(bx)
        # 가장자리를 부드럽게 — 딱 잘린 사각형이 보이면 그게 더 눈에 띈다
        m = Image.new('L', (bx[2] - bx[0], bx[3] - bx[1]), 0)
        m.paste(255, (pad, pad, m.width - pad, m.height - pad))
        done.paste(patch, (bx[0], bx[1]), m.filter(ImageFilter.GaussianBlur(pad * 0.8)))
        cx = (x0 + x1) / 2 * LEN_T / W
        fy = y1 * HALF_T * 2 / H - HALF_T
        wt = (x1 - x0) * LEN_T / W
        print(f'  집 {name}: 발밑 타일 ({cx:.1f}, {fy:.1f})  폭 {wt:.1f}타일')
    done.save(os.path.join(MAPS, 'village.png'))
    print(f'-> {MAPS}/village.png  {W}x{H} (완성.png 그대로, 집 4채만 되메움)')

    # ── 마스크: 지형.png 에서 뽑은 것을 다듬어 확정 ──
    grid = largest_regions(open('packages/client/tools/village_mask.txt').read().strip())
    data = ''.join(''.join(r) for r in grid)
    for path in ('packages/client/tools/village_mask.txt', 'packages/client/tools/village_mask_v1.txt'):
        with open(path, 'w') as f:
            f.write(data)
    print(f'마스크 {G.ROWS}x{G.COLS} — 통행 {data.count(".") * 100 // len(data)}%')


if __name__ == '__main__':
    main()
