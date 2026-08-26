import type { Rng } from './rng.ts';

/** 0 = 좌측(1팀), 1 = 우측(2팀). 레인 진행 방향을 결정한다. */
export type TeamId = 0 | 1;
/**
 * 전투 팀: 0·1 은 플레이어 진영, 2 는 야생(중립적대) — 모두와 적대인 제3세력.
 * 야생은 유닛으로만 존재한다 (넥서스·타워·플레이어 없음).
 */
export type CombatTeam = TeamId | 2;

export function enemyOf(team: CombatTeam): TeamId {
  // 야생(2)의 "진군 목표 진영"은 팀 0 — 둥지를 향해 몰려온다
  if (team === 2) return 0;
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
/** 전투 판정용 재질·존재 태그. 무기 보너스(BonusKey)의 대상이 된다. */
export type CombatTag =
  | 'cloth' | 'leather' | 'plate'
  | 'bio' | 'undead' | 'construct'
  | 'massive' | 'structure';
/**
 * 성별 태그. 전투에는 전혀 관여하지 않고 연출(사망 음성 등)에만 쓰인다.
 * 인간형 유닛에만 붙이며, UI에는 노출하지 않는다.
 */
export type SexTag = 'male' | 'female';
/**
 * 지원가 — 힐·아군 버프·오라로 부대를 받치는 유닛.
 * 전투 판정에는 관여하지 않고, 「도약 강습」처럼 뒤를 치는 스킬의 우선 목표로 쓰인다.
 */
/**
 * 계열 태그 「요정」 — 오베론 「요정의 축복」이 고르는 대상.
 * 전투 판정에도, 화면 표시에도 나오지 않는 숨은 분류다.
 */
export type RoleTag = 'support' | 'fairy';
export type Tag = CombatTag | SexTag | RoleTag;
export type BonusKey = CombatTag | 'flying';

const SEX_TAGS: readonly string[] = ['male', 'female', 'support', 'fairy'];
/** 전투 판정에 쓰이는 태그만 통과 (성별·역할 태그는 제외). */
export function isCombatTag(t: Tag): t is CombatTag {
  return !SEX_TAGS.includes(t);
}

export type TargetCap = 'ground' | 'air' | 'both';

/**
 * 장판 종류. 효과 수치는 data.ts ZONE_DEFS 참조.
 * quake 이후는 효과 없는 시각 전용 (마법의 시전 자국·폭발 이펙트).
 */
export type ZoneKind = 'thorns' | 'spores' | 'forest' | 'grave' | 'blaze'
  | 'quake' | 'frost' | 'gravity' | 'hellfire' | 'fireburst' | 'feast'
  | 'threadstorm' // 드로셀마이어 「실의 폭풍」 — 시각 전용
  | 'moonveil'  // 오베론 「인분의 장막」 — 지속딜 + 공속·사거리 감소
  | 'stormwing' // 검은 폭풍 (검은새) — 하늘을 찢는 깃털바람, 시각 전용
  | 'meteor'    // 「메테오 스트라이크」 — 운석이 쏟아지는 하늘 (그림만, 피해는 시전 순간)
  | 'balm' // 치유 포자 (레쉬 캠페인 강화) — 적 둔화 + 아군 생체 회복
  | 'venom' // 역병 늪 (썩어가는 시체) — 밟으면 독 상태이상, 장판을 벗어나도 남는다
  | 'silverrain' // 은빛 화살비 (에버그린) — 지속피해 + 신성부식·치명상
  // ── 지형 해저드 (스킬이 아니라 맵에 처음부터 깔려 있는 것, MapDef.terrain) ──
  | 'mud'        // 진흙길 — 밟으면 느려진다
  | 'vinepath';  // 덩굴길 — 느려지고 가시에 긁힌다 (초당 피해)

/** 지면에 남는 지속 효과 영역. 근처 재시전 시 갱신되므로 위치·만료는 가변. */
export interface Zone {
  readonly id: number;
  readonly team: CombatTeam;
  readonly kind: ZoneKind;
  x: number;
  y: number;
  readonly radius: number;
  untilTick: number;
  /** 이 엔티티를 따라 움직이는 장판 (숲의 영역). -1 = 고정. 시전자 사망 시 그 자리에 남는다. */
  followId: number;
  /** 초당 피해 덮어쓰기 (강화 단계로 달라지는 장판 — 은빛 화살비). 0 = 기본값 사용. */
  dpsOverride: number;
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
  /** true 면 스플래시가 공중 타겟에만 터진다 — 지상은 단일 타격. */
  readonly splashAirOnly?: boolean;
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
  /**
   * 공중·지상 가리지 않는 다중 사격 — 사거리 안 적을 가까운 순 N기까지 각각 정타.
   * airMultiTargets 가 「공중 목표일 때만」인 것과 달리 항상 적용된다.
   */
  readonly multiTargets?: number;
  /**
   * 교차 사격 (엘로윈 「양손 시전」): 사거리 안의 지상 하나와 공중 하나를
   * 같은 스윙에 각각 정타로 맞힌다. 한쪽만 있으면 그쪽만 맞는다.
   * multiTargets 와 달리 「지상·공중을 하나씩」이라 물량에 휩쓸리지 않는다.
   */
  readonly crossTargets?: boolean;
  readonly airMultiTargets?: number;
  /**
   * 공중 대상 전용 사거리 (생략 = range 와 동일).
   * 모자장수처럼 「지상은 짧고 하늘은 멀리」가 성립하는 유닛용.
   */
  readonly airRange?: number;
  /** 공중 대상 전용 피해 (생략 = damage 와 동일). */
  readonly airDamage?: number;
  /** true 면 사거리 안에 공중이 있을 때 지상보다 먼저 노린다. */
  readonly preferAir?: boolean;
  /** true 면 하늘도 때리지만 목표는 늘 지상부터 고른다. */
  readonly preferGround?: boolean;
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
  /** 공격 적중 시 침묵 부여 틱 (엘루리온 해금 패시브). */
  readonly silenceTicks?: number;
  /** 치명타·버프를 받을 유닛을 이 id 목록으로 제한 (오베론 — 나비·페어리·오베론). */
  /** 버프 대상을 이 태그를 가진 유닛으로 제한 (오베론 — 요정 계열). */
  readonly onlyTag?: Tag;
  /** 대전·연습 전용 — 캐페인에선 발동하지 않는다. */
  readonly soloOnly?: boolean;
  /** seduce: 매혹 확률 % (기본 30). */
  readonly chancePct?: number;
  /** legion: 고정 구성 대량 소환 목록. */
  readonly legion?: readonly { readonly id: string; readonly n: number }[];
  /**
   * 시전하는 동안 자기 발이 묶인다 (invuln 등 방어 기술의 대가).
   * durTicks 만큼 이동만 막고 공격·다른 시전은 그대로다.
   */
  readonly rootsSelf?: boolean;
  readonly kind:
    | 'strike' | 'selfbuff' | 'allybuff' | 'invuln' | 'summon' | 'confuse' | 'zone' | 'taunt' | 'nuke'
    | 'allyarmor' | 'weaken' | 'cure' | 'sleep'
    | 'ground' | 'slowfield' | 'freeze' | 'charm' | 'reflect' | 'fear' | 'root'
    | 'seduce' | 'summonMare' | 'leap' | 'stealth' | 'purge' | 'legion' | 'sacrifice'
    // 마리오네타 확장 로스터
    | 'hasteAlly'    // 「초침 재촉」 주변 아군 공속·이속 증가
    | 'slowFoe'      // 「지각의 저주」 주변 적 공속·이속 감소
    | 'burrow'       // 「토끼굴」 땅속으로 숨는다 (무적·조준 불가)
    | 'timelock'     // 「멈춘 시계」 최고 티어 아군 1기에게 영구 상태이상 면역 (1회한)
    | 'critAura'     // 「정각의 일격」 주변 아군에게 치명타 확률 부여
    | 'randomBuff'   // 모자장수 — 발동할 때마다 다른 모자로 바뀜다
    | 'summonAtFoe'  // 드로셀마이어 — 적 후열 한가운데에 소환
    | 'levitate'     // 주변 아군 원거리·지원가를 공중으로 띄운다
    | 'threadStorm'  // 「실의 폭풍」 광역 속박 후 폭발 피해
    // 실바린 확장 로스터
    | 'wardShield'   // 드라이어드 — 적이 다가오면 주변 후열에 보호막
    | 'regenAura'    // 드라이어드 — 주변 아군 초당 체력 회복
    | 'selfShield'   // 엘루리온 — 자신에게 보호막 (다른 보호막과 합산)
    | 'airTaunt'     // 엘루리온 — 대공이 되는 적만 도발
    | 'ram'          // 엘루리온 — 대공 적에게 돌진해 박고 돌아온다
    | 'diveStrike'   // 오베론 — 적 후열로 도약 강타 후 제자리로
    | 'debuffZone'   // 오베론 — 지속딜 + 공속·사거리 감소 장판
    | 'puppetShow'   // 앨리스 「인형극」 — 주변 아군 기물을 복제
    | 'curtainCall'  // 앨리스 「커튼콜」 — 적을 빨아들였다 무대 밖으로 치운다
    | 'meteor';      // 엘로윈 「메테오 스트라이크」 — 넓은 지역에 운석 낙하 (화상·질식)
  // strike: 스킬 피해 (방어 적용). executeBelowPct 가 있으면
  // 대상 체력이 그 % 이하일 때만 발동하고 executeBonus 를 더한다.
  readonly damage?: number;
  readonly splash?: number; // FP. 있으면 대상 주변 광역
  /**
   * 범위 안에서 실제로 적용할 최대 대상 수 (가까운 순).
   * 광역 군중제어가 부대 전체를 한 번에 무력화하는 것을 막는다.
   */
  readonly maxTargets?: number;
  readonly executeBelowPct?: number;
  readonly executeBonus?: number;
  /** 공격 스킬(nuke 등)의 대상 제한. 생략 시 무기의 targets 를 따른다. */
  readonly targets?: TargetCap;
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
  /**
   * 차지 스킬 (엘로윈 「비전 축적」): 쿨다운이 다 돌면 사용 횟수가 하나씩 쌓여
   * 최대 이 수까지 모인다. 한 번 쓰면 chargeGap 만큼만 쉬고 바로 또 쓸 수 있다.
   */
  readonly charges?: number;
  /** 장판의 초당 피해를 이 값으로 덮어쓴다 (ZONE_DEFS 기본값 대신). */
  readonly zoneDps?: number;
  /** 차지를 연달아 쓸 때의 최소 간격 (틱). 생략 시 3초. */
  readonly chargeGap?: number;
  /** freeze: 이 태그들은 빙결 면역에서 제외한다 (얼려버린다). */
  readonly freezeAlsoTags?: readonly Tag[];
  /** 「화상」 — 맞은 적이 이 시간 동안 초당 dps 만큼 탄다 (독과 별개로 누적). */
  readonly burn?: { readonly dps: number; readonly ticks: number };
  /** 「질식」 부여 틱 — 액티브 사용 불가 + 상태이상 해제를 받지 못한다. */
  readonly chokeTicks?: number;
  // ── stealth 전용 (암살자 은신) ──
  /** 은신 중 평타 피해 가산. */
  readonly stealthDamageAdd?: number;
  /** 은신 중 이동 속도 가산 (FP/틱). */
  readonly stealthSpeedAdd?: number;
  /**
   * 은신 중에는 앞줄을 지나쳐 뒤를 노린다 —
   * 지원가 > 원거리 > 지금 체력이 가장 적은 적 순으로 목표를 다시 고른다.
   */
  readonly assassinate?: boolean;
}

export interface HealAbility {
  readonly amount: number;
  readonly cooldown: number;
  readonly range: number;
  /** 이 태그를 가진 아군은 치료 불가 (예: 재봉사는 undead 수리 불가). */
  readonly excludeTags?: readonly Tag[];
  /** 동시 회복 대상 수 (기본 1). 체력 비율이 낮은 순으로 여럿을 한 번에 돌본다. */
  readonly multi?: number;
}

export interface EntityDef {
  readonly id: string;
  readonly race: RaceId | null; // null = 구조물/수호자 등 종족 무관
  readonly name: string;
  readonly tier: Tier;

  readonly cost: number;
  /** 보급 점유 (초안에서는 상한 미적용, 예약 필드). */
  readonly supply: number;
  /**
   * 타고난 치명타 확률(%) — 버프 없이 항상 적용된다.
   * 「정각의 일격」 같은 일시 버프(critPct/critUntil)와는 별개로, 둘 중 높은 쪽이 쓰인다.
   */
  readonly baseCritPct?: number;
  /** 상태이상 전면 면역 (수호자와 같은 대우). */
  readonly statusImmune?: boolean;
  /**
   * 마법 면역 — 액티브 스킬의 피해·장판 효과가 전혀 통하지 않는다.
   *
   * 넥서스용. 방어력 28 로 「평타로는 못 깬다」를 만들어 놨는데 마법은 방어를
   * 우회하거나 광역으로 들어와 그 설계를 그냥 지나쳐 버렸다. 넥서스는 평타로만
   * 깎이게 못박는다.
   */
  readonly magicImmune?: boolean;
  /**
   * 피난민 — 싸우지 않고 맵 서쪽(x=0) 으로만 달아난다.
   *
   * 6 「자정의 마을」 전용. 적은 이들을 쫓아 죽이려 들고, 우리는 지나가는 길을
   * 지켜 줘야 한다. 진군 로직을 타지 않으므로 전선·수비선에도 걸리지 않는다.
   */
  readonly flees?: boolean;
  /**
   * 평타 주기 사이클 (틱). 한 발 쏠 때마다 다음 칸으로 넘어가며 순환한다 —
   * 엘로윈 「가속 시전」은 1.4초에서 0.6초까지 빨라졌다가 다시 느려진다.
   * 지정하면 weapon.cooldown 대신 이 값이 쓰인다 (공속 버프는 그 위에 곱해진다).
   */
  readonly cadence?: readonly number[];
  /**
   * 「마나 순환」 — 반경 안에서 적이 쓰러질 때마다 스택 1. need 를 채우면
   * 스택이 0으로 돌아가며 이 유닛의 액티브 쿨다운이 전부 초기화된다.
   */
  readonly skillReset?: { readonly need: number; readonly radius: number };
  /**
   * 곁에 아군이 없으면 싸움을 접고 기지로 물러난다 (이 타일 안에 아군이 없을 때).
   * 물러나는 동안은 이동 속도가 오른다 — 「혼자 남으면 살아 돌아가는」 영웅.
   */
  readonly loneFlee?: { readonly radius: number; readonly speedPct: number };
  /** 요구 테크 오버라이드. 없으면 티어 기본값(techOfTier) 사용. */
  readonly techReq?: number;

  readonly maxHp: number;
  readonly armor: number;
  readonly tags: readonly Tag[];
  readonly flying: boolean;

  /** FP/틱. 0 = 이동 불가(구조물). */
  readonly speed: number;
  /**
   * 유령 통행: 충돌 분리에서 완전히 제외 — 아무도 밀지 않고 밀리지도 않는다.
   * (보급 마차 — 나무·부대 사이에 끼지 않고 제 길을 간다. 레인 경계는 그대로)
   */
  readonly ghost?: boolean;
  /**
   * 전투에 띄어들지 않고 아군 본대를 따라다니는 유닛 (하얀토끼).
   * 적진으로 혼자 진군하지 않는다.
   */
  readonly followAlly?: boolean;
  /**
   * 정보창에 띄울 패시브 설명 — 코드로만 구현된 능력(오라·스택 등)은
   * actives 에 안 잡혀서 유닛 설명이 텅 빈 것처럼 보인다.
   */
  readonly passiveDesc?: readonly string[];
  /** 피격한 적에게 침묵을 거는 패시브 (틱) — 업그레이드로 붙는다. */
  readonly silenceOnHit?: number;
  /** 막타 스택 패시브 (오베론): 처치당 공격력 % 증가·최대 스택·지속. */
  readonly killStack?: { readonly pct: number; readonly max: number; readonly ticks: number };
  /** FP 충돌 반지름. */
  readonly radius: number;
  /** FP 적 탐지 거리. */
  readonly acquireRange: number;

  readonly weapon?: Weapon;
  readonly heal?: HealAbility;
  readonly actives?: readonly ActiveSkill[];

  /** 초당 체력 재생 (캠페인 강화 등으로 부여). 최대 체력까지만 회복. */
  readonly regenPerSec?: number;
  /**
   * 밀려나지 않는다 — 겹침 해소에서 자기는 안 밀리고 남만 민다.
   * 「덩치로 버티는」 보스용 (라다만토스).
   */
  readonly immovable?: boolean;
  /**
   * 주변 공중 적을 자기 쪽으로 끌어당긴다 (초당 이동량, FP).
   * 하늘에서 안전하게 쏘는 조합을 자기 품으로 끌어내리는 압박기.
   */
  readonly pullAir?: { readonly radius: number; readonly speed: number };
  /**
   * 「데몰리션」 — 몸에 붙은 적에게 계속 갈리는 피해 (초당, 방어력 무시).
   * 근접으로 붙어 패는 것 자체에 값을 매긴다.
   */
  readonly demolition?: { readonly radius: number; readonly dps: number };
  /**
   * 수호 오라 (영웅 강화 「수호의 맹세」) — 반경 안 아군이 받는 피해의 pct% 를
   * 대신 받아 낸다. 내가 무적이거나 쓰러져 있으면 나눠 받지 않는다.
   */
  readonly guardShare?: { readonly radius: number; readonly pct: number };
  /** 내가 받는 회복량 배수 % (영웅 강화 「생명의 그릇」). 100 = 두 배. */
  readonly healTakenPct?: number;
  /**
   * 치명타 피해 배율 범위(%) — [최소, 최대], 10% 단위로 무작위.
   * 생략 시 150 고정. 「꿰뚫는 한 발」이 이 범위를 넓힌다.
   */
  readonly critMulRange?: readonly [number, number];
  /** 영웅·네임드(소환 전용 최종 티어)에게 주는 추가 피해. */
  readonly bonusVsHero?: number;
  /**
   * 「바람의 춤」 — 적이 이 거리 안으로 들어오면 최대 사거리까지 물러나며 쏜다.
   * 물러나는 동안 이동 속도가 오르고 몸싸움을 하지 않는다 (모든 유닛을 통과).
   */
  readonly kiteDance?: { readonly speedPct: number };
  /** 「잎새의 장막」 — 피격 시 은신. [지속 틱, 쿨 틱]. */
  readonly veilOnHit?: { readonly durTicks: number; readonly cooldown: number };
  /**
   * 「숲의 가호」 나눠주기 — 전투에 들어가면 가까운 아군 N명에게 상태이상 면역을
   * 영구히 준다. 판당 한 번뿐 (다시 태어나야 재사용).
   */
  readonly wardGrant?: number;
  /** 평타 회피 확률 % (캠페인 강화). 마법·스킬·장판은 회피하지 못한다. */
  readonly dodgePct?: number;
  /**
   * 사망 시 1회 부활: delayTicks 동안 쓰러져 있다가 (무적·행동불능)
   * 최대 체력의 hpPct% 로 되살아난다 (검은새).
   */
  readonly rebirth?: { readonly delayTicks: number; readonly hpPct: number };
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
  /** 소속 팀. 「인형의 실」(charm)로 게임 중 전향될 수 있다. 2 = 야생(모두와 적대). */
  team: CombatTeam;
  /** 소유 플레이어 인덱스. 구조물/수호자는 -1. 전향 시 함께 바뀐다. */
  owner: number;

  /** FP 좌표. x = 진행축, y = 폭 방향(0이 중앙). */
  x: number;
  y: number;
  /** 리쉬 앵커 (수호자·구조물). */
  /**
   * 주둔 반경 (FP). 0 이면 보통 유닛.
   * 0 보다 크면 진군하지 않고 anchor 주변을 지킨다 — 적이 이 반경 안으로
   * 들어오면 물지만, 밖으로 나가면 쫓지 않고 제자리로 돌아온다.
   * 호위전 거점을 「적이 점거하고 있는」 상태로 만드는 데 쓴다.
   */
  garrisonR: number;
  /** 직전 틱 위치 — 「가려는데 못 가는」 상태를 재는 데만 쓴다. */
  lastX: number;
  lastY: number;
  /** 제자리에 묶여 있던 틱 수. 일정 시간 넘으면 잠시 서로를 통과한다. */
  stuckTicks: number;
  /** 이 틱까지는 다른 유닛과 몸싸움하지 않는다 (끼임 탈출). */
  phaseUntil: number;
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
  /**
   * 주둔지 — 이 자리를 지키는 유닛 (마을 수비대). -1 이면 없음.
   *
   * 진군하지 않고, 싸우다 자리를 벗어나도 되돌아온다. 플레이어의 집합지
   * 지정에도 따라가지 않는다 — 「내 부대가 아니라 마을이 세운 파수」다.
   */
  homeX: number;
  homeY: number;
  /** 지속피해: 이 틱까지 dotDps(초당) 피해. */
  dotUntil: number;
  dotDps: number;
  /** 이 틱까지 속박 (이동 불가). */
  rootedUntil: number;
  /** 이 틱까지 기절 (이동+공격 불가). 유닛엔 아직 미배정, 엔진 지원만. */
  stunnedUntil: number;
  /** 액티브 스킬별 남은 쿨다운 (틱). def.actives 와 같은 인덱스. */
  skillCds: number[];
  /** 액티브별 남은 차지 수 (charges 스킬 전용). 없는 스킬은 항상 0. */
  skillCharges: number[];
  /** 차지 재충전 타이머 (틱). 0 이 되면 차지 하나가 차오른다. */
  skillRegen: number[];
  /** 평타 주기 사이클(def.cadence)의 현재 위치. */
  cadenceIdx: number;
  /** 「마나 순환」 처치 스택 — need 를 채우면 0으로 돌아가며 쿨을 씻는다. */
  resetStacks: number;
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
  /** 이 틱까지 매혹 (서큐버스) — 공격·시전을 잊고 적진 한가운데로 걸어간다. */
  seducedUntil: number;
  /** 이 틱까지 은신 (인큐버스) — 조준·피해에서 완전히 제외된다. */
  stealthUntil: number;
  /** 이 틱까지 악마 변신 (서큐버스 각성) — 스탯이 defOv 로 뒤집혀 있다. */
  transformUntil: number;
  /** 이 틱까지 상태이상 면역 (인큐버스 「완전 해제」 후). */
  purgeImmuneUntil: number;
  /** 제물 흡수 스택 (인큐버스): 공격력 +10%/방어 +2 씩. */
  sacrificeStacks: number;
  /** 다음 제물 흡수/감쇠 판정 틱. */
  sacrificeNextTick: number;
  /** 내가 소환한 몽마 엔티티 id (서큐버스, -1 = 없음). */
  mareId: number;
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
  /** 본드래곤 「뼈 무덤」: 이 틱 이후에 죽어야 무덤을 남긴다 (부활 후 60초 대기). */
  graveReadyTick: number;
  /** 「인형의 실」로 전향된 유닛 — 새까마케 실루에으로 그려진다. */
  puppetized: boolean;
  /** 「커튼콜」로 무대 밖으로 치워진 상태의 만료 틱 (그 동안 전장에서 사라진다). */
  vanishUntil: number;
  /** 부활 사용 여부 + 부활 예정 틱 (rebirth 유닛 전용). */
  rebirthUsed?: boolean;
  reviveAtTick?: number;
  /** 이 틱까지 방어 버프 (유니콘 「가호」). 중복 없음 — 더 센 쪽으로 갱신. */
  armorBuffUntil: number;
  armorBuffAdd: number;
  /** 디멘터 오라 — 지금 받고 있는 유형 (0 = 없음, 1~4). 매 틱 재계산된다. */
  auraKind: number;
  /** 치명타 확률 % (「정각의 일격」). 0 = 없음. */
  critPct: number;
  critUntil: number;
  /** 땅속에 숨은 상태 만료 틱 (「토끼굴」). */
  buriedUntil: number;
  /** 영구 상태이상 면역 (「멈춘 시계」). */
  timeLocked: boolean;
  /** 임시 비행 만료 틱 (드로셀마이어 「부양」). */
  levitateUntil: number;
  /** 모자장수 랜덤 버프: 0=없음 1=빨강 2=파랑 3=거대화 4=황금(전부). */
  hatKind: number;
  hatUntil: number;
  /** 빨강 모자: 다음 태엽 병정 소환 틱. */
  hatSummonTick: number;
  /** 남은 보호막 (피해를 먼저 흡수한다). */
  shieldHp: number;
  /** 한 번이라도 보호막을 받은 적이 있는가 (디멘터 오라 — 영구 차단). */
  shieldEverGranted: boolean;
  /**
   * 보호막 재부여 면역 만료 틱 — 이 시각까지는 새 보호막을 못 받는다.
   * 드라이어드가 여러 마리여도 돌려가며 계속 걸어주지 못하게 막는다.
   */
  /** 보호막 만료 틱 (0 또는 MAX = 지속시간 없음). */
  shieldUntil: number;
  shieldImmuneUntil: number;
  /** 「신성부식」 만료 틱 — 언데드 전용. 회복이 그대로 피해가 된다. */
  holyRotUntil: number;
  /** 「치명상」 만료 틱 — 이 적에게 가하는 모든 공격이 치명타가 된다. */
  mortalUntil: number;
  /** 「잎새의 장막」 다음 발동 가능 틱. */
  veilReadyTick: number;
  /** 「숲의 가호」를 이미 나눠줬는가 (1회성). */
  wardGiven: boolean;
  /** 「숲의 가호」를 받아 상태이상 면역이 된 유닛. */
  warded: boolean;
  /** 치명타 버프 재부여 면역 만료 틱. */
  critImmuneUntil: number;
  /** 가호(방어 버프) 재부여 면역 만료 틱. */
  armorBuffImmuneUntil: number;
  /** 체력 재생 버프 (드라이어드) — 초당 회복량과 만료/면역. */
  regenPerSec: number;
  regenUntil: number;
  regenImmuneUntil: number;
  /** 침묵 — 액티브 스킬 사용 불가 (엘루리온). */
  silencedUntil: number;
  /** 「화상」 만료 틱과 초당 피해 — 독(dot)과 따로 누적된다. */
  burnUntil: number;
  burnDps: number;
  /** 「질식」 만료 틱 — 액티브 사용 불가 + 상태이상 해제(큐어)를 받지 못한다. */
  chokedUntil: number;
  /** 「인분의 장막」 안에 있는 동안 — 공속 -10%, 사거리 -1. */
  moonveilUntil: number;
  /** 막타 스택 (오베론) — 처치 할 때마다 공격력 +10%, 최대 10. */
  killStacks: number;
  killStackUntil: number;
  /** 대공 도발 — 대공이 되는 적만 이 유닛을 노리게 된다. */
  airTauntUntil: number;
  airTauntBy: number;
  /** 돌진·도약 뒤 제자리로 돌아갈 예약 (복귀 틱과 원래 좌표). */
  returnTick: number;
  returnX: number;
  returnY: number;
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
  /** 봇의 현재 저축 목표 유닛 (defId). 목표를 정하면 살 때까지 유지한다. */
  botGoal: string | null;
}

/**
 * 적 거점 (캠페인 「발타르의 성」류 다거점 스테이지).
 * 팀 1 의 봇 하나를 「거점」으로 보고, 출정 위치·경제·생산 목록을 따로 준다.
 * 사실상 1:N 싸움을 만드는 장치 — 거점마다 성격이 다르다.
 */
export interface EnemyCamp {
  /** 이 거점을 지키는 건물 id. 부서지면 이 거점의 증원이 끊긴다. */
  readonly nexusDefId?: string;
  /** 팀 1 안에서의 봇 순번 (players 배열의 팀1 등장 순서). */
  readonly slot: number;
  /** 화면에 띄울 이름 (「발타르의 성」·「전초 A」…). */
  readonly label?: string;
  /** 출정 좌표 (FP). 생략 시 기본 스폰 지점. */
  readonly x?: number;
  readonly y?: number;
  /** 시작 인컴 단계 (0 = 기본). */
  readonly startIncome?: number;
  /**
   * 인컴 상한. 지정하면 그 단계까지만 올릴 수 있다.
   * unlocks 로 특정 턴에 풀 수 있다.
   */
  readonly incomeCap?: number;
  /** 시작 자금. */
  readonly startMoney?: number;
  /** 출정 주기 (턴). 2 면 두 턴에 한 번 — C·D 처럼 모았다 치는 거점용. */
  readonly deployEveryWave?: number;
  /**
   * 턴 구간별 생산 목록. fromWave 오름차순으로 적고, 현재 턴 이하 중
   * 가장 늦은 구간이 적용된다. units 가 비면 그 구간엔 아무것도 못 산다.
   */
  readonly phases?: readonly {
    readonly fromWave: number;
    readonly units: readonly string[];
    /** 이 구간에서 특히 선호할 유닛 (가중 ×8). */
    readonly preferred?: readonly string[];
  }[];
  /**
   * 특정 턴에 인컴 상한을 푼다 (fromWave 오름차순).
   * setLevel 을 주면 그 단계까지만 시스템이 직접 올려 주고, 그 위로는 봇이
   * 스스로 번 돈으로 올린다 (생략 = cap 까지 한 번에 올려 준다).
   */
  readonly incomeUnlocks?: readonly {
    readonly fromWave: number;
    readonly cap: number;
    readonly setLevel?: number;
  }[];
  /** 매 턴 확정 편입 (fromWave 부터, 목록에서 amount 종을 골라 1기씩). */
  readonly forcedGrowth?: readonly {
    readonly fromWave: number;
    readonly units: readonly string[];
    /** 매 턴 편입할 종류 수 (기본 1). */
    readonly perWave?: number;
  }[];
  /**
   * 턴이 시작될 때마다 얹어 주는 보너스 자금 (fromWave 부터, 오름차순).
   * 인컴 상한만으로는 못 만드는 「후반에 갑자기 물량이 불어나는」 압박을 만든다.
   */
  readonly waveMoney?: readonly { readonly fromWave: number; readonly amount: number }[];
  /** true 면 출정 직전에 남은 돈을 전부 털어 병력을 산다. */
  readonly spendAll?: boolean;
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
   * 이 턴부터 적 봇이 1티어(기본) 유닛을 더 사지 않는다.
   *
   * 후반에도 잡졸이 계속 쌓여 화면이 유닛으로 뒤덮이는 것을 막는다.
   * 그 턴이 오면 살아 있던 1티어는 전부 사라지고 값이 주인에게 환불된다 —
   * 「돈만 날리고 병력이 증발」하면 봇이 갑자기 가난해져 판이 무너진다.
   */
  readonly enemyBasicCutoffWave?: number;
  /**
   * 편성 합치기 — 같은 유닛이 `per` 기 쌓이면 `to` 한 기로 바뀐다.
   *
   * 「목없는 기사 10기 → 마몬 1기」처럼 물량을 질로 접는다. 후반에 잡졸이
   * 무한히 쌓여 화면이 유닛으로 뒤덮이는 것을 막으면서, 전투력은 오히려 올린다.
   * 봇 편성에만 적용된다 (사람 플레이어의 편성은 건드리지 않는다).
   */
  readonly unitMerges?: readonly { readonly from: string; readonly per: number; readonly to: string }[];
  /**
   * 팀 2(적) 봇이 우선적으로 뽑는 유닛 목록 (캠페인 스테이지 성향).
   * 목록의 유닛은 추첨 가중치가 크게 올라간다 — "이 스테이지는 공중 위주" 같은 연출.
   */
  readonly enemyPreferredUnits?: readonly string[];
  /**
   * 팀 2(적) 유닛별 보유 수량 상한 (팀 합산). 캠페인에서 최상급 유닛이
   * 이른 스테이지에 쏟아지는 것을 막는다. 예: { m_gore_teddy: 1 }.
   */
  readonly enemyUnitCaps?: Readonly<Record<string, number>>;
  /** 적(팀1) 봇 구매 화이트리스트 — 지정 시 이 목록의 유닛만 생산한다. */
  readonly enemyAllowedUnits?: readonly string[];
  /**
   * 적(팀1) 봇 구매 금지 목록 — 화이트리스트보다 우선한다.
   * 특정 유닛을 "아직 등장할 때가 아니다"로 잠그는 용도.
   */
  readonly enemyDeniedUnits?: readonly string[];
  /** 캐페인 판인가 — 캐페인에서 막힌 스킬·해금을 가리는 데 쓴다. */
  readonly campaignMode?: boolean;
  /** 적 거점별 설정 (다거점 스테이지). */
  readonly enemyCamps?: readonly EnemyCamp[];
  /** 플레이어 출정 레인 초기값 (두 갈래 맵). */
  readonly deployLaneY?: number;
  /** 적(팀1) 봇 시작 자금 오버라이드. */
  readonly enemyStartMoney?: number;
  /**
   * 적(팀1) 봇 시작 테크 레벨 (1~TECH_MAX). 캠페인 전용 —
   * 처음부터 전 티어를 열어두고 등장 시점은 enemyUnitMinWave 로만 통제한다.
   * 테크가 이미 최대면 봇은 테크비를 쓰지 않으므로 그 돈이 전부 병력으로 간다.
   */
  readonly enemyStartTech?: number;
  /**
   * 적(팀1) 봇 인컴 배율 % (0 = 미지정). 지정 시 기본 인컴식에 곱하며,
   * 난이도별 인컴 보너스(normal +12/레벨)를 대체한다.
   */
  readonly enemyIncomePct?: number;
  /** 아군(팀0) 봇 유닛 수량 상한 (팀 합산) — 캠페인에서 아군 물량 폭주 방지. */
  readonly allyUnitCaps?: Readonly<Record<string, number>>;
  /** 팀 2 유닛별 최소 등장 웨이브 — 이 턴이 되기 전엔 봇이 구매할 수 없다. */
  readonly enemyUnitMinWave?: Readonly<Record<string, number>>;
  /** 이 웨이브부터 enemyUnitCaps 가 전부 해제된다 (후반 총력전). 생략 시 영구. */
  readonly enemyCapsUntilWave?: number;
  /** 팀 2 봇의 성격 강제 (캠페인 스테이지 디자인용). 생략 시 시드 무작위. */
  readonly enemyBotStyle?: BotStyle;
  /** 팀 2 수호자 교체 (캠페인 테마 보스). 생략 시 기본 수호자(GUARDIAN_OF). */
  readonly enemyGuardian?: string;
  /** 팀 1(아군) 봇의 성격 강제 — 앨리스 군단이 저축형에 걸려 생산을 멈추는 것 방지. */
  readonly allyBotStyle?: BotStyle;
  /**
   * 팀 1(사람 편) 이 쓸 수 있는 유닛 화이트리스트 — 캠페인 해금 단계.
   * 아군 봇도 이 범위 안에서만 산다. 빈 배열/생략 = 제한 없음.
   */
  readonly allowedUnits?: readonly string[];
  /**
   * 캠페인 유닛 강화(BOONS) 선택 목록 — 사람 플레이어의 유닛에만 적용된다.
   * 스테이지 클리어 보상으로 하나씩 고르며, 언제든 다시 고를 수 있다.
   */
  readonly unitBoons?: readonly string[];
  /**
   * 용병 목록 — 팀 0(사람 편)이 종족과 무관하게 구매할 수 있는 유닛 (캠페인 전용).
   * 탐욕의 계곡: 마몬이 판데모니엄 용병을 판다.
   */
  readonly mercUnits?: readonly string[];
  /** 용병 가격 배율 % (기본 100 = 정가). */
  readonly mercCostPct?: number;
  /**
   * true 면 「마몬의 상점」을 점령한 팀만 용병을 살 수 있다 (양 팀 공통 규칙).
   * 점령 판정은 캠페인 레이어가 하고 g.mercOwner 로 알려준다.
   */
  readonly mercCaptureRequired?: boolean;
  /**
   * 팀 0 진군 상한 x (FP, 캠페인 디펜스전). 부대가 이 선 너머로 진격하지 않고
   * 수비선을 유지한다. 생략 시 제한 없음.
   */
  readonly holdLineX?: number;
  /**
   * 수비 모드 (둥지 방어): 팀 0 유닛이 진군하지 않고 넥서스 주변에 대기하다가,
   * 넥서스 쪽으로 접근하는 적이 있으면 그리로 마중 나가 요격한다.
   */
  readonly defendNexus?: boolean;
  /** 팀 0 전원이 매 웨이브 함께 출정 (공동 전선 — 12스테이지 앨리스 연합). */
  readonly jointDeploy?: boolean;
  /**
   * 아군 봇(팀 0, isBot)의 출정 위치 오버라이드 (FP) — 합류점 맵에서
   * 앨리스 군단이 위 갈래에서 출정해 내려오도록.
   */
  readonly allyDeploy?: { readonly x: number; readonly y: number };
  /**
   * 영웅 특성 (캠페인 「세계수의 축복」). 사람 플레이어에게만 적용된다.
   * 적 난이도 상승을 특성으로 되받는 구조 — 수치는 보수적으로.
   */
  readonly heroPerks?: HeroPerks;
  /**
   * 양 진영 넥서스 방어력 오버라이드 (캠페인 전용). 생략 시 기본값(28).
   *
   * 기본 28 은 「기본 유닛 평타 = 1」이 되게 맞춘 값이라, 공중으로만 닿는 판
   * (5 올빼미 성채)에서는 숲올빼미·거대 나비로 넥서스를 깰 수가 없다.
   * 그런 판에서 이 값을 낮춰 하늘로도 넥서스를 부술 수 있게 한다.
   */
  readonly nexusArmor?: number;
  /**
   * 수호탑을 아예 세우지 않는다 (캠페인 noTowers 스테이지).
   *
   * 예전엔 게임을 만든 뒤 클라에서 탑을 걷어냈는데, 그 사이 한 프레임이
   * 그려져 「없어야 할 건물이 잠깐 보였다가 파괴 연출과 함께 사라지는」
   * 그림이 나왔다. 아예 만들지 않는 쪽이 맞다.
   */
  readonly noTowers?: boolean;
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
  /** 수급량 가산 (천분율 — 5 = +0.5%). 세계수 레벨 보너스. */
  readonly incomePermille?: number;
  /** 내 유닛 방어력 가산 */
  readonly armorAdd?: number;
  /** 내 유닛 공격 속도 +% (평타 쿨 감소) */
  readonly atkSpeedPct?: number;
  /** 내 유닛 이동 속도 +% */
  readonly moveSpeedPct?: number;
  /** 내 유닛 액티브 쿨타임 -% */
  readonly cdrPct?: number;
  /** 내 유닛 배치 시 기본 보호막 */
  readonly shieldAdd?: number;
  /** 사람 플레이어의 인컴 단계 상한 + (기본 8 → 최대 11) */
  readonly incomeCapAdd?: number;
}

export interface GameEvent {
  readonly tick: number;
  readonly kind:
    | 'wave'          // slot 출정
    | 'towerDown'     // team 의 수호탑 파괴
    | 'guardianSpawn' // team 의 수호자 젠
    | 'guardianDown'
    | 'boneRevive'    // 「뼈 무덤」에서 본드래곤이 다시 일어섰다 (렌더 연출용)
    | 'gameOver';
  readonly team?: TeamId;
  readonly slot?: number;
  readonly winner?: TeamId;
  /** boneRevive: 되살아난 자리 (FP). */
  readonly x?: number;
  readonly y?: number;
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
  /** 적 1티어 생산 중단 턴 (0 = 없음). */
  readonly enemyBasicCutoffWave: number;
  /** 편성 합치기 규칙 (봇 전용). */
  readonly unitMerges: readonly { readonly from: string; readonly per: number; readonly to: string }[];
  /** 이미 환불을 끝냈는가 (한 번만 돈다). */
  basicRefunded: boolean;
  /** 거점 확보로 사람 플레이어가 얻는 인컴 가산 (정산 1회당 골드). */
  captureIncomeAdd: number;
  /** 팀 2 봇의 선호 유닛 (추첨 가중 상향). 빈 배열 = 성향 없음. */
  readonly enemyPreferredUnits: readonly string[];
  /** 팀 2 유닛별 수량 상한 (팀 합산). 빈 객체 = 무제한. */
  readonly enemyUnitCaps: Readonly<Record<string, number>>;
  readonly allyUnitCaps: Readonly<Record<string, number>>;
  readonly enemyAllowedUnits: readonly string[];
  readonly enemyDeniedUnits: readonly string[];
  readonly campaignMode: boolean;
  readonly enemyCamps: readonly EnemyCamp[];
  /**
   * 플레이어(팀0) 출정 레인 — 두 갈래 맵에서 어느 쪽으로 내보낼지.
   * y 오프셋(FP). 0 = 중앙. 클라이언트가 땅을 눌러 바꾼다.
   */
  deployLaneY: number;
  /**
   * 「기지에 머무르기」 — 사람 플레이어(팀0)가 이번 턴 출정을 미룬다.
   * 미룬 턴 수만큼 다음 출정에 한꺼번에 쏟아진다 (모았다가 한 번에 밀기).
   */
  deployHold: boolean;
  /** 머무르며 쌓인 턴 수. 출정하는 순간 0 으로 돌아간다. */
  deployHeld: number;
  /** 이번 틱에 터진 치명타 위치 (렌더 전용 — 매 틱 비워진다). */
  crits: { x: number; y: number; tick: number }[];
  /** 「실의 폭풍」 지연 폭발 예약. */
  threadBooms: { x: number; y: number; tick: number; dmg: number; team: CombatTeam; r: number }[];
  /** 「뼈 무덤」 부화 대기열. */
  boneGraves: { graveId: number; hatchTick: number; team: CombatTeam; owner: number }[];
  /** 「커튼콜」 닫힘 예약 — 그 시각에 무대 위 적을 잠시 치운다. */
  curtainCalls: { x: number; y: number; r: number; closeTick: number; hideTicks: number; team: CombatTeam }[];
  readonly enemyIncomePct: number;
  /** 팀 2 유닛별 최소 등장 웨이브. 빈 객체 = 제한 없음. */
  readonly enemyUnitMinWave: Readonly<Record<string, number>>;
  /** 이 웨이브부터 수량 상한 해제. Infinity = 영구 적용. */
  readonly enemyCapsUntilWave: number;
  /** 팀 2 수호자 defId 오버라이드 (null = 기본). */
  readonly enemyGuardian: string | null;
  /** 팀 1 유닛 화이트리스트 (빈 배열 = 제한 없음). */
  /** 사람 플레이어가 살 수 있는 유닛. 판 도중 해금이 있어 읽기 전용이 아니다. */
  allowedUnits: string[];
  /** 캠페인 유닛 강화 id 목록 (사람 플레이어 전용). */
  readonly unitBoons: readonly string[];
  /** 팀 0이 종족 무관 구매 가능한 용병 목록. */
  readonly mercUnits: readonly string[];
  /** 용병 가격 배율 %. */
  readonly mercCostPct: number;
  /** 용병 구매에 상점 점령이 필요한가. */
  readonly mercCaptureRequired: boolean;
  /**
   * 팀 0 진군 상한 x (0 = 제한 없음). mutable — 호위(페이로드) 미션에서
   * 거점을 점령할 때마다 캠페인 레이어가 전선을 앞으로 민다.
   */
  holdLineX: number;
  /**
   * 팀 0 부대의 집결 지점 (FP). 0 이면 없음.
   * 호위전에서 「지금 점령할 거점」을 가리킨다 — 부대가 마차와 똑같은 길로
   * 거점을 하나씩 경유하게 만든다 (넥서스 직행 흐름장은 거점 앞을 스쳐 지나갔다).
   */
  rallyX: number;
  rallyY: number;
  /**
   * 적(팀1)이 노리는 지점. 0 이면 평소대로 아군 넥서스 방향으로 밀고 온다.
   *
   * 마을 방어전(6)처럼 넥서스가 없는 판에서는 「어디를 치러 오는가」를 따로
   * 정해 줘야 한다 — 안 그러면 넥서스가 있던 자리(맵 서쪽 끝)로 마을을 스쳐 지나간다.
   */
  foeGoalX: number;
  foeGoalY: number;
  /** 피난민(flees)이 향하는 탈출구. 0 이면 맵 서쪽 끝. */
  fleeX: number;
  fleeY: number;
  /**
   * 팀 1 진군 하한 x (0 = 제한 없음). mutable — 호위전에서 적이 현재 다툼 중인
   * 거점에 멈춰 서서 점거하게 한다 (그냥 지나쳐 우리 기지로 달려가지 않도록).
   */
  enemyHoldLineX: number;
  /** 수비 모드 (팀 0 넥서스 방어 AI). */
  readonly defendNexus: boolean;
  /** 팀 0 전원 동시 출정. */
  readonly jointDeploy: boolean;
  /** 아군 봇 출정 위치 오버라이드 (null = 기본 spawnX). */
  readonly allyDeploy: { readonly x: number; readonly y: number } | null;
  /** 현재 상점을 점령한 팀 (-1 = 없음). 캠페인 레이어가 갱신한다. */
  mercOwner: TeamId | -1;
  /** 점령 시도 중인 팀 (-1 = 없음). 캠페인 레이어가 갱신한다. */
  mercCapturingTeam: TeamId | -1;
  /** 점령 진행 틱 (10초 = 200틱 채우면 전환). */
  mercCaptureTicks: number;
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
