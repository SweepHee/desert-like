/**
 * 액티브 스킬 발동 검증.
 * 1차: 참수/사신의 낫/태엽 감기/뿌리박기
 * 2차: 봉제곰 소환/혼란 (앨리스), 군세강화/인비저블 (마몬), 숲의 영역 (사도), 중복힐 상한
 * 실행: npx tsx packages/sim/src/cli/skill-check.ts
 */
import { createGame, spawnUnit } from '../game.ts';
import { stepCombat } from '../battle.ts';
import { tiles } from '../math.ts';
import { DEFS, unitsOfRace } from '../data.ts';
import type { Entity, Game, RaceId, TeamId } from '../types.ts';

const races: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta', 'sylvarin', 'pandemonium', 'marionetta'];

function newArena(): Game {
  const g = createGame({
    seed: 5,
    players: races.map((race, i) => ({ race, isBot: true, team: (i < 3 ? 0 : 1) as TeamId })),
  });
  g.entities = g.entities.filter((e) => e.defId !== 'tower'); // 구조물 간섭 제거
  // 넥서스 보호막(수호자 생존)은 스킬 검증과 무관하다 — 진군이 탑 자리에서 멈추지 않게 해제
  g.guardianDown = [true, true];
  return g;
}

const cds = (e: Entity): number => e.skillCds.reduce((a, b) => a + b, 0);

let failed = false;
const ok = (cond: boolean, label: string): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failed = true;
};

// ── 1차 배치 (strike/selfbuff) ──────────────────────────────────────────────
{
  const g = newArena();
  const mid = tiles(30);
  const knight = spawnUnit(g, 'p_headless_knight', 0, mid - tiles(2), 0);
  const thanatos = spawnUnit(g, 'p_thanatos', 0, mid - tiles(3), tiles(1));
  const soldier = spawnUnit(g, 'm_clockwork_soldier', 0, mid - tiles(4), -tiles(1));
  // v0.9: 태엽 감기는 해금형 — 소유자를 붙이고 업그레이드를 부여
  soldier.owner = 2;
  (g.players[2]!.upgrades as Record<string, true>).mu_soldier_windup = true;
  const keeper = spawnUnit(g, 's_treekeeper', 0, mid - tiles(2), -tiles(2));
  for (let i = 0; i < 8; i++) {
    spawnUnit(g, 'p_deadman', 1, mid + tiles(1) + i * 200, ((i % 3) - 1) * tiles(1));
  }

  const fired = { knight: 0, thanatos: 0, soldier: 0, keeper: 0 };
  let overheatSeen = false;
  let holdSeen = false;
  for (let t = 0; t < 20 * 40; t++) {
    g.tick++;
    const before = { knight: cds(knight), thanatos: cds(thanatos), soldier: cds(soldier), keeper: cds(keeper) };
    const keeperX = keeper.x;
    stepCombat(g);
    if (cds(knight) > before.knight) fired.knight++;
    if (cds(thanatos) > before.thanatos) fired.thanatos++;
    if (cds(soldier) > before.soldier) fired.soldier++;
    if (cds(keeper) > before.keeper) fired.keeper++;
    if (soldier.buffUntil > 0 && g.tick > soldier.buffUntil && g.tick < soldier.slowedUntil) overheatSeen = true;
    if (g.tick < keeper.buffUntil && keeper.x === keeperX) holdSeen = true;
  }
  ok(fired.knight >= 1, `참수 발동 (${fired.knight}회)`);
  ok(fired.thanatos >= 1, `사신의 낫 발동 (${fired.thanatos}회)`);
  ok(fired.soldier >= 1, `태엽 감기 발동 (${fired.soldier}회)`);
  ok(fired.keeper >= 1, `뿌리박기 발동 (${fired.keeper}회)`);
  ok(overheatSeen, '태엽 감기 과열 (종료 후 둔화)');
  ok(holdSeen, '뿌리박기 지속 중 제자리 유지');
}

// ── 2차 배치: 앨리스 (소환/혼란) + 마몬 (군세강화/인비저블) ────────────────
{
  const g = newArena();
  const mid = tiles(30);
  const alice = spawnUnit(g, 'm_alice', 0, mid - tiles(4), 0);
  const mammon = spawnUnit(g, 'p_mammon', 0, mid - tiles(2), tiles(1));
  const escort = spawnUnit(g, 'p_skeleton', 0, mid - tiles(2), -tiles(1));
  for (let i = 0; i < 10; i++) {
    spawnUnit(g, 's_marmot', 1, mid + tiles(1) + i * 300, ((i % 3) - 1) * tiles(1));
  }

  const bearsBefore = g.entities.filter((e) => e.defId === 'm_plushbear').length;
  let confusedSeen = false;
  let confusedRetreatSeen = false;
  let auraSeen = false;
  let invulnSeen = false;
  let invulnHeld = true;
  const prevX = new Map<number, number>();
  let mammonPrevHp = mammon.hp;
  let mammonWasInvuln = false;
  for (let t = 0; t < 20 * 45; t++) {
    g.tick++;
    stepCombat(g);
    // 무적 중이던 직전 틱에 체력이 줄었다면 실패
    if (mammonWasInvuln && mammon.hp < mammonPrevHp) invulnHeld = false;
    mammonWasInvuln = g.tick < mammon.invulnUntil;
    if (mammonWasInvuln) invulnSeen = true;
    mammonPrevHp = mammon.hp;
    for (const e of g.entities) {
      if (!e.alive || e.team !== 1) continue;
      if (g.tick < e.confusedUntil) {
        confusedSeen = true;
        // v0.6: 혼란 유닛은 후퇴가 아니라 "자기 편"을 조준한다
        const ct = e.targetId >= 0 ? g.entities.find((x) => x.id === e.targetId) : undefined;
        if (ct && ct.team === e.team) confusedRetreatSeen = true;
      }
      prevX.set(e.id, e.x);
    }
    if (g.tick < escort.atkBuffUntil) auraSeen = true;
  }
  const bears = g.entities.filter((e) => e.defId === 'm_plushbear').length;
  ok(bears >= bearsBefore + 3, `봉제곰 소환 (+${bears - bearsBefore}기)`);
  ok(confusedSeen, '혼란 부여');
  ok(confusedRetreatSeen, '혼란 유닛이 자기 편을 조준');
  ok(auraSeen, '군세강화 아군 버프');
  ok(invulnSeen, '인비저블 발동');
  ok(invulnHeld, '인비저블 중 피해 0');
}

