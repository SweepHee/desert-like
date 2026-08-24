"""
「자정의 마을」(캠페인 6) 지형 파이프라인.

작가가 준 6라운드지형자료/ 를 게임 에셋으로 굽는다.

  지형.png     -> assets/maps/village.png   (배경 한 장 — MapDef.bgImage)
               -> 통행 마스크               (data.ts MASK_VILLAGE)
  오브젝트.png -> assets/tiles/vg_*.png      (건물 4채 + 나무·바위·등불 소품)

Wang타일.png 는 쓰지 않는다. 그 시트는 「길이 타일 변(邊)으로 이어지는」 엣지형인데
엔진(render.ts WANG_16)은 꼭짓점 기준 코너형이라 규약이 다르다. 억지로 맞추면
작가가 칠한 길 모양이 뭉개지므로, 이미 완성된 지형.png 를 배경으로 통째로 깐다
(MapDef.bgImage — 잿길·세계수와 같은 손그림 지형 경로).

통행 판정: 길은 따뜻하고(r>b) 숲은 차갑다(b>r). 다만 원본에 비네팅이 세서
가장자리 길이 까맣게 죽으므로, 크게 흐린 복사본으로 밝기를 나눠 비네팅을 걷어낸 뒤
색조로 가른다.

실행: python packages/client/tools/gen_village.py
"""
import os
from PIL import Image, ImageFilter

SRC = '6라운드지형자료'
TILES = 'packages/client/public/assets/tiles'
MAPS = 'packages/client/public/assets/maps'

LEN_T, HALF_T = 56, 21          # MapDef 와 반드시 같아야 한다 (길이 56타일 / 반폭 21)
CPT = 2                          # 타일당 격자 칸
ROWS, COLS = LEN_T * CPT, HALF_T * 2 * CPT

# 건물 4채가 설 자리 — 완성.png 에서 잰 화면 비율 (0~1)
BUILDINGS = [
    ('vg_house_a', 0.408, 0.433),   # 11시
    ('vg_house_b', 0.608, 0.414),   # 1시
    ('vg_house_c', 0.390, 0.695),   # 7시
    ('vg_house_d', 0.653, 0.714),   # 5시
]
PLAZA = (0.539, 0.612)


def unvignette(im):
    """크게 흐린 밝기로 나눠 가장자리 어두움을 걷어낸다."""
    g = im.convert('L').filter(ImageFilter.GaussianBlur(70))
    return g


def build_mask(im):
    W, H = im.size
    blur = unvignette(im)
    px, bp = im.load(), blur.load()
    grid = [['#'] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        for c in range(COLS):
            # 격자 칸 중심 -> 원본 픽셀 (행=진행축 x, 열=폭 y)
            x = min(W - 1, int((r + 0.5) * W / ROWS))
            y = min(H - 1, int((c + 0.5) * H / COLS))
            rr, gg, bb = px[x, y][:3]
            base = max(8, bp[x, y])
            # 비네팅 보정: 주변 평균으로 정규화한 뒤 따뜻함(r-b)을 본다
            warm = (rr - bb) * 40 / base
            lum = (rr + gg + bb) / 3 * 40 / base
            if warm > 6 and lum > 26:
                grid[r][c] = '.'
    return grid


def dilate(grid, n=1):
    """길을 n칸 부풀린다 — 건물 앞마당·계단까지 밟히게."""
    for _ in range(n):
        out = [row[:] for row in grid]
        for r in range(ROWS):
            for c in range(COLS):
                if grid[r][c] == '.':
                    continue
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < ROWS and 0 <= nc < COLS and grid[nr][nc] == '.':
                        out[r][c] = '.'
                        break
        grid = out
    return grid


def carve_disc(grid, fx, fy, tiles_r):
    """건물 둘레를 강제로 열어 준다 — 못 닿으면 부술 수가 없다."""
    cr, cc = fx * ROWS, fy * COLS
    rad = tiles_r * CPT
    for r in range(max(0, int(cr - rad)), min(ROWS, int(cr + rad) + 1)):
        for c in range(max(0, int(cc - rad)), min(COLS, int(cc + rad) + 1)):
            if (r - cr) ** 2 + (c - cc) ** 2 <= rad * rad:
                grid[r][c] = '.'


def cut_objects():
    """오브젝트 시트를 알파 연결 성분으로 잘라 낸다."""
    im = Image.open(os.path.join(SRC, '오브젝트.png')).convert('RGBA')
    W, H = im.size
    a = im.split()[3].load()
    seen = [[False] * W for _ in range(H)]
    boxes = []
    for y in range(H):
        for x in range(W):
            if seen[y][x] or a[x, y] < 40:
                continue
            # 반복 플러드필 (재귀는 스택이 터진다)
            stack = [(x, y)]
            seen[y][x] = True
            x0 = x1 = x
            y0 = y1 = y
            n = 0
            while stack:
                cx, cy = stack.pop()
                n += 1
                x0, x1 = min(x0, cx), max(x1, cx)
                y0, y1 = min(y0, cy), max(y1, cy)
                for dx in (-2, -1, 0, 1, 2):
                    for dy in (-2, -1, 0, 1, 2):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < W and 0 <= ny < H and not seen[ny][nx] and a[nx, ny] >= 40:
                            seen[ny][nx] = True
                            stack.append((nx, ny))
            if n >= 900:  # 티끌 제외
                boxes.append((x0, y0, x1 + 1, y1 + 1, n))
    boxes.sort(key=lambda b: (b[1] // 60, b[0]))  # 위->아래, 좌->우
    return im, boxes


def main():
    os.makedirs(MAPS, exist_ok=True)
    terr = Image.open(os.path.join(SRC, '지형.png')).convert('RGB')
    terr.save(os.path.join(MAPS, 'village.png'))
    print(f'-> {MAPS}/village.png {terr.size}')

    grid = dilate(build_mask(terr), 1)
    for _, fx, fy in BUILDINGS:
        carve_disc(grid, fx, fy, 3.0)
    carve_disc(grid, *PLAZA, 5.0)
    data = ''.join(''.join(r) for r in grid)
    assert len(data) == ROWS * COLS
    print(f'마스크 {ROWS}x{COLS} — 통행 {data.count(".") * 100 // len(data)}%')
    with open('packages/client/tools/village_mask.txt', 'w') as f:
        f.write(data)
    for r in range(0, ROWS, 3):
        print(''.join('.' if any(grid[r][c + k] == '.' for k in range(min(3, COLS - c)))
                      else '#' for c in range(0, COLS, 3)))

    im, boxes = cut_objects()
    print(f'\n오브젝트 {len(boxes)}개:')
    for i, (x0, y0, x1, y1, n) in enumerate(boxes):
        print(f'  {i:2d}: ({x0},{y0})-({x1},{y1}) {x1 - x0}x{y1 - y0} px={n}')
        im.crop((x0, y0, x1, y1)).save(os.path.join(TILES, f'vg_raw{i}.png'))


if __name__ == '__main__':
    main()
