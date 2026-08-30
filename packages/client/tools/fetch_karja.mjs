/**
 * 카르자 스프라이트 내려받기 — 픽셀랩 캐릭터 → 게임 에셋.
 *
 * 캐릭터마다 download zip 을 한 번 받아 필요한 것만 꺼낸다:
 *   Idle/rotations/{east,west,north,south}.png   -> <id>_{e,w,n,s}.png
 *   Idle/rotations/east.png                      -> <id>.png        (기존 폴백)
 *   Idle/rotations/south.png                     -> <id>_icon.png   (상점 아이콘)
 *   Idle/animations/karja_attack/east/frame_00N  -> <id>_atk0..3.png
 *   Idle/animations/karja_fly/east/frame_00N     -> <id>_fly0..3.png
 *
 * 프레임은 5장(0 = 기준 자세 + 1~4 동작)이라 1~4 를 쓴다.
 * 15라운드가 굽은 길을 쓰므로 네 방향을 모두 꺼낸다. 회전 그림과 이미 생성된
 * 방향별 애니메이션을 ZIP에서 추출하는 작업이라 추가 generation은 들지 않는다.
 *
 * 픽셀랩 캐릭터 id 를 아래 표에 박아 둔다 — 언제든 이 스크립트만 돌리면 다시 받는다.
 *
 * 실행: node packages/client/tools/fetch_karja.mjs
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const API = 'https://api.pixellab.ai/mcp/characters';
const OUT = 'packages/client/public/assets/units';
const TMP = path.join(process.env.TEMP ?? '/tmp', 'karja_zip');

/** 게임 유닛 id → 픽셀랩 캐릭터 id (인간형은 v3 재생성본 — standard 는 너무 밋밋했다) */
const UNITS = {
  k_scimitar: 'd0553458-dbb3-428e-8643-968d17cb1939',
  k_hunter: 'bb3ac612-8f82-4e07-a596-6058ae596bdb',
  k_wolf: 'ffbb7195-929f-4db4-9da9-d7cdc1c8856f',
  k_wolfrider: 'be86425d-35b7-412b-bad4-93ff130bf4a7',
  k_apprentice: 'af36df46-d5dd-4a6f-a5c7-aae664f2ecea',
  k_tribal: '56ce0787-bdc8-48ab-a346-532e364ed9a2',
  k_shaman: '2935c2a0-0b74-4161-899e-9d1a945043a0',
  k_spiritcaller: 'e674370d-18f2-44c2-9269-552d1a114614',
  k_highlander: 'd8c8f8b1-3941-42d8-a68a-e45908ef767b',
  k_sandgiant: '90d511cf-b828-4f47-b995-7db833ebe4ef',
  k_falconer: 'fee4f278-3ebd-4da8-ac98-06706082705e',
  k_eagle: '7432903f-e9bd-41ff-a8a4-0f6ad987cb68',
  k_beeswarm: 'c6ec8fbc-629f-4f25-93e0-be28cac573ad',
  k_sandwraith: '4c4da4d6-2571-4ffb-9917-ffec47c6d79f',
  k_grandshaman: '35a5ee95-8528-4f66-bdd8-0ce68d60119e',
  k_totem: 'f70f1bb1-2844-4316-af5b-9ce069896fb0',
  k_falcon: '4e24c63e-1a9d-412c-acc4-8866c9127486',
  k_spirit: '16140f81-2e55-42b5-ab84-4e46104a4804',
  // 15 「에메랄드 숲의 값」 일꾼 — 캐는 모션이 karja_attack 으로 들어간다
  c_elf_miner: '19f3d381-e861-46fe-8a34-60acc2d12735',
};

const PY = `
import sys, zipfile, os
zp, out, unit = sys.argv[1], sys.argv[2], sys.argv[3]
z = zipfile.ZipFile(zp)
names = z.namelist()
got = []
def dump(src, dst):
    if src in names:
        with open(os.path.join(out, dst), 'wb') as f:
            f.write(z.read(src))
        got.append(dst)
dirs = (('east', 'e'), ('west', 'w'), ('north', 'n'), ('south', 's'))
dump('Idle/rotations/east.png', unit + '.png')
dump('Idle/rotations/south.png', unit + '_icon.png')
for dirname, short in dirs:
    dump('Idle/rotations/%s.png' % dirname, '%s_%s.png' % (unit, short))
for kind, suffix in (('karja_attack', '_atk'), ('karja_fly', '_fly')):
    for i in range(4):
        src = 'Idle/animations/%s/east/frame_%03d.png' % (kind, i + 1)
        dump(src, '%s%s%d.png' % (unit, suffix, i))
print(' '.join(got))
`;

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  let base = 0;
  let atk = 0;
  let fly = 0;
  const missing = [];
  for (const [unit, cid] of Object.entries(UNITS)) {
    const res = await fetch(`${API}/${cid}/download`);
    if (!res.ok) { console.log(`  ${unit.padEnd(15)} 실패 ${res.status}`); missing.push(unit); continue; }
    const zp = path.join(TMP, `${unit}.zip`);
    fs.writeFileSync(zp, Buffer.from(await res.arrayBuffer()));
    const out = execFileSync('python', ['-c', PY, zp, OUT, unit], { encoding: 'utf8' }).trim();
    const files = out ? out.split(' ') : [];
    const a = files.filter((f) => f.includes('_atk')).length;
    const y = files.filter((f) => f.includes('_fly')).length;
    if (files.includes(`${unit}.png`)) base++;
    if (a === 4) atk++;
    if (y === 4) fly++;
    console.log(`  ${unit.padEnd(15)} 그림 ${files.length - a - y}장 · 공격 ${a} · 부유 ${y}`);
  }
  console.log(`\n기본 ${base}/${Object.keys(UNITS).length} · 공격모션 ${atk}종 · 부유모션 ${fly}종`);
  if (missing.length) console.log('실패:', missing.join(', '));
};

void main();
