/**
 * 게임 상태 관리: 생성, 경제, 출정 로테이션, 스텝.
 */
import { stepCombat } from './battle.ts';
import {
  DEFS, DEFAULT_MAP, GUARDIAN_OF, MAP, MAPS, applyBoons, clampLaneY, effectiveDef, techOfUnit,
  incomeUpgradeCost, laneCenterY, techOfTier, techUpCost,
  upgradeById, upgradesOfUnit, unitsOfRace,
} from './data.ts';
import { clamp, idiv, tiles } from './math.ts';
import { createRng, nextChance, nextInt, nextRange } from './rng.ts';
import { isCombatTag } from './types.ts';
import type { BotStyle, CombatTeam, Entity, EntityDef, Game, GameConfig, HeroPerks, PlayerState, TeamId } from './types.ts';

/** 테스트/밸런스 도구용 직접 스폰. 게임 로직은 deployWave 를 쓴다. */
export function spawnUnit(g: Game, defId: string, team: CombatTeam, x: number, y: number): Entity {
  return spawnEntity(g, defId, team, -1, x, y);
}

function spawnEntity(g: Game, defId: string, team: CombatTeam, owner: number, x: number, y: number, ov?: EntityDef): Entity {
  const d = DEFS[defId];
  if (!d) throw new Error(`unknown def: ${defId}`);
  const e: Entity = {
    id: g.nextEntityId++,
    defId, team, owner,
    ...(ov ? { defOv: ov } : {}),
    x, y, anchorX: x, anchorY: y,
    hp: (ov ?? d).maxHp,
    cooldown: 0,
    healCooldown: 0,
    targetId: -1,
    lastAttackerId: -1,
    slowedUntil: 0,
    dotUntil: 0,
    dotDps: 0,
    rootedUntil: 0,
    stunnedUntil: 0,
    skillCds: (ov ?? d).actives?.map(() => 0) ?? [],
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
    enemyPreferredUnits: cfg.enemyPreferredUnits ?? [],
    enemyUnitCaps: cfg.enemyUnitCaps ?? {},
    enemyUnitMinWave: cfg.enemyUnitMinWave ?? {},
    enemyCapsUntilWave: cfg.enemyCapsUntilWave ?? Infinity,
    enemyGuardian: cfg.enemyGuardian ?? null,
    allowedUnits: cfg.allowedUnits ?? [],
    unitBoons: cfg.unitBoons ?? [],
    mercUnits: cfg.mercUnits ?? [],
    mercCostPct: cfg.mercCostPct ?? 100,
    mercCaptureRequired: cfg.mercCaptureRequired ?? false,
    holdLineX: cfg.holdLineX ?? 0,
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
    spawnEntity(g, 'nexus', team, -1, map.nexusX[team], laneCenterY(map, map.nexusX[team]));
    spawnEntity(g, 'tower', team, -1, map.towerX[team], laneCenterY(map, map.towerX[team]));
  }
  // 영웅 특성: 시작 자금 (사람 플레이어에게만)
  if (g.heroPerks) {
    for (const p of g.players) if (!p.isBot) p.money += g.heroPerks.startMoney;
  }
  return g;
}

// ── 구매 ──────────────────────────────────────────────────────────────────

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
  if (!isMercItem && techOfUnit(d) > p.techLevel) return false; // 테크 미달 (용병은 테크 무관 — 돈이 곧 자격)
  // 캠페인 해금 제한: "사람 플레이어"만 화이트리스트 적용 (용병은 별도 허가).
  // 아군 봇(앨리스 군단 등)은 다른 종족이라 화이트리스트를 적용하면 아무것도 못 산다.
  if (!isMerc && p.team === 0 && !p.isBot && g.allowedUnits.length > 0 && !g.allowedUnits.includes(defId)) return false;
  // 캠페인: 적팀 유닛 수량 상한 (팀 합산) — 최상급 유닛의 조기 물량화 방지.
  // enemyCapsUntilWave 이후엔 전부 해제 (후반 총력전).
  const cap = p.team === 1 && g.waveIndex < g.enemyCapsUntilWave ? g.enemyUnitCaps[defId] : undefined;
  if (cap !== undefined) {
    let owned = 0;
    for (const q of g.players) if (q.team === 1) owned += q.comp[defId] ?? 0;
    if (owned >= cap) return false;
  }
  // 캠페인: 최소 등장 웨이브 — 이 턴 전엔 네임드급 유닛이 나오지 않는다
  const minWave = p.team === 1 ? g.enemyUnitMinWave[defId] : undefined;
  if (minWave !== undefined && g.waveIndex < minWave) return false;
  const cost = isMerc ? idiv(d.cost * g.mercCostPct, 100) : d.cost;
  if (p.money < cost) return false;
  p.money -= cost;
  p.comp[defId] = (p.comp[defId] ?? 0) + 1;
  return true;
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
  p.techPendingUntil = g.tick + MAP.TECH_TIME;
  return true;
}

