import { DEFS } from '../data.ts';
import { createGame, stepGame } from '../game.ts';
const camps = [0, 1].map((slot) => ({
  slot, startIncome: 3, incomeCap: 3, startMoney: 1000,
  phases: [
    { fromWave: 1, units: ['p_deadman', 'p_hound', 'p_bone_thrower'] },
    { fromWave: 4, units: ['p_headless_knight', 'p_lich'] },
    { fromWave: 6, units: ['p_headless_knight', 'p_lich'] },
    { fromWave: 9, units: ['p_lich', 'p_corpse_golem', 'p_thanatos'] },
    { fromWave: 10, units: ['p_lich', 'p_banshee', 'p_corpse_golem', 'p_thanatos'] },
  ],
  incomeUnlocks: [{ fromWave: 6, cap: 8, setLevel: 5 }],
  spendAll: true,
}));
const g = createGame({
  seed: 102950, mapId: 'ashroad', botDifficulty: 'normal',
  enemyStartTech: 4, enemyCapsUntilWave: 28, enemyUnitCaps: { p_mammon: 30 },
  enemyCamps: camps,
  players: [
    { race: 'sylvarin', isBot: true, team: 0 }, { race: 'sylvarin', isBot: true, team: 0 },
    { race: 'pandemonium', isBot: true, team: 1 }, { race: 'pandemonium', isBot: true, team: 1 },
  ],
} as never);
for (const e of g.entities) if (e.defId === 'nexus') e.invulnUntil = Number.MAX_SAFE_INTEGER;
for (const w of [2, 5, 6, 7, 9, 11, 13]) {
  while (g.waveIndex < w - 1 && g.tick < 20 * 60 * 14 && !g.over) stepGame(g);
  const c: Record<string, number> = {};
  for (const p of g.players) if (p.team === 1) for (const [k, v] of Object.entries(p.comp)) c[k] = (c[k] ?? 0) + v;
  const inc = g.players.filter((p) => p.team === 1).map((p) => p.incomeLevel).join('/');
  const tot = Object.values(c).reduce((a, b) => a + b, 0);
  const top = Object.entries(c).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, v]) => `${DEFS[k]?.name ?? k}×${v}`).join(' ');
  console.log(`${w}턴 인컴 ${inc}  총 ${tot}기  ${top}`);
}
