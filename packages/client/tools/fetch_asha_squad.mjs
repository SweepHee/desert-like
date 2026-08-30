/**
 * 아샤 별동대 스프라이트 내려받기 — 픽셀랩 캐릭터 → 게임 에셋.
 *
 * fetch_karja.mjs 와 같은 규약이다:
 *   Idle/rotations/east.png   -> <id>.png       (전장 스프라이트)
 *   Idle/rotations/south.png  -> <id>_icon.png  (상점·강화 아이콘)
 *   east/west/north/south     -> <id>_e/_w/_n/_s.png  (4방향 — DIR_SPRITE_UNITS)
 *
 * 이들은 상점에 안 판다. 아샤의 「별동대 편성」 강화로만 따라 나오는
 * 캠페인 전용 유닛이라 공격 모션은 굽지 않았다 — 평타는 기본 그림으로 돈다.
 *
 * 실행: node packages/client/tools/fetch_asha_squad.mjs
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const API = 'https://api.pixellab.ai/mcp/characters';
const OUT = 'packages/client/public/assets/units';
const TMP = path.join(process.env.TEMP ?? '/tmp', 'asha_zip');

/** 게임 유닛 id → 픽셀랩 캐릭터 id (전부 v3 humanoid) */
const UNITS = {
  c_asha_chaser: 'e2c93628-a926-41c7-8ee1-9e1bcdcf8723',
  c_asha_venom: 'bcc5a644-ffce-4f41-85bc-d6410efb936c',
  c_asha_butcher: '0386cced-1c0f-46ec-af2c-0ef7ac7c139e',
  c_asha_sniper: '4df71b96-bb54-4be5-b5a2-05c9df9a5815',
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
dump('Idle/rotations/east.png', unit + '.png')
dump('Idle/rotations/south.png', unit + '_icon.png')
for d in ('east', 'west', 'north', 'south'):
    dump('Idle/rotations/%s.png' % d, '%s_%s.png' % (unit, d[0]))
print(' '.join(got))
`;

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  for (const [unit, cid] of Object.entries(UNITS)) {
    const res = await fetch(`${API}/${cid}/download`);
    if (!res.ok) { console.log(`  ${unit.padEnd(16)} 실패 ${res.status}`); continue; }
    const zp = path.join(TMP, `${unit}.zip`);
    fs.writeFileSync(zp, Buffer.from(await res.arrayBuffer()));
    const out = execFileSync('python', ['-c', PY, zp, OUT, unit], { encoding: 'utf8' }).trim();
    console.log(`  ${unit.padEnd(16)} ${out ? out.split(' ').length : 0}장`);
  }
};

void main();
