/**
 * 헤드리스 밸런스 시뮬레이션.
 *   node packages/sim/src/cli/battle.ts [seed] [종족목록] [팀인원 a:b]
 *
 * 종족 목록은 1팀부터 순서대로 나열한다. 팀 인원을 주면 비대칭 대전도 된다.
 *   ... 42 sylvarin,pandemonium 1:1
 *   ... 42 sylvarin,pandemonium,marionetta,marionetta 1:3
 * 생략하면 6명(3:3).
 */
import { createGame, stepGame, findStructure } from '../game.ts';
import { RACE_NAMES, MAP, DEFS } from '../data.ts';
import { TICK_HZ } from '../math.ts';
import type { GameConfig, RaceId, TeamId } from '../types.ts';

const seed = Number(process.argv[2] ?? 42);
const raceArg = process.argv[3];
const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];

const races: RaceId[] = raceArg
  ? (raceArg.split(',') as RaceId[])
  : Array.from({ length: 6 }, (_, i) => RACES[(seed + i) % 3]!);

if (races.some((r) => !RACES.includes(r))) {
  console.error('종족은 sylvarin|pandemonium|marionetta 중에서 콤마로 나열하세요.');
  process.exit(1);
}

// 팀 인원: "a:b" 로 지정. 없으면 절반씩 나눈다.
const sizeArg = process.argv[4];
let sizeA: number;
let sizeB: number;
if (sizeArg) {
  const [x, y] = sizeArg.split(':').map(Number);
  sizeA = x!;
  sizeB = y!;
} else {
  sizeA = Math.floor(races.length / 2);
  sizeB = races.length - sizeA;
}
if (!(sizeA >= 1 && sizeB >= 1) || sizeA + sizeB !== races.length) {
  console.error(`팀 인원(${sizeA}:${sizeB})과 종족 수(${races.length})가 맞지 않습니다.`);
  process.exit(1);
}

const cfg: GameConfig = {
  seed,
  players: races.map((race, i) => ({ race, isBot: true, team: (i < sizeA ? 0 : 1) as TeamId })),
};
const g = createGame(cfg);

const MAX_TICKS = TICK_HZ * 60 * 25; // 25분 상한

const fmt = (t: number) => {
  const s = Math.floor(t / TICK_HZ);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

console.log(`시드 ${seed}`);
console.log(`1팀: ${races.slice(0, 3).map((r) => RACE_NAMES[r]).join(', ')}`);
console.log(`2팀: ${races.slice(3).map((r) => RACE_NAMES[r]).join(', ')}`);
console.log('─'.repeat(60));

let lastNexusReport = [100, 100];

while (!g.over && g.tick < MAX_TICKS) {
  stepGame(g);
  for (const ev of g.events) {
    if (ev.kind === 'wave') console.log(`[${fmt(ev.tick)}] ${ev.slot! + 1}번 유저들 출정 (전장 유닛 ${g.entities.filter((e) => e.alive).length}개)`);
    if (ev.kind === 'towerDown') console.log(`[${fmt(ev.tick)}] *** ${ev.team! + 1}팀 수호탑 파괴!`);
    if (ev.kind === 'guardianSpawn') console.log(`[${fmt(ev.tick)}] >>> ${ev.team! + 1}팀 수호자(${ev.defId ? DEFS[ev.defId]?.name ?? ev.defId : ev.team === 0 ? '드래곤' : '슬리피 할로우'}) 젠`);
    if (ev.kind === 'guardianDown') console.log(`[${fmt(ev.tick)}] xxx ${ev.team! + 1}팀 수호자 사망`);
  }
  // 넥서스 체력 10% 단위 리포트
  for (const team of [0, 1] as const) {
    const nx = findStructure(g, 'nexus', team);
    if (!nx) continue;
    const pct = Math.floor((nx.hp / DEFS.nexus!.maxHp) * 100);
    if (pct <= lastNexusReport[team]! - 10) {
      lastNexusReport[team] = pct;
      console.log(`[${fmt(g.tick)}] ${team + 1}팀 넥서스 ${pct}%`);
    }
  }
}

console.log('─'.repeat(60));
if (g.over) {
  console.log(`승리: ${g.over.winner + 1}팀 (${fmt(g.tick)})`);
} else {
  const hp0 = findStructure(g, 'nexus', 0)?.hp ?? 0;
  const hp1 = findStructure(g, 'nexus', 1)?.hp ?? 0;
  console.log(`시간 초과 — 넥서스 HP 1팀 ${hp0} vs 2팀 ${hp1}`);
}
for (const p of g.players) {
  const comp = Object.entries(p.comp)
    .map(([id, n]) => `${DEFS[id]!.name}×${n}`)
    .join(', ');
  console.log(`  P${p.idx} (${p.team + 1}팀/${RACE_NAMES[p.race]}) 인컴Lv${p.incomeLevel}: ${comp || '(없음)'}`);
}