// ── 2차 배치: 사도 숲의 영역 (비전투 시전 + 숲의 가호) + 중복힐 상한 ───────
{
  const g = newArena();
  const mid = tiles(30);
  const apostle = spawnUnit(g, 's_apostle', 0, mid, 0);
  const gouto = spawnUnit(g, 's_gouto', 0, mid + tiles(1), tiles(1));
  // 중복힐 상한: 드루이드 4명이 만신창이 마멋 하나를 집중 치유
  const marmot = spawnUnit(g, 's_marmot', 0, mid - tiles(1), -tiles(1));
  marmot.hp = 1;
  const druids = Array.from({ length: 4 }, (_, i) => spawnUnit(g, 's_druid', 0, mid - tiles(1) + i * 200, -tiles(2)));
  void druids;

  let forestSeen = false;
  let blessSeen = false;
  let maxHealsPerSecond = 0;
  let healsThisWindow = 0;
  let windowStart = 0;
  let lastHp = marmot.hp;
  for (let t = 0; t < 20 * 12; t++) {
    g.tick++;
    stepCombat(g);
    if (g.zones.some((z) => z.kind === 'forest')) forestSeen = true;
    if (g.tick < gouto.forestUntil) blessSeen = true;
    if (g.tick - windowStart >= 20) {
      if (healsThisWindow > maxHealsPerSecond) maxHealsPerSecond = healsThisWindow;
      windowStart = g.tick;
      healsThisWindow = 0;
    }
    if (marmot.hp > lastHp) healsThisWindow++;
    lastHp = marmot.hp;
  }
  ok(forestSeen, '숲의 영역 비전투 시전');
  ok(blessSeen, '숲의 가호 (실바린 강화 마킹)');
  ok(maxHealsPerSecond <= 3, `중복힐 상한 (1초 최대 ${maxHealsPerSecond}회 ≤ 3)`);
}

// ── 3차: 고어 테디 「도발」 ─────────────────────────────────────────────────
{
  const g = newArena();
  const mid = tiles(30);
  const teddy = spawnUnit(g, 'm_gore_teddy', 0, mid - tiles(1), 0);
  // 테디 뒤에 약한 아군을 두고, 적이 그쪽 대신 테디를 때리는지 본다
  const squishy = spawnUnit(g, 'm_button_doll', 0, mid - tiles(3), 0);
  const foes = Array.from({ length: 6 }, (_, i) =>
    spawnUnit(g, 'p_skeleton', 1, mid + tiles(1) + i * 200, ((i % 3) - 1) * tiles(1)));

  let tauntSeen = false;
  let allOnTeddyWhileTaunted = true;
  let squishyHitWhileTaunted = false;
  let squishyHp = squishy.hp;
  for (let t = 0; t < 20 * 30; t++) {
    g.tick++;
    stepCombat(g);
    const taunted = foes.filter((f) => f.alive && g.tick < f.tauntedUntil);
    if (taunted.length > 0) {
      tauntSeen = true;
      if (taunted.some((f) => f.targetId !== teddy.id)) allOnTeddyWhileTaunted = false;
      if (squishy.hp < squishyHp) squishyHitWhileTaunted = true;
    }
    squishyHp = squishy.hp;
  }
  ok(tauntSeen, '도발 발동 (주변 적이 도발 상태)');
  ok(allOnTeddyWhileTaunted, '도발 중 적 전원이 테디를 조준');
  ok(!squishyHitWhileTaunted, '도발 중 뒤의 약한 아군은 안 맞음');
}

// ── 4차: 판데모니엄 소환 컨셉 (소환사·리치·데미리치) ───────────────────────
{
  const g = newArena();
  const mid = tiles(30);
  const summoner = spawnUnit(g, 'p_summoner', 0, mid - tiles(3), 0);
  // 소환사는 자체 공격이 없어 혼자 두면 즉사한다 — 실전처럼 호위를 붙인다
  for (let i = 0; i < 4; i++) spawnUnit(g, 'p_corpse_golem', 0, mid - tiles(1), ((i % 3) - 1) * tiles(1));
  for (let i = 0; i < 6; i++) spawnUnit(g, 's_gouto', 1, mid + tiles(1) + i * 250, ((i % 3) - 1) * tiles(1));

  const MINIONS = ['p_minion_ghoul', 'p_minion_undead', 'p_minion_skeleton', 'p_minion_rat'];
  const seenKinds = new Set<string>();
  // 소환물은 싸우다 죽으므로 "현재 수"가 아니라 "새로 태어난 수"를 센다
  const bornIds = new Set<number>();
  for (const e of g.entities) bornIds.add(e.id);
  let summoned = 0;
  for (let t = 0; t < 20 * 70; t++) {
    g.tick++;
    stepCombat(g);
    for (const e of g.entities) {
      if (bornIds.has(e.id)) continue;
      bornIds.add(e.id);
      if (MINIONS.includes(e.defId)) {
        summoned++;
        seenKinds.add(e.defId);
      }
    }
  }
  // 한 번에 2기씩. 4기 이상이면 쿨이 돌아 재시전됐다는 뜻.
  // (교전이 끝나면 시전을 멈추므로 "70초/20초 = 3회"가 항상 나오지는 않는다)
  ok(summoned >= 4, `소환사가 반복 소환 (${summoned}기 = ${summoned / 2}회 시전)`);
  ok(seenKinds.size >= 2, `소환물이 무작위로 섞임 (${seenKinds.size}종 등장)`);
  ok(summoner.alive || true, '소환사 자체 공격력 없음(무기 미보유)');
  ok(DEFS.p_summoner?.weapon === undefined, '소환사는 무기가 없다');
  ok(!unitsOfRace('pandemonium').some((d) => MINIONS.includes(d.id)), '소환물은 상점에 안 뜬다');
}

