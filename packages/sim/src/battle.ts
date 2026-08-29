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
  FREEZE_IMMUNE_TAGS, FX_ZONE_TICKS, TIER_RANK, CHARM_MIN_RANK, effectiveDef, laneCenterY, clampLaneY, isWalkable, flowStep, flowStepTo,
} from './data.ts';
import { dist2, idiv, isqrt, clamp, seconds, tiles, TICK_HZ } from './math.ts';
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

/**
 * 구조물을 때리는 중 주위를 살피는 탐지 거리 배율 (%).
 * 100 = 평소 탐지 거리 그대로. 2배로 넓혀 봤더니 넥서스를 놔두고 유닛만
 * 쫓아다녀 공성이 지지부진해졌다 — 곁의 적만 알아채면 충분하다.
 */
const STRUCT_SCAN_PCT = 100;

/** 유효 비행 판정 — 「리버스그라비티」로 끌어내려진 공중 유닛은 지상 취급. */
function isFlying(g: Game, e: Entity): boolean {
  // 드로셀마이어 「부양」으로 띄워진 유닛은 지상 유닛이어도 공중 취급 —
  // 땅을 기는 공격은 닿지 않는다.
  if (g.tick < e.levitateUntil) return true;
  return def(e).flying && g.tick >= e.groundedUntil;
}

function canHit(g: Game, attacker: EntityDef, target: Entity): boolean {
  if (g.tick < target.buriedUntil) return false; // 「토끼굴」 땅속엔 닿지 않는다
  if (g.tick < target.vanishUntil) return false; // 「커튼콜」 무대 밖 — 존재하지 않는 것과 같다
  const w = attacker.weapon;
  if (!w) return false;
  // 영구 무적(둥지 수호탑): 어차피 피해가 안 들어가므로 아예 조준하지 않는다 —
  // 무적 몸빵이 적 화력을 빨아들이는 것 방지. 일시 무적(인비저블)은 그대로 조준된다.
  if (target.invulnUntil >= Number.MAX_SAFE_INTEGER) return false;
  // 은신(인큐버스): 아예 보이지 않는다 — 조준 불가
  if (g.tick < target.stealthUntil) return false;
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

/**
 * 주술 결계 — 결계 원 밖에 선 자는 이 유닛을 노릴 수 없다.
 *
 * 기준은 「공격자가 원 안에 있느냐」다: 갱 안으로 들어가면 원거리도 때릴 수 있고,
 * 밖에서는 사거리가 아무리 길어도 닿지 않는다. 결계를 세운 주술사가 죽으면
 * 캠페인 레이어가 wardUntil 을 지워 한 번에 풀린다.
 * (15 「에메랄드 숲의 값」 — 갱을 밖에서 갉지 못하게 해 근접을 들여보내게 만든다)
 *
 * 결정론: 정수 거리 비교뿐이다.
 */
function wardBlocks(g: Game, attacker: Entity, t: Entity): boolean {
  if (g.tick >= t.wardUntil || t.wardR <= 0) return false;
  return dist2(attacker.x, attacker.y, t.wardX, t.wardY) > t.wardR * t.wardR;
}

/** 수호자(중간보스)는 모든 상태이상에 면역이다. */
function isStatusImmune(e: Entity): boolean {
  const d = def(e);
  // warded: 에버그린 「숲의 가호」를 나눠 받은 아군 (판이 끝날 때까지 유지)
  return d.tier === 'guardian' || d.statusImmune === true || e.warded;
}

/** 마법(액티브) 면역 — 넥서스. 스킬 피해도 장판 효과도 받지 않는다. */
function isMagicImmune(e: Entity): boolean {
  return def(e).magicImmune === true;
}

/**
 * 상태이상 차단 판정 — 수호자 / 인큐버스 「완전 해제」 20초 면역 /
 * 하얀토끼 「멈춘 시계」 영구 면역.
 */
function blocksStatus(g: Game, e: Entity): boolean {
  return isStatusImmune(e) || e.timeLocked || g.tick < e.purgeImmuneUntil;
}

/** 행동 불가 상태 (기절·수면·빙결). */
function isIncapacitated(g: Game, e: Entity): boolean {
  if (g.tick < e.vanishUntil) return true; // 「커튼콜」 무대 밖 — 아무것도 못 한다
  return g.tick < e.stunnedUntil || g.tick < e.sleepUntil || g.tick < e.frozenUntil;
}

/** 「큐어」 대상 판정: 하나라도 해로운 상태가 걸려 있는가. */
/**
 * 이 액티브를 지금 쓸 수 있는가.
 * 차지 스킬(엘로윈 「비전 축적」)은 남은 차지가 있어야 하고, 연달아 쏘는
 * 간격(chargeGap)만큼은 쉬어야 한다 — 그 간격도 skillCds 로 잰다.
 */
function skillReady(e: Entity, i: number, a: ActiveSkill): boolean {
  if (e.skillCds[i]! > 0) return false;
  if (a.charges) return (e.skillCharges[i] ?? 0) > 0;
  return true;
}

/** 액티브를 썼다 — 차지 스킬이면 차지를 한 장 쓰고 짧은 간격만 두고, 아니면 통쿨. */
function spendSkill(e: Entity, i: number, a: ActiveSkill): void {
  if (a.charges) {
    e.skillCharges[i] = Math.max(0, (e.skillCharges[i] ?? 0) - 1);
    e.skillCds[i] = a.chargeGap ?? SEC3;
    // 가득 찬 상태에서 처음 한 장을 썼다면 그때부터 재충전이 돈다
    if (e.skillRegen[i] === 0) e.skillRegen[i] = a.cooldown;
    return;
  }
  e.skillCds[i] = a.cooldown;
}

/**
 * 이번 스윙이 끝난 뒤의 평타 쿨 (틱).
 * 「가속 시전」(엘로윈)처럼 사이클이 있으면 쏠 때마다 다음 칸으로 넘어간다 —
 * 1.4 → 1.2 → 1.0 → 0.8 → 0.6 → 0.8 → … 처럼 빨라졌다 느려지기를 반복한다.
 */
function swingCooldown(e: Entity, d: EntityDef): number {
  const cyc = d.cadence;
  if (!cyc || cyc.length === 0) return d.weapon!.cooldown;
  const cd = cyc[e.cadenceIdx % cyc.length]!;
  e.cadenceIdx = (e.cadenceIdx + 1) % cyc.length;
  return cd;
}

/** 차지 스킬의 기본 연사 간격 (3초). */
const SEC3 = TICK_HZ * 3;

function hasDebuff(g: Game, e: Entity): boolean {
  return g.tick < e.slowedUntil || g.tick < e.dotUntil || g.tick < e.rootedUntil
    || g.tick < e.stunnedUntil || g.tick < e.confusedUntil
    || g.tick < e.weakenedUntil || g.tick < e.sleepUntil
    || g.tick < e.frozenUntil || g.tick < e.groundedUntil
    || g.tick < e.chilledUntil || g.tick < e.fearedUntil
    || g.tick < e.seducedUntil || g.tick < e.burnUntil || g.tick < e.chokedUntil;
}

/**
 * 「중독 방지막」 지속 시간 — 치유를 받은 뒤 이만큼 독에 다시 안 걸린다.
 *
 * 4 「독이 스민 숲」의 역병 늪은 밟는 동안 매 틱 독을 새로 얹는다. 치유가
 * 독을 씻기만 하면 다음 틱에 그대로 다시 걸려서 힐러를 사도 소용이 없었다.
 * 「치유 = 잠깐의 면역」이라야 늪을 건너는 그림이 나온다.
 */
const POISON_WARD = seconds(7);

/** 치유를 받았다 — 독을 씻어내고 잠시 다시 안 걸리게 한다. */
function wardPoison(g: Game, e: Entity): void {
  e.dotUntil = 0;
  e.dotDps = 0;
  const until = g.tick + POISON_WARD;
  if (until > e.poisonWardUntil) e.poisonWardUntil = until;
}

/** 지금 독에 다시 걸릴 수 없는가 (치유 직후). */
function poisonWarded(g: Game, e: Entity): boolean {
  return g.tick < e.poisonWardUntil;
}

/** 걸려 있는 해로운 상태를 전부 지운다 (버프는 유지). */
/**
 * 「질식」 중에는 어떤 해제도 통하지 않는다 — 큐어를 받아도 그대로다.
 * 질식 자체는 시간이 지나야만 풀린다.
 */
function clearDebuffs(g: Game, e: Entity): void {
  if (g.tick < e.chokedUntil) return;
  e.burnUntil = 0;
  e.burnDps = 0;
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
  e.seducedUntil = 0;
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
/**
 * 암살 조준 — 은신 중에는 앞줄을 지나쳐 뒤를 노린다.
 *
 * 지원가(치유·강화) > 원거리 > 지금 체력이 가장 적은 적 순으로 고른다.
 * 같은 등급이면 체력이 적은 쪽, 그래도 같으면 배열 앞쪽이 이긴다 (결정론).
 * 은신 중엔 반격을 안 받으므로 평소보다 두 배 멀리 본다 — 그래야 후열까지 닿는다.
 */
function findAssassinTarget(g: Game, e: Entity, d: EntityDef): number {
  const origin = acquireOrigin(e, d);
  const reach = d.acquireRange * 2 + d.radius;
  let bestId = -1;
  let bestRank = 0;
  let bestHp = 0;
  for (const v of g.entities) {
    if (!v.alive || v.team === e.team || !canHit(g, d, v)) continue;
    if (g.tick < v.stealthUntil || g.tick < v.buriedUntil || g.tick < v.vanishUntil) continue;
    const vd = def(v);
    if (vd.tier === 'structure') continue; // 건물은 암살할 것이 없다
    const r = reach + vd.radius;
    if (dist2(origin.x, origin.y, v.x, v.y) > r * r) continue;
    const rank = isSupportFoe(vd) ? 0
      : (vd.weapon !== undefined && vd.weapon.range >= tiles(2) ? 1 : 2);
    if (bestId < 0 || rank < bestRank || (rank === bestRank && v.hp < bestHp)) {
      bestId = v.id;
      bestRank = rank;
      bestHp = v.hp;
    }
  }
  return bestId;
}

function acquireOrigin(e: Entity, d: EntityDef): { x: number; y: number } {
  return d.leashed ? { x: e.anchorX, y: e.anchorY } : { x: e.x, y: e.y };
}

/** 어떤 두 유닛의 반경 합보다도 큰 값 — 거리 선검사용 (최대 반경 1.4타일 x 2). */
const SEP_MAX = 2800;

/** 이 유닛(정의)이 공중을 때릴 수 있는가. */
function canTargetAir(d: EntityDef): boolean {
  return d.weapon !== undefined && d.weapon.targets !== 'ground';
}

/**
 * 탐지 거리 안 가장 가까운 적. skipStructures 면 구조물(넥서스·수호탑)을 건너뛰고,
 * rangePct 로 탐지 거리를 늘린다 (구조물을 때리는 중엔 주위를 더 넓게 살핀다).
 */
function findTarget(g: Game, e: Entity, d: EntityDef, skipStructures = false, rangePct = 100): number {
  const origin = acquireOrigin(e, d);
  const acquire = rangePct === 100 ? d.acquireRange : idiv(d.acquireRange * rangePct, 100);
  let best = -1;
  let bestD2 = -1;
  // 공중 유닛은 대공 가능한 적(=나를 위협하는 적)을 우선한다.
  let bestAA = -1;
  let bestAAD2 = -1;
  // 「하늘 우선」 조준 후보
  let bestPref = -1;
  let bestPrefD2 = -1;
  // 사거리 밖은 좌표 뺄셈만으로 걷어낸다 — 아래 canHit/isShielded/def 는
  // 쌍마다 함수 호출이라, 후반에 수백 기가 몰리면 조준 한 번에 그게 다 돈다.
  // 어떤 유닛의 반경도 SEP_MAX/2 를 넘지 않으므로 결과는 달라지지 않는다.
  const coarse = acquire + d.radius + SEP_MAX / 2;
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team) continue;
    const cdx = t.x - origin.x;
    if (cdx > coarse || cdx < -coarse) continue;
    const cdy = t.y - origin.y;
    if (cdy > coarse || cdy < -coarse) continue;
    if (!canHit(g, d, t) || isShielded(g, t) || wardBlocks(g, e, t)) continue;
    const td = def(t);
    if (skipStructures && td.tier === 'structure') continue;
    const reach = acquire + d.radius + td.radius;
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
    // 「하늘 우선」(모자장수): 사거리 안에 뜬 것이 있으면 땅보다 먼저 노린다
    if (d.weapon?.preferAir && isFlying(g, t) && (bestPref === -1 || d2 < bestPrefD2)) {
      bestPref = t.id;
      bestPrefD2 = d2;
    }
    // 「땅 우선」(오베론): 하늘도 때리지만 목표는 늘 지상부터
    if (d.weapon?.preferGround && !isFlying(g, t) && (bestPref === -1 || d2 < bestPrefD2)) {
      bestPref = t.id;
      bestPrefD2 = d2;
    }
  }
  if ((d.weapon?.preferAir || d.weapon?.preferGround) && bestPref !== -1) return bestPref;
  return d.flying && bestAA !== -1 ? bestAA : best;
}

/**
 * 집결 경계 — 「집결 지점 둘레」 안에 든 적.
 *
 * 집결 명령은 「여기 서 있어라」가 아니라 「여기를 지켜라」다. 표식 한가운데로
 * 부대를 모으고 나니, 탐지 거리(대부분 5~6타일) 밖의 적은 아예 못 본 채 멀뚱히
 * 서 있고 적이 코앞까지 걸어와야 싸움이 시작됐다. 집결 중인 부대는 표식에서
 * RALLY_GUARD 안에 든 적이면 스스로 나가서 문다 — 잡고 나면 표식으로 돌아온다.
 * 건물은 세지 않는다 (지키는 것이지 공성이 아니다).
 */
const RALLY_GUARD = tiles(9);

/** 이 유닛이 플레이어의 집결 명령을 따르는가 (주둔·수비대·수호자는 제외). */
function rallyBound(g: Game, e: Entity, d: EntityDef): boolean {
  return g.rallyX > 0 && e.team === 0 && !!g.map.mask
    && e.garrisonR <= 0 && e.homeX < 0 && !d.leashed && !d.flees;
}

function rallyGuardTarget(g: Game, e: Entity, d: EntityDef): number {
  const gr2 = RALLY_GUARD * RALLY_GUARD;
  let best = -1;
  let bestD2 = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team) continue;
    if (def(t).tier === 'structure') continue;
    if (!canHit(g, d, t) || isShielded(g, t) || wardBlocks(g, e, t)) continue;
    if (dist2(t.x, t.y, g.rallyX, g.rallyY) > gr2) continue;
    const d2 = dist2(e.x, e.y, t.x, t.y);
    if (best === -1 || d2 < bestD2) {
      best = t.id;
      bestD2 = d2;
    }
  }
  return best;
}

/** 혼란 상태: 탐지 거리 안 가장 가까운 "자기 편" (자신 제외, 무기로 때릴 수 있는 대상만). */
function findConfusedTarget(g: Game, e: Entity, d: EntityDef): number {
  let best = -1;
  let bestD2 = -1;
  for (const t of g.entities) {
    if (!t.alive || t.team !== e.team || t.id === e.id) continue;
    if (!canHit(g, d, t) || isShielded(g, t) || wardBlocks(g, e, t)) continue;
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
    // 영구 무적 소품(불타는 나무 등)은 스킬 조준 대상이 아니다 — 허공에 낭비 방지
    if (t.invulnUntil >= Number.MAX_SAFE_INTEGER) continue;
    if (g.tick < t.stealthUntil) continue; // 은신은 스킬로도 못 노린다
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
    untilTick: g.tick + FX_ZONE_TICKS, followId: -1, dpsOverride: 0,
  });
}

function isSlowed(g: Game, e: Entity): boolean {
  return g.tick < e.slowedUntil;
}

/**
 * 정의에서 은신 스킬을 찾는다 (유닛당 최대 1개 가정).
 * 은신 중 붙는 보너스(공격력·이속·암살 조준)를 여기서 읽는다.
 */
function stealthSkillOf(d: EntityDef): ActiveSkill | undefined {
  return d.actives?.find((a) => a.kind === 'stealth');
}

/** 지금 은신해 있고, 그 은신에 이 보너스가 달려 있는가. */
function hidden(g: Game, e: Entity, d: EntityDef): ActiveSkill | undefined {
  if (g.tick >= e.stealthUntil) return undefined;
  return stealthSkillOf(d);
}

/**
 * 아군을 살리거나 북돋우는 유닛 — 암살 1순위.
 * 「그림자 도약」(오베론)과 같은 기준으로 support 태그를 먼저 본다.
 * 태그가 안 붙은 유닛도 있어서 치유 능력과 지원형 액티브를 함께 따진다.
 */
