"""
「자정의 마을」 3단계 — 맵을 위로 넓힌다.

적이 11시·1시 숲길로 들어오는데 진입로가 짧아 순식간에 마을에 닿았다.
북쪽에 숲을 덧대고 두 진입로를 맵 맨 위까지 뽑아, 적이 걸어 내려오는 시간을 준다.

  · 배경: 기존 village.png 위쪽에 숲 띠를 붙이고 진입로를 그린다
  · 마스크: 위로 늘린 만큼 앞줄을 추가하고 두 갈래 길을 뚫는다

좌표는 「원본 그림 비율」이 아니라 넓어진 뒤 기준이므로,
data.ts village MapDef 의 halfW 와 여기 NEW_HALF_T 가 반드시 같아야 한다.

실행: python packages/client/tools/gen_village3.py
"""
import os
import random
import sys
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_village as G  # noqa: E402
import gen_village2 as G2  # noqa: E402

LEN_T = 56          # 진행축(x) — 그대로
OLD_HALF_T = 21     # 넓히기 전 반폭
NEW_HALF_T = 30     # 넓힌 뒤 반폭 (위로 18타일 추가)
CPT = 2
ROWS = LEN_T * CPT
OLD_COLS = OLD_HALF_T * 2 * CPT      # 84
NEW_COLS = NEW_HALF_T * 2 * CPT      # 120
GROW = NEW_COLS - OLD_COLS           # 36칸 = 18타일, 전부 위(작은 col)쪽

# 진입로 — 11시(x 작은 쪽) / 1시(x 큰 쪽). 맵 맨 위(col 0)까지 뚫는다.
LANES = [
    ('11시', 0.215),   # 진행축 x 비율
    ('1시', 0.790),
]
LANE_HALF_T = 3.4      # 진입로 반폭 (타일) — 2.2 였을 때 부대가 숲길에서 서로 밀며 막혔다


def main():
    # ── 배경 ──
    src = Image.open(os.path.join(G.MAPS, 'village.png')).convert('RGBA')
    W, H = src.size
    addH = round(H * GROW / OLD_COLS)
    out = Image.new('RGBA', (W, H + addH), (0, 0, 0, 255))
    # 북쪽 띠는 기존 그림 위쪽 숲을 늘려 채운다 (색·결이 이어지게)
    top = src.crop((0, 0, W, min(H, 260)))
    out.paste(top.resize((W, addH), Image.LANCZOS), (0, 0))
    out.alpha_composite(src, (0, addH))

    im, boxes = G.cut_objects()
    crop = lambda i: im.crop(boxes[i][:4])
    rng = random.Random(6060)
    laneX = [int(fx * W) for _, fx in LANES]
    laneR = LANE_HALF_T / (LEN_T) * W    # 진입로 반폭 (px)

    plan = []
    for _ in range(320):
        x, y = rng.randrange(W), rng.randrange(addH + 120)
        if any(abs(x - lx) < laneR * 1.25 for lx in laneX):
            continue     # 진입로는 비워 둔다
        idx = rng.choice(G2.BIG_TREES + G2.PINES + G2.PINES + G2.BUSHES)
        plan.append((y, crop(idx), x, y, rng.uniform(0.5, 0.95)))
    for _ in range(10):  # 불타는 숲 — 적이 오는 길목
        lx = rng.choice(laneX)
        x = lx + rng.choice([-1, 1]) * int(laneR * (1.3 + rng.random()))
        y = rng.randrange(0, addH)
        plan.append((y, crop(G2.BURNT[0]), x, y, rng.uniform(0.55, 0.8)))
    plan.sort(key=lambda p: p[0])
    for _, s, x, y, sc in plan:
        w, h = max(1, int(s.width * sc)), max(1, int(s.height * sc))
        out.alpha_composite(s.resize((w, h), Image.LANCZOS), (x - w // 2, y - h))
    out.convert('RGB').save(os.path.join(G.MAPS, 'village.png'))
    print(f'배경 {W}x{H} -> {W}x{H + addH} (위로 {addH}px / {GROW // CPT}타일)')

    # ── 마스크 ──
    old = open('packages/client/tools/village_mask_v1.txt').read().strip()
    assert len(old) == ROWS * OLD_COLS, len(old)
    grid = []
    for r in range(ROWS):
        grid.append(['#'] * GROW + list(old[r * OLD_COLS:(r + 1) * OLD_COLS]))

    # 두 진입로를 맵 맨 위에서 기존 빈터까지 뚫는다
    lane_half = int(LANE_HALF_T * CPT)
    for _, fx in LANES:
        rc = int(fx * ROWS)
        # 기존 마스크에서 이 x 줄이 처음 열리는 col 을 찾아 거기까지 잇는다
        join = next((c for c in range(GROW, NEW_COLS) if grid[rc][c] == '.'), GROW + 8)
        for r in range(max(0, rc - lane_half), min(ROWS, rc + lane_half + 1)):
            for c in range(0, min(NEW_COLS, join + 2)):
                grid[r][c] = '.'
    data = ''.join(''.join(r) for r in grid)
    assert len(data) == ROWS * NEW_COLS
    with open('packages/client/tools/village_mask.txt', 'w') as f:
        f.write(data)
    print(f'마스크 {ROWS}x{NEW_COLS} — 통행 {data.count(".") * 100 // len(data)}%')
    for r in range(0, ROWS, 3):
        print(''.join('.' if any(grid[r][c + k] == '.' for k in range(min(3, NEW_COLS - c)))
                      else '#' for c in range(0, NEW_COLS, 3)))


if __name__ == '__main__':
    main()