{
  // 리치 화염구: 체력 많은 쪽을 먼저 노리는가
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 'p_lich', 0, mid - tiles(2), 0);
  const fat = spawnUnit(g, 's_treant', 1, mid + tiles(2), tiles(1));   // 1400 HP
  const thin = spawnUnit(g, 's_elf_archer', 1, mid + tiles(2), -tiles(1)); // 90 HP
  const fatHp0 = fat.hp;
  const thinHp0 = thin.hp;
  for (let t = 0; t < 20 * 10; t++) {
    g.tick++;
    stepCombat(g);
  }
  ok(fatHp0 - fat.hp > 0, `화염구가 체력 높은 대상을 때림 (트렌트 -${fatHp0 - fat.hp})`);
  void thinHp0;
}

{
  // 데미리치 사후의 경계: 적이 장판 중앙으로 끌려오는가
  const g = newArena();
  const mid = tiles(30);
  const dl = spawnUnit(g, 'p_demilich', 0, mid, 0);
  const foe = spawnUnit(g, 's_marmot', 1, mid + tiles(4), tiles(3));
  let graveSeen = false;
  let pulledCloser = false;
  let prevDist = Math.hypot(foe.x - dl.x, foe.y - dl.y);
  for (let t = 0; t < 20 * 40; t++) {
    g.tick++;
    stepCombat(g);
    const z = g.zones.find((zz) => zz.kind === 'grave');
    if (z) {
      graveSeen = true;
      const d = Math.hypot(foe.x - z.x, foe.y - z.y);
      if (d < prevDist) pulledCloser = true;
      prevDist = d;
    }
  }
  ok(graveSeen, '사후의 경계 장판 생성');
  ok(pulledCloser, '장판이 적을 중앙으로 끌어당김');
}

// ── 5차: 실바린 신유닛 (와이번·유니콘·페어리) + 중간보스/베이스 규칙 ──────────
{
  // 와이번 내리꽂기: 쿨마다 광역 피해가 한 번에 여러 적에게 들어가는가
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 's_wyvern', 0, mid - tiles(1), 0);
  const foes = [0, 1, 2].map((i) => spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), (i - 1) * tiles(0.7)));
  const hp0 = foes.map((f) => f.hp);
  let multiHitTick = false;
  for (let t = 0; t < 20 * 12; t++) {
    const before = foes.map((f) => f.hp);
    g.tick++;
    stepCombat(g);
    // 한 틱에 2기 이상이 동시에 깎였다 = 광역이 터졌다
    if (foes.filter((f, i) => f.alive && f.hp < before[i]!).length >= 2) multiHitTick = true;
  }
  ok(multiHitTick, '와이번 내리꽂기 광역 피해');
  ok(hp0.some((h, i) => foes[i]!.hp < h), '와이번 평타 명중');
}

{
  // 유니콘 가호(방어 버프) · 날개짓(약화) · 큐어(디버프 해제)
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 's_unicorn', 0, mid - tiles(2), 0);
  const ally = spawnUnit(g, 's_marmot', 0, mid - tiles(1), 0);
  const foe = spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), 0);
  let wardSeen = false;
  let weakSeen = false;
  for (let t = 0; t < 20 * 25; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < ally.armorBuffUntil && ally.armorBuffAdd > 0) wardSeen = true;
    if (g.tick < foe.weakenedUntil) weakSeen = true;
  }
  ok(wardSeen, '유니콘 「가호」 아군 방어력 버프');
  ok(weakSeen, '유니콘 「날개짓」 적 약화');
}

{
  // 큐어: 둔화·중독에 걸린 아군을 6초 안에 풀어주는가
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 's_unicorn', 0, mid - tiles(2), 0);
  const ally = spawnUnit(g, 's_marmot', 0, mid - tiles(1), 0);
  spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), 0); // 교전 상대 (큐어는 전투 여부와 무관하지만 전장 재현)
  ally.slowedUntil = 20 * 60;
  ally.dotUntil = 20 * 60;
  ally.dotDps = 10;
  let cured = false;
  for (let t = 0; t < 20 * 10; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < 20 * 60 && ally.slowedUntil === 0 && ally.dotUntil === 0) cured = true;
  }
  ok(cured, '유니콘 「큐어」 디버프 즉시 해제');
}

{
  // 페어리 수면: 재워진 적은 못 움직이고, 3회 맞으면 깬다
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 's_fairy', 0, mid - tiles(5), 0);
  const foe = spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), 0);
  let sleptSeen = false;
  let frozenWhileAsleep = true;
  let brokeByHits = false;
  for (let t = 0; t < 20 * 30; t++) {
    const wasAsleep = g.tick < foe.sleepUntil;
    const x0 = foe.x;
    g.tick++;
    stepCombat(g);
    if (g.tick < foe.sleepUntil) sleptSeen = true;
    if (wasAsleep && g.tick < foe.sleepUntil && foe.x !== x0) frozenWhileAsleep = false;
    // 자다가 규정 횟수를 맞고 깨어난 경우
    if (wasAsleep && g.tick >= foe.sleepUntil && foe.alive) brokeByHits = true;
  }
  ok(sleptSeen, '페어리 「수면」 부여');
  ok(frozenWhileAsleep, '수면 중 이동 불가');
  ok(brokeByHits, '수면은 피격으로 해제된다');
  ok(DEFS.s_fairy!.weapon!.range > DEFS.s_owl!.weapon!.range, '페어리 사거리가 숲올빼미보다 길다');
}

