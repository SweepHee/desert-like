/**
 * 실바린 캠페인 「자정의 세계수」 — 18스테이지.
 * 시나리오 원본: docs/campaign-sylvarin.md
 *
 * 구조: 스테이지 데이터(해금 유닛·적 구성·미션·대사) + 진행 저장(localStorage)
 * + 대화 오버레이. 전투 자체는 기존 솔로(봇전) 엔진을 그대로 쓴다 —
 * 캠페인 레이어는 상점 필터·승리 조건·시드만 오버라이드한다.
 */
import { FP } from '@desertlike/sim';
import type { BotDifficulty, EntityDef, HeroPerks, RaceId, TeamId } from '@desertlike/sim';

/** 영웅 강화가 정의를 갈아 끼울 때만 쓰는 얕은 가변 사본 타입. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** 타일·초 — 영웅 강화 수치 계산용 (FP 는 타일 하나). */
const TILE = FP;
const SEC = 20;

export interface DialogueLine {
  readonly who: string;   // 화자 이름 (PORTRAITS 키). '' = 내레이션
  readonly text: string;
  /**
   * 컷신 그림 — 대화창 위에 시네마틱 장면을 띄운다.
   * 지정하면 그때부터 그 그림이 유지되고, '' 을 주면 걷어낸다.
   * (지정 안 한 줄은 직전 그림을 그대로 이어받는다)
   */
  readonly img?: string;
  /**
   * 대화창에서 설 자리를 이 줄에서만 덮어쓴다.
   *
   * RIGHT_SIDE 는 화자 단위라 「나중에 합류하는 중립」을 못 다룬다 — 브리아는
   * 4에서는 통행료 받는 남이고 8부터는 아군이라, 같은 사람이 판마다 자리를
   * 바꿔야 한다. 합류 전 판의 대사에만 'right' 를 달아 준다.
   */
  readonly side?: 'left' | 'right';
}

export interface CampaignStage {
  readonly id: number;    // 1..18
  readonly act: 1 | 2 | 3;
  readonly title: string;
  readonly goal: string;  // 전투 중 상단에 표시되는 목표 한 줄
  readonly briefing: readonly DialogueLine[];
  readonly outro: readonly DialogueLine[];
  /** 이 스테이지에서 상점에 열리는 실바린 유닛 (누적 명시). */
  readonly allowedUnits: readonly string[];
  /** 적 봇 구성 (팀 2). */
  readonly enemies: readonly RaceId[];
  /** 아군 봇 구성 (팀 1, 나 제외). */
  readonly allies: readonly RaceId[];
  readonly botDifficulty: BotDifficulty;
  /**
   * destroy = 적 넥서스 파괴 / survive = surviveSec 버티면 승리 (먼저 부숴도 승리)
   * tower   = 적 수호탑만 부수면 승리 (수호자가 깨어나는 순간 클리어 — 초반 스테이지용)
   */
  readonly mission: 'destroy' | 'survive' | 'tower' | 'boss';
  /**
   * 전장 장애물 — 무적·부동 소품 (불타는 나무 등). 아무도 조준하지 않지만
   * 지상 유닛의 충돌 분리에 걸려 실제로 길을 막는다. yOffTile 은 레인 중앙 기준.
   */
  readonly obstacles?: readonly { readonly defId: string; readonly xTile: number; readonly yOffTile: number }[];
  /**
   * 호위(페이로드) 미션: 보급 마차가 거점을 차례로 점령하며 전진한다.
   * - 마차가 거점 반경 안 + 적 없음 → 점령 게이지 진행 (captureSec 채우면 확보)
   * - 적만 반경 안에 loseSec 초 → 거점 상실, 마차는 직전 거점으로 후퇴
   * - 아군 부대는 현재 목표 거점까지만 진군해 대기 (holdLineX)
   * - 전 거점 확보 시 전선 해제 → 넥서스 총공격
   */
  readonly escort?: {
    readonly pointsXTile: readonly number[];
    readonly captureSec: number;
    readonly loseSec: number;
    readonly radiusTiles: number;
    readonly cartDefId: string;
    /** 전 거점 확보 시 적 넥서스 앞에 등장하는 네임드 (연출 이벤트). */
    readonly onCompleteSpawn?: { readonly defId: string; readonly label: string };
    /**
     * 최종 보스와 함께 나타나는 호위 병력.
     *
     * 보스 하나만 세워 두면 쌓아 온 부대에 순식간에 녹는다 — 마지막 마디는
     * 「보스전」이 아니라 「보스 군단전」이어야 한다.
     */
    readonly onCompleteRetinue?: readonly { readonly defId: string; readonly count: number }[];
    /** 전 거점 확보 시 전투를 멈추고 띄우는 컷신 대화. */
    readonly onCompleteDialogue?: readonly DialogueLine[];
    /**
     * 거점마다 처음부터 눌러앉아 있는 적 주둔 부대 (거점 순서대로).
     * 진군하지 않고 그 자리를 지킨다 — 밀어내야 점령 게이지가 오른다.
     * 생략하거나 빈 배열이면 그 거점은 무주공산.
     */
    readonly garrisons?: readonly (readonly { readonly defId: string; readonly count: number }[])[];
    /** 주둔 부대가 지키는 반경 (타일). 이 밖으로는 적을 쫓지 않는다. */
    readonly garrisonRadiusTiles?: number;
    /**
     * 거점을 확보할 때마다 도착하는 아군 지원군 (거점 순서대로).
     *
     * 이게 없으면 「버티며 인컴·테크만 올리는」 쪽이 언제나 이득이라,
     * 초반 압박만으로 균형을 잡으려다 「약하면 그리디, 세면 아무것도 못 함」의
     * 딜레마에 빠진다. 밀어붙이는 것 자체에 값을 붙여 정면으로 경쟁시킨다.
     * 확보한 거점 자리에 바로 나타나므로 다음 거점 공략에 곧장 합류한다.
     */
    readonly captureReinforcements?: readonly (readonly { readonly defId: string; readonly count: number }[])[];
    /**
     * 확보한 거점이 「매 턴」 내보내는 부대 (거점 순서대로).
     *
     * captureReinforcements 는 확보하는 순간 한 번뿐이라, 뒤 거점을 밀 때쯤이면
     * 그 보상이 이미 다 녹아 있었다. 확보한 거점이 계속 값을 하도록 매 턴
     * 소규모 부대를 보낸다 — 확보 보상보다 훨씬 작게 잡는다 (화면이 터진다).
     */
    readonly pointWaveSquads?: readonly (readonly { readonly defId: string; readonly count: number }[])[];
    /** 거점 하나당 사람 플레이어가 얻는 인컴 가산 (정산 1회당 골드). */
    readonly pointIncomeAdd?: number;
  };
  /** boss 미션: 이 유닛을 처치하면 승리. 게임 시작 시 적 진영에 젠 된다. */
  readonly bossDefId?: string;
  /** 적 넥서스 제거 — 파괴 목표가 없는 보스전용 (적 봇 생산은 계속된다). */
  readonly noEnemyNexus?: boolean;
  /** 아군 봇 출정 위치 (타일) — 합류점 맵에서 앨리스 군단이 위 갈래에서 나온다. */
  readonly allyDeployTile?: { readonly x: number; readonly y: number };
  readonly surviveSec?: number;
  readonly seed: number;
  readonly startMoney?: number;
  /**
   * 마을 방어전 (6 「자정의 마을」).
   *
   * 넥서스가 아예 없는 판이다. 지켜야 하는 것은 집 네 채와, 매 턴 서쪽으로
   * 빠져나가는 주민 행렬이다. 집이 전부 무너지거나 주민이 loseDeaths 명
   * 죽으면 그 자리에서 패배 — 시간을 버티는 것만으로는 이기지 못한다.
   */
  readonly village?: {
    /** 집 네 채 (부술 수 있는 실물). */
    readonly houses: readonly { readonly defId: string; readonly xTile: number; readonly yOffTile: number }[];
    /** 이만큼 죽으면 패배. */
    readonly loseDeaths: number;
    /** 주민이 이 x(타일) 아래로 가면 탈출 성공 — 화면에서 지운다. */
    readonly escapeXTile: number;
  };
  /** true = 양 팀 넥서스를 아예 두지 않는다 (마을 방어전). */
  readonly noNexus?: boolean;
  /** true = 수호탑·수호자 없이 넥서스전만 (탑 제거 + 넥서스 보호막 해제). */
  readonly noTowers?: boolean;
  /** 인컴·테크 상한 (전원 공통 — 봇 포함). 생략 시 기본. */
  readonly incomeCap?: number;
  readonly techCap?: number;
  /** 이 턴부터 적 봇이 1티어를 사지 않고, 그 시점의 1티어는 전액 환불된다. */
  readonly enemyBasicCutoffWave?: number;
  /** 편성 합치기 — 같은 유닛이 per 기 모이면 to 한 기로 접힌다 (봇 전용). */
  readonly unitMerges?: readonly { readonly from: string; readonly per: number; readonly to: string }[];
  /** 적 봇이 압도적으로 선호하는 유닛 (스테이지 성향 — 예: 공중 스테이지). */
  readonly enemyPreferredUnits?: readonly string[];
  /** 적 유닛별 보유 상한 (팀 합산) — 최상급 유닛의 조기 물량화 방지. */
  readonly enemyUnitCaps?: Readonly<Record<string, number>>;
  /** 아군(팀0) 봇 유닛 수량 상한 (팀 합산) — 아군 물량 폭주 방지. */
  readonly allyUnitCaps?: Readonly<Record<string, number>>;
  /** 적(팀1) 봇 구매 화이트리스트 — 지정 시 이 목록만 생산. */
  readonly enemyAllowedUnits?: readonly string[];
  /** 적(팀1) 봇 시작 자금. */
  readonly enemyStartMoney?: number;
  /** 적(팀1) 봇 시작 테크 (1~3). 전 티어를 미리 열고 등장은 minWave 로만 통제. */
  readonly enemyStartTech?: number;
  /**
   * 이 스테이지에서만 잠금을 푸는 유닛 (LOCKED_ENEMY_UNITS 중에서 고른다).
   * 여기 적힌 유닛만 봇 생산·출현 이벤트·growth 에 다시 등장한다.
   */
  readonly unlockEnemyUnits?: readonly string[];
  /**
   * 두 갈래 맵의 출정 레인 — 빈 땅을 누르면 그쪽으로 부대를 보낸다.
   * yTile = 중앙선 기준 오프셋(타일).
   */
  readonly deployLanes?: readonly { readonly yTile: number; readonly label: string }[];
  /** true = 판이 시작될 때 「가운데 대기」로 시작한다 (길을 고를 때까지 출정하지 않는다). */
  readonly deployStartHold?: boolean;
  /** 적 거점 설정 (다거점 스테이지). */
  readonly enemyCamps?: readonly import('@desertlike/sim').EnemyCamp[];
  /** 적(팀1) 봇 인컴 배율 % (난이도 인컴 보너스 대체). */
  readonly enemyIncomePct?: number;
  /** 적 유닛별 최소 등장 웨이브 (이 턴 전엔 구매 불가). */
  readonly enemyUnitMinWave?: Readonly<Record<string, number>>;
  /** 이 웨이브부터 적 유닛 상한 전부 해제 (후반 총력전). */
  readonly enemyCapsUntilWave?: number;
  /** 적 봇 성격 강제 ('fastTech'|'rushThenGreedy'|'balanced'|'finalOnly'). */
  readonly enemyBotStyle?: import('@desertlike/sim').BotStyle;
  /** 아군 봇 성격 강제 — 저축형(finalOnly)에 걸리면 아군이 생산을 안 한다. */
  readonly allyBotStyle?: import('@desertlike/sim').BotStyle;
  /** 팀 0 전원 동시 출정 (공동 전선). */
  readonly jointDeploy?: boolean;
  /** 적 수호자 교체 — 2막 마리오네타 스테이지는 특제 대형 곰인형. */
  readonly enemyGuardian?: string;
  /**
   * 제한 턴 — 이 턴까지 클리어하지 못하면 패배.
   * 장기전으로 흘러 끝이 안 나는 스테이지에 마감을 준다.
   */
  readonly deadlineWave?: number;
  /** 용병 목록 — 이 스테이지에서 종족 무관 구매 가능한 유닛 (마몬의 장사). */
  readonly mercUnits?: readonly string[];
  /** 용병 가격 배율 % (기본 100). */
  readonly mercCostPct?: number;
  /** 맵 중앙 「마몬의 상점」 점령제 — 점령한 팀만 용병을 산다 (적도 동일). */
  readonly mercCaptureRequired?: boolean;
  /** 적(팀1) 건물 스킨 ('toy' = 장난감, 'bone' = 사령). */
  readonly enemySkin?: 'toy' | 'bone';
  /**
   * 전투 중 컷신: 지정 시각에 전투를 멈추고 대사를 띄운다 (네임드 등장 연출).
   * 대사가 끝나면 자동으로 전투가 재개된다.
   */
  readonly cutscenes?: readonly {
    readonly atSec: number;
    readonly lines: readonly DialogueLine[];
  }[];
  /**
   * 캠페인 전용 특수 유닛 스폰 스크립트.
   * atSec = 1회성 등장 시각 / everySec = 반복 주기 (첫 등장도 everySec 시점).
   */
  readonly spawns?: readonly {
    readonly defId: string;
    readonly label: string;      // 경고 배너에 뜨는 이름
    readonly atSec?: number;
    readonly everySec?: number;
    /** 이 시각(초) 이후로는 더 나오지 않는다 — 후반에 다른 보스로 교체할 때. */
    readonly untilSec?: number;
    readonly count?: number;     // 기본 1
    /**
     * 이 규칙이 스폰할 총 마릿수 상한 (생략 = 무제한).
     * 반복 스폰은 상한이 없으면 후반에 무한 누적된다 — 승산이 사라진다(실측).
     */
    readonly maxTotal?: number;
    /** 스폰 x 위치 (타일). 생략 시 적 스폰 지점. */
    readonly atXTile?: number;
    /** 스폰 y 오프셋 (타일, 레인 중앙 기준). 방향 연출용 (12시 = 음수). */
    readonly yOffTile?: number;
    /** 야생 무리: 제3팀(2)으로 스폰 — 자기들끼리 한 편, 나머지 모두와 적대. */
    readonly neutral?: boolean;
    /** 아군 스폰: 팀 0으로 등장 (엘로윈 참전 등). 생략 시 적(팀1). */
    readonly friendly?: boolean;
    /** 함께 등장하는 호위 부대 (영웅이 부대를 이끌고 온다). 같은 팀으로 나온다. */
    readonly withUnits?: readonly { readonly defId: string; readonly count: number }[];
    /**
     * 「죽고 나서 이만큼 뒤에 다시 온다」 (초). concurrentCap 과 함께 쓴다.
     *
     * everySec 만 쓰면 타이머가 살아 있는 동안에도 계속 돌아서, 쓰러진 순간이
     * 마침 다음 차례면 곧바로 다시 나타난다 (실제로 카엘이 즉시 부활했다).
     * 이 값이 있으면 상한에 막힐 때마다 시계를 지금부터 다시 잡는다.
     */
    readonly respawnAfterDeathSec?: number;
    /** 이 등장과 함께 상점에 풀리는 유닛 (첫 등장 때 한 번). */
    readonly unlockUnits?: readonly string[];
    /**
     * true = 경고 배너를 띄우지 않는다.
     * 주민 행렬처럼 매 턴 여러 번 나오는 스폰은 배너가 화면을 계속 가린다.
     */
    readonly quiet?: boolean;
    /** 첫 등장 때 한 번 띄우는 대화 (포트레이트 컷신). */
    readonly onFirstDialogue?: readonly DialogueLine[];
    /**
     * 필드에 동시에 살아 있을 수 있는 최대 수. 이미 그만큼 있으면 이번 차례는 거른다.
     * "죽으면 다시 채워지는 상주 위협"을 만든다 (검은새).
     */
    readonly concurrentCap?: number;
    /** 이 시각(초) 전에는 나오지 않는다. everySec 과 함께 쓰면 첫 등장이 이 시각. */
    readonly fromSec?: number;
    /**
     * 이 거점(slot)이 살아 있는 동안만 나온다. 주둔지가 부서지면 증원도 끊긴다 —
     * 「거점을 부수면 그쪽 압박이 사라진다」가 눈에 보이게 하는 장치.
     */
    readonly whileCampSlot?: number;
    /** 이 거점(slot)이 부서지는 순간 딱 한 번 나온다 (거점 보스). */
    readonly onCampDown?: number;
    /**
     * 「영웅 출정」 — 자동으로 나오지 않고, 플레이어가 상점 영웅 탭에서 부를 때 시작된다.
     * 한 번 부르면 그 뒤론 이 규칙의 부활 시계가 평소대로 돌아 계속 다시 온다.
     */
    readonly heroPick?: boolean;
  }[];
  /**
   * 둥지 수호탑 (11스테이지): 게임 시작 시 아군 진영에 고정 배치되는 무적 수호수.
   * 제자리에서 평타만 한다 — 타워 포지션.
   */
  readonly nestGuards?: readonly {
    readonly defId: string;
    readonly xTile: number;
    readonly yOffTile: number;
    /**
     * 호위전 전용 — 이 번째 거점을 확보해야 세워진다 (1부터).
     * 생략하면 게임 시작과 함께 선다. 「거점을 되찾아야 망루가 살아난다」 연출.
     */
    readonly afterCamp?: number;
  }[];
  /** 팀 0 진군 상한 (타일) — 디펜스전에서 부대가 수비선을 지킨다. */
  readonly holdLineXTile?: number;
  /** 수비 모드: 팀 0 유닛이 둥지 주변 대기 + 침입 방향 자동 요격. */
  readonly defendNexus?: boolean;
  /**
   * 확정 성장: fromWave 턴부터 매 턴 적 봇의 부대 편성(comp)에 무료 +1.
   * 편성이므로 이후 매 웨이브 함께 출정한다. enemyUnitCaps 팀 캡에 도달하면 멈춘다.
   */
  readonly growth?: readonly {
    readonly defId: string;
    readonly label: string;
    readonly fromWave: number;
    /** 한 번에 편입할 수량 (생략 = 1). */
    readonly amount?: number;
    /**
     * true = fromWave 턴에 딱 한 번만 편입 (생략 = 매 턴 반복).
     * 편성(comp)은 누적이라 한 번 넣어두면 이후 매 턴 그만큼 계속 출정한다.
     */
    readonly once?: boolean;
    /** 총 편입 상한 (생략 = 무제한). 네임드는 1 — 여왕이 둘일 수는 없다. */
    readonly maxCount?: number;
  }[];
  /** 맵 오버라이드 (기본 잿불 숲). 'valley' = 사막 협곡. */
  readonly mapId?: string;
  /** 아군 봇 합류 알림 문구 (allies 가 있을 때 시작 배너로 표시). */
  readonly allyNote?: string;
  /**
   * 협공 맵: 아군 진영 한복판에 적 「망자 주둔지」가 박혀 있다.
   * 주둔지가 살아 있는 동안 everySec 마다 그 자리에서 적 부대가 쏟아진다 —
   * 앞뒤 양면전. 주둔지를 부수면 후방 웨이브가 멈춘다 (부가 목표).
   */
  readonly warcamp?: {
    readonly everySec: number;
    readonly units: readonly string[]; // 웨이브 구성 (defId 나열 = 그대로 스폰)
  };
}

/** 화자 → 포트레이트 이미지. 없는 화자는 이름만 표시(내레이션 포함). */
export const PORTRAITS: Record<string, string> = {
  '카엘': '/assets/portraits/kael.png',
  '에버그린': '/assets/portraits/evergreen.png',
  '엘로윈': '/assets/portraits/elowyn.png',
  '티아': '/assets/portraits/tia.png',
  '아린': '/assets/portraits/arin.png',
  '브리아': '/assets/portraits/bria.png',
  '앨리스': '/assets/portraits/alice.png',
  '쿠르가': '/assets/portraits/kurga.png',
  '마몬': '/assets/portraits/mammon.png',
  '발타르': '/assets/portraits/balthar.png',
  '슬리피 할로우': '/assets/portraits/hollow.png',
  '오웬': '/assets/portraits/hollow.png',
  '사도': '/assets/portraits/apostle.png',
  '마멋 족장': '/assets/units/s_marmot_icon.png',
  '광대 인형': '/assets/units/m_clown_doll_icon.png',
};

/** 적/중립 진영 화자 — 대화창에서 오른쪽에 선다. */
const RIGHT_SIDE = new Set(['쿠르가', '마몬', '발타르', '슬리피 할로우', '앨리스', '광대 인형', '마멋 족장']);
export function speakerSide(who: string): 'left' | 'right' {
  return RIGHT_SIDE.has(who) ? 'right' : 'left';
}

