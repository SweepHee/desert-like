"""
15라운드 오브젝트 시트를 낱개로 자른다.

오브젝트.png 는 알파가 살아 있는 시트라, 알파가 이어진 덩어리를 하나씩 떼어
`packages/client/tools/objdump/gm_NN.png` 로 떨군다. 어느 조각이 무엇인지는
사람이 눈으로 보고 gen_goldmine2.py 의 표에 적는다 (좌표·크기를 같이 찍어 준다).

실행: python packages/client/tools/cut_goldmine_objects.py
"""
import os
from collections import deque

from PIL import Image

SRC = '15라운드/오브젝트.png'
OUT = 'packages/client/tools/objdump/goldmine'
MIN_PX = 900          # 이보다 작은 부스러기는 버린다 (그림자 점 등)
ALPHA_ON = 24         # 이 이상이면 「있다」로 친다


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert('RGBA')
    W, H = im.size
    a = im.getchannel('A').load()
    seen = bytearray(W * H)
    parts = []
    for y0 in range(H):
        for x0 in range(W):
            if seen[y0 * W + x0] or a[x0, y0] < ALPHA_ON:
                continue
            q = deque([(x0, y0)])
            seen[y0 * W + x0] = 1
            cells = []
            while q:
                x, y = q.popleft()
                cells.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and not seen[ny * W + nx] and a[nx, ny] >= ALPHA_ON:
                        seen[ny * W + nx] = 1
                        q.append((nx, ny))
            if len(cells) < MIN_PX:
                continue
            xs = [c[0] for c in cells]
            ys = [c[1] for c in cells]
            parts.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, len(cells)))

    # 위에서 아래로, 왼쪽에서 오른쪽으로 번호를 매긴다 (시트를 읽는 순서)
    parts.sort(key=lambda p: (p[1] // 40, p[0]))
    for i, (x0, y0, x1, y1, n) in enumerate(parts):
        im.crop((x0, y0, x1, y1)).save(os.path.join(OUT, f'gm_{i:02d}.png'))
        print(f'gm_{i:02d}  bbox=({x0},{y0})-({x1},{y1})  {x1 - x0}x{y1 - y0}  {n}px')
    print(f'\n조각 {len(parts)}개 -> {OUT}')


if __name__ == '__main__':
    main()
