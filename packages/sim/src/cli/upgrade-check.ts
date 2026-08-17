/**
 * 업그레이드 시스템 스모크 테스트.
 *   node packages/sim/src/cli/upgrade-check.ts
 */
import { createGame, stepGame, buyUnit, buyUpgrade } from '../game.ts';
import { DEFS, MAP, effectiveDef } from '../data.ts';
import type { TeamId } from '../types.ts';

const g = createGame({
  seed: 1,
  players: Array.from({ length: 6 }, (_, i) => ({
    race: 'sylvarin' as const, isBot: false, team: (i < 3 ? 0 : 1) as TeamId,
  })),
});
const p = g.players[0]!;
p.money = 5000;

let fails = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
};

check('테크1에서 구매 거부', buyUpgrade(g, 0, 'su_gouto_fur') === false);
p.techLevel = 2;
check('테크2에서 구매 성공', buyUpgrade(g, 0, 'su_gouto_fur') === true);
check('중복 구매 거부', buyUpgrade(g, 0, 'su_gouto_fur') === false);
check('택1 첫 선택 성공', buyUpgrade(g, 0, 'su_elf_pierce') === true);
check('택1 두번째 거부', buyUpgrade(g, 0, 'su_elf_longbow') === false);
check('타종족 업그레이드 거부', buyUpgrade(g, 0, 'pu_skel_saw') === false);

const effG = effectiveDef('s_gouto', p.upgrades)!;
check(`고우토 방어 ${DEFS.s_gouto!.armor}→${effG.armor}`, effG.armor === DEFS.s_gouto!.armor + 1);
const effE = effectiveDef('s_elf_archer', p.upgrades)!;
check(`엘프 궁수 관통 스플래시 ${effE.weapon!.splash}`, (effE.weapon!.splash ?? 0) === 600);

buyUnit(g, 0, 's_gouto');
while (g.tick <= MAP.PREP_TICKS + 1) stepGame(g);
const spawned = g.entities.find((e) => e.owner === 0 && e.defId === 's_gouto');
check('출정 유닛에 defOv 반영', spawned?.defOv?.armor === DEFS.s_gouto!.armor + 1);

process.exit(fails === 0 ? 0 : 1);
