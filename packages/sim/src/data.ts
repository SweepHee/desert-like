import { idiv, seconds, tiles, tilesPerSecond } from './math.ts';
import type { ActiveSkill, BonusKey, EntityDef, RaceId, TeamId, Weapon } from './types.ts';

// ── 맵 상수 ────────────────────────────────────────────────────────────────
export const MAP = {
  /** FP 단위 전장 길이 (x: 0 ~ LENGTH). */
  LENGTH: tiles(96),
  /** FP 단위 레인 반폭 (y: -HALF_W ~ +HALF_W). */
  HALF_W: tiles(7),

  /** 팀별 구조물/스폰 x 좌표. 인덱스 = TeamId. */
  NEXUS_X: [tiles(4), tiles(92)] as const,
  TOWER_X: [tiles(24), tiles(72)] as const,
  SPAWN_X: [tiles(13), tiles(83)] as const,

  /** 슬롯별 스폰 y 밴드 중심. */
  SLOT_Y: [tiles(-4.5), tiles(0), tiles(4.5)] as const,

  PREP_TICKS: seconds(60),
  WAVE_TICKS: seconds(60),

  INCOME_INTERVAL: seconds(5),
  INCOME_BASE: 30,
  INCOME_PER_LEVEL: 8,
  INCOME_UPGRADE_BASE_COST: 200,
  INCOME_UPGRADE_COST_PER_LEVEL: 75,
  /** 인컴 업그레이드 최대 레벨. */
  INCOME_MAX_LEVEL: 8,
  /** 인컴 업그레이드 후 재구매 대기 시간 (틱). */
  INCOME_COOLDOWN: seconds(60),
  START_MONEY: 250,

  /**
   * 수호탑 파괴 보상: 부순 팀의 "전원"이 각각 받는다.
   * 탑을 내주고 인컴·테크만 올리는 그리드 전략의 카운터웨이트.
   */
  TOWER_BOUNTY: 350,

  /**
   * 수호자(중간보스) 격파 보상. 넥서스 보호막을 벗기는 관문이라 탑과 같은 값을 준다.
   * 관문을 뚫은 팀이 마무리 화력을 살 자금을 확보하게 하는 장치.
   */
  GUARDIAN_BOUNTY: 350,

  /** 테크 연구 소요 시간 (틱). 누른 뒤 이 시간이 지나야 해금된다. */
  TECH_TIME: seconds(60),
  /** 테크업 비용. 인덱스 = 현재 레벨 (1→2 는 [0], 2→3 은 [1]). 잠정치. */
  TECH_UP_COST: [300, 600] as const,
  TECH_MAX: 3,
} as const;

export function incomeUpgradeCost(level: number): number {
  return MAP.INCOME_UPGRADE_BASE_COST + MAP.INCOME_UPGRADE_COST_PER_LEVEL * level;
}

// ── 맵 정의 (지오메트리) ───────────────────────────────────────────────────
// 전장은 "중앙선 폴리라인 + 반폭" 코리도어다. 유닛은 중앙선을 따라 진군하고
// y 는 중앙선 ± halfW 로 제한된다. 직선 맵은 중앙선이 y=0 인 특수 케이스.

export interface MapDef {
  readonly id: string;
  readonly name: string;
  readonly length: number; // FP
  readonly halfW: number; // FP, 코리도어 반폭
  /** 중앙선 폴리라인 [x, y][] (x 오름차순, FP). 구간은 선형 보간. */
  readonly center: readonly (readonly [number, number])[];
  /**
   * 수직 가지 길 (Y자형 맵): x 고정, y0~y1 구간의 코리도어 (폭 = halfW).
   * 12시 방향처럼 메인 레인에 수직으로 붙는 길. 유닛 통행·타일 렌더 모두 인식한다.
   */
  readonly branches?: readonly { readonly x: number; readonly y0: number; readonly y1: number; readonly halfW?: number }[];
  /**
   * 좁은 입구(초크 포인트): x 구간의 레인 반폭 오버라이드.
   * 수비하기 좋은 병목 — 적이 좁은 길을 비집고 들어온다.
   */
  readonly chokes?: readonly { readonly x0: number; readonly x1: number; readonly halfW: number }[];
  readonly nexusX: readonly [number, number];
  readonly towerX: readonly [number, number];
  readonly spawnX: readonly [number, number];
}

export const MAPS: Record<string, MapDef> = {
  plains: {
    id: 'plains',
    // 1팀 쪽은 살아 있는 숲, 2팀(슬리피 할로우) 쪽은 불에 탄 숲
    name: '잿불 숲',
    length: tiles(96),
    halfW: tiles(7),
    center: [[0, 0], [tiles(96), 0]],
    nexusX: [tiles(4), tiles(92)],
    towerX: [tiles(24), tiles(72)],
    spawnX: [tiles(13), tiles(83)],
  },
  toybox: {
    id: 'toybox',
    // 마리오네타 왕국 — 장난감 나라 (캠페인 2막 전용, 지오메트리는 평원과 동일)
    name: '장난감 나라',
    length: tiles(96),
    halfW: tiles(7),
    center: [[0, 0], [tiles(96), 0]],
    nexusX: [tiles(4), tiles(92)],
    towerX: [tiles(24), tiles(72)],
    spawnX: [tiles(13), tiles(83)],
  },
  valley: {
    id: 'valley',
    name: '침강 협곡', // --_-- 형태: 중앙이 아래로 꺼진 계곡
    length: tiles(96),
    halfW: tiles(6),
    center: [
      [0, 0], [tiles(28), 0],
      [tiles(38), tiles(9)], [tiles(58), tiles(9)],
      [tiles(68), 0], [tiles(96), 0],
    ],
    nexusX: [tiles(4), tiles(92)],
    towerX: [tiles(24), tiles(72)],
    spawnX: [tiles(13), tiles(83)],
  },
  greedvalley: {
    id: 'greedvalley',
    // 캠페인 「탐욕의 계곡」: 중앙에 마몬의 상점이 있는 긴 협곡.
    // 진영에서 중앙까지 멀어 점령전이 치열해진다 (길이 128 — 표준의 1.33배).
    name: '탐욕의 계곡',
    length: tiles(128),
    halfW: tiles(6),
    center: [
      [0, 0], [tiles(40), 0],
      [tiles(52), tiles(9)], [tiles(76), tiles(9)],
      [tiles(88), 0], [tiles(128), 0],
    ],
    nexusX: [tiles(4), tiles(124)],
    towerX: [tiles(30), tiles(98)],
    spawnX: [tiles(17), tiles(111)],
  },
  nest: {
    id: 'nest',
    // 캠페인 「둥지 방어」: Y자형 맵 — 정중앙 둥지(= 내 넥서스)로 세 갈래 길이 모인다.
    // 8시(왼쪽 아래)·4시(오른쪽 아래)는 V자 메인 레인, 12시는 위로 뻗은 수직 가지.
    // 12시 가지 길이(40타일)는 중앙~4시 끝 거리와 맞먹는다.
    name: '바람의 둥지',
    length: tiles(96),
    halfW: tiles(5),
    center: [
      [0, tiles(14)], [tiles(40), tiles(3)],
      [tiles(48), 0],
      [tiles(56), tiles(3)], [tiles(96), tiles(14)],
    ],
    branches: [{ x: tiles(48), y0: tiles(-40), y1: 0, halfW: tiles(3) }],
    // 언덕 입구: 좌우 진입로가 2.2타일 폭으로 좁아진다 — 수비 병목
    chokes: [
      { x0: tiles(39), x1: tiles(44), halfW: tiles(2.2) },
      { x0: tiles(52), x1: tiles(57), halfW: tiles(2.2) },
    ],
    nexusX: [tiles(48), tiles(95)],
    towerX: [tiles(60), tiles(86)],
    spawnX: [tiles(43), tiles(91)],
  },
  confluence: {
    id: 'confluence',
    // 캠페인 12 「탐욕의 계곡 — 결전」: 두 갈래 길이 하나로 합쳐져
    // 발타르군 요새로 이어진다. 위 갈래 = 앨리스 군단, 아래 = 플레이어.
    name: '합류점',
    length: tiles(96),
    halfW: tiles(5),
    center: [
      [0, tiles(7)], [tiles(24), tiles(7)],
      [tiles(34), 0], [tiles(96), 0],
    ],
    branches: [{ x: tiles(30), y0: tiles(-16), y1: 0, halfW: tiles(4) }],
    nexusX: [tiles(5), tiles(93)],
    towerX: [tiles(40), tiles(74)],
    spawnX: [tiles(12), tiles(86)],
  },
  ashroad: {
    id: 'ashroad',
    // 캠페인 13 「세계수 뿌리 탈환」: 불탄 숲을 굽이도는 보급로.
    // 위아래로 꺾이는 산길 — 보급 마차가 5개 거점을 차례로 점령하며 전진한다.
    name: '잿길',
    length: tiles(128),
    halfW: tiles(6),
    center: [
      [0, 0], [tiles(16), 0],
      [tiles(26), tiles(-8)], [tiles(38), tiles(-8)],
      [tiles(50), tiles(7)], [tiles(62), tiles(7)],
      [tiles(74), tiles(-6)], [tiles(86), tiles(-6)],
      [tiles(98), tiles(4)], [tiles(110), tiles(4)],
      [tiles(120), 0], [tiles(128), 0],
    ],
    // 불탄 협곡 입구 — 거점 사이가 좁아져 수비·돌파 둘 다 치열해진다
    chokes: [
      { x0: tiles(42), x1: tiles(46), halfW: tiles(3) },
      { x0: tiles(90), x1: tiles(94), halfW: tiles(3) },
    ],
    nexusX: [tiles(4), tiles(124)],
    towerX: [tiles(30), tiles(104)],
    spawnX: [tiles(12), tiles(118)],
  },
};

export const DEFAULT_MAP = 'plains';

/** x 위치에서의 중앙선 y (선형 보간, 정수). */
export function laneCenterY(m: MapDef, x: number): number {
  const pts = m.center;
  if (x <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    if (x <= x1) {
      const [x0, y0] = pts[i - 1]!;
      if (x1 === x0) return y1;
      return y0 + idiv((y1 - y0) * (x - x0), x1 - x0);
    }
  }
  return pts[pts.length - 1]![1];
}

/** 맵의 세로 반높이 (중앙선 최대 이탈 + 반폭). 렌더/클램프 경계용. */
export function mapHalfH(m: MapDef): number {
  let maxAbs = 0;
  for (const [, y] of m.center) {
    const a = y < 0 ? -y : y;
    if (a > maxAbs) maxAbs = a;
  }
  for (const b of m.branches ?? []) {
    const a0 = b.y0 < 0 ? -b.y0 : b.y0;
    const a1 = b.y1 < 0 ? -b.y1 : b.y1;
    if (a0 > maxAbs) maxAbs = a0;
    if (a1 > maxAbs) maxAbs = a1;
  }
  return maxAbs + m.halfW;
}

/** 코리도어 안으로 y 클램프. */
/** x 지점의 메인 레인 반폭 — 초크 구간이면 좁아진다. */
export function laneHalfWAt(m: MapDef, x: number): number {
  for (const ck of m.chokes ?? []) {
    if (x >= ck.x0 && x <= ck.x1) return ck.halfW;
  }
  return m.halfW;
}

export function clampLaneY(m: MapDef, x: number, y: number): number {
  const c = laneCenterY(m, x);
  const hw = laneHalfWAt(m, x);
  const lo = c - hw;
  const hi = c + hw;
  const mainY = y < lo ? lo : y > hi ? hi : y;
  // 가지 길: x가 가지 폭 안이고, 가지 클램프 결과가 원래 y에 더 가깝다면 가지에 남는다
  for (const b of m.branches ?? []) {
    const bw = b.halfW ?? m.halfW;
    if (x < b.x - bw || x > b.x + bw) continue;
    const by = y < b.y0 ? b.y0 : y > b.y1 ? b.y1 : y;
    const dMain = mainY > y ? mainY - y : y - mainY;
    const dBr = by > y ? by - y : y - by;
    if (dBr < dMain) return by;
  }
  return mainY;
}

/** 티어별 요구 테크 레벨. 1 = 시작부터, 2 = 중급 테크, 3 = 고급 테크. */
export function techOfTier(tier: string): number {
  if (tier === 'basic' || tier === 'novice') return 1;
  if (tier === 'mid' || tier === 'air') return 2; // 공중 = 초중반 승부수 (대공 체크)
  return 3; // high, supreme, final
}

/** 현재 레벨에서 다음 테크업 비용. 최대 레벨이면 undefined. */
export function techUpCost(level: number): number | undefined {
  return MAP.TECH_UP_COST[level - 1];
}

/** 유닛의 실제 요구 테크 (유닛별 오버라이드 > 티어 기본값). */
export function techOfUnit(d: EntityDef): number {
  return d.techReq ?? techOfTier(d.tier);
}

// ── 유닛 정의 ──────────────────────────────────────────────────────────────
// 종족 설정 원본(v0.2): docs/races/{sylvarin,pandemonium,marionetta}.md
// ★ 척도의 수치 변환은 전부 잠정치. 패시브/액티브/업그레이드 체계는 미구현이며
// 일부 능력만 현 엔진 메커니즘(힐/둔화/스플래시/태그 보너스/방어무시/흡혈)으로
// 근사했다. 미구현 시스템에 의존하는 유닛은 로스터에서 잠정 제외:
//   - 실바린 「숲의 묘목」 (숲의 영역/장판 시스템 필요)
//   - 판데모니엄 「레이븐」 (정찰/안개 시스템 필요)

// ── 장판 효과 정의 ─────────────────────────────────────────────────────────
// 장판은 무기의 zone 필드로 생성되고, 매 스텝 범위 내 유닛에게 효과를 준다.
export const ZONE_DEFS: Record<string, {
  /** 적에게 초당 지속피해. */
  readonly dps?: number;
  /** 적 둔화 (안에 있는 동안 유지). */
  readonly slow?: boolean;
  /** 아군 생체 초당 회복 (숲의 영역). */
  readonly healBioPerSec?: number;
  /** 적을 중심으로 끌어당기는 힘 (FP/틱). 사후의 경계. */
  readonly pull?: number;
  /** true 면 공중 유닛에게도 적용된다 (기본 장판은 지상 전용). */
  readonly hitsAir?: boolean;
}> = {
  thorns: { dps: 8 },                // 가시밭 — 지속피해 전담 (둔화는 포자 구름의 몫)
  spores: { slow: true },            // 포자 구름
  balm: { slow: true, healBioPerSec: 8 }, // 치유 포자 — 적은 둔화, 아군 생체는 회복
  forest: {},                        // 숲의 영역 — 효과는 FOREST_BUFFS (유닛별)
  // 사후의 경계 — 순수 끌어당김 (딜 없음). 지상·공중 모두 빨려온다.
  grave: { pull: 90, hitsAir: true },
  blaze: { dps: 34 },                // 블레이즈 — 불구덩이, 세이지 전용 고화력 장판
  // 마법의 시전 자국 (효과 없음 — 상태이상·피해는 시전 순간 부여, 이건 그림만)
  quake: {},                         // 어스퀘이크 — 갈라진 땅
  frost: {},                         // 블리자드 — 얼어붙은 땅
  gravity: {},                       // 리버스그라비티 — 중력 마법진
  hellfire: {},                      // 지옥불 — 저주 화염 폭발
  fireburst: {},                     // 화염구 — 착탄 폭발
  // 망자의 만찬 — 넓고 오래가는 저댐 장판 (지상·공중 모두). 중복되지 않는다.
  feast: { dps: 4, hitsAir: true },
};

/** 시각 전용 장판(시전 자국)의 표시 시간 (틱). */
export const FX_ZONE_TICKS = seconds(1.4);

/**
 * 숲의 영역 안에서 실바린 유닛이 받는 유닛별 강화 (세계수의 사도 「숲의 영역」).
 * 밸런스를 크게 흔들지 않는 소폭 보너스로 유닛 정체성에 맞게 배정.
 */
