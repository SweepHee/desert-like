import type { Rng } from './rng.ts';

/** 0 = 좌측(1팀), 1 = 우측(2팀). 레인 진행 방향을 결정한다. */
export type TeamId = 0 | 1;

export function enemyOf(team: TeamId): TeamId {
  return team === 0 ? 1 : 0;
}

export type RaceId = 'sylvarin' | 'pandemonium' | 'marionetta';

/** 봇 난이도. easy = 순정, normal = 인컴 이점, hard = 사람 플레이를 읽고 반응. */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/**
 * 봇 성격 — 게임 시작 시 봇마다 무작위 배정 (시드 기반, 결정론).
 * fastTech       빠른 테크 + 그리디 (초반을 버리고 경제·테크 몰빵)
 * rushThenGreedy 초반 물량 러시 → 몇 웨이브 후 그리디 전환
 * balanced       초·중·후반 고른 밸런스
 * finalOnly      최종테크 유닛만 — 테크 3 도달 후 최상급·최종만 뽑는다
 */
export type BotStyle = 'fastTech' | 'rushThenGreedy' | 'balanced' | 'finalOnly';

export type Tier =
  | 'basic' | 'novice' | 'mid' | 'high' | 'air' | 'supreme' | 'final'
  | 'structure' | 'guardian';

/**
 * 특성 태그 (docs/combat-traits-draft.md).
 * 장갑: cloth(천) / leather(가죽) / plate(판금) — 유닛당 1개
 * 존재: bio(생체) / undead(망자) / construct(기물) — 유닛당 1개
 * 보조: massive(거대), structure(구조물)
 * 비행 여부는 별도 플래그지만 보너스 키로는 쓸 수 있다.
 */
export type Tag =
  | 'cloth' | 'leather' | 'plate'
  | 'bio' | 'undead' | 'construct'
  | 'massive' | 'structure';
export type BonusKey = Tag | 'flying';

export type TargetCap = 'ground' | 'air' | 'both';

/**
 * 장판 종류. 효과 수치는 data.ts ZONE_DEFS 참조.
 * quake 이후는 효과 없는 시각 전용 (마법의 시전 자국·폭발 이펙트).
 */
export type ZoneKind = 'thorns' | 'spores' | 'forest' | 'grave' | 'blaze'
  | 'quake' | 'frost' | 'gravity' | 'hellfire' | 'fireburst' | 'feast';

/** 지면에 남는 지속 효과 영역. 근처 재시전 시 갱신되므로 위치·만료는 가변. */
export interface Zone {
  readonly id: number;
  readonly team: TeamId;
  readonly kind: ZoneKind;
  x: number;
  y: number;
  readonly radius: number;
  untilTick: number;
  /** 이 엔티티를 따라 움직이는 장판 (숲의 영역). -1 = 고정. 시전자 사망 시 그 자리에 남는다. */
  followId: number;
}

export interface Weapon {
  readonly damage: number;
  /** "+X vs 태그" 추가 피해. */
  readonly bonus?: Partial<Record<BonusKey, number>>;
  /** 공격 쿨다운 (틱). */
  readonly cooldown: number;
  /** FP 단위 사거리 (양쪽 반지름은 별도 가산). */
  readonly range: number;
  readonly targets: TargetCap;
  /** FP 단위 스플래시 반경. 명중 지점 주변 적 전체에 동일 피해. */
  readonly splash?: number;
  /** 명중 시 둔화 부여 (틱 수). 둔화 중엔 이속 60%, 공속 절반. */
  readonly slowTicks?: number;
  /** 둔화 부여 확률(%). 미지정이면 slowTicks 가 있을 때 100%. */
  readonly slowChance?: number;
  /** 명중 시 지속피해 (독/화상). dps 는 초당 피해. */
  readonly dotDps?: number;
  readonly dotTicks?: number;
  readonly dotChance?: number;
  /** 명중 시 속박 (이동 불가, 공격은 가능). */
  readonly rootTicks?: number;
  readonly rootChance?: number;
  /** 명중 시 한기 (공속·이속 -CHILL_PCT%). 둔화보다 약하지만 100% 적용. */
  readonly chillTicks?: number;
  /** 명중 지점에 장판 생성 (가시밭·포자 구름·숲의 영역 등). */
  readonly zone?: { readonly kind: ZoneKind; readonly radius: number; readonly ticks: number };
  /**
   * 공중 다중 사격 (숲의 명궁): 목표가 공중이면 사거리 안 공중 적을 최대 이 수까지 동시에 맞힌다.
   * 지상 목표에는 적용되지 않는다 (지상은 항상 단일 대상).
   */
  readonly airMultiTargets?: number;
  /** 방어력 무시 (망령류). */
  readonly ignoreArmor?: boolean;
  /** 입힌 피해의 몇 %를 회복하는가 (흡혈/시체 흡수). */
  readonly lifestealPct?: number;
}