export function buyIncomeUpgrade(g: Game, playerIdx: number): boolean {
  const p = g.players[playerIdx];
  if (!p || g.over) return false;
  if (p.incomeLevel >= g.incomeCap) return false;
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
  let baseX = m.spawnX[p.team];
  // 아군 봇 출정 위치 오버라이드 (앨리스 군단 — 위 갈래에서 내려온다)
  const allyOv = p.team === 0 && p.isBot ? g.allyDeploy : null;
  if (allyOv) baseX = allyOv.x;
  // 슬롯별 y 밴드: 팀 인원 수만큼 코리도어 폭을 나눠 고르게 배치한다.
  // (1명이면 정중앙, 3명이면 기존과 동일하게 상/중/하)
  const n = g.teamSize[p.team];
  const slotY = idiv((2 * p.slot - (n - 1)) * m.halfW, n);
  const baseY = allyOv ? allyOv.y : laneCenterY(m, baseX) + slotY;
  const dir = p.team === 0 ? -1 : 1; // 후열이 자기 진영 쪽으로

  for (let i = 0; i < list.length; i++) {
    const d = list[i]!;
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const jx = nextRange(g.rng, -150, 150);
    const jy = nextRange(g.rng, -150, 150);
    const x = clamp(baseX + dir * col * colGap + jx, 0, m.length);
    const y = clampLaneY(m, x, baseY + (row * rowGap - Math.floor(((perCol - 1) * rowGap) / 2)) + jy);
    let ov = effectiveDef(d.id, p.upgrades);
    // 캠페인 유닛 강화 (사람 플레이어의 유닛만)
    if (!p.isBot && g.unitBoons.length > 0) {
      const boon = applyBoons(ov ?? d, g.unitBoons);
      if (boon !== (ov ?? d)) ov = boon;
    }
    // 영웅 특성: 세계수의 축복 (사람 플레이어의 유닛만 강화)
    if (!p.isBot && g.heroPerks) ov = applyHeroPerks(ov ?? d, g.heroPerks);
    spawnEntity(g, d.id, p.team, p.idx, x, y, ov);
  }
}

/** 영웅 특성을 유닛 정의에 반영한 사본. */
function applyHeroPerks(base: EntityDef, perks: HeroPerks): EntityDef {
  const maxHp = perks.hpPct ? idiv(base.maxHp * (100 + perks.hpPct), 100) : base.maxHp;
  const weapon = base.weapon && perks.dmgPct
    ? { ...base.weapon, damage: idiv(base.weapon.damage * (100 + perks.dmgPct), 100) }
    : base.weapon;
  return { ...base, maxHp, ...(weapon ? { weapon } : {}) };
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
      } else if (chase || nextChance(p.botRng, brain.techSavePct)) {
        return; // 이번 틱은 유닛을 사지 않고 테크비를 모은다
      }
    }
  }

  // 2) 인컴 업그레이드. 어려움 난이도는 적 사람의 인컴을 따라간다 —
  //    추격 중인데 돈이 모자라면 유닛 구매를 참고 인컴비를 모은다.
  if (p.incomeLevel < g.incomeCap && g.tick >= p.incomeCooldownUntil) {
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
      .filter((u) => !u.campaignOnly && !p.upgrades[u.id] && u.tech <= p.techLevel);
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
    for (const p of g.players) {
      p.money += MAP.INCOME_BASE + MAP.INCOME_PER_LEVEL * p.incomeLevel;
      // 영웅 특성: 계절의 흐름 (사람 플레이어 추가 수입)
      if (!p.isBot && g.heroPerks) p.money += g.heroPerks.incomeAdd;
      // 중간 난이도: 봇은 인컴이 유저보다 12원 더 많다 (인컴업마다 +12씩 — 12, 24, 36…)
      if (p.isBot && g.botDifficulty === 'normal') p.money += 12 * (p.incomeLevel + 1);
      if (p.isBot) botDecide(g, p);
    }
  }

  // 출정 로테이션. 팀마다 인원이 다를 수 있으므로 팀별로 따로 돈다
  // (1:3 이면 1인 팀은 매 웨이브, 3인 팀은 세 명이 번갈아 출정).
  const waveTick = MAP.PREP_TICKS + g.waveIndex * MAP.WAVE_TICKS;
  if (g.tick === waveTick) {
    for (const p of g.players) {
      const joint = g.jointDeploy && p.team === 0;
      if (joint || p.slot === g.waveIndex % g.teamSize[p.team]) deployWave(g, p);
    }
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