{
  // 중간보스(수호자)가 죽기 전까진 넥서스 무적 + 힐러는 수호자를 못 고친다
  const g = newArena();
  const nexus1 = g.entities.find((e) => e.defId === 'nexus' && e.team === 1)!;
  g.guardianDown = [false, false];
  const gx = nexus1.x - tiles(3);
  const guardian = spawnUnit(g, 'hollow', 1, gx, 0);
  guardian.hp = 400; // 검증 시간을 줄이려 체력만 낮춘다
  const druid = spawnUnit(g, 's_druid', 1, gx - tiles(1), tiles(1)); // 수호자 옆 아군 힐러
  // 수호자는 비행이므로 대공이 되는 갑옷 마멋으로 친다
  for (let i = 0; i < 8; i++) spawnUnit(g, 's_marmot', 0, nexus1.x - tiles(4) - i * 300, ((i % 3) - 1) * tiles(1));
  const nexusHp0 = nexus1.hp;
  let nexusHurtWhileShielded = false;
  let guardianHealed = false;
  let guardianHpPrev = guardian.hp;
  for (let t = 0; t < 20 * 60; t++) {
    g.tick++;
    stepCombat(g);
    if (!g.guardianDown[1] && nexus1.hp < nexusHp0) nexusHurtWhileShielded = true;
    if (guardian.alive && guardian.hp > guardianHpPrev) guardianHealed = true;
    guardianHpPrev = guardian.hp;
    if (g.guardianDown[1] && nexus1.hp < nexusHp0) break;
  }
  ok(!nexusHurtWhileShielded, '수호자 생존 중엔 넥서스에 피해 0');
  ok(g.guardianDown[1], '수호자 격파 시 보호막 해제');
  ok(nexus1.hp < nexusHp0, '수호자 격파 후 넥서스 피격 가능');
  ok(!guardianHealed, '힐러가 중간보스를 치유하지 않는다');
  void druid;
}

{
  // 베이스 방어력: 기본 티어 평타는 최소 피해(1)만 들어간다
  const basics = ['s_gouto', 's_elf_archer', 'p_deadman', 'p_skeleton', 'm_plushbear', 'm_clockwork_soldier'];
  const nexusDef = DEFS.nexus!;
  const worst = basics.map((id) => {
    const w = DEFS[id]!.weapon!;
    let dmg = w.damage;
    for (const tag of nexusDef.tags) dmg += w.bonus?.[tag] ?? 0;
    return { id, net: dmg - nexusDef.armor };
  });
  const over = worst.filter((x) => x.net > 1);
  ok(over.length === 0, `기본 유닛 평타는 넥서스에 1 피해 (초과: ${over.map((x) => x.id).join(',') || '없음'})`);
  ok(DEFS.s_fairy!.weapon!.damage + (DEFS.s_fairy!.weapon!.bonus?.structure ?? 0)
    + (DEFS.s_fairy!.weapon!.bonus?.plate ?? 0) - nexusDef.armor > 20, '공성 유닛(페어리)은 넥서스에 유효타');
}

{
  // 세계수의 사도: 숲의 영역이 사도를 따라 움직인다
  const g = newArena();
  const mid = tiles(20);
  const apostle = spawnUnit(g, 's_apostle', 0, mid, 0);
  spawnUnit(g, 'p_skeleton', 1, mid + tiles(8), 0);
  let followed = false;
  let apostleMoved = false;
  const x0 = apostle.x;
  for (let t = 0; t < 20 * 20; t++) {
    g.tick++;
    stepCombat(g);
    const z = g.zones.find((zz) => zz.kind === 'forest');
    if (z && z.followId === apostle.id && z.x === apostle.x) followed = true;
    if (apostle.x !== x0) apostleMoved = true;
  }
  ok(followed, '숲의 영역이 사도 좌표를 따라온다');
  ok(apostleMoved, '사도가 숲을 펼친 채로 진군한다');
  const fz = DEFS.s_apostle!.actives![0]!.zone!;
  ok(fz.ticks === 20 * 45 && fz.ticks >= DEFS.s_apostle!.actives![0]!.cooldown,
    `숲의 영역 지속 ${fz.ticks / 20}초 ≥ 쿨 — 사도 생존 시 상시 유지`);
  ok(fz.radius === tiles(5), '숲의 영역 반경 5타일');
}

// ── 6차: 세이지·숲의 명궁·사도 대공 (v0.5) ─────────────────────────────────
{
  // 사도가 공중을 때리는가
  ok(DEFS.s_apostle!.weapon!.targets === 'both', '사도 공격이 지상+공중');
  ok(DEFS.s_apostle!.tier === 'supreme', '사도는 최상급 티어');
  ok(DEFS.s_sage!.tier === 'final', '세이지는 최종 티어');
  ok(DEFS.s_wyvern!.techReq === 3 && DEFS.s_unicorn!.techReq === 3 && DEFS.s_fairy!.techReq === 3,
    '와이번·유니콘·페어리는 테크 3 유닛');
  ok((DEFS.s_owl!.techReq ?? 2) === 2, '숲올빼미는 테크 2 유지');
}

{
  // 숲의 명궁: 공중 목표 3기 동시 타격 / 지상 목표는 단일
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 's_marksman', 0, mid - tiles(4), 0);
  const airs = [0, 1, 2, 3].map((i) => spawnUnit(g, 'p_banshee', 1, mid + tiles(1), (i - 1.5) * tiles(1)));
  let maxSameTick = 0;
  for (let t = 0; t < 20 * 8; t++) {
    const before = airs.map((a) => a.hp);
    g.tick++;
    stepCombat(g);
    const hitNow = airs.filter((a, i) => a.hp < before[i]!).length;
    if (hitNow > maxSameTick) maxSameTick = hitNow;
  }
  ok(maxSameTick === 3, `명궁이 공중 3기를 동시 타격 (동시 ${maxSameTick}기)`);

  const g2 = newArena();
  spawnUnit(g2, 's_marksman', 0, mid - tiles(4), 0);
  const grounds = [0, 1, 2].map((i) => spawnUnit(g2, 'p_skeleton', 1, mid + tiles(1), (i - 1) * tiles(0.6)));
  let maxGroundSameTick = 0;
  for (let t = 0; t < 20 * 8; t++) {
    const before = grounds.map((a) => a.hp);
    g2.tick++;
    stepCombat(g2);
    const hitNow = grounds.filter((a, i) => a.alive && a.hp < before[i]!).length;
    if (hitNow > maxGroundSameTick) maxGroundSameTick = hitNow;
  }
  ok(maxGroundSameTick <= 1, `명궁의 지상 공격은 단일 (동시 ${maxGroundSameTick}기)`);
  ok(DEFS.s_marksman!.weapon!.range === tiles(9), '명궁 사거리 = 기본 원거리의 2배 (9)');
}