/**
 * 액티브 스킬 (쿨다운제, MP 없음). 자율 전투이므로 발동 조건도 정의에 포함.
 * strike = 대상 강타 (처형기 등, 평타 스윙 대체)
 * selfbuff = 자가 강화 / allybuff = 주변 아군 공속 버프 / invuln = 일시 무적
 * summon = 유닛 소환 / confuse = 대상 혼란 / zone = 자기 위치에 장판 생성
 * taunt  = 주변 적이 나를 우선 공격하도록 강제 (탱커용)
 * allyarmor = 주변 아군 방어력 버프 (유니콘 「가호」)
 * weaken = 주변 적 공격력 감소 (유니콘 「날개짓」)
 * cure   = 주변 아군 1기의 디버프 즉시 해제 (유니콘 「큐어」)
 * sleep  = 대상 수면 — 아무것도 못 하지만 SLEEP_BREAK_HITS 회 피격 시 깨어남 (페어리)
 * ── 세이지 (원거리 지정형: castRange 안에서 목표를 고르고 splash 반경에 적용) ──
 * ground    = 「리버스그라비티」 범위 안 공중 적을 지상으로 끌어내림 (일정 시간 지상 판정)
 * slowfield = 「어스퀘이크」 범위 안 적 전원 둔화
 * freeze    = 「블리자드」 범위 안 적 빙결 (판금·거대·구조물은 면역)
 * zone + zoneAtTarget = 「블레이즈」 원격 지점에 장판 생성
 */
export interface ActiveSkill {
  readonly name: string;
  readonly desc: string;
  readonly cooldown: number; // 틱
  /** 이 업그레이드를 산 소유자만 사용 가능 (스킬 해금 — 세이지·앨리스). */
  readonly requiresUpgrade?: string;
  readonly kind:
    | 'strike' | 'selfbuff' | 'allybuff' | 'invuln' | 'summon' | 'confuse' | 'zone' | 'taunt' | 'nuke'
    | 'allyarmor' | 'weaken' | 'cure' | 'sleep'
    | 'ground' | 'slowfield' | 'freeze' | 'charm' | 'reflect' | 'fear';
  // strike: 스킬 피해 (방어 적용). executeBelowPct 가 있으면
  // 대상 체력이 그 % 이하일 때만 발동하고 executeBonus 를 더한다.
  readonly damage?: number;
  readonly splash?: number; // FP. 있으면 대상 주변 광역
  readonly executeBelowPct?: number;
  readonly executeBonus?: number;
  // 지속형 공통 (selfbuff/allybuff/invuln/confuse)
  readonly durTicks?: number;
  // selfbuff
  readonly atkSpeedPct?: number; // +40 = 공속 40% 증가 (allybuff 도 사용)
  readonly speedPct?: number;    // 이속 증가
  readonly armorAdd?: number;
  readonly holdGround?: boolean;      // 지속 중 이동 불가 (뿌리박기)
  /** reflect: 지속 중 받은 평타 피해의 몇 %를 공격자에게 되돌린다 (마법·독·장판은 제외). */
  readonly reflectPct?: number;
  readonly overheatSlowTicks?: number; // 종료 직후 둔화 (태엽 감기 과열)
  // allybuff / allyarmor / weaken / cure
  readonly auraRadius?: number; // FP
  /** 장판이 시전자를 따라 움직인다 (숲의 영역). */
  readonly zoneFollows?: boolean;
  /** 장판을 자기 자리가 아니라 castRange 안에서 고른 목표 지점에 깐다 (블레이즈). */
  readonly zoneAtTarget?: boolean;
  // summon — summonIds 가 여럿이면 소환할 때마다 무작위로 고른다 (결정론 rng)
  readonly summonId?: string;
  readonly summonIds?: readonly string[];
  readonly summonCount?: number;
  // nuke: 무기와 무관하게 쿨마다 터지는 원거리 마법.
  //  splash 0/미지정 = 단일 대상, castRange = 시전 사거리
  readonly castRange?: number;
  /** 발동 지점에 잠깐 남기는 시각 전용 장판 (폭발·마법진 이펙트). */
  readonly fxZone?: ZoneKind;
  /** 'highestHp' = 사거리 안에서 체력이 가장 많은 적을 노린다 (화염구). */
  readonly targetMode?: 'nearest' | 'highestHp';
  // zone
  readonly zone?: { readonly kind: ZoneKind; readonly radius: number; readonly ticks: number };
}

