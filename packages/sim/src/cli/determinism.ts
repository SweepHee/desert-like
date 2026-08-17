/**
 * 결정론 검증: 같은 시드로 두 번 돌려 매 1000틱 상태 해시를 비교한다.
 *   node packages/sim/src/cli/determinism.ts [seed]
 */
import { createGame, stepGame, hashGame } from '../game.ts';
import type { GameConfig, RaceId, TeamId } from '../types.ts';

const seed = Number(process.argv[2] ?? 7);
const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];
const cfg: GameConfig = {
  seed,
  players: Array.from({ length: 6 }, (_, i) => ({
    race: RACES[(seed + i) % 3]!, isBot: true, team: (i < 3 ? 0 : 1) as TeamId,
  })),
};

const TICKS = 20 * 60 * 12; // 12분

function run(): number[] {
  const g = createGame(cfg);
  const hashes: number[] = [];
  for (let t = 0; t < TICKS && !g.over; t++) {
    stepGame(g);
    if (g.tick % 1000 === 0) hashes.push(hashGame(g));
  }
  hashes.push(hashGame(g));
  return hashes;
}

const a = run();
const b = run();

if (a.length !== b.length || a.some((h, i) => h !== b[i])) {
  console.error('결정론 실패! 해시 불일치:');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) console.error(`  checkpoint ${i}: ${a[i]?.toString(16)} != ${b[i]?.toString(16)}`);
  }
  process.exit(1);
}
console.log(`결정론 OK — ${a.length}개 체크포인트 일치 (시드 ${seed})`);