// 해금 누적 단계 (스테이지 데이터에서 참조)
//
// 「N 스테이지를 클리어하면 열리고 N+1 부터 뽑을 수 있다」가 규칙이다.
// 그래서 UN 은 「N 스테이지에서 살 수 있는 목록」이고, N-1 클리어 보상이 들어 있다.
const U1 = ['s_gouto', 's_elf_archer'];
// 2 스테이지는 새 유닛 없이 1 스테이지 로스터로 싸운다 — 피난 행렬 호위라
// 새 병종을 배우는 판이 아니고, 화자도 궁수(아린) 본인이다.
const U2 = U1;
const U3 = [...U2, 's_marmot'];
const U4 = [...U3, 's_druid', 's_mushroom_bomber'];
// 덩굴 사냥꾼은 4(독이 스민 숲) 클리어 보상 — 브리아의 정원을 지나며 배운 잠행이다
const U5 = [...U4, 's_vine_hunter', 's_owl', 's_butterfly'];
const U8 = [...U5, 's_thorn_witch'];
const U11 = [...U8, 's_treekeeper', 's_wyvern', 's_unicorn', 's_fairy'];
const U13 = [...U11, 's_marksman'];
const U14 = [...U13, 's_apostle', 's_treant'];
const U17 = [...U14, 's_sage'];

const seedOf = (id: number): number => (id * 7919 + 3) | 0;

/**
 * 캠페인 전역 잠금 유닛 — 3막의 지정된 무대를 위해 아껴두는 판데모니엄 상급진.
 * 어느 스테이지에서도 적 봇이 사지 못하고, 출현 이벤트·growth 편입도 막힌다.
 * 특정 스테이지에서만 풀려면 그 스테이지에 unlockEnemyUnits 로 나열한다.
 * (대전·연습 모드에는 적용되지 않는다 — 캠페인 한정)
 */
export const LOCKED_ENEMY_UNITS: readonly string[] = [
  'p_coffin_bearer', 'p_succubus', 'p_demilich', 'p_bone_dragon', 'p_mammon', 'p_incubus',
  'p_dementor',
  // 마리오네타 확장 로스터
  'm_ballista', 'm_white_rabbit', 'm_mad_hatter', 'm_drosselmeyer',
  // 실바린 확장 로스터
  's_dryad', 's_elurion', 's_oberon',
];

/** 이 스테이지에서 실제로 막을 유닛 목록 (전역 잠금 − 스테이지별 해제). */
export function deniedUnitsOf(st: { readonly unlockEnemyUnits?: readonly string[] }): readonly string[] {
  const open = st.unlockEnemyUnits ?? [];
  return LOCKED_ENEMY_UNITS.filter((id) => !open.includes(id));
}

