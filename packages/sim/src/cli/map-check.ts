/**
 * 밸리 맵(--_--) 경로 추종 검증.
 *   node packages/sim/src/cli/map-check.ts
 */
import { createGame, stepGame } from '../game.ts';
import { MAPS, laneCenterY } from '../data.ts';
import { FP, TICK_HZ, tiles } from '../math.ts';
import type { RaceId, TeamId } from '../types.ts';

const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];
const g = createGame({
  seed: 5,
  mapId: 'valley',
  players: Array.from({ length: 6 }, (_, i) => ({
    race: RACES[i % 3]!, isBot: true, team: (i < 3 ? 0 : 1) as TeamId,
  })),
});

const m = MAPS.valley!;
let checked = 0;
let inLane = 0;
let dipVisitors = 0;

for (let t = 0; t < TICK_HZ * 60 * 6 && !g.over; t++) {
  stepGame(g);
  if (g.tick % 100 !== 0) continue;
  for (const e of g.entities) {
    if (!e.alive || e.owner < 0) continue;
    checked++;
    const c = laneCenterY(m, e.x);
    if (Math.abs(e.y - c) <= m.halfW + 100) inLane++;
    // 계곡 바닥 구간(x 40~56타일)에 도달했고 y가 내려가(7타일 이상) 있는가
    if (e.x > tiles(40) && e.x < tiles(56) && e.y > tiles(6)) dipVisitors++;
  }
}

console.log(`샘플 ${checked}개 / 코리도어 안 ${inLane}개 (${Math.round((inLane / checked) * 100)}%)`);
console.log(`계곡 바닥 통과 관측: ${dipVisitors}회`);
console.log(`구조물 y: ` + g.entities.filter((e) => e.owner < 0).map((e) => `${e.defId}(${Math.round(e.x / FP)},${Math.round(e.y / FP)})`).join(' '));
if (inLane / checked > 0.99 && dipVisitors > 50) console.log('PASS — 유닛이 --_-- 코리도어를 따라 이동함');
else console.log('FAIL');