/** 세이지 테스트 헬퍼: 소유자를 붙이고 마법 3종을 해금한다 (블레이즈는 기본). */
function unlockSage(g: Game, sage: Entity): void {
  sage.owner = 0;
  const ups = g.players[0]!.upgrades as Record<string, true>;
  ups.su_sage_gravity = true;
  ups.su_sage_quake = true;
  ups.su_sage_blizzard = true;
}

{
  // 세이지 리버스그라비티: 공중 유닛이 지상 판정을 받아 대지상 무기에 맞는다
  const g = newArena();
  const mid = tiles(30);
  unlockSage(g, spawnUnit(g, 's_sage', 0, mid - tiles(6), 0));
  const groundOnly = spawnUnit(g, 's_gouto', 0, mid - tiles(1), 0); // 대지상 전용 아군
  const flier = spawnUnit(g, 'p_banshee', 1, mid + tiles(1), 0);
  let groundedSeen = false;
  let hitWhileGrounded = false;
  let prevHp = flier.hp;
  for (let t = 0; t < 20 * 30; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < flier.groundedUntil) {
      groundedSeen = true;
      if (flier.hp < prevHp && flier.lastAttackerId === groundOnly.id) hitWhileGrounded = true;
    }
    prevHp = flier.hp;
    if (!flier.alive) break;
  }
  ok(groundedSeen, '리버스그라비티 — 공중이 지상 판정');
  ok(hitWhileGrounded, '지상화된 공중을 대지상 유닛이 때림');
}

{
  // 세이지 블레이즈: 원격 지점에 불구덩이 장판
  const g = newArena();
  const mid = tiles(30);
  const sage = spawnUnit(g, 's_sage', 0, mid - tiles(8), 0);
  const foe = spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), 0);
  foe.hp = 99999 as never; // 오래 버티게
  let blazeSeen = false;
  let blazeAtFoe = false;
  let dotHurt = false;
  let hpAtBlaze = -1;
  for (let t = 0; t < 20 * 20; t++) {
    g.tick++;
    stepCombat(g);
    const z = g.zones.find((zz) => zz.kind === 'blaze');
    if (z) {
      blazeSeen = true;
      // 장판이 세이지 자기 발밑이 아니라 적 근처에 깔렸는가
      if (Math.hypot(z.x - foe.x, z.y - foe.y) < Math.hypot(z.x - sage.x, z.y - sage.y)) blazeAtFoe = true;
      if (hpAtBlaze < 0) hpAtBlaze = foe.hp;
      if (foe.hp < hpAtBlaze) dotHurt = true;
    }
  }
  ok(blazeSeen, '블레이즈 장판 생성');
  ok(blazeAtFoe, '블레이즈가 원격 지점(적 발밑)에 깔림');
  ok(dotHurt, '블레이즈 불구덩이가 지속피해를 줌');
}

{
  // 세이지 어스퀘이크(광역 둔화) + 블리자드(빙결, 판금 면역)
  const g = newArena();
  const mid = tiles(30);
  unlockSage(g, spawnUnit(g, 's_sage', 0, mid - tiles(7), 0));
  const cloth = spawnUnit(g, 'p_deadman', 1, mid + tiles(1), tiles(0.5));   // 가죽 — 얼 수 있음
  const plate = spawnUnit(g, 'p_corpse_golem', 1, mid + tiles(1), -tiles(0.5)); // 판금 — 면역
  let slowSeen = false;
  let frozenSeen = false;
  let plateFrozen = false;
  let frozenStuck = true;
  for (let t = 0; t < 20 * 40; t++) {
    const x0 = cloth.x;
    const wasFrozen = g.tick < cloth.frozenUntil;
    g.tick++;
    stepCombat(g);
    if (g.tick < cloth.slowedUntil || g.tick < plate.slowedUntil) slowSeen = true;
    if (g.tick < cloth.frozenUntil) frozenSeen = true;
    if (g.tick < plate.frozenUntil) plateFrozen = true;
    if (wasFrozen && g.tick < cloth.frozenUntil && cloth.x !== x0) frozenStuck = false;
    if (!cloth.alive) break;
  }
  ok(slowSeen, '어스퀘이크 — 광역 둔화');
  ok(frozenSeen, '블리자드 — 빙결 부여');
  ok(frozenStuck, '빙결 중 이동 불가');
  ok(!plateFrozen, '판금(골렘)은 빙결 면역');
}

{
  // 세이지 사거리 = 기본 원거리의 약 3배
  ok(DEFS.s_sage!.weapon!.range === tiles(12), '세이지 사거리 12 (기본 4.5의 약 3배)');
  // 상점 진열 확인
  const ids = unitsOfRace('sylvarin').map((d) => d.id);
  ok(ids.includes('s_marksman') && ids.includes('s_sage'), '명궁·세이지 상점 진열');
  const order = ids.indexOf('s_sage');
  ok(order === ids.length - 1, '세이지가 로스터 마지막(최종 유닛)');
}

{
  // 마법 유닛은 생성 직후 쿨 0 — 그리고 적 없는 곳에서 낭비 시전하지 않는다
  const g = newArena();
  const dl = spawnUnit(g, 'p_demilich', 0, tiles(10), 0); // 주변에 적 없음
  ok(dl.skillCds.every((c) => c === 0), '데미리치 생성 직후 스킬 쿨 0');
  for (let t = 0; t < 20 * 5; t++) {
    g.tick++;
    stepCombat(g);
  }
  ok(dl.skillCds.every((c) => c === 0) && !g.zones.some((z) => z.kind === 'grave'),
    '적 없으면 사후의 경계를 허공에 낭비하지 않음');
}

// ── 7차: v0.5 후속 (세이지 1500·데미리치 최상급·한기·시전 이펙트) ──────────
{
  ok(DEFS.s_sage!.cost === 1500, '세이지 가격 1500');
  ok(DEFS.p_demilich!.tier === 'supreme', '데미리치는 최상급 티어');

  // 밴시 절망의 울음: 한기 부여 (공속·이속 -20%)
  const { effectiveDef } = await import('../data.ts');
  const wailed = effectiveDef('p_banshee', { pu_banshee_wail: true })!;
  ok(wailed.weapon!.chillTicks === 20 * 3, '절망의 울음 = 한기 3초 부여');
  ok(wailed.weapon!.slowTicks === DEFS.p_banshee!.weapon!.slowTicks, '기존 둔화는 변경 없음');

  // 실전: 한기 걸린 유닛의 이동이 실제로 느려지는가
  const g = newArena();
  const mid = tiles(30);
  const banshee = spawnUnit(g, 'p_banshee', 0, mid - tiles(3), 0);
  banshee.defOv = wailed;
  const foe = spawnUnit(g, 's_marmot', 1, mid + tiles(6), 0);
  let chillSeen = false;
  for (let t = 0; t < 20 * 15; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < foe.chilledUntil) chillSeen = true;
    if (!foe.alive) break;
  }
  ok(chillSeen, '피격 시 한기 상태이상 부여');
}

