/**
 * 틱 단위 전투 해석.
 *
 * 결정론 규칙:
 *  - 모든 순회는 entities 배열 순서 그대로. 정렬·재배치 금지.
 *  - 좌표·거리 계산은 전부 정수 (math.ts 참고).
 *  - "가장 가까운" 판정의 동률은 배열 앞쪽(id 낮은 쪽)이 이긴다 (strict <).
 */
import {
  GUARDIAN_OF, DEFS, MAP, ZONE_DEFS, FOREST_BUFFS, WEAKEN_PCT, CHILL_PCT, SLEEP_BREAK_HITS,
  FREEZE_IMMUNE_TAGS, FX_ZONE_TICKS, TIER_RANK, CHARM_MIN_RANK, effectiveDef, laneCenterY, clampLaneY,
} from './data.ts';
import { dist2, idiv, isqrt, clamp, tiles } from './math.ts';
import { nextChance, nextInt } from './rng.ts';
import { isCombatTag } from './types.ts';
import type { ActiveSkill, CombatTeam, Entity, EntityDef, Game, TeamId } from './types.ts';
import { enemyOf } from './types.ts';

function def(e: Entity): EntityDef {
  if (e.defOv) return e.defOv; // 업그레이드 반영본
  const d = DEFS[e.defId];
  if (!d) throw new Error(`unknown def: ${e.defId}`);
  return d;
}

/** 유효 비행 판정 — 「리버스그라비티」로 끌어내려진 공중 유닛은 지상 취급. */
function isFlying(g: Game, e: Entity): boolean {
  return def(e).flying && g.tick >= e.groundedUntil;
}

function canHit(g: Game, attacker: EntityDef, target: Entity): boolean {
  const w = attacker.weapon;
  if (!w) return false;
  // 영구 무적(둥지 수호탑): 어차피 피해가 안 들어가므로 아예 조준하지 않는다 —
  // 무적 몸빵이 적 화력을 빨아들이는 것 방지. 일시 무적(인비저블)은 그대로 조준된다.
  if (target.invulnUntil >= Number.MAX_SAFE_INTEGER) return false;
  const tFlying = isFlying(g, target);
  if (w.targets === 'ground') return !tFlying;
  if (w.targets === 'air') return tFlying;
  return true;
}

/**
 * 넥서스 보호막: 그 팀의 수호자가 죽기 전까지 넥서스는 무적이고 타겟도 되지 않는다.
 * (수호탑 → 수호자 → 넥서스 순서 강제)
 */
function isShielded(g: Game, t: Entity): boolean {
  return t.defId === 'nexus' && !g.guardianDown[t.team as TeamId];
}

/** 수호자(중간보스)는 모든 상태이상에 면역이다. */
function isStatusImmune(e: Entity): boolean {
  return def(e).tier === 'guardian';
}

/** 행동 불가 상태 (기절·수면·빙결). */
function isIncapacitated(g: Game, e: Entity): boolean {
  return g.tick < e.stunnedUntil || g.tick < e.sleepUntil || g.tick < e.frozenUntil;
}

/** 「큐어」 대상 판정: 하나라도 해로운 상태가 걸려 있는가. */
function hasDebuff(g: Game, e: Entity): boolean {
  return g.tick < e.slowedUntil || g.tick < e.dotUntil || g.tick < e.rootedUntil
    || g.tick < e.stunnedUntil || g.tick < e.confusedUntil
    || g.tick < e.weakenedUntil || g.tick < e.sleepUntil
    || g.tick < e.frozenUntil || g.tick < e.groundedUntil
    || g.tick < e.chilledUntil || g.tick < e.fearedUntil;
}

/** 걸려 있는 해로운 상태를 전부 지운다 (버프는 유지). */
function clearDebuffs(e: Entity): void {
  e.slowedUntil = 0;
  e.dotUntil = 0;
  e.dotDps = 0;
  e.rootedUntil = 0;
  e.stunnedUntil = 0;
  e.confusedUntil = 0;
  e.weakenedUntil = 0;
  e.sleepUntil = 0;
  e.sleepHits = 0;
  e.frozenUntil = 0;
  e.groundedUntil = 0;
  e.chilledUntil = 0;
  e.fearedUntil = 0;
}

/** 수면 중인 대상이 맞았다 — 규정 횟수를 넘기면 깨운다. */
function noteSleepHit(g: Game, victim: Entity): void {
  if (g.tick >= victim.sleepUntil) return;
  victim.sleepHits++;
  if (victim.sleepHits >= SLEEP_BREAK_HITS) {
    victim.sleepUntil = 0;
    victim.sleepHits = 0;
  }
}

/** 수호자는 앵커 기준으로만 적을 무는다 (리쉬). */
function acquireOrigin(e: Entity, d: EntityDef): { x: number; y: number } {
  return d.leashed ? { x: e.anchorX, y: e.anchorY } : { x: e.x, y: e.y };
}

/** 이 유닛(정의)이 공중을 때릴 수 있는가. */
function canTargetAir(d: EntityDef): boolean {
  return d.weapon !== undefined && d.weapon.targets !== 'ground';
}

function findTarget(g: Game, e: Entity, d: EntityDef): number {
  const origin = acquireOrigin(e, d);
  let best = -1;
  let bestD2 = -1;
  // 공중 유닛은 대공 가능한 적(=나를 위협하는 적)을 우선한다.
  let bestAA = -1;
  let bestAAD2 = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team) continue;
    if (!canHit(g, d, t) || isShielded(g, t)) continue;
    const td = def(t);
    const reach = d.acquireRange + d.radius + td.radius;
    const d2 = dist2(origin.x, origin.y, t.x, t.y);
    if (d2 > reach * reach) continue;
    if (best === -1 || d2 < bestD2) {
      best = t.id;
      bestD2 = d2;
    }
    if (d.flying && canTargetAir(td) && (bestAA === -1 || d2 < bestAAD2)) {
      bestAA = t.id;
      bestAAD2 = d2;
    }
  }
  return d.flying && bestAA !== -1 ? bestAA : best;
}

/** 혼란 상태: 탐지 거리 안 가장 가까운 "자기 편" (자신 제외, 무기로 때릴 수 있는 대상만). */
function findConfusedTarget(g: Game, e: Entity, d: EntityDef): number {
  let best = -1;
  let bestD2 = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team !== e.team || t.id === e.id) continue;
    if (!canHit(g, d, t) || isShielded(g, t)) continue;
    const td = def(t);
    const reach = d.acquireRange + d.radius + td.radius;
    const d2 = dist2(e.x, e.y, t.x, t.y);
    if (d2 > reach * reach) continue;
    if (best === -1 || d2 < bestD2) {
      best = t.id;
      bestD2 = d2;
    }
  }
  return best;
}

/** 때릴 수 있는지 따지지 않고 탐지 거리 안 가장 가까운 적 (무기 없는 시전자용). */
function findNearestFoe(g: Game, e: Entity, d: EntityDef): number {
  let best = -1;
  let bestD2 = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team || isShielded(g, t)) continue;
    const td = def(t);
    const reach = d.acquireRange + d.radius + td.radius;
    const d2 = dist2(e.x, e.y, t.x, t.y);
    if (d2 > reach * reach) continue;
    if (best === -1 || d2 < bestD2) {
      best = t.id;
      bestD2 = d2;
    }
  }
  return best;
}

/**
 * 시전 사거리 안에서 조건에 맞는 가장 가까운 적 (지정형 마법의 조준점).
 * 동률은 배열 앞쪽이 이긴다 — 결정론 유지.
 */
function nearestFoeWithin(
  g: Game, e: Entity, d: EntityDef, range: number,
  filter: (v: Entity) => boolean,
): Entity | undefined {
  let best: Entity | undefined;
  let bestD2 = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team || isShielded(g, t)) continue;
    if (!filter(t)) continue;
    const reach = range + d.radius + def(t).radius;
    const d2 = dist2(e.x, e.y, t.x, t.y);
    if (d2 > reach * reach) continue;
    if (best === undefined || d2 < bestD2) {
      best = t;
      bestD2 = d2;
    }
  }
  return best;
}

