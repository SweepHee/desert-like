/**
 * 동일 비용 결투 하네스 — 밸런스 점검용.
 *   node duel.ts "s_gouto:13" "s_treant:1,s_gouto:3" [seed]
 *   node duel.ts --stats            # 유닛별 비용 효율표
 *
 * 맵 중앙(수호탑 사거리 밖)에 두 부대를 마주 세우고 전멸까지 돌린다.
 */
import { createGame, stepGame, spawnUnit } from '../game.ts';
import { DEFS, unitsOfRace, RACE_NAMES } from '../data.ts';
import { FP, TICK_HZ, tiles } from '../math.ts';
import type { GameConfig, RaceId, TeamId } from '../types.ts';

const argv = process.argv.slice(2);

if (argv[0] === '--stats') {
  printStats();
  process.exit(0);
}

const compA = parseComp(argv[0] ?? 's_gouto:13');
const compB = parseComp(argv[1] ?? 's_treant:1,s_gouto:3');
const seed = Number(argv[2] ?? 1);

const result = duel(compA, compB, seed);
const fmtSide = (c: Record<string, number>) =>
  Object.entries(c).map(([id, n]) => `${DEFS[id]!.name}×${n}`).join(',');
console.log(`A [${fmtSide(compA)}] (${compCost(compA)}원)  vs  B [${fmtSide(compB)}] (${compCost(compB)}원)`);
console.log(`   → ${result.winner === -1 ? '무승부' : result.winner === 0 ? 'A 승' : 'B 승'}` +
  ` | ${result.sec.toFixed(1)}초 | 잔존가치 A ${result.valueA} vs B ${result.valueB}`);

function parseComp(s: string): Record<string, number> {
  const comp: Record<string, number> = {};
  for (const part of s.split(',')) {
    const [id, n] = part.split(':');
    if (!id || !DEFS[id]) {
      console.error(`알 수 없는 유닛: ${id}`);
      process.exit(1);
    }
    comp[id] = Number(n ?? 1);
  }
  return comp;
}

function compCost(comp: Record<string, number>): number {
  return Object.entries(comp).reduce((sum, [id, n]) => sum + DEFS[id]!.cost * n, 0);
}

export function duel(a: Record<string, number>, b: Record<string, number>, s: number) {
  const cfg: GameConfig = {
    seed: s,
    players: Array.from({ length: 6 }, (_, i) => ({
      race: 'sylvarin' as RaceId, isBot: false, team: (i < 3 ? 0 : 1) as TeamId,
    })),
  };
  const g = createGame(cfg);

  // 부대 배치: 중앙 기준 양쪽, 사거리 짧은 유닛이 앞열
  place(a, 0, tiles(42));
  place(b, 1, tiles(54));

  function place(comp: Record<string, number>, team: 0 | 1, baseX: number): void {
    const list: string[] = [];
    for (const [id, n] of Object.entries(comp)) for (let i = 0; i < n; i++) list.push(id);
    list.sort((x, y) => rangeKey(x) - rangeKey(y));
    const dir = team === 0 ? -1 : 1;
    for (let i = 0; i < list.length; i++) {
      const col = Math.floor(i / 5);
      const row = i % 5;
      spawnUnit(g, list[i]!, team, baseX + dir * col * tiles(0.8), (row - 2) * tiles(1.1));
    }
  }

  function rangeKey(id: string): number {
    const d = DEFS[id]!;
    if (d.heal && !d.weapon) return 1_000_000;
    return d.weapon ? d.weapon.range : 900_000;
  }

  const MAX = TICK_HZ * 120;
  const isArmy = (e: (typeof g.entities)[number]) => {
    const t = DEFS[e.defId]!.tier;
    return t !== 'structure' && t !== 'guardian';
  };
  while (g.tick < MAX) {
    stepGame(g);
    const a0 = g.entities.some((e) => e.alive && e.team === 0 && isArmy(e));
    const a1 = g.entities.some((e) => e.alive && e.team === 1 && isArmy(e));
    if (!a0 || !a1) break;
  }
  const value = (team: 0 | 1) =>
    g.entities.filter((e) => e.alive && e.team === team && isArmy(e))
      .reduce((sum, e) => sum + Math.round(DEFS[e.defId]!.cost * (e.hp / DEFS[e.defId]!.maxHp)), 0);
  const valueA = value(0);
  const valueB = value(1);
  return {
    winner: valueA === valueB ? -1 : valueA > valueB ? 0 : 1,
    sec: g.tick / TICK_HZ,
    valueA, valueB,
  };
}

function printStats(): void {
  for (const race of ['sylvarin', 'pandemonium', 'marionetta'] as RaceId[]) {
    console.log(`\n═══ ${RACE_NAMES[race]} ═══`);
    console.log('유닛              티어      비용   HP/원   DPS   DPS/100원  방어  사거리');
    for (const d of unitsOfRace(race)) {
      const dps = d.weapon ? d.weapon.damage / (d.weapon.cooldown / TICK_HZ) : 0;
      const row = [
        d.name.padEnd(9, '　'),
        d.tier.padEnd(8),
        String(d.cost).padStart(4),
        (d.maxHp / d.cost).toFixed(2).padStart(6),
        dps.toFixed(1).padStart(6),
        ((dps / d.cost) * 100).toFixed(1).padStart(8),
        String(d.armor).padStart(4),
        (d.weapon ? (d.weapon.range / FP).toFixed(1) : '-').padStart(6),
      ].join(' ');
      console.log(row + (d.weapon?.splash ? ' 광역' : '') + (d.heal ? ' 힐' : ''));
    }
  }
}