const SUPPORT_KINDS = new Set<ActiveSkill['kind']>([
  'allybuff', 'allyarmor', 'cure', 'regenAura', 'wardShield', 'hasteAlly', 'critAura',
]);
function isSupportFoe(d: EntityDef): boolean {
  if (d.tags.includes('support') || d.heal) return true;
  return d.actives?.some((a) => SUPPORT_KINDS.has(a.kind)) ?? false;
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
  armor += e.sacrificeStacks * 2; // 제물 흡수 (인큐버스)
  if (e.auraKind === 1) armor += 4; // 디멘터 오라 유형1
  return armor;
}

/** 보호막이 남아 있으면 먼저 깎는다. 반환값 = 체력에 실제로 들어갈 피해. */
function soakShield(victim: Entity, dmg: number): number {
  if (victim.shieldHp <= 0 || dmg <= 0) return dmg;
  const soak = Math.min(victim.shieldHp, dmg);
  victim.shieldHp -= soak;
  return dmg - soak;
}

/**
 * 실제 공격 사거리. 디멘터 오라 유형2 는 +1타일.
 * 대상이 공중이고 airRange 가 있으면 그쪽을 쓴다 (모자장수: 지상은 짧고 하늘은 멀리).
 * 파랑 모자 중에는 공중 사거리가 1타일 더 늘어난다.
 */
function rangeOf(g: Game, e: Entity, d: EntityDef, targetFlying?: boolean): number {
  const w = d.weapon;
  if (!w) return 0;
  let base = w.range;
  if (targetFlying && w.airRange !== undefined) {
    base = w.airRange;
    if (e.hatKind === 2 || e.hatKind === 4) base += tiles(1); // 파랑/황금 모자
  }
  if (e.auraKind === 2) base += tiles(1);   // 디멘터 오라 유형2
  if (g.tick < e.moonveilUntil) base -= tiles(1); // 「인분의 장막」
  return base < tiles(0.4) ? tiles(0.4) : base;
}

/** 이 유닛이 낼 수 있는 최대 사거리 (조준·접근 판단용). */
function maxRangeOf(g: Game, e: Entity, d: EntityDef): number {
  const w = d.weapon;
  if (!w) return 0;
  const air = w.airRange !== undefined ? rangeOf(g, e, d, true) : 0;
  return Math.max(rangeOf(g, e, d, false), air);
}

/** 공속 버프 합산 % (자가 버프 + 숲의 가호 + 군세강화). */
function atkSpeedPctOf(g: Game, e: Entity, d: EntityDef): number {
  let pct = 0;
  const sb = selfbuffOf(d);
  if (sb?.atkSpeedPct && isBuffed(g, e, d)) pct += sb.atkSpeedPct;
  const fb = forestBuffOf(g, e);
  if (fb?.atkSpeedPct) pct += fb.atkSpeedPct;
  if (g.tick < e.atkBuffUntil) pct += 10; // 군세강화 (중복 없음 — 갱신만)
  pct += e.sacrificeStacks * 10; // 제물 흡수 (인큐버스): 스택당 공속 +10%
  if (e.auraKind === 4) pct += 10; // 디멘터 「종말의 오라」
  if (g.tick < e.moonveilUntil) pct -= 10; // 「인분의 장막」
  return pct;
}

/**
 * 그 x 에서 노릴 y — 보통은 중앙선이지만, 격자 마스크 맵에서는
 * 지금 서 있는 줄에서 가장 가까운 「밟을 수 있는」 자리를 고른다.
 */
function aimY(g: Game, x: number, curY: number): number {
  const c = laneCenterY(g.map, x);
  if (!g.map.mask) return c;
  // 중앙선이 곧 「그림에 그려진 길」이다. 그 자리가 막혀 있을 때만 근처로 비킨다.
  if (isWalkable(g.map, x, c)) return c;
  return clampLaneY(g.map, x, curY);
}

/**
 * 이 유닛이 격자 마스크(나무·물·바위)에 막히는가.
 * 비행은 지형을 넘어가므로 마스크를 무시한다 — 강 위·숲 위를 그대로 난다.
 */
function blockedByTerrain(g: Game, d: EntityDef): boolean {
  return !!g.map.mask && !d.flying;
}

/**
 * 집결 지점에 「도착했다」고 보는 거리.
 *
 * 0 이면 전원이 정확히 같은 칸을 밀며 영원히 자리다툼을 한다. 한 타일쯤
 * 여유를 주면 그 둘레에 자연스럽게 뭉치고, 겹침 해소가 알아서 펴 준다.
 */
const RALLY_HOLD = tiles(1.0);

/** 벽 안에 끼인 유닛이 길로 빠져나오는 한 틱 분량. */
const UNSTICK_STEP = tiles(0.4);

/**
 * 벽(나무·물·바위) 안에 들어가 버린 지상 유닛을 길 쪽으로 조금씩 밀어낸다.
 *
 * 예전엔 clampLaneY 로 「가장 가까운 길」에 한 번에 붙여 놨는데, 그 길이 몇
 * 타일 밖이면 유닛이 나무 지대를 가로질러 순간이동한 것처럼 보였다.
 * 한 틱에 0.4타일씩만 옮기면 벽에서 걸어 나오는 그림이 된다.
 */
function nudgeOntoPath(g: Game, e: Entity): void {
  const cy = clampLaneY(g.map, e.x, e.y);
  const dy = cy - e.y;
  if (dy === 0) return;
  if (dy > UNSTICK_STEP) e.y += UNSTICK_STEP;
  else if (dy < -UNSTICK_STEP) e.y -= UNSTICK_STEP;
  else e.y = cy;
}

/**
 * 두 점 사이가 마스크상 「직선으로 걸어서」 이어지는가 (거친 샘플).
 *
 * 정밀한 시야 판정이 아니라 「이대로 밀어붙이면 벽에 낀다」만 걸러낸다.
 * moveToward 의 벽 미끄러짐은 한 틱 이동거리의 4배까지만 옆을 훑으므로,
 * 몇 타일 떨어진 우회로(다리·길목)는 못 찾는다 — 그건 흐름장의 몫이다.
 *
 * 결정론: 정수 나눗셈 샘플 + 고정 개수.
 */
function walkLineClear(m: Game['map'], x0: number, y0: number, x1: number, y1: number): boolean {
  if (!m.mask) return true;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = isqrt(dx * dx + dy * dy);
  if (len <= 0) return true;
  // 마스크 칸보다 촘촘하게, 다만 24 샘플을 넘지 않게 (추격 사거리는 길어야 8타일)
  let n = idiv(len, tiles(4) / 10) + 1;
  if (n > 24) n = 24;
  for (let i = 1; i < n; i++) {
    if (!isWalkable(m, x0 + idiv(dx * i, n), y0 + idiv(dy * i, n))) return false;
  }
  return true;
}
function moveToward(
  g: Game, e: Entity, d: EntityDef, tx: number, ty: number, slowed: boolean,
  /** 추가 이속 보정(%) — 고립 도주처럼 이 이동에만 붙는 값. */
  bonusPct = 0,
): void {
  if (d.speed <= 0) return;
  // 어떤 이유로든 막힌 칸에 있으면(밀침·소환 등) 먼저 길 위로 나온다
  if (blockedByTerrain(g, d) && !isWalkable(g.map, e.x, e.y)) nudgeOntoPath(g, e);
  const dx = tx - e.x;
  const dy = ty - e.y;
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return;
  // 암살 은신(「덩굴 잠행」): 덩굴 사이로 파고드는 동안은 발이 빨라진다 —
  // 둔화 계산 전에 얹어야 「느려진 상태에서도 은신이 도움이 되는」 그림이 된다
  const hideMv = hidden(g, e, d)?.stealthSpeedAdd ?? 0;
  const baseSpd = d.speed + hideMv;
  let step = slowed ? idiv(baseSpd * 3, 5) : baseSpd;
  if (g.tick < e.chilledUntil) step = idiv(step * (100 - CHILL_PCT), 100); // 한기
  // 이속 버프 (태엽 감기 + 숲의 가호)
  {
    let pct = 0;
    const sb = selfbuffOf(d);
    if (sb?.speedPct && isBuffed(g, e, d)) pct += sb.speedPct;
    const fb = forestBuffOf(g, e);
    if (fb?.speedPct) pct += fb.speedPct;
    if (e.auraKind === 4) pct += 10; // 디멘터 「종말의 오라」
    pct += bonusPct;
    if (pct) step = idiv(step * (100 + pct), 100);
  }
  if (step > len) step = len;
  const nx = clamp(e.x + idiv(dx * step, len), 0, g.map.length);
  const ny = e.y + idiv(dy * step, len);
  // 격자 마스크가 있는 지형: 벽을 뚫지 않고 미끄러진다.
  // 대각선이 막히면 한 축씩 시도해 벽을 따라 돌아간다 (간단한 슬라이딩 —
  // 경로탐색 없이도 나무·물·울타리에 끼지 않고 길을 따라간다).
  if (blockedByTerrain(g, d)) {
    if (isWalkable(g.map, nx, ny)) {
      e.x = nx;
      e.y = ny;
      return;
    }
    if (isWalkable(g.map, nx, e.y)) { // x 만 이동
      e.x = nx;
      return;
    }
    if (isWalkable(g.map, e.x, ny)) { // y 만 이동
      e.y = ny;
      return;
    }
    // 둘 다 막혔다: 벽을 따라 옆으로 비켜 본다.
    // 좁은 길 입구를 놓치지 않게 여러 폭으로 훑는다 (가까운 쪽부터).
    for (let k = 1; k <= 4; k++) {
      const side = step * k;
      for (const cand of [e.y - side, e.y + side]) {
        if (isWalkable(g.map, e.x, cand) && isWalkable(g.map, nx, cand)) {
          e.y = cand;
          e.x = nx;
          return;
        }
      }
    }
    // 전진이 도저히 안 되면 옆으로만이라도 (벽을 따라 흐른다)
    for (let k = 1; k <= 4; k++) {
      const side = step * k;
      for (const cand of [e.y - side, e.y + side]) {
        if (isWalkable(g.map, e.x, cand)) {
          e.y = cand;
          return;
        }
      }
    }
    return; // 완전히 갇혔으면 제자리
  }
  e.x = nx;
  // 격자 마스크 맵에서 여기까지 온 것은 「비행」뿐이다 (지상은 위에서 처리하고 return).
  // 그런 유닛에 clampLaneY 를 걸면 숲·강 위를 날다 말고 가장 가까운 길로
  // 순간이동해 버린다 — 마스크 맵에선 y 를 건드리지 않는다.
  e.y = g.map.mask ? ny : clampLaneY(g.map, e.x, ny);
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
  // 격자 마스크 지형: 밀려나다 벽 안으로 들어간 유닛을 길 위로 되돌린다.
  // (겹침 해소는 지형을 모르기 때문에 나무 속으로 밀어 넣곤 한다)
  if (g.map.mask) {
    for (const e of g.entities) {
      const d = def(e);
      if (!e.alive || d.speed <= 0 || d.flying) continue; // 비행은 지형 위에 그대로 둔다
      if (isWalkable(g.map, e.x, e.y)) continue;
      nudgeOntoPath(g, e);
    }
  }
  detectStuck(g);
}

/** 이 시간(틱) 넘게 제자리면 끼인 것으로 본다. */
const STUCK_TICKS = 60;      // 3초
/** 끼임 판정 후 서로를 통과하는 시간. */
const PHASE_TICKS = 30;      // 1.5초
/** 「움직였다」고 볼 최소 이동량. */
const MOVE_EPS = 20;         // FP (0.02타일)

/**
 * 좁은 목에서 부대가 굳는 것을 푼다.
 *
 * 지형에 막히지 않아도, 앞뒤 유닛이 서로 밀며 버티면 아무도 못 지나가는
 * 교착이 생긴다 (다리·성문 같은 한 칸짜리 길목). 3초 넘게 제자리인 유닛은
 * 1.5초 동안 몸싸움을 끄고 서로를 통과시킨다 — RTS 에서 흔히 쓰는 처리다.
 * 제자리에 서 있는 것이 「정상」인 유닛(속박·기절·주둔·수호자)은 세지 않는다.
 */
function detectStuck(g: Game): void {
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    if (d.speed <= 0) continue;
    const moved = Math.abs(e.x - e.lastX) + Math.abs(e.y - e.lastY) > MOVE_EPS;
    e.lastX = e.x;
    e.lastY = e.y;
    // 일부러 멈춰 있는 경우는 끼임이 아니다
    const parked = g.tick < e.rootedUntil || isIncapacitated(g, e)
      || (e.garrisonR > 0 && dist2(e.x, e.y, e.anchorX, e.anchorY) <= tiles(1) * tiles(1))
      || (d.leashed && dist2(e.x, e.y, e.anchorX, e.anchorY) <= tiles(1) * tiles(1));
    if (moved || parked) { e.stuckTicks = 0; continue; }
    e.stuckTicks++;
    if (e.stuckTicks >= STUCK_TICKS) {
      e.stuckTicks = 0;
      e.phaseUntil = g.tick + PHASE_TICKS;
    }
  }
}

/**
 * 「거대 보스」의 상시 패시브 두 가지.
 *
 * pullAir  — 사거리 밖 하늘에서 안전하게 쏘는 조합을 자기 품으로 끌어내린다.
 *            매 틱 조금씩 당기므로 도망은 갈 수 있지만 거리를 벌리기 어렵다.
 * demolition — 몸에 붙어 패는 적을 초당 갈아낸다 (방어력 무시). 1초에 한 번
 *            정수로 넣어 결정론을 지킨다.
 */
function bossFieldPass(g: Game): void {
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    if (!d.pullAir && !d.demolition) continue;
    if (isIncapacitated(g, e)) continue; // 기절·수면 중엔 장이 꺼진다
    const foe = enemyOf(e.team as TeamId);
    for (const t of g.entities) {
      if (!t.alive || t.id === e.id) continue;
      if (t.team !== foe && t.team !== 2) continue;
      const td = def(t);
      if (td.tier === 'structure') continue;
      const dx = e.x - t.x;
      const dy = e.y - t.y;
      const d2 = dx * dx + dy * dy;
      // 끌어당기기: 공중만
      if (d.pullAir && isFlying(g, t) && td.speed > 0) {
        const r = d.pullAir.radius;
        if (d2 <= r * r && d2 > 0) {
          const len = isqrt(d2);
          const step = d.pullAir.speed;
          if (len > step) {
            t.x = clamp(t.x + idiv(dx * step, len), 0, g.map.length);
            t.y += idiv(dy * step, len);
          }
        }
      }
      // 데몰리션: 몸에 닿아 있는 적을 초당 갈아낸다
      if (d.demolition && g.tick % TICK_HZ === 0) {
        const r = d.demolition.radius + td.radius;
        if (d2 <= r * r) {
          if (g.tick < t.invulnUntil || isShielded(g, t)) continue;
          if (g.tick < t.stealthUntil || g.tick < t.buriedUntil) continue;
          t.hp -= soakShield(t, d.demolition.dps);
          noteSleepHit(g, t);
        }
      }
    }
  }
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
      /*
       * 값싼 좌표 선검사 — 겹칠 수 없는 쌍은 뺄셈 두 번으로 걷어낸다.
       *
       * 아래 검사들(def 조회·isFlying·ghost)은 쌍마다 함수 호출이 붙는데,
       * 후반 전선에 300기가 몰리면 4만 쌍을 그렇게 훑느라 이 함수 하나가
       * 심 비용의 절반을 넘게 먹었다. 어떤 유닛도 반경이 SEP_MAX 의 절반을
       * 넘지 않으므로, 이 거리 밖이면 결과에 영향 없이 건너뛸 수 있다.
       */
      const pdx = b.x - a.x;
      if (pdx > SEP_MAX || pdx < -SEP_MAX) continue;
      const pdy = b.y - a.y;
      if (pdy > SEP_MAX || pdy < -SEP_MAX) continue;
      const db = def(b);
      // 유령 통행(보급 마차): 누구와도 몸싸움하지 않는다
      if (da.ghost || db.ghost) continue;
      // 「바람의 춤」 중인 유닛도 누구와도 부딪히지 않는다 — 물러설 길이 막히면
      // 거리를 되찾는다는 스킬 자체가 성립하지 않는다
      if (da.kiteDance || db.kiteDance) continue;
      // 끼임 탈출 중: 잠시 서로를 통과한다 (좁은 다리에서 부대가 굳는 것 방지)
      if (g.tick < a.phaseUntil || g.tick < b.phaseUntil) continue;
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
      // immovable: 덩치로 버티는 보스는 밀리지 않는다 (남은 민다)
      const aMobile = da.speed > 0 && !da.immovable;
      const bMobile = db.speed > 0 && !db.immovable;
      const m = g.map;
      /**
       * 겹침을 풀며 유닛을 밀어낸다.
       *
       * 격자 마스크 맵의 지상 유닛은 **벽 안으로는 절대 밀리지 않는다**.
       * 예전엔 일단 밀고 나서 clampLaneY 로 길에 붙였는데, 부대가 거점에
       * 몰리면 뒷줄이 통째로 숲으로 밀려나 「나무 위에 서 있는」 그림이 됐다.
       * 대각선이 막히면 한 축씩, 그것도 막히면 제자리 (다음 패스에서 다시 푼다).
       */
      // dx, dy 는 이미 나눗셈까지 끝낸 값을 받는다 — idiv 가 floor 라
      // -idiv(v) 와 idiv(-v) 가 1 만큼 다르고, 그 차이가 시드 결과를 흔든다.
      const shove = (e: Entity, dd: EntityDef, dx2: number, dy2: number): void => {
        const nx2 = clamp(e.x + dx2, 0, m.length);
        const ny2 = e.y + dy2;
        if (!m.mask) { e.x = nx2; e.y = clampLaneY(m, nx2, ny2); return; }
        if (dd.flying) { e.x = nx2; e.y = ny2; return; } // 비행은 지형 무시
        if (isWalkable(m, nx2, ny2)) { e.x = nx2; e.y = ny2; return; }
        if (isWalkable(m, nx2, e.y)) { e.x = nx2; return; }
        if (isWalkable(m, e.x, ny2)) { e.y = ny2; return; }
      };
      if (aMobile && bMobile) {
        shove(a, da, -idiv(nx * push, 1000), -idiv(ny * push, 1000));
        shove(b, db, idiv(nx * push, 1000), idiv(ny * push, 1000));
      } else if (aMobile) {
        shove(a, da, -idiv(nx * overlap, 1000), -idiv(ny * overlap, 1000));
      } else if (bMobile) {
        shove(b, db, idiv(nx * overlap, 1000), idiv(ny * overlap, 1000));
      }
    }
  }
}