export const FOREST_BUFFS: Record<string, {
  readonly speedPct?: number;
  readonly atkSpeedPct?: number;
  readonly armorAdd?: number;
  readonly regenPerSec?: number;
}> = {
  s_gouto: { speedPct: 20 },          // 들쥐 — 숲에서 날렵
  s_elf_archer: { atkSpeedPct: 15 },  // 홈그라운드 사격
  s_marmot: { armorAdd: 2 },          // 흙갑옷 보강
  s_vine_hunter: { speedPct: 25 },    // 덩굴 타기
  s_mushroom_bomber: { atkSpeedPct: 15 },
  s_druid: { regenPerSec: 4 },        // 자연 회복
  s_treekeeper: { armorAdd: 2 },
  s_thorn_witch: { atkSpeedPct: 12 },
  s_owl: { atkSpeedPct: 12 },
  s_butterfly: { speedPct: 20 },
  s_treant: { regenPerSec: 6 },
  s_apostle: { regenPerSec: 6 },
  s_wyvern: { atkSpeedPct: 15 },
  s_unicorn: { armorAdd: 1 },
  s_fairy: { atkSpeedPct: 15 },
  s_marksman: { atkSpeedPct: 12 },
  s_sage: { regenPerSec: 6 },
};

/**
 * 티어 서열 (「인형의 실」 전향 우선순위 등). 클수록 상위.
 * 구조물·수호자는 목록에 없다 = 전향 불가.
 */
export const TIER_RANK: Record<string, number> = {
  basic: 0, novice: 1, mid: 2, high: 3, air: 4, supreme: 5, final: 6,
};
/** 「인형의 실」 최소 티어 서열 — 중급(mid) 미만에게는 발동하지 않는다. */
export const CHARM_MIN_RANK = TIER_RANK.mid!;

/** 약화 상태이상: 가하는 피해 감소율(%). */
export const WEAKEN_PCT = 10;
/** 한기 상태이상: 공속·이속 감소율(%). 둔화(이속 -40/공속 -50)보다 약한 대신 확정 부여. */
export const CHILL_PCT = 20;
/** 수면 상태이상: 이 횟수만큼 피격당하면 즉시 깨어난다. */
export const SLEEP_BREAK_HITS = 3;
/**
 * 빙결(블리자드) 면제 태그. 판금 갑주·거대 생물·구조물은 얼지 않는다 —
 * 「인간/생체/가죽/천/기물/망자」를 얼린다는 원안의 여집합.
 */
export const FREEZE_IMMUNE_TAGS = ['plate', 'massive', 'structure'] as const;

const D = (def: EntityDef) => def;

export const DEFS: Record<string, EntityDef> = {};

function reg(def: EntityDef): void {
  DEFS[def.id] = def;
}

// 공용 기본값 조각
const GROUND = { flying: false } as const;

// ═══ 🌲 실바린 (sylvarin) ══ 생명·자연·장기전 ═══
// 특성: docs/combat-traits-draft.md — 장갑(cloth/leather/plate) × 존재(bio/undead/construct)
// 공격 유형별 보너스 ≈ 기본공격력의 50%. 방어력은 0~3으로 축소 (상성이 주 방어수단).

reg(D({
  id: 's_gouto', race: 'sylvarin', name: '고우토', tier: 'basic',
  cost: 45, supply: 1, maxHp: 150, armor: 1, tags: ['leather', 'bio'], ...GROUND,
  speed: tilesPerSecond(2.4), radius: tiles(0.32), acquireRange: tiles(5),
  // 참격 (발톱): 천 카운터
  weapon: { damage: 10, bonus: { cloth: 5 }, cooldown: seconds(0.8), range: tiles(0.4), targets: 'ground' },
}));
reg(D({
  // 성별 태그 없음: 스프라이트 변형이 여/남 둘 다라 개체마다 갈린다
  // (사망 음성은 render.ts 가 변형 인덱스로 판정)
  id: 's_elf_archer', race: 'sylvarin', name: '엘프 궁수', tier: 'basic',
  cost: 60, supply: 1, maxHp: 90, armor: 0, tags: ['cloth', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.9), radius: tiles(0.3), acquireRange: tiles(6),
  // 관통 (화살): 가죽 카운터. 「숲의 화살」 15% 둔화
  // 사거리 4.5 = 기본 원거리 표준 (태엽 병정과 동일 — 「긴 활」 업그레이드로만 초과)
  weapon: { damage: 10, bonus: { leather: 5 }, cooldown: seconds(1.0), range: tiles(4.5), targets: 'both', slowTicks: seconds(1.5), slowChance: 15 },
}));
reg(D({
  id: 's_marmot', race: 'sylvarin', name: '갑옷 마멋', tier: 'mid',
  cost: 130, supply: 2, maxHp: 360, armor: 2, tags: ['plate', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.5), radius: tiles(0.42), acquireRange: tiles(5),
  // 충격 (철퇴): 판금·거대 카운터 겸직. 진흙탄 대공 겸용
  weapon: { damage: 30, bonus: { plate: 22, massive: 22 }, cooldown: seconds(1.4), range: tiles(0.6), targets: 'both' },
}));
reg(D({
  id: 's_vine_hunter', race: 'sylvarin', name: '덩굴 사냥꾼', tier: 'mid',
  cost: 150, supply: 2, maxHp: 180, armor: 1, tags: ['leather', 'bio', 'female'], ...GROUND,
  speed: tilesPerSecond(3.4), radius: tiles(0.34), acquireRange: tiles(6),
  // 참격 (쌍단검): 천 카운터 — 후방 암살 정체성
  weapon: { damage: 24, bonus: { cloth: 12 }, cooldown: seconds(0.7), range: tiles(0.5), targets: 'ground' },
}));
reg(D({
  id: 's_mushroom_bomber', race: 'sylvarin', name: '버섯 폭탄병', tier: 'mid',
  cost: 170, supply: 2, maxHp: 130, armor: 0, tags: ['cloth', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.32), acquireRange: tiles(5.5),
  // 충격 (폭발): 판금 카운터. 착탄 지점에 포자 구름 장판 (안의 적 둔화)
  weapon: { damage: 26, bonus: { plate: 20 }, cooldown: seconds(2.0), range: tiles(4.5), targets: 'ground', splash: tiles(1.0), zone: { kind: 'spores', radius: tiles(1.2), ticks: seconds(3) } },
}));
reg(D({
  id: 's_druid', race: 'sylvarin', name: '드루이드', tier: 'mid',
  cost: 160, supply: 2, maxHp: 100, armor: 0, tags: ['cloth', 'bio', 'female'], ...GROUND,
  speed: tilesPerSecond(1.7), radius: tiles(0.3), acquireRange: tiles(6),
  // 마법: 판금 카운터. 「정화의 빛」(신성, 대망자)은 업그레이드
  // 생명 회복은 생체 전용 — 망자·기물은 회복 불가 (기물은 수리로만)
  heal: { amount: 14, cooldown: seconds(1.0), range: tiles(4), excludeTags: ['undead', 'construct'] },
  weapon: { damage: 10, bonus: { plate: 8 }, cooldown: seconds(1.3), range: tiles(4), targets: 'both' },
}));
reg(D({
  // 전열 탱커는 중반부터 필요하다 — high 티어지만 테크 2에 연다
  id: 's_treekeeper', race: 'sylvarin', name: '나무지기', tier: 'high', techReq: 2,
  cost: 280, supply: 3, maxHp: 800, armor: 3, tags: ['plate', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.2), radius: tiles(0.5), acquireRange: tiles(4.5),
  // 충격 (가지 강타): 판금 카운터
  weapon: { damage: 30, bonus: { plate: 22 }, cooldown: seconds(1.3), range: tiles(0.6), targets: 'ground' },
  actives: [{
    name: '뿌리박기', desc: '5초간 제자리에 뿌리내려 방어력 +3', kind: 'selfbuff',
    cooldown: seconds(12), durTicks: seconds(5), armorAdd: 3, holdGround: true,
  }],
}));
reg(D({
  id: 's_thorn_witch', race: 'sylvarin', name: '가시 마녀', tier: 'high',
  cost: 300, supply: 3, maxHp: 140, armor: 0, tags: ['cloth', 'bio', 'female'], ...GROUND,
  speed: tilesPerSecond(1.7), radius: tiles(0.3), acquireRange: tiles(6),
  // 저주 (가시): 생체 카운터. 착탄 지점에 가시밭 장판 (지속피해 + 둔화)
  // 사거리 5→ 마리오네타 원거리(4.5)가 접근 교전 가능하도록 아웃레인지 축소
  weapon: { damage: 30, bonus: { bio: 17 }, cooldown: seconds(1.6), range: tiles(5), targets: 'ground', splash: tiles(1.1), zone: { kind: 'thorns', radius: tiles(1.1), ticks: seconds(3) } },
}));
reg(D({
  id: 's_owl', race: 'sylvarin', name: '숲올빼미', tier: 'air',
  cost: 240, supply: 3, maxHp: 260, armor: 1, tags: ['leather', 'bio'], flying: true,
  speed: tilesPerSecond(3.3), radius: tiles(0.4), acquireRange: tiles(6),
  // 관통 (기수의 활): 가죽 카운터
  weapon: { damage: 26, bonus: { leather: 13 }, cooldown: seconds(1.2), range: tiles(4.5), targets: 'both' },
}));
reg(D({
  id: 's_butterfly', race: 'sylvarin', name: '거대 나비', tier: 'air',
  cost: 200, supply: 2, maxHp: 240, armor: 0, tags: ['cloth', 'bio'], flying: true,
  speed: tilesPerSecond(2.6), radius: tiles(0.42), acquireRange: tiles(5.5),
  // 순수 지원: 꽃가루 둔화 (보너스 없음)
  weapon: { damage: 8, cooldown: seconds(1.2), range: tiles(4), targets: 'both', slowTicks: seconds(2) },
}));
reg(D({
  id: 's_treant', race: 'sylvarin', name: '고대 트렌트', tier: 'supreme',
  cost: 450, supply: 5, maxHp: 1400, armor: 3, tags: ['plate', 'massive', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.0), radius: tiles(0.65), acquireRange: tiles(5),
  // 충격 (대지의 울림): 판금 카운터 + 광역
  weapon: { damage: 70, bonus: { plate: 35 }, cooldown: seconds(1.5), range: tiles(0.9), targets: 'ground', splash: tiles(1.1) },
}));
reg(D({
  // v0.5: 최종 → 최상급으로 이동 (최종은 세이지). 가지 휘둘러 공중도 때린다.
  id: 's_apostle', race: 'sylvarin', name: '세계수의 사도', tier: 'supreme',
  cost: 500, supply: 6, maxHp: 1100, armor: 3, tags: ['plate', 'massive', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.2), radius: tiles(0.7), acquireRange: tiles(6),
  // 충격 (뿌리 강타, 지상+공중) + 생체 회복 (망자·기물 제외)
  weapon: { damage: 60, bonus: { plate: 30 }, cooldown: seconds(1.5), range: tiles(2.5), targets: 'both', splash: tiles(0.9) },
  heal: { amount: 12, cooldown: seconds(1.5), range: tiles(5), excludeTags: ['undead', 'construct'] },
  // 다친 아군을 쫓지 않고 진군한다 — 숲을 몰고 전진하는 컨셉
  advancesWhileHealing: true,
  actives: [{
    // 지속 45초 = 쿨 45초 — 사도가 살아 있는 한 숲이 꺼지지 않는다
    name: '숲의 영역', desc: '사도를 따라다니는 거대한 숲 (반경 5) — 실바린이 유닛별로 강화. 사도 생존 시 상시 유지', kind: 'zone',
    cooldown: seconds(45), zoneFollows: true,
    zone: { kind: 'forest', radius: tiles(5), ticks: seconds(45) },
  }],
}));
reg(D({
  id: 's_marksman', race: 'sylvarin', name: '숲의 명궁', tier: 'supreme',
  cost: 440, supply: 5, maxHp: 240, armor: 1, tags: ['cloth', 'bio', 'female'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.34), acquireRange: tiles(9),
  // 사거리 9 = 기본 원거리 표준(4.5)의 2배. 유리몸 대공 특화 —
  // 공중 목표에는 화살이 갈라져 사거리 안 공중 적을 무조건 3기 동시 타격.
  // 지상 목표는 한 발에 하나뿐.
  weapon: { damage: 38, bonus: { leather: 18 }, cooldown: seconds(1.6), range: tiles(9), targets: 'both', airMultiTargets: 3 },
}));
reg(D({
  id: 's_sage', race: 'sylvarin', name: '세이지', tier: 'final',
  cost: 1500, supply: 7, maxHp: 620, armor: 1, tags: ['cloth', 'bio', 'male'], ...GROUND,
  speed: tilesPerSecond(1.3), radius: tiles(0.42), acquireRange: tiles(12),
  // 사거리 12 ≈ 일반 원거리(4.5)의 약 3배 — 최후방 마법 포대.
  // 평타(비전 화살)는 견제 수준이고 본체는 마법 4종.
  weapon: { damage: 24, cooldown: seconds(1.4), range: tiles(12), targets: 'both' },
  actives: [
    {
      name: '리버스그라비티', desc: '넓은 범위의 공중 유닛을 지상으로 떨어뜨림 — 12초간 지상 판정 (업그레이드 필요)', kind: 'ground',
      cooldown: seconds(25), durTicks: seconds(12), castRange: tiles(11), splash: tiles(3),
      requiresUpgrade: 'su_sage_gravity',
    },
    {
      name: '블레이즈', desc: '대상 구역을 10초간 불구덩이로 만든다 (초당 34)', kind: 'zone', targets: 'ground',
      cooldown: seconds(30), zoneAtTarget: true, castRange: tiles(11),
      zone: { kind: 'blaze', radius: tiles(1.8), ticks: seconds(10) },
    },
    {
      name: '어스퀘이크', desc: '넓은 지역에 지진 — 적 전원 10초 둔화 (업그레이드 필요)', kind: 'slowfield',
      cooldown: seconds(30), durTicks: seconds(10), castRange: tiles(11), splash: tiles(3.5),
      requiresUpgrade: 'su_sage_quake',
    },
    {
      name: '블리자드', desc: '대상 지역의 적을 6초간 빙결 — 판금·거대·구조물 면역 (업그레이드 필요)', kind: 'freeze',
      cooldown: seconds(60), durTicks: seconds(6), castRange: tiles(11), splash: tiles(2.6),
      requiresUpgrade: 'su_sage_blizzard',
    },
  ],
}));
reg(D({
  // 테크 3 전용 공중 (숲올빼미·나비는 테크 2, 얘부터는 승부처)
  id: 's_wyvern', race: 'sylvarin', name: '와이번', tier: 'air', techReq: 3,
  cost: 330, supply: 4, maxHp: 430, armor: 2, tags: ['leather', 'bio'], flying: true,
  speed: tilesPerSecond(3.0), radius: tiles(0.5), acquireRange: tiles(6),
  // 포지션: 공대지 전문. 평타는 무난하고, 내리꽂기로 지상을 쓸어담는다.
  weapon: { damage: 40, bonus: { plate: 20 }, cooldown: seconds(1.3), range: tiles(1.2), targets: 'both' },
  actives: [{
    name: '내리꽂기', desc: '솟구쳤다 지상에 내리꽂아 넓은 광역 피해 (쿨 6초, 공중엔 안 통함)', kind: 'strike',
    cooldown: seconds(6), damage: 55, splash: tiles(2.0), targets: 'ground',
  }],
}));
reg(D({
  id: 's_unicorn', race: 'sylvarin', name: '유니콘', tier: 'air', techReq: 3,
  cost: 290, supply: 3, maxHp: 380, armor: 2, tags: ['leather', 'bio'], flying: true,
  speed: tilesPerSecond(2.9), radius: tiles(0.46), acquireRange: tiles(5.5),
  // 서포터 — 버프·해제가 본체지만 자체 화력도 준수하다
  weapon: { damage: 24, cooldown: seconds(1.3), range: tiles(4.0), targets: 'both' },
  actives: [
    {
      name: '가호', desc: '주변 아군 전체 방어력 +6 (12초)', kind: 'allyarmor',
      cooldown: seconds(20), durTicks: seconds(12), armorAdd: 6, auraRadius: tiles(5.5),
    },
    {
      name: '날개짓', desc: '주변 적에게 약화 — 공격력 10% 감소 (6초)', kind: 'weaken',
      cooldown: seconds(12), durTicks: seconds(6), auraRadius: tiles(4.5),
    },
    {
      name: '큐어', desc: '주변 아군 1기의 디버프를 즉시 해제 (쿨 6초)', kind: 'cure',
      cooldown: seconds(6), auraRadius: tiles(5.5),
    },
  ],
}));
reg(D({
  id: 's_fairy', race: 'sylvarin', name: '페어리', tier: 'air', techReq: 3,
  cost: 300, supply: 3, maxHp: 200, armor: 0, tags: ['cloth', 'bio', 'female'], flying: true,
  speed: tilesPerSecond(2.2), radius: tiles(0.3), acquireRange: tiles(7),
  // 포지션: 공대공 전문. 공중 단일 화력은 최강이지만 지상·구조물에는 무력하다.
  weapon: { damage: 16, bonus: { flying: 34 }, cooldown: seconds(1.4), range: tiles(5.0), targets: 'both' },
  actives: [{
    name: '수면', desc: '적 하나를 10초간 재운다 — 3회 피격당하면 깨어난다', kind: 'sleep',
    cooldown: seconds(16), durTicks: seconds(10),
  }],
}));

