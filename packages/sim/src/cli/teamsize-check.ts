/**
 * 팀 인원 가변(1:1, 1:2, 2:3 …) 검증.
 * 실행: npx tsx packages/sim/src/cli/teamsize-check.ts
 */
import { createGame, stepGame, nextWaveInfo } from '../game.ts';
import { MAP } from '../data.ts';
import type { RaceId, TeamId } from '../types.ts';

let failed = false;
const ok = (cond: boolean, label: string): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failed = true;
};

const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];

function make(a: number, b: number, seed = 3) {
  return createGame({
    seed,
    players: Array.from({ length: a + b }, (_, i) => ({
      race: RACES[i % 3]!,
      isBot: true,
      team: (i < a ? 0 : 1) as TeamId,
    })),
  });
}

// ── 구성 검증 ──────────────────────────────────────────────────────────────
for (const [a, b] of [[1, 1], [1, 2], [2, 1], [1, 3], [2, 2], [2, 3], [3, 3]] as const) {
  const g = make(a, b);
  const t0 = g.players.filter((p) => p.team === 0);
  const t1 = g.players.filter((p) => p.team === 1);
  const slots0 = t0.map((p) => p.slot).sort((x, y) => x - y);
  const slots1 = t1.map((p) => p.slot).sort((x, y) => x - y);
  const expect0 = Array.from({ length: a }, (_, i) => i);
  const expect1 = Array.from({ length: b }, (_, i) => i);
  ok(
    g.teamSize[0] === a && g.teamSize[1] === b
      && JSON.stringify(slots0) === JSON.stringify(expect0)
      && JSON.stringify(slots1) === JSON.stringify(expect1),
    `${a}:${b} 구성 — 팀 인원/순번 정상`,
  );
}

// ── 출정 로테이션: 팀마다 독립적으로 돌아야 한다 ────────────────────────────
{
  const a = 1, b = 3;
  const g = make(a, b);
  // 각 플레이어가 몇 번 출정했는지: 웨이브 이벤트 대신 유닛 스폰으로 확인
  for (const p of g.players) {
    p.money = 100000;
    p.comp = { s_gouto: 1 };
  }
  // 부대 규모는 봇 구매로 계속 커지므로 유닛 수가 아니라 "출정한 횟수"를 센다.
  // 한 틱에 그 플레이어의 유닛이 새로 생겼다면 그 웨이브에 출정한 것.
  const byOwner = new Map<number, number>();
  const seen = new Set<number>();
  for (const e of g.entities) seen.add(e.id);
  const total = MAP.PREP_TICKS + MAP.WAVE_TICKS * 6;
  for (let t = 0; t < total; t++) {
    stepGame(g);
    // 소환 스킬(앨리스 봉제곰 등)도 유닛을 만들므로, 출정 웨이브 틱만 센다
    const isWaveTick = g.events.some((ev) => ev.kind === 'wave');
    const deployedThisTick = new Set<number>();
    for (const e of g.entities) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.owner >= 0 && isWaveTick) deployedThisTick.add(e.owner);
    }
    for (const owner of deployedThisTick) byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
  }
  const solo = byOwner.get(0) ?? 0;                      // 1인 팀의 유일한 플레이어
  const trio = [1, 2, 3].map((i) => byOwner.get(i) ?? 0); // 3인 팀
  ok(solo >= 5, `1인 팀은 매 웨이브 출정 (6웨이브 중 ${solo}회)`);
  ok(trio.every((n) => n >= 1 && n <= 3), `3인 팀은 번갈아 출정 (각 ${trio.join('/')}회)`);
  ok(solo > Math.max(...trio), '1인 팀 출정 빈도 > 3인 팀 개인 빈도');
}

// ── 스폰 y 밴드: 인원 수에 맞게 퍼져야 한다 ─────────────────────────────────
{
  const g1 = make(1, 1);
  const p = g1.players[0]!;
  p.money = 100000;
  p.comp = { s_gouto: 1 };
  for (let t = 0; t <= MAP.PREP_TICKS; t++) stepGame(g1);
  const mine = g1.entities.filter((e) => e.defId === 's_gouto' && e.owner === 0);
  const avgY = mine.reduce((s, e) => s + e.y, 0) / Math.max(1, mine.length);
  ok(mine.length > 0 && Math.abs(avgY) < 1500, `1인 팀은 레인 중앙 스폰 (평균 y=${Math.round(avgY)})`);
}

// ── 웨이브 안내: 팀별 순번 ──────────────────────────────────────────────────
{
  const g = make(1, 3);
  const info = nextWaveInfo(g);
  ok(info.slots[0] === 0 && info.slots[1] === 0, '웨이브0 순번 = 양 팀 0번');
  g.waveIndex = 4;
  const i2 = nextWaveInfo(g);
  ok(i2.slots[0] === 0 && i2.slots[1] === 1, `웨이브4 순번 = 1팀 0번 / 2팀 1번 (실제 ${i2.slots.join(',')})`);
}

// ── 최소 인원 방어 ─────────────────────────────────────────────────────────
{
  let threw = false;
  try {
    createGame({ seed: 1, players: [{ race: 'sylvarin', isBot: true, team: 0 }] });
  } catch {
    threw = true;
  }
  ok(threw, '한 팀이 비면 게임 생성 거부');
}

if (failed) process.exitCode = 1;