/** 시각 전용 장판(폭발·마법진 자국)을 잠깐 심는다. 게임 효과 없음 — 그림만. */
function dropFxZone(
  g: Game, team: CombatTeam, kind: import('./types.ts').ZoneKind,
  x: number, y: number, radius: number,
): void {
  g.zones.push({
    id: g.nextZoneId++, team, kind, x, y, radius,
    untilTick: g.tick + FX_ZONE_TICKS, followId: -1,
  });
}

function isSlowed(g: Game, e: Entity): boolean {
  return g.tick < e.slowedUntil;
}

/** 정의에서 selfbuff 스킬을 찾는다 (유닛당 최대 1개 가정). */
function selfbuffOf(d: EntityDef): ActiveSkill | undefined {
  return d.actives?.find((a) => a.kind === 'selfbuff');
}

/** 자가 버프(selfbuff) 지속 중인가. */
function isBuffed(g: Game, e: Entity, d: EntityDef): boolean {
  return g.tick < e.buffUntil && selfbuffOf(d) !== undefined;
}

/** 숲의 가호 (숲의 영역 안) 유닛별 강화. 지속 중이 아니면 undefined. */
function forestBuffOf(g: Game, e: Entity): (typeof FOREST_BUFFS)[string] | undefined {
  return g.tick < e.forestUntil ? FOREST_BUFFS[e.defId] : undefined;
}

/** 버프 반영 방어력. */
function armorOf(g: Game, e: Entity, d: EntityDef): number {
  let armor = d.armor;
  const sb = selfbuffOf(d);
  if (sb?.armorAdd && isBuffed(g, e, d)) armor += sb.armorAdd;
  const fb = forestBuffOf(g, e);
  if (fb?.armorAdd) armor += fb.armorAdd;
  if (g.tick < e.armorBuffUntil) armor += e.armorBuffAdd; // 유니콘 「가호」
  return armor;
}

/** 공속 버프 합산 % (자가 버프 + 숲의 가호 + 군세강화). */
function atkSpeedPctOf(g: Game, e: Entity, d: EntityDef): number {
  let pct = 0;
  const sb = selfbuffOf(d);
  if (sb?.atkSpeedPct && isBuffed(g, e, d)) pct += sb.atkSpeedPct;
  const fb = forestBuffOf(g, e);
  if (fb?.atkSpeedPct) pct += fb.atkSpeedPct;
  if (g.tick < e.atkBuffUntil) pct += 10; // 군세강화 (중복 없음 — 갱신만)
  return pct;
}

function moveToward(g: Game, e: Entity, d: EntityDef, tx: number, ty: number, slowed: boolean): void {
  if (d.speed <= 0) return;
  const dx = tx - e.x;
  const dy = ty - e.y;
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return;
  let step = slowed ? idiv(d.speed * 3, 5) : d.speed;
  if (g.tick < e.chilledUntil) step = idiv(step * (100 - CHILL_PCT), 100); // 한기
  // 이속 버프 (태엽 감기 + 숲의 가호)
  {
    let pct = 0;
    const sb = selfbuffOf(d);
    if (sb?.speedPct && isBuffed(g, e, d)) pct += sb.speedPct;
    const fb = forestBuffOf(g, e);
    if (fb?.speedPct) pct += fb.speedPct;
    if (pct) step = idiv(step * (100 + pct), 100);
  }
  if (step > len) step = len;
  e.x = clamp(e.x + idiv(dx * step, len), 0, g.map.length);
  e.y = clampLaneY(g.map, e.x, e.y + idiv(dy * step, len));
}

/**
 * 겹침 해소. 같은 레이어(지상/공중)끼리만 밀어낸다.
 *
 * 3회 반복 완화: 한 번의 밀어내기로는 밀집 대형의 전진 압력을 못 이겨
 * 유닛이 겹친 채 한 대상을 다구리하는 문제가 생긴다. 반복 완화로 몸이
 * 실제로 자리를 차지하게 만들면, 근접 유닛은 대상 주위 링(6~8자리)을
 * 차지한 유닛만 때릴 수 있고 나머지는 줄을 서게 된다.
 */
function separate(g: Game): void {
  for (let iter = 0; iter < 3; iter++) separatePass(g);
}

function separatePass(g: Game): void {
  const es = g.entities;
  for (let i = 0; i < es.length; i++) {
    const a = es[i]!;
    if (!a.alive) continue;
    const da = def(a);
    for (let j = i + 1; j < es.length; j++) {
      const b = es[j]!;
      if (!b.alive) continue;
      const db = def(b);
      // 지상화(리버스그라비티)된 공중 유닛은 지상 레이어에서 몸싸움한다
      if (isFlying(g, a) !== isFlying(g, b)) continue;
      const minDist = da.radius + db.radius;
      const dx = b.x - a.x;
      if (dx > minDist || dx < -minDist) continue;
      const dy = b.y - a.y;
      if (dy > minDist || dy < -minDist) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;

      const dist = isqrt(d2);
      // 완전히 겹친 경우 id 홀짝으로 결정론적 분리 방향을 만든다.
      let nx: number, ny: number, overlap: number;
      if (dist === 0) {
        nx = 0;
        ny = (a.id & 1) === 0 ? 1000 : -1000;
        overlap = minDist;
      } else {
        nx = idiv(dx * 1000, dist);
        ny = idiv(dy * 1000, dist);
        overlap = minDist - dist;
      }
      const push = idiv(overlap, 2);
      const aMobile = da.speed > 0;
      const bMobile = db.speed > 0;
      const m = g.map;
      if (aMobile && bMobile) {
        a.x = clamp(a.x - idiv(nx * push, 1000), 0, m.length);
        a.y = clampLaneY(m, a.x, a.y - idiv(ny * push, 1000));
        b.x = clamp(b.x + idiv(nx * push, 1000), 0, m.length);
        b.y = clampLaneY(m, b.x, b.y + idiv(ny * push, 1000));
      } else if (aMobile) {
        a.x = clamp(a.x - idiv(nx * overlap, 1000), 0, m.length);
        a.y = clampLaneY(m, a.x, a.y - idiv(ny * overlap, 1000));
      } else if (bMobile) {
        b.x = clamp(b.x + idiv(nx * overlap, 1000), 0, m.length);
        b.y = clampLaneY(m, b.x, b.y + idiv(ny * overlap, 1000));
      }
    }
  }
}