// ═══ ☠️ 판데모니엄 (pandemonium) ══ 죽음·소모전 (힐러 없음) ═══

reg(D({
  id: 'p_deadman', race: 'pandemonium', name: '망자병', tier: 'basic',
  cost: 45, supply: 1, maxHp: 170, armor: 1, tags: ['leather', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(1.7), radius: tiles(0.32), acquireRange: tiles(5),
  // 참격 (녹슨 검): 천 카운터
  weapon: { damage: 13, bonus: { cloth: 6 }, cooldown: seconds(1.0), range: tiles(0.4), targets: 'ground', lifestealPct: 10 },
}));
reg(D({
  id: 'p_skeleton', race: 'pandemonium', name: '스켈레톤', tier: 'basic',
  cost: 70, supply: 1, maxHp: 130, armor: 2, tags: ['leather', 'undead'], ...GROUND,
  speed: tilesPerSecond(2.6), radius: tiles(0.32), acquireRange: tiles(5.5),
  // 참격 (뼈검): 천 카운터. 「톱날 뼈」 업그레이드로 판금 카운터 전환
  weapon: { damage: 16, bonus: { cloth: 8 }, cooldown: seconds(0.8), range: tiles(0.4), targets: 'ground', lifestealPct: 15 },
}));
reg(D({
  id: 'p_hound', race: 'pandemonium', name: '시체 사냥개', tier: 'novice',
  cost: 100, supply: 1, maxHp: 160, armor: 1, tags: ['leather', 'undead'], ...GROUND,
  speed: tilesPerSecond(3.5), radius: tiles(0.36), acquireRange: tiles(6),
  // 관통 (이빨): 가죽 카운터
  weapon: { damage: 17, bonus: { leather: 8 }, cooldown: seconds(0.9), range: tiles(0.5), targets: 'ground', lifestealPct: 12 },
}));
reg(D({
  id: 'p_bone_thrower', race: 'pandemonium', name: '해골 투척병', tier: 'novice',
  cost: 110, supply: 1, maxHp: 100, armor: 0, tags: ['cloth', 'undead'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.3), acquireRange: tiles(5.5),
  // 관통 (뼈 화살): 가죽 카운터 (구 방어무시는 관통 보너스로 통합)
  // 관통 (뼈 투척): 가죽 카운터 + 인형 관절 파괴 (대기물)
  weapon: { damage: 15, bonus: { leather: 7, construct: 12 }, cooldown: seconds(1.1), range: tiles(4.5), targets: 'both' },
}));
reg(D({
  id: 'p_headless_knight', race: 'pandemonium', name: '목없는 기사', tier: 'mid',
  cost: 190, supply: 2, maxHp: 420, armor: 2, tags: ['plate', 'undead'], ...GROUND,
  speed: tilesPerSecond(2.5), radius: tiles(0.44), acquireRange: tiles(6),
  // 참격 (대검): 천 카운터 — 후방 학살 기병
  weapon: { damage: 36, bonus: { cloth: 18 }, cooldown: seconds(1.0), range: tiles(0.6), targets: 'ground', lifestealPct: 15 },
  actives: [{
    name: '참수', desc: '체력 40% 이하의 적에게 강력한 일격', kind: 'strike',
    cooldown: seconds(12), damage: 50, executeBelowPct: 40, executeBonus: 70,
  }],
}));
reg(D({
  id: 'p_corpsecaller', race: 'pandemonium', name: '시체술사', tier: 'mid',
  cost: 210, supply: 3, maxHp: 110, armor: 0, tags: ['cloth', 'undead'], ...GROUND,
  speed: tilesPerSecond(1.6), radius: tiles(0.3), acquireRange: tiles(6),
  // 저주 (암흑): 생체 카운터 — 실바린 견제 핵심
  // 저주 폭발: 착탄 지점 소범위 광역 — 수리 뭉침(마리오네타 힐 군단) 카운터
  weapon: { damage: 28, bonus: { bio: 14, construct: 24 }, cooldown: seconds(1.7), range: tiles(5.5), targets: 'both', splash: tiles(0.8) },
}));
reg(D({
  id: 'p_banshee', race: 'pandemonium', name: '밴시', tier: 'air', techReq: 3,
  cost: 300, supply: 3, maxHp: 220, armor: 0, tags: ['cloth', 'undead', 'female'], flying: true,
  speed: tilesPerSecond(2.6), radius: tiles(0.36), acquireRange: tiles(5.5),
  // 저주 (절규): 생체 카운터 + 단일 대상 둔화 (테크 3 공중)
  // 광역이던 시절엔 같은 값 물량을 일방적으로 쓸어버려서 단일 대상으로 되돌렸다.
  weapon: { damage: 20, bonus: { bio: 10 }, cooldown: seconds(1.3), range: tiles(4.5), targets: 'both', slowTicks: seconds(3) },
}));
reg(D({
  id: 'p_thanatos', race: 'pandemonium', name: '타나토스', tier: 'high',
  cost: 380, supply: 5, maxHp: 460, armor: 2, tags: ['plate', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(2.0), radius: tiles(0.5), acquireRange: tiles(6),
  // 참격 (불타는 낫): 천 카운터 + 거대 처형자
  weapon: { damage: 64, bonus: { cloth: 32, massive: 48 }, cooldown: seconds(1.4), range: tiles(1.2), targets: 'ground', splash: tiles(1.0) },
  actives: [{
    name: '사신의 낫', desc: '체력 35% 이하의 적 주변을 낫으로 쓸어 광역 처형', kind: 'strike',
    cooldown: seconds(14), damage: 55, splash: tiles(1.4), executeBelowPct: 35, executeBonus: 55,
  }],
}));
reg(D({
  id: 'p_corpse_golem', race: 'pandemonium', name: '시체 골렘', tier: 'high',
  cost: 300, supply: 4, maxHp: 850, armor: 3, tags: ['plate', 'undead'], ...GROUND,
  speed: tilesPerSecond(1.1), radius: tiles(0.55), acquireRange: tiles(4.5),
  // 충격 (주먹): 판금 카운터 + 흡혈
  weapon: { damage: 30, bonus: { plate: 22 }, cooldown: seconds(1.4), range: tiles(0.7), targets: 'ground', lifestealPct: 35 },
}));
reg(D({
  id: 'p_wraith', race: 'pandemonium', name: '망령', tier: 'air',
  cost: 220, supply: 2, maxHp: 240, armor: 0, tags: ['cloth', 'undead'], flying: true,
  speed: tilesPerSecond(3.0), radius: tiles(0.4), acquireRange: tiles(6),
  // 마법 (영혼 접촉): 판금 카운터 — 값싼 공중 대탱커
  weapon: { damage: 24, bonus: { plate: 18 }, cooldown: seconds(1.2), range: tiles(1.0), targets: 'both' },
}));
// ── 소환물 (상점에 없음. 스켈레톤 소환사가 무작위로 불러낸다) ──────────────
// 전부 총알받이 수준. 값이 없으므로 cost 0, 테크 무관.
reg(D({
  id: 'p_minion_ghoul', race: 'pandemonium', name: '구울', tier: 'basic', summonOnly: true,
  cost: 0, supply: 0, maxHp: 55, armor: 0, tags: ['cloth', 'undead'], ...GROUND,
  speed: tilesPerSecond(1.9), radius: tiles(0.3), acquireRange: tiles(4),
  // 느리게 할퀴지만 50% 확률로 독을 남긴다
  weapon: {
    damage: 9, cooldown: seconds(1.9), range: tiles(0.4), targets: 'ground',
    dotDps: 6, dotTicks: seconds(3), dotChance: 50,
  },
}));
reg(D({
  id: 'p_minion_undead', race: 'pandemonium', name: '언데드', tier: 'basic', summonOnly: true,
  cost: 0, supply: 0, maxHp: 90, armor: 0, tags: ['cloth', 'undead'], ...GROUND,
  speed: tilesPerSecond(2.0), radius: tiles(0.3), acquireRange: tiles(4),
  // 특별할 것 없는 표준형
  weapon: { damage: 11, cooldown: seconds(1.2), range: tiles(0.4), targets: 'ground' },
}));
reg(D({
  id: 'p_minion_skeleton', race: 'pandemonium', name: '하급 스켈레톤', tier: 'basic', summonOnly: true,
  cost: 0, supply: 0, maxHp: 130, armor: 1, tags: ['leather', 'undead'], ...GROUND,
  speed: tilesPerSecond(1.9), radius: tiles(0.32), acquireRange: tiles(4),
  // 소환물 중 제일 단단하지만 공격은 약하다
  weapon: { damage: 7, cooldown: seconds(1.2), range: tiles(0.4), targets: 'ground' },
}));
reg(D({
  id: 'p_minion_rat', race: 'pandemonium', name: '시궁창쥐', tier: 'basic', summonOnly: true,
  cost: 0, supply: 0, maxHp: 45, armor: 0, tags: ['cloth', 'bio'], ...GROUND,
  speed: tilesPerSecond(2.8), radius: tiles(0.26), acquireRange: tiles(4),
  // 무는 힘은 세지만 종잇장. 물어뜯을 때 주변까지 튄다
  weapon: { damage: 18, cooldown: seconds(1.1), range: tiles(0.35), targets: 'ground', splash: tiles(0.5) },
}));

reg(D({
  // 자체 공격이 0이라 값은 싸게. 가치가 시간에 걸쳐 쌓이는 유닛이다.
  id: 'p_summoner', race: 'pandemonium', name: '스켈레톤 소환사', tier: 'mid',
  cost: 150, supply: 2, maxHp: 170, armor: 0, tags: ['cloth', 'undead'], ...GROUND,
  speed: tilesPerSecond(1.7), radius: tiles(0.32), acquireRange: tiles(6),
  // 자체 공격력 없음 — 오로지 소환으로만 싸운다
  actives: [{
    name: '망자 소환', desc: '20초마다 잡졸 2기를 무작위로 불러낸다 (구울·언데드·하급 스켈레톤·시궁창쥐)',
    kind: 'summon', cooldown: seconds(20), summonCount: 2,
    summonIds: ['p_minion_ghoul', 'p_minion_undead', 'p_minion_skeleton', 'p_minion_rat'],
  }],
}));

reg(D({
  id: 'p_lich', race: 'pandemonium', name: '리치', tier: 'mid',
  cost: 260, supply: 3, maxHp: 210, armor: 0, tags: ['cloth', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(1.6), radius: tiles(0.34), acquireRange: tiles(6),
  // 평타는 약하고 마법으로 싸운다
  weapon: { damage: 8, cooldown: seconds(1.5), range: tiles(4.5), targets: 'both' },
  actives: [
    {
      name: '지옥불', desc: '범위 마법 — 주변 적을 한꺼번에 태운다', kind: 'nuke',
      cooldown: seconds(11), damage: 30, splash: tiles(1.5), castRange: tiles(5), fxZone: 'hellfire',
    },
    {
      name: '화염구', desc: '단일 마법 — 체력이 가장 많은 적을 노린다', kind: 'nuke',
      cooldown: seconds(9), damage: 50, castRange: tiles(5), targetMode: 'highestHp', fxZone: 'fireburst',
    },
  ],
}));

reg(D({
  // v0.5: 고급 → 최상급 승격 (판데모니엄의 공중 하이엔드)
  id: 'p_demilich', race: 'pandemonium', name: '데미리치', tier: 'supreme',
  cost: 520, supply: 5, maxHp: 540, armor: 2, tags: ['cloth', 'undead'], flying: true,
  speed: tilesPerSecond(2.2), radius: tiles(0.46), acquireRange: tiles(6),
  // 대공 광역 마법 딜러: 공중 타겟을 때리면 주변 공중까지 함께 태운다.
  // 지상엔 단일 타격 — 공중 물량(올빼미·페니와이즈류)의 명확한 카운터.
  weapon: {
    damage: 38, bonus: { bio: 19 }, cooldown: seconds(1.2), range: tiles(4.5), targets: 'both',
    splash: tiles(1.4), splashAirOnly: true,
  },
  actives: [
    {
      // 넓게 오래 깔리지만 딜은 얕은 장판 — 겹쳐 깔아도 중복되지 않는다 (병합)
      name: '망자의 만찬', desc: '반경 5타일에 12초간 죽음의 안개 — 첫 피해 10, 이후 초당 4 (지상·공중 모두)',
      kind: 'zone', cooldown: seconds(30), damage: 10, splash: tiles(5), castRange: tiles(6),
      zoneAtTarget: true, zone: { kind: 'feast', radius: tiles(5), ticks: seconds(12) },
    },
    {
      name: '사후의 경계', desc: '반경 4타일의 적을 5초간 중앙으로 끌어당긴다 (피해 없음, 지상·공중 모두)',
      kind: 'zone', cooldown: seconds(60), zone: { kind: 'grave', radius: tiles(4), ticks: seconds(5) },
    },
  ],
}));

reg(D({
  id: 'p_mammon', race: 'pandemonium', name: '마몬', tier: 'supreme',
  cost: 570, supply: 7, maxHp: 1150, armor: 3, tags: ['plate', 'massive', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(1.4), radius: tiles(0.7), acquireRange: tiles(6),
  // 충격 (대검 강타): 판금 카운터 + 흡혈 광역
  weapon: { damage: 72, bonus: { plate: 36 }, cooldown: seconds(1.3), range: tiles(0.9), targets: 'ground', splash: tiles(0.9), lifestealPct: 30 },
  actives: [
    {
      name: '군세강화', desc: '주변 아군 전체 공속 +10% (8초, 중복 불가)', kind: 'allybuff',
      cooldown: seconds(45), durTicks: seconds(8), atkSpeedPct: 10, auraRadius: tiles(5),
    },
    {
      name: '인비저블', desc: '4초간 모든 피해를 받지 않음', kind: 'invuln',
      cooldown: seconds(30), durTicks: seconds(4),
    },
  ],
}));

// ── 판데모니엄 확장 로스터 (v1.1) ─────────────────────────────────────────
reg(D({
  // 밴시와 데미리치 사이의 강함 — 딜러+탱커+서포터를 겸하는 공중 만능형
  id: 'p_bone_dragon', race: 'pandemonium', name: '본드래곤', tier: 'supreme',
  cost: 520, supply: 5, maxHp: 680, armor: 2, tags: ['plate', 'massive', 'undead'], flying: true,
  speed: tilesPerSecond(2.4), radius: tiles(0.62), acquireRange: tiles(6),
  // 뼈 브레스: 소범위 광역 + 입힌 피해의 30% 흡혈
  weapon: { damage: 40, cooldown: seconds(1.3), range: tiles(1.4), targets: 'both', splash: tiles(1.1), lifestealPct: 25 },
}));
reg(D({
  // 후방 암살자: 힐러·원거리에게 관짝째 도약해 달려든다 (도약 중 무적)
  id: 'p_coffin_bearer', race: 'pandemonium', name: '관짝지기', tier: 'high',
  cost: 340, supply: 3, maxHp: 430, armor: 2, tags: ['leather', 'undead'], ...GROUND,
  speed: tilesPerSecond(2.3), radius: tiles(0.4), acquireRange: tiles(5.5),
  weapon: { damage: 46, bonus: { cloth: 20 }, cooldown: seconds(1.0), range: tiles(0.6), targets: 'ground' },
  actives: [{
    name: '관짝 강습', desc: '후방의 힐러·원거리에게 도약 (사거리 5, 도약 중 무적)', kind: 'leap',
    cooldown: seconds(12), castRange: tiles(5),
  }],
}));
reg(D({
  // CC 마법사: 딜은 미미하지만 매혹·몽마로 전선을 뒤흔든다. 공격은 하트가 날아간다
  id: 'p_succubus', race: 'pandemonium', name: '서큐버스', tier: 'high',
  cost: 380, supply: 3, maxHp: 250, armor: 0, tags: ['cloth', 'undead', 'female'], ...GROUND,
  speed: tilesPerSecond(1.9), radius: tiles(0.36), acquireRange: tiles(5.5),
  weapon: { damage: 8, cooldown: seconds(1.1), range: tiles(5), targets: 'both' },
  actives: [
    {
      name: '매혹', desc: '적 하나를 8초간 홀린다 (30%) — 싸움을 잊고 적진으로 걸어간다', kind: 'seduce',
      cooldown: seconds(9), durTicks: seconds(8), castRange: tiles(6), chancePct: 30,
    },
    {
      name: '몽마 소환', desc: '꿈의 마수를 부른다 (서큐버스당 1마리 — 재소환 시 이전 몽마는 흩어진다)', kind: 'summonMare',
      cooldown: seconds(45),
    },
  ],
}));
reg(D({
  // 서큐버스의 소환수: 잠을 부르는 꿈의 마수. 매혹당한 제물에게서 생기를 빨아들인다
  id: 'p_dream_mare', race: 'pandemonium', name: '몽마', tier: 'mid', summonOnly: true,
  cost: 0, supply: 0, maxHp: 280, armor: 1, tags: ['cloth', 'undead'], flying: true,
  speed: tilesPerSecond(2.8), radius: tiles(0.4), acquireRange: tiles(5),
  weapon: { damage: 34, cooldown: seconds(1.0), range: tiles(0.8), targets: 'both' },
  actives: [{
    name: '자장가', desc: '목표를 6초간 재운다 (3회 피격 시 해제)', kind: 'sleep',
    cooldown: seconds(8), durTicks: seconds(6),
  }],
}));
reg(D({
  // 최종 유닛: 한손검의 귀공자. 은신과 완전 해제로 죽지 않고, 해금 스킬로 군세를 부린다
  id: 'p_incubus', race: 'pandemonium', name: '인큐버스', tier: 'final',
  cost: 1500, supply: 8, maxHp: 950, armor: 3, tags: ['leather', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(2.0), radius: tiles(0.45), acquireRange: tiles(6),
  // 검기가 하늘까지 닿는다 — 공중도 벤다
  weapon: { damage: 95, cooldown: seconds(0.9), range: tiles(0.7), targets: 'both' },
  actives: [
    {
      name: '은신', desc: '6초간 완전히 사라진다 — 조준·피해 불가 (쿨 18초)', kind: 'stealth',
      cooldown: seconds(18), durTicks: seconds(6),
    },
    {
      name: '완전 해제', desc: '상태이상에 걸리면 즉시 해제 + 20초 면역 (자동, 쿨 30초)', kind: 'purge',
      cooldown: seconds(30), durTicks: seconds(20),
    },
    {
      name: '군세 소환', desc: '판데모니엄 군세를 부른다 — 밴시 12·시체 골렘 5·타나토스 3·데미리치 1·마몬 1 (업그레이드 필요)', kind: 'legion',
      cooldown: seconds(60), requiresUpgrade: 'pu_incubus_legion',
      legion: [
        { id: 'p_banshee', n: 12 }, { id: 'p_corpse_golem', n: 5 },
        { id: 'p_thanatos', n: 3 }, { id: 'p_demilich', n: 1 }, { id: 'p_mammon', n: 1 },
      ],
    },
    {
      name: '제물 흡수', desc: '7초마다 내 1티어 유닛(소환수 포함)을 삼켜 강해진다 — 스택당 공격 +10%·방어 +2, 최대 10 (업그레이드 필요)', kind: 'sacrifice',
      cooldown: seconds(7), auraRadius: tiles(3), requiresUpgrade: 'pu_incubus_sacrifice',
    },
  ],
}));

// ═══ 🧸 마리오네타 (marionetta) ══ 인형·실·호러·순간폭발 ═══
// 유령(캐스퍼·스펙터 테디)은 망자, 앨리스는 유일한 생체, 나머지는 기물

reg(D({
  id: 'm_plushbear', race: 'marionetta', name: '봉제곰', tier: 'basic',
  cost: 50, supply: 1, maxHp: 200, armor: 1, tags: ['cloth', 'construct'], ...GROUND,
  speed: tilesPerSecond(1.6), radius: tiles(0.36), acquireRange: tiles(5),
  // 충격 (솜주먹+이빨): 판금 카운터 + 물어뜯기 (대생체) — 봉제 = 천 장갑
  weapon: { damage: 12, bonus: { plate: 9, bio: 5 }, cooldown: seconds(1.1), range: tiles(0.4), targets: 'ground' },
}));
reg(D({
  id: 'm_clockwork_soldier', race: 'marionetta', name: '태엽 병정', tier: 'basic',
  cost: 60, supply: 1, maxHp: 90, armor: 1, tags: ['plate', 'construct', 'male'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.3), acquireRange: tiles(6),
  // 관통 (탄환): 가죽 카운터 + 사냥탄 (대생체) — 양철 = 판금
  weapon: { damage: 10, bonus: { leather: 5, bio: 4 }, cooldown: seconds(0.9), range: tiles(4.5), targets: 'both' },
  actives: [{
    // v0.9: 기본 스킬에서 제외 — 테크 2 업그레이드로 해금
    name: '태엽 감기', desc: '4초간 공속·이속 +40%, 종료 후 1.5초 과열(둔화) (업그레이드 필요)', kind: 'selfbuff',
    cooldown: seconds(15), durTicks: seconds(4), atkSpeedPct: 40, speedPct: 40, overheatSlowTicks: seconds(1.5),
    requiresUpgrade: 'mu_soldier_windup',
  }],
}));
reg(D({
  id: 'm_button_doll', race: 'marionetta', name: '단추 인형', tier: 'basic',
  cost: 80, supply: 1, maxHp: 90, armor: 0, tags: ['cloth', 'construct', 'female'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.3), acquireRange: tiles(6),
  // 「긴급 봉합」 (수리 — 망자는 수리 불가)
  heal: { amount: 8, cooldown: seconds(1.2), range: tiles(3.5), excludeTags: ['undead'] },
}));
reg(D({
  id: 'm_puppet_swordsman', race: 'marionetta', name: '꼭두각시 검사', tier: 'novice',
  cost: 120, supply: 2, maxHp: 240, armor: 2, tags: ['leather', 'construct'], ...GROUND,
  speed: tilesPerSecond(2.8), radius: tiles(0.36), acquireRange: tiles(5.5),
  // 참격 (목검): 천 카운터 — 목재 = 가죽 취급
  weapon: { damage: 22, bonus: { cloth: 11, bio: 8 }, cooldown: seconds(0.8), range: tiles(0.5), targets: 'ground' },
}));
reg(D({
  id: 'm_clockwork_spider', race: 'marionetta', name: '태엽 거미', tier: 'mid',
  cost: 170, supply: 2, maxHp: 220, armor: 2, tags: ['plate', 'construct'], ...GROUND,
  speed: tilesPerSecond(2.4), radius: tiles(0.38), acquireRange: tiles(5),
  // 「포획 실」: 35% 확률로 1.2초 속박 (이동 불가)
  weapon: { damage: 20, cooldown: seconds(1.1), range: tiles(1.5), targets: 'ground', rootTicks: seconds(1.2), rootChance: 35 },
}));
reg(D({
  id: 'm_clown_doll', race: 'marionetta', name: '광대 인형', tier: 'mid',
  cost: 190, supply: 2, maxHp: 300, armor: 1, tags: ['cloth', 'construct', 'male'], ...GROUND,
  speed: tilesPerSecond(2.0), radius: tiles(0.4), acquireRange: tiles(5),
  // 충격 (대형 망치): 판금·거대 카운터 겸직 + 광역
  weapon: { damage: 32, bonus: { plate: 24, massive: 24 }, cooldown: seconds(1.4), range: tiles(0.7), targets: 'ground', splash: tiles(1.1) },
  actives: [{
    // 근접 광역 딜러가 붙기도 전에 녹는 문제 — 접근하는 동안 버티는 철판
    name: '풍선 갑옷', desc: '6초간 방어력 +10 (교전 시 자동 발동)', kind: 'selfbuff',
    cooldown: seconds(15), durTicks: seconds(6), armorAdd: 10,
  }],
}));
reg(D({
  id: 'm_cursed_doll', race: 'marionetta', name: '저주받은 인형', tier: 'high',
  cost: 290, supply: 3, maxHp: 260, armor: 1, tags: ['leather', 'construct', 'male'], ...GROUND,
  speed: tilesPerSecond(3.3), radius: tiles(0.34), acquireRange: tiles(6),
  // 참격 (식칼): 천 카운터 — 유리몸 후방 학살
  weapon: { damage: 34, bonus: { cloth: 17, bio: 18 }, cooldown: seconds(0.8), range: tiles(0.5), targets: 'ground' },
}));
reg(D({
  // 유령이니 원래부터 떠다니는 게 자연스럽다 → 2테크 공중으로 이동.
  // 티어를 내린 만큼 체력·화력을 낮추고, 대신 값을 싸게 해 초중반 승부수로.
  id: 'm_casper', race: 'marionetta', name: '캐스퍼', tier: 'air',
  cost: 210, supply: 2, maxHp: 150, armor: 0, tags: ['cloth', 'undead'], flying: true,
  speed: tilesPerSecond(3.2), radius: tiles(0.34), acquireRange: tiles(5.5),
  // 저주 (유령 장난): 생체 카운터 — 유령이므로 망자 (정화에 맞는다)
  weapon: { damage: 17, bonus: { bio: 17 }, cooldown: seconds(1.0), range: tiles(3.5), targets: 'both', slowTicks: seconds(1.5), slowChance: 30 },
}));
reg(D({
  id: 'm_puppet_ann', race: 'marionetta', name: '꼭두각시 앤', tier: 'air',
  cost: 300, supply: 3, maxHp: 220, armor: 0, tags: ['cloth', 'construct', 'female'], flying: true,
  speed: tilesPerSecond(2.8), radius: tiles(0.42), acquireRange: tiles(6),
  // 마법 (실): 판금 카운터 + 둔화
  weapon: { damage: 26, bonus: { plate: 20 }, cooldown: seconds(1.2), range: tiles(4.5), targets: 'both', slowTicks: seconds(2) },
}));
reg(D({
  id: 'm_specter_teddy', race: 'marionetta', name: '스펙터 테디', tier: 'air',
  cost: 230, supply: 2, maxHp: 280, armor: 1, tags: ['cloth', 'undead'], flying: true,
  speed: tilesPerSecond(2.4), radius: tiles(0.42), acquireRange: tiles(5.5),
  // 순수 지원: 몽마의 포옹 (강한 둔화, 보너스 없음) — 유령이므로 망자
  weapon: { damage: 8, cooldown: seconds(1.2), range: tiles(4), targets: 'both', slowTicks: seconds(3) },
}));
reg(D({
  // 지상 원거리 광역 포대 — 시계추를 쾅쾅 떨어뜨린다
  id: 'm_grandfather_clock', race: 'marionetta', name: '괘종시계', tier: 'high',
  cost: 320, supply: 3, maxHp: 560, armor: 2, tags: ['plate', 'construct'], ...GROUND,
  speed: tilesPerSecond(1.3), radius: tiles(0.5), acquireRange: tiles(5.5),
  // 충격 (낙하하는 시계추): 판금 카운터 + 광역. 느리지만 한 방이 넓고 아프다
  weapon: { damage: 44, bonus: { plate: 22 }, cooldown: seconds(2.2), range: tiles(5), targets: 'ground', splash: tiles(1.3) },
}));
reg(D({
  // 풍선에 매달려 나는 살인 광대 — 공중 스플래시 (단일딜은 약함)
  id: 'm_pennywise', race: 'marionetta', name: '페니와이즈', tier: 'air', techReq: 3,
  cost: 300, supply: 3, maxHp: 310, armor: 1, tags: ['cloth', 'construct'], flying: true,
  speed: tilesPerSecond(2.5), radius: tiles(0.45), acquireRange: tiles(5.5),
  // 터지는 풍선: 공중을 때리면 주변 공중까지 함께 터진다(대공 광역).
  // 지상에는 단일 타격 — 대공 요격기 포지션이 분명해진다.
  weapon: {
    damage: 16, cooldown: seconds(1.1), range: tiles(3.5), targets: 'both',
    splash: tiles(1.1), splashAirOnly: true,
  },
}));
reg(D({
  // 떠다니는 실뭉치 — 초장거리 바늘 공성 (공중은 못 찌른다)
  id: 'm_thread_needle', race: 'marionetta', name: '실과 바늘', tier: 'air', techReq: 3,
  cost: 320, supply: 3, maxHp: 190, armor: 0, tags: ['cloth', 'construct'], flying: true,
  speed: tilesPerSecond(2.0), radius: tiles(0.34), acquireRange: tiles(13.5),
  // 사거리 13.5 = 기본 원거리(4.5)의 3배 — 실바린 세이지(12)보다도 긴 최장거리 공성
  weapon: { damage: 30, bonus: { structure: 24, plate: 10 }, cooldown: seconds(1.8), range: tiles(13.5), targets: 'ground' },
}));
reg(D({
  // 시계탑의 심장 — 지상+공중 원거리 + 「자정의 종소리」 광역 공포
  id: 'm_clocktower_gear', race: 'marionetta', name: '시계탑 톱니바퀴', tier: 'supreme',
  cost: 480, supply: 5, maxHp: 1150, armor: 3, tags: ['plate', 'construct'], ...GROUND,
  speed: tilesPerSecond(1.2), radius: tiles(0.55), acquireRange: tiles(6),
  // 사거리 5.5 = 기본 원거리(4.5) 아웃레인지 — 공포로 쫓아낸 적의 등에 딜을 넣는다.
  // 톱니 파편 소범위 광역 — 유틸(공포)만으로는 최상급 몸값이 안 나온다
  weapon: { damage: 58, bonus: { plate: 26 }, cooldown: seconds(1.3), range: tiles(5.5), targets: 'both', splash: tiles(0.9) },
  actives: [{
    name: '자정의 종소리', desc: '적 원거리 유닛 최우선으로 넓은 지역에 공포 — 6초간 달아남, 최대 6기 (쿨 25초)', kind: 'fear',
    maxTargets: 6,
    cooldown: seconds(25), durTicks: seconds(6), castRange: tiles(5.5), splash: tiles(2.5),
  }],
}));
reg(D({
  id: 'm_gore_teddy', race: 'marionetta', name: '고어 테디', tier: 'supreme',
  cost: 460, supply: 5, maxHp: 1300, armor: 3, tags: ['leather', 'massive', 'construct'], ...GROUND,
  speed: tilesPerSecond(1.0), radius: tiles(0.65), acquireRange: tiles(5),
  // 충격 (찢어진 포옹): 판금 카운터 + 소범위 광역 — 끌어안아 주변까지 찢는다.
  // 단일 공격력이 최상급 중 가장 높아(80) 반경은 좁게 잡았다.
  weapon: { damage: 80, bonus: { plate: 40 }, cooldown: seconds(1.4), range: tiles(0.8), targets: 'ground', splash: tiles(0.9) },
  actives: [
    {
      name: '도발', desc: '주변 적이 5초간 나를 우선 공격 (아군 대신 맞아준다)', kind: 'taunt',
      cooldown: seconds(18), durTicks: seconds(5), auraRadius: tiles(4.5),
    },
    {
      name: '가시 봉제', desc: '5초간 받은 평타 피해의 50%를 반사 (마법은 반사 안 됨)', kind: 'reflect',
      cooldown: seconds(30), durTicks: seconds(5), reflectPct: 50,
    },
  ],
}));
reg(D({
  id: 'm_alice', race: 'marionetta', name: '인형사 앨리스', tier: 'final',
  cost: 1350, supply: 7, maxHp: 950, armor: 2, tags: ['cloth', 'bio', 'female'], ...GROUND,
  speed: tilesPerSecond(1.6), radius: tiles(0.42), acquireRange: tiles(6),
  // 마법 (조종 실): 판금 카운터 + 둔화 + 수리. 유일한 인간 (생체!)
  weapon: { damage: 52, bonus: { plate: 26 }, cooldown: seconds(1.2), range: tiles(5.5), targets: 'both', slowTicks: seconds(1.5) },
  heal: { amount: 16, cooldown: seconds(1.2), range: tiles(5), excludeTags: ['undead'] },
  actives: [
    {
      name: '봉제곰 소환', desc: '전투 중 봉제곰 3기를 소환', kind: 'summon',
      cooldown: seconds(10), summonId: 'm_plushbear', summonCount: 3,
    },
    {
      name: '혼란', desc: '범위 안 적들이 5초간 적아를 잃고 자기 편을 공격', kind: 'confuse',
      cooldown: seconds(30), durTicks: seconds(5), splash: tiles(2),
    },
    {
      name: '인형의 실', desc: '적 중급 이상 유닛 하나를 영구히 아군으로 — 티어 높은 순 우선 (업그레이드 필요)', kind: 'charm',
      cooldown: seconds(45), castRange: tiles(6), requiresUpgrade: 'mu_alice_charm',
    },
  ],
}));

// ── 마몬의 용병 (캠페인 「탐욕의 계곡」 상점 판매 품목) ──────────────────
// 원본 판데모니엄 유닛의 복제 — 독립 유닛이라 스펙을 따로 조정할 수 있다.
// summonOnly: 대전 상점·봇 자연 생산에는 절대 노출되지 않는다.
reg(D({
  id: 'merc_headless_knight', race: 'pandemonium', name: '마몬의 목없는 기사', tier: 'mid', summonOnly: true,
  // 원본(190)보다 10% 저렴 — 점령한 쪽의 확실한 이득 (적도 원본 대신 이걸 사면 이득)
  cost: 171, supply: 2, maxHp: 420, armor: 2, tags: ['plate', 'undead'], ...GROUND,
  speed: tilesPerSecond(2.5), radius: tiles(0.44), acquireRange: tiles(6),
  weapon: { damage: 36, bonus: { cloth: 18 }, cooldown: seconds(1.0), range: tiles(0.6), targets: 'ground', lifestealPct: 15 },
  actives: [{
    name: '참수', desc: '체력 40% 이하의 적에게 강력한 일격', kind: 'strike',
    cooldown: seconds(12), damage: 50, executeBelowPct: 40, executeBonus: 70,
  }],
}));
reg(D({
  id: 'merc_lich', race: 'pandemonium', name: '마몬의 리치', tier: 'mid', summonOnly: true,
  // 원본(260) -10%
  cost: 234, supply: 3, maxHp: 210, armor: 0, tags: ['cloth', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(1.6), radius: tiles(0.34), acquireRange: tiles(6),
  weapon: { damage: 8, cooldown: seconds(1.5), range: tiles(4.5), targets: 'both' },
  actives: [
    {
      name: '지옥불', desc: '범위 마법 — 주변 적을 한꺼번에 태운다', kind: 'nuke',
      cooldown: seconds(11), damage: 30, splash: tiles(1.5), castRange: tiles(5), fxZone: 'hellfire',
    },
    {
      name: '화염구', desc: '단일 마법 — 체력이 가장 많은 적을 노린다', kind: 'nuke',
      cooldown: seconds(9), damage: 50, castRange: tiles(5), targetMode: 'highestHp', fxZone: 'fireburst',
    },
  ],
}));
reg(D({
  id: 'merc_thanatos', race: 'pandemonium', name: '마몬의 타나토스', tier: 'high', summonOnly: true,
  // 원본(380) -10%
  cost: 342, supply: 5, maxHp: 460, armor: 2, tags: ['plate', 'undead', 'male'], ...GROUND,
  speed: tilesPerSecond(2.0), radius: tiles(0.5), acquireRange: tiles(6),
  weapon: { damage: 64, bonus: { cloth: 32, massive: 48 }, cooldown: seconds(1.4), range: tiles(1.2), targets: 'ground', splash: tiles(1.0) },
  actives: [{
    name: '사신의 낫', desc: '체력 35% 이하의 적 주변을 낫으로 쓸어 광역 처형', kind: 'strike',
    cooldown: seconds(14), damage: 55, splash: tiles(1.4), executeBelowPct: 35, executeBonus: 55,
  }],
}));

// ── 11스테이지 「둥지 방어」 전용 ──────────────────────────────────────────
// 둥지 수호탑: 제자리에 고정된 공중 수호수 — 평타만 하는 타워.
// 무적은 캠페인 레이어가 스폰 직후 부여한다 (invulnUntil).
reg(D({
  id: 'c_nest_wyvern', race: null, name: '둥지의 와이번', tier: 'air', summonOnly: true,
  cost: 0, supply: 0, maxHp: 430, armor: 2, tags: ['leather', 'bio'], flying: true,
  speed: 0, radius: tiles(0.5), acquireRange: tiles(6),
  weapon: { damage: 42, bonus: { leather: 21 }, cooldown: seconds(1.1), range: tiles(4.5), targets: 'both' },
}));
reg(D({
  id: 'c_nest_unicorn', race: null, name: '둥지의 유니콘', tier: 'air', summonOnly: true,
  cost: 0, supply: 0, maxHp: 380, armor: 2, tags: ['leather', 'bio'], flying: true,
  speed: 0, radius: tiles(0.46), acquireRange: tiles(6),
  weapon: { damage: 22, cooldown: seconds(1.0), range: tiles(4.5), targets: 'both' },
}));
reg(D({
  id: 'c_nest_fairy', race: null, name: '둥지의 페어리', tier: 'air', summonOnly: true,
  cost: 0, supply: 0, maxHp: 200, armor: 0, tags: ['cloth', 'bio', 'female'], flying: true,
  speed: 0, radius: tiles(0.3), acquireRange: tiles(7),
  weapon: { damage: 38, bonus: { plate: 12 }, cooldown: seconds(2.0), range: tiles(6.5), targets: 'both' },
}));

// 야생 무리 (중립 연출 — 절반은 아군 팀, 절반은 적 팀으로 스폰돼 서로도 싸운다)
reg(D({
  id: 'c_wild_wolf_gray', race: null, name: '회색늑대', tier: 'basic', summonOnly: true,
  cost: 0, supply: 0, maxHp: 140, armor: 0, tags: ['leather', 'bio'], ...GROUND,
  speed: tilesPerSecond(3.0), radius: tiles(0.34), acquireRange: tiles(6),
  weapon: { damage: 14, cooldown: seconds(0.8), range: tiles(0.4), targets: 'ground' },
}));
reg(D({
  id: 'c_wild_snake', race: null, name: '뱀', tier: 'basic', summonOnly: true,
  cost: 0, supply: 0, maxHp: 100, armor: 0, tags: ['cloth', 'bio'], ...GROUND,
  speed: tilesPerSecond(2.2), radius: tiles(0.3), acquireRange: tiles(5),
  // 독니: 3초간 초당 6 중독
  weapon: { damage: 8, cooldown: seconds(1.0), range: tiles(0.4), targets: 'ground', dotDps: 6, dotTicks: seconds(3) },
}));
reg(D({
  id: 'c_wild_wolf_black', race: null, name: '검은늑대', tier: 'mid', summonOnly: true,
  cost: 0, supply: 0, maxHp: 240, armor: 1, tags: ['leather', 'bio'], ...GROUND,
  speed: tilesPerSecond(3.2), radius: tiles(0.36), acquireRange: tiles(6),
  weapon: { damage: 24, cooldown: seconds(0.8), range: tiles(0.45), targets: 'ground' },
}));
reg(D({
  id: 'c_wild_tarantula', race: null, name: '타란튤라', tier: 'mid', summonOnly: true,
  cost: 0, supply: 0, maxHp: 220, armor: 1, tags: ['leather', 'bio'], ...GROUND,
  speed: tilesPerSecond(2.4), radius: tiles(0.4), acquireRange: tiles(5.5),
  // 독+거미줄: 중독에 30% 확률 1초 속박
  weapon: { damage: 16, cooldown: seconds(1.1), range: tiles(0.5), targets: 'ground', dotDps: 8, dotTicks: seconds(3), rootTicks: seconds(1), rootChance: 30 },
}));
reg(D({
  id: 'c_wild_kestrel', race: null, name: '황조롱이', tier: 'mid', summonOnly: true,
  cost: 0, supply: 0, maxHp: 160, armor: 0, tags: ['cloth', 'bio'], flying: true,
  speed: tilesPerSecond(3.6), radius: tiles(0.36), acquireRange: tiles(6.5),
  weapon: { damage: 18, cooldown: seconds(0.9), range: tiles(0.6), targets: 'both' },
}));
reg(D({
  id: 'c_wild_bear_gray', race: null, name: '회색곰', tier: 'mid', summonOnly: true,
  cost: 0, supply: 0, maxHp: 520, armor: 2, tags: ['leather', 'massive', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.52), acquireRange: tiles(5),
  weapon: { damage: 26, cooldown: seconds(1.2), range: tiles(0.6), targets: 'ground' },
}));
reg(D({
  id: 'c_wild_direwolf', race: null, name: '다이어울프', tier: 'high', summonOnly: true,
  cost: 0, supply: 0, maxHp: 420, armor: 1, tags: ['leather', 'bio'], ...GROUND,
  speed: tilesPerSecond(3.4), radius: tiles(0.42), acquireRange: tiles(6.5),
  weapon: { damage: 40, cooldown: seconds(0.9), range: tiles(0.5), targets: 'ground' },
}));
reg(D({
  id: 'c_wild_grizzly', race: null, name: '그리즐리베어', tier: 'high', summonOnly: true,
  cost: 0, supply: 0, maxHp: 900, armor: 3, tags: ['leather', 'massive', 'bio'], ...GROUND,
  speed: tilesPerSecond(1.7), radius: tiles(0.6), acquireRange: tiles(5),
  weapon: { damage: 55, cooldown: seconds(1.5), range: tiles(0.7), targets: 'ground', splash: tiles(0.8) },
}));
reg(D({
  // 하늘의 왕 — 둥지 방어전의 준보스. 한 번은 반드시 되살아난다.
  id: 'c_wild_blackbird', race: null, name: '검은새', tier: 'supreme', summonOnly: true,
  cost: 0, supply: 0, maxHp: 4200, armor: 5, tags: ['leather', 'massive', 'bio'], flying: true,
  speed: tilesPerSecond(2.6), radius: tiles(0.8), acquireRange: tiles(7.5),
  // 하늘의 왕이자 「필드 청소부」: 30턴 버티기에서 양쪽에 쌓인 물량을
  // 한 번씩 리셋하는 역할. 검은 폭풍이 지상·공중을 가리지 않고 쓸어버린다.
  weapon: { damage: 85, cooldown: seconds(1.2), range: tiles(1.5), targets: 'both', splash: tiles(2.5), splashAirOnly: true },
  rebirth: { delayTicks: seconds(3), hpPct: 60 },
  actives: [
    {
      name: '강철 깃털', desc: '깃털을 곤두세워 8초간 방어력이 50이 된다', kind: 'selfbuff',
      cooldown: seconds(22), durTicks: seconds(8), armorAdd: 45,
    },
    {
      // 필드 리셋기 — 반경 6타일의 모든 것(지상·공중)을 갈아버린다.
      // 잡졸은 즉사, 중급도 두 방이면 위태롭다. 검은새를 안 잡으면 군세를 못 쌓는다.
      name: '검은 폭풍', desc: '날개를 내리쳐 반경 6타일의 지상·공중 전체에 폭풍 (150)', kind: 'nuke',
      cooldown: seconds(24), damage: 150, splash: tiles(6), castRange: tiles(6), fxZone: 'gravity',
    },
    {
      name: '암흑 구체', desc: '검은 거대 구체 — 공중의 가장 튼튼한 적을 노린다 (지상엔 안 통함)', kind: 'nuke',
      cooldown: seconds(14), damage: 110, splash: tiles(1.2), castRange: tiles(6), targetMode: 'highestHp', targets: 'air', fxZone: 'feast',
    },
  ],
}));

// ── 구조물 ──
reg(D({
  id: 'tower', race: null, name: '수호탑', tier: 'structure',
  cost: 0, supply: 0, maxHp: 2900, armor: 3, tags: ['plate', 'structure'], ...GROUND,
  speed: 0, radius: tiles(0.9), acquireRange: tiles(7),
  weapon: { damage: 60, cooldown: seconds(1.2), range: tiles(7), targets: 'both' },
}));
// 넥서스: 기본 티어 유닛의 평타로는 최소 피해(1)밖에 못 준다 (방어력 28).
// 공성·고급 유닛으로만 실질 피해가 들어간다. 또한 수호자가 죽기 전까진 무적.
reg(D({
  id: 'nexus', race: null, name: '넥서스', tier: 'structure',
  cost: 0, supply: 0, maxHp: 5000, armor: 28, tags: ['plate', 'structure'], ...GROUND,
  speed: 0, radius: tiles(1.2), acquireRange: tiles(8),
  weapon: { damage: 90, cooldown: seconds(1.5), range: tiles(8), targets: 'both' },
}));

// ── 수호자 (수호탑 파괴 시 부서진 팀의 수비수로 젠, docs/setting.md) ──
// 중간보스 포지션: 빠른 연타 + 광역 브레스로 웨이브를 통째로 갈아버린다.
reg(D({
  id: 'dragon', race: null, name: '드래곤', tier: 'guardian',
  cost: 0, supply: 0, maxHp: 4000, armor: 2, tags: ['leather', 'massive', 'bio'], flying: true,
  speed: tilesPerSecond(2.2), radius: tiles(0.8), acquireRange: tiles(8), leashed: true,
  // 화염 브레스: 기물 카운터 (마리오네타에게 위협적인 수호자) — 광역
  weapon: { damage: 80, bonus: { construct: 40 }, cooldown: seconds(0.9), range: tiles(3), targets: 'both', splash: tiles(1.7) },
}));
reg(D({
  // 2막 마리오네타 수호자: 여왕이 특별히 지어 올린 근위 곰인형.
  // 지상 근접이지만 낮게 나는 것도 낚아챈다(대공) — 광역 포옹으로 웨이브를 으깬다.
  id: 'teddy_guardian', race: null, name: '특제 대형 곰인형', tier: 'guardian',
  cost: 0, supply: 0, maxHp: 5200, armor: 4, tags: ['leather', 'massive', 'construct'], ...GROUND,
  speed: tilesPerSecond(2.0), radius: tiles(0.9), acquireRange: tiles(8), leashed: true,
  weapon: { damage: 85, bonus: { bio: 40 }, cooldown: seconds(0.9), range: tiles(1.3), targets: 'both', splash: tiles(1.7) },
}));
reg(D({
  id: 'hollow', race: null, name: '슬리피 할로우', tier: 'guardian',
  cost: 0, supply: 0, maxHp: 4500, armor: 3, tags: ['plate', 'massive', 'undead'], flying: true,
  // 저주 참격: 생체 카운터 (실바린에게 위협적인 수호자) — 광역
  speed: tilesPerSecond(2.0), radius: tiles(0.8), acquireRange: tiles(8), leashed: true,
  weapon: { damage: 70, bonus: { bio: 35 }, cooldown: seconds(0.9), range: tiles(3), targets: 'both', splash: tiles(1.7) },
}));

reg(D({
  // 캠페인 12 보스 — 발타르가 아끼는 선봉장. 슬리피 할로우급 거구에 그 이상의 힘.
  // 요새 앞을 지키며(leashed) 접근하는 모든 것을 소울파이어 대검으로 갈라 버린다.
  id: 'c_balthar_general', race: null, name: '사령장군 카르가스', tier: 'guardian', summonOnly: true,
  cost: 0, supply: 0, maxHp: 21000, armor: 6, tags: ['plate', 'massive', 'undead'], ...GROUND,
  regenPerSec: 7, // 사령 재생 — 찔끔찔끔 갉아서는 못 잡는다, 화력을 한 번에 집중해야
  // (상태이상 면역은 guardian 티어 공통 규칙으로 이미 적용된다)
  speed: tilesPerSecond(1.6), radius: tiles(1.0), acquireRange: tiles(8), leashed: true,
  weapon: { damage: 120, bonus: { bio: 40 }, cooldown: seconds(1.1), range: tiles(1.6), targets: 'both', splash: tiles(1.9) },
  actives: [
    {
      name: '사령 참격', desc: '대검을 내리쳐 전방을 소울파이어로 가른다', kind: 'nuke',
      cooldown: seconds(10), damage: 70, splash: tiles(2.4), castRange: tiles(5), fxZone: 'hellfire',
    },
    {
      name: '망자 소집', desc: '쓰러진 자들을 일으켜 세운다 (구울·스켈레톤 3기)',
      kind: 'summon', cooldown: seconds(18), summonCount: 3,
      summonIds: ['p_minion_ghoul', 'p_minion_skeleton', 'p_minion_undead'],
    },
  ],
}));

// ── 캠페인 전용 특수 유닛 ──────────────────────────────────────────────────

// ── 호위전(13) 소품: 보급 마차 + 불타는 숲 장애물 ──
// 마차는 캠페인 레이어가 위치를 직접 움직인다 (speed 0 = 충돌 분리에서 안 밀림).
// 장애물은 무적(invulnUntil=MAX)으로 스폰돼 아무도 조준하지 않지만,
// 지상 유닛의 충돌 분리에는 걸려 실제로 길을 막는다. 비행 유닛은 넘어간다.
// ── 엘로윈 (13 호위전 참전) — 세이지 사본, 마법 4종 전부 해금 상태 ──
reg(D({
  id: 'c_elowyn', race: null, name: '세이지 엘로윈', tier: 'final', summonOnly: true,
  cost: 0, supply: 0, maxHp: 720, armor: 1, tags: ['cloth', 'bio', 'male'], ...GROUND,
  speed: tilesPerSecond(1.3), radius: tiles(0.42), acquireRange: tiles(12),
  weapon: { damage: 24, cooldown: seconds(1.4), range: tiles(12), targets: 'both' },
  actives: [
    {
      name: '리버스그라비티', desc: '넓은 범위의 공중 유닛을 지상으로 떨어뜨림 — 12초간 지상 판정', kind: 'ground',
      cooldown: seconds(25), durTicks: seconds(12), castRange: tiles(11), splash: tiles(3),
    },
    {
      name: '블레이즈', desc: '대상 구역을 10초간 불구덩이로 만든다 (초당 34)', kind: 'zone', targets: 'ground',
      cooldown: seconds(30), zoneAtTarget: true, castRange: tiles(11),
      zone: { kind: 'blaze', radius: tiles(1.8), ticks: seconds(10) },
    },
    {
      name: '어스퀘이크', desc: '넓은 지역에 지진 — 적 전원 10초 둔화', kind: 'slowfield',
      cooldown: seconds(30), durTicks: seconds(10), castRange: tiles(11), splash: tiles(3.5),
    },
    {
      name: '블리자드', desc: '대상 지역의 적을 6초간 빙결 — 판금·거대·구조물 면역', kind: 'freeze',
      cooldown: seconds(60), durTicks: seconds(6), castRange: tiles(11), splash: tiles(2.6),
    },
  ],
}));
// ── 세이지 망루 (13 캠프 방어 포탑) — 영구 무적으로 스폰돼 조준·마법·끌림 전부 제외 ──
reg(D({
  id: 'c_sage_watchtower', race: null, name: '숲의 망루', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.6), acquireRange: tiles(7),
  // 망루 위 현자의 비전 화살 — 수호탑보다 약한 견제 포탑
  weapon: { damage: 26, cooldown: seconds(1.1), range: tiles(7), targets: 'both' },
}));

// ── 앨리스의 지원 병력 (13 호위전) ──
// race: null — 어떤 종족 상점에도 안 뜨고, 봇 구매 풀(race 일치 필터)에도 안 들어간다.
// 캠페인 mercUnits 목록으로만 사람 플레이어가 산다.
reg(D({
  id: 'c_alice_soldier', race: null, name: '앨리스의 태엽 병정', tier: 'basic',
  cost: 60, supply: 1, maxHp: 90, armor: 1, tags: ['plate', 'construct', 'male'], ...GROUND,
  speed: tilesPerSecond(1.8), radius: tiles(0.3), acquireRange: tiles(6),
  weapon: { damage: 10, bonus: { leather: 5, bio: 4 }, cooldown: seconds(0.9), range: tiles(4.5), targets: 'both' },
  actives: [{
    // 여왕 직속 — 태엽 감기가 처음부터 풀려 있다 (업그레이드 불필요)
    name: '태엽 감기', desc: '4초간 공속·이속 +40%, 종료 후 1.5초 과열(둔화)', kind: 'selfbuff',
    cooldown: seconds(15), durTicks: seconds(4), atkSpeedPct: 40, speedPct: 40, overheatSlowTicks: seconds(1.5),
  }],
}));
reg(D({
  id: 'c_alice_teddy', race: null, name: '앨리스의 고어 테디', tier: 'supreme',
  cost: 460, supply: 5, maxHp: 1300, armor: 3, tags: ['leather', 'massive', 'construct'], ...GROUND,
  speed: tilesPerSecond(1.0), radius: tiles(0.65), acquireRange: tiles(5),
  weapon: { damage: 80, bonus: { plate: 40 }, cooldown: seconds(1.4), range: tiles(0.8), targets: 'ground', splash: tiles(0.9) },
  // 원본과 달리 가시 봉제(공격 반사)가 없다 — 도발 탱커 역할만
  actives: [{
    name: '도발', desc: '주변 적이 5초간 나를 우선 공격 (아군 대신 맞아준다)', kind: 'taunt',
    cooldown: seconds(18), durTicks: seconds(5), auraRadius: tiles(4.5),
  }],
}));

reg(D({
  id: 'c_supply_cart', race: null, name: '생명수 보급 마차', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 1500, armor: 6, tags: ['plate', 'structure'], ...GROUND,
  speed: 0, radius: tiles(0.55), acquireRange: 0, ghost: true,
}));
reg(D({
  id: 'c_sylvarin_tent2', race: null, name: '실바린 지휘 천막', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.85), acquireRange: 0,
}));
reg(D({
  id: 'c_camp_fire', race: null, name: '모닥불', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.4), acquireRange: 0,
}));
reg(D({
  id: 'c_camp_crates', race: null, name: '보급 상자', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.5), acquireRange: 0,
}));
reg(D({
  id: 'c_sylvarin_banner', race: null, name: '실바린 군기', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.28), acquireRange: 0,
}));
reg(D({
  id: 'c_sylvarin_tent', race: null, name: '실바린 캠프 천막', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.7), acquireRange: 0,
}));
reg(D({
  id: 'c_burning_tree', race: null, name: '불타는 나무', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.85), acquireRange: 0,
}));
reg(D({
  id: 'c_ember_tree', race: null, name: '잿불 고목', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.8), acquireRange: 0,
}));
reg(D({
  id: 'c_ember_tree2', race: null, name: '뒤틀린 잿불 고목', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(0.8), acquireRange: 0,
}));
reg(D({
  id: 'c_burning_log', race: null, name: '불타는 쓰러진 둥치', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 999, armor: 0, tags: ['structure'], ...GROUND,
  speed: 0, radius: tiles(1.0), acquireRange: 0,
}));

