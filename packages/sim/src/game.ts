/**
 * 게임 상태 관리: 생성, 경제, 출정 로테이션, 스텝.
 */
import { stepCombat } from './battle.ts';
import {
  DEFS, DEFAULT_MAP, GUARDIAN_OF, MAP, MAPS, applyBoons, clampLaneY, effectiveDef, techOfUnit,
  incomeUpgradeCost, isWalkable, laneCenterY, maskCellCenter, maskIndexOf, techOfTier, techUpCost,
  upgradeById, upgradesOfUnit, unitsOfRace,
} from './data.ts';
import { FP, clamp, idiv, tiles } from './math.ts';
import { createRng, nextChance, nextInt, nextRange } from './rng.ts';
import { isCombatTag } from './types.ts';
import type { MapDef } from './data.ts';
import type { BotStyle, CombatTeam, EnemyCamp, Entity, EntityDef, Game, GameConfig, HeroPerks, PlayerState, TeamId } from './types.ts';

/** 테스트/밸런스 도구용 직접 스폰. 게임 로직은 deployWave 를 쓴다. */
export function spawnUnit(
  g: Game, defId: string, team: CombatTeam, x: number, y: number, ov?: EntityDef,
): Entity {
  return spawnEntity(g, defId, team, -1, x, y, ov);
}