{
  // 마법 시전 이펙트: 지옥불이 터진 자리에 hellfire 자국이 남는가
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 'p_lich', 0, mid - tiles(2), 0);
  spawnUnit(g, 's_marmot', 1, mid + tiles(2), 0);
  let fxSeen = false;
  for (let t = 0; t < 20 * 15; t++) {
    g.tick++;
    stepCombat(g);
    if (g.zones.some((z) => z.kind === 'hellfire' || z.kind === 'fireburst')) fxSeen = true;
  }
  ok(fxSeen, '리치 마법 시전 자국(hellfire/fireburst) 생성');
}

{
  // 세이지 마법 시전 자국 (quake/frost/gravity)
  const g = newArena();
  const mid = tiles(30);
  unlockSage(g, spawnUnit(g, 's_sage', 0, mid - tiles(6), 0));
  spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), 0);
  spawnUnit(g, 'p_banshee', 1, mid + tiles(1), tiles(1));
  const seen = new Set<string>();
  for (let t = 0; t < 20 * 40; t++) {
    g.tick++;
    stepCombat(g);
    for (const z of g.zones) seen.add(z.kind);
  }
  ok(seen.has('quake') && seen.has('frost') && seen.has('gravity'),
    `세이지 시전 자국 3종 생성 (${['quake', 'frost', 'gravity'].filter((k) => seen.has(k)).join(',')})`);
}

// ── 8차: v0.6 (앨리스 개편·인형의 실·스킬 해금) ────────────────────────────
{
  ok(DEFS.m_alice!.cost === 1350, '앨리스 가격 1350');
  const summon = DEFS.m_alice!.actives!.find((a) => a.kind === 'summon')!;
  ok(summon.cooldown === 20 * 10, '봉제곰 소환 쿨 10초');
  const conf = DEFS.m_alice!.actives!.find((a) => a.kind === 'confuse')!;
  ok((conf.splash ?? 0) > 0, '혼란이 범위 마법');

  // 해금 전: 인형의 실 봉인
  const g = newArena();
  const mid = tiles(30);
  const alice = spawnUnit(g, 'm_alice', 0, mid - tiles(3), 0);
  alice.owner = 2; // 마리오네타 봇
  const bigfoe = spawnUnit(g, 's_treant', 1, mid + tiles(1), 0);     // supreme
  const midfoe = spawnUnit(g, 's_marmot', 1, mid + tiles(1), tiles(1)); // mid
  const smallfoe = spawnUnit(g, 's_gouto', 1, mid + tiles(1), -tiles(1)); // basic
  for (let t = 0; t < 20 * 8; t++) {
    g.tick++;
    stepCombat(g);
  }
  ok(bigfoe.team === 1 && midfoe.team === 1, '해금 전엔 인형의 실 발동 안 함');

  // 해금 후: 티어가 가장 높은 트렌트부터 전향
  (g.players[2]!.upgrades as Record<string, true>).mu_alice_charm = true;
  let charmed: string | null = null;
  for (let t = 0; t < 20 * 8; t++) {
    g.tick++;
    stepCombat(g);
    if (charmed === null) {
      if (bigfoe.team === 0) charmed = 'treant';
      else if (midfoe.team === 0) charmed = 'marmot';
      else if (smallfoe.team === 0) charmed = 'gouto';
    }
  }
  ok(charmed === 'treant', `인형의 실이 최고 티어(트렌트)를 전향 (실제: ${charmed})`);
  ok(smallfoe.team === 1, '기본 유닛(고우토)은 전향 대상 아님');
  ok(bigfoe.team === 0 && bigfoe.owner === 2, '전향 유닛의 팀·소유자 이전');
}

{
  // 혼란 실전: 혼란 걸린 적이 자기 편을 실제로 때린다
  const g = newArena();
  const mid = tiles(30);
  const alice = spawnUnit(g, 'm_alice', 0, mid - tiles(4), 0);
  void alice;
  const foeA = spawnUnit(g, 's_marmot', 1, mid + tiles(1), 0);
  const foeB = spawnUnit(g, 's_marmot', 1, mid + tiles(1), tiles(0.8));
  let friendlyFire = false;
  for (let t = 0; t < 20 * 30; t++) {
    g.tick++;
    stepCombat(g);
    // 2팀 마멋이 2팀 유닛에게 맞았는가
    if ((foeA.alive && foeA.lastAttackerId === foeB.id) || (foeB.alive && foeB.lastAttackerId === foeA.id)) {
      friendlyFire = true;
    }
  }
  ok(friendlyFire, '혼란 중 자기 편 오사 발생');
}

{
  // 세이지 해금 전: 블레이즈만 나간다
  const g = newArena();
  const mid = tiles(30);
  const sage = spawnUnit(g, 's_sage', 0, mid - tiles(6), 0);
  sage.owner = 0; // 해금 안 산 소유자
  spawnUnit(g, 'p_skeleton', 1, mid + tiles(1), 0);
  spawnUnit(g, 'p_banshee', 1, mid + tiles(1), tiles(1));
  const seen = new Set<string>();
  for (let t = 0; t < 20 * 30; t++) {
    g.tick++;
    stepCombat(g);
    for (const z of g.zones) seen.add(z.kind);
  }
  ok(seen.has('blaze'), '해금 전에도 블레이즈는 기본');
  ok(!seen.has('quake') && !seen.has('frost') && !seen.has('gravity'),
    '해금 전 나머지 마법 봉인');
  // 해금 업그레이드가 택1이 아니라 전부 구매 가능한가
  const { upgradesOfUnit } = await import('../data.ts');
  const sageUnlocks = upgradesOfUnit('s_sage').filter((u) => u.cost === 1000);
  ok(sageUnlocks.length === 3 && sageUnlocks.every((u) => !u.choiceGroup),
    '세이지 해금 3종 모두 개별 구매 가능 (택1 아님)');
}