// race: null + summonOnly — 대전 상점에는 절대 진열되지 않는다.
// 캠페인 스테이지 스크립트가 시간에 맞춰 직접 스폰하는 엘리트·보스.
reg(D({
  // 1막 엘리트: 재를 흩날리는 원귀 — 방어 무시 유령
  id: 'c_ash_revenant', race: null, name: '재의 원귀', tier: 'high', summonOnly: true,
  cost: 0, supply: 0, maxHp: 520, armor: 1, tags: ['cloth', 'undead'], flying: true,
  speed: tilesPerSecond(2.4), radius: tiles(0.5), acquireRange: tiles(6),
  weapon: { damage: 34, cooldown: seconds(1.1), range: tiles(2), targets: 'both', ignoreArmor: true },
}));
reg(D({
  // 2막 엘리트: 실이 끊긴 발레리나 — 고속 난도질 + 둔화
  id: 'c_mad_ballerina', race: null, name: '미친 발레리나', tier: 'high', summonOnly: true,
  cost: 0, supply: 0, maxHp: 640, armor: 2, tags: ['leather', 'construct', 'female'], ...GROUND,
  speed: tilesPerSecond(3.6), radius: tiles(0.44), acquireRange: tiles(6),
  weapon: { damage: 40, bonus: { cloth: 20 }, cooldown: seconds(0.6), range: tiles(0.6), targets: 'ground', slowTicks: seconds(1) },
}));
reg(D({
  // 3막 엘리트: 뼈로 쌓은 거상 — 광역 진압 탱크
  id: 'c_bone_colossus', race: null, name: '뼈 거상', tier: 'supreme', summonOnly: true,
  cost: 0, supply: 0, maxHp: 2400, armor: 4, tags: ['plate', 'massive', 'undead'], ...GROUND,
  speed: tilesPerSecond(0.9), radius: tiles(0.7), acquireRange: tiles(5),
  weapon: { damage: 90, bonus: { plate: 40 }, cooldown: seconds(1.8), range: tiles(1), targets: 'ground', splash: tiles(1.3), lifestealPct: 20 },
}));
reg(D({
  // 공중 엘리트: 공포의 가고일 — 하늘의 습격자
  id: 'c_dread_gargoyle', race: null, name: '공포의 가고일', tier: 'supreme', summonOnly: true,
  cost: 0, supply: 0, maxHp: 900, armor: 2, tags: ['plate', 'undead'], flying: true,
  speed: tilesPerSecond(2.8), radius: tiles(0.5), acquireRange: tiles(6.5),
  weapon: { damage: 55, bonus: { bio: 25 }, cooldown: seconds(1.2), range: tiles(3.5), targets: 'both' },
}));
// 네임드 보스 — tier: 'guardian' = 모든 상태이상 면역. 격파 시 팀 전원 보상 +
// 적 넥서스 보호막까지 해제된다 (보스 처치의 전략적 리워드).
reg(D({
  id: 'c_kurga', race: null, name: '리치 쿠르가', tier: 'guardian', summonOnly: true,
  cost: 0, supply: 0, maxHp: 3200, armor: 3, tags: ['cloth', 'undead', 'massive'], ...GROUND,
  speed: tilesPerSecond(1.4), radius: tiles(0.6), acquireRange: tiles(7),
  weapon: { damage: 40, cooldown: seconds(1.2), range: tiles(5), targets: 'both', splash: tiles(1.2) },
  actives: [
    { name: '겁화', desc: '넓은 화염 폭발', kind: 'nuke', cooldown: seconds(9), damage: 45, splash: tiles(2), castRange: tiles(6), fxZone: 'hellfire' },
  ],
}));
reg(D({
  id: 'c_mammon_lord', race: null, name: '대부호 마몬', tier: 'guardian', summonOnly: true,
  cost: 0, supply: 0, maxHp: 4200, armor: 4, tags: ['plate', 'undead', 'massive'], ...GROUND,
  speed: tilesPerSecond(1.3), radius: tiles(0.65), acquireRange: tiles(6),
  weapon: { damage: 85, bonus: { construct: 30 }, cooldown: seconds(1.1), range: tiles(1.2), targets: 'both', splash: tiles(1.2), lifestealPct: 30 },
  actives: [
    { name: '황금 군세', desc: '주변 아군 공속 강화', kind: 'allybuff', cooldown: seconds(25), durTicks: seconds(8), auraRadius: tiles(6) },
  ],
}));
reg(D({
  id: 'c_balthar', race: null, name: '데미리치 발타르', tier: 'guardian', summonOnly: true,
  cost: 0, supply: 0, maxHp: 6000, armor: 4, tags: ['cloth', 'undead', 'massive'], flying: true,
  speed: tilesPerSecond(1.8), radius: tiles(0.6), acquireRange: tiles(7),
  weapon: { damage: 60, bonus: { bio: 30 }, cooldown: seconds(1.0), range: tiles(5), targets: 'both' },
  actives: [
    { name: '자정의 만찬', desc: '초광역 사령 폭발', kind: 'nuke', cooldown: seconds(20), damage: 40, splash: tiles(4), castRange: tiles(7), fxZone: 'feast' },
    { name: '사후의 경계', desc: '끌어당기는 장판', kind: 'zone', cooldown: seconds(40), zone: { kind: 'grave', radius: tiles(3), ticks: seconds(5) } },
  ],
}));