function spawnEntity(g: Game, defId: string, team: CombatTeam, owner: number, x: number, y: number, ov?: EntityDef): Entity {
  const d = DEFS[defId];
  if (!d) throw new Error(`unknown def: ${defId}`);
  // 격자 마스크가 있는 지형: 막힌 칸에 세우면 영영 갇힌다 — 길 위로 옮겨 놓는다.
  // 다만 못 움직이는 구조물(망루·소품)은 부른 자리에 그대로 둔다 —
  // 길가에 세우려고 숲을 찍었는데 길 한복판으로 끌려오면 통행을 막는다.
  if (g.map.mask && d.speed > 0) y = clampLaneY(g.map, x, y);
  const e: Entity = {
    id: g.nextEntityId++,
    defId, team, owner,
    ...(ov ? { defOv: ov } : {}),
    x, y, garrisonR: 0, lastX: x, lastY: y, stuckTicks: 0, phaseUntil: 0,
    anchorX: x, anchorY: y,
    hp: (ov ?? d).maxHp,
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
    skillCds: (ov ?? d).actives?.map(() => 0) ?? [],
    skillCharges: (ov ?? d).actives?.map((a) => a.charges ?? 0) ?? [],
    skillRegen: (ov ?? d).actives?.map(() => 0) ?? [],
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
  g.entities.push(e);
  return e;
}

export function createGame(cfg: GameConfig): Game {
  const map = MAPS[cfg.mapId ?? DEFAULT_MAP];
  if (!map) throw new Error(`unknown map: ${cfg.mapId}`);
  // 팀 내 순번은 배열 등장 순서. 양 팀 모두 최소 1명이어야 게임이 성립한다.
  const used: [number, number] = [0, 0];
  const slots = cfg.players.map((p) => used[p.team]++);
  if (used[0] === 0 || used[1] === 0) throw new Error('each team needs at least one player');
  const BOT_STYLES: readonly BotStyle[] = ['fastTech', 'rushThenGreedy', 'balanced', 'finalOnly'];
  const g: Game = {
    tick: 0,
    map,
    rng: createRng(cfg.seed),
    teamSize: used,
    botDifficulty: cfg.botDifficulty ?? 'easy',
    incomeCap: Math.min(MAP.INCOME_MAX_LEVEL, cfg.incomeCap ?? MAP.INCOME_MAX_LEVEL),
    techCap: Math.min(MAP.TECH_MAX, cfg.techCap ?? MAP.TECH_MAX),
    enemyBasicCutoffWave: cfg.enemyBasicCutoffWave ?? 0,
    unitMerges: cfg.unitMerges ?? [],
    basicRefunded: false,
    captureIncomeAdd: 0,
    enemyPreferredUnits: cfg.enemyPreferredUnits ?? [],
    enemyUnitCaps: cfg.enemyUnitCaps ?? {},
    allyUnitCaps: cfg.allyUnitCaps ?? {},
    enemyAllowedUnits: cfg.enemyAllowedUnits ?? [],
    enemyDeniedUnits: cfg.enemyDeniedUnits ?? [],
    campaignMode: cfg.campaignMode ?? false,
    enemyCamps: cfg.enemyCamps ?? [],
    deployLaneY: cfg.deployLaneY ?? 0,
    deployHold: false,
    deployHeld: 0,
    crits: [],
    threadBooms: [],
    boneGraves: [],
    curtainCalls: [],
    enemyIncomePct: cfg.enemyIncomePct ?? 0,
    enemyUnitMinWave: cfg.enemyUnitMinWave ?? {},
    enemyCapsUntilWave: cfg.enemyCapsUntilWave ?? Infinity,
    enemyGuardian: cfg.enemyGuardian ?? null,
    allowedUnits: [...(cfg.allowedUnits ?? [])],
    unitBoons: cfg.unitBoons ?? [],
    mercUnits: cfg.mercUnits ?? [],
    mercCostPct: cfg.mercCostPct ?? 100,
    mercCaptureRequired: cfg.mercCaptureRequired ?? false,
    holdLineX: cfg.holdLineX ?? 0,
    rallyX: 0,
    foeGoalX: 0,
    foeGoalY: 0,
    fleeX: 0,
    fleeY: 0,
    rallyY: 0,
    enemyHoldLineX: 0,
    defendNexus: cfg.defendNexus ?? false,
    jointDeploy: cfg.jointDeploy ?? false,
    allyDeploy: cfg.allyDeploy ?? null,
    mercOwner: -1,
    mercCapturingTeam: -1,
    mercCaptureTicks: 0,
    heroPerks: cfg.heroPerks ?? null,
    players: cfg.players.map((p, idx): PlayerState => {
      const botRng = createRng(cfg.seed ^ (0x9e37 * (idx + 7)));
      // 봇 성격을 시드로 무작위 배정 — 같은 시드면 항상 같은 성격 (결정론).
      // 캠페인은 적 봇 성격을 강제할 수 있다 (스테이지 디자인).
      const rolled = BOT_STYLES[nextInt(botRng, BOT_STYLES.length)]!;
      const botStyle = p.team === 1 && cfg.enemyBotStyle ? cfg.enemyBotStyle
        : p.team === 0 && cfg.allyBotStyle ? cfg.allyBotStyle
        : rolled;
      return {
        idx,
        team: p.team,
        slot: slots[idx]!,
        race: p.race,
        isBot: p.isBot,
        money: MAP.START_MONEY,
        incomeLevel: 0,
        incomeCooldownUntil: 0,
        techLevel: 1,
        techPendingUntil: -1,
        upgrades: {},
        comp: {},
        botRng,
        botStyle,
        botGoal: null,
      };
    }),
    entities: [],
    nextEntityId: 1,
    zones: [],
    nextZoneId: 1,
    waveIndex: 0,
    guardianDown: [false, false],
    events: [],
    over: null,
  };
  for (const team of [0, 1] as const) {
    // 손그림 지형 맵은 진영이 코리도어 한복판이 아니라 구석 언덕 위에 있다 (nexusPos)
    const np = map.nexusPos?.[team];
    spawnEntity(g, 'nexus', team, -1,
      np ? np[0] : map.nexusX[team],
      np ? np[1] : laneCenterY(map, map.nexusX[team]));
    if (!cfg.noTowers) {
      spawnEntity(g, 'tower', team, -1, map.towerX[team], laneCenterY(map, map.towerX[team]));
    }
  }
  /*
   * 지형 해저드 (진흙길·덩굴길) — 맵에 처음부터 깔린 장판.
   *
   * team 2(중립적대)로 깔면 장판 판정이 `e.team !== z.team` 이므로 양 진영
   * 모두가 걸린다. untilTick 은 사실상 무한 — 지형이라 사라지지 않는다.
   */
  if (map.terrain) {
    for (const t of map.terrain) {
      g.zones.push({
        id: g.nextZoneId++,
        team: 2,
        kind: t.kind,
        x: t.x,
        y: t.y,
        radius: t.radius,
        untilTick: Number.MAX_SAFE_INTEGER,
        followId: -1,
        dpsOverride: 0,
      });
    }
  }
  /*
   * 넥서스 방어력 오버라이드 (캠페인 스테이지 전용).
   *
   * 기본 넥서스는 방어 28 이라 공중 유닛의 평타가 1 로 잘린다. 「하늘로만
   * 갈 수 있는 판」(5 올빼미 성채)에서는 그 넥서스를 깰 방법이 아예 없어지므로
   * 방어력만 낮춘 판본을 쓴다. defId 는 그대로 'nexus' — 승패 판정이 defId 로
   * 구조물을 찾기 때문에 별도 defId 로 갈아끼우면 게임이 끝나지 않는다.
   */
  if (cfg.nexusArmor !== undefined) {
    for (const e of g.entities) {
      if (e.defId !== 'nexus') continue;
      e.defOv = { ...DEFS['nexus']!, armor: cfg.nexusArmor };
    }
  }
  // 영웅 특성: 시작 자금 (사람 플레이어에게만)
  if (g.heroPerks) {
    for (const p of g.players) if (!p.isBot) p.money += g.heroPerks.startMoney;
  }
  // 캠페인: 적 봇 시작 자금 오버라이드
  if (cfg.enemyStartMoney !== undefined) {
    for (const p of g.players) if (p.team === 1 && p.isBot) p.money = cfg.enemyStartMoney;
  }
  // 캠페인: 적 봇 시작 테크 — 전 티어를 미리 열고 등장은 minWave 로만 통제한다.
  // 테크가 이미 상한이면 botDecide 의 테크 분기가 통째로 스킵돼 테크비가 병력으로 간다.
  if (cfg.enemyStartTech !== undefined) {
    const lv = Math.max(1, Math.min(g.techCap, cfg.enemyStartTech));
    for (const p of g.players) if (p.team === 1 && p.isBot) p.techLevel = lv;
  }
  // 캠페인 다거점: 거점마다 시작 경제가 다르다 (성은 부유하게, 전초는 가난하게)
  for (const camp of g.enemyCamps) {
    const p = g.players.find((q) => q.team === 1 && q.slot === camp.slot);
    if (!p) continue;
    if (camp.startIncome !== undefined) p.incomeLevel = camp.startIncome;
    if (camp.startMoney !== undefined) p.money = camp.startMoney;
  }
  return g;
}

/** 이 플레이어가 맡은 거점 설정 (없으면 undefined). */
/**
 * 이 거점의 주둔지 건물이 부서졌는가.
 * 건물을 지정하지 않은 거점(성 등)은 언제나 살아 있는 것으로 친다.
 */
function campDown(g: Game, p: PlayerState): boolean {
  const camp = campOf(g, p);
  if (!camp?.nexusDefId) return false;
  for (const e of g.entities) {
    if (e.alive && e.owner === p.idx && e.defId === camp.nexusDefId) return false;
  }
  return true;
}

/** 지금이 「적 1티어 생산 중단」 구간인가. */
function basicCutoffOn(g: Game): boolean {
  return g.enemyBasicCutoffWave > 0 && g.waveIndex + 1 >= g.enemyBasicCutoffWave;
}

function campOf(g: Game, p: PlayerState): EnemyCamp | undefined {
  if (p.team !== 1 || g.enemyCamps.length === 0) return undefined;
  return g.enemyCamps.find((c) => c.slot === p.slot);
}

/** 지금 턴에 적용되는 생산 구간 (fromWave 이하 중 가장 늦은 것). */
function phaseOf(camp: EnemyCamp, wave: number): { units: readonly string[]; preferred?: readonly string[] } | undefined {
  if (!camp.phases || camp.phases.length === 0) return undefined;
  let hit: typeof camp.phases[number] | undefined;
  for (const ph of camp.phases) {
    if (wave + 1 >= ph.fromWave) hit = ph; // 배열 순서 그대로 — 뒤에 오는 구간이 이긴다
  }
  return hit;
}

/** 거점의 현재 인컴 상한 (incomeUnlocks 반영). */
function campIncomeCap(g: Game, camp: EnemyCamp): number {
  let cap = camp.incomeCap ?? g.incomeCap;
  for (const u of camp.incomeUnlocks ?? []) {
    if (g.waveIndex + 1 >= u.fromWave) cap = u.cap;
  }
  return Math.min(g.incomeCap, cap);
}

// ── 구매 ──────────────────────────────────────────────────────────────────

/**
 * 거점 주둔 부대. 진군하지 않고 그 자리를 지킨다 (반경 밖은 쫓지 않는다).
 * 호위전에서 「적이 이미 점거한 거점」을 만들 때 쓴다.
 */
export function spawnGarrison(
  g: Game, defId: string, team: CombatTeam, x: number, y: number, radius: number,
): Entity {
  const e = spawnUnit(g, defId, team, x, y);
  e.garrisonR = radius;
  e.anchorX = e.x;
  e.anchorY = e.y;
  return e;
}

export function buyUnit(g: Game, playerIdx: number, defId: string): boolean {
  const p = g.players[playerIdx];
  const d = DEFS[defId];
  if (!p || !d || g.over) return false;
  // 용병 (캠페인): 팀 0 사람 플레이어는 목록의 타종족 유닛을 살 수 있다.
  // 상점 점령제(mercCaptureRequired)면 양 팀 모두 — 점령한 팀만 용병 품목을 산다.
  const isMercItem = g.mercUnits.includes(defId);
  const isMerc = p.team === 0 && !p.isBot && isMercItem;
  if (g.mercCaptureRequired && isMercItem && g.mercOwner !== p.team) return false;
  if (d.race !== p.race && !isMerc) return false;
  // 테크 미달. 타종족 용병(마몬의 장사)은 테크 무관 — 돈이 곧 자격.
  // 전속 지원군(race: null 용병 — 앨리스 병력)은 자기 티어의 테크를 따른다.
  const mercTechFree = isMercItem && d.race !== null;
  if (!mercTechFree && techOfUnit(d) > p.techLevel) return false;
  // 캠페인 해금 제한: "사람 플레이어"만 화이트리스트 적용 (용병은 별도 허가).
  // 아군 봇(앨리스 군단 등)은 다른 종족이라 화이트리스트를 적용하면 아무것도 못 산다.
  if (!isMerc && p.team === 0 && !p.isBot && g.allowedUnits.length > 0 && !g.allowedUnits.includes(defId)) return false;
  // 캠페인: 적팀 화이트리스트 — 지정 시 목록 밖 유닛은 생산 불가
  if (p.team === 1 && g.enemyAllowedUnits.length > 0 && !g.enemyAllowedUnits.includes(defId)) return false;
  // 캠페인 금지 목록 — 화이트리스트가 없는 판에서도 이 유닛만은 못 산다.
  // 양 팀 봇 모두에 적용한다: 아군 봇에만 안 걸어 뒀더니, 「캠페인에 아직 안
  // 내보내기로 한」 신규 유닛(엘루리온·드라이어드 등)을 아군 봇이 뽑아 버렸다.
  // 사람 플레이어의 상점은 allowedUnits 가 따로 관리하므로 여기서 막지 않는다.
  if (p.isBot && g.enemyDeniedUnits.includes(defId)) return false;
  // 1티어 생산 중단(캠페인): 그 턴부터 적 봇은 기본 유닛을 못 산다
  if (p.team === 1 && p.isBot && basicCutoffOn(g) && techOfUnit(d) <= 1) return false;
  // 거점별 턴 구간 제한 — 지금 구간의 목록에 없으면 생산 불가
  {
    const camp = campOf(g, p);
    const ph = camp ? phaseOf(camp, g.waveIndex) : undefined;
    if (ph && !ph.units.includes(defId)) return false;
  }
  // 캠페인: 적팀 유닛 수량 상한 (팀 합산) — 최상급 유닛의 조기 물량화 방지.
  // enemyCapsUntilWave 이후엔 전부 해제 (후반 총력전).
  const cap = p.team === 1 && g.waveIndex < g.enemyCapsUntilWave ? g.enemyUnitCaps[defId] : undefined;
  if (cap !== undefined) {
    let owned = 0;
    for (const q of g.players) if (q.team === 1) owned += q.comp[defId] ?? 0;
    if (owned >= cap) return false;
  }
  // 캠페인: 아군(팀0) 봇 수량 상한 — 사람 플레이어는 제한 없음
  const allyCap = p.team === 0 && p.isBot ? g.allyUnitCaps[defId] : undefined;
  if (allyCap !== undefined) {
    let owned = 0;
    for (const q of g.players) if (q.team === 0 && q.isBot) owned += q.comp[defId] ?? 0;
    if (owned >= allyCap) return false;
  }
  // 캠페인: 최소 등장 웨이브 — 이 턴 전엔 네임드급 유닛이 나오지 않는다
  const minWave = p.team === 1 ? g.enemyUnitMinWave[defId] : undefined;
  if (minWave !== undefined && g.waveIndex < minWave) return false;
  const cost = isMerc ? idiv(d.cost * g.mercCostPct, 100) : d.cost;
  if (p.money < cost) return false;
  p.money -= cost;
  p.comp[defId] = (p.comp[defId] ?? 0) + 1;
  if (p.isBot) mergeComp(g, p);
  return true;
}

/**
 * 편성 합치기 — `per` 기가 모이면 `to` 한 기로 접는다.
 *
 * 12기면 「10기 → 상위 1기」로 접고 2기가 남는다. 접은 결과가 다시 다른 규칙의
 * 재료가 될 수 있으므로(사슬), 더 접을 게 없을 때까지 돈다.
 * 사람 플레이어의 편성은 건드리지 않는다 — 산 것이 말없이 사라지면 안 된다.
 */
export function mergeComp(g: Game, p: PlayerState): void {
  if (g.unitMerges.length === 0 || !p.isBot) return;
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    for (const m of g.unitMerges) {
      const have = p.comp[m.from] ?? 0;
      if (m.per <= 0 || have < m.per) continue;
      const packs = Math.floor(have / m.per);
      const left = have - packs * m.per;
      if (left > 0) p.comp[m.from] = left;
      else delete p.comp[m.from];
      p.comp[m.to] = (p.comp[m.to] ?? 0) + packs;
      changed = true;
    }
    if (!changed) break;
  }
}