export const SYLVARIN_CAMPAIGN: readonly CampaignStage[] = [
  // ═══ 1막 「재의 새벽」 ═══
  {
    id: 1, act: 1, title: '국경의 봉화', goal: '적 수호탑을 파괴하라 — 문지기가 깨어나면 철수한다',
    allowedUnits: U1, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'tower', seed: seedOf(1), startMoney: 350, incomeCap: 3, techCap: 2,
    briefing: [
      { who: '', img: '/assets/cutscenes/cs11_raid.png',
        text: '실바린의 숲 — 세계수의 뿌리가 대지를 지탱하는, 300년간 전쟁을 모르던 땅.\n그 숲이, 봉화가 오르기도 전에 먼저 불탔다.' },
      { who: '', text: '검은 말을 탄 기사가 국경 숲을 가로질렀다. 놈이 지나간 자리마다 300년 묵은 거목이 재가 되었다.' },
      { who: '', img: '/assets/cutscenes/cs11_flee.png',
        text: '주민들은 등 뒤의 빛이 새벽이 아니라는 것을 알고 있었다. 걷지 못하는 노목들은… 두고 갈 수밖에 없었다.' },
      { who: '', img: '/assets/cutscenes/cs11_hollow.png',
        text: '기사에게는 목이 없었다. 타오르는 이음매만이 어둠 속에서 이쪽을 「보고」 있었다.' },
      { who: '', text: '그 밤, 숲은 이름 하나를 공포로 새겼다 — 슬리피 할로우.\n데미리치 「발타르」의 망자 군단이 국경을 넘은 것이다.' },
      { who: '카엘', img: '', text: '보, 봉화가… 셋입니다. 셋이면 전면 침공이잖아요.' },
      { who: '엘로윈', text: '놈들이 노리는 건 마을이 아니다 — 세계수의 심장이다. 정면으로는 못 이겨. 우리는 시간을 벌며 물러나야 한다.' },
      { who: '엘로윈', text: '300년 만이군. 카엘, 궁수들을 깨워라. 오늘부터 너는 경비병이 아니라 지휘관이다.' },
      { who: '엘로윈', text: '유닛을 사면 부대에 영구 편성된다. 네 차례가 올 때마다 부대 전체가 출격하지. 오늘 임무는 정찰이다 — 적의 수호탑만 무너뜨려라.' },
      { who: '엘로윈', text: '탑이 무너지면 그 자리에 「문지기」가 깨어난다. 그놈과는 싸우지 마라. 아직은.' },
    ],
    outro: [
      { who: '카엘', text: '탑이 무너지자… 목 없는 기사가 일어났습니다. 마을을 태운 게 저놈이에요.' },
      { who: '엘로윈', text: '(침묵) …철수한다. 잘 싸웠다, 카엘. 이건 척후일 뿐 — 재 냄새가 바람을 타고 온다.' },
    ],
  },
  {
    id: 2, act: 1, title: '재가 내리는 길', goal: '피난 행렬 호위 — 15분간 넥서스를 지켜라',
    allowedUnits: U2, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'survive', surviveSec: 900, seed: seedOf(2), noTowers: true, incomeCap: 3, techCap: 2,
    spawns: [{ defId: 'c_ash_revenant', label: '재의 원귀', everySec: 150 }],
    briefing: [
      { who: '아린', text: '척후 다녀왔습니다. 남쪽 마을이 전부 비었어요 — 걷지 못하는 노목(老木)들은… 두고 왔대요.' },
      { who: '카엘', text: '전부 데려가겠습니다. 숲은… 누구도 버리지 않으니까요.' },
      { who: '아린', text: '그럼 활 든 사람이 저희뿐이네요. 행렬 양옆은 제가 맡을게요.' },
    ],
    outro: [
      { who: '아린', text: '한 명도 안 잃었어요. …근데 대장님, 저 재는 나무를 태운 재가 아니에요. 뼈를 간 가루예요.' },
      { who: '아린', text: '아, 그리고 이거 — 피난민들이 세계수 수액을 나눠줬어요. 캠페인 화면의 「🌿 세계수의 축복」에서 힘을 나눠 받을 수 있어요.' },
      { who: '아린', text: '스테이지를 깰 때마다 축복이 깊어지고, 언제든 공짜로 다시 나눌 수 있대요. 적이 강해질수록 이 힘이 필요할 거예요.' },
    ],
  },
  {
    id: 3, act: 1, title: '마멋 구릉', goal: '마멋 부족의 시험 — 15분간 버텨라',
    allowedUnits: U3, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'survive', surviveSec: 900, seed: seedOf(3), noTowers: true, incomeCap: 3, techCap: 2,
    spawns: [
      { defId: 'c_ash_revenant', label: '재의 원귀', everySec: 180, count: 2 },
      { defId: 'c_bone_colossus', label: '뼈 거상', atSec: 720 },
    ],
    briefing: [
      { who: '마멋 족장', text: '엘프의 전쟁에 왜 우리가 피를 흘리나!' },
      { who: '카엘', text: '저들이 태우는 건 엘프의 숲이 아니라 모두의 숲입니다. 굴도, 겨울잠도, 새끼들도요.' },
      { who: '마멋 족장', text: '…버텨 봐라. 마멋은 강한 자의 말만 듣는다.' },
    ],
    outro: [
      { who: '마멋 족장', text: '…철갑을 채워라. 마멋은 빚을 지면 갚는다. (갑옷 마멋 합류!)' },
    ],
  },
  {
    id: 4, act: 1, title: '독이 스민 숲', goal: '적 넥서스를 파괴하라 — 역병 늪은 치유로만 버틴다',
    allowedUnits: U4, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'destroy', seed: seedOf(4), noTowers: true, mapId: 'mire',
    // 1~3 은 incomeCap 3 / techCap 2 였는데 4 에서 통째로 빠져 있었다 —
    // 상한이 없으면 기본값이 테크 4 라, 이 판에서 봇이 갑자기 목없는 기사부터
    // 본드래곤까지 다 뽑았다. 한 칸씩만 올려 1막의 계단을 잇는다.
    incomeCap: 4, techCap: 2,
    // 늪·물량 위주로 몰아 「독에 갉히는 판」의 성격을 만든다.
    // 스켈레톤 소환사가 부르는 구울이 독을 가진 유일한 판데모니엄 유닛이다.
    enemyPreferredUnits: ['p_summoner', 'p_hound', 'p_deadman'],
    // 목없는 기사는 이 시점 로스터에 과하고, 공중은 5(첫 공중전)의 몫이라 미룬다.
    enemyUnitCaps: { p_headless_knight: 0, p_banshee: 0, p_wraith: 0 },
    spawns: [
      /*
       * 이 판의 정체성. 자기 화력은 낮지만 6초마다 반경 3.5타일 역병 늪을 깔고,
       * 밟은 부대는 늪을 벗어나도 16초간 초당 6 으로 계속 닳는다.
       * 상한이 없으면 반복 스폰이 후반에 무한 누적되므로(캠페인 실측) 동시 3기까지.
       */
      { defId: 'c_rotting_corpse', label: '☠ 썩어가는 시체', everySec: 80, concurrentCap: 3 },
    ],
    briefing: [
      { who: '브리아', text: '어머, 정규군이 여기까지? 이 앞은 내 정원인데. 통행료는 비싸.', side: 'right' },
      { who: '카엘', text: '…지금 숲이 불타는데 통행료?' },
      { who: '브리아', text: '불탄 건 저쪽이고 여긴 썩었어. 늪물은 한 번 묻으면 씻어도 안 빠져. 경고는 했다?', side: 'right' },
      { who: '티아', text: '…대장, 저 물 초록색이에요. 저건 물이 아니에요.' },
    ],
    outro: [
      { who: '티아', text: '저 마녀, 말은 저래도… 독에 당한 애들 해독초를 두고 갔어요.' },
      { who: '아린', text: '늪가를 지나며 애들이 덩굴 타는 법을 익혔습니다. 다음 판부터 덩굴 사냥꾼을 붙일 수 있어요. (덩굴 사냥꾼 해금)' },
    ],
  },
  {
    id: 5, act: 1, title: '올빼미 성채', goal: '적 넥서스를 파괴하라 — 산길은 멀고 하늘은 곧다',
    allowedUnits: U5, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'destroy', seed: seedOf(5), noTowers: true, mapId: 'owlkeep',
    /*
     * 첫 공중전 학습 스테이지 — 「하늘을 사야 하는 이유」를 지형이 설명한다.
     * 굽이치는 산길은 지상으로 291타일이고 비행은 57타일이다 (5.1배).
     * 지상 부대는 첫 접촉까지 3분 가까이 걸리므로 초반의 판은 하늘에서 갈린다.
     */
    incomeCap: 4, techCap: 2,
    enemyPreferredUnits: ['p_wraith', 'p_banshee'],
    spawns: [{ defId: 'c_dread_gargoyle', label: '공포의 가고일', everySec: 120 }],
    briefing: [
      { who: '아린', text: '…길이 없습니다. 저건 길이 아니라 미로예요.' },
      { who: '카엘', text: '걸어서 저 위까지 가면?' },
      { who: '아린', text: '해가 집니다. 두 번 집니다.' },
      { who: '티아', text: '…그럼 걷지 말죠. 저 위 둥지에 올빼미들이 아직 남아 있어요.' },
      { who: '카엘', text: '태워 줄까요, 그게?' },
      { who: '티아', text: '부탁은 제가 합니다. 대장은 하늘에서 뭐가 날아오는지나 보세요.' },
    ],
    outro: [
      { who: '티아', text: '숲올빼미가 등을 내줬어요. 얘들 아무나 안 태우는데. (숲올빼미·거대 나비 해금)' },
    ],
  },
  {
    id: 6, act: 1, title: '자정의 마을', goal: '주민이 다 빠져나갈 때까지 마을을 지켜라 — 15분',
    allowedUnits: U5, enemies: ['pandemonium', 'pandemonium'], allies: [], botDifficulty: 'normal',
    mission: 'survive', surviveSec: 900, seed: seedOf(6), noTowers: true,
    mapId: 'village', noNexus: true,
    incomeCap: 5, techCap: 2,
    // 넥서스가 없어 밀어붙일 목표도 없다 — 부대는 마을 언저리를 지킨다
    holdLineXTile: 40,
    village: {
      // 완성.png 에서 잰 자리 (11시 / 1시 / 7시 / 5시)
      houses: [
        { defId: 'c_village_a', xTile: 22.8, yOffTile: -2.8 },
        { defId: 'c_village_b', xTile: 34.0, yOffTile: -3.6 },
        { defId: 'c_village_c', xTile: 21.8, yOffTile: 8.2 },
        { defId: 'c_village_d', xTile: 36.6, yOffTile: 9.0 },
      ],
      loseDeaths: 10,
      // 서쪽 길은 x 2 아래로 통행칸이 1~5개까지 좁아진다. 여기를 탈출선으로 잡으면
      // 느린 노인이 끝내 통과하지 못하고 벽에 붙어 남는다 (실측) — 4 로 넉넉히 둔다.
      escapeXTile: 4,
    },
    spawns: [
      // 적은 북쪽 두 숲길로 밀려든다 (완성.png 의 불타는 모서리)
      { defId: 'c_ash_revenant', label: '⬉ 재의 원귀', everySec: 90, atXTile: 12, yOffTile: -16 },
      { defId: 'c_ash_revenant', label: '⬈ 재의 원귀', everySec: 90, atXTile: 44, yOffTile: -16 },
      { defId: 'c_kurga', label: '⚔ 보스: 리치 쿠르가', atSec: 480, atXTile: 46, yOffTile: -14 },
      { defId: 'c_bone_colossus', label: '뼈 거상', atSec: 660, everySec: 200, atXTile: 12, yOffTile: -16 },
      { defId: 'c_villager_adult_m', label: '', everySec: 60, friendly: true, atXTile: 30, yOffTile: 2, quiet: true },
      { defId: 'c_villager_adult_f', label: '', everySec: 60, friendly: true, atXTile: 30, yOffTile: 4, quiet: true },
      { defId: 'c_villager_child_m', label: '', everySec: 60, friendly: true, atXTile: 30, yOffTile: 3, quiet: true },
      { defId: 'c_villager_elder_f', label: '', everySec: 60, friendly: true, atXTile: 30, yOffTile: 5, quiet: true },
      { defId: 'c_villager_child_f', label: '', everySec: 60, friendly: true, atXTile: 30, yOffTile: 6, quiet: true },
    ],
    briefing: [
      { who: '엘로윈', text: '카엘. 이 마을은 지킬 수 없다. 지켜야 하는 건 마을이 아니라 마을 사람이다.' },
      { who: '카엘', text: '…집을 버리라는 말씀입니까.' },
      { who: '엘로윈', text: '집이 무너지는 데는 시간이 걸린다. 그 시간을 전부 행렬에 써라.' },
      { who: '쿠르가', text: '타라, 타라, 푸른 것들아! 발타르 님의 겨울에 봄은 오지 않는다!', side: 'right' },
      { who: '티아', text: '서쪽 길이 아직 열려 있어요. 한 번에 다섯씩 내보낼게요. 열 명을 잃으면… 거기서 끝이에요.' },
    ],
    outro: [
      { who: '카엘', text: '…마을이 탑니다. 제가 지휘했는데.' },
      { who: '엘로윈', text: '네가 지휘해서 사람이 살아서 탄 거다. 그 차이를 평생 기억해라.' },
      { who: '', text: '— 1막 끝. 실바린은 국경을 잃고 숲 심부로 퇴각한다. —' },
    ],
  },
  // ═══ 2막 「태엽과 가시」 ═══
  {
    id: 7, act: 2, title: '부서진 장난감 골목', goal: '마리오네타 방어선을 뚫어라 (넥서스 파괴)',
    allowedUnits: U5, enemies: ['marionetta'], allies: [], botDifficulty: 'easy',
    mission: 'destroy', seed: seedOf(7), mapId: 'toybox',
    enemyGuardian: 'teddy_guardian',
    spawns: [{ defId: 'c_mad_ballerina', label: '미친 발레리나', everySec: 150 }],
    briefing: [
      { who: '', img: '/assets/cutscenes/cs21_retreat.png',
        text: '숲은 불탔다. 재의 함락에서 대피 시간을 번 피난 행렬은 살아남은 이들을 이끌고 남쪽으로 달아났다.\n등 뒤로 재가 내렸다. 아무도 뒤를 돌아보지 않았다.' },
      { who: '', img: '/assets/cutscenes/cs21_gate.png',
        text: '발타르의 추격을 피해 지도에도 없는 국경을 넘은 순간 — 태엽 감기는 소리가 들려왔다.\n부서진 장난감이 나뒹구는 골목, 인형들의 왕국 마리오네타.' },
      { who: '카엘', text: '남쪽 산맥을 넘어 발타르의 성을 우회합니다. 이 나라를 지나가야만 해요.' },
      { who: '티아', img: '/assets/cutscenes/cs21_dolls.png', text: '여긴… 장난감 마을? 근데 왜 전부 이쪽을 보고 있죠?' },
      { who: '광대 인형', text: '침・입・자. 여왕님의 골목. 통과 금지. 껴안아 주기. 터질 때까지.' },
    ],
    outro: [
      { who: '카엘', text: '인형이 왜 국경을 지키죠? 인형의 왕국에 대체 무슨 일이…' },
    ],
  },
  {
    id: 8, act: 2, title: '태엽 공방', goal: '괘종시계 포대 지대를 돌파하라',
    allowedUnits: U8, enemies: ['marionetta'], allies: [], botDifficulty: 'easy',
    mission: 'destroy', seed: seedOf(8), mapId: 'toybox',
    enemyGuardian: 'teddy_guardian',
    // 「괘종시계 포대 지대」 — 태엽 병기들이 단계적으로 깨어난다:
    //   처음부터: 봉제곰·단추 인형·태엽 병정·태엽 거미 (선호 생산)
    //   5턴~: 괘종시계 (최대 5) / 6턴~: 고어 테디 (무제한 증가) / 7턴~: 톱니바퀴 (최대 5)
    //   페니와이즈·실과 바늘·앨리스는 끝까지 등장하지 않는다 (캡 해제 없음 — 영구)
    enemyBotStyle: 'balanced',
    // 적이 만들 수 있는 유닛은 화이트리스트 그대로만:
    // 곰·단추·병정·거미(자연 생산) + 괘종·테디·톱니(growth 매 턴 +1).
    // 그 외 마리오네타 전 유닛은 캡 0 = 영구 금지.
    enemyPreferredUnits: [],
    enemyUnitMinWave: { m_grandfather_clock: 5, m_gore_teddy: 6, m_clocktower_gear: 7 },
    enemyUnitCaps: {
      m_grandfather_clock: 5, m_clocktower_gear: 5, // growth 포함 최대 5기
      // 테디 캡 0 = 봇 구매 금지, growth 매 턴 +1 만으로 증가 — 다른 유닛이 전부
      // 금지라 구매를 열어두면 봇 돈이 테디에 몰려 폭주한다 (실측 20분 90기)
      m_gore_teddy: 0,
      m_puppet_swordsman: 0, m_clown_doll: 0, m_cursed_doll: 0,
      m_casper: 0, m_puppet_ann: 0, m_specter_teddy: 0,
      m_pennywise: 0, m_thread_needle: 0, m_alice: 0,
    },
    growth: [
      // 5턴부터 매 턴 괘종시계 +1 (9턴에 캡 5) / 6턴부터 테디 +1 무제한 / 7턴부터 톱니 +1 (11턴에 캡 5)
      { defId: 'm_grandfather_clock', label: '괘종시계 포대', fromWave: 5 },
      { defId: 'm_gore_teddy', label: '여왕의 근위곰', fromWave: 6 },
      { defId: 'm_clocktower_gear', label: '자정의 톱니바퀴', fromWave: 7 },
    ],
    spawns: [{ defId: 'c_mad_ballerina', label: '미친 발레리나', everySec: 120 }],
    briefing: [
      { who: '브리아', text: '통행료 받으러 왔어. 어머, 전멸 직전이네? 할인해 줄게.' },
      { who: '카엘', text: '…왜 도와주는 겁니까.' },
      { who: '브리아', text: '내 정원 태운 게 쟤네 윗선이거든. 가시엔 가시. (가시 마녀 합류!)' },
    ],
    outro: [
      { who: '브리아', text: '선불이야. 숲 되찾으면 남쪽 언덕은 내 거.' },
    ],
  },
  {
    id: 9, act: 2, title: '여왕과의 알현', goal: '근위대의 시험을 통과하라 (넥서스 파괴)',
    allowedUnits: U8, enemies: ['marionetta'], allies: [], botDifficulty: 'normal',
    mission: 'destroy', seed: seedOf(9), mapId: 'toybox',
    enemyGuardian: 'teddy_guardian',
    // 지상 유닛으로 뚫는 라운드 — 하늘은 페니와이즈가 봉쇄한다.
    // 캡은 영구 (16턴 해제 없음): 실과 바늘·테디가 후반에 풀리면 라운드 정체성이 무너진다.
    // 테디는 봇 구매 금지 + 확정 스폰 3회로 정확히 3기만 등장.
    enemyBotStyle: 'balanced',
    enemyPreferredUnits: ['m_pennywise'],
    // 테디 2기 고정 / 앨리스는 growth 로만 계속 늘어난다(구매 금지 캡 0).
    // 캡 해제 없음(영구) — 후반 총력전까지 겹치면 난이도가 감당이 안 된다.
    // 페니와이즈는 봇 구매 상한 12 — 선호 유닛이라 열어두면 무한 증식한다 (실측 100기+)
    enemyUnitCaps: {
      m_pennywise: 12, m_gore_teddy: 2, m_clocktower_gear: 5,
      m_alice: 0, m_thread_needle: 0,
    },
    deadlineWave: 60, // 60턴 안에 못 끝내면 패배 (제작자 클리어 44턴 — 여유를 준다)
    // 여왕 친정 순간엔 전투를 세우고 본인이 직접 등장을 선언한다
    cutscenes: [
      {
        atSec: 900,
        lines: [
          { who: '', text: '태엽 소리가 일제히 멎었다. 인형들이 전부 한쪽으로 고개를 돌린다.' },
          { who: '앨리스', text: '…근위대가 셋이나 찢겼네. 시험은 여기까지.' },
          { who: '앨리스', text: '숲지기. 네가 여기까지 온 건 인정할게. 그러니 이제 내가 나가.' },
          { who: '카엘', text: '여왕이 직접…!' },
          { who: '앨리스', text: '인형사는 무대에 안 올라. 올라올 땐, 막을 내릴 때뿐이야.' },
        ],
      },
    ],
    // 확정 편성: 매 턴 +1 로 계속 늘어난다 (필드 1회 출현이 아니라 매 웨이브 출정).
    // 테디는 캡 2 에서 멈추고, 앨리스는 15턴부터 매 턴 늘어난다.
    growth: [
      { defId: 'm_gore_teddy', label: '여왕의 근위곰', fromWave: 8 },
      // 여왕은 오직 1기 — 15턴에 합류해 이후 매 웨이브 함께 출정한다
      { defId: 'm_alice', label: '👑 여왕 앨리스', fromWave: 15, maxCount: 1 },
    ],
    // 반복 스폰엔 반드시 총량 상한을 둔다 — 없으면 20턴에 57기까지 불어나
    // 어떤 시드로도 이길 수 없다 (승률 0/20 실측)
    spawns: [
      { defId: 'm_pennywise', label: '풍선 광대 편대', everySec: 90, count: 1, maxTotal: 10 },
      { defId: 'c_mad_ballerina', label: '여왕의 발레리나', everySec: 120, count: 1, maxTotal: 14 },
    ],
    briefing: [
      { who: '앨리스', text: '숲의 아이들이 왜 내 나라를 밟지? …아, 발타르. 그 뼈다귀가 요즘 국경을 시끄럽게 하더라.' },
      { who: '카엘', text: '당신들도 당했잖아. 손을 잡자.' },
      { who: '앨리스', text: '인형은 거래를 하지, 약속은 안 해. 내 근위대를 이겨 봐. 그럼 들어줄게.' },
    ],
    outro: [
      { who: '앨리스', text: '…재밌네, 숲지기. 300년 만에 재밌어.' },
      { who: '엘로윈', text: '(300년…? 이 여왕, 대체—)' },
    ],
  },
  {
    id: 10, act: 2, title: '탐욕의 계곡 — 입구', goal: '중앙 「마몬의 상점」을 점령해 용병을 사라 (🚩 점령한 팀만 구매 가능)',
    allowedUnits: U8, enemies: ['pandemonium'], allies: [], botDifficulty: 'normal',
    mission: 'destroy', seed: seedOf(10), startMoney: 150, mapId: 'greedvalley',
    enemySkin: 'bone',
    // 상점 점령전: 계곡 한복판에 마몬의 상점 — 주변을 장악한 팀만 용병을 산다.
    // 적 봇도 점령하면 같은 용병(기사·리치·타나토스)을 사들인다. 언데드라 드루이드 힐 불가.
    mercUnits: ['merc_headless_knight', 'merc_lich', 'merc_thanatos'],
    mercCostPct: 100, // 정가 — 지금은 환심을 사는 중 (12에서 배신하는 복선)
    mercCaptureRequired: true,
    enemyBotStyle: 'balanced',
    enemyPreferredUnits: ['p_headless_knight', 'p_corpse_golem', 'merc_thanatos', 'merc_lich'],
    // 데미리치(대공 광역) 5턴부터 매 턴 편입 — 공중 스팸 원툴 전략을 막는다 (실플레이: 올빼미만으로 15턴 클리어)
    enemyUnitCaps: { p_demilich: 4 },
    growth: [{ defId: 'p_demilich', label: '데미리치 요격수', fromWave: 5 }],
    deadlineWave: 60,
    briefing: [
      { who: '마몬', text: '전쟁은 최고의 장사지! 실바린엔 방어구를, 발타르에겐 뼈를 팔았다네. 아 물론 너희들의 뼈를.' },
      { who: '브리아', text: '어머, 동종업계. 근데 나는 선은 안 넘어.' },
      { who: '마몬', text: '계곡 한복판에 내 상점이 있네. 먼저 깃발을 꽂는 쪽에게 팔지 — 기사, 리치, 타나토스, 전부 특별가일세!' },
      { who: '카엘', text: '중앙을 장악한 쪽이 용병을 산다… 전선 싸움이 곧 돈 싸움이군요. (🚩 상점 주변을 점령하면 💰용병 구매 가능!)' },
    ],
    outro: [
      { who: '카엘', text: '용병 장부를 손에 넣었습니다. …발타르가 사들인 게 뼈만이 아니에요. 「세계수 심장의 열쇠」?' },
    ],
  },
  {
    id: 11, act: 2, title: '바람의 둥지', goal: '둥지를 지켜라 — 세 방향에서 몰려온다 (30턴 버티기)',
    allowedUnits: U11, enemies: ['pandemonium'], allies: [], botDifficulty: 'normal',
    mission: 'survive', surviveSec: 1800, noTowers: true,
    seed: seedOf(11), mapId: 'nest',
    enemySkin: 'bone',
    // ── 11 = 판데 중상급의 무대: 시체 골렘·타나토스·밴시가 주역 ──
    // 적 생산창을 아예 밴시까지로 잘라둔다. 끝판급(데미리치·마몬·본드래곤·
    // 인큐버스…)은 목록에 없으니 봇이 살 수 없고, 데미리치·마몬만 「출현!」으로 온다.
    enemyAllowedUnits: [
      'p_skeleton', 'p_bone_thrower', 'p_summoner', 'p_headless_knight',
      'p_lich', 'p_corpse_golem', 'p_thanatos',
      'p_wraith', 'p_banshee',
    ],
    // 적 봇은 처음부터 테크 3 — 등장 시점은 전부 minWave 로만 통제한다.
    // (봇 테크는 성격·시드 운을 타서 "밴시가 30턴 내내 안 나오는" 시드가 생겼다.
    //  테크비를 안 쓰는 만큼 그 돈은 병력으로 간다.)
    enemyStartTech: 3,
    // 망령을 앞에 세워 "인컴+테크 그리디"를 초반부터 응징한다 — 공중 위협이
    // 1~2턴부터 꾸준해야 방어에 돈을 쓰게 된다
    enemyPreferredUnits: ['p_wraith', 'p_corpse_golem', 'p_thanatos', 'p_banshee'],
    enemyUnitMinWave: {
      // 테크가 열려 있으니 등장 순서는 여기서 직접 그린다 (턴 = 대략적인 난이도 곡선)
      p_summoner: 2, p_wraith: 2,          // 2턴: 소환사·망령 — 공중 위협이 일찍 온다
      p_headless_knight: 3,
      p_corpse_golem: 5, p_banshee: 5,     // 5턴: 주역 지상·공중 합류
      p_lich: 6,
      p_thanatos: 7,                       // 7턴: 최종 주역
    },
    enemyUnitCaps: {
      // 주역 4종(망령·시체 골렘·타나토스·밴시)은 상한 없음 — 턴이 갈수록 계속 불어난다
      // 잡졸은 초반 물량용. 테크비를 안 쓰는 만큼 남는 돈이 전부 스켈레톤(70원)으로
      // 흘러가 40기씩 쌓이던 것을 캡으로 막는다 — 그 돈이 주역으로 간다
      p_skeleton: 10,
      // 조연 — 소수만
      p_bone_thrower: 6, p_headless_knight: 12,
      p_lich: 4,
    },
    // 발타르의 밴시 증원 — 8·11·16턴에 걸쳐 4시 판데 군세에 통째로 편입된다.
    // 편성은 누적이라 한 번 들어가면 이후 매 턴 그만큼 계속 출정한다 (봇 생산분과 별개).
    // 3 → 8 → 23기로 불어나며 상시 공중 압박을 만든다. 봇의 구매 가중치는
    // 편성 규모를 보지 않으므로, 이렇게 얹어도 봇은 밴시를 계속 자기 돈으로 산다.
    growth: [
      { defId: 'p_banshee', label: '밴시 무리', fromWave: 8, amount: 3, once: true },
      { defId: 'p_banshee', label: '밴시 무리', fromWave: 11, amount: 5, once: true },
      { defId: 'p_banshee', label: '밴시 무리', fromWave: 16, amount: 15, once: true },
    ],
    // 수비 모드: 부대가 둥지 주변에 대기하다 침입 방향으로 자동 요격한다
    defendNexus: true,
    // 둥지 수호탑: 세 갈래 입구에 하나씩 (평타만 — 타워)
    // ⚠ 여기는 nest 맵(길이 96타일·halfW 5·둥지 x48)이다. 13/14 의 망루 좌표를
    //   그대로 붙이면 전부 길 밖·맵 밖으로 나간다 — 한 번 그렇게 섞인 적이 있다.
    nestGuards: [
      { defId: 'c_nest_wyvern', xTile: 48, yOffTile: -7 },  // 12시 입구
      { defId: 'c_nest_unicorn', xTile: 43, yOffTile: 1 },  // 8시 입구
      { defId: 'c_nest_fairy', xTile: 53, yOffTile: 1 },    // 4시 입구
    ],
    // 세 방향 침공 — 전부 중앙 둥지로 수렴한다:
    // ① 4시 (오른쪽): 정규 판데모니엄 봇이 턴마다 출정 (기본 enemies)
    // ② 12시 (능선 위): 잡졸 무리가 둥지 바로 위 능선에서 쉬지 않고 내려온다
    // ③ 8시 (왼쪽 골짜기): 야생 무리 — 반은 이쪽 반은 저쪽, 아무나 문다
    spawns: [
      // ── 12시: 수직 가지 길 꼭대기(-36타일)에서 능선을 타고 쉼 없이 내려온다.
      // 초반부터 물량이 확 몰려와야 "아무것도 안 뽑는 풀인컴"이 응징된다.
      { defId: 'p_minion_ghoul', label: '⬆ 능선의 망자 무리', everySec: 8, count: 3, atXTile: 47, yOffTile: -36 },
      { defId: 'p_minion_undead', label: '⬆ 능선의 망자 무리', everySec: 12, count: 3, atXTile: 49, yOffTile: -36 },
      { defId: 'p_minion_skeleton', label: '⬆ 능선의 망자 무리', everySec: 10, count: 3, atXTile: 48, yOffTile: -34 },
      { defId: 'p_minion_rat', label: '⬆ 능선의 망자 무리', everySec: 7, count: 4, atXTile: 48, yOffTile: -32 },
      // 능선의 망령: 1분부터 하늘로도 꾸준히 내려온다 — 인컴 그리디의 천적
      { defId: 'p_wraith', label: '⬆ 능선의 망령', atSec: 60, everySec: 40, count: 2, atXTile: 47, yOffTile: -34 },
      // ── 4시(적 진영): 봇 생산 웨이브 + 끝판 손님은 「출현!」으로만 소수 등장.
      // 25턴(1500초)부터 데미리치 3기 · 26턴부터 마몬 2기 — 마지막 5턴의 압박
      { defId: 'p_demilich', label: '💀 데미리치', atSec: 1500, everySec: 120 },
      { defId: 'p_mammon', label: '💰 탐욕의 마몬', atSec: 1560, everySec: 150 },
      // ── 8시: V자 왼쪽 끝 골짜기에서 올라온다 (중립: 시간이 갈수록 사나워진다).
      // 12시보다 훨씬 뜸하게 온다 — 야생이 쉼 없이 쏟아지면 판데 군세가 중간에서
      // 야생과 갉아먹는 소모전만 하다 끝나 둥지가 한 대도 안 맞았다.
      // 유입량 기준 12시의 1/8 수준으로 낮춰, 판데가 둥지까지 도달하게 한다.
      { defId: 'c_wild_wolf_gray', label: '⬋ 야생 늑대 무리', everySec: 45, count: 3, atXTile: 8, yOffTile: 0, neutral: true },
      { defId: 'c_wild_snake', label: '⬋ 독사 떼', everySec: 55, count: 3, atXTile: 5, yOffTile: 0, neutral: true },
      { defId: 'c_wild_wolf_black', label: '⬋ 검은늑대 무리', atSec: 120, everySec: 80, count: 2, atXTile: 8, yOffTile: 0, neutral: true },
      { defId: 'c_wild_tarantula', label: '⬋ 타란튤라', atSec: 180, everySec: 95, count: 2, atXTile: 6, yOffTile: 0, neutral: true },
      // 황조롱이는 1분 반부터 — 공중 조합에도 초반부터 성가신 손님이 있어야 한다
      { defId: 'c_wild_kestrel', label: '⬋ 황조롱이 떼', atSec: 90, everySec: 70, count: 2, atXTile: 10, yOffTile: -1, neutral: true },
      { defId: 'c_wild_bear_gray', label: '⬋ 회색곰', atSec: 360, everySec: 105, count: 2, atXTile: 6, yOffTile: 0, neutral: true },
      { defId: 'c_wild_direwolf', label: '⬋ 다이어울프 무리', atSec: 540, everySec: 100, count: 2, atXTile: 8, yOffTile: 0, neutral: true },
      { defId: 'c_wild_grizzly', label: '⬋ 그리즐리베어', atSec: 600, everySec: 115, count: 2, atXTile: 6, yOffTile: 0, neutral: true },
      // 18턴부터 매 턴 한 기씩 — 「망자의 시선」으로 부대를 붙들어 세운다.
      // 뒤에서 안전하게 쏘던 공중 조합(와이번·페어리·유니콘)을 강제로 앞으로 끌어낸다.
      { defId: 'c_grave_warden', label: '⚰ 무덤의 파수꾼', atSec: 1080, everySec: 60 },
      // 검은새 등장표 (반복 없음, 총 11마리):
      //   14·17턴 한 마리  →  20·23턴 두 마리  →  25·27·28·29·30턴 한 마리씩
      // 상시 3기 유지(45초 보충)는 숨 돌릴 틈이 없었다. 대신 후반으로 갈수록
      // 간격이 촘촘해져 마지막 4턴은 매 턴 한 마리씩 — 끝을 향해 조여든다.
      // 상시 압박은 검은새가 아니라 아래 growth(밴시 증원)가 맡는다.
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 840, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1020, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1200, count: 2, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1380, count: 2, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1500, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1620, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1680, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1740, atXTile: 5, yOffTile: -2, neutral: true },
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 1800, atXTile: 5, yOffTile: -2, neutral: true },
    ],
    briefing: [
      { who: '엘로윈', text: '높은 봉우리의 옛 맹약을 깨울 때다. 와이번은 긍지가 높다 — 명령하지 말고 부탁해라.' },
      { who: '카엘', text: '(와이번에게) …함께 날아 주겠어? (나무지기·와이번·유니콘·페어리 합류!)' },
      { who: '티아', text: '둥지 입구에 수호수들이 자리를 잡았어요! 하지만 냄새를 맡고 온 게… 망자만이 아니에요.' },
      { who: '엘로윈', text: '세 갈래다. 능선의 망자, 골짜기의 야수, 그리고 발타르의 선발대. 알이 깨어날 때까지 — 둥지를 지켜라.' },
    ],
    outro: [
      { who: '티아', text: '유니콘이 카엘을 태워줬어요! 유니콘은 아무나 안 태우는데!' },
      { who: '브리아', text: '어련하시겠어.' },
    ],
  },
  {
    id: 12, act: 2, title: '탐욕의 계곡 — 결전', goal: '⚔ 보스: 사령장군 카르가스를 쓰러뜨려라 (앨리스 군단과 공동 전선!)',
    allowedUnits: U11, enemies: ['pandemonium', 'pandemonium'], allies: ['marionetta'], botDifficulty: 'normal',
    allyNote: '🤝 앨리스의 군단이 북쪽 갈래에서 함께 진군한다!',
    mission: 'boss', seed: seedOf(12), mapId: 'confluence',
    allyBotStyle: 'balanced', // 앨리스 군단은 꾸준히 생산해야 한다 (저축형 금지)
    jointDeploy: true, // 매 턴 내 부대와 앨리스 군단이 함께 출정 (공동 전선)
    enemySkin: 'bone',
    noTowers: true,
    noEnemyNexus: true,
    bossDefId: 'c_balthar_general',
    // 28턴 — "기다렸다 총력 러시"가 안 통하는 빠듯한 시한. 그리디 차단의 핵심
    deadlineWave: 28,
    // 앨리스 군단(아군 봇)은 위 갈래 끝에서 출정해 합류점으로 내려온다
    allyDeployTile: { x: 30, y: -13 },
    // ── 적 구성: 중상급 정예군만 생산한다 (잡졸·끝판 유닛은 생산 목록에서 제외)
    // 데미리치가 growth 로 일찍부터 확정 편입되던 것 폐지 — 끝판 유닛은 「출현!」로만
    enemyAllowedUnits: [
      'p_hound', 'p_bone_thrower', 'p_headless_knight',
      'p_lich', 'p_corpse_golem', 'p_thanatos', 'p_wraith', 'p_banshee',
    ],
    // 리치·타나토스·시체 골렘·밴시가 주력으로 쏟아진다 (x8 가중, 상한 없음)
    enemyPreferredUnits: ['p_banshee', 'p_lich', 'p_thanatos', 'p_corpse_golem'],
    // 적 경제: 시작 1000원 + 인컴 52부터 (기본 30의 174% — 인컴업도 비례로 오른다)
    enemyStartMoney: 1000,
    enemyIncomePct: 174,
    // 아군 봇의 인형사 앨리스는 1기뿐 — 여왕은 한 명이다 (아군 과강화 방지)
    allyUnitCaps: { m_alice: 1 },
    // 끝판 유닛은 「출현!」 이벤트로 한 번씩 — 데미리치·마몬·뼈 거상
    spawns: [
      { defId: 'c_bone_colossus', label: '뼈 거상', everySec: 150 },
      { defId: 'p_demilich', label: '💀 데미리치', atSec: 300, everySec: 210 },
      { defId: 'p_mammon', label: '💰 배신자 마몬', atSec: 420, everySec: 300 },
    ],
    briefing: [
      { who: '마몬', text: '배신? 아니지, 더 좋은 조건이 왔을 뿐! 발타르 님이 너희 숲을 통째로 주신다더군!' },
      { who: '', text: '계곡 끝에서 거대한 그림자가 일어선다. 발타르가 아끼는 선봉장 — 사령장군 카르가스.' },
      { who: '카엘', text: '마몬이 저걸 데려온 겁니까… 넥서스가 문제가 아닙니다. 저 장군을 쓰러뜨려야 길이 열려요.' },
      { who: '앨리스', text: '내 국경에서 장사하면서 자릿세를 안 냈네? …전부 부숴. (앨리스의 군단이 함께 싸운다!)' },
    ],
    outro: [
      { who: '앨리스', text: '동맹이야, 숲지기. 대가는… 나중에 청구할게. 인형은 외상 장부를 안 잊거든.' },
      { who: '브리아', text: '어머, 동종업계 수법이네. 저런 말 뒤엔 꼭 큰 게 붙어.' },
      { who: '엘로윈', text: '(작게) …300년을 산 여왕이라. 대체 무엇을 잃었길래.' },
      { who: '', text: '— 2막 끝. 세 종족의 운명이 한 점으로 모이기 시작한다. —' },
    ],
  },
  // ═══ 3막 「자정의 세계수」 ═══
  {
    id: 13, act: 3, title: '세계수 뿌리 탈환', goal: '🛞 생명수 마차를 호위하라 — 보급 거점 5개를 차례로 점령',
    // 숲의 명궁은 처음엔 못 산다 — 14턴에 에버그린이 데려오면서 풀린다
    // 호위전은 1인 팀이다.
    // 아군 봇을 두면 팀 인원(2명)으로 출정 로테이션이 돌아 내 부대가 한 턴 걸러
    // 나갔다 — 마차 곁을 계속 지켜야 하는 판에서 그 공백이 그대로 상실이 됐다.
    // 병력 보강은 엘로윈이 데려오는 부대와 출현 이벤트가 맡는다.
    allowedUnits: U11, enemies: ['pandemonium', 'pandemonium'], allies: [], botDifficulty: 'normal',
    /*
     * 편성 합치기 — 물량이 쌓이면 알아서 상위 유닛으로 접힌다.
     * 후반에 잡졸이 무한히 늘어 화면이 뒤덮이는 것을 막으면서 전투력은 올린다.
     * (목없는 기사 12기 → 마몬 1 + 기사 2)
     */
    unitMerges: [
      { from: 'p_headless_knight', per: 10, to: 'p_mammon' },
      { from: 'p_banshee', per: 10, to: 'p_demilich' },
    ],
    mission: 'destroy', seed: seedOf(13), enemyBasicCutoffWave: 11, mapId: 'ashroad',
    enemySkin: 'bone',
    noTowers: true, // 수호탑 대신 — 전 거점 확보 시 슬리피 할로우가 직접 나타난다
    // 앨리스의 지원 병력: 사람 플레이어만 살 수 있다 (race: null — 봇 구매 풀 제외)
    mercUnits: ['c_alice_soldier', 'c_alice_teddy'],
    /*
     * 물량 상한 (팀 합산). 28턴에 통째로 풀린다.
     *  마몬 — 후반에 무한히 쌓여 벽이 되는 것 방지.
     * 밴시는 상한을 두지 않는다 — 대신 생산 개방을 10턴으로 늦춰서 조절한다.
     * 데미리치는 growth(확정 편입)로 10기까지 늘고, 28턴에 상한이 통째로 풀린다.
     */
    enemyUnitCaps: { p_mammon: 30 },
    enemyCapsUntilWave: 28, // 28턴부터 적 유닛 상한 전부 해제
    // 처음부터 4티어를 열어 두고, 실제 등장 시점은 아래 거점 phases 로만 통제한다
    enemyStartTech: 4,
    // 전역 잠금(LOCKED_ENEMY_UNITS)을 이 판에서만 푼다 — 안 풀면 아래 구간표와
    // 확정 편입이 통째로 무시된다 (봇 구매·growth·출현 이벤트 전부 막힌다)
    unlockEnemyUnits: ['p_demilich', 'p_mammon'],
    // 아군 봇의 세이지 금지 — 마법 화력은 엘로윈(스폰 이벤트) 단 한 명뿐
    allyUnitCaps: { s_sage: 0 },
    /*
     * 적 생산 구간표. 팀1 봇 두 기 모두 같은 표를 쓴다.
     *
     *  ~9턴  망자병·시체사냥개·해골투척병   (1티어 물량. 6턴에 인컴 0 → 5 해제)
     * 10턴~  목없는 기사·리치              (1티어 잠금 — 물량에서 질로)
     * 17턴~  + 밴시                        (하늘이 열린다)
     * 22턴~  시체골렘·타나토스·밴시        (기사·리치가 빠진다)
     * 28턴~  타나토스·데미리치·마몬        (상한 해제 + 총력전)
     */
    enemyCamps: [0, 1].map((slot) => ({
      slot,
      // 인컴 0단계로 출발하고, 6턴 전까지는 스스로 못 올린다 (상한 0).
      // 시작 자금도 기본값 그대로 — 1000 을 쥐여 줬더니 초반부터 너무 두꺼웠다.
      startIncome: 0,
      incomeCap: 0,
      phases: [
        { fromWave: 1, units: ['p_deadman', 'p_hound', 'p_bone_thrower'] },
        { fromWave: 10, units: ['p_headless_knight', 'p_lich'] },
        { fromWave: 17, units: ['p_headless_knight', 'p_lich', 'p_banshee'] },
        { fromWave: 22, units: ['p_corpse_golem', 'p_thanatos', 'p_banshee'] },
        { fromWave: 28, units: ['p_thanatos', 'p_demilich', 'p_mammon'], preferred: ['p_demilich'] },
      ],
      // 6턴에 잠금이 풀린다: 시스템이 5단계까지 올려 주고 상한은 8 —
      // 6→8 은 봇이 스스로 번 돈으로 올린다 (한 번에 8을 주면 감당이 안 됐다)
      incomeUnlocks: [{ fromWave: 6, cap: 8, setLevel: 5 }],
      // 턴 보너스 자금은 쓰지 않는다 — 6턴부터 +300 을 주니 인컴 개방과 겹쳐
      // 물량이 감당이 안 됐다. 압박은 인컴 개방(6턴 상한 8)만으로 만든다.
      spendAll: true,
    })),
    // 숲의 망루 (무적 포탑, 현자의 비전 화살) — 손으로 고른 다섯 자리.
    // 전부 길 밖 어깨에 세운다 (ghost 라 몸싸움은 안 하지만, 길 한복판에 서면
    // 유닛이 통과해 지나가는 그림이 나온다).
    // yOffTile 은 중앙선 기준이라 실제 y 를 주석에 같이 적어 둔다.
    nestGuards: [
      // 전부 「화면상 완전한 숲 타일」 + 길에서 2~4칸 떨어진 자리다.
      // 길가 어깨에 세우면 Wang 코너 규칙 때문에 그 칸에도 흙이 번져 그려져서,
      // 실제로는 숲인데 화면에선 길 한복판에 선 것처럼 보였다.
      // 본진 망루만 처음부터 서 있다. 나머지는 옛 국경 감시선의 잔해라,
      // 그 앞 거점을 되찾아야 다시 불을 밝힌다 (afterCamp).
      { defId: 'c_sage_watchtower', xTile: 10.5, yOffTile: 11.4 },   // 본진 6시 숲 (y 10.5)
      { defId: 'c_sage_watchtower', xTile: 43.5, yOffTile: -9.4, afterCamp: 2 },   // 캠프1↔2 사이 (y -3.5)
      { defId: 'c_sage_watchtower_s', xTile: 66.5, yOffTile: -14.0, afterCamp: 3 }, // 캠프3 3시 숲 (y -9.5)
      { defId: 'c_sage_watchtower_s', xTile: 79.5, yOffTile: 11.4, afterCamp: 5 },  // 캠프5 9시 숲 (y 8.5)
      { defId: 'c_sage_watchtower', xTile: 87.5, yOffTile: -9.7, afterCamp: 5 },   // 캠프5 12시 숲 (y -3.5)
    ],
    // 엘로윈 참전 컷신 — 실제 등장(9턴)과 같은 시각에 띄운다
    cutscenes: [{
      atSec: 540, // 엘로윈이 실제로 참전하는 9턴에 맞춘다
      lines: [
        { who: '엘로윈', text: '(지팡이 끝이 빛난다) 이 길은 300년 전에도 내가 걸었다. …늙은이가 앞장서마.' },
        { who: '티아', text: '스승님?! 전선에 직접 나오시는 건 처음 봐요!' },
        { who: '엘로윈', text: '뿌리가 마르는데 서재에 앉아 있을 수는 없지. 카엘 — 마법은 내가 맡는다.' },
      ],
    }],
    // 호위전: 마차가 거점에 서 있는 동안(아군 부대 동반 필수) 점령 게이지가 오른다.
    // 적이 거점을 되찾으면 마차는 직전 거점으로 후퇴 — 오버워치 화물 밀기.
    escort: {
      // 그림의 공터 다섯 곳 (양 끝 본거지 제외, 좌→우).
      // 신 지형에 그려 놓은 전방 캠프와 같은 자리 — 거점 = 눈에 보이는 캠프다.
      pointsXTile: [32.4, 46.2, 57, 79.2, 89.4],
      captureSec: 60,
      loseSec: 12,
      radiusTiles: 4.5,
      cartDefId: 'c_supply_cart',
      /**
       * 거점 주둔군 — 처음부터 눌러앉아 있는 적 부대. 진군하지 않고 그 자리를
       * 지키므로, 밀어내지 않으면 점령 게이지가 시작조차 하지 않는다.
       * 뒤로 갈수록 두껍게 — 예전엔 엘로윈과 아군 증원만으로 5거점까지 그냥
       * 흘러갔다 (플레이어가 한 기도 안 뽑아도).
       */
      garrisonRadiusTiles: 6.5,
      /*
       * 거점을 되찾을 때마다 숲의 잔존 병력이 합류한다.
       * 「밀어붙이면 부대가 커진다」 — 버티며 인컴만 올리는 쪽과 경쟁시키는 축.
       * 뒤로 갈수록 상위 티어가 온다 (5거점 = 고대 트렌트 + 세계수의 사도).
       */
      captureReinforcements: [
        [{ defId: 's_elf_archer', count: 5 }, { defId: 's_gouto', count: 10 }],
        [{ defId: 's_druid', count: 2 }, { defId: 's_treekeeper', count: 3 },
          { defId: 's_mushroom_bomber', count: 2 }],
        [{ defId: 's_butterfly', count: 3 }, { defId: 's_owl', count: 3 }],
        [{ defId: 's_thorn_witch', count: 2 }, { defId: 's_marksman', count: 2 }],
        [{ defId: 's_treant', count: 1 }, { defId: 's_apostle', count: 1 }],
      ],
      /** 거점 하나당 인컴 +5 (기본 30 기준). 다섯 곳이면 +25. */
      pointIncomeAdd: 5,
      garrisons: [
        // 거점 1 — 전초. 초반 부대로 밀 수 있는 정도
        [{ defId: 'p_skeleton', count: 5 }, { defId: 'p_bone_thrower', count: 2 }],
        // 거점 2 — 기사가 섞인다
        [{ defId: 'p_skeleton', count: 6 }, { defId: 'p_bone_thrower', count: 3 },
          { defId: 'p_headless_knight', count: 2 }],
        // 거점 3 — 시체골렘이 앞을 막는다
        [{ defId: 'p_skeleton', count: 6 }, { defId: 'p_bone_thrower', count: 4 },
          { defId: 'p_headless_knight', count: 3 }, { defId: 'p_corpse_golem', count: 1 }],
        /*
         * 거점 4·5 — 수가 아니라 질로 막는다.
         * 잡졸을 잔뜩 세우면 화면이 유닛으로 뒤덮여 렉이 걸린다. 소수의
         * 데미리치·마몬으로 같은 벽을 세우고, 3거점을 확보해야 비로소 나타난다.
         */
        [{ defId: 'p_skeleton', count: 7 }, { defId: 'p_bone_thrower', count: 4 },
          { defId: 'p_headless_knight', count: 3 }, { defId: 'p_corpse_golem', count: 2 },
          { defId: 'p_demilich', count: 5 }, { defId: 'p_mammon', count: 3 }],
        // 거점 5 — 마지막 마디. 마법 캐논이 길목을 때린다
        [{ defId: 'p_skeleton', count: 8 }, { defId: 'p_bone_thrower', count: 5 },
          { defId: 'p_headless_knight', count: 4 }, { defId: 'p_corpse_golem', count: 3 },
          { defId: 'p_demilich', count: 5 }, { defId: 'p_mammon', count: 5 },
          { defId: 'p_thanatos', count: 2 }, { defId: 'c_bone_cannon', count: 2 }],
      ],
      onCompleteSpawn: { defId: 'hollow', label: '⚔ 슬리피 할로우' },
      // 할로우 혼자서는 너무 쉽게 무너졌다 — 이 판의 네임드 셋과 상급진을 함께 세운다
      onCompleteRetinue: [
        { defId: 'c_bone_colossus', count: 1 },
        { defId: 'c_void_necromancer', count: 1 },
        { defId: 'c_radamanthus', count: 1 },
        { defId: 'p_demilich', count: 8 },
        { defId: 'p_mammon', count: 5 },
      ],
      onCompleteDialogue: [
        { who: '', img: '/assets/cutscenes/cs13_hollow.png',
          text: '다섯 번째 마디에 생명수가 스며든 순간 — 길 끝의 어둠에서, 태엽 감기는 소리가 들려왔다.' },
        { who: '슬리피 할로우', text: '…….' },
        { who: '앨리스', img: '', text: '저 걸음걸이… 저 검. 잠깐. 잠깐만.' },
        { who: '앨리스', text: '오빠…? 오웬?! 나야, 알리시아야! 왜 네가 저놈들 편에— 아니, 어떻게 살아서—' },
        { who: '엘로윈', text: '(창백해진다) 오웬. …300년 전, 세계수 앞에서 스러진 초대 숲의 기사다. 시신은 끝내 찾지 못했지. 발타르가… 그를 주워다 문지기로 세웠구나.' },
        { who: '카엘', text: '우리가 넘어야 할 상대가… 아군이었던 사람이라고요?' },
        { who: '슬리피 할로우', text: '(태엽 소리가 어긋난다) ……알, 리…' },
        { who: '앨리스', text: '숲지기, 계획 변경이야. 저 애를 부수지 마. — 되찾아 줘.' },
      ],
    },
    // 소품은 두지 않는다 — 지형 타일이 마스크를 따라 침엽수·바위를 직접 심고,
    // 캠프·다리·천막은 mapdeco.ts 의 MAP_PROPS 가 그림 그대로 놓는다.
    /*
     * 확정 편입 — 봇이 사든 말든 매 턴 출정에 얹힌다.
     * 전부 once: 그 턴에 한 번만 편성에 넣고 이후로는 늘지 않는다
     * (편성은 누적이라 한 번 넣어두면 매 턴 그만큼 계속 나온다).
     *  6턴~  목없는 기사 1
     * 10턴~  밴시 3 + 망령 3
     * 15턴~  데미리치 1
     */
    growth: [
      { defId: 'p_headless_knight', label: '목없는 기사', fromWave: 6, amount: 1, once: true },
      { defId: 'p_banshee', label: '밴시 무리', fromWave: 10, amount: 3, once: true },
      { defId: 'p_wraith', label: '망령 무리', fromWave: 10, amount: 3, once: true },
      { defId: 'p_demilich', label: '💀 데미리치', fromWave: 15, amount: 1, once: true },
    ],
    spawns: [
      // 16턴(900초)부터 뼈 거상이 물러나고 라다만토스가 그 자리를 대신한다
      // 뼈 거상: 끝까지 계속 (170초마다)
      { defId: 'c_bone_colossus', label: '🦴 뼈 거상', everySec: 170 },
      // 15턴(840초)부터 공허 강령술사 — 잡졸 10기를 20초마다 게워 낸다
      { defId: 'c_void_necromancer', label: '🕯 공허 강령술사', atSec: 840, everySec: 170 },
      // 19턴(1080초)부터 라다만토스 — 동시 1기만
      { defId: 'c_radamanthus', label: '☠ 라다만토스', atSec: 1080, everySec: 170, concurrentCap: 1 },
      /*
       * 엘로윈: 9턴(540초)부터. 올 때마다 숲의 부대를 이끌고 온다.
       *
       * 아군 봇을 없애 내 부대가 매 턴 나가게 되자 초반이 너무 헐거워졌다 —
       * 엘로윈까지 처음부터 붙어 있으면 에버그린이 오기도 전에 판이 끝난다.
       * 초반은 카엘 하나로 버티고, 증원은 중반부터 들어온다.
       */
      { defId: 'c_elowyn', label: '🧙 현자 엘로윈 참전!', fromSec: 540, everySec: 240,
        respawnAfterDeathSec: 240, concurrentCap: 1,
        atXTile: 14, friendly: true,
        withUnits: [
          { defId: 's_treekeeper', count: 5 },
          { defId: 's_druid', count: 3 },
          { defId: 's_elf_archer', count: 5 },
        ] },
      // 에버그린: 14턴(840초)부터. 항상 1기만, 쓰러지면 170초 뒤에 다시 온다.
      // 첫 등장에 명궁 셋·나무지기 둘·드루이드 하나를 이끌고 오고,
      // 그때부터 숲의 명궁이 상점에도 풀린다.
      { defId: 'c_evergreen', label: '🏹 신궁 에버그린 참전!', fromSec: 840, everySec: 170,
        concurrentCap: 1, respawnAfterDeathSec: 170, atXTile: 14, friendly: true,
        withUnits: [
          { defId: 's_marksman', count: 3 },
          { defId: 's_treekeeper', count: 2 },
          { defId: 's_druid', count: 1 },
        ],
        unlockUnits: ['s_marksman'],
        onFirstDialogue: [
          { who: '엘로윈', img: '', text: '활시위 소리다. 이 숲에서 저 소리를 내는 건 하나뿐이야.' },
          { who: '에버그린', text: '늦었나? 북쪽 능선을 훑고 오느라 길이 길었다.' },
          { who: '카엘', text: '에, 에버그린?! 살아… 살아 있었구나! 며, 명궁대는?!' },
          { who: '에버그린', text: '여섯 남았다. 그거면 충분해. 셋씩 묶어 쏘면 스무 놈 몫은 하니까.' },
          { who: '엘로윈', text: '명궁대가 돌아왔다. 이제 뒤를 걱정하지 말고 마차를 밀어라.' },
        ] },
      /*
       * 세계수의 사도·트렌트 — 15턴(900초)부터 60초마다 숲이 직접 병력을 보낸다.
       * 22턴(1320초)부터는 규모가 커진다 (앞 규칙은 untilSec 으로 끊는다).
       */
      { defId: 's_apostle', label: '🌳 세계수의 사도', fromSec: 900, everySec: 60, untilSec: 1320,
        count: 1, atXTile: 14, friendly: true },
      { defId: 's_treant', label: '🌳 트렌트', fromSec: 900, everySec: 60, untilSec: 1320,
        count: 1, atXTile: 14, friendly: true },
      { defId: 's_apostle', label: '🌳 세계수의 사도 (증편)', fromSec: 1320, everySec: 60,
        count: 2, atXTile: 14, friendly: true },
      { defId: 's_treant', label: '🌳 트렌트 (증편)', fromSec: 1320, everySec: 60,
        count: 3, atXTile: 14, friendly: true },
      // 카엘: 첫 턴부터 전선에 선다. 쓰러져도 100초 뒤 다시 (동시 1기)
      { defId: 'c_kael', label: '🛡 숲지기 카엘 참전!', everySec: 100, concurrentCap: 1,
        respawnAfterDeathSec: 100, atXTile: 14, friendly: true },
    ],
    briefing: [
      { who: '', img: '/assets/cutscenes/cs13_road.png',
        text: '세계수의 뿌리는 불탄 국경 숲 — 카엘이 지키던 바로 그 길 밑을 지난다.\n뿌리가 마르면 심장도 마른다. 숲은 이제 도망치지 않는다.' },
      { who: '', img: '/assets/cutscenes/cs13_cart.png',
        text: '새벽, 생명수를 실은 마차가 숲의 문을 나섰다. 300년 만의 첫 반격이 — 이 낡은 바퀴 위에 실려 있다.' },
      { who: '엘로윈', text: '뿌리 마디마다 생명수를 부어 오염을 씻어야 한다 — 다섯 군데, 하나도 거를 수 없다.' },
      { who: '', img: '/assets/cutscenes/cs13_camp.png',
        text: '마디마다 옛 국경 수비대의 캠프가 남아 있다. 잿더미가 된 줄 알았던 그곳에서 — 모닥불이 하나둘 다시 타오르기 시작했다.' },
      { who: '티아', img: '', text: '마차가 마디에 서 있는 동안 제가 의식을 올릴게요. 1분이면 돼요. 근처에 부대가 함께 있어야 해요!' },
      { who: '브리아', text: '불타는 숲길에서 마차 호위라. 할증이야. …농담이고, 저 나무들 사이는 좁아. 진형 조심해.' },
      { who: '앨리스', text: '잠깐, 숲지기. …선물이야. 내 태엽 병정이랑 테디 몇, 마차에 실어 뒀어. 상점에서 꺼내 쓰면 돼.' },
      { who: '카엘', text: '웬일로 공짜를…?' },
      { who: '앨리스', text: '공짜 아니야, 투자야. 이 길의 끝에… 확인해 보고 싶은 게 있어.' },
      { who: '카엘', text: '(방패를 고쳐 쥔다) …손 떨리는 건 추워서입니다. 진짜예요. 아침이라 그래요.' },
      { who: '엘로윈', text: '카엘. 무리하지 마라. 네가 무너지면 마차도 함께 무너진다.' },
      { who: '카엘', text: '안 무너집니다. 저 딴 건 몰라도 방패 하나는… 그, 잘 들어서요. 각도 계산도 해 뒀습니다.' },
      { who: '티아', text: '카엘 님, 방패 끈 풀렸어요.' },
      { who: '카엘', text: '…알고 있었습니다.' },
      { who: '엘로윈', text: '적이 마디를 되찾으면 마차는 물러설 수밖에 없다. 서두르지 마라 — 한 마디씩, 확실하게.' },
    ],
    outro: [
      { who: '앨리스', text: '…물러갔어. 부서진 몸을 태엽으로 끌면서. 오빠가— 저게 정말 오빠라면, 300년 동안 저기 있었다는 거잖아.' },
      { who: '앨리스', text: '발타르의 성에 오빠의 머리가 있어. 그게 오빠의 기억이야. 숲지기 — 이게 아까 말한 「내 물건」이야. 찾아와 줘.' },
      { who: '티아', text: '…발밑에서, 심장 뛰는 소리가 들렸어요. 뿌리가 살아났어요.' },
      { who: '사도', text: '(땅에서 일어나며) 뿌리가 기억한다. 아이야, 세계수가 너를 부른다. (숲의 명궁 합류!)' },
    ],
  },
  {
    id: 14, act: 3, title: '걸어가는 숲', goal: '세계수 줄기의 적 주둔지를 걷어내라 — 두 갈래 숲길 (적 거점 5곳)',
    allowedUnits: U14, botDifficulty: 'normal',
    // 적은 다섯 곳에서 쏟아진다 — 성 · 전초 A·B · 전방기지 C·D. 사실상 1:5.
    enemies: ['pandemonium', 'pandemonium', 'pandemonium', 'pandemonium', 'pandemonium'],
    allies: [],
    mission: 'destroy', seed: seedOf(14), mapId: 'greatroot',
    enemySkin: 'bone',
    noTowers: true,
    enemyStartTech: 3,
    // 이 판에 나올 수 있는 판데모니엄 유닛 (거점별 구간 제한이 이 안에서 다시 걸린다)
    enemyAllowedUnits: [
      'p_hound', 'p_bone_thrower', 'p_summoner', 'p_headless_knight',
      'p_corpse_golem', 'p_thanatos', 'p_dementor', 'p_wraith', 'p_banshee',
      'p_demilich', 'p_bone_dragon',
    ],
    // 성 전용으로 디멘터·데미리치·본드래곤을 푼다 (전역 잠금 해제)
    unlockEnemyUnits: ['p_dementor', 'p_demilich', 'p_bone_dragon'],
    // 두 갈래 — 빈 땅을 누르면 그쪽으로 부대를 보낸다.
    // 판은 「가운데 대기」로 시작한다 (길을 고르기 전엔 야영지에 병력을 모은다)
    deployStartHold: true,
    deployLanes: [
      { yTile: -9.0, label: '서쪽 숲길 (C → A)' },
      { yTile: 10.3, label: '동쪽 숲길 (D → B)' },
    ],
    enemyCamps: [
      {
        // ── 발타르의 성 (12시) — 가장 부유하고 가장 강하다
        slot: 0, label: '발타르의 성', x: 53 * FP, y: 0,
        startIncome: 5, startMoney: 500, spendAll: true,
        phases: [
          { fromWave: 1, units: ['p_hound', 'p_bone_thrower'] },
          { fromWave: 5, units: ['p_hound', 'p_bone_thrower', 'p_headless_knight'], preferred: ['p_headless_knight'] },
          { fromWave: 13, units: ['p_headless_knight', 'p_bone_thrower', 'p_corpse_golem', 'p_banshee'], preferred: ['p_banshee', 'p_corpse_golem'] },
          { fromWave: 21, units: ['p_thanatos', 'p_banshee', 'p_bone_dragon', 'p_demilich'] },
          { fromWave: 25, units: ['p_thanatos', 'p_banshee', 'p_bone_dragon', 'p_demilich', 'p_dementor'] },
        ],
        // 21턴부터 매 턴 최소 2기 확정 편입, 25턴부터 디멘터도 섞인다
        forcedGrowth: [
          { fromWave: 21, units: ['p_thanatos', 'p_banshee', 'p_bone_dragon', 'p_demilich'], perWave: 2 },
          { fromWave: 25, units: ['p_dementor'], perWave: 1 },
        ],
      },
      {
        // ── 전초 A (북쪽 중간)
        // A~D 는 스스로 생산하지 않는다 (인컴 0) — 정해진 주기로 「출현」만 한다.
        // 물량 압박을 봇 경제에 맡기면 턴이 갈수록 걷잡을 수 없이 불어난다.
        slot: 1, label: '전초 A', x: 42.2 * FP, y: -8.3 * FP, nexusDefId: 'c_demon_camp',
        startIncome: 0, incomeCap: 0, startMoney: 0,
        phases: [{ fromWave: 1, units: ['p_skeleton'] }],
      },
      {
        slot: 2, label: '전초 B', x: 41.5 * FP, y: 10.3 * FP, nexusDefId: 'c_demon_camp',
        startIncome: 0, incomeCap: 0, startMoney: 0,
        phases: [{ fromWave: 1, units: ['p_skeleton'] }],
      },
      {
        slot: 3, label: '전방기지 C', x: 29.8 * FP, y: -9.0 * FP, nexusDefId: 'c_demon_camp',
        startIncome: 0, incomeCap: 0, startMoney: 0,
        phases: [{ fromWave: 1, units: ['p_skeleton'] }],
      },
      {
        slot: 4, label: '전방기지 D', x: 29.5 * FP, y: 10.3 * FP, nexusDefId: 'c_demon_camp',
        startIncome: 0, incomeCap: 0, startMoney: 0,
        phases: [{ fromWave: 1, units: ['p_skeleton'] }],
      },
    ],
    // 야영지를 지키는 엘프 망루 3기 — 길목이 아니라 「길가」에 선다.
    // (길 한복판에 세우면 부대가 지나다니는 길처럼 안 보인다)
    nestGuards: [
      { defId: 'c_elf_watchtower', xTile: 6, yOffTile: -9.0 },  // 9시 — 서쪽 길가
      { defId: 'c_elf_watchtower', xTile: 6, yOffTile: 9.0 },   // 3시 — 동쪽 길가
      { defId: 'c_elf_watchtower', xTile: 11, yOffTile: 1.5 },  // 12시 — 야영지 앞
    ],
    spawns: [
      // ── 영웅: 상점 「영웅」 탭에서 직접 불러낸다 (한 번 부르면 쓰러져도 계속 다시 온다) ──
      { defId: 'c_kael', label: '🛡 숲지기 카엘 참전!', heroPick: true, everySec: 110,
        concurrentCap: 1, respawnAfterDeathSec: 110, atXTile: 9, friendly: true },
      { defId: 'c_elowyn', label: '🧙 현자 엘로윈 참전!', heroPick: true, everySec: 240,
        concurrentCap: 1, respawnAfterDeathSec: 240, atXTile: 9, friendly: true },
      { defId: 'c_evergreen', label: '🏹 신궁 에버그린 참전!', heroPick: true, everySec: 170,
        concurrentCap: 1, respawnAfterDeathSec: 170, atXTile: 9, friendly: true },
      // 15턴에 합류하는 신규 영웅 — 200초마다 야영지에서 다시 나선다
      { defId: 'c_alice_hero', label: '🎭 인형사 앨리스 참전!', fromSec: 840, everySec: 200,
        concurrentCap: 1, respawnAfterDeathSec: 200, atXTile: 9, friendly: true },
      // ── A~D 증원: 80초마다 「출현」. 거점이 무너지면 그쪽은 영구히 끊긴다 ──
      { defId: 'p_skeleton', label: '전초 A 증원', count: 2, everySec: 80, untilSec: 840,
        atXTile: 42.2, yOffTile: -8.3, whileCampSlot: 1 },
      { defId: 'p_bone_thrower', label: '전초 A 증원', count: 3, everySec: 80, untilSec: 840,
        atXTile: 42.2, yOffTile: -8.3, whileCampSlot: 1 },
      { defId: 'p_skeleton', label: '전초 B 증원', count: 2, everySec: 80, untilSec: 840,
        atXTile: 41.5, yOffTile: 10.3, whileCampSlot: 2 },
      { defId: 'p_bone_thrower', label: '전초 B 증원', count: 3, everySec: 80, untilSec: 840,
        atXTile: 41.5, yOffTile: 10.3, whileCampSlot: 2 },
      { defId: 'p_skeleton', label: '전방기지 C 증원', count: 2, everySec: 80, untilSec: 840,
        atXTile: 29.8, yOffTile: -9.0, whileCampSlot: 3 },
      { defId: 'p_bone_thrower', label: '전방기지 C 증원', count: 3, everySec: 80, untilSec: 840,
        atXTile: 29.8, yOffTile: -9.0, whileCampSlot: 3 },
      { defId: 'p_skeleton', label: '전방기지 D 증원', count: 2, everySec: 80, untilSec: 840,
        atXTile: 29.5, yOffTile: 10.3, whileCampSlot: 4 },
      { defId: 'p_bone_thrower', label: '전방기지 D 증원', count: 3, everySec: 80, untilSec: 840,
        atXTile: 29.5, yOffTile: 10.3, whileCampSlot: 4 },
      // ── 15턴부터: 전방기지는 수를 늘리고, 전초는 정예로 갈아탄다 ──
      { defId: 'p_skeleton', label: '전방기지 C 증원', count: 5, everySec: 80, fromSec: 840,
        atXTile: 29.8, yOffTile: -9.0, whileCampSlot: 3 },
      { defId: 'p_bone_thrower', label: '전방기지 C 증원', count: 5, everySec: 80, fromSec: 840,
        atXTile: 29.8, yOffTile: -9.0, whileCampSlot: 3 },
      { defId: 'p_skeleton', label: '전방기지 D 증원', count: 5, everySec: 80, fromSec: 840,
        atXTile: 29.5, yOffTile: 10.3, whileCampSlot: 4 },
      { defId: 'p_bone_thrower', label: '전방기지 D 증원', count: 5, everySec: 80, fromSec: 840,
        atXTile: 29.5, yOffTile: 10.3, whileCampSlot: 4 },
      { defId: 'p_headless_knight', label: '전초 A 정예', count: 2, everySec: 80, fromSec: 840,
        atXTile: 42.2, yOffTile: -8.3, whileCampSlot: 1 },
      { defId: 'p_wraith', label: '전초 A 정예', count: 2, everySec: 80, fromSec: 840,
        atXTile: 42.2, yOffTile: -8.3, whileCampSlot: 1 },
      { defId: 'p_headless_knight', label: '전초 B 정예', count: 2, everySec: 80, fromSec: 840,
        atXTile: 41.5, yOffTile: 10.3, whileCampSlot: 2 },
      { defId: 'p_wraith', label: '전초 B 정예', count: 2, everySec: 80, fromSec: 840,
        atXTile: 41.5, yOffTile: 10.3, whileCampSlot: 2 },
      // ── 전방기지가 무너지면 그 자리에서 구울 군주가 기어 나온다 ──
      { defId: 'c_ghoul_lord', label: '💀 구울 군주', onCampDown: 3, atXTile: 29.8, yOffTile: -9.0 },
      { defId: 'c_ghoul_lord', label: '💀 구울 군주', onCampDown: 4, atXTile: 29.5, yOffTile: 10.3 },
      // ── 성에서 이따금 내려오는 뼈 용 ──
      { defId: 'c_skullrender', label: '🐉 스컬렌더', everySec: 180, fromSec: 840, atXTile: 53, concurrentCap: 2 },
    ],
    briefing: [
      { who: '사도', text: '뿌리는 되찾았다. 허나 놈들은 이미 줄기를 타고 올라갔다 — 세계수의 몸에 못을 박은 채로.' },
      { who: '사도', text: '숲은 도망치는 법을 잊었다. 이제 걸어가는 법을 기억해낼 것이다. (세계수의 사도·고대 트렌트 합류!)' },
      { who: '티아', text: '벌목장이에요… 세계수 가지를 잘라서 태우고 있어요. 저것들 때문에 뿌리가 말랐던 거예요.' },
      { who: '엘로윈', text: '강을 건너는 다리는 둘뿐이다. 서쪽으로 가면 서쪽만, 동쪽으로 가면 동쪽만 — 가운데 물은 날개 달린 것만 넘는다.' },
      { who: '엘로윈', text: '주둔지를 부숴라. 하나 무너질 때마다 그쪽에서 오던 증원이 끊긴다 — 넷을 다 걷어내면 성만 남는다.' },
      { who: '사도', text: '그리고 하나 더 — 이제 영웅은 스스로 걸어 나오지 않는다. 네가 이름을 불러야 한다.' },
      { who: '사도', text: '상점의 「영웅」 칸에서 부르면 야영지에서 나선다. 한 번 부르면 쓰러져도 다시 온다. 다만 한 판에 셋까지, 다음 이름을 부르기까지는 5분이 걸린다.' },
    ],
    outro: [
      { who: '티아', text: '나무들이… 행진해요. 태어나서 이런 건 처음 봐요.' },
      { who: '사도', text: '못이 뽑혔다. 줄기가 다시 숨을 쉰다.' },
      { who: '앨리스', text: '여기까진 왔네. 이제 진짜 문제는 저 위야 — 발타르의 성.' },
    ],
  },
  {
    id: 15, act: 3, title: '발타르의 성 — 망자의 만찬', goal: '방공망을 뚫고 오웬의 머리를 탈환하라 (넥서스 파괴)',
    allowedUnits: U14, enemies: ['pandemonium', 'pandemonium'], allies: ['marionetta'], botDifficulty: 'normal',
    allyNote: '🤝 앨리스의 군단이 성문을 함께 두드린다!',
    mission: 'destroy', seed: seedOf(15),
    enemyPreferredUnits: ['p_wraith', 'p_banshee', 'p_demilich'],
    spawns: [{ defId: 'c_dread_gargoyle', label: '공포의 가고일', everySec: 120, count: 2 }],
    briefing: [
      { who: '발타르', text: '손님이군. 마침 만찬 시간인데. 메뉴는… 너희들이다.' },
      { who: '아린', text: '…시끄러운 뼈다귀.' },
    ],
    outro: [
      { who: '카엘', text: '(상자를 연다) …투구 속에서, 300년 동안 감지 못한 눈이 우리를 봅니다.' },
    ],
  },
  {
    id: 16, act: 3, title: '시간이 멈춘 평원', goal: '슬리피 할로우와 대치 — 15분간 협공을 버텨라',
    allowedUnits: U14, enemies: ['pandemonium', 'pandemonium', 'pandemonium'], allies: ['sylvarin', 'marionetta'], botDifficulty: 'normal',
    allyNote: '🤝 숲과 인형, 두 군세가 함께 버틴다!',
    mission: 'survive', surviveSec: 900, seed: seedOf(16),
    warcamp: { everySec: 90, units: ['p_skeleton', 'p_skeleton', 'p_hound', 'p_bone_thrower'] },
    spawns: [
      { defId: 'c_bone_colossus', label: '뼈 거상', everySec: 120 },
      { defId: 'c_dread_gargoyle', label: '공포의 가고일', everySec: 160 },
    ],
    briefing: [
      { who: '앨리스', text: '오빠. …나야. 알리시아야. 그때 그 종소리 기억해?' },
      { who: '슬리피 할로우', text: '(멈칫— 태엽 소리가 어긋난다) ……알, 리…' },
      { who: '발타르', text: '고장 났군. 수리해 오지.' },
    ],
    outro: [
      { who: '앨리스', text: '들었지, 숲지기. 오빠가 내 이름을 불렀어. 아직 안에 있어.' },
    ],
  },
  {
    id: 17, act: 3, title: '현자의 참회', goal: '엘로윈의 의식을 지켜라 — 15분간 총공세를 버텨라',
    allowedUnits: U17, enemies: ['pandemonium', 'pandemonium', 'marionetta'], allies: ['sylvarin', 'sylvarin'], botDifficulty: 'hard',
    allyNote: '🤝 실바린 전군이 의식을 지킨다!',
    mission: 'survive', surviveSec: 900, seed: seedOf(17),
    spawns: [
      { defId: 'c_bone_colossus', label: '뼈 거상', everySec: 90 },
      { defId: 'c_ash_revenant', label: '재의 원귀', everySec: 120, count: 2 },
    ],
    briefing: [
      { who: '엘로윈', text: '고백하마. 300년 전, 오웬을 사지로 보낸 작전을 짠 게… 나다.' },
      { who: '엘로윈', text: '그래서 나는 300년을 살았다. 속죄가 끝나지 않아서. (세이지 합류!)' },
      { who: '카엘', text: '그럼 오늘 끝내죠. 같이.' },
    ],
    outro: [
      { who: '엘로윈', text: '…의식 준비가 끝났다. 세계수 앞으로. 자정이 오기 전에.' },
    ],
  },
  {
    id: 18, act: 3, title: '자정의 결전', goal: '최종전 — 자정이 오기 전에 (12분) 발타르의 넥서스를 파괴하라!',
    allowedUnits: U17, enemies: ['pandemonium', 'pandemonium', 'pandemonium'], allies: ['sylvarin', 'marionetta'], botDifficulty: 'hard',
    allyNote: '🤝 세 종족의 연합군이 자정에 맞선다!',
    mission: 'destroy', seed: seedOf(18),
    spawns: [
      { defId: 'c_balthar', label: '👑 최종 보스: 데미리치 발타르', atSec: 180 },
      { defId: 'c_bone_colossus', label: '뼈 거상', everySec: 120 },
    ],
    briefing: [
      { who: '발타르', text: '11시 59분. 이 밤의 다음은 없다. 봄도, 부활도, 너희도.' },
      { who: '카엘', text: '숲은 겨울마다 죽습니다. 그리고 매번 돌아오죠. 그게 우리와 당신의 차이입니다.' },
    ],
    outro: [
      { who: '오웬', text: '(투구를 벗으며 — 300년 만의 얼굴) …알리시아. 많이 컸구나.' },
      { who: '앨리스', text: '(단추 눈에서, 있을 리 없는 눈물) 바보. 나 이제 너보다 나이 많아.' },
      { who: '사도', text: '시계가 다시 돈다. 겨울이 오면 — 봄도 온다.' },
      { who: '엘로윈', text: '카엘. 숲이 네 이름을 기억할 것이다. …나는 이제, 조금 쉬어도 되겠지.' },
      { who: '', text: '— 새벽의 세계수. 카엘이 국경 봉화대에 새 불을 밝힌다. 처음 그 봉화대다. —' },
      { who: '', text: '🌲 실바린 캠페인 「자정의 세계수」 完 — 플레이해 주셔서 감사합니다! 🌲' },
    ],
  },
];