reg(D({
  // 캠페인 협공 맵의 적 주둔지 — 아군 진영 한복판에 박힌 요새.
  // defId 가 nexus/tower 가 아니므로 부숴도 게임은 끝나지 않는다 (부가 목표).
  id: 'c_warcamp', race: null, name: '망자 주둔지', tier: 'structure', summonOnly: true,
  cost: 0, supply: 0, maxHp: 4200, armor: 3, tags: ['plate', 'structure'], ...GROUND,
  speed: 0, radius: tiles(1.0), acquireRange: tiles(6.5),
  weapon: { damage: 45, cooldown: seconds(1.3), range: tiles(6.5), targets: 'both' },
}));

/** 팀별 수호자 defId. 1진영 = 드래곤, 2진영 = 슬리피 할로우. */
export const GUARDIAN_OF: Record<TeamId, string> = { 0: 'dragon', 1: 'hollow' };

/** 종족별 구매 가능 유닛 목록 (표시 순서 = 티어순). */
export function unitsOfRace(race: RaceId): EntityDef[] {
  const order: Record<string, number> = {
    basic: 0, novice: 1, mid: 2, high: 3, air: 4, supreme: 5, final: 6,
  };
  return Object.values(DEFS)
    .filter((d) => d.race === race && !d.summonOnly) // 소환물은 상점에 안 판다
    .sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || a.cost - b.cost);
}