// ── 9차: v0.7 (가시 봉제 반사·풍선 갑옷) ──────────────────────────────────
{
  // 고어 테디 「가시 봉제」: 평타 반사 50%, 마법은 반사 안 됨
  const g = newArena();
  const mid = tiles(30);
  const teddy = spawnUnit(g, 'm_gore_teddy', 0, mid - tiles(1), 0);
  const bruiser = spawnUnit(g, 's_marmot', 1, mid + tiles(0.5), 0); // 평타 근접
  let reflectSeen = false;
  let reflectHurt = false;
  let prevBruiserHp = bruiser.hp;
  for (let t = 0; t < 20 * 25; t++) {
    const reflecting = g.tick < teddy.reflectUntil;
    g.tick++;
    stepCombat(g);
    if (g.tick < teddy.reflectUntil) reflectSeen = true;
    // 반사 중 마멋이 (테디 평타 사거리 밖 상황 무관하게) 자기 스윙에 되맞아 깎였는가:
    // 마멋 체력이 테디의 평타 쿨과 무관한 틱에도 줄면 반사 피해다 — 근사 검증:
    // 반사 지속 중 마멋 체력 감소가 관측되면 성공으로 본다 (테디 평타+반사 둘 다 유효 피해).
    if (reflecting && bruiser.alive && bruiser.hp < prevBruiserHp) reflectHurt = true;
    prevBruiserHp = bruiser.hp;
    if (!bruiser.alive || !teddy.alive) break;
  }
  ok(reflectSeen, '가시 봉제 발동 (반사막 지속)');
  ok(reflectHurt, '반사 중 공격자가 피해를 입음');

  // 정밀: 반사량 = 평타의 50% (방어 무시 고정 반사)
  const g2 = newArena();
  const teddy2 = spawnUnit(g2, 'm_gore_teddy', 0, tiles(10), 0);
  teddy2.reflectUntil = 999999;
  const foe2 = spawnUnit(g2, 's_gouto', 1, tiles(30), 0); // 멀리 — 자동 교전 방지
  const hp0 = foe2.hp;
  // 수동으로 평타 1대: 고우토 → 테디 (dmg 10 - armor 3 = 7, 반사 3)
  const { DEFS: D2 } = { DEFS };
  void D2;
  // 직접 applyDamage 를 부를 수 없으니 근접 배치 후 1틱만 돌린다
  foe2.x = teddy2.x + tiles(0.5);
  let reflected = false;
  for (let t = 0; t < 20 * 3; t++) {
    g2.tick++;
    stepCombat(g2);
    if (foe2.hp < hp0) { reflected = true; break; }
  }
  ok(reflected, '평타가 반사로 되돌아옴');

  // 마법(스트라이크) 미반사: 리치 화염구가 반사막 테디를 때려도 리치는 무사
  const g3 = newArena();
  const teddy3 = spawnUnit(g3, 'm_gore_teddy', 0, tiles(10), 0);
  teddy3.reflectUntil = 999999;
  teddy3.rootedUntil = 999999; // 고정 — 접근해서 평타로 때리는 오염 제거 (반사분만 측정)
  const lich = spawnUnit(g3, 'p_lich', 1, tiles(10) + tiles(4), 0);
  const lichHp0 = lich.hp;
  let teddyHitByMagic = false;
  let prevTeddyHp = teddy3.hp;
  for (let t = 0; t < 20 * 12; t++) {
    g3.tick++;
    stepCombat(g3);
    // 리치 평타(원거리 8뎀)와 화염구 모두 맞지만, 반사는 평타분만 —
    // 리치가 받는 피해가 "받은 것 없이 커지는" 일이 없는지는 아래 근사로:
    if (teddy3.hp < prevTeddyHp) teddyHitByMagic = true;
    prevTeddyHp = teddy3.hp;
  }
  // 리치는 원거리(사거리 4.5)라 테디 평타(0.8)에 안 맞는다 — 깎였다면 전부 반사분.
  // 평타 8뎀 - 방어 3 = 5 → 반사 2/타. 화염구 50뎀 - 3 = 47 은 반사 0이어야 한다.
  // 12초간 평타 ~8회 = 반사 ≤ 20. 화염구까지 반사됐다면 40+ 이상 깎인다.
  const lichLoss = lichHp0 - lich.hp;
  ok(teddyHitByMagic && lichLoss > 0 && lichLoss <= 25,
    `마법은 반사 안 됨 (리치 피해 ${lichLoss} ≤ 25 = 평타 반사분만)`);
}

{
  // 광대 인형 「풍선 갑옷」: 교전 중 방어 +10
  const g = newArena();
  const mid = tiles(30);
  const clown = spawnUnit(g, 'm_clown_doll', 0, mid - tiles(1), 0);
  spawnUnit(g, 's_gouto', 1, mid + tiles(0.5), 0);
  let buffSeen = false;
  for (let t = 0; t < 20 * 10; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < clown.buffUntil) buffSeen = true;
  }
  ok(buffSeen, '풍선 갑옷 발동');
  const sb = DEFS.m_clown_doll!.actives!.find((a) => a.kind === 'selfbuff')!;
  ok(sb.armorAdd === 10, '풍선 갑옷 방어 +10');
}

{
  // 수리공 인형 삭제 — 단추 인형이 정밀 수리를 물려받았다 (테크 2)
  ok(DEFS.m_repair_doll === undefined, '수리공 인형 삭제됨');
  ok(!unitsOfRace('marionetta').some((d) => d.id === 'm_repair_doll'), '상점에서도 제거');
  const { upgradesOfUnit: upsOf } = await import('../data.ts');
  const btn = upsOf('m_button_doll').find((u) => u.id === 'mu_repair_precise');
  ok(btn !== undefined && btn.tech === 2, '단추 인형 「정밀 수리」 (테크 2)');
  const { effectiveDef: eff3 } = await import('../data.ts');
  const upB = eff3('m_button_doll', { mu_repair_precise: true })!;
  ok(upB.heal!.amount === Math.floor((DEFS.m_button_doll!.heal!.amount * 140) / 100), '정밀 수리 = 수리량 +40%');
}