// ── 진행 저장 ─────────────────────────────────────────────────────────────
/** 진행 상황이 바뀔 때마다 호출 — main.ts 가 클라우드 업로드를 연결한다. */
let onProgressChanged: (() => void) | null = null;
export function setProgressListener(fn: () => void): void {
  onProgressChanged = fn;
}

/** 현재 로컬 진행 상황 스냅샷 (클라우드 세이브와 같은 모양). */
export function localSave(): { cleared: number; perks: Record<string, number>; boons: Record<string, string[]>; updatedAt: number } {
  // 서버는 cleared/perks/boons 만 저장한다 — 세계수 경험치는 perks 에 편승시킨다.
  // (perkAlloc 은 PERKS 목록에 있는 id 만 통과시키므로 되읽을 때 자동으로 걸러진다)
  return {
    cleared: campaignCleared(),
    perks: { ...perkAlloc(), _treeXp: treeXpTotal() },
    boons: boonChoices(),
    updatedAt: Date.now(),
  };
}

/** 클라우드에서 받은 진행 상황을 로컬에 통째로 덮어쓴다 (동기화). */
// boons 는 예전 저장본(문자열 하나)일 수도 있다 — 읽는 쪽(boonChoices)이 감싸 준다
export function applySave(save: { cleared: number; perks: Record<string, number>; boons: Record<string, string | string[]> }): void {
  const tx = save.perks['_treeXp'];
  if (typeof tx === 'number' && Number.isFinite(tx) && tx >= 0) {
    localStorage.setItem(TREE_KEY, String(Math.floor(tx)));
  }
  localStorage.setItem(SAVE_KEY, String(Math.max(0, Math.floor(save.cleared))));
  localStorage.setItem(PERK_KEY, JSON.stringify(save.perks ?? {}));
  localStorage.setItem(BOON_KEY, JSON.stringify(save.boons ?? {}));
}