export interface HealAbility {
  readonly amount: number;
  readonly cooldown: number;
  readonly range: number;
  /** 이 태그를 가진 아군은 치료 불가 (예: 재봉사는 undead 수리 불가). */
  readonly excludeTags?: readonly Tag[];
}

export interface EntityDef {
  readonly id: string;
  readonly race: RaceId | null; // null = 구조물/수호자 등 종족 무관
  readonly name: string;
  readonly tier: Tier;

  readonly cost: number;
  /** 보급 점유 (초안에서는 상한 미적용, 예약 필드). */
  readonly supply: number;
  /** 요구 테크 오버라이드. 없으면 티어 기본값(techOfTier) 사용. */
  readonly techReq?: number;

  readonly maxHp: number;
  readonly armor: number;
  readonly tags: readonly Tag[];
  readonly flying: boolean;

  /** FP/틱. 0 = 이동 불가(구조물). */
  readonly speed: number;
  /** FP 충돌 반지름. */
  readonly radius: number;
  /** FP 적 탐지 거리. */
  readonly acquireRange: number;

  readonly weapon?: Weapon;
  readonly heal?: HealAbility;
  readonly actives?: readonly ActiveSkill[];

  /** 수호자용: 진군하지 않고 앵커 주변을 지킨다. */
  readonly leashed?: boolean;
  /** 소환으로만 나오는 유닛. 상점에 진열되지 않는다. */
  readonly summonOnly?: boolean;
  /**
   * 전투형 힐러: 다친 아군을 쫓아다니지 않고 진군을 유지한다 (세계수의 사도).
   * 치유는 사거리 안에 들어온 아군에게만 나간다.
   */
  readonly advancesWhileHealing?: boolean;
}

export interface Entity {
  readonly id: number;
  readonly defId: string;
  /** 소속 팀. 「인형의 실」(charm)로 게임 중 전향될 수 있다. */
  team: TeamId;
  /** 소유 플레이어 인덱스. 구조물/수호자는 -1. 전향 시 함께 바뀐다. */
  owner: number;

  /** FP 좌표. x = 진행축, y = 폭 방향(0이 중앙). */
  x: number;
  y: number;
  /** 리쉬 앵커 (수호자·구조물). */
  anchorX: number;
  anchorY: number;