/** 유닛 업그레이드 구매. 다음 출정 웨이브부터 적용된다. */
export function buyUpgrade(g: Game, playerIdx: number, upgradeId: string): boolean {
  const p = g.players[playerIdx];
  const u = upgradeById(upgradeId);
  if (!p || !u || g.over) return false;
  const unitDef = DEFS[u.unit];
  if (!unitDef || unitDef.race !== p.race) return false;
  if (p.upgrades[u.id]) return false; // 이미 보유
  if (p.techLevel < u.tech) return false;
  // 택1 그룹: 같은 그룹의 다른 업그레이드를 이미 샀으면 불가
  if (u.choiceGroup) {
    const conflict = upgradesOfUnit(u.unit).some(
      (o) => o.choiceGroup === u.choiceGroup && o.id !== u.id && p.upgrades[o.id],
    );
    if (conflict) return false;
  }
  if (p.money < u.cost) return false;
  p.money -= u.cost;
  p.upgrades[u.id] = true;
  return true;
}

/** 테크업 연구 시작. 완료는 TECH_TIME 이후 stepGame 에서 처리된다. */
export function buyTechUp(g: Game, playerIdx: number): boolean {
  const p = g.players[playerIdx];
  if (!p || g.over) return false;
  if (p.techLevel >= g.techCap) return false;
  if (p.techPendingUntil >= 0) return false; // 이미 연구 중
  const cost = techUpCost(p.techLevel);
  if (cost === undefined || p.money < cost) return false;
  p.money -= cost;
  // 4티어(3→4)만 3분, 나머지는 1분
  p.techPendingUntil = g.tick + (p.techLevel >= 3 ? MAP.TECH_TIME_T4 : MAP.TECH_TIME);
  return true;
}

