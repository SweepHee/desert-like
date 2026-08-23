/*
 * 스프라이트 세트 짝 맞춤 검사.
 *
 * 유닛 그림을 새로 뽑으면서 방향 4장만 갈아 끼우고 공격 프레임을 그대로 두면,
 * 전장·강화 패널에서 「예전 캐릭터」가 튀어나온다 (레쉬·세이지에서 실제로 났던 사고).
 * 파일 수정 시각을 견줘 그런 짝을 찾아낸다.
 *
 * 실행: node packages/client/tools/check-sprite-sets.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNITS = join(dirname(fileURLToPath(import.meta.url)), '../public/assets/units');
/** 이 이상 벌어지면 「같이 뽑은 세트가 아니다」로 본다. */
const GAP_MS = 24 * 60 * 60 * 1000;

const files = readdirSync(UNITS).filter((f) => f.endsWith('.png'));
const mtime = (f) => statSync(join(UNITS, f)).mtimeMs;
// toISOString 은 UTC 라 한국 새벽에 뽑은 파일이 전날로 보인다 — 현지 날짜로 찍는다
const day = (ms) => new Date(ms).toLocaleDateString('sv-SE');

// 파생 파일(_e/_n/_s/_w/_icon/_atk*/_fly*/_air*/_aim)을 뺀 나머지가 유닛 id
const derived = /_(e|n|s|w|icon|aim|atk\d|fly\d|air\d)\.png$/;
const bad = [];
for (const f of files) {
  if (derived.test(f)) continue;
  const id = f.slice(0, -4);
  const atks = files.filter((x) => x.startsWith(`${id}_atk`) || x.startsWith(`${id}_fly`)
    || x.startsWith(`${id}_air`));
  if (atks.length === 0) continue;
  const base = mtime(f);
  const motion = Math.max(...atks.map(mtime));
  if (base - motion > GAP_MS) bad.push({ id, base, motion });
}

if (bad.length === 0) {
  console.log(`OK — 검사한 유닛 그림 ${files.length}장에서 어긋난 세트 없음`);
  process.exit(0);
}
console.log(`어긋난 세트 ${bad.length}종 — 베이스가 동작 프레임보다 하루 이상 새롭다:`);
for (const b of bad) console.log(`  ${b.id.padEnd(24)} 베이스 ${day(b.base)}  /  동작 ${day(b.motion)}`);
console.log('\n픽셀랩에서 지금 캐릭터로 동작을 다시 뽑아 덮어써야 한다.');
process.exit(1);