const SAVE_KEY = 'campaign_sylvarin_cleared';

/** 클리어한 최대 스테이지 번호 (0 = 아직 없음). */
export function campaignCleared(): number {
  const n = Number(localStorage.getItem(SAVE_KEY) ?? '0');
  return Number.isFinite(n) ? Math.max(0, Math.min(18, n)) : 0;
}

export function markCampaignCleared(stageId: number): void {
  if (stageId > campaignCleared()) {
    localStorage.setItem(SAVE_KEY, String(stageId));
    onProgressChanged?.();
  }
}

// ── 영웅 특성 「세계수의 축복」 ────────────────────────────────────────────
// 포인트 = 클리어한 스테이지 수. 언제든 무료 재분배. localStorage 저장.
export interface PerkDef {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly desc: string;   // 1포인트당 효과
  readonly max: number;
  /** 이 스테이지를 클리어해야 해금된다 (생략 = 처음부터). */
  readonly requiresStage?: number;
}

/** 13 클리어 시 「영웅 강화」와 축복 「영웅의 성장」이 함께 열린다. */
export const HERO_UNLOCK_STAGE = 13;

export const PERKS: readonly PerkDef[] = [
  { id: 'sap', name: '생명의 축복', icon: '💚', desc: '내 유닛 최대 체력 +3%', max: 5 },
  { id: 'thorn', name: '전장의 결의', icon: '⚔', desc: '내 유닛 공격력 +2%', max: 5 },
  { id: 'fruit', name: '풍요의 열매', icon: '💰', desc: '시작 자금 +50', max: 5 },
  { id: 'season', name: '계절의 흐름', icon: '⏱', desc: '5초마다 수입 +2', max: 5 },
  { id: 'bark', name: '굳건한 방패', icon: '🛡', desc: '내 유닛 방어력 +1', max: 5 },
  { id: 'haste', name: '신속의 손길', icon: '⚡', desc: '내 유닛 공격 속도 +1%', max: 5 },
  { id: 'stride', name: '바람의 걸음', icon: '👣', desc: '내 유닛 이동 속도 +1%', max: 5 },
  { id: 'mana', name: '마력의 흐름', icon: '🔮', desc: '내 유닛 스킬 쿨타임 -1%', max: 5 },
  { id: 'aegis', name: '수호의 껍질', icon: '🔰', desc: '내 유닛 기본 보호막 +10', max: 5 },
  { id: 'roots', name: '깊은 뿌리', icon: '🌱', desc: '인컴 단계 상한 +1 (기본 8 → 최대 11)', max: 3, requiresStage: 8 },
  { id: 'heroLv', name: '영웅의 성장', icon: '⭐', max: 3, requiresStage: HERO_UNLOCK_STAGE,
    desc: '모든 영웅 기본 능력 6종(공격·방어·체력·이동·공속·회복) 한 단계씩' },
];