/**
 * 출정 레인 변경 (두 갈래 맵). 다음 출정부터 적용된다.
 * 결정론: 값만 바꾸므로 명령 릴레이로 그대로 전달하면 된다.
 */
export function setDeployLane(g: Game, y: number): void {
  const lim = g.map.halfW;
  g.deployLaneY = Math.max(-lim, Math.min(lim, y));
}

/**
 * 「기지에 머무르기」 켜고 끄기 (두 갈래 맵).
 * 결정론: 값만 바꾸므로 명령 릴레이로 그대로 전달하면 된다.
 */
export function setDeployHold(g: Game, on: boolean): void {
  g.deployHold = on;
}

export function buyIncomeUpgrade(g: Game, playerIdx: number): boolean {
  const p = g.players[playerIdx];
  if (!p || g.over) return false;
  {
    const camp = campOf(g, p);
    let cap = camp ? campIncomeCap(g, camp) : g.incomeCap;
    // 축복 「깊은 뿌리」: 사람 플레이어의 인컴 단계 상한이 늘어난다 (8 → 최대 11)
    if (!p.isBot && g.heroPerks && (g.heroPerks.incomeCapAdd ?? 0) > 0) {
      cap = Math.min(11, cap + g.heroPerks.incomeCapAdd!);
    }
    if (p.incomeLevel >= cap) return false;
  }
  if (g.tick < p.incomeCooldownUntil) return false;
  const cost = incomeUpgradeCost(p.incomeLevel);
  if (p.money < cost) return false;
  p.money -= cost;
  p.incomeLevel++;
  p.incomeCooldownUntil = g.tick + MAP.INCOME_COOLDOWN;
  return true;
}

// ── 출정 ──────────────────────────────────────────────────────────────────

/** 부대 구성을 진형으로 전개. 사거리 짧은 유닛이 앞열. */
/**
 * 마스크 맵에서 「이 근처의 빈 길 칸」 하나. 없으면 null.
 *
 * 출정 대형은 격자를 모른다. 좁은 숲길 거점(6 자정의 마을 1시 입구)에서는
 * 뒷열이 통째로 벽에 박혔고, clampLaneY 가 그걸 전부 같은 몇 칸으로 몰아넣어
 * 열 몇 기가 한 자리에 겹쳐 섰다 — 서로 밀어내느라 길목이 그대로 막혔다.
 * 벽에 걸리는 자리는 대형을 접고 길을 따라 퍼뜨린다.
 *
 * 결정론: 반경 오름차순 → 행 → 열 고정 순회. 난수를 쓰지 않는다.
 */
function freeCellNear(m: MapDef, x: number, y: number, taken: number[]): { x: number; y: number } | null {
  const mk = m.mask;
  if (!mk) return null;
  const here = maskIndexOf(m, x, y);
  if (here < 0) return null;
  const r0 = (here / mk.cols) | 0;
  const c0 = here - r0 * mk.cols;
  // 서로 밀어내지 않을 최소 간격 (칸) — 0.75타일
  const cellsPerTile = idiv(mk.rows * FP, m.length);
  const gap = Math.max(1, idiv(cellsPerTile * 3, 4));
  for (let rad = 0; rad <= 48; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (rad > 0 && dr !== -rad && dr !== rad && dc !== -rad && dc !== rad) continue;
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= mk.rows || c < 0 || c >= mk.cols) continue;
        const i = r * mk.cols + c;
        if (mk.data.charCodeAt(i) !== 46) continue;
        let clash = false;
        for (const t of taken) {
          const tr = (t / mk.cols) | 0;
          const tc = t - tr * mk.cols;
          const dr2 = tr > r ? tr - r : r - tr;
          const dc2 = tc > c ? tc - c : c - tc;
          if (dr2 < gap && dc2 < gap) { clash = true; break; }
        }
        if (clash) continue;
        taken.push(i);
        return maskCellCenter(m, i);
      }
    }
  }
  return null;
}