/**
 * 수호 오라 (영웅 강화 「수호의 맹세」).
 *
 * 반경 안 아군이 받을 피해의 일부를 수호자가 대신 받는다. 넘겨받는 쪽이
 * 무적·은신·쓰러진 상태면 나누지 않는다 (무적으로 피해를 지우는 악용 방지).
 * 수호자 자신이 맞을 때는 당연히 나누지 않는다.
 *
 * 반환값 = 피해자가 실제로 받을 피해.
 */
function shareToGuardian(g: Game, victim: Entity, dmg: number): number {
  for (const gd of g.entities) {
    if (!gd.alive || gd.team !== victim.team || gd.id === victim.id) continue;
    const share = def(gd).guardShare;
    if (!share) continue;
    if (g.tick < gd.invulnUntil || isShielded(g, gd)) continue;
    if (g.tick < gd.stealthUntil || g.tick < gd.buriedUntil || g.tick < gd.vanishUntil) continue;
    const r = share.radius;
    if (dist2(gd.x, gd.y, victim.x, victim.y) > r * r) continue;
    const moved = idiv(dmg * share.pct, 100);
    if (moved < 1) continue;
    gd.hp -= soakShield(gd, moved);
    noteSleepHit(g, gd);
    return dmg - moved;
  }
  return dmg;
}