// ── 세계수 레벨·경험치 ─────────────────────────────────────────────────────
/*
 * 스테이지를 「클리어」하면 경험치를 얻는다 (패배는 0).
 *  · 클리어 경험치 = 8 + 2×스테이지 번호 — 뒤로 갈수록 더 준다.
 *  · 레벨업 필요치 = 12 + 3×다음 레벨 — 1~13 을 한 번씩만 깨면 딱 10레벨쯤.
 *  · 최대 레벨 = 클리어한 최고 스테이지 × 3 — 낮은 판을 다시 돌아 노가다할 수 있다.
 *  · 상한을 넘긴 경험치는 버리지 않고 쌓아 둔다 — 다음 판을 깨서 상한이 오르면 바로 반영.
 *  · 레벨 1마다 축복 포인트 1. (클리어 자체는 이제 포인트를 주지 않는다)
 */
const TREE_KEY = 'camp_tree_xp';

/** 이 스테이지를 클리어하면 받는 경험치. */
export function treeClearXp(stage: number): number {
  return 8 + 2 * stage;
}
/** level 레벨이 되는 데 드는 경험치 (level-1 → level). */
export function treeXpNeed(level: number): number {
  return 12 + 3 * level;
}
export function treeMaxLevel(): number {
  return campaignCleared() * 3;
}
export function treeXpTotal(): number {
  try {
    const raw = localStorage.getItem(TREE_KEY);
    if (raw !== null) {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }
    // 마이그레이션: 예전 저장(클리어만 있던 시절)은 「각 스테이지 1회 클리어」만큼 심어 준다.
    // 안 그러면 기존 유저의 축복 포인트가 통째로 0 이 된다.
    const cleared = campaignCleared();
    let seed = 0;
    for (let st = 1; st <= cleared; st++) seed += treeClearXp(st);
    if (seed > 0) localStorage.setItem(TREE_KEY, String(seed));
    return seed;
  } catch {
    return 0;
  }
}
/** 현재 세계수 레벨 (경험치 누적 → 레벨, 최대 레벨 상한 적용). */
export function treeLevel(): number {
  const cap = treeMaxLevel();
  let xp = treeXpTotal();
  let lv = 0;
  while (lv < cap && xp >= treeXpNeed(lv + 1)) {
    xp -= treeXpNeed(lv + 1);
    lv++;
  }
  return lv;
}
/** 진행 표시용 — 다음 레벨까지 얼마나 왔나. */
export function treeProgress(): { level: number; cap: number; into: number; need: number } {
  const cap = treeMaxLevel();
  let xp = treeXpTotal();
  let lv = 0;
  while (lv < cap && xp >= treeXpNeed(lv + 1)) {
    xp -= treeXpNeed(lv + 1);
    lv++;
  }
  return { level: lv, cap, into: xp, need: treeXpNeed(lv + 1) };
}
/** 클리어 보상 지급. 레벨 변화를 돌려준다 (알림용). */
export function addTreeXp(stage: number): { gained: number; levelBefore: number; levelAfter: number } {
  const levelBefore = treeLevel();
  const gained = treeClearXp(stage);
  try { localStorage.setItem(TREE_KEY, String(treeXpTotal() + gained)); } catch { /* 무시 */ }
  onProgressChanged?.();
  return { gained, levelBefore, levelAfter: treeLevel() };
}
/** 세계수 그림 단계 (1~6) — 8레벨마다 자란다. */
export function treeStageImg(): number {
  return Math.min(6, Math.floor(treeLevel() / 8) + 1);
}
/**
 * 세계수 레벨이 자동으로 주는 보너스 (포인트와 무관).
 *  · 매 레벨: 시작 자금 +5
 *  · 10레벨 초과분마다: 수급량 +0.5%
 *  · 20/25/30/40/48 레벨 고비마다 한 번씩 큰 보너스
 */
export function treeAutoBonus(): {
  startMoney: number; incomePermille: number; hpPct: number; dmgPct: number;
  armorAdd: number; atkSpeedPct: number;
} {
  const lv = treeLevel();
  return {
    startMoney: 5 * lv,
    incomePermille: 5 * Math.max(0, lv - 10),
    hpPct: (lv >= 20 ? 3 : 0) + (lv >= 25 ? 1 : 0) + (lv >= 40 ? 10 : 0) + (lv >= 48 ? 10 : 0),
    dmgPct: (lv >= 20 ? 3 : 0) + (lv >= 25 ? 1 : 0) + (lv >= 40 ? 10 : 0) + (lv >= 48 ? 10 : 0),
    armorAdd: lv >= 30 ? 1 : 0,
    atkSpeedPct: (lv >= 30 ? 10 : 0) + (lv >= 48 ? 10 : 0),
  };
}
/** 레벨 고비 안내 (UI 표) — [레벨, 설명]. */
export const TREE_MILESTONES: readonly [number, string][] = [
  [10, '수급량 증가 시작 (레벨당 +0.5%)'],
  [20, '유닛 체력 +3% · 공격력 +3%'],
  [25, '유닛 체력 +1% · 공격력 +1%'],
  [30, '유닛 방어력 +1 · 공격 속도 +10%'],
  [40, '유닛 공격력 +10% · 체력 +10%'],
  [48, '유닛 공격력 +10% · 체력 +10% · 공격 속도 +10%'],
];

const PERK_KEY = 'campaign_sylvarin_perks';

export function perkAlloc(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(PERK_KEY) ?? '{}') as Record<string, number>;
    const out: Record<string, number> = {};
    for (const p of PERKS) {
      const v = Number(raw[p.id] ?? 0);
      out[p.id] = Number.isFinite(v) ? Math.max(0, Math.min(p.max, Math.floor(v))) : 0;
    }
    return out;
  } catch {
    return Object.fromEntries(PERKS.map((p) => [p.id, 0]));
  }
}

export function savePerkAlloc(alloc: Record<string, number>): void {
  localStorage.setItem(PERK_KEY, JSON.stringify(alloc));
  onProgressChanged?.();
}

export function perkPointsSpent(alloc: Record<string, number>): number {
  return Object.values(alloc).reduce((a, b) => a + b, 0);
}

/** 특성 배분 → sim 에 넘길 보정치. */
// ── 캠페인 유닛 강화 (BOONS) — 스테이지 클리어 보상 ──────────────────────
/**
 * 스테이지 클리어 → 강화가 개방되는 유닛.
 * 개방 시점에 이미 해금돼 있고, 바로 다음 난관에 도움이 되는 유닛으로 배정.
 * (1-8 숲올빼미 = 9라운드 대공전 대비, 1-12 가시 마녀 = 3막 진입 보상)
 */
export const BOON_UNLOCKS: Record<number, readonly string[]> = {
  3: ['s_gouto'],
  5: ['s_elf_archer'],
  6: ['s_marmot'],
  7: ['s_vine_hunter'],
  8: ['s_mushroom_bomber'],
  // 숲올빼미 강화는 9 클리어 보상 — 9라운드는 "지상으로 뚫는" 라운드라
  // 올빼미(무리 사냥)를 미리 주면 공중 스팸으로 의도가 무너진다 (실플레이 확인)
  9: ['s_owl'],
  10: ['s_druid'],
  11: ['s_butterfly'],
  // 2막 마지막 — 3막 문턱에서 크게 푼다. 슬롯도 이때 둘로 늘어난다.
  12: ['s_thorn_witch', 's_wyvern', 's_unicorn', 's_fairy'],
  // 3막: 그 판에서 처음 쓰게 될 유닛의 강화를 한 발 앞서 준다
  13: ['s_treekeeper', 's_marksman'],
  14: ['s_treant', 's_apostle'],
  17: ['s_sage'],
};

/** 2막을 끝내면 유닛마다 강화를 둘까지 고를 수 있다. */
export const BOON_SLOT2_STAGE = 12;
export function boonSlots(): number {
  return campaignCleared() >= BOON_SLOT2_STAGE ? 2 : 1;
}

const BOON_KEY = 'camp_boons';

/**
 * 유닛별 선택된 강화 (unit defId → boon id 배열). 언제든 다시 고를 수 있다.
 * 예전 저장본은 문자열 하나였으므로 읽을 때 배열로 감싼다.
 */