function deployWave(g: Game, p: PlayerState): void {
  const list: EntityDef[] = [];
  for (const d of unitsOfRace(p.race)) {
    const n = p.comp[d.id] ?? 0;
    for (let i = 0; i < n; i++) list.push(d);
  }
  // 용병 (타종족): 편성에 있으면 함께 출정한다 — 순회 순서는 mercUnits 배열 고정 (결정론)
  for (const id of g.mercUnits) {
    const d = DEFS[id];
    if (!d || d.race === p.race) continue;
    const n = p.comp[id] ?? 0;
    for (let i = 0; i < n; i++) list.push(d);
  }
  if (list.length === 0) return;
  // 사거리 오름차순 = 근접 앞열. 힐러는 최후열.
  list.sort((a, b) => rangeKey(a) - rangeKey(b));

  const perCol = 4;
  const colGap = tiles(0.7);
  const rowGap = tiles(0.75);
  const m = g.map;
  let baseX = m.spawnPos?.[p.team]?.[0] ?? m.spawnX[p.team];
  // 아군 봇 출정 위치 오버라이드 (앨리스 군단 — 위 갈래에서 내려온다)
  const allyOv = p.team === 0 && p.isBot ? g.allyDeploy : null;
  if (allyOv) baseX = allyOv.x;
  // 다거점: 거점마다 자기 자리에서 나온다 (성·전초·전방기지가 다른 곳에서 밀려온다)
  const campHere = campOf(g, p);
  if (campHere?.x !== undefined) baseX = campHere.x;
  // 슬롯별 y 밴드: 팀 인원 수만큼 코리도어 폭을 나눠 고르게 배치한다.
  // (1명이면 정중앙, 3명이면 기존과 동일하게 상/중/하)
  const n = g.teamSize[p.team];
  const slotY = idiv((2 * p.slot - (n - 1)) * m.halfW, n);
  // 두 갈래 맵: 사람 플레이어는 고른 레인에서 출정한다 (땅을 눌러 바꾼다)
  const laneOv = p.team === 0 && !p.isBot && g.deployLaneY !== 0 ? g.deployLaneY : 0;
  const spawnOv = m.spawnPos?.[p.team];
  const baseY = campHere?.y !== undefined ? campHere.y
    : allyOv ? allyOv.y
    : spawnOv ? spawnOv[1] + (laneOv !== 0 ? laneOv : slotY)
    : laneCenterY(m, baseX) + (laneOv !== 0 ? laneOv : slotY);
  const dir = p.team === 0 ? -1 : 1; // 후열이 자기 진영 쪽으로

  // 마스크 맵: 대형이 벽에 걸린 자리를 길 위로 퍼뜨릴 때 이미 쓴 칸을 기억한다
  const taken: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i]!;
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const jx = nextRange(g.rng, -150, 150);
    const jy = nextRange(g.rng, -150, 150);
    let x = clamp(baseX + dir * col * colGap + jx, 0, m.length);
    const idealY = baseY + (row * rowGap - Math.floor(((perCol - 1) * rowGap) / 2)) + jy;
    // 대형 자리가 벽이면 거점 둘레의 빈 길 칸으로 (좁은 숲길에서 겹쳐 서는 걸 막는다)
    const spot = m.mask && !isWalkable(m, x, idealY) ? freeCellNear(m, baseX, baseY, taken) : null;
    let y: number;
    if (spot) {
      x = spot.x;
      y = spot.y;
    } else {
      y = clampLaneY(m, x, idealY);
      if (m.mask) {
        const cell = maskIndexOf(m, x, y);
        if (cell >= 0) taken.push(cell);
      }
    }
    let ov = effectiveDef(d.id, p.upgrades);
    // 캠페인 유닛 강화 (사람 플레이어의 유닛만)
    if (!p.isBot && g.unitBoons.length > 0) {
      const boon = applyBoons(ov ?? d, g.unitBoons);
      if (boon !== (ov ?? d)) ov = boon;
    }
    // 영웅 특성: 세계수의 축복 (사람 플레이어의 유닛만 강화)
    if (!p.isBot && g.heroPerks) ov = applyHeroPerks(ov ?? d, g.heroPerks);
    const ent = spawnEntity(g, d.id, p.team, p.idx, x, y, ov);
    // 갈래별 목표: 이 거점에서 나왔으면 그 거점이 노리는 곳을 물려받는다
    if (campHere?.goalX !== undefined && campHere.goalY !== undefined) {
      ent.goalX = campHere.goalX;
      ent.goalY = campHere.goalY;
    }
    // 축복: 배치되는 순간부터 기본 보호막을 두른다 (시간제한 없음 — 깎이면 그걸로 끝)
    if (!p.isBot && g.heroPerks && (g.heroPerks.shieldAdd ?? 0) > 0) {
      ent.shieldHp = g.heroPerks.shieldAdd!;
      ent.shieldUntil = Number.MAX_SAFE_INTEGER;
      ent.shieldEverGranted = true;
    }
  }
}

/** 영웅 특성을 유닛 정의에 반영한 사본. */
function applyHeroPerks(base: EntityDef, perks: HeroPerks): EntityDef {
  const maxHp = perks.hpPct ? idiv(base.maxHp * (100 + perks.hpPct), 100) : base.maxHp;
  const asp = perks.atkSpeedPct ?? 0;
  const weapon = base.weapon && (perks.dmgPct || asp)
    ? {
      ...base.weapon,
      damage: perks.dmgPct ? idiv(base.weapon.damage * (100 + perks.dmgPct), 100) : base.weapon.damage,
      cooldown: asp ? Math.max(1, idiv(base.weapon.cooldown * 100, 100 + asp)) : base.weapon.cooldown,
    }
    : base.weapon;
  const armor = perks.armorAdd ? (base.armor ?? 0) + perks.armorAdd : base.armor;
  const speed = perks.moveSpeedPct ? idiv(base.speed * (100 + perks.moveSpeedPct), 100) : base.speed;
  const cdr = perks.cdrPct ?? 0;
  const actives = base.actives && cdr > 0
    ? base.actives.map((a) => ({ ...a, cooldown: Math.max(1, idiv(a.cooldown * (100 - cdr), 100)) }))
    : base.actives;
  return {
    ...base, maxHp, armor, speed,
    ...(weapon ? { weapon } : {}),
    ...(actives ? { actives } : {}),
  };
}

function rangeKey(d: EntityDef): number {
  if (d.heal) return 1_000_000;
  return d.weapon ? d.weapon.range : 900_000;
}

// ── 봇 ────────────────────────────────────────────────────────────────────

/** 성격별 의사결정 파라미터. rush 성격은 웨이브에 따라 두 얼굴을 가진다. */
interface BotBrain {
  techBuyPct: number;   // 테크비가 모였을 때 실제로 누를 확률
  techSavePct: number;  // 테크비가 모자랄 때 이번 틱 소비를 참을 확률
  incomePct: number;    // 인컴업 시도 확률
  upgradePct: number;   // 유닛 업그레이드(해금 포함) 시도 확률
  highTierBias: number; // 유닛 목표 추첨의 비용 가중 지수 (1 = cost, 2 = cost^2 근사)
  spendAll: boolean;    // 잔돈을 남기지 않고 물량을 쏟아붓는가
}

function brainOf(g: Game, p: PlayerState): BotBrain {
  const earlyGame = g.waveIndex < 3; // 첫 3웨이브 = 초반
  switch (p.botStyle) {
    case 'fastTech':
      return { techBuyPct: 100, techSavePct: 90, incomePct: 25, upgradePct: 35, highTierBias: 2, spendAll: false };
    case 'rushThenGreedy':
      return earlyGame
        ? { techBuyPct: 30, techSavePct: 10, incomePct: 4, upgradePct: 10, highTierBias: 1, spendAll: true }
        : { techBuyPct: 95, techSavePct: 85, incomePct: 20, upgradePct: 35, highTierBias: 2, spendAll: false };
    case 'finalOnly':
      return { techBuyPct: 100, techSavePct: 95, incomePct: 15, upgradePct: 40, highTierBias: 3, spendAll: false };
    case 'balanced':
    default:
      return { techBuyPct: 85, techSavePct: 80, incomePct: 14, upgradePct: 30, highTierBias: 1, spendAll: false };
  }
}

/** 어려움 난이도: 적팀 사람의 최다 보유 유닛 (카운터 픽의 기준). */
function humanTopUnit(g: Game, p: PlayerState): EntityDef | undefined {
  const human = g.players.find((h) => !h.isBot && h.team !== p.team);
  if (!human) return undefined;
  let bestId: string | undefined;
  let bestN = 0;
  for (const id of Object.keys(human.comp)) {
    const n = human.comp[id] ?? 0;
    if (n > bestN) {
      bestN = n;
      bestId = id;
    }
  }
  return bestId ? DEFS[bestId] : undefined;
}