export const RACE_NAMES: Record<RaceId, string> = {
  sylvarin: '실바린',
  pandemonium: '판데모니엄',
  marionetta: '마리오네타',
};

// ── 유닛 업그레이드 ────────────────────────────────────────────────────────
// 원본: docs/races/*.md 의 유닛별 업그레이드. 미구현 시스템(독/공포/넉백/반사/
// 소환/연결/처형/명중률) 의존 항목은 제외하거나 기존 메커니즘으로 근사했고,
// 수치는 밸런스 감사를 거친 잠정치다. tech: 필요 테크 레벨 (1티어 유닛의
// 업그레이드도 최소 테크 2 — 초반 스노우볼 방지).

export interface UpgradeMods {
  readonly maxHpPct?: number;
  readonly armorAdd?: number;
  readonly damagePct?: number;
  readonly cooldownPct?: number; // 음수 = 공속 증가
  readonly speedPct?: number;
  readonly rangeAdd?: number; // FP
  readonly splashAdd?: number; // FP (기존 스플래시에 가산, 없으면 신설)
  readonly slowTicksAdd?: number; // 틱 (기존 둔화에 가산, 없으면 신설)
  readonly bonusAdd?: Partial<Record<BonusKey, number>>;
  readonly healAmountPct?: number;
  /** 동시 회복 대상 수 지정 (드루이드 「이중 개화」 = 2). */
  readonly healMultiSet?: number;
  /** 지속피해 부여 (독/화상). 기존 dot 이 있으면 dps 가산. */
  readonly dotSet?: { readonly dps: number; readonly ticks: number; readonly chance?: number };
  /** 속박 부여 (없던 유닛에 신설). */
  readonly rootSet?: { readonly ticks: number; readonly chance?: number };
  /** 한기 부여 (명중 시 공속·이속 -CHILL_PCT%). */
  readonly chillSet?: { readonly ticks: number };
  readonly rootTicksAdd?: number;
  readonly rootChanceAdd?: number;
  /** 장판 지속시간 가산 (장판 무기 전용). */
  readonly zoneTicksAdd?: number;
  // ── 액티브 스킬 강화 (def.actives 전체에 적용) ──
  readonly skillDamagePct?: number;
  readonly skillCooldownPct?: number; // 음수 = 쿨 감소
  readonly skillSplashAdd?: number;   // FP
  readonly skillDurTicksAdd?: number; // 틱
  readonly skillCastRangeAdd?: number; // FP (마법 시전 사거리)
  // ── 캠페인 강화(BOONS) 전용 수단 ──
  /** 평타 흡혈 % 가산 (기존 흡혈에 더한다). */
  readonly lifestealAdd?: number;
  /** 초당 체력 재생 부여. */
  readonly regenPerSec?: number;
  /** 공중 동시 사격 대상 수 설정 (숲의 명궁류). */
  readonly airMultiTargetsSet?: number;
  /** 액티브 스킬 부여 — 원래 없던 스킬을 통째로 붙인다. */
  readonly addActive?: ActiveSkill;
  /** 무기 타겟 범위 변경 (지상 전용 → 지상·공중 등). */
  readonly targetsSet?: Weapon['targets'];
  /** 최대 체력 고정 가산. */
  readonly maxHpAdd?: number;
  /** 평타 회피 확률 % 설정. */
  readonly dodgePct?: number;
  /** 평타 장판 종류 교체 (포자 구름 → 치유 포자 등). */
  readonly zoneKindSet?: import('./types.ts').ZoneKind;
}

