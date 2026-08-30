"""ImageGen 카르자 광부 원본을 게임용 투명 픽셀 스프라이트로 굽는다."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'packages/client/assets/karja/miner/k_miner_imagegen.png'
UNIT = ROOT / 'packages/client/public/assets/units/k_miner.png'
ICON = ROOT / 'packages/client/public/assets/units/k_miner_icon.png'


def fitted(size: int, body_h: int) -> Image.Image:
    src = Image.open(SRC).convert('RGBA')
    alpha = src.getchannel('A')
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError('카르자 광부 원본에 불투명 픽셀이 없습니다.')
    src = src.crop(bbox)
    scale = min((size - 4) / src.width, body_h / src.height)
    w = max(1, round(src.width * scale))
    h = max(1, round(src.height * scale))
    # 원본 자체가 큰 픽셀 블록으로 생성되었으므로 NEAREST로 경계를 보존한다.
    src = src.resize((w, h), Image.Resampling.NEAREST)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.alpha_composite(src, ((size - w) // 2, size - h - 2))
    return out


def main() -> None:
    UNIT.parent.mkdir(parents=True, exist_ok=True)
    fitted(64, 58).save(UNIT)
    fitted(64, 60).save(ICON)
    print(f'{UNIT.name}, {ICON.name}: 64x64 RGBA')


if __name__ == '__main__':
    main()
