"""
「자정의 마을」(캠페인 6) 지형 에셋 파이프라인.

작가가 준 세 장을 게임 에셋으로 굽는다:
  6라운드지형자료/Wang타일.png  -> assets/tiles/village.png  (16타일 Wang 시트)
  6라운드지형자료/지형.png       -> 통행 마스크 (data.ts MASK_VILLAGE)
  6라운드지형자료/오브젝트.png   -> assets/tiles/vg_*.png    (건물·나무·바위 소품)

Wang 시트의 배치는 눈으로 맞추지 않는다. 타일마다 네 모서리를 찍어
「길(밝은 흙) = 1 / 숲(어두운 초록) = 0」으로 코너 마스크를 계산하고,
render.ts 의 WANG_16 이 기대하는 자리에 그 인덱스로 꽂는다.

실행: python packages/client/tools/gen_village_tiles.py
"""
import os
from PIL import Image

SRC = '6라운드지형자료'
OUT = 'packages/client/public/assets/tiles'

# render.ts WANG_16 — 코너 idx(NW*8|NE*4|SW*2|SE) -> 시트 좌표
WANG = {0: (64, 32), 1: (96, 32), 2: (64, 64), 3: (32, 64), 4: (64, 0), 5: (96, 64),
        6: (0, 32), 7: (96, 96), 8: (32, 32), 9: (64, 96), 10: (32, 0), 11: (0, 64),
        12: (96, 0), 13: (0, 0), 14: (32, 96), 15: (0, 96)}


def is_road(px):
    """길(밝은 모래빛)인가. 숲은 어둡고 초록이 돈다."""
    r, g, b = px[:3]
    return (r + g + b) / 3 > 90 and r > b + 18


def corner_mask(tile):
    """네 모서리 안쪽을 찍어 코너 비트를 만든다 (NW<<3|NE<<2|SW<<1|SE)."""
    w, h = tile.size
    # 모서리 딱 끝은 이웃 타일 경계선이 섞이므로 12% 안쪽을 본다
    d = int(w * 0.12)
    pts = [(d, d), (w - 1 - d, d), (d, h - 1 - d), (w - 1 - d, h - 1 - d)]  # NW NE SW SE
    bits = 0
    for i, (x, y) in enumerate(pts):
        # 한 점만 보면 돌·꽃에 속으므로 작은 패치의 다수결
        n = road = 0
        for dx in range(-6, 7, 3):
            for dy in range(-6, 7, 3):
                n += 1
                if is_road(tile.getpixel((min(w - 1, max(0, x + dx)), min(h - 1, max(0, y + dy))))):
                    road += 1
        if road * 2 > n:
            bits |= 1 << (3 - i)
    return bits


def build_sheet():
    src = Image.open(os.path.join(SRC, 'Wang타일.png')).convert('RGBA')
    W, H = src.size
    tw, th = W / 4, H / 4
    sheet = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    seen = {}
    for r in range(4):
        for c in range(4):
            box = (round(c * tw), round(r * th), round((c + 1) * tw), round((r + 1) * th))
            tile = src.crop(box)
            m = corner_mask(tile)
            seen.setdefault(m, []).append((r, c))
            sheet.paste(tile.resize((32, 32), Image.LANCZOS), WANG[m])
    print('코너 마스크 판정:')
    for m in range(16):
        where = seen.get(m)
        print(f'  mask {m:2d}: ' + (f'원본 {where}' if where else '*** 없음 ***'))
    dup = {m: v for m, v in seen.items() if len(v) > 1}
    missing = [m for m in range(16) if m not in seen]
    if dup or missing:
        raise SystemExit(f'배치 판정 실패 — 중복 {dup} / 누락 {missing}')
    sheet.save(os.path.join(OUT, 'village.png'))
    print(f'-> {OUT}/village.png')


if __name__ == '__main__':
    build_sheet()