export interface UnitUpgrade {
  readonly id: string;
  readonly unit: string; // defId
  readonly name: string;
  readonly desc: string;
  readonly cost: number;
  readonly tech: number;
  /** 같은 그룹에서 하나만 선택 가능 (택1). */
  readonly choiceGroup?: string;
  /** 캠페인 전용 — 대전 상점에는 진열되지 않고 봇도 사지 않는다 (강화 연계 해금). */
  readonly campaignOnly?: boolean;
  /** 이 강화를 골랐을 때만 상점에 노출된다 (campaignOnly 와 함께 사용). */
  readonly boonId?: string;
  readonly mods: UpgradeMods;
}

export const UPGRADES: UnitUpgrade[] = [
  // 🌲 실바린
  { id: 'su_gouto_fur', unit: 's_gouto', name: '단단한 털', desc: '방어력 +1', cost: 150, tech: 2, mods: { armorAdd: 1 } },
  { id: 'su_elf_pierce', unit: 's_elf_archer', name: '관통 화살', desc: '화살이 소범위 관통 피해', cost: 200, tech: 2, choiceGroup: 'elf1', mods: { splashAdd: tiles(0.6) } },
  { id: 'su_elf_longbow', unit: 's_elf_archer', name: '긴 활', desc: '사거리 +1', cost: 200, tech: 2, choiceGroup: 'elf1', mods: { rangeAdd: tiles(1) } },
  { id: 'su_elf_poison', unit: 's_elf_archer', name: '독화살', desc: '명중 시 3초간 초당 6 독 피해', cost: 200, tech: 2, choiceGroup: 'elf1', mods: { dotSet: { dps: 6, ticks: seconds(3) } } },
  { id: 'su_vine_poison', unit: 's_vine_hunter', name: '맹독 단검', desc: '명중 시 3초간 초당 8 독 피해', cost: 220, tech: 2, mods: { dotSet: { dps: 8, ticks: seconds(3) } } },
  { id: 'su_marmot_armor', unit: 's_marmot', name: '단단한 갑주', desc: '방어력 +2', cost: 200, tech: 2, choiceGroup: 'marmot1', mods: { armorAdd: 2 } },
  { id: 'su_marmot_mace', unit: 's_marmot', name: '철퇴 강화', desc: '공격력 +30%', cost: 200, tech: 2, choiceGroup: 'marmot1', mods: { damagePct: 30 } },
  { id: 'su_mush_paralyze', unit: 's_mushroom_bomber', name: '마비 포자', desc: '포자 구름 지속 +2초', cost: 220, tech: 2, choiceGroup: 'mush1', mods: { zoneTicksAdd: seconds(2) } },
  { id: 'su_mush_blast', unit: 's_mushroom_bomber', name: '폭발 포자', desc: '폭발 범위 확대', cost: 220, tech: 2, choiceGroup: 'mush1', mods: { splashAdd: tiles(0.4) } },
  { id: 'su_druid_spring', unit: 's_druid', name: '생명의 샘', desc: '회복량 +40%', cost: 250, tech: 2, choiceGroup: 'druid1', mods: { healAmountPct: 40 } },
  { id: 'su_druid_purify', unit: 's_druid', name: '정화의 빛', desc: '언데드에게 +25 추가 피해', cost: 250, tech: 2, choiceGroup: 'druid1', mods: { bonusAdd: { undead: 25 } } },
  { id: 'su_witch_black', unit: 's_thorn_witch', name: '화염 가시', desc: '기물(인형)에게 +17 추가 피해', cost: 250, tech: 3, choiceGroup: 'witch1', mods: { bonusAdd: { construct: 17 } } },
  { id: 'su_witch_bind', unit: 's_thorn_witch', name: '속박의 가시', desc: '명중 시 40% 확률로 1초 속박', cost: 250, tech: 3, choiceGroup: 'witch1', mods: { rootSet: { ticks: seconds(1), chance: 40 } } },
  { id: 'su_treant_bark', unit: 's_treant', name: '고대의 껍질', desc: '방어력 +2', cost: 300, tech: 3, mods: { armorAdd: 2 } },
  { id: 'su_wyvern_dive', unit: 's_wyvern', name: '급강하', desc: '내리꽂기 피해 +50%, 범위 확대', cost: 300, tech: 3, choiceGroup: 'wyvern1', mods: { skillDamagePct: 50, skillSplashAdd: tiles(0.4) } },
  { id: 'su_wyvern_scale', unit: 's_wyvern', name: '두꺼운 비늘', desc: '방어력 +2, 체력 +20%', cost: 300, tech: 3, choiceGroup: 'wyvern1', mods: { armorAdd: 2, maxHpPct: 20 } },
  { id: 'su_unicorn_bless', unit: 's_unicorn', name: '축복의 뿔', desc: '가호·날개짓 지속 +6초', cost: 270, tech: 3, choiceGroup: 'unicorn1', mods: { skillDurTicksAdd: seconds(6) } },
  { id: 'su_unicorn_swift', unit: 's_unicorn', name: '신속한 정화', desc: '액티브 쿨타임 -25%', cost: 270, tech: 3, choiceGroup: 'unicorn1', mods: { skillCooldownPct: -25 } },
  { id: 'su_fairy_dust', unit: 's_fairy', name: '요정 가루', desc: '수면 쿨타임 -25%', cost: 280, tech: 3, choiceGroup: 'fairy1', mods: { skillCooldownPct: -25 } },
  { id: 'su_marks_eagle', unit: 's_marksman', name: '매의 눈', desc: '사거리 +1', cost: 320, tech: 3, choiceGroup: 'marks1', mods: { rangeAdd: tiles(1) } },
  { id: 'su_marks_pierce', unit: 's_marksman', name: '폭풍 관통시', desc: '공격력 +25%', cost: 320, tech: 3, choiceGroup: 'marks1', mods: { damagePct: 25 } },
  { id: 'su_sage_gravity', unit: 's_sage', name: '리버스그라비티 해금', desc: '마법 해금: 공중 유닛을 지상으로 떨어뜨린다', cost: 1000, tech: 3, mods: {} },
  { id: 'su_sage_quake', unit: 's_sage', name: '어스퀘이크 해금', desc: '마법 해금: 넓은 지역 둔화', cost: 1000, tech: 3, mods: {} },
  { id: 'su_sage_blizzard', unit: 's_sage', name: '블리자드 해금', desc: '마법 해금: 광역 빙결', cost: 1000, tech: 3, mods: {} },
  // ── 캠페인 강화 연계 해금 (해당 강화를 골랐을 때만 상점에 노출) ──
  // 액티브형: 구매 시 스킬 발동이 열린다 (requiresUpgrade)
  { id: 'su_elf_rain', unit: 's_elf_archer', name: '화살비 연구', desc: '캠페인 강화 「화살비」 사용 해금', cost: 350, tech: 3, campaignOnly: true, boonId: 'b_elf_rain', mods: {} },
  // 스탯형: 구매 시 능력치가 실제로 적용된다 (강화 선택은 노출 조건일 뿐)
  { id: 'su_gouto_pack', unit: 's_gouto', name: '무리의 결속', desc: '체력 +40%, 방어력 +1', cost: 300, tech: 3, campaignOnly: true, boonId: 'b_gouto_pack', mods: { maxHpPct: 40, armorAdd: 1 } },
  { id: 'su_gouto_feral', unit: 's_gouto', name: '야성의 굶주림', desc: '공격력 +25%, 흡혈 20%', cost: 250, tech: 2, campaignOnly: true, boonId: 'b_gouto_feral', mods: { damagePct: 25, lifestealAdd: 20 } },
  { id: 'su_marmot_fortress', unit: 's_marmot', name: '요새의 갑주', desc: '체력 +35%, 방어력 +3', cost: 350, tech: 3, campaignOnly: true, boonId: 'b_marmot_fortress', mods: { maxHpPct: 35, armorAdd: 3 } },
  { id: 'su_marmot_siege', unit: 's_marmot', name: '공성 철퇴', desc: '공격력 +35%, 구조물 특효 +25', cost: 350, tech: 3, campaignOnly: true, boonId: 'b_marmot_siege', mods: { damagePct: 35, bonusAdd: { structure: 25 } } },
  { id: 'su_sage_focus', unit: 's_sage', name: '비전 집중', desc: '마법 쿨타임 -20%', cost: 400, tech: 3, choiceGroup: 'sage1', mods: { skillCooldownPct: -20 } },
  { id: 'su_sage_robe', unit: 's_sage', name: '세계수의 예복', desc: '체력 +30%, 방어력 +2', cost: 400, tech: 3, choiceGroup: 'sage1', mods: { maxHpPct: 30, armorAdd: 2 } },
  { id: 'su_fairy_siege', unit: 's_fairy', name: '별빛 포격', desc: '공격력 +25%, 사거리 +0.5', cost: 280, tech: 3, choiceGroup: 'fairy1', mods: { damagePct: 25, rangeAdd: tiles(0.5) } },
  // ☠️ 판데모니엄
  { id: 'pu_skel_saw', unit: 'p_skeleton', name: '톱날 뼈', desc: '판금 유닛에게 +8 추가 피해', cost: 180, tech: 2, choiceGroup: 'skel1', mods: { bonusAdd: { plate: 8 } } },
  { id: 'pu_skel_tough', unit: 'p_skeleton', name: '질긴 뼈', desc: '체력 +25%, 방어력 +1', cost: 180, tech: 2, choiceGroup: 'skel1', mods: { maxHpPct: 25, armorAdd: 1 } },
  { id: 'pu_bone_shard', unit: 'p_bone_thrower', name: '뼈 파편', desc: '공격이 소범위 파편 피해', cost: 200, tech: 2, mods: { splashAdd: tiles(0.5) } },
  { id: 'pu_knight_horse', unit: 'p_headless_knight', name: '검은 군마', desc: '이동속도 +20%', cost: 200, tech: 2, mods: { speedPct: 20 } },
  { id: 'pu_banshee_scream', unit: 'p_banshee', name: '죽음의 비명', desc: '공격력 +40%', cost: 220, tech: 2, choiceGroup: 'banshee1', mods: { damagePct: 40 } },
  { id: 'pu_succubus_awaken', unit: 'p_succubus', name: '각성', desc: '매혹 확률 45% + 매혹 성공 시 15초 악마 변신 (체력 2배·완전 회복·공격력 대폭 상승)', cost: 1200, tech: 3, mods: {} },
  { id: 'pu_incubus_legion', unit: 'p_incubus', name: '군세 소환 해금', desc: '스킬 해금: 밴시 12·시체 골렘 5·타나토스 3·데미리치 1·마몬 1 소환', cost: 1200, tech: 3, mods: {} },
  { id: 'pu_incubus_sacrifice', unit: 'p_incubus', name: '제물 흡수 해금', desc: '스킬 해금: 7초마다 내 1티어 유닛을 삼켜 공격 +10%·방어 +2 (최대 10스택)', cost: 1800, tech: 3, mods: {} },
  { id: 'pu_banshee_wail', unit: 'p_banshee', name: '절망의 울음', desc: '피격 시 한기 3초 — 공속·이속 -20%', cost: 220, tech: 2, choiceGroup: 'banshee1', mods: { chillSet: { ticks: seconds(3) } } },
  { id: 'pu_thanatos_scythe', unit: 'p_thanatos', name: '죽음의 낫', desc: '낫 범위 확대', cost: 300, tech: 3, mods: { splashAdd: tiles(0.5) } },
  { id: 'pu_golem_bone', unit: 'p_corpse_golem', name: '뼈 갑주', desc: '방어력 +2', cost: 250, tech: 3, mods: { armorAdd: 2 } },
  { id: 'pu_wraith_chill', unit: 'p_wraith', name: '한기', desc: '공격 시 1.5초 둔화', cost: 250, tech: 2, mods: { slowTicksAdd: seconds(1.5) } },
  // 🧸 마리오네타
  { id: 'mu_bear_button', unit: 'm_plushbear', name: '강철 단추', desc: '방어력 +1', cost: 180, tech: 2, choiceGroup: 'bear1', mods: { armorAdd: 1 } },
  { id: 'mu_bear_stuff', unit: 'm_plushbear', name: '봉제 강화', desc: '체력 +25%', cost: 180, tech: 2, choiceGroup: 'bear1', mods: { maxHpPct: 25 } },
  { id: 'mu_soldier_explosive', unit: 'm_clockwork_soldier', name: '폭발 탄환', desc: '탄환이 소범위 폭발', cost: 200, tech: 2, mods: { splashAdd: tiles(0.5) } },
  { id: 'mu_soldier_windup', unit: 'm_clockwork_soldier', name: '태엽 감기 해금', desc: '스킬 해금: 4초 공속·이속 +40% (종료 후 과열)', cost: 200, tech: 2, mods: {} },
  { id: 'mu_swords_sharp', unit: 'm_puppet_swordsman', name: '날카로운 목검', desc: '공격력 +25%', cost: 200, tech: 2, choiceGroup: 'swords1', mods: { damagePct: 25 } },
  { id: 'mu_swords_thread', unit: 'm_puppet_swordsman', name: '절단 실', desc: '공격 시 1초 둔화', cost: 200, tech: 2, choiceGroup: 'swords1', mods: { slowTicksAdd: seconds(1) } },
  { id: 'mu_spider_web', unit: 'm_clockwork_spider', name: '질긴 포획 실', desc: '속박 지속 +0.6초, 확률 +15%', cost: 200, tech: 2, mods: { rootTicksAdd: seconds(0.6), rootChanceAdd: 15 } },
  { id: 'mu_clown_firework', unit: 'm_clown_doll', name: '불꽃놀이', desc: '폭발 범위 확대', cost: 220, tech: 2, mods: { splashAdd: tiles(0.4) } },
  // 수리공 인형 삭제 (단추 인형과 역할 중복) — 정밀 수리는 단추 인형이 물려받았다
  { id: 'mu_repair_precise', unit: 'm_button_doll', name: '정밀 수리', desc: '수리량 +40%', cost: 200, tech: 2, mods: { healAmountPct: 40 } },
  { id: 'mu_cursed_stitch', unit: 'm_cursed_doll', name: '붉은 실밥', desc: '공격속도 +15%', cost: 250, tech: 3, mods: { cooldownPct: -15 } },
  { id: 'mu_casper_fire', unit: 'm_casper', name: '유령불', desc: '공격력 +20%, 명중 시 2초 화상(초당 8)', cost: 250, tech: 3, mods: { damagePct: 20, dotSet: { dps: 8, ticks: seconds(2) } } },
  { id: 'mu_ann_red', unit: 'm_puppet_ann', name: '붉은 실', desc: '둔화 지속 +1초', cost: 250, tech: 2, choiceGroup: 'ann1', mods: { slowTicksAdd: seconds(1) } },
  { id: 'mu_ann_sharp', unit: 'm_puppet_ann', name: '날카로운 실', desc: '공격력 +25%', cost: 250, tech: 2, choiceGroup: 'ann1', mods: { damagePct: 25 } },
  { id: 'mu_gore_pain', unit: 'm_gore_teddy', name: '고통의 실', desc: '공격력 +20%', cost: 300, tech: 3, mods: { damagePct: 20 } },
  { id: 'mu_alice_charm', unit: 'm_alice', name: '인형의 실 해금', desc: '스킬 해금: 적 중급 이상 유닛을 영구히 아군으로 (45초 쿨)', cost: 1000, tech: 3, mods: {} },
  { id: 'mu_gear_bell', unit: 'm_clocktower_gear', name: '거대한 종', desc: '자정의 종소리 시전 사거리 +2', cost: 300, tech: 3, mods: { skillCastRangeAdd: tiles(2) } },
];

// ── 캠페인 유닛 강화 (BOONS) ──────────────────────────────────────────────
// 스테이지 클리어 보상으로 유닛 하나가 개방되고, 그 유닛의 강화 3개 중 하나를 고른다.
// 언제든 다시 고를 수 있다 (localStorage 저장). 대전에는 전혀 영향이 없다.
export interface UnitBoon {
  readonly id: string;
  readonly unit: string;   // defId
  readonly name: string;
  readonly desc: string;
  /** 분류 — UI 뱃지용. */
  readonly kind: 'stat' | 'passive' | 'active';
  readonly mods: UpgradeMods;
}