function applyDamage(g: Game, attacker: Entity, attackerDef: EntityDef, victim: Entity): void {
  // 무적 (인비저블 / 수호자 생존 중인 넥서스): 피해·상태이상 전부 무시.
  if (g.tick < victim.invulnUntil || isShielded(g, victim)) {
    victim.lastAttackerId = attacker.id;
    return;
  }
  /*
   * 주술 결계: 결계 밖에서 날아온 것은 닿지 않는다.
   * 조준에서 이미 걸러지지만, 광역은 조준과 무관하게 번지므로 여기서도 막는다 —
   * 안 그러면 갱 밖에서 광역만 던져 결계를 우회할 수 있다.
   */
  if (wardBlocks(g, attacker, victim)) return;
  const w = attackerDef.weapon!;
  const vd = def(victim);
  // 은신 중에는 어떤 평타도 맞지 않는다 (이미 날아온 투사체 포함)
  if (g.tick < victim.stealthUntil) return;
  if (g.tick < victim.buriedUntil) return; // 「토끼굴」 땅속
  if (g.tick < victim.vanishUntil) return; // 「커튼콜」 무대 밖
  // 회피 (캠페인 강화): 평타만 피한다 — 마법·스킬·장판·독은 회피 불가
  if (vd.dodgePct && nextChance(g.rng, vd.dodgePct)) {
    victim.lastAttackerId = attacker.id;
    return;
  }
  /*
   * 「잎새의 장막」(에버그린): 얻어맞는 순간 잎에 몸을 숨긴다.
   * 피해는 그대로 받되, 그 뒤로 잠깐 조준에서 사라진다 — 근접에 물렸을 때
   * 한 번 끊고 빠져나갈 여지를 준다. 쿨타임이 있어 계속 숨을 수는 없다.
   */
  {
    const veil = vd.veilOnHit;
    if (veil && g.tick >= victim.veilReadyTick) {
      victim.stealthUntil = g.tick + veil.durTicks;
      victim.veilReadyTick = g.tick + veil.cooldown;
    }
  }
  // 공중 전용 피해 (모자장수: 하늘엔 강하고 땅엔 약하다)
  let dmg = (w.airDamage !== undefined && isFlying(g, victim)) ? w.airDamage : w.damage;
  // 암살 은신(「덩굴 잠행」): 덩굴 뒤에서 찌르는 한 방은 더 깊게 들어간다
  dmg += hidden(g, attacker, attackerDef)?.stealthDamageAdd ?? 0;
  // 막타 스택: 처치할 때마다 공격력이 붙는다 (지속이 끝나면 통째로 사라진다)
  const kst = attackerDef.killStack;
  if (kst && attacker.killStacks > 0 && g.tick < attacker.killStackUntil) {
    dmg = idiv(dmg * (100 + attacker.killStacks * kst.pct), 100);
  }
  if (w.bonus) {
    for (const tag of vd.tags) if (isCombatTag(tag)) dmg += w.bonus[tag] ?? 0;
    if (vd.flying) dmg += w.bonus.flying ?? 0;
  }
  // 거물 사냥(에버그린): 영웅·네임드에게 추가 피해.
  // 「소환으로만 나오는 최종 티어」 = 캠페인 네임드·영웅이다.
  if (attackerDef.bonusVsHero && vd.tier === 'final' && vd.summonOnly) {
    dmg += attackerDef.bonusVsHero;
  }
  // 제물 흡수 (인큐버스): 스택당 공격력 +10%
  if (attacker.sacrificeStacks > 0) dmg = idiv(dmg * (100 + attacker.sacrificeStacks * 10), 100);
  // 약화: 방어력 계산 전에 가하는 피해를 깎는다
  if (g.tick < attacker.weakenedUntil) dmg = idiv(dmg * (100 - WEAKEN_PCT), 100);
  if (!w.ignoreArmor) dmg -= armorOf(g, victim, vd);
  // 「정각의 일격」: 확률적으로 1.5배. 결정론 rng 를 쓰고, 터진 사실은
  // lastCritTick 에 남겨 렌더가 CRITICAL HIT!! 를 띄운다
  {
    /*
     * 치명타.
     *  - 확률: 타고난 것(에버그린)과 일시 버프 중 높은 쪽. 0 이면 rng 를 건드리지
     *    않는다 — 안 그러면 치명타가 없는 유닛들의 난수열까지 밀린다.
     *  - 「치명상」이 걸린 적은 확률과 무관하게 무조건 치명타로 맞는다.
     *  - 배율: 기본 150%. critMulRange 가 있으면 10% 단위로 무작위.
     */
    const buffCrit = g.tick < attacker.critUntil ? attacker.critPct : 0;
    const critPct = Math.max(attackerDef.baseCritPct ?? 0, buffCrit);
    const forced = g.tick < victim.mortalUntil;
    const rolled = !forced && critPct > 0 && nextChance(g.rng, critPct);
    if (dmg > 0 && (forced || rolled)) {
      const range = attackerDef.critMulRange;
      let mul = 150;
      if (range) {
        // [최소, 최대] 를 10% 단위로 — 균등 확률
        const steps = idiv(range[1] - range[0], 10) + 1;
        mul = range[0] + nextInt(g.rng, steps) * 10;
      }
      dmg = idiv(dmg * mul, 100);
      g.crits.push({ x: victim.x, y: victim.y, tick: g.tick });
    }
  }
  if (dmg < 1) dmg = 1;
  dmg = shareToGuardian(g, victim, dmg);
  const before = victim.hp;
  victim.hp -= soakShield(victim, dmg);
  noteSleepHit(g, victim); // 수면 중이었다면 피격 횟수 누적
  victim.lastAttackerId = attacker.id; // 보복 타겟팅용

  // 침묵(엘루리온 해금 패시브): 맞은 쪽은 한동안 액티브를 못 쓴다
  const sil = attackerDef.silenceOnHit ?? 0;
  if (sil > 0 && !blocksStatus(g, victim)) {
    victim.silencedUntil = Math.max(victim.silencedUntil, g.tick + sil);
  }
  // 막타 스택(오베론): 이 일격으로 쓰러뜨렸다면 스택을 쌓고 지속을 갱신한다
  const ks = attackerDef.killStack;
  if (ks && before > 0 && victim.hp <= 0) {
    if (attacker.killStacks < ks.max) attacker.killStacks++;
    attacker.killStackUntil = g.tick + ks.ticks;
  }

  // 공격 반사 (가시 봉제): 받은 평타 피해의 일부를 공격자에게 되돌린다.
  // applyStrike(마법)·독·장판은 이 함수를 안 거치므로 자연히 반사되지 않는다.
  if (g.tick < victim.reflectUntil && attacker.alive && g.tick >= attacker.invulnUntil) {
    const rp = def(victim).actives?.find((a) => a.kind === 'reflect')?.reflectPct ?? 0;
    if (rp > 0) {
      const back = idiv(dmg * rp, 100);
      if (back > 0) attacker.hp -= back;
    }
  }

  // 몽마: 매혹에 홀린 제물의 생기를 통째로 빨아들인다 (최대 체력의 10%)
  if (attackerDef.id === 'p_dream_mare' && g.tick < victim.seducedUntil && attacker.alive) {
    const drain = idiv(vd.maxHp, 10);
    victim.hp -= drain;
    attacker.hp += drain;
    const mareMax = attackerDef.maxHp;
    if (attacker.hp > mareMax) attacker.hp = mareMax;
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
  // 치유 직후(방지막)에는 아예 안 걸린다.
  if (w.dotDps && w.dotTicks && !poisonWarded(g, victim)) {
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
  if (isMagicImmune(victim)) return;        // 넥서스 — 마법은 통하지 않는다
  if (g.tick < victim.stealthUntil) return; // 은신은 스킬 피해도 받지 않는다
  if (g.tick < victim.buriedUntil) return; // 「토끼굴」 도 마찬가지
  if (g.tick < victim.vanishUntil) return; // 「커튼콜」 무대 밖
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
  victim.hp -= soakShield(victim, dmg);
  noteSleepHit(g, victim);
  victim.lastAttackerId = attacker.id;
}

/** 전투 중 유닛 생성 (수호자·소환수 공용). */
/**
 * 전투 중 유닛 생성.
 *
 * from 을 주면 「갈래별 목표」(goalX/goalY)를 물려받는다 — 소환수가 소환한
 * 놈과 다른 곳으로 걸어가 버리는 걸 막는다 (6 마을은 갈래마다 목표가 다르다).
 */
function spawnBattleEntity(g: Game, defId: string, team: CombatTeam, owner: number, x: number, y: number, ov?: EntityDef, from?: Entity): Entity {
  const d = ov ?? DEFS[defId]!;
  const e: Entity = {
    id: g.nextEntityId++,
    defId,
    team,
    owner,
    ...(ov ? { defOv: ov } : {}),
    x, y,
    garrisonR: 0,
    lastX: x, lastY: y, stuckTicks: 0, phaseUntil: 0,
    anchorX: x, anchorY: y,
    hp: d.maxHp,
    cooldown: 0,
    healCooldown: 0,
    targetId: -1,
    lastAttackerId: -1,
    slowedUntil: 0,
    homeX: -1,
    goalX: -1,
    goalY: -1,
    homeY: -1,
    dotUntil: 0,
    dotDps: 0,
    poisonWardUntil: 0,
    rootedUntil: 0,
    stunnedUntil: 0,
    skillCds: d.actives?.map(() => 0) ?? [],
    // 차지 스킬은 가득 채운 채로 시작한다 (일반 스킬은 0 — 쓰이지 않는 칸)
    skillCharges: d.actives?.map((a) => a.charges ?? 0) ?? [],
    skillRegen: d.actives?.map(() => 0) ?? [],
    cadenceIdx: 0,
    resetStacks: 0,
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
    seducedUntil: 0,
    stealthUntil: 0,
    transformUntil: 0,
    purgeImmuneUntil: 0,
    sacrificeStacks: 0,
    sacrificeNextTick: 0,
    mareId: -1,
    groundedUntil: 0,
    frozenUntil: 0,
    sleepUntil: 0,
    sleepHits: 0,
    armorBuffUntil: 0,
    armorBuffAdd: 0,
    auraKind: 0,
    shieldHp: 0,
    shieldEverGranted: false,
    graveReadyTick: 0,
    puppetized: false,
    vanishUntil: 0,
    shieldUntil: 0,
    shieldImmuneUntil: 0,
    critImmuneUntil: 0,
    armorBuffImmuneUntil: 0,
    regenPerSec: 0,
    regenUntil: 0,
    wardUntil: 0,
    wardX: 0,
    wardY: 0,
    wardR: 0,
    lastStandUntil: 0,
    lastStandPct: 0,
    lastStandHealPct: 0,
    regenImmuneUntil: 0,
    silencedUntil: 0,
    burnUntil: 0,
    burnDps: 0,
    chokedUntil: 0,
    moonveilUntil: 0,
    killStacks: 0,
    killStackUntil: 0,
    airTauntUntil: 0,
    airTauntBy: -1,
    returnTick: 0,
    returnX: 0,
    returnY: 0,
    critPct: 0,
    holyRotUntil: 0,
    mortalUntil: 0,
    veilReadyTick: 0,
    wardGiven: false,
    warded: false,
    critUntil: 0,
    buriedUntil: 0,
    timeLocked: false,
    levitateUntil: 0,
    hatKind: 0,
    hatUntil: 0,
    hatSummonTick: 0,
    healWindowStart: -100,
    healsInWindow: 0,
    alive: true,
  };
  if (from && from.goalX >= 0) {
    e.goalX = from.goalX;
    e.goalY = from.goalY;
  }
  g.entities.push(e);
  return e;
}

function spawnGuardian(g: Game, team: TeamId, x: number, y: number): void {
  // 캠페인 테마 보스: 적 팀 수호자를 스테이지가 지정한 것으로 교체할 수 있다
  const defId = team === 1 && g.enemyGuardian ? g.enemyGuardian : GUARDIAN_OF[team];
  spawnBattleEntity(g, defId, team, -1, x, y);
  g.events.push({ tick: g.tick, kind: 'guardianSpawn', team, defId });
}

// ── 디멘터 「오라」 ────────────────────────────────────────────────────────
// 적 편성을 읽어 네 유형 중 하나를 고르는 지속 버프. 시전이 아니라 상태라서
// 매 틱 다시 계산하고, 디멘터가 죽으면 그 즉시 사라진다.
//
// 유형 판정: 15타일 안의 적을 분류별로 세어 "가장 많은" 분류가 발동한다.
// 동률이면 우선순위(4 > 3 > 1·2)로 가른다.
/** 티어 서열 (「멈춘 시계」가 '가장 강한 아군'을 고를 때 쓴다). */
const TIER_ORDER: readonly string[] = ['basic', 'novice', 'mid', 'air', 'high', 'supreme', 'final', 'guardian'];
/** 「뼈 무덤」이 부화하기까지 (20초) — 이 사이 부서지면 부활은 없다. */
const BONE_GRAVE_TICKS = 20 * 20;
/** 되살아난 본드래곤이 다시 무덤이 되기까지의 대기 (60초). */
const BONE_GRAVE_COOLDOWN = 60 * 20;
const DEMENTOR_ID = 'p_dementor';
/** 적 탐지 범위. */
const AURA_SCAN = tiles(15);
/** 아군 버프가 닿는 범위. */
const AURA_REACH = tiles(7);
/** 유형별 우선순위 — 작을수록 우선. [_, 유형1, 유형2, 유형3, 유형4] */
const AURA_PRIO: readonly [number, number, number, number, number] = [9, 3, 3, 2, 1];
/** 유형3 보호막 크기. */
const AURA_SHIELD = 100;

/** 1티어(basic·novice) / 2티어 이하(+mid) 판정. */
function tierRank1(d: EntityDef): boolean {
  return d.tier === 'basic' || d.tier === 'novice';
}
function tierRank2(d: EntityDef): boolean {
  return tierRank1(d) || d.tier === 'mid';
}
/** 고급 이상 (high·supreme·final). */
function tierHigh(d: EntityDef): boolean {
  return d.tier === 'high' || d.tier === 'supreme' || d.tier === 'final';
}

/**
 * 디멘터의 오라 유형을 고른다. 0 = 조건에 맞는 적이 없어 발동하지 않음.
 * 결정론: entities 배열 순서대로 세고, 동률은 우선순위 → 낮은 유형 번호 순.
 */
function pickAura(g: Game, e: Entity): number {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const t of g.entities) {
    if (!t.alive || t.team === e.team || isShielded(g, t)) continue;
    const td = def(t);
    if (td.tier === 'structure') continue;
    if (dist2(e.x, e.y, t.x, t.y) > AURA_SCAN * AURA_SCAN) continue;
    const flying = isFlying(g, t);
    const range = td.weapon ? td.weapon.range : 0;
    // 유형1: 1티어 + 사거리 2타일 이상
    if (!flying && tierRank1(td) && range >= tiles(2)) counts[1]++;
    // 유형2: 2티어 이하 + 지상 + 판금
    if (!flying && tierRank2(td) && td.tags.includes('plate')) counts[2]++;
    // 유형3: 비행
    if (flying) counts[3]++;
    // 유형4: 고급 이상
    if (tierHigh(td)) counts[4]++;
  }
  let best = 0;
  let bestCount = 0;
  let bestPrio = 99;
  for (let k = 1; k <= 4; k++) {
    const c = counts[k] ?? 0;
    if (c === 0) continue;
    const prio = AURA_PRIO[k] ?? 99;
    // 많은 쪽이 이기고, 같으면 우선순위가 높은(숫자가 작은) 쪽이 이긴다
    if (c > bestCount || (c === bestCount && prio < bestPrio)) {
      best = k;
      bestCount = c;
      bestPrio = prio;
    }
  }
  return best;
}

/**
 * 매 틱 오라를 새로 칠한다. 팀당 디멘터 한 마리분만 발동하며,
 * 그 자리는 배열 앞쪽(= 먼저 나온) 개체가 갖는다 — 죽으면 다음 개체가 이어받는다.
 */
function applyAuras(g: Game): void {
  for (const e of g.entities) e.auraKind = 0;
  // 팀별 오라 주인 (0·1·2 팀 각각 최대 한 마리)
  const owner: (Entity | undefined)[] = [undefined, undefined, undefined];
  for (const e of g.entities) {
    if (!e.alive || e.defId !== DEMENTOR_ID) continue;
    if (owner[e.team] === undefined) owner[e.team] = e;
  }
  for (const src of owner) {
    if (!src) continue;
    const kind = pickAura(g, src);
    if (kind === 0) continue;
    src.auraKind = kind; // 시전자 본인도 오라 표시 대상 (렌더·정보창용)
    for (const ally of g.entities) {
      if (!ally.alive || ally.team !== src.team) continue;
      if (def(ally).tier === 'structure') continue;
      if (dist2(src.x, src.y, ally.x, ally.y) > AURA_REACH * AURA_REACH) continue;
      ally.auraKind = kind;
      // 유형3: 보호막은 "받아본 적 없는" 유닛에게 딱 한 번만 채워진다
      if (kind === 3 && !ally.shieldEverGranted && g.tick >= ally.shieldImmuneUntil) {
        ally.shieldEverGranted = true;
        ally.shieldHp = AURA_SHIELD;
      }
    }
  }
}

export function stepCombat(g: Game): void {
  const byId = new Map<number, Entity>();
  for (const e of g.entities) if (e.alive) byId.set(e.id, e);

  // 막타 스택 만료: 지속이 끝나면 0 으로 (부분 감쇠 없음)
  for (const e of g.entities) {
    if (e.killStacks > 0 && g.tick >= e.killStackUntil) e.killStacks = 0;
  }
  // 돌진·도약 복귀: 예약 시각이 되면 떠나기 전 자리로 돌아간다
  for (const e of g.entities) {
    if (!e.alive || e.returnTick === 0 || g.tick < e.returnTick) continue;
    e.x = clamp(e.returnX, 0, g.map.length);
    e.y = clampLaneY(g.map, e.x, e.returnY);
    e.returnTick = 0;
  }
  // 보호막 만료: 지속시간이 있는 보호막은 시간이 지나면 남아있어도 사라진다
  for (const e of g.entities) {
    if (e.shieldHp > 0 && e.shieldUntil > 0 && g.tick >= e.shieldUntil) e.shieldHp = 0;
  }
  // 치명타 이벤트는 한 틱만 산다 (렌더가 가져간다)
  if (g.crits.length > 0) g.crits = g.crits.filter((c) => c.tick === g.tick);
  // 디멘터 오라: 상태이므로 매 틱 새로 칠한다 (죽으면 그 즉시 사라진다)
  applyAuras(g);
  // 모자장수 빨강·황금 모자: 3초마다 태엽 병정 3기가 주변에서 튀어나온다
  for (const e of g.entities) {
    if (!e.alive || e.hatUntil <= g.tick) continue;
    if (e.hatKind !== 1 && e.hatKind !== 4) continue;
    if (g.tick < e.hatSummonTick + 60) continue;
    e.hatSummonTick = g.tick;
    for (let k = 0; k < 3; k++) {
      const ox = (k - 1) * 500;
      spawnBattleEntity(g, 'm_clockwork_soldier', e.team, e.owner,
        clamp(e.x + ox, 0, g.map.length), clampLaneY(g.map, e.x + ox, e.y + 400), undefined, e);
    }
  }
  // 「실의 폭풍」: 예약 시각이 되면 그 자리에서 실이 터진다
  if (g.threadBooms.length > 0) {
    const due = g.threadBooms.filter((b) => b.tick === g.tick);
    g.threadBooms = g.threadBooms.filter((b) => b.tick > g.tick);
    for (const b of due) {
      for (const v of g.entities) {
        if (!v.alive || v.team === b.team || isFlying(g, v)) continue;
        if (g.tick < v.invulnUntil || isShielded(g, v) || g.tick < v.stealthUntil) continue;
        if (dist2(b.x, b.y, v.x, v.y) > b.r * b.r) continue;
        let dmg = b.dmg - armorOf(g, v, def(v));
        if (dmg < 1) dmg = 1;
        v.hp -= soakShield(v, dmg);
        noteSleepHit(g, v);
      }
    }
  }

  // 0) 상태이상·장판 (피해/회복은 1초에 1번 — tick % 20 === 0 에 적용)
  // 서큐버스 악마 변신 종료: 원래 모습으로 (체력은 원 최대치로 잘라낸다)
  for (const e of g.entities) {
    // transformUntil 0 은 「변신한 적 없음」이다. g.tick 0 과 맞아떨어져
    // 게임 첫 틱에 모든 유닛의 defOv(업그레이드 반영본)를 날려버렸다.
    if (!e.alive || e.transformUntil === 0 || e.transformUntil !== g.tick) continue;
    const base = DEFS[e.defId]!;
    delete e.defOv;
    if (e.hp > base.maxHp) e.hp = base.maxHp;
  }
  // 인큐버스 「완전 해제」: 상태이상이 걸리는 즉시 자동 발동 (행동불능 중에도)
  for (const e of g.entities) {
    if (!e.alive) continue;
    const acts0 = def(e).actives;
    if (!acts0) continue;
    for (let i = 0; i < acts0.length; i++) {
      const a = acts0[i]!;
      if (a.kind !== 'purge' || !skillReady(e, i, a)) continue;
      if (a.requiresUpgrade && (e.owner < 0 || !g.players[e.owner]?.upgrades[a.requiresUpgrade])) continue;
      if (!hasDebuff(g, e)) continue;
      clearDebuffs(g, e);
      e.purgeImmuneUntil = g.tick + (a.durTicks ?? 400); // 기본 20초 면역
      spendSkill(e, i, a);
    }
  }
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
  // 디멘터 「종말의 오라」: 초당 체력 1 회복 (최대치 초과 없음)
  if (dmgTick) {
    for (const e of g.entities) {
      if (!e.alive || e.auraKind !== 4) continue;
      const md = def(e).maxHp;
      if (e.hp < md) e.hp = Math.min(md, e.hp + 1);
    }
  }
  if (dmgTick) {
    for (const e of g.entities) {
      if (!e.alive) continue;
      // 독/화상은 방어 무시 (무적 중엔 면역)
      if (g.tick < e.dotUntil && e.dotDps > 0 && g.tick >= e.invulnUntil) e.hp -= e.dotDps;
      // 화상(메테오)은 독과 별개로 쌓인다 — 둘 다 걸리면 둘 다 닳는다
      if (g.tick < e.burnUntil && e.burnDps > 0 && g.tick >= e.invulnUntil) e.hp -= e.burnDps;
      // 재생: 숲의 가호 + 유닛 자체 재생(캠페인 강화)을 합산.
      // (둥지 자체 재생은 뺐다 — 방어 28 상대 잡몹 실피해가 1이라 사실상 무적이 된다.
      //  둥지 회복은 드루이드 치유로만.)
      const fb = forestBuffOf(g, e);
      const auraRegen = g.tick < e.regenUntil ? e.regenPerSec : 0; // 드라이어드 「생명의 숨결」
      const regen = (fb?.regenPerSec ?? 0) + (def(e).regenPerSec ?? 0) + auraRegen;
      if (regen > 0) {
        /*
         * 「신성부식」(은빛 화살비): 언데드가 이 상태면 회복이 그대로 피해가 된다.
         * 되살아나 버티는 망자 부대를 「회복할수록 무너지게」 뒤집는 상태이상이다.
         */
        if (g.tick < e.holyRotUntil && def(e).tags.includes('undead')) {
          e.hp -= regen;
        } else {
          const max = def(e).maxHp;
          if (e.hp < max) {
            e.hp += regen;
            if (e.hp > max) e.hp = max;
          }
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
        if (!e.alive || isMagicImmune(e)) continue; // 넥서스는 장판도 안 받는다
        const d = def(e);
        const r = z.radius + d.radius;
        if (dist2(z.x, z.y, e.x, e.y) > r * r) continue;
        if (e.team !== z.team) {
          // 공격성 장판은 기본 지상 전용. hitsAir 장판(망자의 만찬·사후의 경계)만 공중도 걸린다.
          if (isFlying(g, e) && !zd.hitsAir) continue;
          // 적: 지속피해 + 둔화 (장판 안에 있는 동안 갱신, 나가면 0.3초 뒤 풀림)
          const zdps = z.dpsOverride > 0 ? z.dpsOverride : (zd.dps ?? 0);
          if (zdps && dmgTick && g.tick >= e.invulnUntil && g.tick >= e.stealthUntil) e.hp -= zdps;
          /*
           * 은빛 화살비에 한 번이라도 닿은 적은 두 낙인을 얻는다 (각 10초).
           *  - 신성부식: 언데드가 회복하면 그 수치만큼 오히려 깎인다
           *  - 치명상: 이 적에게 가하는 모든 공격이 치명타로 들어간다
           * 수호자·면역 대상은 걸리지 않는다.
           */
          if (z.kind === 'silverrain' && !blocksStatus(g, e)) {
            const until = g.tick + TICK_HZ * 10;
            if (until > e.holyRotUntil) e.holyRotUntil = until;
            if (until > e.mortalUntil) e.mortalUntil = until;
          }
          if (zd.slow && d.speed > 0 && !isStatusImmune(e)) {
            const until = g.tick + 6;
            if (until > e.slowedUntil) e.slowedUntil = until;
          }
          /*
           * 역병 늪: 장판을 밟는 순간 「독」이 옮겨 붙는다.
           *
           * 다른 장판은 안에 있는 동안만 효과가 있어 물러서면 그만이지만,
           * 이건 유닛에 상태이상으로 얹히므로 나와도 계속 닳는다 — 물러서기가
           * 답이 아니라 치유가 답이 되게 하는 장치. 갱신은 더 센 쪽·더 긴 쪽.
           */
          if (zd.poison && !blocksStatus(g, e) && !poisonWarded(g, e)) {
            const until = g.tick + zd.poison.ticks;
            if (until > e.dotUntil) e.dotUntil = until;
            if (zd.poison.dps > e.dotDps) e.dotDps = zd.poison.dps;
          }
          // 「인분의 장막」: 안에 있는 동안 공속과 사거리가 깎인다 (한기로 공속을,
          // moonveilUntil 로 사거리를 — 나가면 0.3초 뒤 풀린다)
          if (z.kind === 'moonveil' && !blocksStatus(g, e)) {
            const until = g.tick + 6;
            if (until > e.moonveilUntil) e.moonveilUntil = until;
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
          wardPoison(g, e); // 체력이 꽉 차 있어도 「치유를 받은」 것으로 친다
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

    // 대공 도발(엘루리온 「창공의 포효」): 하늘을 때릴 수 있는 적만 끌어당긴다.
    // 지상만 때리는 유닛은 애초에 걸리지 않으므로 멍하니 서 있는 일이 없다.
    if (g.tick < e.airTauntUntil) {
      const roarer = byId.get(e.airTauntBy);
      if (roarer && roarer.alive && canHit(g, d, roarer)) {
        e.targetId = roarer.id;
        continue;
      }
      e.airTauntUntil = 0;
    }

    /*
     * 암살 (「덩굴 잠행」): 몸을 감춘 동안은 눈앞의 방패를 지나쳐 뒤를 문다.
     * 은신 중엔 어차피 맞지 않으므로 보복 타겟팅보다 앞에 둔다.
     */
    {
      const hide = hidden(g, e, d);
      if (hide?.assassinate) {
        const prey = findAssassinTarget(g, e, d);
        if (prey >= 0) {
          e.targetId = prey;
          continue;
        }
      }
    }

    const cur = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
    let valid = false;
    // cur.team 체크: 혼란 중 조준했던 "자기 편"이 회복 후에도 타겟으로 남아
    // 유닛이 아군만 영원히 따라다니는 바보 상태를 막는다
    if (cur && cur.alive && cur.team !== e.team && canHit(g, d, cur)
      // 결계 밖으로 나갔으면 물고 있던 것도 놓는다 — 안 그러면 계속 쏘면서
      // 피해는 0 이라 「때리는데 안 죽는」 그림이 된다 (15 금광 고원)
      && !wardBlocks(g, e, cur)) {
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
      // 「하늘 우선」(모자장수): 이미 공중을 겨누고 있으면 지상에서 맞아도 시선을 돌리지
      // 않는다. 코앞의 근접 유닛에게 얻어맞을 때마다 하늘을 놓치면 컨셉이 무너진다.
      const keepAir = d.weapon?.preferAir === true
        && curNow !== undefined && isFlying(g, curNow) && !isFlying(g, atk);
      if (!mutual && !keepAir) {
        const origin = acquireOrigin(e, d);
        const ad = def(atk);
        const reach = d.acquireRange + d.radius + ad.radius;
        if (dist2(origin.x, origin.y, atk.x, atk.y) <= reach * reach) {
          e.targetId = atk.id;
          valid = true;
        }
      }
    }

    // 구조물(넥서스·수호탑)을 때리는 중엔 주위를 평소의 2배 거리까지 살펴,
    // 살아 있는 적이 보이면 건물을 놔두고 그쪽을 먼저 상대한다.
    // 구조물은 반격해도 「나를 때린 놈」 보복 대상이 못 되는 경우가 있어,
    // 서로 다른 세력이 같은 넥서스를 노리면 코앞에 마주 서고도 안 싸웠다.
    // (11스테이지처럼 판데 군세와 야생 무리가 한 둥지로 수렴하는 판에서 특히 어색했다)
    if (valid) {
      const curT = byId.get(e.targetId);
      if (curT && def(curT).tier === 'structure') {
        const live = findTarget(g, e, d, true, STRUCT_SCAN_PCT);
        const lt = live >= 0 ? byId.get(live) : undefined;
        // 단, 건물 주인과 "다른 세력"이 곁에 있을 때만 전환한다.
        // 건물을 지키는 같은 편 수비대는 원래대로 무시하고 건물을 계속 때린다 —
        // 안 그러면 수비 병력을 다 치울 때까지 공성이 시작되지 않아 판이 늘어진다.
        if (lt && lt.team !== curT.team) e.targetId = live;
      }
    }

    // 「땅 우선」(오베론): 하늘을 물고 있는데 지상이 사거리에 들어오면 그쪽으로 옮긴다
    if (valid && d.weapon?.preferGround) {
      const curT = byId.get(e.targetId);
      if (curT && isFlying(g, curT)) {
        const grd = findTarget(g, e, d);
        if (grd >= 0) {
          const gt = byId.get(grd);
          if (gt && !isFlying(g, gt)) e.targetId = grd;
        }
      }
    }

    // 「하늘 우선」: 지상을 물고 있는데 사거리 안에 뜬 것이 나타나면 그쪽으로 옮긴다
    if (valid && d.weapon?.preferAir) {
      const curT = byId.get(e.targetId);
      if (curT && !isFlying(g, curT)) {
        const air = findTarget(g, e, d);
        if (air >= 0) {
          const at = byId.get(air);
          if (at && isFlying(g, at)) e.targetId = air;
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

    if (!valid) {
      e.targetId = findTarget(g, e, d);
      // 집결 중이어도 표식 둘레에 든 적은 제 발로 나가서 문다 (집결 = 영역 방어)
      if (e.targetId < 0 && rallyBound(g, e, d)) e.targetId = rallyGuardTarget(g, e, d);
    }
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

    /*
     * 고립 도주 (에버그린): 곁에 아군이 하나도 없으면 싸움을 접고 기지로 물러난다.
     * 물러나는 동안은 발이 빨라진다 — 혼자 남으면 죽지 않고 살아 돌아간다.
     */
    if (d.loneFlee) {
      const rr = d.loneFlee.radius;
      let friend = false;
      for (const v of g.entities) {
        if (!v.alive || v.id === e.id || v.team !== e.team) continue;
        if (def(v).tier === 'structure') continue; // 건물은 동행으로 안 친다
        if (dist2(e.x, e.y, v.x, v.y) <= rr * rr) { friend = true; break; }
      }
      if (!friend) {
        const nx = g.map.nexusX[e.team === 2 ? 1 : e.team];
        moveToward(g, e, d, nx, laneCenterY(g.map, nx), slowed, d.loneFlee.speedPct);
        continue;
      }
    }

    /*
     * 바람의 춤 (에버그린): 최대 사거리보다 가까이 붙은 적이 있으면 물러나며 쏜다.
     *
     * 사거리 11~14타일짜리 저격수가 근접에 붙잡히면 아무것도 못 한다. 거리를 스스로
     * 되찾게 해 「멀리서 계속 쏜다」는 정체성을 지킨다. 물러나는 동안은 발이 빨라지고
     * 몸싸움을 하지 않는다 (separatePass 가 ghost 처럼 통과시킨다).
     */
    if (d.kiteDance && d.weapon) {
      const reach = maxRangeOf(g, e, d);
      let nearest = -1;
      for (const v of g.entities) {
        if (!v.alive || v.team === e.team) continue;
        if (def(v).tier === 'structure') continue;
        const d2v = dist2(e.x, e.y, v.x, v.y);
        if (nearest < 0 || d2v < nearest) nearest = d2v;
      }
      // 사거리의 80% 안까지 들어왔으면 물러난다 (경계에서 앞뒤로 떠는 것 방지)
      const keep = idiv(reach * 8, 10);
      if (nearest >= 0 && nearest < keep * keep) {
        const nx = g.map.nexusX[e.team === 2 ? 1 : e.team];
        moveToward(g, e, d, nx, laneCenterY(g.map, nx), slowed, d.kiteDance.speedPct);
        continue;
      }
    }

    // 매혹(서큐버스): 싸움을 잊고 적진 한가운데로 홀린 듯 걸어간다
    if (g.tick < e.seducedUntil) {
      const foeTeam = e.team === 2 ? 1 : enemyOf(e.team as TeamId);
      const nx = g.map.nexusX[foeTeam];
      moveToward(g, e, d, nx, laneCenterY(g.map, nx), slowed);
      continue;
    }

    // 혼란: 조준한 "자기 편"에게 달려든다. 대상이 없으면 멍하니 제자리.
    if (g.tick < e.confusedUntil) {
      const ct = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
      if (ct && ct.alive && d.weapon) {
        const reach = rangeOf(g, e, d) + d.radius + def(ct).radius;
        if (dist2(e.x, e.y, ct.x, ct.y) > reach * reach) {
          moveToward(g, e, d, ct.x, ct.y, slowed);
        }
      }
      continue;
    }

    // 전투형 힐러(사도)는 아군을 쫓지 않고 진군한다 — 숲을 몰고 전진하는 컨셉
    if (d.heal && !d.advancesWhileHealing) {
      // 힐러: 다친 아군을 따라다닌다. 없으면 진군 대열을 따른다.
      const wounded = findWoundedAllies(g, e, d, tiles(8), 1)[0];
      if (wounded) {
        const dd = dist2(e.x, e.y, wounded.x, wounded.y);
        const r = d.heal.range + d.radius;
        if (dd > r * r) moveToward(g, e, d, wounded.x, wounded.y, slowed);
        continue;
      }
    }

    const target = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
    /*
     * 주둔 부대 — 진군하지 않고 자기 거점을 지킨다.
     * 반경 안으로 들어온 적은 물지만, 밖으로 달아나면 쫓지 않고 제자리로 돌아온다.
     * (일반 추격보다 먼저 판정해야 한다 — 안 그러면 적을 따라 맵 끝까지 간다)
     */
    if (e.garrisonR > 0) {
      const r2 = e.garrisonR * e.garrisonR;
      if (target && target.alive && d.weapon
        && dist2(target.x, target.y, e.anchorX, e.anchorY) <= r2) {
        const reach = rangeOf(g, e, d) + d.radius + def(target).radius;
        if (dist2(e.x, e.y, target.x, target.y) > reach * reach) {
          moveToward(g, e, d, target.x, target.y, slowed);
        }
        continue;
      }
      if (dist2(e.x, e.y, e.anchorX, e.anchorY) > tiles(0.8) * tiles(0.8)) {
        moveToward(g, e, d, e.anchorX, e.anchorY, slowed);
      }
      continue;
    }
    if (target && target.alive && d.weapon) {
      const td = def(target);
      const reach = rangeOf(g, e, d) + d.radius + td.radius;
      if (dist2(e.x, e.y, target.x, target.y) <= reach * reach) continue; // 사거리 안 — 제자리에서 쏜다
      /*
       * 집결 중에는 표식 둘레 밖의 적을 쫓아가지 않는다.
       *
       * 「여기로 모여」는 「여기를 지켜라」다. 그런데 사거리가 긴 유닛(에버그린 11타일)이
       * 지나가다 엉뚱한 곳의 적을 물면 그 자리에 멈춰 서서 부대 전체가 목적지에
       * 영영 못 갔다 (15 금광 고원에서 다른 갱의 일꾼을 물고 굳었다).
       * 표식에서 먼 것은 쳐다보지 말고 가던 길을 간다.
       */
      if (rallyBound(g, e, d)
        && dist2(target.x, target.y, g.rallyX, g.rallyY) > RALLY_GUARD * RALLY_GUARD) {
        e.targetId = -1;
      } else {
      /*
       * 마스크 지형에서는 「보이는 적」이 「갈 수 있는 적」이 아니다.
       * 13 「세계수 뿌리 탈환」의 x17 개울(폭 1타일, 건널 곳은 남쪽 다리 하나)
       * 건너편 적이 사거리 밖에서 보이면, 부대가 물가로 직진해 줄줄이 굳었다.
       * 사이가 막혔으면 추격을 접고 아래 진군(흐름장)에 맡긴다 — 다리를 건너
       * 다시 보이면 그때 문다.
       */
        if (!blockedByTerrain(g, d) || walkLineClear(g.map, e.x, e.y, target.x, target.y)) {
          moveToward(g, e, d, target.x, target.y, slowed);
          continue;
        }
      }
    }

    if (d.leashed) {
      // 수호자: 목표 없으면 앵커로 복귀.
      if (dist2(e.x, e.y, e.anchorX, e.anchorY) > tiles(0.5) * tiles(0.5)) {
        moveToward(g, e, d, e.anchorX, e.anchorY, slowed);
      }
      continue;
    }

    // 혼자 진군하지 않는 유닛(하얀토끼): 가장 앞선 아군 뒤를 따라다닌다.
    // 아군이 하나도 없으면 그 자리에 멈춰 선다 (「토끼굴」 발동 조건).
    if (d.followAlly) {
      const m0 = g.map;
      let lead: Entity | undefined;
      for (const ally of g.entities) {
        if (!ally.alive || ally.team !== e.team || ally.id === e.id) continue;
        const ad2 = def(ally);
        if (ad2.tier === 'structure' || ad2.followAlly) continue;
        if (lead === undefined) { lead = ally; continue; }
        // 전선 기준으로 가장 앞선 아군 (팀별 진군 방향)
        const fwd = e.team === 0 ? ally.x > lead.x : ally.x < lead.x;
        if (fwd) lead = ally;
      }
      if (lead) {
        const gap = tiles(2);
        const behind = e.team === 0 ? lead.x - gap : lead.x + gap;
        if (dist2(e.x, e.y, behind, lead.y) > gap * gap) {
          moveToward(g, e, d, clamp(behind, 0, m0.length), clampLaneY(m0, behind, lead.y), slowed);
        }
      }
      continue;
    }
    /*
     * 피난민: 진군이 아니라 도주다. 전선·수비선·흐름장 목적지와 무관하게
     * 서쪽 끝만 보고 걷는다 (마스크 맵이면 흐름장으로 길을 찾아서).
     * 맵 밖으로 내보내는 것과 세는 것은 캠페인 쪽 몫.
     */
    if (d.flees) {
      const fx = g.fleeX > 0 ? g.fleeX : 0;
      const fy = g.fleeX > 0 ? g.fleeY : laneCenterY(g.map, 0);
      if (g.map.mask && !d.flying) {
        const cell = flowStepTo(g.map, fx, fy, e.x, e.y);
        if (cell) moveToward(g, e, d, cell.x, cell.y, slowed);
        else moveToward(g, e, d, fx, fy, slowed);
      } else {
        moveToward(g, e, d, fx, fy, slowed);
      }
      continue;
    }
    /*
     * 마을 수비대 — 자기 자리를 지킨다.
     *
     * 진군하지 않고, 사거리 안 적과 싸우다 밀려나면 주둔지로 되돌아온다.
     * 플레이어의 집합지 지정에도 따라가지 않는다 (내 부대가 아니라 마을의 파수다).
     */
    if (e.homeX >= 0) {
      const back = tiles(2);
      if (dist2(e.x, e.y, e.homeX, e.homeY) > back * back) {
        if (g.map.mask && !d.flying) {
          const cell = flowStepTo(g.map, e.homeX, e.homeY, e.x, e.y);
          if (cell) moveToward(g, e, d, cell.x, cell.y, slowed);
          else moveToward(g, e, d, e.homeX, e.homeY, slowed);
        } else {
          moveToward(g, e, d, e.homeX, e.homeY, slowed);
        }
      }
      continue;
    }
    // 진군: 중앙선을 따라 적 넥서스 방향으로. (--_-- 같은 굽은 코리도어 지원)
    // 단, 적 넥서스가 아직 보호막(수호자 생존) 상태면 수호탑 자리까지만 밀고 간다.
    const m = g.map;
    const foe = enemyOf(e.team);
    let nexusX = g.guardianDown[foe] ? m.nexusX[foe] : m.towerX[foe];
    const dir = e.team === 0 ? 1 : -1;
    /*
     * 「전선」이 걸린 판인가 — 수호탑 보호막·상점 점령·호위전 홀드라인.
     *
     * 전선이 있으면 그 x 를 넘어 진격하면 안 되므로 목표 x 를 잘라 낸다.
     * 반대로 전선이 없으면 자르면 안 된다: 굽이길 맵(5 올빼미 성채)은 길이
     * 진행축을 거슬러 내려갔다 다시 올라오므로, x 를 자르면 부대가 내려가야 할
     * 굽이에서 그대로 멈춰 선다.
     */
    let frontier = !g.guardianDown[foe];
    // 마몬의 상점 (점령제): 우리 팀 소유가 아니면 상점을 지나 진격하지 않는다 —
    // 점령이 먼저다. 부대가 상점 앞에 멈춰 서고, 단독 점유 10초로 깃발을 꽂는다.
    if (g.mercCaptureRequired && g.mercOwner !== e.team) {
      const shopX = idiv(m.length, 2);
      nexusX = dir > 0 ? Math.min(nexusX, shopX) : Math.max(nexusX, shopX);
      frontier = true;
    }
    // 디펜스전 (둥지 방어): 팀 0 부대는 수비선 너머로 진격하지 않는다
    if (g.holdLineX > 0 && e.team === 0) {
      nexusX = Math.min(nexusX, g.holdLineX);
      frontier = true;
    }
    // 호위전: 적(팀1)은 현재 다툼 중인 거점에 멈춰 서서 점거한다
    if (g.enemyHoldLineX > 0 && e.team === 1) {
      nexusX = Math.max(nexusX, g.enemyHoldLineX);
      frontier = true;
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
    /*
     * 목표 y. 보통은 코리도어 한가운데지만, 진영이 폭 구석의 언덕 위에 있는
     * 맵(nexusPos)에서는 그 실제 자리를 쓴다. 레인중앙을 쓰면 목표가 늪
     * 한복판이 되어 비행 유닛이 허공에 멈춰 서고, 지상은 도착 판정을 못 한다.
     * 전선이 걸려 목표 x 가 잘린 경우엔 그 x 의 레인중앙이 맞다.
     */
    const npos = m.nexusPos?.[foe];
    const goalY = (!frontier && npos) ? npos[1] : laneCenterY(m, nexusX);
    const distToNexus = dir > 0 ? nexusX - e.x : e.x - nexusX;
    /*
     * 두 갈래 출정 경로: 선택한 길의 상단 경유지를 지날 때까지 모든 아군이
     * 같은 흐름장을 탄다. deployLaneY 만 스폰 위치에 쓰면 공용 넥서스 흐름장이
     * 가까운 갈래를 다시 골라 부대가 서·동으로 찢어졌다.
     */
    // rallyX 가 켜졌다면 「야영지 지키기」가 최우선이다. 마지막에 고른 숲길 값은
    // 다음 출정을 위해 남아 있어도, 이미 나온 부대는 아래 집결 로직으로 복귀해야 한다.
    if (e.team === 0 && g.rallyX === 0 && m.deployWaypoints && g.deployLaneY !== 0) {
      let wp = m.deployWaypoints[0];
      let best = wp ? (wp.laneY > g.deployLaneY ? wp.laneY - g.deployLaneY : g.deployLaneY - wp.laneY) : 0;
      for (let i = 1; i < m.deployWaypoints.length; i++) {
        const cand = m.deployWaypoints[i]!;
        const delta = cand.laneY > g.deployLaneY ? cand.laneY - g.deployLaneY : g.deployLaneY - cand.laneY;
        if (delta < best) { wp = cand; best = delta; }
      }
      if (wp && e.x < wp.x) {
        if (d.flying) moveToward(g, e, d, wp.x, wp.y, slowed);
        else {
          const cell = flowStepTo(m, wp.x, wp.y, e.x, e.y);
          if (cell) moveToward(g, e, d, cell.x, cell.y, slowed);
          else moveToward(g, e, d, wp.x, wp.y, slowed);
        }
        continue;
      }
    }
    // 격자 마스크 지형: 흐름장이 알려주는 다음 칸으로 간다.
    // 중앙선을 따라가면 굽은 길에서 벽을 향해 걷다 끼어 버린다 (실측: 중앙선
    // 59지점 중 22곳이 마스크상 벽이었다).
    // 호위전 집결: 팀 0 은 「지금 점령할 거점」으로 간다. 넥서스 직행 흐름장은
    // 거점이 길 옆 공터에 있으면 그 앞을 스쳐 지나가 버린다 — 마차는 거점에
    // 서는데 부대만 지나쳐 가는 그림이 됐다. 거점으로 향하는 흐름장을 따로 써서
    // 부대가 마차와 같은 길로 거점을 하나씩 들르게 한다.
    if (g.rallyX > 0 && e.team === 0 && g.map.mask) {
      const rx = g.rallyX;
      const ry = g.rallyY;
      /*
       * 집결 지점 한가운데로 모인다.
       *
       * 원 안 곳곳에 자리를 나눠 세워도 봤는데(rallySlot), 넓은 표식에서는
       * 부대가 가장자리에 흩어져 서서 근접·영웅이 교전에 못 끼었다. 지금은
       * 다시 한 점으로 모으되 「이만큼 가까우면 도착」이라는 여유를 둔다 —
       * 여유가 없으면 전원이 같은 칸을 밀며 자리다툼만 한다.
       */
      const rr = RALLY_HOLD;
      if (dist2(e.x, e.y, rx, ry) <= rr * rr) continue;
      if (d.flying) {
        moveToward(g, e, d, rx, ry, slowed);
        continue;
      }
      const cellR = flowStepTo(g.map, rx, ry, e.x, e.y);
      if (cellR) moveToward(g, e, d, cellR.x, cellR.y, slowed);
      else moveToward(g, e, d, rx, ry, slowed); // 거점 칸에 닿았다 — 지점으로 모인다
      continue;
    }
    /*
     * 적이 노리는 지점이 따로 정해진 판 (마을 방어전): 넥서스가 없으므로
     * 「맵 서쪽 끝」이 아니라 마을 한복판을 향해 온다. 도착하면 그 자리에서
     * 교전하며 눌러앉는다 (더 갈 곳이 없다).
     */
    if ((g.foeGoalX > 0 || e.goalX >= 0) && e.team === 1) {
      // 갈래별 목표가 찍혀 있으면 그쪽 — 6 「자정의 마을」은 1시/11시가
      // 각각 다른 6시 길을 노린다 (한 점으로 모으면 아래 두 채를 영영 안 친다).
      const gx = e.goalX >= 0 ? e.goalX : g.foeGoalX;
      const gy = e.goalX >= 0 ? e.goalY : g.foeGoalY;
      if (d.flying || !g.map.mask) {
        moveToward(g, e, d, gx, gy, slowed);
      } else {
        const cell = flowStepTo(g.map, gx, gy, e.x, e.y);
        if (cell) moveToward(g, e, d, cell.x, cell.y, slowed);
        else moveToward(g, e, d, gx, gy, slowed);
      }
      continue;
    }
    if (g.map.mask && d.flying) {
      // 비행은 지형을 무시하고 길 위를 그대로 가로질러 난다 (강·숲을 넘는다).
      // 목표 x 는 nexusX — 전선이 걸려 있으면 거기서 멈춘다.
      moveToward(g, e, d, nexusX, goalY, slowed);
      continue;
    }
    if (g.map.mask) {
      // 전선(호위전 holdLine / 수호탑 보호막 / 상점 점령)을 넘어서 진군하지 않는다.
      // 흐름장은 목적지만 알 뿐 전선을 모르므로 x 를 여기서 직접 막아 준다 —
      // 이게 없으면 부대가 거점을 그냥 지나쳐 적진으로 달려가 점령이 안 됐다.
      const nextCell = flowStep(g.map, e.team === 0 ? 0 : 1, e.x, e.y);
      if (nextCell) {
        // 전선 너머로는 목표 x 를 잘라 낸다. 넘어가 있으면 목표가 뒤가 되어
        // 다시 전선으로 물러난다 (겹침에 밀려 조금씩 앞으로 새는 것도 이걸로 잡힌다).
        const tx = !frontier ? nextCell.x
          : dir > 0
            ? (nextCell.x < nexusX ? nextCell.x : nexusX)
            : (nextCell.x > nexusX ? nextCell.x : nexusX);
        moveToward(g, e, d, tx, nextCell.y, slowed);
      } else {
        // 목적지 줄에 닿았다 — 이제 넥서스 자리로 곧장 모인다.
        // 예전엔 y 를 e.y 로 뒀는데, 흐름장 목적지가 「줄」이라 도착한 폭 그대로
        // 멈춰 서서 넥서스 옆에 늘어서기만 하고 끝내 치러 오지 않았다.
        moveToward(g, e, d, nexusX, goalY, slowed);
      }
      continue;
    }
    if (distToNexus <= tiles(6)) {
      // 넥서스가 가까우면 직접 향한다
      moveToward(g, e, d, nexusX, aimY(g, nexusX, e.y), slowed);
    } else {
      // 전방 4타일 지점을 향해 (경사·굽이에서 자연스럽게 꺾인다).
      // 격자 마스크 맵에서는 「중앙선」이 아니라 그 지점에서 실제로 밟을 수 있는
      // 가장 가까운 자리를 노린다 — 굽은 길을 벽에 부딪히지 않고 따라간다.
      const lookX = clamp(e.x + dir * tiles(4), 0, m.length);
      moveToward(g, e, d, lookX, aimY(g, lookX, e.y), slowed);
    }
  }

  // 3) 겹침 해소
  separate(g);

  // 3-b) 덩치 보스 패시브 — 공중 끌어당기기 + 몸에 붙은 적 갈아내기
  bossFieldPass(g);

  // 4) 공격 (+ 액티브 시전)
  for (const e of g.entities) {
    if (!e.alive) continue;
    const d = def(e);
    // 무기가 없어도 액티브가 있으면 시전은 해야 한다 (소환사처럼 소환만 하는 유닛)
    if (!d.weapon && !d.actives) continue;
    // 침묵(엘루리온 해금 패시브)·질식(메테오): 액티브를 못 쓴다 (평타는 가능)
    const silenced = g.tick < e.silencedUntil || g.tick < e.chokedUntil;

    if (d.weapon && e.cooldown > 0) {
      // 둔화 중엔 공속 절반: 짝수 틱에만 쿨다운이 준다.
      if (!isSlowed(g, e) || (g.tick & 1) === 0) e.cooldown--;
    }
    for (let i = 0; i < e.skillCds.length; i++) {
      if (e.skillCds[i]! > 0) e.skillCds[i]!--;
    }
    /*
     * 차지 재충전 (엘로윈 「비전 축적」): 스킬마다 따로 도는 타이머가 다 돌면
     * 차지가 한 장 차오른다. 가득 차면 타이머는 멈춘다 (넘치지 않는다).
     */
    if (d.actives) {
      for (let i = 0; i < d.actives.length; i++) {
        const a = d.actives[i]!;
        if (!a.charges) continue;
        if ((e.skillCharges[i] ?? 0) >= a.charges) { e.skillRegen[i] = 0; continue; }
        if (e.skillRegen[i]! > 0) e.skillRegen[i]!--;
        if (e.skillRegen[i]! <= 0) {
          e.skillCharges[i] = (e.skillCharges[i] ?? 0) + 1;
          e.skillRegen[i] = (e.skillCharges[i] ?? 0) >= a.charges ? 0 : a.cooldown;
        }
      }
    }

    /*
     * 「숲의 가호」 나눠주기 (에버그린 강화): 전투에 들어서면 곁의 아군 N명에게
     * 상태이상 면역을 넘겨준다. 판당 딱 한 번 — 다시 태어나야 또 쓸 수 있다.
     * 쿨타임이 아니라 1회성이라 스킬 목록이 아닌 여기서 직접 처리한다.
     */
    if (d.wardGrant && !e.wardGiven && e.targetId >= 0) {
      const tgt = byId.get(e.targetId);
      if (tgt && tgt.alive) {
        e.wardGiven = true;
        let left = d.wardGrant;
        // 가까운 순서가 아니라 배열 순서 — 결정론을 위해 정렬하지 않는다
        for (const v of g.entities) {
          if (left <= 0) break;
          if (!v.alive || v.id === e.id || v.team !== e.team || v.warded) continue;
          const vd2 = def(v);
          if (vd2.tier === 'structure' || vd2.summonOnly) continue;
          if (dist2(e.x, e.y, v.x, v.y) > tiles(8) * tiles(8)) continue;
          v.warded = true;
          left--;
        }
      }
    }

    // 논스윙형 액티브 시전 (공격 쿨과 무관). 기절·수면·혼란 중엔 불가.
    const acts = d.actives;
    if (acts && !isIncapacitated(g, e) && g.tick >= e.confusedUntil && g.tick >= e.fearedUntil
      && g.tick >= e.seducedUntil) {
      for (let i = 0; i < acts.length; i++) {
        if (silenced) break; // 침묵 중엔 어떤 액티브도 나가지 않는다
        const a = acts[i]!;
        if (a.kind === 'strike' || !skillReady(e, i, a)) continue;
        // 해금형 스킬: 소유자가 업그레이드를 사기 전엔 봉인 (사면 즉시 전 유닛 사용 가능)
        if (a.soloOnly && g.campaignMode) continue; // 캠페인에선 봉인된 스킬
        if (a.requiresUpgrade && (e.owner < 0 || !g.players[e.owner]?.upgrades[a.requiresUpgrade])) continue;
        const t = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
        const inCombat = t !== undefined && t.alive;
        switch (a.kind) {
          case 'selfbuff': // 교전 중 자가 강화
            if (inCombat) {
              e.buffUntil = g.tick + (a.durTicks ?? 0);
              spendSkill(e, i, a);
            }
            break;
          case 'reflect': // 「가시 봉제」 교전 중 + 이미 맞고 있을 때 평타 반사막
            if (inCombat && e.hp < d.maxHp) {
              e.reflectUntil = g.tick + (a.durTicks ?? 0);
              spendSkill(e, i, a);
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
              spendSkill(e, i, a);
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
                // 은빛 화살비: 강화 단계로 초당 피해가 달라진다 (즉발 피해의 약 36%)
                // 은빛 화살비는 첫 피해(damage)에서 초당 피해를 역산하고,
                // 나머지 장판은 zoneDps 로 직접 덮어쓴다 (0 = ZONE_DEFS 기본값)
                dpsOverride: z.kind === 'silverrain'
                  ? idiv((a.damage ?? 70) * 36, 100)
                  : (a.zoneDps ?? 0),
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
            spendSkill(e, i, a);
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
              spendSkill(e, i, a);
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
              /*
               * 「대지 파쇄」(엘로윈 강화): 둔화만 걸던 지진이 실제로 땅을 부순다.
               * 둔화는 이동 가능한 적만 걸리지만 피해는 구조물·수호자도 받는다 —
               * 그래서 슬로우 루프와 따로 돈다.
               */
              if (a.damage) {
                for (const v of g.entities) {
                  if (!v.alive || v.team === e.team || isFlying(g, v)) continue;
                  if (dist2(aim.x, aim.y, v.x, v.y) > r * r) continue;
                  applyStrike(g, e, a, v);
                }
              }
              dropFxZone(g, e.team, 'quake', aim.x, aim.y, r);
              spendSkill(e, i, a);
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
            if (hit) spendSkill(e, i, a);
            break;
          }
          case 'freeze': { // 「블리자드」 대상 지역 빙결 (판금·거대·구조물 면역)
            // 강화 단계마다 얼릴 수 있는 재질이 늘어난다 (freezeAlsoTags 는 면역에서 뺀다)
            const hard = FREEZE_IMMUNE_TAGS.filter((t) => !(a.freezeAlsoTags ?? []).includes(t));
            const canFreeze = (v: Entity): boolean =>
              !isStatusImmune(v) && !hard.some((tag) => def(v).tags.includes(tag));
            // 피해까지 주는 강화형이면 얼릴 수 없는 적만 있어도 시전한다
            const aim = a.damage
              ? nearestFoeWithin(g, e, d, a.castRange ?? tiles(8), () => true)
              : nearestFoeWithin(g, e, d, a.castRange ?? tiles(8), canFreeze);
            if (aim) {
              const r = a.splash ?? tiles(2.5);
              const until = g.tick + (a.durTicks ?? 0);
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team) continue;
                if (dist2(aim.x, aim.y, v.x, v.y) > r * r) continue;
                // 눈보라 피해는 지상·공중을 가리지 않는다 (빙결 면역이어도 맞는다)
                if (a.damage) applyStrike(g, e, a, v);
                if (!canFreeze(v) || g.tick < v.invulnUntil) continue;
                if (until > v.frozenUntil) v.frozenUntil = until;
              }
              dropFxZone(g, e.team, 'frost', aim.x, aim.y, r);
              spendSkill(e, i, a);
            }
            break;
          }
          case 'meteor': {
            /*
             * 「메테오 스트라이크」(엘로윈 최종기) — 넓은 하늘에서 운석이 쏟아진다.
             * 피해·화상·질식은 시전 순간 한 번에 들어가고, 이후 7초 동안 남는
             * 운석 장판은 그림만이다 (효과를 틱마다 다시 주면 겹겹이 쌓인다).
             * 지상·공중을 가리지 않으며 완전면역 대상에겐 낙인이 붙지 않는다.
             */
            const mr = a.castRange ?? tiles(12);
            const aim = nearestFoeWithin(g, e, d, mr, () => true);
            if (aim) {
              const r = a.splash ?? tiles(10);
              const burnUntil = a.burn ? g.tick + a.burn.ticks : 0;
              const chokeUntil = a.chokeTicks ? g.tick + a.chokeTicks : 0;
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team) continue;
                if (dist2(aim.x, aim.y, v.x, v.y) > r * r) continue;
                applyStrike(g, e, a, v);
                if (blocksStatus(g, v)) continue;
                if (a.burn && burnUntil > v.burnUntil) {
                  v.burnUntil = burnUntil;
                  v.burnDps = Math.max(v.burnDps, a.burn.dps);
                }
                if (chokeUntil > v.chokedUntil) v.chokedUntil = chokeUntil;
              }
              g.zones.push({
                id: g.nextZoneId++, team: e.team, kind: 'meteor',
                x: aim.x, y: aim.y, radius: r,
                untilTick: g.tick + (a.zone?.ticks ?? TICK_HZ * 7),
                followId: -1, dpsOverride: 0,
              });
              spendSkill(e, i, a);
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
                spawnBattleEntity(g, pick, e.team, e.owner, sx2, sy2, ov, e);
              }
              spendSkill(e, i, a);
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
              spendSkill(e, i, a);
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
              best.puppetized = true; // 실에 매달린 인형 — 새까맣게 그려진다
              best.targetId = -1;
              best.lastAttackerId = -1;
              best.tauntedUntil = 0;
              best.tauntedBy = -1;
              clearDebuffs(g, best);
              // 전향한 유닛을 겨누던 참조를 전부 끊는다 (아군 오사 방지)
              for (const o of g.entities) {
                if (o.targetId === best.id) o.targetId = -1;
                if (o.lastAttackerId === best.id) o.lastAttackerId = -1;
              }
              spendSkill(e, i, a);
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
            if (hit > 0) spendSkill(e, i, a);
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
              spendSkill(e, i, a);
            }
            break;
          case 'invuln': // 전투 중 + 이미 피해를 입었을 때 무적
            if (inCombat && e.hp < d.maxHp) {
              e.invulnUntil = g.tick + (a.durTicks ?? 0);
              // 발이 묶이는 방어 기술 — 무적인 동안 그 자리에 못 박힌다
              if (a.rootsSelf) e.rootedUntil = g.tick + (a.durTicks ?? 0);
              spendSkill(e, i, a);
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
              // 유니콘이 여러 마리여도 돌려가며 영구 유지할 수 없다 — 면역 쿨을 둔다
              if (g.tick < ally.armorBuffImmuneUntil) continue;
              if (until > ally.armorBuffUntil || add > ally.armorBuffAdd) {
                ally.armorBuffUntil = Math.max(ally.armorBuffUntil, until);
                ally.armorBuffAdd = Math.max(ally.armorBuffAdd, add);
                ally.armorBuffImmuneUntil = g.tick + a.cooldown;
              }
            }
            spendSkill(e, i, a);
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
            if (hit > 0) spendSkill(e, i, a);
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
              clearDebuffs(g, victim);
              spendSkill(e, i, a);
            }
            break;
          }
          case 'seduce': { // 「매혹」(서큐버스) 확률로 적 하나를 홀린다
            if (!inCombat) break;
            const range6 = a.castRange ?? tiles(6);
            const aim = nearestFoeWithin(g, e, d, range6, (v) =>
              def(v).speed > 0 && !blocksStatus(g, v) && g.tick >= v.invulnUntil && g.tick >= v.seducedUntil);
            if (aim) {
              // 각성(해금 업그레이드): 확률 45% + 성공 시 15초 악마 변신
              const awakened = e.owner >= 0 && !!g.players[e.owner]?.upgrades['pu_succubus_awaken'];
              const chance = awakened ? 45 : (a.chancePct ?? 30);
              if (nextChance(g.rng, chance)) {
                aim.seducedUntil = g.tick + (a.durTicks ?? 160); // 기본 8초
                if (awakened) {
                  // 악마 변신: 체력 2배 + 100% 회복 + 공격력 대폭 상승 (15초)
                  const base = DEFS[e.defId]!;
                  const w0 = base.weapon!;
                  e.defOv = {
                    ...base,
                    maxHp: base.maxHp * 2,
                    // 악마가 된 동안엔 날아오른다 — 지상 전용 공격은 닿지 않는다
                    flying: true,
                    weapon: { ...w0, damage: w0.damage * 5 },
                  };
                  e.hp = base.maxHp * 2;
                  e.transformUntil = g.tick + 300; // 15초
                }
              }
              spendSkill(e, i, a); // 빗나가도 쿨은 돈다 (확률기)
            }
            break;
          }
          case 'summonMare': { // 「몽마 소환」 — 서큐버스당 한 마리, 재소환하면 이전 몽마는 흩어진다
            if (!inCombat) break;
            const oldMare = e.mareId >= 0 ? byId.get(e.mareId) : undefined;
            if (oldMare && oldMare.alive) {
              oldMare.alive = false; // 조용히 흩어진다 (사망 이벤트·보상 없음)
            }
            const mare = spawnBattleEntity(g, 'p_dream_mare', e.team, e.owner,
              clamp(e.x + 400, 0, g.map.length), clampLaneY(g.map, e.x, e.y + 400), undefined, e);
            e.mareId = mare.id;
            spendSkill(e, i, a);
            break;
          }
          case 'leap': { // 적에게 뛰어든다 — 도약 중 무적. damage 가 있으면 착지 지점에 꽂는다
            const range5 = a.castRange ?? tiles(5);
            const pick = (filter: (v: Entity) => boolean): Entity | undefined =>
              nearestFoeWithin(g, e, d, range5, (v) =>
                g.tick >= v.invulnUntil && def(v).speed > 0 && filter(v));
            /*
             * 조준 방식은 스킬이 정한다.
             *  · backline (관짝 강습) — 지원가 > 원거리 > 아무 적. 부대를 떠받치는
             *    유닛을 먼저 끊는 것이 그 스킬의 존재 이유다.
             *  · nearest (고우토 도약 강습) — 가장 가까운 적. 45원짜리 기본 근접이
             *    적 후열 힐러를 골라 무는 건 값에 비해 과하다. 거리 좁히기로만 둔다.
             */
            const jumpTo = a.leapAim === 'nearest'
              ? pick(() => true)
              : a.leapAim === 'ranged'
                ? pick((v) => (def(v).weapon?.range ?? 0) >= tiles(2))
                  ?? pick(() => true)
                : pick((v) => def(v).tags.includes('support'))
                  ?? pick((v) => (def(v).weapon?.range ?? 0) >= tiles(2))
                  ?? pick(() => true);
            if (jumpTo) {
              const jd = def(jumpTo);
              e.x = clamp(jumpTo.x - (jd.radius + d.radius), 0, g.map.length);
              e.y = clampLaneY(g.map, e.x, jumpTo.y);
              e.invulnUntil = g.tick + 12; // 0.6초 — 도약 중 무적
              e.targetId = jumpTo.id;
              // 착지 피해 — splash 가 있으면 착지 지점 둘레를 통째로 친다
              if (a.damage) {
                if (a.splash) {
                  const r = a.splash;
                  for (const v of g.entities) {
                    if (!v.alive || v.team === e.team || !canHit(g, d, v)) continue;
                    if (dist2(jumpTo.x, jumpTo.y, v.x, v.y) <= r * r) applyStrike(g, e, a, v);
                  }
                } else {
                  applyStrike(g, e, a, jumpTo);
                }
              }
              spendSkill(e, i, a);
            }
            break;
          }
          case 'stealth': // 「은신」(인큐버스) 6초간 조준·피해에서 완전히 사라진다
            if (inCombat) {
              e.stealthUntil = g.tick + (a.durTicks ?? 120); // 기본 6초
              spendSkill(e, i, a);
            }
            break;
          case 'legion': { // 「군세 소환」(인큐버스 해금) 고정 구성 대량 소환
            if (inCombat && a.legion) {
              let k = 0;
              for (const row of a.legion) {
                for (let m = 0; m < row.n; m++) {
                  const ov = e.owner >= 0 ? effectiveDef(row.id, g.players[e.owner]!.upgrades) : undefined;
                  const sx2 = clamp(e.x + ((k % 5) - 2) * 500, 0, g.map.length);
                  const sy2 = clampLaneY(g.map, sx2, e.y + (Math.floor(k / 5) - 2) * 500);
                  spawnBattleEntity(g, row.id, e.team, e.owner, sx2, sy2, ov, e);
                  k++;
                }
              }
              spendSkill(e, i, a);
            }
            break;
          }
          case 'sacrifice': { // 「제물 흡수」(인큐버스 해금) 내 1티어 유닛을 삼켜 강해진다
            // 7초마다: 제물이 있으면 흡수 +1스택, 없으면 -1스택 (스킬 쿨 = 판정 주기).
            // 제물 조건: 같은 소유자(내 유닛만 — 팀원 것은 안 됨) + 1티어(basic/novice)
            // — 스켈레톤 소환사가 소환한 잡유닛(minion, basic)도 제물이 된다.
            const rr = a.auraRadius ?? tiles(3);
            let victim: Entity | undefined;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team || ally.id === e.id) continue;
              if (ally.owner !== e.owner) continue; // 내 유닛만
              const ad = def(ally);
              if (ad.tier !== 'basic' && ad.tier !== 'novice') continue; // 1티어만
              if (ally.invulnUntil >= Number.MAX_SAFE_INTEGER) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > rr * rr) continue;
              victim = ally; // 배열 앞쪽 우선 — 결정론
              break;
            }
            if (victim) {
              victim.alive = false; // 제물은 조용히 사라진다
              if (e.sacrificeStacks < 10) e.sacrificeStacks++;
              const max = def(e).maxHp;
              e.hp += idiv(max, 10);
              if (e.hp > max) e.hp = max;
            } else if (e.sacrificeStacks > 0) {
              e.sacrificeStacks--;
            }
            spendSkill(e, i, a);
            break;
          }
          // ── 마리오네타 확장 로스터 ─────────────────────────────────────
          case 'hasteAlly': { // 「초침 재촉」 주변 아군 공속·이속 (중복 없음 — 갱신만)
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(5);
            const until = g.tick + (a.durTicks ?? 60);
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              if (until > ally.atkBuffUntil) ally.atkBuffUntil = until;
            }
            spendSkill(e, i, a);
            break;
          }
          case 'slowFoe': { // 「지각의 저주」 주변 적 공속·이속 (한기로 근사 — 중복 없음)
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(6);
            const until = g.tick + (a.durTicks ?? 140);
            let hit = 0;
            for (const foe of g.entities) {
              if (!foe.alive || foe.team === e.team || blocksStatus(g, foe)) continue;
              if (dist2(e.x, e.y, foe.x, foe.y) > r * r) continue;
              if (until > foe.chilledUntil) foe.chilledUntil = until;
              hit++;
            }
            if (hit > 0) spendSkill(e, i, a);
            break;
          }
          case 'burrow': { // 「토끼굴」 주변에 아군이 없으면 땅속으로 숨는다
            const r = a.auraRadius ?? tiles(15);
            let friends = 0;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team || ally.id === e.id) continue;
              if (def(ally).tier === 'structure') continue;
              if (dist2(e.x, e.y, ally.x, ally.y) <= r * r) { friends++; break; }
            }
            if (friends === 0) {
              e.buriedUntil = g.tick + (a.durTicks ?? 600);
              e.targetId = -1;
              spendSkill(e, i, a);
            }
            break;
          }
          case 'timelock': { // 「멈춘 시계」 가장 티어 높은 아군 1기에게 영구 면역 (1회한)
            let best: Entity | undefined;
            let bestRank = -1;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team || ally.timeLocked) continue;
              const ad = def(ally);
              if (ad.tier === 'structure') continue;
              const rank = TIER_ORDER.indexOf(ad.tier);
              if (rank > bestRank) { bestRank = rank; best = ally; } // 동률은 배열 앞쪽
            }
            if (best) {
              best.timeLocked = true;
              best.slowedUntil = 0; best.dotUntil = 0; best.rootedUntil = 0;
              best.stunnedUntil = 0; best.confusedUntil = 0; best.weakenedUntil = 0;
              best.chilledUntil = 0; best.frozenUntil = 0; best.fearedUntil = 0;
              best.sleepUntil = 0; best.groundedUntil = 0; best.seducedUntil = 0;
              e.skillCds[i] = Number.MAX_SAFE_INTEGER; // 평생 한 번뿐
            }
            break;
          }
          case 'critAura': { // 「정각의 일격」 주변 아군에게 치명타 확률 부여
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(5);
            const until = g.tick + (a.durTicks ?? 120);
            const pct = a.chancePct ?? 50;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              // 한 번 받았으면 쿨이 돌 때까지 다시 못 받는다 (여러 시전자가 돌려가며
              // 계속 걸어주는 것을 막는다 — 면역 방식)
              if (g.tick < ally.critImmuneUntil) continue;
              // 대상 제한 (오베론: 나비·페어리 계열에게만)
              if (a.onlyTag && !def(ally).tags.includes(a.onlyTag)) continue;
              ally.critUntil = until;
              ally.critPct = pct;
              ally.critImmuneUntil = g.tick + a.cooldown;
            }
            spendSkill(e, i, a);
            break;
          }
          case 'randomBuff': { // 모자장수 — 쓸 때마다 모자가 바뀐다
            if (!inCombat) break;
            // 1~3 은 고르게, 4(황금)는 드물게: 0~9 중 9 만 황금
            const roll = nextInt(g.rng, 10);
            e.hatKind = roll === 9 ? 4 : (roll % 3) + 1;
            e.hatUntil = g.tick + (a.durTicks ?? 200);
            e.hatSummonTick = g.tick;
            spendSkill(e, i, a);
            break;
          }
          case 'summonAtFoe': { // 드로셀마이어 — 적 후열(원거리·지원가) 한가운데에 소환
            const r = a.castRange ?? tiles(9);
            let aim: Entity | undefined;
            let aimD2 = -1;
            for (const foe of g.entities) {
              if (!foe.alive || foe.team === e.team || isShielded(g, foe)) continue;
              const fd = def(foe);
              if (fd.tier === 'structure') continue;
              const isBack = fd.tags.includes('support') || (fd.weapon?.range ?? 0) >= tiles(2);
              if (!isBack) continue;
              const d2 = dist2(e.x, e.y, foe.x, foe.y);
              if (d2 > r * r) continue;
              if (aim === undefined || d2 < aimD2) { aim = foe; aimD2 = d2; }
            }
            if (!aim) break; // 후열이 없으면 소환하지 않는다
            const n = a.summonCount ?? 8;
            for (let k = 0; k < n; k++) {
              const ang = (k * 8) % 16;
              const ox = ((ang % 4) - 2) * 420;
              const oy = (idiv(ang, 4) - 2) * 420;
              spawnBattleEntity(g, a.summonId ?? 'm_nutcracker', e.team, e.owner,
                clamp(aim.x + ox, 0, g.map.length), clampLaneY(g.map, aim.x + ox, aim.y + oy), undefined, e);
            }
            spendSkill(e, i, a);
            break;
          }
          case 'levitate': { // 주변 아군 원거리·지원가를 공중으로 띄운다
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(5);
            const until = g.tick + (a.durTicks ?? 80);
            let lifted = 0;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              const ad = def(ally);
              if (ad.tier === 'structure' || ad.flying) continue;
              const isBack = ad.tags.includes('support') || (ad.weapon?.range ?? 0) >= tiles(2);
              if (!isBack) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              ally.levitateUntil = until;
              lifted++;
            }
            if (lifted > 0) spendSkill(e, i, a);
            break;
          }
          case 'threadStorm': { // 「실의 폭풍」 광역 속박 → 3초 뒤 터지며 피해
            if (!inCombat) break;
            const r = a.splash ?? tiles(4);
            const range = a.castRange ?? tiles(7);
            const aim = nearestFoeWithin(g, e, d, range, (v) => !isFlying(g, v));
            if (!aim) break;
            const until = g.tick + (a.durTicks ?? 60);
            // 실이 깔린 자리를 그림으로 남긴다 (효과는 아래 속박·폭발이 직접 준다)
            g.zones.push({
              id: g.nextZoneId++, team: e.team, kind: 'threadstorm',
              x: aim.x, y: aim.y, radius: r, untilTick: until, dpsOverride: 0, followId: -1,
            });
            for (const foe of g.entities) {
              if (!foe.alive || foe.team === e.team || isFlying(g, foe)) continue;
              if (dist2(aim.x, aim.y, foe.x, foe.y) > r * r) continue;
              if (!blocksStatus(g, foe)) {
                foe.rootedUntil = Math.max(foe.rootedUntil, until);
                foe.stunnedUntil = Math.max(foe.stunnedUntil, until); // 공격도 불가
              }
              // 터질 때의 피해는 예약 없이 즉시 계산해 두고 지연 적용한다
              g.threadBooms.push({ x: foe.x, y: foe.y, tick: until, dmg: a.damage ?? 60, team: e.team, r: tiles(2) });
            }
            spendSkill(e, i, a);
            break;
          }
          // ── 실바린 확장 로스터 ─────────────────────────────────────────
          case 'wardShield': { // 「나무껍질 장막」 적이 다가오면 주변 후열에 보호막
            const trigger = a.castRange ?? tiles(7);
            let foeNear = false;
            for (const foe of g.entities) {
              if (!foe.alive || foe.team === e.team) continue;
              if (def(foe).tier === 'structure') continue;
              if (dist2(e.x, e.y, foe.x, foe.y) <= trigger * trigger) { foeNear = true; break; }
            }
            if (!foeNear) break; // 적이 없으면 아낀다
            const r = a.auraRadius ?? tiles(5);
            const amt = a.damage ?? 100;
            const until = g.tick + (a.durTicks ?? 200);
            let given = 0;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              const ad = def(ally);
              if (ad.tier === 'structure') continue;
              // 보호 대상 = 원거리·지원가 (앞에서 막는 유닛은 스스로 버틴다)
              const isBack = ad.tags.includes('support') || (ad.weapon?.range ?? 0) >= tiles(2);
              if (!isBack) continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              if (g.tick < ally.shieldImmuneUntil) continue; // 면역 중이면 건너뛴다
              ally.shieldHp = amt;
              ally.shieldUntil = until;
              ally.shieldImmuneUntil = g.tick + a.cooldown;
              given++;
            }
            if (given > 0) spendSkill(e, i, a);
            break;
          }
          case 'regenAura': { // 「생명의 숨결」 주변 아군 초당 회복
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(7);
            const until = g.tick + (a.durTicks ?? 400);
            const amt = a.damage ?? 3;
            let given = 0;
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team) continue;
              if (def(ally).tier === 'structure') continue;
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              if (g.tick < ally.regenImmuneUntil) continue;
              ally.regenPerSec = amt;
              ally.regenUntil = until;
              ally.regenImmuneUntil = g.tick + a.cooldown;
              // 「최후의 함성」: 회복과 함께 「죽음을 버티는」 가호도 같이 얹는다
              if (a.lastStandPct) {
                ally.lastStandUntil = until;
                ally.lastStandPct = a.lastStandPct;
                ally.lastStandHealPct = a.lastStandHealPct ?? 30;
              }
              given++;
            }
            if (given > 0) spendSkill(e, i, a);
            break;
          }
          case 'selfShield': { // 엘루리온 「비늘 방벽」 — 다른 보호막 위에 얹힌다
            if (!inCombat) break;
            const amt = a.damage ?? 100;
            e.shieldHp += amt;          // 합산 (다만 이 스킬 자체는 쿨마다 100 고정)
            e.shieldUntil = Number.MAX_SAFE_INTEGER; // 지속시간 없음 — 다 닳으면 끝
            spendSkill(e, i, a);
            break;
          }
          case 'airTaunt': { // 「창공의 포효」 대공이 되는 적만 이쪽을 보게 만든다
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(7);
            const until = g.tick + (a.durTicks ?? 140);
            let hit = 0;
            for (const foe of g.entities) {
              if (!foe.alive || foe.team === e.team || blocksStatus(g, foe)) continue;
              const fd = def(foe);
              // 대공이 안 되는 적은 애초에 나를 못 때린다 — 도발해봤자 바보가 될 뿐
              if (!canTargetAir(fd)) continue;
              if (dist2(e.x, e.y, foe.x, foe.y) > r * r) continue;
              foe.airTauntUntil = until;
              foe.airTauntBy = e.id;
              hit++;
            }
            if (hit > 0) spendSkill(e, i, a);
            break;
          }
          case 'ram': { // 「들이받기」 하늘의 적에게 돌진 → 강타 → 제자리 복귀
            const range = a.castRange ?? tiles(8);
            // 「지상 유닛은 안 당한다」 — 대공이 되는지가 아니라 실제로 떠 있는지로 고른다.
            // (canTargetAir 로 고르면 땅에 선 대공 유닛에게도 박아서 스펙과 어긋났다)
            const aim = nearestFoeWithin(g, e, d, range, (v) => isFlying(g, v));
            if (!aim) break;
            e.returnX = e.x;
            e.returnY = e.y;
            e.returnTick = g.tick + (a.durTicks ?? 24);
            const ad = def(aim);
            e.x = clamp(aim.x - (ad.radius + d.radius), 0, g.map.length);
            e.y = clampLaneY(g.map, e.x, aim.y);
            applyStrike(g, e, a, aim);
            // 제 몸도 상한다 — 남은 체력의 10%
            e.hp -= idiv(e.hp, 10);
            e.targetId = aim.id;
            spendSkill(e, i, a);
            break;
          }
          case 'diveStrike': { // 오베론 「그림자 도약」 적 후열 강타 후 복귀
            const range = a.castRange ?? tiles(7);
            const pick = (filter: (v: Entity) => boolean): Entity | undefined =>
              nearestFoeWithin(g, e, d, range, (v) =>
                g.tick >= v.invulnUntil && def(v).speed > 0 && filter(v));
            const aim = pick((v) => def(v).tags.includes('support'))
              ?? pick((v) => (def(v).weapon?.range ?? 0) >= tiles(2))
              ?? pick(() => true);
            if (!aim) break;
            e.returnX = e.x;
            e.returnY = e.y;
            e.returnTick = g.tick + (a.durTicks ?? 40); // 2초 뒤 복귀
            const ad2 = def(aim);
            e.x = clamp(aim.x - (ad2.radius + d.radius), 0, g.map.length);
            e.y = clampLaneY(g.map, e.x, aim.y);
            applyStrike(g, e, a, aim);
            e.targetId = aim.id;
            spendSkill(e, i, a);
            break;
          }
          case 'debuffZone': { // 오베론 「인분의 장막」 장판 — 지속딜 + 공속·사거리 감소
            if (!inCombat) break;
            const r = a.splash ?? tiles(4.5);
            g.zones.push({
              id: g.nextZoneId++, team: e.team, kind: a.zone?.kind ?? 'spores',
              x: e.x, y: e.y, radius: r, untilTick: g.tick + (a.durTicks ?? 140),
              dpsOverride: 0, followId: -1,
            });
            spendSkill(e, i, a);
            break;
          }
          case 'puppetShow': { // 「인형극」 주변 아군 기물을 복제해 무대에 올린다
            if (!inCombat) break;
            const r = a.auraRadius ?? tiles(6);
            const want = a.summonCount ?? 5;
            // 후보 수집 — 기물(construct) 아군만, 배열 순서 그대로 (결정론)
            const cast: Entity[] = [];
            for (const ally of g.entities) {
              if (!ally.alive || ally.team !== e.team || ally.id === e.id) continue;
              const ad = def(ally);
              if (!ad.tags.includes('construct') || ad.tier === 'structure') continue;
              if (ad.tier === 'final') continue; // 최종 유닛은 복제 불가 — 앨리스가 앨리스를 찍어낼 순 없다
              if (dist2(e.x, e.y, ally.x, ally.y) > r * r) continue;
              cast.push(ally);
            }
            if (cast.length === 0) break;
            // 무작위로 골라 복제 (같은 개체가 두 번 뽑히지 않게 뒤에서 당겨 채운다)
            const pool = [...cast];
            const n = Math.min(want, pool.length);
            for (let k = 0; k < n; k++) {
              const pick = nextInt(g.rng, pool.length);
              const src = pool[pick]!;
              pool[pick] = pool[pool.length - 1]!;
              pool.pop();
              const copy = spawnBattleEntity(g, src.defId, e.team, e.owner,
                clamp(src.x + (k - 2) * 300, 0, g.map.length),
                clampLaneY(g.map, src.x, src.y + ((k % 2 === 0) ? 400 : -400)),
                src.defOv, e);
              copy.hp = def(copy).maxHp;   // 온전한 몸, 쿨다운 없는 새 유닛
            }
            spendSkill(e, i, a);
            break;
          }
          case 'curtainCall': { // 「커튼콜」 적을 무대 중앙으로 빨아들였다 통째로 치운다
            if (!inCombat) break;
            const r = a.splash ?? tiles(5);
            const range = a.castRange ?? tiles(7);
            const aim = nearestFoeWithin(g, e, d, range, () => true);
            if (!aim) break;
            // 흡입 구간: 커튼이 열려 있는 동안 중앙으로 끌려온다 (사후의 경계 재활용)
            const suck = a.durTicks ?? 120; // 기본 6초
            g.zones.push({
              id: g.nextZoneId++, team: e.team, kind: 'grave',
              x: aim.x, y: aim.y, radius: r, untilTick: g.tick + suck, dpsOverride: 0, followId: -1,
            });
            // 커튼이 닫히는 순간(6초 뒤) 무대 위의 적을 6초간 치운다
            g.curtainCalls.push({
              x: aim.x, y: aim.y, r, closeTick: g.tick + suck,
              hideTicks: a.executeBonus ?? 120, team: e.team,
            });
            spendSkill(e, i, a);
            break;
          }
          case 'sleep': // 「수면」 현재 목표를 재운다 (이미 자는 대상엔 낭비하지 않는다)
            if (inCombat && def(t!).speed > 0 && g.tick >= t!.invulnUntil && g.tick >= t!.sleepUntil
              && !isStatusImmune(t!)) {
              t!.sleepUntil = g.tick + (a.durTicks ?? 0);
              t!.sleepHits = 0;
              spendSkill(e, i, a);
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
              if (hooked > 0) spendSkill(e, i, a);
            }
            break;
        }
      }
    }

    if (!d.weapon) continue; // 여기부터는 평타 처리 — 무기 없는 시전자는 끝
    if (e.cooldown > 0) continue;
    if (isIncapacitated(g, e)) continue; // 기절·수면·빙결: 공격 불가
    if (g.tick < e.fearedUntil) continue; // 공포: 달아나느라 공격 불가
    if (g.tick < e.seducedUntil) continue; // 매혹: 싸움을 잊었다
    // (혼란은 공격을 막지 않는다 — 타겟팅이 이미 자기 편을 조준하고 있다)

    const target = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
    if (!target || !target.alive || !canHit(g, d, target) || isShielded(g, target)) continue;
    // 혼란이 풀렸는데 아군을 조준 중이면 스윙 취소 (다음 틱 타겟팅이 정리)
    if (g.tick >= e.confusedUntil && target.team === e.team) continue;
    const td = def(target);
    const reach = rangeOf(g, e, d) + d.radius + td.radius;
    if (dist2(e.x, e.y, target.x, target.y) > reach * reach) continue;

    // 액티브 strike (처형기): 조건이 맞으면 이번 스윙을 스킬로 대체
    if (acts) {
      let fired = false;
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i]!;
        if (a.kind !== 'strike' || !skillReady(e, i, a)) continue;
        if (a.soloOnly && g.campaignMode) continue; // 캠페인에선 봉인된 스킬
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
        spendSkill(e, i, a);
        e.cooldown = swingCooldown(e, d);
        fired = true;
        break;
      }
      if (fired) continue;
    }

    if (d.weapon.crossTargets) {
      /*
       * 교차 사격 (엘로윈 「양손 시전」) — 사거리 안의 지상 하나와 공중 하나를
       * 같은 스윙에 각각 정타로 맞힌다. 한쪽뿐이면 그쪽만 맞고, 그래도
       * 「지상 하나 + 공중 하나」라 물량에 휩쓸리지는 않는다.
       * 가장 가까운 쪽을 고르되 동률은 배열 앞쪽이 이긴다 (strict <, 결정론).
       */
      let gr: Entity | undefined;
      let grD2 = 0;
      let ai: Entity | undefined;
      let aiD2 = 0;
      const maxReach = maxRangeOf(g, e, d) + d.radius;
      for (const v of g.entities) {
        if (!v.alive || v.team !== target.team || v.id === e.id) continue;
        if (!canHit(g, d, v) || isShielded(g, v)) continue;
        const reach = maxReach + def(v).radius;
        const d2v = dist2(e.x, e.y, v.x, v.y);
        if (d2v > reach * reach) continue;
        if (isFlying(g, v)) {
          if (ai === undefined || d2v < aiD2) { ai = v; aiD2 = d2v; }
        } else if (gr === undefined || d2v < grD2) { gr = v; grD2 = d2v; }
      }
      if (gr) applyDamage(g, e, d, gr);
      if (ai) applyDamage(g, e, d, ai);
    } else if (d.weapon.multiTargets) {
      /*
       * 다중 사격 — 사거리 안의 적을 가까운 순으로 N기까지 각각 정타로 맞힌다.
       * 공중·지상을 가리지 않는다 (airMultiTargets 는 공중 목표일 때만).
       * 정렬은 삽입 정렬 + strict < 로, 동률이면 배열 앞쪽이 이긴다 (결정론).
       */
      const n = d.weapon.multiTargets;
      const maxReach = maxRangeOf(g, e, d) + d.radius;
      const picks: { v: Entity; d2: number }[] = [];
      for (const v of g.entities) {
        if (!v.alive || v.team !== target.team || v.id === e.id) continue;
        if (!canHit(g, d, v) || isShielded(g, v)) continue;
        const reach = maxReach + def(v).radius;
        const d2v = dist2(e.x, e.y, v.x, v.y);
        if (d2v > reach * reach) continue;
        let at = picks.length;
        while (at > 0 && d2v < picks[at - 1]!.d2) at--;
        picks.splice(at, 0, { v, d2: d2v });
        if (picks.length > n) picks.pop();
      }
      for (const p of picks) applyDamage(g, e, d, p.v);
    } else if (d.weapon.airMultiTargets && isFlying(g, target)) {
      // 다중 사격 (숲의 명궁): 공중 목표면 사거리 안 공중 적을 가까운 순 N기까지
      // 각각 정타로 맞힌다. 지상 목표는 아래의 일반 분기(단일)로 떨어진다.
      const n = d.weapon.airMultiTargets;
      const maxReach = rangeOf(g, e, d) + d.radius;
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
    } else if ((d.weapon.splash || e.hatKind === 3 || e.hatKind === 4)
        && !(d.weapon.splashAirOnly && !isFlying(g, target))) {
      // splashAirOnly: 공중을 때릴 때만 광역 — 지상 타겟은 아래 단일 타격으로 빠진다
      // 거대화·황금 모자: 평타가 광역으로 바뀜다 (기본 광역이 없으면 2타일)
      const hatSplash = (e.hatKind === 3 || e.hatKind === 4) ? tiles(2) : 0;
      const r = Math.max(d.weapon.splash ?? 0, hatSplash);
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
          dpsOverride: 0, followId: -1,
        });
      }
    }
    let cd = swingCooldown(e, d);
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
    if (g.tick < e.confusedUntil || g.tick < e.fearedUntil || g.tick < e.seducedUntil
      || isIncapacitated(g, e)) continue; // 혼란·공포·매혹·기절·수면: 치유 불가
    // 동시 회복(multi): 체력 비율이 낮은 순으로 여럿을 한 번에 돌본다 (기본 1명)
    const allies = findWoundedAllies(g, e, d, d.heal.range + d.radius, d.heal.multi ?? 1);
    let healedAny = false;
    for (const ally of allies) {
      // 중복힐 상한: 같은 대상에게 1초 안에 최대 3회 — 힐러가 몰려도 무한 탱킹 방지
      if (g.tick - ally.healWindowStart >= 20) {
        ally.healWindowStart = g.tick;
        ally.healsInWindow = 0;
      }
      if (ally.healsInWindow >= 3) continue;
      ally.healsInWindow++;
      // 「생명의 그릇」: 이 대상이 받는 회복량을 늘린다 (영웅 강화)
      const takenPct = def(ally).healTakenPct ?? 0;
      ally.hp += takenPct > 0
        ? d.heal.amount + idiv(d.heal.amount * takenPct, 100)
        : d.heal.amount;
      const max = def(ally).maxHp;
      if (ally.hp > max) ally.hp = max;
      wardPoison(g, ally);
      healedAny = true;
    }
    // 전원 상한에 걸렸으면 쿨 소모 없이 다음 틱에 재판정
    if (healedAny) e.healCooldown = d.heal.cooldown;
  }

  // 「커튼콜」 닫힘: 무대 위에 있던 적들이 그 상태 그대로 잠시 사라진다.
  // 죽는 게 아니라 치워지는 것이라, 체력·버프·쿨다운을 그대로 안고 다시 나온다.
  if (g.curtainCalls.length > 0) {
    const pending: typeof g.curtainCalls = [];
    for (const cc of g.curtainCalls) {
      if (g.tick < cc.closeTick) { pending.push(cc); continue; }
      for (const v of g.entities) {
        if (!v.alive || v.team === cc.team) continue;
        if (def(v).tier === 'structure') continue;   // 건물은 무대에 못 올린다
        // 수호자·보스는 상태이상 전면 면역 — 무대에도 오르지 않는다.
        // (흡입 단계도 이미 면역이라, 여기만 통하면 규칙이 어긋난다)
        if (blocksStatus(g, v)) continue;
        if (dist2(cc.x, cc.y, v.x, v.y) > cc.r * cc.r) continue;
        v.vanishUntil = g.tick + cc.hideTicks;
        v.targetId = -1;
        // 사라진 것을 겨누던 참조를 끊는다 (허공을 때리지 않게)
        for (const o of g.entities) {
          if (o.targetId === v.id) o.targetId = -1;
          if (o.lastAttackerId === v.id) o.lastAttackerId = -1;
        }
      }
    }
    g.curtainCalls = pending;
  }

  // 「뼈 무덤」 부화: 20초를 버틴 무덤에서 본드래곤이 온전한 몸으로 일어선다.
  // 무덤이 먼저 부서지면 대기열에서 조용히 빠진다.
  if (g.boneGraves.length > 0) {
    const still: typeof g.boneGraves = [];
    for (const bg of g.boneGraves) {
      const grave = g.entities.find((q) => q.id === bg.graveId);
      if (!grave || !grave.alive) continue; // 부서졌다 — 부활 없음
      if (g.tick < bg.hatchTick) { still.push(bg); continue; }
      grave.alive = false;
      grave.hp = 0;
      const born = spawnBattleEntity(g, 'p_bone_dragon', bg.team, bg.owner, grave.x, grave.y, undefined, grave);
      born.hp = def(born).maxHp;                    // 온전한 몸으로
      born.graveReadyTick = g.tick + BONE_GRAVE_COOLDOWN; // 60초는 다시 무덤이 못 된다
      g.events.push({ tick: g.tick, kind: 'boneRevive', x: born.x, y: born.y });
    }
    g.boneGraves = still;
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
    /*
     * 「최후의 함성」(카엘): 함성이 닿아 있는 동안은 죽는 순간 버텨낼 수 있다.
     * 체력이 0 밑으로 내려가도 쓰러지지 않고 최대 체력의 일부를 되찾는다.
     * 확률 판정은 g.rng — 부활(rebirth)보다 먼저 본다.
     */
    if (g.tick < e.lastStandUntil && e.lastStandPct > 0 && def(e).tier !== 'structure'
      && nextChance(g.rng, e.lastStandPct)) {
      const back = idiv(def(e).maxHp * e.lastStandHealPct, 100);
      e.hp = back > 0 ? back : 1;
      g.events.push({ tick: g.tick, kind: 'lastStand', team: e.team as TeamId, x: e.x, y: e.y });
      continue;
    }
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
    // 본드래곤 「뼈 무덤」: 쓰러진 자리에 무덤을 남긴다.
    // 되살아난 직후 60초 동안은 그냥 죽는다 (graveReadyTick).
    if (e.defId === 'p_bone_dragon' && g.tick >= e.graveReadyTick) {
      const grave = spawnBattleEntity(g, 'c_bone_grave', e.team, e.owner, e.x, e.y, undefined, e);
      g.boneGraves.push({
        graveId: grave.id,
        hatchTick: g.tick + BONE_GRAVE_TICKS,
        team: e.team,
        owner: e.owner,
      });
    }
    /*
     * 「마나 순환」(엘로윈 강화): 이 죽음을 반경 안에서 지켜본 적 진영의
     * 시전자가 스택을 쌓는다. 가득 차면 스택이 0으로 돌아가며 액티브 쿨이
     * 전부 씻긴다 (차지 스킬은 차지까지 가득 찬다).
     * 「멈춘 시계」처럼 평생 한 번뿐인 스킬은 건드리지 않는다.
     */
    for (const w of g.entities) {
      if (!w.alive || w.team === e.team) continue;
      const wd = def(w);
      const sr = wd.skillReset;
      if (!sr) continue;
      if (dist2(w.x, w.y, e.x, e.y) > sr.radius * sr.radius) continue;
      w.resetStacks++;
      if (w.resetStacks < sr.need) continue;
      w.resetStacks = 0;
      const wa = wd.actives ?? [];
      for (let i = 0; i < wa.length; i++) {
        const wact = wa[i]!;
        if (wact.kind === 'timelock') continue; // 평생 한 번뿐인 스킬은 예외
        w.skillCds[i] = 0;
        if (wact.charges) {
          w.skillCharges[i] = wact.charges;
          w.skillRegen[i] = 0;
        }
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

/**
 * 사거리 안에서 체력 비율이 낮은 순으로 최대 count 명의 다친 아군을 고른다.
 * 결정론 규칙: 삽입 정렬 + 동률(strict <)은 배열 앞쪽이 이긴다.
 */
function findWoundedAllies(g: Game, healer: Entity, d: EntityDef, range: number, count: number): Entity[] {
  const picks: { t: Entity; ratio: number }[] = [];
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
    // 체력 비율(1000분율)이 낮은 순으로 상위 count 명 유지
    const ratio = idiv(t.hp * 1000, td.maxHp);
    let at = picks.length;
    while (at > 0 && ratio < picks[at - 1]!.ratio) at--;
    picks.splice(at, 0, { t, ratio });
    if (picks.length > count) picks.pop();
  }
  return picks.map((p) => p.t);
}