function applyDamage(g: Game, attacker: Entity, attackerDef: EntityDef, victim: Entity): void {
  // 무적 (인비저블 / 수호자 생존 중인 넥서스): 피해·상태이상 전부 무시.
  if (g.tick < victim.invulnUntil || isShielded(g, victim)) {
    victim.lastAttackerId = attacker.id;
    return;
  }
  const w = attackerDef.weapon!;
  const vd = def(victim);
  // 회피 (캠페인 강화): 평타만 피한다 — 마법·스킬·장판·독은 회피 불가
  if (vd.dodgePct && nextChance(g.rng, vd.dodgePct)) {
    victim.lastAttackerId = attacker.id;
    return;
  }
  let dmg = w.damage;
  if (w.bonus) {
    for (const tag of vd.tags) if (isCombatTag(tag)) dmg += w.bonus[tag] ?? 0;
    if (vd.flying) dmg += w.bonus.flying ?? 0;
  }
  // 약화: 방어력 계산 전에 가하는 피해를 깎는다
  if (g.tick < attacker.weakenedUntil) dmg = idiv(dmg * (100 - WEAKEN_PCT), 100);
  if (!w.ignoreArmor) dmg -= armorOf(g, victim, vd);
  if (dmg < 1) dmg = 1;
  victim.hp -= dmg;
  noteSleepHit(g, victim); // 수면 중이었다면 피격 횟수 누적
  victim.lastAttackerId = attacker.id; // 보복 타겟팅용

  // 공격 반사 (가시 봉제): 받은 평타 피해의 일부를 공격자에게 되돌린다.
  // applyStrike(마법)·독·장판은 이 함수를 안 거치므로 자연히 반사되지 않는다.
  if (g.tick < victim.reflectUntil && attacker.alive && g.tick >= attacker.invulnUntil) {
    const rp = def(victim).actives?.find((a) => a.kind === 'reflect')?.reflectPct ?? 0;
    if (rp > 0) {
      const back = idiv(dmg * rp, 100);
      if (back > 0) attacker.hp -= back;
    }
  }

  // 흡혈: 입힌 피해의 일부 회복
  if (w.lifestealPct && attacker.alive) {
    const healed = idiv(dmg * w.lifestealPct, 100);
    if (healed > 0) {
      attacker.hp += healed;
      if (attacker.hp > attackerDef.maxHp) attacker.hp = attackerDef.maxHp;
    }
  }

  if (isStatusImmune(victim)) return; // 수호자: 아래 부가효과(상태이상) 전부 무시

  // 둔화 (slowChance 미지정 시 100%)
  if (w.slowTicks && vd.speed > 0) {
    const apply = w.slowChance === undefined || nextChance(g.rng, w.slowChance);
    if (apply) {
      const until = g.tick + w.slowTicks;
      if (until > victim.slowedUntil) victim.slowedUntil = until;
    }
  }

  // 지속피해 (독/화상). 갱신 시 dps 는 더 센 쪽 유지.
  if (w.dotDps && w.dotTicks) {
    const apply = w.dotChance === undefined || nextChance(g.rng, w.dotChance);
    if (apply) {
      const until = g.tick + w.dotTicks;
      if (until > victim.dotUntil) victim.dotUntil = until;
      if (w.dotDps > victim.dotDps) victim.dotDps = w.dotDps;
    }
  }

  // 속박 (이동 불가). 구조물엔 무의미하므로 이동 가능 유닛만.
  if (w.rootTicks && vd.speed > 0) {
    const apply = w.rootChance === undefined || nextChance(g.rng, w.rootChance);
    if (apply) {
      const until = g.tick + w.rootTicks;
      if (until > victim.rootedUntil) victim.rootedUntil = until;
    }
  }

  // 한기 (공속·이속 -CHILL_PCT%) — 확정 부여, 갱신만
  if (w.chillTicks) {
    const until = g.tick + w.chillTicks;
    if (until > victim.chilledUntil) victim.chilledUntil = until;
  }
}

/**
 * nuke 스킬의 대상 고르기.
 *  nearest    — 사거리 안 가장 가까운 적
 *  highestHp  — 사거리 안 체력이 가장 많은 적 (화염구: 살찐 놈부터 태운다)
 * 동률은 배열 앞쪽(=id 낮은 쪽)이 이긴다 — 결정론 유지.
 */
function pickNukeTarget(
  g: Game, e: Entity, d: EntityDef, range: number, mode: 'nearest' | 'highestHp',
  extraFilter?: (t: Entity) => boolean,
): Entity | undefined {
  let best: Entity | undefined;
  let bestKey = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team || !canHit(g, d, t) || isShielded(g, t)) continue;
    if (extraFilter && !extraFilter(t)) continue;
    const td = def(t);
    const reach = range + d.radius + td.radius;
    const d2 = dist2(e.x, e.y, t.x, t.y);
    if (d2 > reach * reach) continue;
    const key = mode === 'highestHp' ? t.hp : -d2;
    if (best === undefined || key > bestKey) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

/** 액티브 strike 피해 (처형기). 무기 부가효과(둔화·독 등)는 묻지 않는다. */
function applyStrike(g: Game, attacker: Entity, a: ActiveSkill, victim: Entity): void {
  if (g.tick < victim.invulnUntil || isShielded(g, victim)) {
    victim.lastAttackerId = attacker.id;
    return;
  }
  const vd = def(victim);
  let dmg = a.damage ?? 0;
  if (a.executeBelowPct !== undefined && a.executeBonus) {
    // 처형: 대상 체력 비율이 기준 이하면 추가 피해
    if (victim.hp * 100 <= vd.maxHp * a.executeBelowPct) dmg += a.executeBonus;
  }
  if (g.tick < attacker.weakenedUntil) dmg = idiv(dmg * (100 - WEAKEN_PCT), 100);
  dmg -= armorOf(g, victim, vd);
  if (dmg < 1) dmg = 1;
  victim.hp -= dmg;
  noteSleepHit(g, victim);
  victim.lastAttackerId = attacker.id;
}

/** 전투 중 유닛 생성 (수호자·소환수 공용). */
function spawnBattleEntity(g: Game, defId: string, team: CombatTeam, owner: number, x: number, y: number, ov?: EntityDef): Entity {
  const d = ov ?? DEFS[defId]!;
  const e: Entity = {
    id: g.nextEntityId++,
    defId,
    team,
    owner,
    ...(ov ? { defOv: ov } : {}),
    x, y,
    anchorX: x, anchorY: y,
    hp: d.maxHp,
    cooldown: 0,
    healCooldown: 0,
    targetId: -1,
    lastAttackerId: -1,
    slowedUntil: 0,
    dotUntil: 0,
    dotDps: 0,
    rootedUntil: 0,
    stunnedUntil: 0,
    skillCds: d.actives?.map(() => 0) ?? [],
    buffUntil: 0,
    confusedUntil: 0,
    atkBuffUntil: 0,
    invulnUntil: 0,
    forestUntil: 0,
    tauntedUntil: 0,
    tauntedBy: -1,
    weakenedUntil: 0,
    chilledUntil: 0,
    reflectUntil: 0,
    fearedUntil: 0,
    groundedUntil: 0,
    frozenUntil: 0,
    sleepUntil: 0,
    sleepHits: 0,
    armorBuffUntil: 0,
    armorBuffAdd: 0,
    healWindowStart: -100,
    healsInWindow: 0,
    alive: true,
  };
  g.entities.push(e);
  return e;
}

function spawnGuardian(g: Game, team: TeamId, x: number, y: number): void {
  // 캠페인 테마 보스: 적 팀 수호자를 스테이지가 지정한 것으로 교체할 수 있다
  const defId = team === 1 && g.enemyGuardian ? g.enemyGuardian : GUARDIAN_OF[team];
  spawnBattleEntity(g, defId, team, -1, x, y);
  g.events.push({ tick: g.tick, kind: 'guardianSpawn', team });
}