/** 이 유닛이 target 의 카운터인가 (태그 보너스 보유 + 실제로 때릴 수 있음). */
function countersUnit(d: EntityDef, target: EntityDef): boolean {
  const w = d.weapon;
  if (!w) return false;
  if (target.flying && w.targets === 'ground') return false;
  if (!target.flying && w.targets === 'air') return false;
  if (!w.bonus) return false;
  for (const tag of target.tags) {
    if (isCombatTag(tag) && (w.bonus[tag] ?? 0) > 0) return true;
  }
  if (target.flying && (w.bonus.flying ?? 0) > 0) return true;
  return false;
}

function botDecide(g: Game, p: PlayerState): void {
  const brain = brainOf(g, p);
  const hard = g.botDifficulty === 'hard';
  const human = hard ? g.players.find((h) => !h.isBot && h.team !== p.team) : undefined;

  // 1) 테크업. 어려움 난이도는 적 사람이 앞서 있으면 무조건 따라간다.
  if (p.techLevel < g.techCap && p.techPendingUntil < 0) {
    const cost = techUpCost(p.techLevel);
    if (cost !== undefined) {
      const chase = human !== undefined
        && (human.techLevel > p.techLevel || (human.techPendingUntil >= 0 && human.techLevel >= p.techLevel));
      if (p.money >= cost) {
        if (chase || nextChance(p.botRng, brain.techBuyPct)) buyTechUp(g, p.idx);
      } else {
        // 테크 3까지는 모아서라도 올린다.
        // 4티어(1800원)는 초중반에 모으면 인컴도 병력도 멈춰 봇이 주저앉으므로,
        // 「최종 유닛을 노리는 성격」이거나 후반(12웨이브~)일 때만 저축한다.
        // 경제를 어느 정도 갖춘 뒤에야 4티어를 노린다 — 인컴을 제쳐두고
        // 1800원을 모으면 후반 경제가 통째로 뒤처진다 (인컴 추격 실패로 드러났다).
        const wantT4 = p.incomeLevel >= 3
          && (p.botStyle === 'finalOnly' || p.botStyle === 'fastTech' || g.waveIndex >= 12);
        const maySave = p.techLevel < 3 || wantT4;
        if (maySave && (chase || nextChance(p.botRng, brain.techSavePct))) {
          return; // 이번 틱은 유닛을 사지 않고 테크비를 모은다
        }
      }
    }
  }

  // 2) 인컴 업그레이드. 어려움 난이도는 적 사람의 인컴을 따라간다 —
  //    추격 중인데 돈이 모자라면 유닛 구매를 참고 인컴비를 모은다.
  const myCamp = campOf(g, p);
  const myIncomeCap = myCamp ? campIncomeCap(g, myCamp) : g.incomeCap;
  if (p.incomeLevel < myIncomeCap && g.tick >= p.incomeCooldownUntil) {
    const chase = human !== undefined && human.incomeLevel > p.incomeLevel;
    const cost = incomeUpgradeCost(p.incomeLevel);
    if (p.money >= cost) {
      if (chase || nextChance(p.botRng, brain.incomePct)) buyIncomeUpgrade(g, p.idx);
    } else if (chase && nextChance(p.botRng, 70)) {
      return; // 인컴 추격 저축
    }
  }

  // 3) 유닛 업그레이드 + 스킬 해금. 비싼 해금(1000원)을 우선하고,
  //    해금 후보가 있는데 돈이 모자라면 가끔 유닛 구매를 참고 해금비를 모은다.
  {
    const cands = Object.keys(p.comp)
      .filter((id) => (p.comp[id] ?? 0) > 0)
      .flatMap((id) => upgradesOfUnit(id))
      .filter((u) => !u.campaignOnly && !(g.campaignMode && u.soloOnly)
        && !p.upgrades[u.id] && u.tech <= p.techLevel);
    const affordable = cands.filter((u) => u.cost <= p.money);
    if (nextChance(p.botRng, brain.upgradePct) && affordable.length > 0) {
      const unlocks = affordable.filter((u) => u.cost >= 1000);
      const pick = unlocks.length > 0 && nextChance(p.botRng, 60)
        ? unlocks[nextInt(p.botRng, unlocks.length)]!
        : affordable[nextInt(p.botRng, affordable.length)]!;
      buyUpgrade(g, p.idx, pick.id);
    } else if (cands.some((u) => u.cost >= 1000 && u.cost > p.money) && nextChance(p.botRng, 30)) {
      return; // 해금비 저축
    }
  }

  // 4) 유닛 구매 풀. finalOnly 는 테크 3 이후 최상급·최종만 노린다.
  let pool = unitsOfRace(p.race).filter((d) => techOfUnit(d) <= p.techLevel);
  // 상점 점령제: 점령한 팀의 봇은 용병 품목을 구매 목록에 넣는다
  // (용병은 summonOnly 라 기본 pool 에 없다 — 점령 중에만 열린다)
  if (g.mercUnits.length > 0 && (!g.mercCaptureRequired || g.mercOwner === p.team)) {
    for (const id of g.mercUnits) {
      const d = DEFS[id];
      if (d && d.race === p.race && !pool.some((x) => x.id === id)) pool.push(d);
    }
  }
  if (p.team === 0 && !p.isBot && g.allowedUnits.length > 0) {
    pool = pool.filter((d) => g.allowedUnits.includes(d.id));
  }
  if (p.team === 1 && g.enemyAllowedUnits.length > 0) {
    pool = pool.filter((d) => g.enemyAllowedUnits.includes(d.id));
  }
  if (g.enemyDeniedUnits.length > 0) {
    // 봇 구매 풀 — 아군 봇도 캠페인 금지 목록을 지킨다
    pool = pool.filter((d) => !g.enemyDeniedUnits.includes(d.id));
  }
  if (p.team === 1 && basicCutoffOn(g)) {
    pool = pool.filter((d) => techOfUnit(d) > 1);
  }
  // 거점 구간 목록 (있으면 그 안에서만 고른다)
  const campHere = campOf(g, p);
  const phaseHere = campHere ? phaseOf(campHere, g.waveIndex) : undefined;
  if (phaseHere) {
    pool = pool.filter((d) => phaseHere.units.includes(d.id));
  }
  if (p.team === 1) {
    pool = pool.filter((d) => {
      const minWave = g.enemyUnitMinWave[d.id];
      if (minWave !== undefined && g.waveIndex < minWave) return false;
      if (g.waveIndex >= g.enemyCapsUntilWave) return true; // 캡 해제 구간
      const cap = g.enemyUnitCaps[d.id];
      if (cap === undefined) return true;
      let owned = 0;
      for (const q of g.players) if (q.team === 1) owned += q.comp[d.id] ?? 0;
      return owned < cap;
    });
  }
  if (p.team === 0 && p.isBot) {
    pool = pool.filter((d) => {
      const capA = g.allyUnitCaps[d.id];
      if (capA === undefined) return true;
      let owned = 0;
      for (const q of g.players) if (q.team === 0 && q.isBot) owned += q.comp[d.id] ?? 0;
      return owned < capA;
    });
  }
  if (p.botStyle === 'finalOnly' && p.techLevel >= g.techCap) {
    const top = pool.filter((d) => d.tier === 'supreme' || d.tier === 'final');
    if (top.length > 0) pool = top;
  }
  if (pool.length === 0) return;

  // 비용^bias 가중 + 어려움 난이도 카운터 픽 (적 사람의 주력을 잡는 유닛 ×4)
  const counterTarget = hard ? humanTopUnit(g, p) : undefined;
  const weightOf = (d: EntityDef): number => {
    let w = d.cost;
    for (let b = 1; b < brain.highTierBias; b++) w = idiv(w * d.cost, 100);
    if (w < 1) w = 1;
    if (counterTarget && countersUnit(d, counterTarget)) w *= 4;
    // 캠페인 스테이지 성향: 적 봇은 지정된 유닛을 압도적으로 선호한다
    if (p.team === 1 && g.enemyPreferredUnits.includes(d.id)) w *= 8;
    // 거점 구간이 지정한 선호 유닛도 같은 무게로 민다
    if (phaseHere?.preferred?.includes(d.id)) w *= 8;
    return w;
  };
  const weights = pool.map(weightOf);
  const totalW = weights.reduce((a, b) => a + b, 0);

  // 목표 유지형 구매: 목표를 한 번 정하면 살 때까지 저축한다.
  // (매번 재추첨하면 고티어 유닛 값이 영영 안 모여 봇이 저티어만 뽑는다 — 실측된 문제)
  for (let guard = 0; guard < 8; guard++) {
    let goal = p.botGoal ? pool.find((d) => d.id === p.botGoal) : undefined;
    if (!goal) {
      let r = nextInt(p.botRng, totalW);
      goal = pool[pool.length - 1]!;
      for (let i = 0; i < pool.length; i++) {
        if (r < weights[i]!) {
          goal = pool[i]!;
          break;
        }
        r -= weights[i]!;
      }
      p.botGoal = goal.id;
    }
    if (p.money >= goal.cost) {
      if (!buyUnit(g, p.idx, goal.id)) {
        p.botGoal = null; // 캡 등으로 막힌 목표는 버린다
        continue;
      }
      p.botGoal = null;
      if (!brain.spendAll && nextChance(p.botRng, 35)) break; // 가끔 잔돈을 남기고 멈춤
    } else {
      // 저축. 아주 가끔만, 목표 저축을 크게 훼손하지 않는 잔돈 유닛으로 전선을 채운다.
      if (brain.spendAll || nextChance(p.botRng, 15)) {
        const cheap = pool.filter((d) => d.cost <= p.money && d.cost * 4 <= goal.cost);
        if (cheap.length > 0) buyUnit(g, p.idx, cheap[nextInt(p.botRng, cheap.length)]!.id);
      }
      break;
    }
  }
}