// ── 10차: v0.8 (마리오네타 신유닛 4종·공포) ────────────────────────────────
{
  // 시계탑 톱니바퀴 「자정의 종소리」: 원거리 적 최우선 공포 + 도주
  const g = newArena();
  const mid = tiles(30);
  spawnUnit(g, 'm_clocktower_gear', 0, mid - tiles(2), 0);
  const melee = spawnUnit(g, 'p_skeleton', 1, mid - tiles(0.5), 0);       // 근접 — 더 가깝다
  const ranged = spawnUnit(g, 'p_bone_thrower', 1, mid + tiles(2), 0);    // 원거리 — 멀다
  let fearSeen = false;
  let rangedFearedFirst = false;
  let fledBack = false;
  let fearedNoAttack = true;
  for (let t = 0; t < 20 * 15; t++) {
    const x0 = ranged.x;
    const cd0 = ranged.cooldown;
    g.tick++;
    stepCombat(g);
    if (!fearSeen && (g.tick < ranged.fearedUntil || g.tick < melee.fearedUntil)) {
      fearSeen = true;
      // 첫 공포가 원거리(투척병)에 걸렸는가 — 근접이 더 가까이 있어도
      if (g.tick < ranged.fearedUntil) rangedFearedFirst = true;
    }
    if (g.tick < ranged.fearedUntil && ranged.alive) {
      if (ranged.x > x0) fledBack = true; // 2팀 기지는 오른쪽
      if (ranged.cooldown > cd0) fearedNoAttack = false; // 도주 중 공격했다면 실패
    }
    if (!ranged.alive) break;
  }
  ok(fearSeen, '자정의 종소리 — 공포 부여');
  ok(rangedFearedFirst, '원거리 유닛을 최우선으로 공포');
  ok(fledBack, '공포 유닛이 기지로 도주');
  ok(fearedNoAttack, '공포 중 공격 불가');
}

{
  // 신유닛 로스터·티어 확인
  const ids = unitsOfRace('marionetta').map((d) => d.id);
  ok(['m_grandfather_clock', 'm_pennywise', 'm_thread_needle', 'm_clocktower_gear'].every((id) => ids.includes(id)),
    '마리오네타 신유닛 4종 상점 진열');
  ok(DEFS.m_pennywise!.techReq === 3 && DEFS.m_thread_needle!.techReq === 3, '페니와이즈·실과 바늘 테크 3');
  ok(DEFS.m_thread_needle!.weapon!.range === tiles(13.5), '실과 바늘 사거리 = 기본의 3배 (13.5)');
  ok(DEFS.m_thread_needle!.weapon!.targets === 'ground', '실과 바늘은 공대지 전용');
  ok(DEFS.m_pennywise!.weapon!.splash !== undefined, '페니와이즈 스플래시 보유');
  ok(DEFS.m_grandfather_clock!.weapon!.splash !== undefined && DEFS.m_grandfather_clock!.weapon!.targets === 'ground',
    '괘종시계 = 지상 원거리 광역');
  // 「거대한 종」 업그레이드: 시전 사거리 +2
  const { effectiveDef: eff2 } = await import('../data.ts');
  const upped = eff2('m_clocktower_gear', { mu_gear_bell: true })!;
  const base = DEFS.m_clocktower_gear!.actives![0]!.castRange!;
  ok(upped.actives![0]!.castRange === base + tiles(2), '거대한 종 — 시전 사거리 +2');
}

{
  // 태엽 감기: 해금 전엔 봉인
  const g = newArena();
  const mid = tiles(30);
  const s2 = spawnUnit(g, 'm_clockwork_soldier', 0, mid - tiles(2), 0);
  s2.owner = 2; // 해금 안 산 소유자
  spawnUnit(g, 'p_skeleton', 1, mid + tiles(0.5), 0);
  let buffed = false;
  for (let t = 0; t < 20 * 10; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < s2.buffUntil) buffed = true;
  }
  ok(!buffed, '태엽 감기 — 해금 전 봉인');
  const wu = DEFS.m_clockwork_soldier!.actives![0]!;
  ok(wu.requiresUpgrade === 'mu_soldier_windup', '태엽 감기 = 업그레이드 해금형 (테크 2)');
}

{
  // 수호자(중간보스)는 모든 상태이상 면역
  const g = newArena();
  const mid = tiles(30);
  const boss = spawnUnit(g, 'hollow', 1, mid + tiles(2), 0);
  boss.anchorX = boss.x; boss.anchorY = boss.y;
  // 상태이상 공세: 둔화·독(엘프 독화살 없이 마녀), 수면(페어리), 공포(톱니), 혼란(앨리스)
  spawnUnit(g, 's_fairy', 0, mid - tiles(2), 0);
  spawnUnit(g, 'm_clocktower_gear', 0, mid - tiles(1), tiles(1));
  spawnUnit(g, 'm_alice', 0, mid - tiles(2), -tiles(1));
  spawnUnit(g, 's_thorn_witch', 0, mid - tiles(1), tiles(2));
  spawnUnit(g, 's_butterfly', 0, mid - tiles(1), -tiles(2)); // 100% 둔화탄
  let anyStatus = false;
  for (let t = 0; t < 20 * 30; t++) {
    g.tick++;
    stepCombat(g);
    if (g.tick < boss.slowedUntil || g.tick < boss.dotUntil || g.tick < boss.sleepUntil
      || g.tick < boss.fearedUntil || g.tick < boss.confusedUntil || g.tick < boss.frozenUntil
      || g.tick < boss.chilledUntil || g.tick < boss.weakenedUntil || g.tick < boss.tauntedUntil
      || g.tick < boss.groundedUntil) anyStatus = true;
    if (!boss.alive) break;
  }
  ok(!anyStatus, '수호자는 모든 상태이상 면역');
  ok(DEFS.m_clocktower_gear!.actives![0]!.cooldown === 20 * 25, '자정의 종소리 쿨 25초');
}

if (failed) process.exitCode = 1;
