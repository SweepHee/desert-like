"""건물 그림의 「캔버스 아래 빈 여백」 잘라내기.

렌더러는 건물을 anchor(0.5, 1) — 캔버스 바닥 기준 — 으로 땅에 세운다.
그래서 그림 아래에 투명 여백이 남아 있으면 그만큼 건물이 공중에 뜬다.
넥서스는 11px, 수호탑은 7px 이 비어 있었고 화면에서는 확대돼 더 벌어졌다
(그 틈에 그림자 타원까지 깔려서 「받침대 위에 떠 있는」 것처럼 보였다).

폭은 건드리지 않는다 — 렌더러가 targetW / texture.width 로 크기를 정하므로
폭을 자르면 건물 크기가 통째로 바뀐다. 잘라내는 건 아래쪽 빈 줄뿐이다.

실행: python packages/client/tools/trim_structure_base.py [--dry]
"""
import sys
from pathlib import Path
from PIL import Image

UNITS = Path(__file__).resolve().parent.parent / 'public' / 'assets' / 'units'
DRY = '--dry' in sys.argv

# 땅에 세우는 건물 그림 (tier: 'structure'). 장식 소품은 여기 넣지 않는다.
BUILDINGS = [
    'nexus', 'tower',
    'nexus_toy', 'tower_toy',
    'nexus_bone', 'tower_bone',
    'nexus_nest', 'nexus_demon', 'nexus_elfcamp', 'nexus_forestcamp',
    'nexus_ash', 'tower_ash',
    'c_demon_camp', 'c_sage_watchtower', 'c_sage_watchtower_s', 'c_sylvarin_tent',
]

changed = 0
for name in BUILDINGS:
    path = UNITS / f'{name}.png'
    if not path.exists():
        continue
    im = Image.open(path).convert('RGBA')
    bb = im.getbbox()
    if bb is None:
        continue
    pad = im.height - bb[3]
    if pad <= 0:
        continue
    print(f'{name:22s} 아래 여백 {pad:3d}px 잘라냄  {im.height} -> {bb[3]}')
    changed += 1
    if not DRY:
        im.crop((0, 0, im.width, bb[3])).save(path)

print('모든 건물이 이미 바닥에 붙어 있다.' if changed == 0
      else f'{changed}종 정리' + (' (미적용, --dry)' if DRY else ''))