export function boonChoices(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(BOON_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [unit, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[unit] = [v];
      else if (Array.isArray(v)) out[unit] = v.filter((x): x is string => typeof x === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

/** 강화 하나를 켜고 끈다. 슬롯이 꽉 찼으면 가장 먼저 고른 것을 밀어낸다. */
export function toggleBoonChoice(unit: string, boonId: string): void {
  const all = boonChoices();
  const cur = all[unit] ?? [];
  const at = cur.indexOf(boonId);
  let next: string[];
  if (at >= 0) next = cur.filter((x) => x !== boonId);
  else next = [...cur, boonId].slice(-boonSlots());
  if (next.length === 0) delete all[unit];
  else all[unit] = next;
  localStorage.setItem(BOON_KEY, JSON.stringify(all));
  onProgressChanged?.();
}

/** 현재 클리어 수 기준으로 개방된 강화 유닛 목록 (개방 순서대로). */
export function unlockedBoonUnits(): string[] {
  const cleared = campaignCleared();
  return Object.entries(BOON_UNLOCKS)
    .filter(([stage]) => Number(stage) <= cleared)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .flatMap(([, units]) => units);
}

/** 게임에 넘길 유효 강화 id 배열 — 개방된 유닛의 선택만 인정한다. */
export function selectedBoonIds(): string[] {
  const unlocked = new Set(unlockedBoonUnits());
  const all = boonChoices();
  const slots = boonSlots();
  const out: string[] = [];
  for (const [unit, ids] of Object.entries(all)) {
    if (unlocked.has(unit)) out.push(...ids.slice(0, slots));
  }
  return out;
}

export function perksToHero(alloc: Record<string, number>): HeroPerks {
  const auto = treeAutoBonus();
  return {
    hpPct: (alloc.sap ?? 0) * 3 + auto.hpPct,
    dmgPct: (alloc.thorn ?? 0) * 2 + auto.dmgPct,
    startMoney: (alloc.fruit ?? 0) * 50 + auto.startMoney,
    incomeAdd: (alloc.season ?? 0) * 2,
    incomePermille: auto.incomePermille,
    armorAdd: (alloc.bark ?? 0) + auto.armorAdd,
    atkSpeedPct: (alloc.haste ?? 0) + auto.atkSpeedPct,
    moveSpeedPct: alloc.stride ?? 0,
    cdrPct: alloc.mana ?? 0,
    shieldAdd: (alloc.aegis ?? 0) * 10,
    incomeCapAdd: campaignCleared() >= 8 ? (alloc.roots ?? 0) : 0,
  };
}

// ── 대화 오버레이 ─────────────────────────────────────────────────────────
/**
 * 대화 시퀀스 재생. 클릭/스페이스/엔터로 진행, 끝나면 resolve.
 * #dialogue 오버레이 DOM 은 index.html 에 정의되어 있다.
 */
export function runDialogue(lines: readonly DialogueLine[]): Promise<void> {
  return new Promise((resolve) => {
    const box = document.querySelector('#dialogue') as HTMLElement;
    const portrait = box.querySelector('.dlg-portrait') as HTMLImageElement;
    const nameEl = box.querySelector('.dlg-name') as HTMLElement;
    const textEl = box.querySelector('.dlg-text') as HTMLElement;
    const scene = box.querySelector('.dlg-scene') as HTMLImageElement;
    let i = 0;
    let sceneUrl = ''; // 현재 걸려 있는 컷신 그림 (줄을 넘겨도 유지)

    const show = (): void => {
      const line = lines[i]!;
      if (line.img !== undefined) sceneUrl = line.img;
      scene.classList.toggle('hidden', !sceneUrl);
      if (sceneUrl && scene.src !== sceneUrl) scene.src = sceneUrl;
      box.classList.toggle('dlg-cine', !!sceneUrl);
      const url = PORTRAITS[line.who];
      portrait.style.display = url ? '' : 'none';
      if (url) portrait.src = url;
      box.classList.toggle('dlg-right', (line.side ?? speakerSide(line.who)) === 'right');
      nameEl.textContent = line.who || '​';
      nameEl.style.visibility = line.who ? 'visible' : 'hidden';
      textEl.textContent = line.text;
    };

    const advance = (): void => {
      i++;
      if (i >= lines.length) {
        cleanup();
        resolve();
      } else {
        show();
      }
    };
    const onClick = (e: Event): void => {
      e.stopPropagation();
      advance();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        advance();
      } else if (e.key === 'Escape') {
        cleanup();
        resolve(); // 대화 스킵
      }
    };
    const cleanup = (): void => {
      box.classList.add('hidden');
      scene.classList.add('hidden');
      box.classList.remove('dlg-cine');
      box.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };

    box.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    box.classList.remove('hidden');
    show();
  });
}

// ── 영웅 강화 (3막) ───────────────────────────────────────────────────────
/*
 * 13스테이지를 클리어하면 열린다. 영웅마다 강화 포인트 3개를 따로 쥔다.
 * 언제든 무료로 다시 나눌 수 있고, 대전에는 전혀 영향이 없다.
 *
 * 효과는 두 갈래로 나뉜다:
 *  - 심에 넘기는 것: 유닛 정의를 덮어써서(defOv) 체력·공격·스킬 수치를 바꾼다
 *  - 클라가 처리하는 것: 부활 시간·부활 충전·동반 출정 (캠페인 스폰 스크립트 소관)
 */
/**
 * 갈래마다 따로 쥐는 포인트 (13스테이지 클리어 시 영웅마다 지급).
 *
 * 한 주머니에서 다 꺼내 쓰면 「기본 스탯만 몰아 찍기」가 언제나 정답이 된다.
 * 갈래를 나눠 두면 특수·스킬·영웅 능력도 반드시 하나씩 고르게 된다.
 */
/**
 * 「영웅 스킬」 포인트는 영웅마다 주지 않고 전 영웅이 한 주머니를 나눠 쓴다.
 * 어느 영웅에게 줄지 골라야 하고, 그래서 키울 영웅이 정해진다.
 */
export const SHARED_GROUPS: readonly HeroUpgradeDef['group'][] = ['skill'];

/**
 * 공용 영웅 스킬 포인트 — 13 클리어에 1개, 그 뒤로 스테이지를 깰 때마다 +1.
 *
 * 늘어나는 게 핵심이다. 처음엔 스킬 하나를 1단계로만 켤 수 있지만, 판을 깰수록
 * 같은 스킬에 포인트를 더 부어 2·3단계로 깊게 파거나 여러 영웅에게 나눠 줄 수 있다.
 */
export function sharedSkillPoints(): number {
  if (!heroUpgradesOpen()) return 0;
  return Math.max(1, campaignCleared() - HERO_UNLOCK_STAGE + 1);
}

/**
 * 이 갈래에 주어지는 포인트 총량.
 *  · stat   = 0 — 세계수의 축복 「영웅의 성장」이 6종을 한꺼번에 올린다
 *  · skill  = 전 영웅 공용 주머니 (진행도에 따라 늘어난다)
 *  · 나머지 = 영웅마다 하나씩
 */
export function heroGroupCap(group: HeroUpgradeDef['group']): number {
  if (group === 'stat') return 0;
  if (group === 'skill') return sharedSkillPoints();
  return 1;
}

/** 영웅 하나가 자기 몫으로 쥐는 포인트 (특수 + 영웅 능력). */
export function heroOwnPoints(): number {
  return heroGroupCap('special') + heroGroupCap('hero');
}

export interface HeroUpgradeDef {
  readonly id: string;
  readonly hero: string;              // 영웅 defId
  readonly group: 'stat' | 'special' | 'hero' | 'skill';
  readonly name: string;
  readonly icon: string;
  readonly max: number;
  /** 단계별 설명 (0단계 = 기본값 설명, 1..max = 찍었을 때) */
  readonly steps: readonly string[];
  /**
   * 이 능력이 「무엇을 하는가」 한 줄. steps 는 숫자만 담고 있어서
   * 처음 보는 사람은 도발·반사가 뭔지 알 수 없다. 그 빈자리를 메운다.
   */
  readonly desc?: string;
}

// ── 영웅 출정 (14스테이지~) ───────────────────────────────────────────────
/*
 * 14라운드부터 영웅은 스크립트로 저절로 나오지 않는다. 상점 「영웅」 탭에서
 * 직접 불러내고, 한 번 부르면 쓰러져도 계속 다시 온다 (부활은 기존 규칙 그대로).
 * 한 판에 최대 3마리 — 다음 영웅을 부르려면 5분을 기다려야 하므로,
 * 「누구를 먼저 부를 것인가」가 그 판의 첫 결정이 된다.
 */
/** 한 판에 불러낼 수 있는 영웅 수. */
export const HERO_DEPLOY_MAX = 3;
/** 영웅을 하나 부르고 나서 다음을 부를 수 있게 되기까지 (초). */
export const HERO_PICK_COOLDOWN_SEC = 300;

export const HEROES: readonly { id: string; name: string; icon: string; blurb: string }[] = [
  { id: 'c_kael', name: '숲지기 카엘', icon: '🛡',
    blurb: '전열을 붙잡는 방패. 쓰러져도 다시 일어선다.' },
  { id: 'c_elowyn', name: '현자 엘로윈', icon: '🔮',
    blurb: '자리를 잡고 마법을 퍼붓는 포대.' },
  { id: 'c_evergreen', name: '신궁 에버그린', icon: '🏹',
    blurb: '부대와 함께 움직이며 전열을 갉는 다중 사격수.' },
];

/**
 * 영웅 서사 — 강화 패널 「스토리」 탭에서 읽는다.
 * 시나리오 원본(docs/campaign-sylvarin.md)의 사건을 그 영웅 시점으로 풀어 쓴 것.
 */
export interface HeroStory {
  readonly portrait: string;   // /assets/portraits/*.png
  readonly title: string;      // 한 줄 칭호
  readonly quote: string;      // 대표 대사
  readonly sections: readonly { readonly h: string; readonly p: string }[];
}

export const HERO_STORIES: Record<string, HeroStory> = {
  c_kael: {
    portrait: 'kael', title: '국경 숲지기 · 숲의 영웅',
    quote: '숲은 겨울마다 죽어. 그리고 매번 돌아온다. 그게 우리와 너의 차이다.',
    sections: [
      { h: '봉화가 셋', p: '국경 봉화대를 지키는 숲지기였다. 하나가 오르면 척후, 둘이면 습격 — 셋은 300년 동안 한 번도 없었다. 그 밤에 셋이 올랐다. 엘로윈은 그날로 그를 경비병이 아니라 지휘관이라 불렀다.' },
      { h: '전부 데려간다', p: '재를 뿌리며 밀려드는 망자 앞에서 그는 후퇴로마다 숲의 것들을 등에 업었다. 굴도, 겨울잠도, 새끼들도. 「저들이 태우는 건 엘프의 숲이 아니라 모두의 숲이다.」' },
      { h: '무너진 국경', p: '여섯 번째 싸움에서 국경은 끝내 무너졌다. 자신이 지휘한 패배였다. 엘로윈은 말했다 — 「네가 지휘해서 모두 살아서 무너진 거다. 그 차이를 평생 기억해라.」 그날 그는 버티는 것이 이기는 것임을 배웠다.' },
      { h: '내민 손', p: '태엽과 가시의 땅에서 그는 적이었던 인형의 여왕에게 먼저 손을 내밀었다. 「당신들도 당했잖아. 손을 잡자.」 숲지기의 셈법은 단순하다 — 살릴 수 있는 것은 전부 살린다.' },
      { h: '자정 앞에서', p: '세계수 아래, 300년 전에 죽은 기사와 마주 선다. 목 없는 적이 실은 구원해야 할 아군이었음을 알게 된 뒤에도 그는 물러서지 않았다. 새벽이 오면 봉화대에 다시 불을 밝히기 위해.' },
    ],
  },
  c_elowyn: {
    portrait: 'elowyn', title: '세계수의 현자 · 300년의 속죄',
    quote: '이길 수 없는 싸움이다. 버티는 것이 이기는 것이다.',
    sections: [
      { h: '300년을 산 자', p: '세계수를 섬기는 현자. 엘프의 수명으로도 300년은 길다. 숲의 누구도 그가 왜 그토록 오래 사는지 묻지 못했다.' },
      { h: '멘토', p: '봉화가 셋 오른 밤, 그는 젊은 숲지기를 지휘관으로 세웠다. 이기는 법이 아니라 물러서는 법부터 가르쳤다 — 숲을 지키는 싸움은 한 번의 승리로 끝나지 않기 때문이다.' },
      { h: '고백', p: '「300년 전, 초대 숲의 기사 오웬을 사지로 보낸 작전을 짠 게… 나다. 그래서 나는 300년을 살았다. 속죄가 끝나지 않아서.」 그가 늙지 않은 이유는 축복이 아니라 형벌이었다.' },
      { h: '마지막 의식', p: '자정의 의식을 되돌릴 수 있는 것은 세계수 앞에 선 현자뿐이다. 총공세를 등지고 그는 300년 만에 처음으로 끝을 준비했다. 「숲이 네 이름을 기억할 것이다. 나는 이제, 조금 쉬어도 되겠지.」' },
    ],
  },
  c_evergreen: {
    portrait: 'evergreen', title: '숲의 신궁 · 노래하는 활',
    quote: '화살은 하나만 날아가지 않아. 노래처럼, 겹쳐서 간다.',
    sections: [
      { h: '상록의 이름', p: '겨울에도 잎을 떨구지 않는 나무의 이름을 받았다. 숲이 가장 참혹하게 타들어 간 계절에도 그는 전선을 떠나지 않았고, 부대는 그 사실 하나로 버텼다.' },
      { h: '먼 눈', p: '시위를 당기기 전에 이미 세 걸음 뒤의 표적을 본다. 화살 하나가 날아가는 동안 다음 둘이 시위에 걸린다 — 삼연사는 재주가 아니라 그가 세상을 보는 방식이다.' },
      { h: '노래', p: '그의 활시위는 소리를 낸다. 질풍의 노래가 흐르면 부대의 발이 가벼워지고, 광란의 노래가 오르면 시위가 눈으로 좇을 수 없게 빨라진다. 숲은 그 소리를 듣고 어디를 지켜야 할지 안다.' },
      { h: '잎새의 장막', p: '적이 다가오면 싸우지 않고 거리를 되찾는다. 맞는 순간 잎에 몸을 숨겨 조준에서 사라진다. 앞에 서는 영웅이 아니라, 끝까지 남아 마지막 화살을 쏘는 영웅이다.' },
    ],
  },
};

/**
 * 모든 영웅 공통 「기본」 스탯 강화 — 영웅마다 같은 6종.
 * % 기반이라 몸값에 비례해 붙는다 (카엘 체력 +10% 와 에버그린 체력 +10% 는 절대값이 다르다).
 */
function commonStats(hero: string, p: string): HeroUpgradeDef[] {
  return [
    { id: `${p}_c_atk`, hero, group: 'stat', name: '공격력 강화', icon: '⚔', max: 3,
      steps: ['기본 공격력', '공격력 +10%', '공격력 +20%', '공격력 +30%'] },
    { id: `${p}_c_arm`, hero, group: 'stat', name: '방어력 강화', icon: '🛡', max: 3,
      steps: ['기본 방어력', '방어력 +1', '방어력 +2', '방어력 +3'] },
    { id: `${p}_c_hp`, hero, group: 'stat', name: '체력 강화', icon: '❤', max: 3,
      steps: ['기본 체력', '체력 +10%', '체력 +20%', '체력 +30%'] },
    { id: `${p}_c_mv`, hero, group: 'stat', name: '이동 속도 강화', icon: '👣', max: 3,
      steps: ['기본 이동 속도', '이동 속도 +10%', '이동 속도 +20%', '이동 속도 +30%'] },
    { id: `${p}_c_as`, hero, group: 'stat', name: '공격 속도 강화', icon: '⚡', max: 3,
      steps: ['기본 공격 속도', '공격 속도 +10%', '공격 속도 +20%', '공격 속도 +30%'] },
    { id: `${p}_c_rg`, hero, group: 'stat', name: '회복력 강화', icon: '💚', max: 3,
      steps: ['기본 회복', '초당 회복 +1', '초당 회복 +2', '초당 회복 +3'] },
  ];
}

export const HERO_UPGRADES: readonly HeroUpgradeDef[] = [
  // ── 숲지기 카엘 ─────────────────────────────────────────────────────
  // 기본 스펙 — 전 영웅 공통
  ...commonStats('c_kael', 'k'),
  // 특수 능력
  { id: 'k_splash', hero: 'c_kael', group: 'special', name: '휩쓸기', icon: '💥', max: 3,
    desc: '평타가 광역이 된다 — 한 번에 여럿을 후려친다',
    steps: ['단일 공격', '평타 광역 2타일', '평타 광역 3타일', '평타 광역 4타일'] },
  { id: 'k_air', hero: 'c_kael', group: 'special', name: '숲의 장궁', icon: '🏹', max: 1,
    desc: '평타로 공중 유닛도 때릴 수 있게 된다',
    steps: ['대공 불가', '활을 들어 공중도 때린다'] },
  { id: 'k_regen', hero: 'c_kael', group: 'special', name: '숲의 맥박', icon: '🌿', max: 3,
    desc: '가만히 있어도 체력이 차오른다 — 전선에서 오래 버티는 밑천',
    steps: ['초당 8 회복', '초당 15 회복', '초당 20 회복', '초당 25 회복'] },
  // 영웅 능력 (클라가 처리 — 부활·동반 출정)
  { id: 'k_revive', hero: 'c_kael', group: 'hero', name: '부활 속도 증가', icon: '⏳', max: 3,
    desc: '쓰러진 뒤 다시 나오기까지 걸리는 시간이 짧아진다',
    steps: ['부활 100초', '부활 90초', '부활 80초', '부활 70초'] },
  { id: 'k_retinue', hero: 'c_kael', group: 'hero', name: '출정 유닛 강화', icon: '👥', max: 3,
    desc: '참전할 때 부대를 함께 데려온다',
    steps: ['없음',
      '출정마다 궁수5·고우토5·마멋3·드루이드1 동반',
      '출정마다 궁수8·마멋5·드루이드2·레쉬2 동반',
      '출정마다 궁수8·마멋5·드루이드3·레쉬3·나무지기1 동반'] },
  { id: 'k_charge', hero: 'c_kael', group: 'hero', name: '부활 충전', icon: '♻', max: 2,
    desc: '살아 있는 동안 부활이 미리 채워진다 — 차 있으면 즉시 부활',
    steps: ['충전 없음',
      '살아 있는 동안 부활이 1회 충전 — 충전돼 있으면 즉시 부활',
      '부활 2회까지 충전 (각각 따로 찬다)'] },
  // 영웅 스킬
  { id: 'k_taunt', hero: 'c_kael', group: 'special', name: '숲의 부름', icon: '📣', max: 3,
    desc: '주변 적이 나만 노리게 만든다 — 뒤에 선 아군이 안 맞는다',
    steps: ['도발 10초 · 쿨 20초', '도발 12초 · 쿨 20초', '도발 14초 · 쿨 20초', '도발 16초 · 쿨 20초'] },
  { id: 'k_shield', hero: 'c_kael', group: 'skill', name: '세계수의 방패', icon: '✨', max: 3,
    desc: '잠깐 모든 피해를 무시한다 — 몰매를 한 번 끊는다',
    steps: ['무적 4초 · 쿨 40초', '무적 5초 · 쿨 38초', '무적 6초 · 쿨 36초', '무적 7초 · 쿨 34초'] },
  { id: 'k_thorns', hero: 'c_kael', group: 'skill', name: '가시 껍질', icon: '🌵', max: 3,
    desc: '맞은 평타의 일부를 때린 쪽에 되돌려준다 (마법은 안 됨)',
    steps: ['반사 50% · 8초 · 쿨 30초', '반사 60% · 8초 · 쿨 28초',
      '반사 70% · 8초 · 쿨 26초', '반사 80% · 10초 · 쿨 24초'] },
  { id: 'k_demo', hero: 'c_kael', group: 'skill', name: '데몰리션', icon: '☄', max: 3,
    desc: '주변 적이 서 있기만 해도 조금씩 깎인다',
    steps: ['없음', '주변 4.5타일 초당 6', '주변 5타일 초당 7', '주변 5.5타일 초당 8'] },
  { id: 'k_guard', hero: 'c_kael', group: 'skill', name: '수호의 맹세', icon: '🤝', max: 3,
    desc: '주변 아군이 받을 피해를 내가 대신 받는다',
    steps: ['없음', '주변 8타일 아군 피해의 60%를 대신 받음',
      '주변 9타일 아군 피해의 70%를 대신 받음', '주변 10타일 아군 피해의 80%를 대신 받음'] },
  { id: 'k_vessel', hero: 'c_kael', group: 'skill', name: '생명의 그릇', icon: '🍶', max: 3,
    desc: '내가 받는 회복량이 늘어난다 — 재생·치유가 다 커진다',
    steps: ['없음', '내가 받는 회복 +100%', '내가 받는 회복 +120%', '내가 받는 회복 +140%'] },
  { id: 'k_shout', hero: 'c_kael', group: 'skill', name: '함성', icon: '🔊', max: 3,
    desc: '외침으로 주변 아군의 체력을 잠시 회복시킨다',
    steps: ['없음', '주변 아군 초당 5 재생 (10초 · 쿨 30초)',
      '주변 아군 초당 7 재생 (10초 · 쿨 30초)', '주변 아군 초당 10 재생 (10초 · 쿨 30초)'] },

  // ── 신궁 에버그린 ───────────────────────────────────────────────────
  // 기본 스펙 — 전 영웅 공통. 「먼 눈(사거리)」은 에버그린만의 강화라 특수로 옮겼다.
  ...commonStats('c_evergreen', 'e'),
  { id: 'e_range', hero: 'c_evergreen', group: 'special', name: '먼 눈', icon: '🎯', max: 3,
    desc: '더 멀리서 쏜다 — 붙기 전에 먼저 깎는다',
    steps: ['사거리 11타일', '사거리 12타일', '사거리 13타일', '사거리 14타일'] },
  // 특수 능력
  { id: 'e_multi', hero: 'c_evergreen', group: 'special', name: '삼연사', icon: '🏹', max: 3,
    desc: '한 번에 여러 적을 동시에 맞힌다',
    steps: ['동시 3기', '동시 4기', '동시 5기', '동시 6기'] },
  { id: 'e_type', hero: 'c_evergreen', group: 'special', name: '바람의 몸', icon: '💨', max: 2,
    desc: '재질 태그를 벗어 「대가죽·대생체」 특효를 무효로 만든다',
    steps: ['가죽 · 생체', '생체 (가죽 없음 — 대가죽 보너스 무효)',
      '무타입 (모든 특효 보너스 무효)'] },
  { id: 'e_vshero', hero: 'c_evergreen', group: 'special', name: '거물 사냥', icon: '👑', max: 3,
    desc: '적 영웅·네임드에게 추가 피해를 준다',
    steps: ['없음', '영웅·네임드에게 +30', '영웅·네임드에게 +40', '영웅·네임드에게 +50'] },
  { id: 'e_crit', hero: 'c_evergreen', group: 'special', name: '급소 겨냥', icon: '💥', max: 3,
    desc: '평타가 치명타로 터질 확률이 오른다',
    steps: ['치명타 25%', '치명타 30%', '치명타 35%', '치명타 40%'] },
  { id: 'e_critdmg', hero: 'c_evergreen', group: 'special', name: '꿰뚫는 한 발', icon: '🎯', max: 3,
    desc: '치명타가 터졌을 때의 배율이 오르고 무작위가 된다',
    steps: ['치명타 피해 150%', '치명타 피해 150~200% (무작위)',
      '치명타 피해 170~220% (무작위)', '치명타 피해 200~250% (무작위)'] },
  // 영웅 능력 (부활·동반 출정 — 클라 담당)
  { id: 'e_revive', hero: 'c_evergreen', group: 'hero', name: '부활 속도 증가', icon: '⏳', max: 3,
    desc: '쓰러진 뒤 다시 나오기까지 걸리는 시간이 짧아진다',
    steps: ['부활 170초', '부활 160초', '부활 150초', '부활 140초'] },
  { id: 'e_retinue', hero: 'c_evergreen', group: 'hero', name: '출정 유닛 강화', icon: '👥', max: 3,
    desc: '참전할 때 명궁대를 함께 데려온다',
    steps: ['명궁 3 · 나무지기 2 · 드루이드 1', '명궁 5 · 나무지기 3 · 드루이드 2',
      '명궁 7 · 나무지기 5 · 드루이드 3', '명궁 10 · 나무지기 7 · 드루이드 5'] },
  { id: 'e_charge', hero: 'c_evergreen', group: 'hero', name: '부활 충전', icon: '♻', max: 2,
    desc: '살아 있는 동안 부활이 미리 채워진다 — 차 있으면 즉시 부활',
    steps: ['충전 없음', '부활 1회 충전 — 충전돼 있으면 즉시 부활', '부활 2회까지 충전'] },
  // 영웅 스킬
  { id: 'e_ward', hero: 'c_evergreen', group: 'skill', name: '숲의 가호', icon: '🍀', max: 3,
    desc: '내 상태이상 면역을 곁의 아군에게도 나눠준다 (판당 1회)',
    steps: ['나만 모든 상태이상 면역',
      '+ 아군 1명에게도 면역 부여 (1회성 — 다시 태어나야 재사용)',
      '+ 아군 2명에게 부여', '+ 아군 3명에게 부여'] },
  { id: 'e_flee', hero: 'c_evergreen', group: 'skill', name: '고립 회피', icon: '🏃', max: 2,
    desc: '곁에 아군이 없으면 싸우지 않고 기지로 물러난다',
    steps: ['6타일 안에 아군 없으면 이속 +20%로 후퇴',
      '10타일 · 이속 +25%', '15타일 · 이속 +30%'] },
  { id: 'e_gale', hero: 'c_evergreen', group: 'skill', name: '질풍의 노래', icon: '🎵', max: 3,
    desc: '주변 아군의 공격·이동 속도를 함께 끌어올린다',
    steps: ['주변 6타일 공·이속 +10% (10초 · 쿨 20초)', '8타일 +12%', '10타일 +15%', '13타일 +18%'] },
  { id: 'e_frenzy', hero: 'c_evergreen', group: 'skill', name: '광란의 노래', icon: '🎶', max: 3,
    desc: '잠깐 내 공격 속도를 극한으로 끌어올린다',
    steps: ['없음', '내 공격 속도 +80% (8초 · 쿨 30초)',
      '내 공격 속도 +80% (8초 · 쿨 25초)', '내 공격 속도 +80% (8초 · 쿨 20초)'] },
  { id: 'e_dance', hero: 'c_evergreen', group: 'skill', name: '바람의 춤', icon: '🌀', max: 1,
    desc: '적이 붙으면 거리를 되찾으며 쏜다 — 몸싸움도 하지 않는다',
    steps: ['없음',
      '적이 사거리 안으로 들어오면 최대 사거리까지 물러나며 쏜다 — 이속 +20%, 충돌 없음'] },
  { id: 'e_veil', hero: 'c_evergreen', group: 'skill', name: '잎새의 장막', icon: '🍃', max: 1,
    desc: '맞는 순간 잎에 몸을 숨겨 조준에서 사라진다',
    steps: ['없음', '공격당하면 4초간 은신 (쿨 20초)'] },
  { id: 'e_rain', hero: 'c_evergreen', group: 'skill', name: '은빛 화살비', icon: '🌧', max: 3,
    desc: '지정한 곳에 은빛 화살이 쏟아진다 — 맞은 적은 회복이 피해가 되고, 모든 공격을 치명타로 맞는다',
    steps: ['없음',
      '지정 지역에 12초간 은빛 화살 — 첫 70 · 초당 25 · 맞은 적에게 신성부식·치명상 10초 (쿨 55초)',
      '첫 85 · 초당 30', '첫 100 · 초당 35'] },

  // ── 현자 엘로윈 ─────────────────────────────────────────────────────
  ...commonStats('c_elowyn', 'w'),
  // 특수 능력 — 「자리를 잡고 마법을 퍼붓는 포대」를 밀어주는 갈래
  { id: 'w_cross', hero: 'c_elowyn', group: 'special', name: '양손 시전', icon: '🤲', max: 1,
    desc: '한 스윙에 지상 하나와 공중 하나를 동시에 맞힌다',
    steps: ['한 번에 하나', '사거리 안의 지상 1기 + 공중 1기를 같이 때린다'] },
  { id: 'w_cadence', hero: 'c_elowyn', group: 'special', name: '가속 시전', icon: '🎼', max: 1,
    desc: '주문을 이어 갈수록 시전이 빨라졌다가, 숨을 고르며 다시 느려진다',
    steps: ['공격 주기 1.4초 고정',
      '주기가 1.4 → 1.2 → 1.0 → 0.8 → 0.6 → 0.8 → 1.0 → 1.2 로 순환'] },
  { id: 'w_cycle', hero: 'c_elowyn', group: 'special', name: '마나 순환', icon: '🔄', max: 3,
    desc: '곁에서 적이 쓰러질 때마다 마나가 고인다 — 다 차면 모든 스킬 쿨이 씻긴다',
    steps: ['없음', '주변 12타일 적 처치 30기마다 전 스킬 쿨 초기화',
      '26기마다 초기화', '22기마다 초기화'] },
  { id: 'w_stance', hero: 'c_elowyn', group: 'special', name: '반석의 자세', icon: '🗿', max: 1,
    desc: '적이 몸으로 밀어도 자리를 내주지 않는다',
    steps: ['밀린다', '어떤 몸싸움에도 밀려나지 않는다'] },
  // 영웅 능력 (부활·동반 출정 — 클라 담당)
  { id: 'w_revive', hero: 'c_elowyn', group: 'hero', name: '부활 속도 증가', icon: '⏳', max: 3,
    desc: '쓰러진 뒤 다시 나오기까지 걸리는 시간이 짧아진다',
    steps: ['부활 240초', '부활 220초', '부활 200초', '부활 180초'] },
  { id: 'w_retinue', hero: 'c_elowyn', group: 'hero', name: '출정 유닛 강화', icon: '👥', max: 3,
    desc: '참전할 때 부대를 함께 데려온다',
    steps: ['없음',
      '나무지기 2 · 드루이드 2 · 가시마녀 1 동반',
      '나무지기 4 · 드루이드 2 · 가시마녀 3 동반',
      '나무지기 5 · 드루이드 3 · 가시마녀 4 동반'] },
  { id: 'w_charge', hero: 'c_elowyn', group: 'hero', name: '부활 충전', icon: '♻', max: 2,
    desc: '살아 있는 동안 부활이 미리 채워진다 — 차 있으면 즉시 부활',
    steps: ['충전 없음', '부활 1회 충전 — 충전돼 있으면 즉시 부활', '부활 2회까지 충전'] },
  // 영웅 스킬 — 마법 4종을 키우거나, 아예 새 주문을 얻는다
  { id: 'w_blaze', hero: 'c_elowyn', group: 'skill', name: '블레이즈 강화', icon: '🔥', max: 3,
    desc: '불구덩이가 더 오래 타고 더 뜨거워진다',
    steps: ['10초 · 초당 34 · 쿨 20초', '13초 · 초당 40 · 쿨 20초',
      '16초 · 초당 44 · 쿨 20초', '20초 · 초당 50 · 쿨 20초'] },
  { id: 'w_arcane', hero: 'c_elowyn', group: 'skill', name: '비전 축적', icon: '🔋', max: 3,
    desc: '주문을 미리 재어 둔다 — 쿨이 다 돌면 한 번 더 쓸 몫이 쌓이고, 연달아 쏠 땐 3초만 쉰다',
    steps: ['차지 없음', '블레이즈 2차지 (연사 간격 3초)',
      '+ 어스퀘이크 2차지', '+ 블리자드 2차지'] },
  { id: 'w_quake', hero: 'c_elowyn', group: 'skill', name: '어스퀘이크 강화', icon: '🌋', max: 3,
    desc: '갈라진 땅이 둔화만 걸던 데서 실제로 지상 유닛을 부수기 시작한다',
    steps: ['둔화만 (지름 7타일)',
      '지름 7타일 · 지상에 120 피해', '지름 7타일 · 140 피해', '지름 7타일 · 180 피해'] },
  { id: 'w_bliz', hero: 'c_elowyn', group: 'skill', name: '블리자드 강화', icon: '❄', max: 3,
    desc: '눈보라가 더 오래 얼리고, 얼지 않던 재질까지 얼리며, 피해까지 준다',
    steps: ['빙결 6초 (판금·거대·구조물 면역)',
      '빙결 9초 · 판금도 얼림 · 지상/공중 88 피해',
      '빙결 9초 · 판금·거대도 얼림 · 102 피해',
      '빙결 9초 · 판금·거대도 얼림 · 120 피해'] },
  { id: 'w_meteor', hero: 'c_elowyn', group: 'skill', name: '메테오 스트라이크', icon: '☄', max: 3,
    desc: '넓은 하늘에서 운석이 쏟아진다 — 맞은 적은 불타고 숨이 막혀 스킬을 못 쓴다',
    steps: ['없음',
      '지름 15타일에 7초간 운석 · 지상/공중 220 피해 · 화상 8초(초당 12) · 질식 4초 (쿨 120초)',
      '피해 240', '피해 280'] },
];

export const HERO_UPGRADES_BY_HERO = new Map<string, HeroUpgradeDef[]>();
for (const u of HERO_UPGRADES) {
  const list = HERO_UPGRADES_BY_HERO.get(u.hero) ?? [];
  list.push(u);
  HERO_UPGRADES_BY_HERO.set(u.hero, list);
}

const HERO_KEY = 'camp_hero_upgrades';
export function heroUpgradesOpen(): boolean {
  return campaignCleared() >= HERO_UNLOCK_STAGE;
}

/** 강화 id → 찍은 단계. */
export function heroAlloc(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HERO_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && v > 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function saveHeroAlloc(alloc: Record<string, number>): void {
  localStorage.setItem(HERO_KEY, JSON.stringify(alloc));
  onProgressChanged?.();
}

/** 이 영웅에게 쓴 포인트 (갈래 지정 시 그 갈래만). */
export function heroPointsSpent(
  hero: string, alloc: Record<string, number>, group?: HeroUpgradeDef['group'],
): number {
  let n = 0;
  for (const u of HERO_UPGRADES_BY_HERO.get(hero) ?? []) {
    if (group && u.group !== group) continue;
    n += alloc[u.id] ?? 0;
  }
  return n;
}

/**
 * 이 갈래에 남은 포인트.
 * 공용 갈래(스킬)는 영웅을 가리지 않고 전체에서 쓴 만큼을 뺀다 — 판 전체에 하나뿐이다.
 */
export function heroGroupLeft(
  hero: string, alloc: Record<string, number>, group: HeroUpgradeDef['group'],
): number {
  const cap = heroGroupCap(group);
  if (SHARED_GROUPS.includes(group)) {
    let spent = 0;
    for (const u of HERO_UPGRADES) if (u.group === group) spent += alloc[u.id] ?? 0;
    return Math.max(0, cap - spent);
  }
  return Math.max(0, cap - heroPointsSpent(hero, alloc, group));
}

/** 이 영웅이 공용 갈래(스킬)에 부어 둔 포인트 수. */
export function sharedSkillSpentOn(hero: string, alloc: Record<string, number>): number {
  let n = 0;
  for (const u of HERO_UPGRADES) {
    if (u.hero !== hero || !SHARED_GROUPS.includes(u.group)) continue;
    n += alloc[u.id] ?? 0;
  }
  return n;
}

/** 공용 스킬 포인트를 나눠 쥔 영웅들 — 「누구를 키우는 중인가」. */
export function sharedSkillHolders(alloc: Record<string, number>): { hero: string; n: number }[] {
  const out: { hero: string; n: number }[] = [];
  for (const h of HEROES) {
    const n = sharedSkillSpentOn(h.id, alloc);
    if (n > 0) out.push({ hero: h.id, n });
  }
  return out;
}

/** 찍은 단계 (상한·개방 여부까지 반영한 실제 값). */
export function heroLv(id: string): number {
  if (!heroUpgradesOpen()) return 0;
  const u = HERO_UPGRADES.find((x) => x.id === id);
  if (!u) return 0;
  // 기본 스탯 6종은 포인트로 찍지 않는다 — 세계수의 축복 「영웅의 성장」 단계를 그대로 쓴다
  if (u.group === 'stat') return Math.min(u.max, heroGrowth());
  return Math.min(u.max, heroAlloc()[id] ?? 0);
}

/** 세계수의 축복 「영웅의 성장」 단계 — 모든 영웅의 기본 스탯이 이만큼 오른다. */
export function heroGrowth(): number {
  if (!heroUpgradesOpen()) return 0;
  return Math.max(0, Math.min(3, perkAlloc()['heroLv'] ?? 0));
}

/**
 * 영웅 강화를 유닛 정의에 반영한 사본.
 *
 * 심에 넘길 수 있는 것만 여기서 처리한다 — 체력·공격·방어·평타·스킬 수치와
 * 새 패시브(데몰리션·수호의 맹세·생명의 그릇), 그리고 「함성」 액티브.
 * 부활 시간·부활 충전·동반 출정은 스폰 스크립트 소관이라 여기서 다루지 않는다.
 */
/**
 * 신궁 에버그린 강화 적용.
 *
 * 「혼합(숲의 총아)」은 모든 수치에 조금씩 얹히므로 다른 줄과 합산한다.
 * 부활 시간·부활 충전·동반 출정은 스폰 스크립트 소관이라 여기서 다루지 않는다.
 */
function applyEvergreen(base: EntityDef): EntityDef {
  // 체력·방어·이속·공속·공격력은 공통 스탯(commonStats)이 이미 base 에 반영돼 있다.
  const lv = (id: string): number => heroLv(id);
  const out: Mutable<EntityDef> = { ...base };

  // 평타 — 사거리(먼 눈)·동시 타격(삼연사)
  const rng = lv('e_range');
  const mt = lv('e_multi');
  if (base.weapon && (rng > 0 || mt > 0)) {
    const w = base.weapon;
    out.weapon = {
      ...w,
      range: w.range + TILE * rng,
      multiTargets: (w.multiTargets ?? 3) + mt,
    };
    if (rng > 0) out.acquireRange = out.weapon.range;
  }
  const crit = lv('e_crit');
  if (crit > 0) out.baseCritPct = 25 + 5 * crit;
  const cd2 = lv('e_critdmg');
  if (cd2 > 0) {
    const r = ([[150, 200], [170, 220], [200, 250]] as const)[cd2 - 1];
    if (r) out.critMulRange = r;
  }
  const vh = lv('e_vshero');
  if (vh > 0) out.bonusVsHero = [0, 30, 40, 50][vh]!;

  // 「바람의 몸」 — 특효 보너스를 피하려고 태그를 벗는다
  const ty = lv('e_type');
  if (ty === 1) out.tags = base.tags.filter((t) => t !== 'leather');
  else if (ty >= 2) out.tags = base.tags.filter((t) => t !== 'leather' && t !== 'bio');

  // 고립 회피
  const fl = lv('e_flee');
  if (fl > 0) out.loneFlee = { radius: TILE * [6, 10, 15][fl]!, speedPct: [20, 25, 30][fl]! };
  // 바람의 춤 / 잎새의 장막 / 숲의 가호 나눔
  if (lv('e_dance') > 0) out.kiteDance = { speedPct: 20 };
  if (lv('e_veil') > 0) out.veilOnHit = { durTicks: SEC * 4, cooldown: SEC * 20 };
  const wd = lv('e_ward');
  if (wd > 0) out.wardGrant = wd;

  // 스킬 — 질풍의 노래 수치 교체 + 새 액티브 두 종
  const gale = lv('e_gale');
  const frenzy = lv('e_frenzy');
  const rain = lv('e_rain');
  if (base.actives && (gale > 0 || frenzy > 0 || rain > 0)) {
    const acts = base.actives.map((a) => {
      if (a.name === '질풍의 노래' && gale > 0) {
        return {
          ...a, auraRadius: TILE * [6, 8, 10, 13][gale]!,
          desc: `주변 아군의 공격 속도·이동 속도 ${[10, 12, 15, 18][gale]!}% 상승 (10초)`,
        };
      }
      return a;
    });
    if (frenzy > 0) {
      acts.push({
        name: '광란의 노래', desc: '내 공격 속도가 8초간 80% 오른다',
        kind: 'selfbuff', cooldown: SEC * [0, 30, 25, 20][frenzy]!, durTicks: SEC * 8,
        atkSpeedPct: 80,
      } as never);
    }
    if (rain > 0) {
      acts.push({
        name: '은빛 화살비',
        desc: `지정 지역에 12초간 은빛 화살 — 첫 ${[0, 70, 85, 100][rain]!} · 초당 ${[0, 25, 30, 35][rain]!}`
          + ' · 맞은 적에게 신성부식·치명상 10초',
        kind: 'zone', targets: 'both', cooldown: SEC * 55, zoneAtTarget: true,
        castRange: TILE * 12, damage: [0, 70, 85, 100][rain]!,
        zone: { kind: 'silverrain', radius: TILE * 2.6, ticks: SEC * 12 },
      } as never);
    }
    out.actives = acts;
  }
  return out;
}

/**
 * 현자 엘로윈 강화 적용.
 *
 * 「자리를 잡고 마법을 퍼붓는 포대」라는 성격을 그대로 밀어준다 —
 * 평타는 교차 사격·가속 사이클로, 마법은 차지·범위·새 주문으로 커진다.
 * 부활 시간·부활 충전·동반 출정은 스폰 스크립트 소관이라 여기서 다루지 않는다.
 */
function applyElowyn(base: EntityDef): EntityDef {
  const lv = (id: string): number => heroLv(id);
  const out: Mutable<EntityDef> = { ...base };

  // ── 특수 ──
  if (lv('w_cross') > 0 && base.weapon) out.weapon = { ...base.weapon, crossTargets: true };
  if (lv('w_cadence') > 0) {
    // 1.4 → 1.2 → 1.0 → 0.8 → 0.6 → 0.8 → 1.0 → 1.2 (그리고 다시 처음으로)
    out.cadence = [28, 24, 20, 16, 12, 16, 20, 24];
  }
  const cyc = lv('w_cycle');
  if (cyc > 0) out.skillReset = { need: [0, 30, 26, 22][cyc]!, radius: TILE * 12 };
  if (lv('w_stance') > 0) out.immovable = true;

  // ── 스킬 ──
  const blaze = lv('w_blaze');
  const quake = lv('w_quake');
  const bliz = lv('w_bliz');
  const arc = lv('w_arcane');
  const met = lv('w_meteor');
  if (!base.actives) return out;

  const acts = base.actives.map((a) => {
    if (a.name === '블레이즈') {
      const secs = [10, 13, 16, 20][blaze]!;
      const dps = [34, 40, 44, 50][blaze]!;
      const o: Record<string, unknown> = { ...a };
      if (blaze > 0) {
        o['zone'] = { ...a.zone!, ticks: SEC * secs };
        // 장판 dps 는 시전자가 덮어쓴다 (ZONE_DEFS.blaze 는 기본값 34)
        o['zoneDps'] = dps;
        o['desc'] = `대상 구역을 ${secs}초간 불구덩이로 만든다 (초당 ${dps})`;
      }
      // 비전 축적 1단계부터 블레이즈가 차지 스킬이 된다
      if (arc >= 1) { o['charges'] = 2; o['chargeGap'] = SEC * 3; }
      return o as never;
    }
    if (a.name === '어스퀘이크') {
      const o: Record<string, unknown> = { ...a };
      if (quake > 0) {
        // 범위는 기본(지름 7타일 = 반경 3.5)을 그대로 둔다 — 커지는 건 위력뿐이다
        o['damage'] = [0, 120, 140, 180][quake]!;
        o['desc'] = `지름 7타일에 지진 — 적 전원 10초 둔화 + 지상에 ${[0, 120, 140, 180][quake]!} 피해`;
      }
      if (arc >= 2) { o['charges'] = 2; o['chargeGap'] = SEC * 3; }
      return o as never;
    }
    if (a.name === '블리자드') {
      const o: Record<string, unknown> = { ...a };
      if (bliz > 0) {
        o['durTicks'] = SEC * 9;
        o['damage'] = [0, 88, 102, 120][bliz]!;
        // 1단계는 판금까지, 2단계부터 거대까지 얼린다 (구조물은 끝까지 면역)
        o['freezeAlsoTags'] = bliz >= 2 ? ['plate', 'massive'] : ['plate'];
        o['desc'] = `대상 지역의 적을 9초간 빙결 + ${[0, 88, 102, 120][bliz]!} 피해`
          + (bliz >= 2 ? ' — 판금·거대도 얼린다' : ' — 판금도 얼린다');
      }
      if (arc >= 3) { o['charges'] = 2; o['chargeGap'] = SEC * 3; }
      return o as never;
    }
    return a;
  });

  if (met > 0) {
    const dmg = [0, 220, 240, 280][met]!;
    acts.push({
      name: '메테오 스트라이크',
      desc: `지름 15타일에 7초간 운석 낙하 — 지상·공중에 ${dmg} 피해`
        + ' · 화상 8초(초당 12) · 질식 4초(액티브 봉인·해제 불가)',
      kind: 'meteor', cooldown: SEC * 120, castRange: TILE * 12,
      splash: TILE * 7.5, damage: dmg,
      burn: { dps: 12, ticks: SEC * 8 }, chokeTicks: SEC * 4,
      zone: { kind: 'meteor', radius: TILE * 7.5, ticks: SEC * 7 },
    } as never);
  }
  out.actives = acts;
  return out;
}

/** 전 영웅 공통 「기본」 스탯 강화 적용 — % 는 원본 수치 기준. */
function applyCommonStats(base: EntityDef, p: string): EntityDef {
  const lv = (k: string): number => heroLv(`${p}_c_${k}`);
  const atk = lv('atk');
  const arm = lv('arm');
  const hp = lv('hp');
  const mv = lv('mv');
  const asp = lv('as');
  const rg = lv('rg');
  if (atk + arm + hp + mv + asp + rg === 0) return base;
  const out: Mutable<EntityDef> = { ...base };
  if (hp > 0) out.maxHp = Math.round(base.maxHp * (100 + 10 * hp) / 100);
  if (arm > 0) out.armor = (base.armor ?? 0) + arm;
  if (rg > 0) out.regenPerSec = (base.regenPerSec ?? 0) + rg;
  if (mv > 0) out.speed = Math.round(base.speed * (100 + 10 * mv) / 100);
  if (base.weapon && (atk > 0 || asp > 0)) {
    const w = base.weapon;
    // 공격력 % 는 상성 보너스(비행 +25 같은)에도 같이 붙는다
    const bonus = w.bonus && atk > 0
      ? Object.fromEntries(Object.entries(w.bonus).map(([k2, v]) => [k2, Math.round(v * (100 + 10 * atk) / 100)]))
      : w.bonus;
    out.weapon = {
      ...w,
      damage: Math.round(w.damage * (100 + 10 * atk) / 100),
      ...(bonus ? { bonus } : {}),
      cooldown: Math.max(1, Math.round((w.cooldown * 100) / (100 + 10 * asp))),
    };
  }
  return out;
}

const COMMON_PREFIX: Record<string, string> = { c_kael: 'k', c_evergreen: 'e', c_elowyn: 'w' };

export function applyHeroUpgrades(base: EntityDef, hero: string): EntityDef {
  if (!heroUpgradesOpen()) return base;
  const prefix = COMMON_PREFIX[hero];
  const common = prefix ? applyCommonStats(base, prefix) : base;
  if (hero === 'c_evergreen') return applyEvergreen(common);
  if (hero === 'c_elowyn') return applyElowyn(common);
  if (hero !== 'c_kael') return common;
  const lv = (id: string): number => heroLv(id);

  const out: Mutable<EntityDef> = { ...common };
  const rg = lv('k_regen');
  // 숲의 맥박은 절대값으로 갈아 끼운다 — 공통 회복 강화 몫은 그 위에 얹는다
  if (rg > 0) out.regenPerSec = [8, 15, 20, 25][rg]! + heroLv('k_c_rg');

  const sp = lv('k_splash');
  const air = lv('k_air');
  if (common.weapon && (sp > 0 || air > 0)) {
    out.weapon = {
      ...common.weapon,
      ...(sp > 0 ? { splash: TILE * (1 + sp) } : {}),
      ...(air > 0 ? { targets: 'both' as const } : {}),
    };
  }
  const demo = lv('k_demo');
  if (demo > 0) out.demolition = { radius: Math.round(TILE * [0, 4.5, 5, 5.5][demo]!), dps: [0, 6, 7, 8][demo]! };
  const gd = lv('k_guard');
  if (gd > 0) out.guardShare = { radius: TILE * [0, 8, 9, 10][gd]!, pct: [0, 60, 70, 80][gd]! };
  const vs = lv('k_vessel');
  if (vs > 0) out.healTakenPct = [0, 100, 120, 140][vs]!;

  // 스킬 수치 — 이름으로 찾아 갈아 끼운다
  const shout = lv('k_shout');
  const taunt = lv('k_taunt');
  const shield = lv('k_shield');
  const thorns = lv('k_thorns');
  if (common.actives && (taunt > 0 || shield > 0 || thorns > 0 || shout > 0)) {
    const acts = common.actives.map((a) => {
      if (a.name === '숲의 부름' && taunt > 0) return { ...a, durTicks: SEC * [10, 12, 14, 16][taunt]! };
      if (a.name === '세계수의 방패' && shield > 0) {
        return { ...a, durTicks: SEC * [4, 5, 6, 7][shield]!, cooldown: SEC * [40, 38, 36, 34][shield]! };
      }
      if (a.name === '가시 껍질' && thorns > 0) {
        return {
          ...a, reflectPct: [50, 60, 70, 80][thorns]!,
          durTicks: SEC * [8, 8, 8, 10][thorns]!, cooldown: SEC * [30, 28, 26, 24][thorns]!,
        };
      }
      return a;
    });
    if (shout > 0) {
      acts.push({
        name: '함성', desc: `주변 아군이 초당 ${[0, 5, 7, 10][shout]!} 회복 (10초)`,
        kind: 'regenAura', cooldown: SEC * 30, durTicks: SEC * 10,
        damage: [0, 5, 7, 10][shout]!, auraRadius: TILE * 7,
      });
    }
    out.actives = acts;
  }
  return out;
}

/** 카엘의 부활 대기 시간(초) — 「불굴」 단계에 따라 줄어든다. */
export function kaelReviveSec(): number {
  return [100, 90, 80, 70][heroLv('k_revive')]!;
}
/** 카엘이 데리고 나오는 부대 — 「숲지기의 부대」 단계별. */
export function kaelRetinue(): { defId: string; count: number }[] {
  const t = heroLv('k_retinue');
  if (t === 1) return [{ defId: 's_elf_archer', count: 5 }, { defId: 's_gouto', count: 5 },
    { defId: 's_marmot', count: 3 }, { defId: 's_druid', count: 1 }];
  if (t === 2) return [{ defId: 's_elf_archer', count: 8 }, { defId: 's_marmot', count: 5 },
    { defId: 's_druid', count: 2 }, { defId: 's_mushroom_bomber', count: 2 }];
  if (t === 3) return [{ defId: 's_elf_archer', count: 8 }, { defId: 's_marmot', count: 5 },
    { defId: 's_druid', count: 3 }, { defId: 's_mushroom_bomber', count: 3 },
    { defId: 's_treekeeper', count: 1 }];
  return [];
}
/** 부활 충전 최대 개수 — 살아 있는 동안 하나씩 찬다. */
export function kaelReviveCharges(): number {
  return heroLv('k_charge');
}

/** 에버그린 부활 대기 (초) — 「숲은 다시 부른다」. */
export function evergreenReviveSec(): number {
  return [170, 160, 150, 140][heroLv('e_revive')]!;
}
/** 에버그린이 데리고 나오는 부대 — 「명궁대」 단계별. */
export function evergreenRetinue(): { defId: string; count: number }[] {
  const t = heroLv('e_retinue');
  const n = [[3, 2, 1], [5, 3, 2], [7, 5, 3], [10, 7, 5]][t]!;
  return [
    { defId: 's_marksman', count: n[0]! },
    { defId: 's_treekeeper', count: n[1]! },
    { defId: 's_druid', count: n[2]! },
  ];
}
/** 에버그린 부활 충전 횟수 — 「부활 충전」. */
export function evergreenReviveCharges(): number {
  return heroLv('e_charge');
}

/** 엘로윈 부활 대기 (초) — 「부활 속도 증가」. */
export function elowynReviveSec(): number {
  return [240, 220, 200, 180][heroLv('w_revive')]!;
}
/** 엘로윈이 데리고 나오는 부대 — 「출정 유닛 강화」 단계별. */
export function elowynRetinue(): { defId: string; count: number }[] {
  const t = heroLv('w_retinue');
  if (t === 1) return [{ defId: 's_treekeeper', count: 2 }, { defId: 's_druid', count: 2 },
    { defId: 's_thorn_witch', count: 1 }];
  if (t === 2) return [{ defId: 's_treekeeper', count: 4 }, { defId: 's_druid', count: 2 },
    { defId: 's_thorn_witch', count: 3 }];
  if (t === 3) return [{ defId: 's_treekeeper', count: 5 }, { defId: 's_druid', count: 3 },
    { defId: 's_thorn_witch', count: 4 }];
  return [];
}
/** 엘로윈 부활 충전 횟수 — 「부활 충전」. */
export function elowynReviveCharges(): number {
  return heroLv('w_charge');
}