export function stepCombat(g: Game): void {
  const byId = new Map<number, Entity>();
  for (const e of g.entities) if (e.alive) byId.set(e.id, e);

  // 0) 상태이상·장판 (피해/회복은 1초에 1번 — tick % 20 === 0 에 적용)
  // 버프 종료 후유증 (태엽 감기 과열 등)
  for (const e of g.entities) {
    if (!e.alive || e.buffUntil !== g.tick) continue;
    const slow = selfbuffOf(def(e))?.overheatSlowTicks;
    if (slow) {
      const until = g.tick + slow;
      if (until > e.slowedUntil) e.slowedUntil = until;
    }
  }
  const dmgTick = g.tick % 20 === 0;
  if (dmgTick) {
    for (const e of g.entities) {
      if (!e.alive) continue;
      // 독/화상은 방어 무시 (무적 중엔 면역)
      if (g.tick < e.dotUntil && e.dotDps > 0 && g.tick >= e.invulnUntil) e.hp -= e.dotDps;
      // 재생: 숲의 가호 + 유닛 자체 재생(캠페인 강화)을 합산.
      // (둥지 자체 재생은 뺐다 — 방어 28 상대 잡몹 실피해가 1이라 사실상 무적이 된다.
      //  둥지 회복은 드루이드 치유로만.)
      const fb = forestBuffOf(g, e);
      const regen = (fb?.regenPerSec ?? 0) + (def(e).regenPerSec ?? 0);
      if (regen > 0) {
        const max = def(e).maxHp;
        if (e.hp < max) {
          e.hp += regen;
          if (e.hp > max) e.hp = max;
        }
      }
    }
  }
  if (g.zones.length > 0) {
    g.zones = g.zones.filter((z) => g.tick < z.untilTick);
    for (const z of g.zones) {
      // 추종 장판 (숲의 영역): 시전자를 따라 움직인다. 시전자가 죽으면 그 자리에 남는다.
      if (z.followId >= 0) {
        const host = byId.get(z.followId);
        if (host && host.alive) {
          z.x = host.x;
          z.y = host.y;
        } else {
          z.followId = -1;
        }
      }
      const zd = ZONE_DEFS[z.kind]!;
      for (const e of g.entities) {
        if (!e.alive) continue;
        const d = def(e);
        const r = z.radius + d.radius;
        if (dist2(z.x, z.y, e.x, e.y) > r * r) continue;
        if (e.team !== z.team) {
          // 공격성 장판은 기본 지상 전용. hitsAir 장판(망자의 만찬·사후의 경계)만 공중도 걸린다.
          if (isFlying(g, e) && !zd.hitsAir) continue;
          // 적: 지속피해 + 둔화 (장판 안에 있는 동안 갱신, 나가면 0.3초 뒤 풀림)
          if (zd.dps && dmgTick && g.tick >= e.invulnUntil) e.hp -= zd.dps;
          if (zd.slow && d.speed > 0 && !isStatusImmune(e)) {
            const until = g.tick + 6;
            if (until > e.slowedUntil) e.slowedUntil = until;
          }
          // 끌어당김 (사후의 경계): 중앙 쪽으로 조금씩 빨려온다 (수호자는 안 끌려온다)
          if (zd.pull && d.speed > 0 && !isStatusImmune(e)) {
            const dx = z.x - e.x;
            const dy = z.y - e.y;
            const len = isqrt(dx * dx + dy * dy);
            if (len > 0) {
              const step = Math.min(zd.pull, len);
              e.x = clamp(e.x + idiv(dx * step, len), 0, g.map.length);
              e.y = clampLaneY(g.map, e.x, e.y + idiv(dy * step, len));
            }
          }
        } else if (z.kind === 'forest' && FOREST_BUFFS[e.defId]) {
          // 아군 실바린: 숲의 가호 마킹 (비행 포함 — 숲 위를 나는 것도 가호)
          const until = g.tick + 6;
          if (until > e.forestUntil) e.forestUntil = until;
        } else if (zd.healBioPerSec && dmgTick && d.tags.includes('bio')) {
          // 치유 포자 (balm): 장판 안의 아군 생체를 초당 회복
          const max = d.maxHp;
          if (e.hp < max) {
            e.hp += zd.healBioPerSec;
            if (e.hp > max) e.hp = max;
          }
        }
      }
    }
  }

  // 수비 모드: 이번 스텝의 "둥지 최근접 위협"을 한 번만 계산해 공유한다.
  // 위협 = 팀 0 이 아닌 유닛 중 아군 넥서스에 가장 가까운 것 (동률은 배열 앞쪽).
  let defendThreat: Entity | null = null;
  if (g.defendNexus) {
    const nx = g.map.nexusX[0];
    const ny = laneCenterY(g.map, nx);
    let bestD2 = -1;
    for (const v of g.entities) {
      if (!v.alive || v.team === 0) continue;
      const vd = def(v);
      if (vd.tier === 'structure') continue;
      const d2v = dist2(nx, ny, v.x, v.y);
      if (bestD2 < 0 || d2v < bestD2) {
        bestD2 = d2v;
        defendThreat = v;
      }
    }
    // 마중 반경 13타일 — 그보다 먼 위협은 무시하고 둥지 곁을 지킨다
    // (넓게 잡으면 위협이 바뀔 때마다 부대가 전장을 우왕좌왕 쏘다닌다)
    if (defendThreat && bestD2 > tiles(13) * tiles(13)) defendThreat = null;
  }

  // 1) 타겟팅
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    if (!d.weapon) {
      // 무기 없는 시전자(소환사 등)도 "교전 중인가"를 알아야 스킬을 쓴다.
      // 때릴 수는 없으니 canHit 을 따지지 않고 가까운 적을 잡아만 둔다.
      if (d.actives) e.targetId = findNearestFoe(g, e, d);
      continue;
    }
    // 혼란: 적아를 잃고 가장 가까운 "자기 편"을 조준한다 (도발보다도 우선).
    if (g.tick < e.confusedUntil) {
      e.targetId = findConfusedTarget(g, e, d);
      continue;
    }
    // 도발: 지속 중이면 다른 모든 판단(보복·최근접·대공 우선)보다 앞선다.
    if (g.tick < e.tauntedUntil) {
      const taunter = byId.get(e.tauntedBy);
      if (taunter && taunter.alive && canHit(g, d, taunter)) {
        e.targetId = taunter.id;
        continue;
      }
      e.tauntedUntil = 0; // 도발한 놈이 죽었으면 해제
    }

    const cur = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
    let valid = false;
    // cur.team 체크: 혼란 중 조준했던 "자기 편"이 회복 후에도 타겟으로 남아
    // 유닛이 아군만 영원히 따라다니는 바보 상태를 막는다
    if (cur && cur.alive && cur.team !== e.team && canHit(g, d, cur)) {
      const origin = acquireOrigin(e, d);
      const cd = def(cur);
      // 이미 문 대상은 탐지 거리의 1.3배까지 따라간다 (수호자는 앵커 기준 유지).
      const keep = idiv((d.acquireRange + d.radius + cd.radius) * 13, 10);
      valid = dist2(origin.x, origin.y, cur.x, cur.y) <= keep * keep;
    }

    // 보복 우선: 나를 때린 적을 내가 때릴 수 있으면 그쪽으로 전환한다.
    // 단, 현재 목표가 이미 나를 노리는 상호 교전이면 유지 (타겟 튐 방지).
    const atk = e.lastAttackerId >= 0 ? byId.get(e.lastAttackerId) : undefined;
    if (atk && atk.alive && atk.team !== e.team && atk.id !== e.targetId && canHit(g, d, atk)) {
      const curNow = valid ? byId.get(e.targetId) : undefined;
      const mutual = curNow !== undefined && curNow.targetId === e.id;
      if (!mutual) {
        const origin = acquireOrigin(e, d);
        const ad = def(atk);
        const reach = d.acquireRange + d.radius + ad.radius;
        if (dist2(origin.x, origin.y, atk.x, atk.y) <= reach * reach) {
          e.targetId = atk.id;
          valid = true;
        }
      }
    }

    // 공중 유닛: 현재 목표가 대공 불가(나를 위협하지 못하는 적)라면,
    // 탐지 범위 안의 대공 가능한 적으로 우선 전환한다.
    if (valid && d.flying) {
      const curT = byId.get(e.targetId);
      if (curT && !canTargetAir(def(curT))) {
        const found = findTarget(g, e, d); // findTarget 이 대공 우선으로 탐색
        if (found >= 0) {
          const ft = byId.get(found);
          if (ft && canTargetAir(def(ft))) e.targetId = found;
        }
      }
    }

    if (!valid) e.targetId = findTarget(g, e, d);
  }

  // 2) 이동
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    if (d.speed <= 0) continue;
    if (g.tick < e.rootedUntil || isIncapacitated(g, e)) continue; // 속박·기절·수면: 이동 불가
    if (selfbuffOf(d)?.holdGround && isBuffed(g, e, d)) continue; // 뿌리박기: 지속 중 이동 포기
    const slowed = isSlowed(g, e);

    // 공포: 싸움을 포기하고 자기 기지 방향으로 달아난다
    if (g.tick < e.fearedUntil) {
      // 야생(팀 2)은 기지가 없다 — 적(팀 1) 기지 쪽으로 달아나는 것으로 근사
      const nx = g.map.nexusX[e.team === 2 ? 1 : e.team];
      moveToward(g, e, d, nx, laneCenterY(g.map, nx), slowed);
      continue;
    }

    // 혼란: 조준한 "자기 편"에게 달려든다. 대상이 없으면 멍하니 제자리.
    if (g.tick < e.confusedUntil) {
      const ct = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
      if (ct && ct.alive && d.weapon) {
        const reach = d.weapon.range + d.radius + def(ct).radius;
        if (dist2(e.x, e.y, ct.x, ct.y) > reach * reach) {
          moveToward(g, e, d, ct.x, ct.y, slowed);
        }
      }
      continue;
    }

    // 전투형 힐러(사도)는 아군을 쫓지 않고 진군한다 — 숲을 몰고 전진하는 컨셉
    if (d.heal && !d.advancesWhileHealing) {
      // 힐러: 다친 아군을 따라다닌다. 없으면 진군 대열을 따른다.
      const wounded = findWoundedAlly(g, e, d, tiles(8));
      if (wounded) {
        const dd = dist2(e.x, e.y, wounded.x, wounded.y);
        const r = d.heal.range + d.radius;
        if (dd > r * r) moveToward(g, e, d, wounded.x, wounded.y, slowed);
        continue;
      }
    }

    const target = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
    if (target && target.alive && d.weapon) {
      const td = def(target);
      const reach = d.weapon.range + d.radius + td.radius;
      if (dist2(e.x, e.y, target.x, target.y) > reach * reach) {
        moveToward(g, e, d, target.x, target.y, slowed);
      }
      continue;
    }

    if (d.leashed) {
      // 수호자: 목표 없으면 앵커로 복귀.
      if (dist2(e.x, e.y, e.anchorX, e.anchorY) > tiles(0.5) * tiles(0.5)) {
        moveToward(g, e, d, e.anchorX, e.anchorY, slowed);
      }
      continue;
    }

    // 진군: 중앙선을 따라 적 넥서스 방향으로. (--_-- 같은 굽은 코리도어 지원)
    // 단, 적 넥서스가 아직 보호막(수호자 생존) 상태면 수호탑 자리까지만 밀고 간다.
    const m = g.map;
    const foe = enemyOf(e.team);
    let nexusX = g.guardianDown[foe] ? m.nexusX[foe] : m.towerX[foe];
    const dir = e.team === 0 ? 1 : -1;
    // 마몬의 상점 (점령제): 우리 팀 소유가 아니면 상점을 지나 진격하지 않는다 —
    // 점령이 먼저다. 부대가 상점 앞에 멈춰 서고, 단독 점유 10초로 깃발을 꽂는다.
    if (g.mercCaptureRequired && g.mercOwner !== e.team) {
      const shopX = idiv(m.length, 2);
      nexusX = dir > 0 ? Math.min(nexusX, shopX) : Math.max(nexusX, shopX);
    }
    // 디펜스전 (둥지 방어): 팀 0 부대는 수비선 너머로 진격하지 않는다
    if (g.holdLineX > 0 && e.team === 0) {
      nexusX = Math.min(nexusX, g.holdLineX);
    }
    // 수비 모드: 진군 대신 — 위협이 있으면 그 위치로 마중, 없으면 둥지 주변 대기
    if (g.defendNexus && e.team === 0) {
      if (defendThreat) {
        moveToward(g, e, d, defendThreat.x, defendThreat.y, slowed);
      } else {
        const hx = g.map.nexusX[0];
        const hy = laneCenterY(g.map, hx);
        // 둥지에서 4타일 넘게 떨어졌으면 복귀, 가까우면 제자리 (겹침은 separate 가 푼다)
        if (dist2(e.x, e.y, hx, hy) > tiles(4) * tiles(4)) {
          moveToward(g, e, d, hx, hy, slowed);
        }
      }
      continue;
    }
    const distToNexus = dir > 0 ? nexusX - e.x : e.x - nexusX;
    if (distToNexus <= tiles(6)) {
      // 넥서스가 가까우면 직접 향한다
      moveToward(g, e, d, nexusX, laneCenterY(m, nexusX), slowed);
    } else {
      // 전방 4타일 지점의 중앙선을 향해 (경사 구간에서 자연스럽게 꺾임)
      const lookX = clamp(e.x + dir * tiles(4), 0, m.length);
      moveToward(g, e, d, lookX, laneCenterY(m, lookX), slowed);
    }
  }

  // 3) 겹침 해소
  separate(g);

  // 4) 공격 (+ 액티브 시전)
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    // 무기가 없어도 액티브가 있으면 시전은 해야 한다 (소환사처럼 소환만 하는 유닛)
    if (!d.weapon && !d.actives) continue;

    if (d.weapon && e.cooldown > 0) {
      // 둔화 중엔 공속 절반: 짝수 틱에만 쿨다운이 준다.
      if (!isSlowed(g, e) || (g.tick & 1) === 0) e.cooldown--;
    }
    for (let i = 0; i < e.skillCds.length; i++) {
      if (e.skillCds[i]! > 0) e.skillCds[i]!--;
    }

    // 논스윙형 액티브 시전 (공격 쿨과 무관). 기절·수면·혼란 중엔 불가.
    const acts = d.actives;
    if (acts && !isIncapacitated(g, e) && g.tick >= e.confusedUntil && g.tick >= e.fearedUntil) {
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i]!;
        if (a.kind === 'strike' || e.skillCds[i]! > 0) continue;
        // 해금형 스킬: 소유자가 업그레이드를 사기 전엔 봉인 (사면 즉시 전 유닛 사용 가능)
        if (a.requiresUpgrade && (e.owner < 0 || !g.players[e.owner]?.upgrades[a.requiresUpgrade])) continue;
        const t = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
        const inCombat = t !== undefined && t.alive;
        switch (a.kind) {
          case 'selfbuff': // 교전 중 자가 강화
            if (inCombat) {
              e.buffUntil = g.tick + (a.durTicks ?? 0);
              e.skillCds[i] = a.cooldown;
            }
            break;
          case 'reflect': // 「가시 봉제」 교전 중 + 이미 맞고 있을 때 평타 반사막
            if (inCombat && e.hp < d.maxHp) {
              e.reflectUntil = g.tick + (a.durTicks ?? 0);
              e.skillCds[i] = a.cooldown;
            }
            break;
          case 'fear': { // 「자정의 종소리」 원거리 적 최우선으로 넓은 지역 공포
            const range = a.castRange ?? tiles(5);
            // 원거리 적(사거리 2타일 이상) 우선, 없으면 아무 이동 가능한 적
            const isRangedFoe = (v: Entity): boolean => {
              const vw = def(v).weapon;
              return vw !== undefined && vw.range >= tiles(2);
            };
            const aim = nearestFoeWithin(g, e, d, range, (v) => def(v).speed > 0 && isRangedFoe(v))
              ?? nearestFoeWithin(g, e, d, range, (v) => def(v).speed > 0);
            if (aim) {
              const r = a.splash ?? tiles(2.5);
              const until = g.tick + (a.durTicks ?? 0);
              // maxTargets 가 있으면 중심에서 가까운 순으로만 건다 (삽입 정렬,
              // 동률은 배열 앞쪽이 이긴다 — 결정론 규칙 그대로).
              const cap = a.maxTargets ?? Infinity;
              const picks: { v: Entity; d2: number }[] = [];
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team || def(v).speed <= 0) continue;
                if (g.tick < v.invulnUntil || isStatusImmune(v)) continue;
                const d2v = dist2(aim.x, aim.y, v.x, v.y);
                if (d2v > r * r) continue;
                if (cap === Infinity) {
                  if (until > v.fearedUntil) v.fearedUntil = until;
                  continue;
                }
                let at = picks.length;
                while (at > 0 && d2v < picks[at - 1]!.d2) at--;
                picks.splice(at, 0, { v, d2: d2v });
                if (picks.length > cap) picks.pop();
              }
              for (const p of picks) if (until > p.v.fearedUntil) p.v.fearedUntil = until;
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'zone': { // 장판 — 자기 위치(사도) 또는 원격 지점(블레이즈)
            if (!a.zone) break;
            // 고정 장판(사후의 경계류)은 교전 중에만 — 스폰 직후 기지 앞에
            // 허공 시전해 쿨을 태우는 낭비 방지. 추종 숲(사도)·원격 지정(블레이즈)은
            // 각각 항상 따라다니고 / 적이 있어야만 나가므로 예외.
            if (!a.zoneFollows && !a.zoneAtTarget && !inCombat) break;
            const z = a.zone;
            let zx = e.x;
            let zy = e.y;
            if (a.zoneAtTarget) {
              // 원격 시전: castRange 안 가장 가까운 적의 발밑에 깐다. 없으면 아낀다.
              // targets 가 지정되면 그 부류만 조준한다 (블레이즈 = 지상 전용).
              const aim = nearestFoeWithin(g, e, d, a.castRange ?? tiles(8), (v) => {
                if (a.targets === 'ground') return !isFlying(g, v);
                if (a.targets === 'air') return isFlying(g, v);
                return true;
              });
              if (!aim) break;
              zx = aim.x;
              zy = aim.y;
            }
            const follow = a.zoneFollows ? e.id : -1;
            let merged = false;
            for (const old of g.zones) {
              if (old.team !== e.team || old.kind !== z.kind) continue;
              if (dist2(old.x, old.y, zx, zy) > z.radius * z.radius) continue;
              old.x = zx;
              old.y = zy;
              old.untilTick = g.tick + z.ticks;
              old.followId = follow;
              merged = true;
              break;
            }
            if (!merged) {
              g.zones.push({
                id: g.nextZoneId++, team: e.team, kind: z.kind,
                x: zx, y: zy, radius: z.radius, untilTick: g.tick + z.ticks,
                followId: follow,
              });
            }
            // 시전 순간의 즉발 피해 (망자의 만찬의 "첫 피해") — 장판 범위 안 전원
            if (a.damage) {
              const br = a.splash ?? z.radius;
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team || isShielded(g, v)) continue;
                if (a.targets === 'ground' && isFlying(g, v)) continue;
                if (a.targets === 'air' && !isFlying(g, v)) continue;
                if (dist2(zx, zy, v.x, v.y) <= br * br) applyStrike(g, e, a, v);
              }
            }
            e.skillCds[i] = a.cooldown;
            break;
          }
          case 'ground': { // 「리버스그라비티」 범위 안 공중 적을 지상으로 끌어내림
            const aim = nearestFoeWithin(g, e, d, a.castRange ?? tiles(8),
              (v) => isFlying(g, v));
            if (aim) {
              const r = a.splash ?? tiles(2.5);
              const until = g.tick + (a.durTicks ?? 0);
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team || !isFlying(g, v)) continue;
                if (g.tick < v.invulnUntil || isStatusImmune(v)) continue;
                if (dist2(aim.x, aim.y, v.x, v.y) > r * r) continue;
                if (until > v.groundedUntil) v.groundedUntil = until;
              }
              dropFxZone(g, e.team, 'gravity', aim.x, aim.y, r);
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'slowfield': { // 「어스퀘이크」 넓은 지역의 지상 적 전원 둔화
            const aim = nearestFoeWithin(g, e, d, a.castRange ?? tiles(8),
              (v) => !isFlying(g, v));
            if (aim) {
              const r = a.splash ?? tiles(3);
              const until = g.tick + (a.durTicks ?? 0);
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team || isFlying(g, v)) continue;
                if (g.tick < v.invulnUntil || def(v).speed <= 0 || isStatusImmune(v)) continue;
                if (dist2(aim.x, aim.y, v.x, v.y) > r * r) continue;
                if (until > v.slowedUntil) v.slowedUntil = until;
              }
              dropFxZone(g, e.team, 'quake', aim.x, aim.y, r);
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'root': { // 「덩굴 옭아매기」류 — 시전자 주변 지상 적을 제자리에 묶는다
            if (!inCombat) break;
            const r = a.splash ?? tiles(1.8);
            const until = g.tick + (a.durTicks ?? 0);
            let hit = false;
            for (const v of g.entities) {
              if (!v.alive || v.team === e.team || isFlying(g, v)) continue;
              if (g.tick < v.invulnUntil || def(v).speed <= 0 || isStatusImmune(v)) continue;
              if (dist2(e.x, e.y, v.x, v.y) > r * r) continue;
              if (until > v.rootedUntil) v.rootedUntil = until;
              hit = true;
            }
            if (hit) e.skillCds[i] = a.cooldown;
            break;
          }
          case 'freeze': { // 「블리자드」 대상 지역 빙결 (판금·거대·구조물 면역)
            const canFreeze = (v: Entity): boolean =>
              !isStatusImmune(v) && !FREEZE_IMMUNE_TAGS.some((tag) => def(v).tags.includes(tag));
            const aim = nearestFoeWithin(g, e, d, a.castRange ?? tiles(8), canFreeze);
            if (aim) {
              const r = a.splash ?? tiles(2.5);
              const until = g.tick + (a.durTicks ?? 0);
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team || !canFreeze(v)) continue;
                if (g.tick < v.invulnUntil) continue;
                if (dist2(aim.x, aim.y, v.x, v.y) > r * r) continue;
                if (until > v.frozenUntil) v.frozenUntil = until;
              }
              dropFxZone(g, e.team, 'frost', aim.x, aim.y, r);
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'summon': { // 전투 중 소환 (소환수는 소유자 업그레이드 승계)
            const pool = a.summonIds ?? (a.summonId ? [a.summonId] : []);
            if (inCombat && pool.length > 0) {
              const n = a.summonCount ?? 1;
              for (let k = 0; k < n; k++) {
                // 여럿이면 매번 무작위 (게임 rng 라 모든 클라이언트가 같은 결과)
                const pick = pool.length === 1 ? pool[0]! : pool[nextInt(g.rng, pool.length)]!;
                const ov = e.owner >= 0 ? effectiveDef(pick, g.players[e.owner]!.upgrades) : undefined;
                const ang = k - (n - 1) / 2;
                const sx2 = clamp(e.x + Math.round(ang) * 300, 0, g.map.length);
                const sy2 = clampLaneY(g.map, sx2, e.y + (k % 2 === 0 ? 500 : -500) * (k + 1));
                spawnBattleEntity(g, pick, e.team, e.owner, sx2, sy2, ov);
              }
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'nuke': { // 무기와 무관하게 쿨마다 터지는 마법 (지옥불·화염구·망자의 만찬)
            const range = a.castRange ?? tiles(5);
            // 스킬 자체 대상 제한 (화살비 = 지상 전용) — 생략 시 무기 기준(canHit)
            const skillCanHit = (v: Entity): boolean => {
              if (a.targets === 'ground' && isFlying(g, v)) return false;
              if (a.targets === 'air' && !isFlying(g, v)) return false;
              return true;
            };
            const victim = pickNukeTarget(g, e, d, range, a.targetMode ?? 'nearest', skillCanHit);
            if (victim) {
              if (a.splash) {
                for (const v of g.entities) {
                  if (!v.alive || v.team === e.team || !canHit(g, d, v) || !skillCanHit(v)) continue;
                  if (dist2(victim.x, victim.y, v.x, v.y) <= a.splash * a.splash) applyStrike(g, e, a, v);
                }
              } else {
                applyStrike(g, e, a, victim);
              }
              if (a.fxZone) dropFxZone(g, e.team, a.fxZone, victim.x, victim.y, a.splash ?? tiles(0.8));
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'charm': { // 「인형의 실」 적 중급 이상 유닛을 영구 전향 — 티어 높은 순
            const range = a.castRange ?? tiles(6);
            let best: Entity | undefined;
            let bestKey = -1;
            for (const v of g.entities) {
              if (!v.alive || v.team === e.team || isShielded(g, v)) continue;
              if (g.tick < v.invulnUntil) continue;
              const vd = def(v);
              const rank = TIER_RANK[vd.tier] ?? -1;
              if (rank < CHARM_MIN_RANK) continue; // 중급 미만·구조물·수호자는 조종 불가
              const reach = range + d.radius + vd.radius;
              const d2v = dist2(e.x, e.y, v.x, v.y);
              if (d2v > reach * reach) continue;
              // 티어 서열 최우선, 같은 서열이면 가까운 쪽 (동률은 배열 앞쪽 — 결정론)
              const key = rank * 100_000_000_000 - d2v;
              if (best === undefined || key > bestKey) {
                best = v;
                bestKey = key;
              }
            }
            if (best) {
              best.team = e.team;
              best.owner = e.owner;
              best.targetId = -1;
              best.lastAttackerId = -1;
              best.tauntedUntil = 0;
              best.tauntedBy = -1;
              clearDebuffs(best);
              // 전향한 유닛을 겨누던 참조를 전부 끊는다 (아군 오사 방지)
              for (const o of g.entities) {
                if (o.targetId === best.id) o.targetId = -1;
                if (o.lastAttackerId === best.id) o.lastAttackerId = -1;
              }
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'confuse': { // 전투 중 혼란 — splash 가 있으면 목표 주변 범위, 없으면 단일
            if (!inCombat) break;
            const until = g.tick + (a.durTicks ?? 0);
            let hit = 0;
            const tryConfuse = (v: Entity): void => {
              if (def(v).speed <= 0 || g.tick < v.invulnUntil || isStatusImmune(v)) return;
              if (until > v.confusedUntil) v.confusedUntil = until;
              hit++;
            };
            if (a.splash) {
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team) continue;
                if (dist2(t!.x, t!.y, v.x, v.y) <= a.splash * a.splash) tryConfuse(v);
              }
            } else {
              tryConfuse(t!);
            }
            if (hit > 0) e.skillCds[i] = a.cooldown;
            break;
          }
          case 'allybuff': // 전투 중 주변 아군 공속 버프 (중복 없음 — 갱신만)
            if (inCombat) {
              const r = a.auraRadius ?? tiles(5);
              const until = g.tick + (a.durTicks ?? 0);
              for (const ally of g.entities) {
                if (!ally.alive || ally.team !== e.team) continue;
                if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
                if (until > ally.atkBuffUntil) ally.atkBuffUntil = until;
              }
              e.skillCds[i] = a.cooldown;
            }
            break;
          case 'invuln': // 전투 중 + 이미 피해를 입었을 때 무적
            if (inCombat && e.hp < d.maxHp) {
              e.invulnUntil = g.tick + (a.durTicks ?? 0);
              e.skillCds[i] = a.cooldown;
            }
            break;
          case 'allyarmor': { // 「가호」 주변 아군 방어력 버프 (중복 없음 — 더 센 쪽·더 긴 쪽)
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(5);
            const until = g.tick + (a.durTicks ?? 0);
            const add = a.armorAdd ?? 1;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              if (until > ally.armorBuffUntil || add > ally.armorBuffAdd) {
                ally.armorBuffUntil = Math.max(ally.armorBuffUntil, until);
                ally.armorBuffAdd = Math.max(ally.armorBuffAdd, add);
              }
            }
            e.skillCds[i] = a.cooldown;
            break;
          }
          case 'weaken': { // 「날개짓」 주변 적 공격력 감소
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(3.5);
            const until = g.tick + (a.durTicks ?? 0);
            let hit = 0;
            for (const foe of g.entities) {
              if (!foe.alive || foe.team === e.team) continue;
              if (!def(foe).weapon || g.tick < foe.invulnUntil || isStatusImmune(foe)) continue;
              if (dist2(e.x, e.y, foe.x, foe.y) > r * r) continue;
              if (until > foe.weakenedUntil) foe.weakenedUntil = until;
              hit++;
            }
            if (hit > 0) e.skillCds[i] = a.cooldown;
            break;
          }
          case 'cure': { // 「큐어」 주변 아군 1기의 디버프를 통째로 해제
            const r = a.auraRadius ?? tiles(5);
            let victim: Entity | undefined;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              if (!hasDebuff(g, ally)) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              victim = ally; // 배열 앞쪽 우선 — 결정론
              break;
            }
            if (victim) {
              clearDebuffs(victim);
              e.skillCds[i] = a.cooldown;
            }
            break;
          }
          case 'sleep': // 「수면」 현재 목표를 재운다 (이미 자는 대상엔 낭비하지 않는다)
            if (inCombat && def(t!).speed > 0 && g.tick >= t!.invulnUntil && g.tick >= t!.sleepUntil
              && !isStatusImmune(t!)) {
              t!.sleepUntil = g.tick + (a.durTicks ?? 0);
              t!.sleepHits = 0;
              e.skillCds[i] = a.cooldown;
            }
            break;
          case 'taunt': // 주변 적이 나를 우선 공격하게 만든다 (나를 때릴 수 있는 적만)
            if (inCombat) {
              const r = a.auraRadius ?? tiles(4);
              const until = g.tick + (a.durTicks ?? 0);
              let hooked = 0;
              for (const foe of g.entities) {
                if (!foe.alive || foe.team === e.team) continue;
                if (def(foe).speed <= 0 && !def(foe).weapon) continue;
                if (!canHit(g, def(foe), e)) continue; // 나를 때릴 수 없으면 도발도 무의미
                if (isStatusImmune(foe)) continue; // 수호자는 도발당하지 않는다
                if (dist2(e.x, e.y, foe.x, foe.y) > r * r) continue;
                foe.tauntedUntil = until;
                foe.tauntedBy = e.id;
                foe.targetId = e.id;
                hooked++;
              }
              if (hooked > 0) e.skillCds[i] = a.cooldown;
            }
            break;
        }
      }
    }

    if (!d.weapon) continue; // 여기부터는 평타 처리 — 무기 없는 시전자는 끝
    if (e.cooldown > 0) continue;
    if (isIncapacitated(g, e)) continue; // 기절·수면·빙결: 공격 불가
    if (g.tick < e.fearedUntil) continue; // 공포: 달아나느라 공격 불가
    // (혼란은 공격을 막지 않는다 — 타겟팅이 이미 자기 편을 조준하고 있다)

    const target = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
    if (!target || !target.alive || !canHit(g, d, target) || isShielded(g, target)) continue;
    // 혼란이 풀렸는데 아군을 조준 중이면 스윙 취소 (다음 틱 타겟팅이 정리)
    if (g.tick >= e.confusedUntil && target.team === e.team) continue;
    const td = def(target);
    const reach = d.weapon.range + d.radius + td.radius;
    if (dist2(e.x, e.y, target.x, target.y) > reach * reach) continue;

    // 액티브 strike (처형기): 조건이 맞으면 이번 스윙을 스킬로 대체
    if (acts) {
      let fired = false;
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i]!;
        if (a.kind !== 'strike' || e.skillCds[i]! > 0) continue;
        if (a.requiresUpgrade && (e.owner < 0 || !g.players[e.owner]?.upgrades[a.requiresUpgrade])) continue;
        if (a.executeBelowPct !== undefined && target.hp * 100 > td.maxHp * a.executeBelowPct) continue;
        // 스킬 자체 대상 제한 (와이번 내리꽂기 = 지상 전용) — 대상이 안 맞으면 쿨을 태우지 않는다
        const strikeCanHit = (v: Entity): boolean => {
          if (a.targets === 'ground' && isFlying(g, v)) return false;
          if (a.targets === 'air' && !isFlying(g, v)) return false;
          return true;
        };
        if (!strikeCanHit(target)) continue;
        if (a.splash) {
          const r = a.splash;
          for (const v of g.entities) {
            if (!v.alive || v.team === e.team || !canHit(g, d, v) || !strikeCanHit(v)) continue;
            if (dist2(target.x, target.y, v.x, v.y) <= r * r) applyStrike(g, e, a, v);
          }
        } else {
          applyStrike(g, e, a, target);
        }
        e.skillCds[i] = a.cooldown;
        e.cooldown = d.weapon.cooldown;
        fired = true;
        break;
      }
      if (fired) continue;
    }

    if (d.weapon.airMultiTargets && isFlying(g, target)) {
      // 다중 사격 (숲의 명궁): 공중 목표면 사거리 안 공중 적을 가까운 순 N기까지
      // 각각 정타로 맞힌다. 지상 목표는 아래의 일반 분기(단일)로 떨어진다.
      const n = d.weapon.airMultiTargets;
      const maxReach = d.weapon.range + d.radius;
      // 상위 N 유지 (삽입 정렬) — 동률은 배열 앞쪽이 이긴다 (strict <)
      const picks: { v: Entity; d2: number }[] = [];
      for (const v of g.entities) {
        if (!v.alive || v.team !== target.team || v.id === e.id || !isFlying(g, v) || isShielded(g, v)) continue;
        const reach = maxReach + def(v).radius;
        const d2v = dist2(e.x, e.y, v.x, v.y);
        if (d2v > reach * reach) continue;
        let at = picks.length;
        while (at > 0 && d2v < picks[at - 1]!.d2) at--;
        picks.splice(at, 0, { v, d2: d2v });
        if (picks.length > n) picks.pop();
      }
      for (const p of picks) applyDamage(g, e, d, p.v);
    } else if (d.weapon.splash && !(d.weapon.splashAirOnly && !isFlying(g, target))) {
      // splashAirOnly: 공중을 때릴 때만 광역 — 지상 타겟은 아래 단일 타격으로 빠진다
      const r = d.weapon.splash;
      const airOnly = d.weapon.splashAirOnly === true;
      for (const v of g.entities) {
        if (!v.alive || v.team !== target.team || v.id === e.id || !canHit(g, d, v) || isShielded(g, v)) continue;
        if (airOnly && !isFlying(g, v)) continue; // 공중 전용 폭발은 지상을 휩쓸지 않는다
        if (dist2(target.x, target.y, v.x, v.y) <= r * r) applyDamage(g, e, d, v);
      }
    } else {
      applyDamage(g, e, d, target);
    }
    // 장판 생성: 공격당 1번, 명중 지점에 (스플래시와 무관).
    // 근처(반경 이내)에 같은 팀·종류 장판이 있으면 새로 깔지 않고 갱신 —
    // 연사로 같은 자리에 겹겹이 쌓여 효과가 중첩되는 것을 막는다.
    if (d.weapon.zone) {
      const z = d.weapon.zone;
      let merged = false;
      for (const old of g.zones) {
        if (old.team !== e.team || old.kind !== z.kind) continue;
        if (dist2(old.x, old.y, target.x, target.y) > z.radius * z.radius) continue;
        old.x = target.x;
        old.y = target.y;
        old.untilTick = g.tick + z.ticks;
        old.followId = -1;
        merged = true;
        break;
      }
      if (!merged) {
        g.zones.push({
          id: g.nextZoneId++, team: e.team, kind: z.kind,
          x: target.x, y: target.y, radius: z.radius, untilTick: g.tick + z.ticks,
          followId: -1,
        });
      }
    }
    let cd = d.weapon.cooldown;
    // 공속 버프 (태엽 감기 + 숲의 가호 + 군세강화)
    const atkPct = atkSpeedPctOf(g, e, d);
    if (atkPct > 0) cd = Math.max(1, idiv(cd * 100, 100 + atkPct));
    // 한기: 공속 -CHILL_PCT% (쿨다운이 그만큼 길어진다)
    if (g.tick < e.chilledUntil) cd = idiv(cd * 100, 100 - CHILL_PCT);
    e.cooldown = cd;
  }

  // 5) 힐
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    if (!d.heal) continue;
    if (e.healCooldown > 0) {
      e.healCooldown--;
      continue;
    }
    if (g.tick < e.confusedUntil || g.tick < e.fearedUntil || isIncapacitated(g, e)) continue; // 혼란·공포·기절·수면: 치유 불가
    const ally = findWoundedAlly(g, e, d, d.heal.range + d.radius);
    if (ally) {
      // 중복힐 상한: 같은 대상에게 1초 안에 최대 3회 — 힐러가 몰려도 무한 탱킹 방지
      if (g.tick - ally.healWindowStart >= 20) {
        ally.healWindowStart = g.tick;
        ally.healsInWindow = 0;
      }
      if (ally.healsInWindow >= 3) continue; // 쿨 소모 없이 다음 틱에 재판정
      ally.healsInWindow++;
      ally.hp += d.heal.amount;
      const max = def(ally).maxHp;
      if (ally.hp > max) ally.hp = max;
      e.healCooldown = d.heal.cooldown;
    }
  }

  // 부활 대기 처리: 시간이 되면 되살아난다
  for (const e of g.entities) {
    if (!e.alive || e.reviveAtTick === undefined) continue;
    if (g.tick >= e.reviveAtTick) {
      const d = def(e);
      e.hp = idiv(d.maxHp * (d.rebirth?.hpPct ?? 50), 100);
      delete e.reviveAtTick;
    }
  }

  // 6) 사망 처리
  for (const e of g.entities) {
    if (!e.alive || e.hp > 0) continue;
    // 1회 부활 (검은새): 죽는 대신 쓰러져 있다가 되살아난다
    {
      const rb = def(e).rebirth;
      if (rb && !e.rebirthUsed) {
        e.rebirthUsed = true;
        e.hp = 1;
        e.reviveAtTick = g.tick + rb.delayTicks;
        e.invulnUntil = g.tick + rb.delayTicks; // 쓰러진 동안 무적
        e.stunnedUntil = g.tick + rb.delayTicks; // + 행동불능
        continue;
      }
    }
    e.alive = false;
    if (e.defId === 'tower') {
      const t = e.team as TeamId; // 구조물은 팀 0|1 만 존재
      g.events.push({ tick: g.tick, kind: 'towerDown', team: t });
      // 파괴 보상: 부순 팀 전원에게 지급
      const winners = enemyOf(t);
      for (const p of g.players) {
        if (p.team === winners) p.money += MAP.TOWER_BOUNTY;
      }
      spawnGuardian(g, t, e.x, e.y);
    } else if (e.defId === 'nexus') {
      const winner = enemyOf(e.team as TeamId);
      g.over = { winner };
      g.events.push({ tick: g.tick, kind: 'gameOver', winner });
    } else if (def(e).tier === 'guardian') {
      const t = e.team as TeamId; // 수호자도 팀 0|1 만 존재
      // 수호자 격파 → 이 팀의 넥서스 보호막 해제 + 부순 팀 전원에게 보상
      g.guardianDown[t] = true;
      const winners = enemyOf(t);
      for (const p of g.players) {
        if (p.team === winners) p.money += MAP.GUARDIAN_BOUNTY;
      }
      g.events.push({ tick: g.tick, kind: 'guardianDown', team: t });
    }
  }

  // 7) 주기적 압축 (배열 순서 유지, 죽은 것만 제거)
  if (g.tick % 100 === 0) {
    g.entities = g.entities.filter((e) => e.alive);
  }
}

function findWoundedAlly(g: Game, healer: Entity, d: EntityDef, range: number): Entity | null {
  let best: Entity | null = null;
  let bestRatio = 1_000_000;
  for (const t of g.entities) {
    if (!t.alive || t.team !== healer.team || t.id === healer.id) continue;
    const td = def(t);
    // 구조물·수호자는 치유 대상이 아니다 (힐러가 중간보스에 눌러앉는 것 방지).
    // 예외: 수비 모드(둥지 방어)의 아군 넥서스(둥지)는 치유할 수 있다.
    const nestHealable = g.defendNexus && t.defId === 'nexus' && t.team === healer.team;
    if ((td.tier === 'structure' && !nestHealable) || td.tier === 'guardian' || td.heal) continue;
    if (t.hp >= td.maxHp) continue;
    // 수리 불가 대상 (예: 재봉사는 언데드를 수리할 수 없다)
    if (d.heal!.excludeTags?.some((tag) => td.tags.includes(tag))) continue;
    if (dist2(healer.x, healer.y, t.x, t.y) > range * range) continue;
    // 체력 비율(1000분율)이 가장 낮은 아군.
    const ratio = idiv(t.hp * 1000, td.maxHp);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = t;
    }
  }
  return best;
}