export const BOONS: readonly UnitBoon[] = [
  // 고우토 (45원 기본 근접, 공격 10 / 공속 0.8 / 지상만)
  { id: 'b_gouto_pack', unit: 's_gouto', kind: 'stat', name: '무리의 결속',
    desc: '체력 +40%, 방어력 +1 — 테크 3 「무리의 결속」(300원) 구매 시 적용', mods: {} },
  { id: 'b_gouto_feral', unit: 's_gouto', kind: 'passive', name: '야성의 굶주림',
    desc: '공격력 +25%, 흡혈 20% — 테크 2 「야성의 굶주림」(250원) 구매 시 적용', mods: {} },
  { id: 'b_gouto_leap', unit: 's_gouto', kind: 'active', name: '도약 강습',
    desc: '전투 중 8초마다 뛰어들어 착지 지점에 광역 30',
    mods: { addActive: { name: '도약 강습', desc: '착지 지점 광역 30', kind: 'strike',
      cooldown: seconds(8), damage: 30, splash: tiles(1.1) } } },

  // 엘프 궁수 (60원 기본 원거리, 공격 10 / 사거리 5)
  { id: 'b_elf_volley', unit: 's_elf_archer', kind: 'stat', name: '속사 훈련',
    desc: '공격 속도 +10%, 사거리 +1 (시작부터 적용)', mods: { cooldownPct: -10, rangeAdd: tiles(1) } },
  { id: 'b_elf_hunter', unit: 's_elf_archer', kind: 'passive', name: '사냥꾼의 눈',
    desc: '체력 +20, 공중 유닛에게 추가 +12', mods: { maxHpAdd: 20, bonusAdd: { flying: 12 } } },
  { id: 'b_elf_rain', unit: 's_elf_archer', kind: 'active', name: '화살비',
    desc: '12초마다 지상에 화살비 (광역 6, 공중 제외) — 테크 3 「화살비 연구」(350원) 구매 시 발동',
    mods: { addActive: { name: '화살비', desc: '지상 광역 6 (테크 3 연구 필요)', kind: 'nuke',
      cooldown: seconds(12), damage: 6, splash: tiles(1.8), castRange: tiles(5),
      targets: 'ground', requiresUpgrade: 'su_elf_rain' } } },

  // 갑옷 마멋 (130원 탱커·공성, 공격 30+판금22 / 체력 360)
  { id: 'b_marmot_fortress', unit: 's_marmot', kind: 'stat', name: '요새의 갑주',
    desc: '체력 +35%, 방어력 +3 — 테크 3 「요새의 갑주」(350원) 구매 시 적용', mods: {} },
  { id: 'b_marmot_siege', unit: 's_marmot', kind: 'passive', name: '공성 철퇴',
    desc: '공격력 +35%, 구조물 특효 +25 — 테크 3 「공성 철퇴」(350원) 구매 시 적용', mods: {} },
  { id: 'b_marmot_quake', unit: 's_marmot', kind: 'active', name: '대지 진동',
    desc: '전투 중 10초마다 주변 적을 3초간 둔화',
    mods: { addActive: { name: '대지 진동', desc: '주변 둔화 3초', kind: 'slowfield',
      cooldown: seconds(10), durTicks: seconds(3), splash: tiles(2.2) } } },

  // 덩굴 사냥꾼 (150원 고속 암살, 공격 24 / 공속 0.7 / 지상만)
  { id: 'b_vine_swift', unit: 's_vine_hunter', kind: 'passive', name: '바람의 발놀림',
    desc: '평타를 30% 확률로 회피 (마법·장판은 못 피한다)', mods: { dodgePct: 30 } },
  { id: 'b_vine_venom', unit: 's_vine_hunter', kind: 'passive', name: '맹독 도포',
    desc: '명중 시 4초간 초당 12 독, 흡혈 15%',
    mods: { dotSet: { dps: 12, ticks: seconds(4) }, lifestealAdd: 15 } },
  { id: 'b_vine_grasp', unit: 's_vine_hunter', kind: 'active', name: '덩굴 옭아매기',
    desc: '전투 중 9초마다 주변 적을 2초간 속박',
    mods: { addActive: { name: '덩굴 옭아매기', desc: '주변 속박 2초', kind: 'root',
      cooldown: seconds(9), durTicks: seconds(2), splash: tiles(1.8) } } },

  // 드루이드 (160원 힐러, 힐 14 / 쿨 1초)
  { id: 'b_druid_spring', unit: 's_druid', kind: 'stat', name: '생명의 원천',
    desc: '회복량 +50%, 회복 사거리 +1', mods: { healAmountPct: 50, rangeAdd: tiles(1) } },
  { id: 'b_druid_bark', unit: 's_druid', kind: 'passive', name: '이중 개화',
    desc: '가장 다친 아군 2명을 동시에 회복한다', mods: { healMultiSet: 2 } },
  { id: 'b_druid_bloom', unit: 's_druid', kind: 'active', name: '개화',
    desc: '전투 중 14초마다 주변 아군 방어력 +2 (10초)',
    mods: { addActive: { name: '개화', desc: '아군 방어 +2 (10초)', kind: 'allyarmor',
      cooldown: seconds(14), durTicks: seconds(10), auraRadius: tiles(4), armorAdd: 2 } } },

  // 버섯 폭탄병 (170원 공성 포격, 공격 26+판금20 / 지상만)
  { id: 'b_mush_range', unit: 's_mushroom_bomber', kind: 'stat', name: '장거리 포자탄',
    desc: '사거리 +1.5', mods: { rangeAdd: tiles(1.5) } },
  { id: 'b_mush_frenzy', unit: 's_mushroom_bomber', kind: 'active', name: '포자 과다분비',
    desc: '전투 중 10초마다 4초간 공격 속도 +50%',
    mods: { addActive: { name: '포자 과다분비', desc: '4초간 공속 +50%', kind: 'selfbuff',
      cooldown: seconds(10), durTicks: seconds(4), atkSpeedPct: 50 } } },
  { id: 'b_mush_balm', unit: 's_mushroom_bomber', kind: 'passive', name: '치유 포자',
    desc: '포자 구름이 아군 생체를 회복시킨다 (초당 8) + 구름 지속 +2초',
    mods: { zoneKindSet: 'balm', zoneTicksAdd: seconds(2) } },

  // 숲올빼미 (240원 대공, 공격 26+가죽13 / 사거리 4.5)
  { id: 'b_owl_talon', unit: 's_owl', kind: 'stat', name: '강철 발톱',
    desc: '공격력 +30%, 공격 속도 +15%', mods: { damagePct: 30, cooldownPct: -15 } },
  { id: 'b_owl_swarm', unit: 's_owl', kind: 'passive', name: '무리 사냥',
    desc: '공중 적 2기를 동시 사격, 공중에게 추가 +10',
    mods: { airMultiTargetsSet: 2, bonusAdd: { flying: 10 } } },
  { id: 'b_owl_dive', unit: 's_owl', kind: 'active', name: '급강하',
    desc: '전투 중 9초마다 내리꽂아 착지 지점에 광역 40',
    mods: { addActive: { name: '급강하', desc: '착지 광역 40', kind: 'strike',
      cooldown: seconds(9), damage: 40, splash: tiles(1.2) } } },

  // 거대 나비 (200원 지원, 공격 8 / 둔화 2초)
  { id: 'b_butterfly_dust', unit: 's_butterfly', kind: 'stat', name: '짙은 인분',
    desc: '공격력 +80%, 둔화 지속 +1.5초', mods: { damagePct: 80, slowTicksAdd: seconds(1.5) } },
  { id: 'b_butterfly_heal', unit: 's_butterfly', kind: 'passive', name: '치유의 인분',
    desc: '체력 +50%, 초당 5 재생', mods: { maxHpPct: 50, regenPerSec: 5 } },
  { id: 'b_butterfly_gale', unit: 's_butterfly', kind: 'active', name: '돌풍',
    desc: '전투 중 13초마다 주변 적을 6초간 약화',
    mods: { addActive: { name: '돌풍', desc: '주변 약화 6초', kind: 'weaken',
      cooldown: seconds(13), durTicks: seconds(6), auraRadius: tiles(3.5) } } },

  // 가시 마녀 (300원 광역 저격, 공격 30 / 가시밭 장판)
  { id: 'b_witch_thorn', unit: 's_thorn_witch', kind: 'stat', name: '가시 폭풍',
    desc: '공격력 +30%, 폭발 범위 +0.5타일', mods: { damagePct: 30, splashAdd: tiles(0.5) } },
  { id: 'b_witch_doll', unit: 's_thorn_witch', kind: 'passive', name: '인형 사냥꾼',
    desc: '기물(인형)에게 추가 +25, 사거리 +1.5',
    mods: { bonusAdd: { construct: 25 }, rangeAdd: tiles(1.5) } },
  { id: 'b_witch_frost', unit: 's_thorn_witch', kind: 'active', name: '서리 가시',
    desc: '전투 중 15초마다 대상 지역 적을 4초간 빙결 (판금·거대 면역)',
    mods: { addActive: { name: '서리 가시', desc: '광역 빙결 4초', kind: 'freeze',
      cooldown: seconds(15), durTicks: seconds(4), castRange: tiles(5), splash: tiles(1.6), fxZone: 'frost' } } },
];

export const BOONS_BY_UNIT = new Map<string, UnitBoon[]>();
for (const b of BOONS) {
  const list = BOONS_BY_UNIT.get(b.unit) ?? [];
  list.push(b);
  BOONS_BY_UNIT.set(b.unit, list);
}

const UPGRADES_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));
const UPGRADES_BY_UNIT = new Map<string, UnitUpgrade[]>();
for (const u of UPGRADES) {
  const list = UPGRADES_BY_UNIT.get(u.unit) ?? [];
  list.push(u);
  UPGRADES_BY_UNIT.set(u.unit, list);
}

export function upgradeById(id: string): UnitUpgrade | undefined {
  return UPGRADES_BY_ID.get(id);
}

export function upgradesOfUnit(defId: string): UnitUpgrade[] {
  return UPGRADES_BY_UNIT.get(defId) ?? [];
}

/**
 * 구매한 업그레이드를 반영한 유효 정의. 수정이 없으면 undefined (기본 사용).
 * 순수 함수 — 같은 입력이면 같은 출력 (결정론).
 */
export function effectiveDef(defId: string, owned: Record<string, true>): EntityDef | undefined {
  const ups = (UPGRADES_BY_UNIT.get(defId) ?? []).filter((u) => owned[u.id]);
  if (ups.length === 0) return undefined;
  return applyMods(DEFS[defId]!, ups.map((u) => u.mods));
}

/**
 * 캠페인 유닛 강화(BOONS) 를 정의에 반영한 사본.
 * 업그레이드와 같은 수단(UpgradeMods)을 쓰지만 적용 경로는 따로다 —
 * 강화는 상점에서 사는 게 아니라 스테이지 보상으로 고르는 것이기 때문.
 */
export function applyBoons(base: EntityDef, boonIds: readonly string[]): EntityDef {
  if (boonIds.length === 0) return base;
  const mods = BOONS.filter((b) => b.unit === base.id && boonIds.includes(b.id))
    .map((b) => b.mods)
    // 해금형 강화는 mods 가 비어 있다 (효과는 연계 업그레이드가 담당) — 사본을 만들지 않는다
    .filter((m) => Object.keys(m).length > 0);
  return mods.length === 0 ? base : applyMods(base, mods);
}

/** 수정자 목록을 순서대로 적용한 정의 사본. 순서가 결과를 바꾸므로 배열 순서 그대로 돈다. */
function applyMods(base: EntityDef, modList: readonly UpgradeMods[]): EntityDef {
  let maxHp = base.maxHp;
  let armor = base.armor;
  let speed = base.speed;
  let heal = base.heal;
  let weapon: Weapon | undefined = base.weapon;
  let actives = base.actives;
  let regenPerSec = base.regenPerSec;
  let dodgePct = base.dodgePct;
  for (const m of modList) {
    if (actives && (m.skillDamagePct || m.skillCooldownPct || m.skillSplashAdd || m.skillDurTicksAdd || m.skillCastRangeAdd)) {
      actives = actives.map((a) => {
        const next = { ...a };
        if (m.skillDamagePct && next.damage) next.damage = idiv(next.damage * (100 + m.skillDamagePct), 100);
        if (m.skillCooldownPct) next.cooldown = Math.max(1, idiv(next.cooldown * (100 + m.skillCooldownPct), 100));
        if (m.skillSplashAdd && next.splash) next.splash += m.skillSplashAdd;
        if (m.skillDurTicksAdd && next.durTicks) next.durTicks += m.skillDurTicksAdd;
        if (m.skillCastRangeAdd && next.castRange) next.castRange += m.skillCastRangeAdd;
        return next;
      });
    }
    if (m.maxHpPct) maxHp = idiv(maxHp * (100 + m.maxHpPct), 100);
    if (m.maxHpAdd) maxHp += m.maxHpAdd;
    if (m.dodgePct) dodgePct = m.dodgePct;
    if (m.regenPerSec) regenPerSec = (regenPerSec ?? 0) + m.regenPerSec;
    if (m.addActive) actives = [...(actives ?? []), m.addActive];
    if (m.armorAdd) armor += m.armorAdd;
    if (m.speedPct) speed = idiv(speed * (100 + m.speedPct), 100);
    if (m.healAmountPct && heal) heal = { ...heal, amount: idiv(heal.amount * (100 + m.healAmountPct), 100) };
    if (m.healMultiSet && heal) heal = { ...heal, multi: m.healMultiSet };
    if (weapon) {
      let w = { ...weapon } as {
        damage: number; bonus?: Partial<Record<BonusKey, number>>; cooldown: number;
        range: number; targets: Weapon['targets']; splash?: number;
        slowTicks?: number; slowChance?: number; ignoreArmor?: boolean; lifestealPct?: number;
        dotDps?: number; dotTicks?: number; dotChance?: number;
        rootTicks?: number; rootChance?: number; chillTicks?: number;
        airMultiTargets?: number;
        zone?: { kind: import('./types.ts').ZoneKind; radius: number; ticks: number };
      };
      if (m.damagePct) w.damage = idiv(w.damage * (100 + m.damagePct), 100);
      if (m.cooldownPct) w.cooldown = Math.max(1, idiv(w.cooldown * (100 + m.cooldownPct), 100));
      if (m.rangeAdd) w.range += m.rangeAdd;
      if (m.splashAdd) w.splash = (w.splash ?? 0) + m.splashAdd;
      if (m.slowTicksAdd) {
        w.slowTicks = (w.slowTicks ?? 0) + m.slowTicksAdd;
        // 확률 둔화가 아니었다면 100% 적용 유지 (slowChance undefined = 100%)
      }
      if (m.dotSet) {
        w.dotDps = (w.dotDps ?? 0) + m.dotSet.dps;
        w.dotTicks = Math.max(w.dotTicks ?? 0, m.dotSet.ticks);
        if (m.dotSet.chance !== undefined) w.dotChance = m.dotSet.chance;
      }
      if (m.rootSet) {
        w.rootTicks = Math.max(w.rootTicks ?? 0, m.rootSet.ticks);
        if (m.rootSet.chance !== undefined) w.rootChance = m.rootSet.chance;
      }
      if (m.chillSet) w.chillTicks = Math.max(w.chillTicks ?? 0, m.chillSet.ticks);
      if (m.rootTicksAdd) w.rootTicks = (w.rootTicks ?? 0) + m.rootTicksAdd;
      if (m.rootChanceAdd && w.rootChance !== undefined) {
        w.rootChance = Math.min(100, w.rootChance + m.rootChanceAdd);
      }
      if (m.zoneTicksAdd && w.zone) w.zone = { ...w.zone, ticks: w.zone.ticks + m.zoneTicksAdd };
      if (m.lifestealAdd) w.lifestealPct = (w.lifestealPct ?? 0) + m.lifestealAdd;
      if (m.airMultiTargetsSet) w.airMultiTargets = m.airMultiTargetsSet;
      if (m.targetsSet) w.targets = m.targetsSet;
      if (m.zoneKindSet && w.zone) w.zone = { ...w.zone, kind: m.zoneKindSet };
      if (m.bonusAdd) {
        const merged: Partial<Record<BonusKey, number>> = { ...(w.bonus ?? {}) };
        for (const [k, v] of Object.entries(m.bonusAdd)) {
          merged[k as BonusKey] = (merged[k as BonusKey] ?? 0) + (v ?? 0);
        }
        w.bonus = merged;
      }
      weapon = w;
    }
  }
  const eff: EntityDef = {
    ...base, maxHp, armor, speed,
    ...(weapon ? { weapon } : {}),
    ...(heal ? { heal } : {}),
    ...(actives ? { actives } : {}),
    ...(regenPerSec ? { regenPerSec } : {}),
    ...(dodgePct ? { dodgePct } : {}),
  };
  return eff;
}

