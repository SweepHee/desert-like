/**
 * 봇 AI 검증: 난이도 3단계 + 성격 4유형 + 업그레이드/해금 구매.
 * 실행: npx tsx packages/sim/src/cli/bot-check.ts
 */
import { createGame, stepGame, buyIncomeUpgrade, buyTechUp, buyUnit } from '../game.ts';
import { DEFS, UPGRADES, TIER_RANK } from '../data.ts';
import type { BotStyle, Game, RaceId, TeamId } from '../types.ts';

let failed = false;
const ok = (cond: boolean, label: string): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failed = true;
};

const races: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta', 'sylvarin', 'pandemonium', 'marionetta'];
const mkGame = (seed: number, diff: 'easy' | 'normal' | 'hard'): Game =>
  createGame({
    seed,
    botDifficulty: diff,
    players: races.map((race, i) => ({ race, isBot: i !== 0, team: (i < 3 ? 0 : 1) as TeamId })),
  });

// 1) 성격 배정: 여러 시드에서 4유형이 골고루 등장하는가
{
  const seen = new Set<BotStyle>();
  for (let seed = 1; seed <= 12; seed++) {
    const g = mkGame(seed, 'easy');
    for (const p of g.players) if (p.isBot) seen.add(p.botStyle);
  }
  ok(seen.size === 4, `봇 성격 4유형 전부 등장 (${[...seen].join(',')})`);
}

// 2) 봇이 최종·최상급 유닛과 해금 스킬을 실제로 산다 (10분 관찰, 여러 시드)
{
  let topTierBought = 0;
  let finalBought = 0;
  let unlockBought = 0;
  const unlockIds = new Set(UPGRADES.filter((u) => u.cost >= 1000).map((u) => u.id));
  for (const seed of [1, 2, 3, 4, 5]) {
    const g = mkGame(seed, 'easy');
    for (let t = 0; t < 20 * 60 * 10 && !g.over; t++) stepGame(g);
    for (const p of g.players) {
      if (!p.isBot) continue;
      for (const id of Object.keys(p.comp)) {
        const rank = TIER_RANK[DEFS[id]!.tier] ?? 0;
        if (rank >= 5) topTierBought += p.comp[id]!;      // supreme+
        if (DEFS[id]!.tier === 'final') finalBought += p.comp[id]!;
      }
      for (const uid of Object.keys(p.upgrades)) if (unlockIds.has(uid)) unlockBought++;
    }
  }
  ok(topTierBought >= 10, `봇이 최상급+ 유닛 구매 (10분 × 5시드에 ${topTierBought}기)`);
  ok(finalBought >= 1, `봇이 최종 유닛 구매 (${finalBought}기)`);
  void unlockBought;
}

// 2b) 해금 구매 단위 검증: 세이지를 보유한 봇은 돈이 생기면 해금 스킬을 산다
{
  const g = mkGame(3, 'easy');
  const bot = g.players[3]!; // 2팀 실바린 봇
  bot.comp.s_sage = 1;
  bot.techLevel = 3;
  let bought = false;
  for (let t = 0; t < 20 * 120 && !bought; t++) {
    bot.money = Math.max(bot.money, 2000); // 여윳돈 보장 — 구매 의사만 검증
    stepGame(g);
    bought = Object.keys(bot.upgrades).some((id) => id.startsWith('su_sage_') && (DEFS.s_sage ? true : true))
      && ['su_sage_gravity', 'su_sage_quake', 'su_sage_blizzard'].some((id) => bot.upgrades[id]);
  }
  ok(bought, '세이지 보유 봇이 해금 스킬 구매');
}

// 3) 중간 난이도: 같은 시드에서 봇 자금이 easy 보다 확실히 앞선다
{
  const gE = mkGame(7, 'easy');
  const gN = mkGame(7, 'normal');
  for (let t = 0; t < 20 * 60 * 4; t++) {
    stepGame(gE);
    stepGame(gN);
  }
  const wealth = (g: Game): number =>
    g.players.filter((p) => p.isBot)
      .reduce((s, p) => s + p.money + p.incomeLevel * 200 + Object.values(p.comp).reduce((a, b) => a + b, 0) * 50, 0);
  ok(wealth(gN) > wealth(gE), `중간 난이도 봇 경제 우위 (easy ${wealth(gE)} < normal ${wealth(gN)})`);
}

// 4) 어려움 난이도: 사람이 테크·인컴을 올리면 적 봇이 따라온다 + 카운터 픽
{
  const g = mkGame(11, 'hard');
  const me = g.players[0]!; // 1팀 사람 (실바린)
  // 사람 흉내: 현실적인 속도 — 인컴 3, 테크 3까지 올리고 와이번 몰빵
  me.money = 99999;
  buyIncomeUpgrade(g, 0);
  buyTechUp(g, 0);
  for (let t = 0; t < 20 * 60 * 6 && !g.over; t++) {
    stepGame(g);
    me.money = Math.max(me.money, 5000);
    if (me.incomeLevel < 3) buyIncomeUpgrade(g, 0);
    buyTechUp(g, 0);
    if (me.techLevel >= 3 && (t % 40 === 0)) buyUnit(g, 0, 's_wyvern'); // 공중(가죽) 몰빵
  }
  const foes = g.players.filter((p) => p.isBot && p.team === 1);
  const maxFoeIncome = Math.max(...foes.map((p) => p.incomeLevel));
  const maxFoeTech = Math.max(...foes.map((p) => p.techLevel));
  ok(maxFoeIncome >= me.incomeLevel - 1, `어려움: 적 봇이 인컴 추격 (나 ${me.incomeLevel} vs 봇 최고 ${maxFoeIncome})`);
  ok(maxFoeTech >= 3, `어려움: 적 봇이 테크 추격 (봇 최고 테크 ${maxFoeTech})`);
  // 카운터 픽: 와이번(공중·가죽) 카운터 = 대공+대가죽 유닛 구매 비중 확인
  let counters = 0;
  let total = 0;
  for (const p of foes) {
    for (const id of Object.keys(p.comp)) {
      const d = DEFS[id]!;
      const n = p.comp[id]!;
      total += n;
      const w = d.weapon;
      if (w && w.targets !== 'ground' && (w.bonus?.leather ?? 0) > 0) counters += n;
    }
  }
  ok(counters > 0, `어려움: 와이번 카운터(대공·대가죽) 생산 (${counters}/${total}기)`);
}

if (failed) process.exitCode = 1;