// ── 스텝 ──────────────────────────────────────────────────────────────────

export function stepGame(g: Game): void {
  if (g.over) return;
  g.events = [];

  // 테크 연구 완료 처리
  for (const p of g.players) {
    if (p.techPendingUntil >= 0 && g.tick >= p.techPendingUntil) {
      p.techLevel++;
      p.techPendingUntil = -1;
    }
  }

  // 경제 틱
  if (g.tick > 0 && g.tick % MAP.INCOME_INTERVAL === 0) {
    // 난이도 보너스는 「사람의 반대편」 봇에게만 준다. 사람이 없으면(봇끼리)
    // 아무도 못 받아 완전 대칭이 된다.
    const humanTeam = g.players.find((q) => !q.isBot)?.team;
    for (const p of g.players) {
      const baseIncome = MAP.INCOME_BASE + MAP.INCOME_PER_LEVEL * p.incomeLevel;
      // 캠페인: 적 인컴 배율 — 지정 시 난이도 인컴 보너스를 대체한다
      const scaled = p.isBot && p.team === 1 && g.enemyIncomePct > 0;
      p.money += scaled ? idiv(baseIncome * g.enemyIncomePct, 100) : baseIncome;
      // 영웅 특성: 계절의 흐름 (사람 플레이어 추가 수입)
      if (!p.isBot && g.heroPerks) p.money += g.heroPerks.incomeAdd;
      // 세계수 레벨: 수급량 % 가산 (천분율 — 5초 정산의 기본 수입에 곱한다)
      if (!p.isBot && g.heroPerks && (g.heroPerks.incomePermille ?? 0) > 0) {
        p.money += idiv(baseIncome * g.heroPerks.incomePermille!, 1000);
      }
      // 거점 확보 보너스 — 점령한 만큼 매 정산에 얹힌다 (뺏기면 그만큼 줄어든다)
      if (!p.isBot && g.captureIncomeAdd > 0) p.money += g.captureIncomeAdd;
      // 중간 난이도: 「적」 봇만 인컴이 12원 더 많다 (인컴업마다 +12씩).
      // 사람과 같은 편인 봇까지 보너스를 받으면 난이도가 통째로 상쇄돼,
      // easy·normal·hard 가 사실상 같은 판이 됐다 (실측: 승률 동일).
      if (p.isBot && p.team !== humanTeam && g.botDifficulty === 'normal' && !scaled) {
        p.money += 12 * (p.incomeLevel + 1);
      }
      if (p.isBot) botDecide(g, p);
    }
  }

  // 출정 로테이션. 팀마다 인원이 다를 수 있으므로 팀별로 따로 돈다
  // (1:3 이면 1인 팀은 매 웨이브, 3인 팀은 세 명이 번갈아 출정).
  const waveTick = MAP.PREP_TICKS + g.waveIndex * MAP.WAVE_TICKS;
  if (g.tick === waveTick) {
    /*
     * 1티어 생산 중단이 시작되는 턴: 살아 있던 적 1티어를 전부 거두고
     * 값을 주인에게 돌려준다.
     *
     * 그냥 생산만 막으면 이미 깔린 잡졸이 그대로 남아 렉이 안 풀리고,
     * 그렇다고 값을 안 돌려주면 봇이 병력·자금을 동시에 잃어 판이 무너진다.
     */
    if (basicCutoffOn(g) && !g.basicRefunded) {
      g.basicRefunded = true;
      // 편성(comp)이 원본이다 — 여기서 빼야 다음 턴부터 다시 안 나온다.
      // 환불은 「산 값 × 보유 수」로, 편성 기준이라 두 번 쳐지지 않는다.
      const gone = new Set<string>();
      for (const p of g.players) {
        if (p.team !== 1 || !p.isBot) continue;
        for (const [id, n] of Object.entries(p.comp)) {
          const d = DEFS[id];
          if (!d || d.tier === 'structure' || d.summonOnly) continue;
          if (techOfUnit(d) > 1) continue;
          p.money += d.cost * n;
          delete p.comp[id];
          gone.add(id);
        }
      }
      // 이미 전장에 나가 있던 것들도 같이 거둔다 (편성에서 뺐으니 값은 이미 돌려줬다)
      for (const e of g.entities) {
        if (!e.alive || e.team !== 1 || !gone.has(e.defId)) continue;
        e.alive = false;
        e.hp = 0;
      }
    }
    // 거점 확정 편입: 돈과 무관하게 매 턴 정해진 유닛이 합류한다.
    // (21턴부터 타나토스·밴시·본드래곤·데미리치가 최소 몇 기씩 섞이는 식)
    for (const camp of g.enemyCamps) {
      const p = g.players.find((q) => q.team === 1 && q.slot === camp.slot);
      if (!p) continue;
      // 인컴 해제: 상한만 푸는 게 아니라 그 단계까지 시스템이 직접 올려준다.
      // (전방기지는 번 돈을 전부 병력에 쏟아붓느라 스스로는 인컴을 못 올린다)
      for (const u of camp.incomeUnlocks ?? []) {
        // setLevel 이 있으면 거기까지만 올려 준다 — 그 위는 봇이 스스로 올린다
        const give = u.setLevel ?? u.cap;
        if (g.waveIndex + 1 >= u.fromWave && p.incomeLevel < give) {
          p.incomeLevel = Math.min(g.incomeCap, give);
        }
      }
      // 턴 보너스 자금 — 조건에 맞는 것 중 가장 늦은 구간 하나만 적용
      {
        let bonus = 0;
        for (const wm of camp.waveMoney ?? []) {
          if (g.waveIndex + 1 >= wm.fromWave) bonus = wm.amount;
        }
        if (bonus > 0) p.money += bonus;
      }
      for (const fg of camp.forcedGrowth ?? []) {
        if (g.waveIndex + 1 < fg.fromWave || fg.units.length === 0) continue;
        const per = fg.perWave ?? 1;
        for (let k = 0; k < per; k++) {
          // 배열을 순서대로 돌며 고른다 (결정론 — rng 를 쓰지 않는다)
          const id = fg.units[(g.waveIndex * per + k) % fg.units.length]!;
          p.comp[id] = (p.comp[id] ?? 0) + 1;
        }
        mergeComp(g, p);   // 확정 편입분도 합치기 대상이다
      }
      // 예산 소진: 출정 전에 남은 돈을 털어 병력을 채운다
      if (camp.spendAll) {
        for (let guard = 0; guard < 40; guard++) {
          const before = p.money;
          botDecide(g, p);
          if (p.money === before) break; // 더 살 게 없다
        }
      }
    }
    for (const p of g.players) {
      const joint = g.jointDeploy && p.team === 0;
      const camp = campOf(g, p);
      if (camp) {
        // 주둔지가 부서진 거점은 더 이상 증원을 보내지 않는다 — 부수고 다니는 게 의미가 있어야 한다
        if (campDown(g, p)) continue;
        // 거점은 로테이션을 타지 않는다 — 저마다 제 주기로 쏟아낸다.
        // deployEveryWave 2 면 두 턴에 한 번 (모았다가 한꺼번에 친다).
        const every = camp.deployEveryWave ?? 1;
        if ((g.waveIndex + 1) % every === 0) deployWave(g, p);
        continue;
      }
      // 사람 플레이어가 「머무르기」를 골랐으면 이번 턴은 안 나간다.
      // 미룬 턴 수는 세어 두었다가, 길을 고른 턴에 그만큼 더 쏟아낸다.
      if (p.team === 0 && !p.isBot && g.deployHold) continue;
      if (joint || p.slot === g.waveIndex % g.teamSize[p.team]) {
        const extra = p.team === 0 && !p.isBot ? g.deployHeld : 0;
        for (let k = 0; k <= extra; k++) deployWave(g, p);
      }
    }
    // 머문 턴은 쌓고, 나간 턴은 비운다 (사람 플레이어 기준)
    g.deployHeld = g.deployHold ? Math.min(g.deployHeld + 1, 8) : 0;
    g.events.push({ tick: g.tick, kind: 'wave', slot: g.waveIndex % g.teamSize[0] });
    g.waveIndex++;
  }

  stepCombat(g);
  g.tick++;
}