  hp: number;
  cooldown: number;
  healCooldown: number;
  targetId: number; // -1 = 없음
  /** 마지막으로 나를 공격한 적 id. 보복 타겟팅에 사용. -1 = 없음. */
  lastAttackerId: number;
  /** 업그레이드가 반영된 유효 정의. 없으면 DEFS[defId] 사용. */
  defOv?: EntityDef;
  /** 이 틱까지 둔화 상태. */
  slowedUntil: number;
  /** 지속피해: 이 틱까지 dotDps(초당) 피해. */
  dotUntil: number;
  dotDps: number;
  /** 이 틱까지 속박 (이동 불가). */
  rootedUntil: number;
  /** 이 틱까지 기절 (이동+공격 불가). 유닛엔 아직 미배정, 엔진 지원만. */
  stunnedUntil: number;
  /** 액티브 스킬별 남은 쿨다운 (틱). def.actives 와 같은 인덱스. */
  skillCds: number[];
  /** 이 틱까지 자가 버프 지속 (selfbuff). */
  buffUntil: number;
  /** 이 틱까지 혼란 — 적아 구분을 잃고 자기 편을 공격한다 (치유·시전은 불가). */
  confusedUntil: number;
  /** 이 틱까지 군세강화 (공속 +10%). 중복 없음 — 갱신만. */
  atkBuffUntil: number;
  /** 이 틱까지 무적 (피해 0). */
  invulnUntil: number;
  /** 이 틱까지 숲의 가호 (숲의 영역 안 — 유닛별 강화). */
  forestUntil: number;
  /** 이 틱까지 도발당함 — tauntedBy 를 무조건 우선 공격한다. */
  tauntedUntil: number;
  tauntedBy: number;
  /** 이 틱까지 약화 — 가하는 피해 WEAKEN_PCT% 감소. */
  weakenedUntil: number;
  /** 이 틱까지 한기 — 공속·이속 -CHILL_PCT% (밴시 「절망의 울음」). */
  chilledUntil: number;
  /** 이 틱까지 공격 반사 (고어 테디 「가시 봉제」). 반사율은 스킬의 reflectPct. */
  reflectUntil: number;
  /** 이 틱까지 공포 — 싸움을 포기하고 자기 기지로 달아난다 (시계탑 톱니바퀴). */
  fearedUntil: number;
  /**
   * 이 틱까지 지상화 (「리버스그라비티」). 비행 유닛이 지상 판정을 받는다 —
   * 대지상 무기에 맞고, 지상 장판에 걸리고, 지상 유닛과 겹침 판정도 한다.
   */
  groundedUntil: number;
  /** 이 틱까지 빙결 (「블리자드」) — 이동·공격·치유·시전 전면 불가. */
  frozenUntil: number;
  /** 이 틱까지 수면 — 이동·공격·치유·시전 불가. 피격 SLEEP_BREAK_HITS 회면 즉시 해제. */
  sleepUntil: number;
  sleepHits: number;
  /** 이 틱까지 방어 버프 (유니콘 「가호」). 중복 없음 — 더 센 쪽으로 갱신. */
  armorBuffUntil: number;
  armorBuffAdd: number;
  /** 중복힐 상한용 1초 창: 시작 틱과 창 내 받은 힐 횟수 (최대 3). */
  healWindowStart: number;
  healsInWindow: number;
  alive: boolean;
}

export interface PlayerState {
  /** 0..5. 0-2 = 팀0 슬롯0-2, 3-5 = 팀1 슬롯0-2. */
  readonly idx: number;
  readonly team: TeamId;
  /** 팀 내 출정 순번 0..2. */
  readonly slot: number;
  readonly race: RaceId;
  /** AI 조종 여부. 멀티에서 이탈/복귀 시 게임 중에도 바뀔 수 있다 (동일 틱 적용). */
  isBot: boolean;

  money: number;
  incomeLevel: number;
  /** 이 틱이 되기 전까지 인컴 업그레이드 재구매 불가. */
  incomeCooldownUntil: number;
  /** 현재 테크 레벨 (1~3). 티어별 요구 레벨은 techOfTier() 참조. */
  techLevel: number;
  /** 연구 완료 예정 틱. -1 = 연구 중 아님. */
  techPendingUntil: number;
  /** 구매한 유닛 업그레이드 id 집합. */
  upgrades: Record<string, true>;
  /** defId → 구매 수량. 출정 때마다 이 구성 전체가 복제 스폰된다. */
  comp: Record<string, number>;
  /** 봇 의사결정 전용 난수 (전투 rng와 분리). */
  readonly botRng: Rng;
  /** 봇 성격 (시작 시 무작위 배정). 사람 플레이어에게는 의미 없음. */
  readonly botStyle: BotStyle;
}

export interface GameConfig {
  readonly seed: number;
  /**
   * 참가자 목록. 팀 인원이 서로 달라도 된다 (1:1, 1:3, 2:3 …).
   * 팀 내 출정 순번(slot)은 이 배열에 등장하는 순서로 정해진다.
   * 각 팀에 최소 1명은 있어야 한다.
   */
  readonly players: readonly { race: RaceId; isBot: boolean; team: TeamId }[];
  /** 맵 id (data.ts MAPS). 생략 시 기본 맵. */
  readonly mapId?: string;
  /** 봇 난이도. 생략 시 easy. */
  readonly botDifficulty?: BotDifficulty;
  /** 인컴 레벨 상한 오버라이드 (캠페인 초반 스테이지용). 생략 시 기본 상한. */
  readonly incomeCap?: number;
  /** 테크 레벨 상한 오버라이드. 생략 시 3. */
  readonly techCap?: number;
  /**
   * 팀 2(적) 봇이 우선적으로 뽑는 유닛 목록 (캠페인 스테이지 성향).
   * 목록의 유닛은 추첨 가중치가 크게 올라간다 — "이 스테이지는 공중 위주" 같은 연출.
   */
  readonly enemyPreferredUnits?: readonly string[];
  /**
   * 영웅 특성 (캠페인 「세계수의 축복」). 사람 플레이어에게만 적용된다.
   * 적 난이도 상승을 특성으로 되받는 구조 — 수치는 보수적으로.
   */
  readonly heroPerks?: HeroPerks;
}

/** 캠페인 영웅 특성 보정치. */
export interface HeroPerks {
  /** 내 유닛 최대체력 +% */
  readonly hpPct: number;
  /** 내 유닛 공격력 +% */
  readonly dmgPct: number;
  /** 시작 자금 가산 */
  readonly startMoney: number;
  /** 5초 인컴 틱마다 추가 수입 */
  readonly incomeAdd: number;
}

export interface GameEvent {
  readonly tick: number;
  readonly kind:
    | 'wave'          // slot 출정
    | 'towerDown'     // team 의 수호탑 파괴
    | 'guardianSpawn' // team 의 수호자 젠
    | 'guardianDown'
    | 'gameOver';
  readonly team?: TeamId;
  readonly slot?: number;
  readonly winner?: TeamId;
}

export interface Game {
  tick: number;
  rng: Rng;
  /** 맵 지오메트리 (data.ts MAPS[mapId]). 결정론: 같은 mapId 면 동일. */
  map: import('./data.ts').MapDef;
  /** 팀별 인원 수. 인덱스 = TeamId. 출정 로테이션 주기가 팀마다 다를 수 있다. */
  readonly teamSize: readonly [number, number];
  /** 봇 난이도 (createGame 시 확정). */
  readonly botDifficulty: BotDifficulty;
  /** 인컴·테크 레벨 상한 (전 플레이어 공통 — 봇 포함). */
  readonly incomeCap: number;
  readonly techCap: number;
  /** 팀 2 봇의 선호 유닛 (추첨 가중 상향). 빈 배열 = 성향 없음. */
  readonly enemyPreferredUnits: readonly string[];
  /** 영웅 특성 (없으면 null). */
  readonly heroPerks: HeroPerks | null;
  readonly players: PlayerState[];
  entities: Entity[];
  nextEntityId: number;
  /** 활성 장판 목록. */
  zones: Zone[];
  nextZoneId: number;
  /** 다음에 출정할 웨이브 인덱스 (0부터, slot = index % 3). */
  waveIndex: number;
  /**
   * 팀별 수호자 격파 여부. false 인 동안 그 팀의 넥서스는 무적이며 타겟도 되지 않는다.
   * (수호탑 → 수호자 → 넥서스 순으로만 진격 가능)
   */
  guardianDown: [boolean, boolean];
  /** 이번 스텝에서 발생한 이벤트 (매 스텝 초기화). 누적 로그는 호출측 책임. */
  events: GameEvent[];
  over: { winner: TeamId } | null;
}