// ── 조회 헬퍼 ─────────────────────────────────────────────────────────────

export function findStructure(g: Game, defId: 'nexus' | 'tower', team: TeamId): Entity | undefined {
  return g.entities.find((e) => e.defId === defId && e.team === team);
}

/**
 * 다음 출정까지 남은 틱과 팀별 출정 순번.
 * 팀 인원이 다르면 순번도 팀마다 다르므로 둘 다 돌려준다.
 */
export function nextWaveInfo(g: Game): { ticksLeft: number; slot: number; slots: [number, number] } {
  const waveTick = MAP.PREP_TICKS + g.waveIndex * MAP.WAVE_TICKS;
  const slots: [number, number] = [g.waveIndex % g.teamSize[0], g.waveIndex % g.teamSize[1]];
  return { ticksLeft: waveTick - g.tick, slot: slots[0], slots };
}

/** 결정론 검증용 상태 해시 (FNV-1a). */
export function hashGame(g: Game): number {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (n >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (n >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  };
  mix(g.tick);
  mix(g.rng.s);
  for (const p of g.players) {
    mix(p.money);
    mix(p.incomeLevel);
    mix(p.techLevel);
  }
  for (const e of g.entities) {
    if (!e.alive) continue;
    mix(e.id); mix(e.x); mix(e.y); mix(e.hp); mix(e.targetId);
  }
  for (const z of g.zones) {
    mix(z.id); mix(z.x); mix(z.y); mix(z.untilTick);
  }
  return h >>> 0;
}

export { GUARDIAN_OF };
