/**
 * 실바린 캠페인 「자정의 세계수」 — 18스테이지.
 * 시나리오 원본: docs/campaign-sylvarin.md
 *
 * 구조: 스테이지 데이터(해금 유닛·적 구성·미션·대사) + 진행 저장(localStorage)
 * + 대화 오버레이. 전투 자체는 기존 솔로(봇전) 엔진을 그대로 쓴다 —
 * 캠페인 레이어는 상점 필터·승리 조건·시드만 오버라이드한다.
 */
import type { BotDifficulty, RaceId, TeamId } from '@desertlike/sim';

export interface DialogueLine {
  readonly who: string;   // 화자 이름 (PORTRAITS 키). '' = 내레이션
  readonly text: string;
  /**
   * 컷신 그림 — 대화창 위에 시네마틱 장면을 띄운다.
   * 지정하면 그때부터 그 그림이 유지되고, '' 을 주면 걷어낸다.
   * (지정 안 한 줄은 직전 그림을 그대로 이어받는다)
   */
  readonly img?: string;
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
    /** 전 거점 확보 시 전투를 멈추고 띄우는 컷신 대화. */
    readonly onCompleteDialogue?: readonly DialogueLine[];
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
  /** true = 수호탑·수호자 없이 넥서스전만 (탑 제거 + 넥서스 보호막 해제). */
  readonly noTowers?: boolean;
  /** 인컴·테크 상한 (전원 공통 — 봇 포함). 생략 시 기본. */
  readonly incomeCap?: number;
  readonly techCap?: number;
  /** 적 봇이 압도적으로 선호하는 유닛 (스테이지 성향 — 예: 공중 스테이지). */
  readonly enemyPreferredUnits?: readonly string[];
  /** 적 유닛별 보유 상한 (팀 합산) — 최상급 유닛의 조기 물량화 방지. */
  readonly enemyUnitCaps?: Readonly<Record<string, number>>;
  /** 아군(팀0) 봇 유닛 수량 상한 (팀 합산) — 아군 물량 폭주 방지. */
  readonly allyUnitCaps?: Readonly<Record<string, number>>;
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
    /**
     * 필드에 동시에 살아 있을 수 있는 최대 수. 이미 그만큼 있으면 이번 차례는 거른다.
     * "죽으면 다시 채워지는 상주 위협"을 만든다 (검은새).
     */
    readonly concurrentCap?: number;
  }[];
  /**
   * 둥지 수호탑 (11스테이지): 게임 시작 시 아군 진영에 고정 배치되는 무적 수호수.
   * 제자리에서 평타만 한다 — 타워 포지션.
   */
  readonly nestGuards?: readonly {
    readonly defId: string;
    readonly xTile: number;
    readonly yOffTile: number;
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
  '엘로윈': '/assets/portraits/elowyn.png',
  '티아': '/assets/portraits/tia.png',
  '브리아': '/assets/portraits/bria.png',
  '실피': '/assets/portraits/silphy.png',
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
const U1 = ['s_gouto', 's_elf_archer'];
const U2 = [...U1, 's_vine_hunter'];
const U3 = [...U2, 's_marmot'];
const U4 = [...U3, 's_druid', 's_mushroom_bomber'];
const U5 = [...U4, 's_owl', 's_butterfly'];
const U8 = [...U5, 's_thorn_witch'];
const U11 = [...U8, 's_wyvern', 's_unicorn', 's_fairy'];
const U13 = [...U11, 's_marksman', 's_treekeeper'];
const U14 = [...U13, 's_apostle', 's_treant'];
const U17 = [...U14, 's_sage'];

const seedOf = (id: number): number => (id * 7919 + 3) | 0;

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
      { who: '카엘', img: '', text: '봉화가… 셋. 셋이면 전면 침공이잖아.' },
      { who: '엘로윈', text: '놈들이 노리는 건 마을이 아니다 — 세계수의 심장이다. 정면으로는 못 이겨. 우리는 시간을 벌며 물러나야 한다.' },
      { who: '엘로윈', text: '300년 만이군. 카엘, 궁수들을 깨워라. 오늘부터 너는 경비병이 아니라 지휘관이다.' },
      { who: '엘로윈', text: '유닛을 사면 부대에 영구 편성된다. 네 차례가 올 때마다 부대 전체가 출격하지. 오늘 임무는 정찰이다 — 적의 수호탑만 무너뜨려라.' },
      { who: '엘로윈', text: '탑이 무너지면 그 자리에 「문지기」가 깨어난다. 그놈과는 싸우지 마라. 아직은.' },
    ],
    outro: [
      { who: '카엘', text: '탑이 무너지자… 목 없는 기사가 일어났다. 마을을 태운 게 저놈이야.' },
      { who: '엘로윈', text: '(침묵) …철수한다. 잘 싸웠다, 카엘. 이건 척후일 뿐 — 재 냄새가 바람을 타고 온다.' },
    ],
  },
  {
    id: 2, act: 1, title: '재가 내리는 길', goal: '피난 행렬 호위 — 15분간 넥서스를 지켜라',
    allowedUnits: U2, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'survive', surviveSec: 900, seed: seedOf(2), noTowers: true, incomeCap: 3, techCap: 2,
    spawns: [{ defId: 'c_ash_revenant', label: '재의 원귀', everySec: 150 }],
    briefing: [
      { who: '티아', text: '남쪽 마을이 전부 비었어요. 걷지 못하는 노목(老木)들은… 두고 왔대요.' },
      { who: '카엘', text: '전부 데려간다. 숲은 누구도 버리지 않아.' },
    ],
    outro: [
      { who: '티아', text: '고마워요. …근데 카엘, 저 재는 나무를 태운 재가 아니에요. 뼈를 간 가루예요.' },
      { who: '티아', text: '아, 그리고 이거 — 피난민들이 세계수 수액을 나눠줬어요. 캠페인 화면의 「🌿 세계수의 축복」에서 힘을 나눠 받을 수 있어요.' },
      { who: '티아', text: '스테이지를 깰 때마다 축복이 깊어지고, 언제든 공짜로 다시 나눌 수 있대요. 적이 강해질수록 이 힘이 필요할 거예요.' },
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
      { who: '카엘', text: '저들이 태우는 건 엘프의 숲이 아니라 모두의 숲이다. 굴도, 겨울잠도, 새끼들도.' },
      { who: '마멋 족장', text: '…버텨 봐라. 마멋은 강한 자의 말만 듣는다.' },
    ],
    outro: [
      { who: '마멋 족장', text: '…철갑을 채워라. 마멋은 빚을 지면 갚는다. (갑옷 마멋 합류!)' },
    ],
  },
  {
    id: 4, act: 1, title: '독이 스민 숲', goal: '적 넥서스를 파괴하라 — 독은 드루이드가 씻는다',
    allowedUnits: U4, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'destroy', seed: seedOf(4), noTowers: true,
    spawns: [{ defId: 'c_ash_revenant', label: '재의 원귀', everySec: 150 }],
    briefing: [
      { who: '브리아', text: '어머, 정규군이 여기까지? 이 앞은 내 정원인데. 통행료는 비싸.' },
      { who: '카엘', text: '…지금 숲이 불타는데 통행료?' },
      { who: '브리아', text: '숲이 불타니까 몸값이 오르는 거야. 전쟁 경제 몰라?' },
    ],
    outro: [
      { who: '티아', text: '저 마녀, 말은 저래도… 독에 당한 애들 해독초를 두고 갔어요.' },
    ],
  },
  {
    id: 5, act: 1, title: '올빼미 성채', goal: '적 넥서스를 파괴하라 — 하늘을 조심할 것',
    allowedUnits: U5, enemies: ['pandemonium'], allies: [], botDifficulty: 'easy',
    mission: 'destroy', seed: seedOf(5), noTowers: true,
    // 첫 공중전 학습 스테이지 (easy) — 망령·밴시 편대 위주
    enemyPreferredUnits: ['p_wraith', 'p_banshee', 'p_demilich'],
    spawns: [{ defId: 'c_dread_gargoyle', label: '공포의 가고일', everySec: 120 }],
    briefing: [
      { who: '실피', text: '…하늘.' },
      { who: '카엘', text: '하늘이 뭐? …저게 다 날아온다고?!' },
    ],
    outro: [
      { who: '실피', text: '떨어지는 건 전부 맞은 거야. (실피 합류)' },
    ],
  },
  {
    id: 6, act: 1, title: '재의 함락', goal: '이길 수 없는 싸움 — 15분간 대피 시간을 벌어라',
    allowedUnits: U5, enemies: ['pandemonium', 'pandemonium', 'pandemonium'], allies: ['sylvarin'], botDifficulty: 'hard',
    allyNote: '🤝 엘로윈의 잔존 병력이 함께 싸운다!',
    mission: 'survive', surviveSec: 900, seed: seedOf(6), noTowers: true,
    spawns: [
      { defId: 'c_kurga', label: '⚔ 보스: 리치 쿠르가', atSec: 300 },
      { defId: 'c_ash_revenant', label: '재의 원귀', everySec: 90 },
      { defId: 'c_bone_colossus', label: '뼈 거상', atSec: 600, everySec: 180 },
    ],
    briefing: [
      { who: '쿠르가', text: '타라, 타라, 푸른 것들아! 발타르 님의 겨울에 봄은 오지 않는다!' },
      { who: '엘로윈', text: '카엘. 이길 수 없는 싸움이다. 버티는 것이 이기는 것이다. 모두를 물려라.' },
    ],
    outro: [
      { who: '카엘', text: '…국경이 무너졌어. 내가 지휘했는데.' },
      { who: '엘로윈', text: '네가 지휘해서 모두 살아서 무너진 거다. 그 차이를 평생 기억해라.' },
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
      { who: '카엘', text: '남쪽 산맥을 넘어 발타르의 성을 우회한다. 이 나라를 지나가야만 해.' },
      { who: '티아', img: '/assets/cutscenes/cs21_dolls.png', text: '여긴… 장난감 마을? 근데 왜 전부 이쪽을 보고 있죠?' },
      { who: '광대 인형', text: '침・입・자. 여왕님의 골목. 통과 금지. 껴안아 주기. 터질 때까지.' },
    ],
    outro: [
      { who: '카엘', text: '인형이 왜 국경을 지키지? 인형의 왕국에 대체 무슨 일이…' },
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
      { who: '카엘', text: '…왜 도와주는 건데.' },
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
      { who: '카엘', text: '중앙을 장악한 쪽이 용병을 산다… 전선 싸움이 곧 돈 싸움이군. (🚩 상점 주변을 점령하면 💰용병 구매 가능!)' },
    ],
    outro: [
      { who: '카엘', text: '용병 장부를 손에 넣었다. …발타르가 사들인 게 뼈만이 아니야. 「세계수 심장의 열쇠」?' },
    ],
  },
  {
    id: 11, act: 2, title: '바람의 둥지', goal: '둥지를 지켜라 — 세 방향에서 몰려온다 (30턴 버티기)',
    allowedUnits: U11, enemies: ['pandemonium'], allies: [], botDifficulty: 'normal',
    mission: 'survive', surviveSec: 1800, noTowers: true,
    seed: seedOf(11), mapId: 'nest',
    enemySkin: 'bone',
    // ── 11 = 판데 중상급의 무대: 시체 골렘·타나토스·밴시가 주역 ──
    // 데미리치·마몬(끝판급)은 아직 이르다 — 25턴부터, 그것도 소수 정예(캡 3)만.
    // preferred ×8 가중은 폭주 함정이라 반드시 캡과 함께 쓴다 (타나토스 47기 실측).
    // 망령을 앞에 세워 "인컴+테크 그리디"를 초반부터 응징한다 — 공중 위협이
    // 1~2턴부터 꾸준해야 방어에 돈을 쓰게 된다 (밴시는 테크3 즉시 합류)
    enemyPreferredUnits: ['p_wraith', 'p_corpse_golem', 'p_thanatos', 'p_banshee'],
    enemyUnitMinWave: {
      // 끝판 유닛은 25턴에야 모습을 드러낸다
      p_demilich: 25, p_mammon: 25,
      // 주역 지상 2종은 초반 몇 턴은 잡졸이 먼저 (테크 진행 느낌)
      p_corpse_golem: 5, p_thanatos: 7, p_banshee: 5,
    },
    enemyUnitCaps: {
      // 주역 — 물량감은 있되 무한 누적은 금지 (팀 합산 편성 상한)
      p_corpse_golem: 12, p_thanatos: 10, p_banshee: 10, p_wraith: 8,
      // 조연 — 소수만
      p_bone_thrower: 6, p_headless_knight: 12,
      p_lich: 4, p_corpsecaller: 4,
      // 25턴부터의 끝판 손님은 딱 3기씩
      p_demilich: 3, p_mammon: 3,
    },
    // 수비 모드: 부대가 둥지 주변에 대기하다 침입 방향으로 자동 요격한다
    defendNexus: true,
    // 둥지 수호탑: 세 갈래 입구에 하나씩 (평타만 — 타워)
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
      // 12시: 수직 가지 길 꼭대기(-36타일)에서 능선을 타고 내려온다
      { defId: 'p_minion_ghoul', label: '⬆ 능선의 망자 무리', everySec: 12, count: 2, atXTile: 47, yOffTile: -36 },
      { defId: 'p_minion_undead', label: '⬆ 능선의 망자 무리', everySec: 17, count: 2, atXTile: 49, yOffTile: -36 },
      { defId: 'p_minion_skeleton', label: '⬆ 능선의 망자 무리', everySec: 14, count: 2, atXTile: 48, yOffTile: -34 },
      { defId: 'p_minion_rat', label: '⬆ 능선의 망자 무리', everySec: 9, count: 3, atXTile: 48, yOffTile: -32 },
      // 능선의 망령: 2분부터 하늘로도 꾸준히 내려온다 — 인컴 그리디의 천적
      { defId: 'p_wraith', label: '⬆ 능선의 망령', atSec: 120, everySec: 50, count: 2, atXTile: 47, yOffTile: -34 },
      // 8시: V자 왼쪽 끝 골짜기에서 올라온다 (중립: 시간이 갈수록 사나워진다)
      { defId: 'c_wild_wolf_gray', label: '⬋ 야생 늑대 무리', everySec: 25, count: 4, atXTile: 8, yOffTile: 0, neutral: true },
      { defId: 'c_wild_snake', label: '⬋ 독사 떼', everySec: 30, count: 3, atXTile: 5, yOffTile: 0, neutral: true },
      { defId: 'c_wild_wolf_black', label: '⬋ 검은늑대 무리', atSec: 120, everySec: 40, count: 3, atXTile: 8, yOffTile: 0, neutral: true },
      { defId: 'c_wild_tarantula', label: '⬋ 타란튤라', atSec: 180, everySec: 50, count: 2, atXTile: 6, yOffTile: 0, neutral: true },
      // 황조롱이는 1분 반부터 — 공중 조합에도 초반부터 성가신 손님이 있어야 한다
      { defId: 'c_wild_kestrel', label: '⬋ 황조롱이 떼', atSec: 90, everySec: 35, count: 3, atXTile: 10, yOffTile: -1, neutral: true },
      { defId: 'c_wild_bear_gray', label: '⬋ 회색곰', atSec: 360, everySec: 70, count: 2, atXTile: 6, yOffTile: 0, neutral: true },
      { defId: 'c_wild_direwolf', label: '⬋ 다이어울프 무리', atSec: 540, everySec: 60, count: 3, atXTile: 8, yOffTile: 0, neutral: true },
      { defId: 'c_wild_grizzly', label: '⬋ 그리즐리베어', atSec: 600, everySec: 80, count: 2, atXTile: 6, yOffTile: 0, neutral: true },
      // 14턴부터 상시 3기 유지 — 죽으면 다시 날아온다 (출현 1회가 아니라 지속 위협)
      { defId: 'c_wild_blackbird', label: '⚫ 검은새 — 하늘의 왕', atSec: 840, everySec: 45, concurrentCap: 3, atXTile: 5, yOffTile: -2, neutral: true },
    ],
    briefing: [
      { who: '엘로윈', text: '높은 봉우리의 옛 맹약을 깨울 때다. 와이번은 긍지가 높다 — 명령하지 말고 부탁해라.' },
      { who: '카엘', text: '(와이번에게) …함께 날아 주겠어? (와이번·유니콘·페어리 합류!)' },
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
    deadlineWave: 45,
    // 앨리스 군단(아군 봇)은 위 갈래 끝에서 출정해 합류점으로 내려온다
    allyDeployTile: { x: 30, y: -13 },
    // 적 물량은 봇 생산 + 확정 증원 — 보스만 잡는 게 아니라 물량전을 버티며 뚫는다
    growth: [
      { defId: 'p_headless_knight', label: '사령 기사단', fromWave: 4 },
      { defId: 'p_demilich', label: '데미리치 친위대', fromWave: 8 },
    ],
    enemyUnitCaps: { p_headless_knight: 8, p_demilich: 4 },
    briefing: [
      { who: '마몬', text: '배신? 아니지, 더 좋은 조건이 왔을 뿐! 발타르 님이 너희 숲을 통째로 주신다더군!' },
      { who: '', text: '계곡 끝에서 거대한 그림자가 일어선다. 발타르가 아끼는 선봉장 — 사령장군 카르가스.' },
      { who: '카엘', text: '마몬이 저걸 데려온 건가… 넥서스가 문제가 아니야. 저 장군을 쓰러뜨려야 길이 열린다.' },
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
    allowedUnits: U13, enemies: ['pandemonium', 'pandemonium'], allies: ['sylvarin'], botDifficulty: 'normal',
    allyNote: '🤝 숲의 잔존 병력이 합류했다!',
    mission: 'destroy', seed: seedOf(13), mapId: 'ashroad',
    enemySkin: 'bone',
    noTowers: true, // 수호탑 대신 — 전 거점 확보 시 슬리피 할로우가 직접 나타난다
    // 앨리스의 지원 병력: 사람 플레이어만 살 수 있다 (race: null — 봇 구매 풀 제외)
    mercUnits: ['c_alice_soldier', 'c_alice_teddy'],
    // 물량 상한 — 마몬·데미리치가 무한히 쌓여 후반이 벽이 되는 것 방지
    enemyUnitCaps: { p_mammon: 30, p_demilich: 20 },
    // 아군 봇의 세이지 금지 — 마법 화력은 엘로윈(스폰 이벤트) 단 한 명뿐
    allyUnitCaps: { s_sage: 0 },
    // 숲의 망루(무적 포탑, 현자의 비전 화살): 캠프에 하나씩 + 사잇길에 외딴 망루 —
    // 옛 국경 감시선이 길을 따라 띄엄띄엄 남아 있는 그림
    nestGuards: [
      // 가장자리 전용 + 캠프 천막 무리에서 몇 타일 떨어뜨려 세운다
      { defId: 'c_sage_watchtower', xTile: 20, yOffTile: -4.3 },
      { defId: 'c_sage_watchtower', xTile: 24.5, yOffTile: 4.4 },
      { defId: 'c_sage_watchtower', xTile: 36, yOffTile: -4.4 },
      { defId: 'c_sage_watchtower', xTile: 51, yOffTile: -4.5 },
      { defId: 'c_sage_watchtower', xTile: 56, yOffTile: 4.3 },
      { defId: 'c_sage_watchtower', xTile: 70.8, yOffTile: 4.4 },
      { defId: 'c_sage_watchtower', xTile: 76, yOffTile: -4.3 },
      { defId: 'c_sage_watchtower', xTile: 84.6, yOffTile: -4.4 },
      { defId: 'c_sage_watchtower', xTile: 103.2, yOffTile: 4.4 },
    ],
    // 엘로윈 참전: 4분에 등장(대사와 함께), 쓰러지면 잠시 후 다시 온다 (동시 1명)
    cutscenes: [{
      atSec: 240,
      lines: [
        { who: '엘로윈', text: '(지팡이 끝이 빛난다) 이 길은 300년 전에도 내가 걸었다. …늙은이가 앞장서마.' },
        { who: '티아', text: '스승님?! 전선에 직접 나오시는 건 처음 봐요!' },
        { who: '엘로윈', text: '뿌리가 마르는데 서재에 앉아 있을 수는 없지. 카엘 — 마법은 내가 맡는다.' },
      ],
    }],
    // 호위전: 마차가 거점에 서 있는 동안(아군 부대 동반 필수) 점령 게이지가 오른다.
    // 적이 거점을 되찾으면 마차는 직전 거점으로 후퇴 — 오버워치 화물 밀기.
    escort: {
      pointsXTile: [28, 48, 68, 88, 106],
      captureSec: 60,
      loseSec: 12,
      radiusTiles: 4.5,
      cartDefId: 'c_supply_cart',
      onCompleteSpawn: { defId: 'hollow', label: '⚔ 슬리피 할로우' },
      onCompleteDialogue: [
        { who: '', text: '다섯 번째 마디에 생명수가 스며든 순간 — 길 끝의 어둠에서, 태엽 감기는 소리가 들려왔다.' },
        { who: '슬리피 할로우', text: '…….' },
        { who: '앨리스', text: '저 걸음걸이… 저 검. 잠깐. 잠깐만.' },
        { who: '앨리스', text: '오빠…? 오웬?! 나야, 알리시아야! 왜 네가 저놈들 편에— 아니, 어떻게 살아서—' },
        { who: '엘로윈', text: '(창백해진다) 오웬. …300년 전, 세계수 앞에서 스러진 초대 숲의 기사다. 시신은 끝내 찾지 못했지. 발타르가… 그를 주워다 문지기로 세웠구나.' },
        { who: '카엘', text: '우리가 넘어야 할 상대가… 아군이었던 사람이라고?' },
        { who: '슬리피 할로우', text: '(태엽 소리가 어긋난다) ……알, 리…' },
        { who: '앨리스', text: '숲지기, 계획 변경이야. 저 애를 부수지 마. — 되찾아 줘.' },
      ],
    },
    // 불타는 숲 장애물 — 길 가장자리에 붙여 세운다. 중앙 통행로는 열어 두되
    // 어깨가 좁아져 진형이 자연스럽게 눌린다 (비행 유닛은 넘어간다)
    obstacles: [
      { defId: 'c_ember_tree2', xTile: 22, yOffTile: -4.5 },
      { defId: 'c_ember_tree', xTile: 24, yOffTile: 4.5 },
      { defId: 'c_burning_log', xTile: 33, yOffTile: -4.2 },
      { defId: 'c_ember_tree', xTile: 41, yOffTile: -2.6 },
      { defId: 'c_ember_tree2', xTile: 44, yOffTile: 2.6 },
      { defId: 'c_burning_log', xTile: 55, yOffTile: -4.5 },
      { defId: 'c_ember_tree2', xTile: 58, yOffTile: 4.3 },
      { defId: 'c_ember_tree', xTile: 64, yOffTile: -4.4 },
      { defId: 'c_burning_log', xTile: 72, yOffTile: 4.4 },
      { defId: 'c_ember_tree2', xTile: 78, yOffTile: -4.5 },
      { defId: 'c_ember_tree', xTile: 82, yOffTile: 4.2 },
      { defId: 'c_burning_log', xTile: 91, yOffTile: -2.7 },
      { defId: 'c_ember_tree', xTile: 93, yOffTile: 2.7 },
      { defId: 'c_ember_tree', xTile: 100, yOffTile: -4.4 },
      { defId: 'c_ember_tree2', xTile: 102, yOffTile: 4.4 },
      // 실바린 캠프 — 천막은 캠프 마당(링 안쪽)에 띄엄띄엄, 서로 붙지 않게.
      // 가장자리는 망루 전용이다.
      // 캠프 1 (28): 살림 많은 본진 캠프 — 천막 3동·모닥불·보급 상자·군기
      { defId: 'c_sylvarin_tent', xTile: 26.4, yOffTile: 3.0 },
      { defId: 'c_sylvarin_tent', xTile: 29.6, yOffTile: 3.4 },
      { defId: 'c_sylvarin_tent2', xTile: 30.6, yOffTile: -2.8 },
      { defId: 'c_camp_fire', xTile: 28.2, yOffTile: 2.0 },
      { defId: 'c_camp_crates', xTile: 27.2, yOffTile: -3.2 },
      { defId: 'c_sylvarin_banner', xTile: 25.4, yOffTile: -2.6 },
      // 캠프 2 (48): 지휘소 — 지휘 천막 + 부속 천막 2동, 군기
      { defId: 'c_sylvarin_tent2', xTile: 49.6, yOffTile: -2.8 },
      { defId: 'c_sylvarin_tent', xTile: 46.8, yOffTile: -3.2 },
      { defId: 'c_sylvarin_tent', xTile: 48.4, yOffTile: 3.0 },
      { defId: 'c_sylvarin_banner', xTile: 46, yOffTile: 2.6 },
      { defId: 'c_camp_fire', xTile: 47.8, yOffTile: -1.6 },
      // 캠프 3 (68): 보급 캠프 — 상자 더미 사이 천막 2동
      { defId: 'c_camp_crates', xTile: 66.2, yOffTile: 2.8 },
      { defId: 'c_camp_crates', xTile: 67.8, yOffTile: 3.3 },
      { defId: 'c_sylvarin_tent', xTile: 69.4, yOffTile: -2.6 },
      { defId: 'c_sylvarin_tent', xTile: 66.4, yOffTile: -3.0 },
      { defId: 'c_camp_fire', xTile: 68, yOffTile: -1.6 },
      // 캠프 4 (88): 전선 캠프 — 지휘 천막 + 천막 2동, 모닥불
      { defId: 'c_sylvarin_tent2', xTile: 86.6, yOffTile: 2.8 },
      { defId: 'c_sylvarin_tent', xTile: 89.2, yOffTile: 3.2 },
      { defId: 'c_sylvarin_tent', xTile: 87.2, yOffTile: -3.0 },
      { defId: 'c_camp_fire', xTile: 88.4, yOffTile: 1.8 },
      { defId: 'c_sylvarin_banner', xTile: 90.2, yOffTile: -2.6 },
      // 캠프 5 (106): 최전방 전초 — 천막 2동, 군기가 먼저 보인다
      { defId: 'c_sylvarin_banner', xTile: 104.6, yOffTile: 2.6 },
      { defId: 'c_sylvarin_tent', xTile: 108.2, yOffTile: 3.0 },
      { defId: 'c_sylvarin_tent', xTile: 105.4, yOffTile: -3.0 },
      { defId: 'c_camp_crates', xTile: 106.6, yOffTile: -3.4 },
      { defId: 'c_camp_fire', xTile: 107.4, yOffTile: -1.8 },
    ],
    spawns: [
      { defId: 'c_bone_colossus', label: '뼈 거상', everySec: 170 },
      // 엘로윈: 아군 진영에서 등장해 부대와 함께 전진. 항상 1명 (쓰러지면 재등장)
      { defId: 'c_elowyn', label: '🧙 세이지 엘로윈 참전!', everySec: 240, concurrentCap: 1, atXTile: 14, friendly: true },
    ],
    briefing: [
      { who: '', text: '세계수의 뿌리는 불탄 국경 숲 — 카엘이 지키던 바로 그 길 밑을 지난다.\n뿌리가 마르면 심장도 마른다. 숲은 이제 도망치지 않는다.' },
      { who: '엘로윈', text: '생명수를 실은 마차다. 뿌리 마디마다 부어 오염을 씻어야 한다 — 다섯 군데, 하나도 거를 수 없다.' },
      { who: '티아', text: '마차가 마디에 서 있는 동안 제가 의식을 올릴게요. 1분이면 돼요. 근처에 부대가 함께 있어야 해요!' },
      { who: '브리아', text: '불타는 숲길에서 마차 호위라. 할증이야. …농담이고, 저 나무들 사이는 좁아. 진형 조심해.' },
      { who: '앨리스', text: '잠깐, 숲지기. …선물이야. 내 태엽 병정이랑 테디 몇, 마차에 실어 뒀어. 상점에서 꺼내 쓰면 돼.' },
      { who: '카엘', text: '웬일로 공짜를…?' },
      { who: '앨리스', text: '공짜 아니야, 투자야. 이 길의 끝에… 확인해 보고 싶은 게 있어.' },
      { who: '엘로윈', text: '적이 마디를 되찾으면 마차는 물러설 수밖에 없다. 서두르지 마라 — 한 마디씩, 확실하게.' },
    ],
    outro: [
      { who: '앨리스', text: '…물러갔어. 부서진 몸을 태엽으로 끌면서. 오빠가— 저게 정말 오빠라면, 300년 동안 저기 있었다는 거잖아.' },
      { who: '앨리스', text: '발타르의 성에 오빠의 머리가 있어. 그게 오빠의 기억이야. 숲지기 — 이게 아까 말한 「내 물건」이야. 찾아와 줘.' },
      { who: '티아', text: '…발밑에서, 심장 뛰는 소리가 들렸어요. 뿌리가 살아났어요.' },
      { who: '사도', text: '(땅에서 일어나며) 뿌리가 기억한다. 아이야, 세계수가 너를 부른다. (숲의 명궁·나무지기 합류!)' },
    ],
  },
  {
    id: 14, act: 3, title: '걸어가는 숲', goal: '협공 돌파 — 후방의 주둔지를 걷어내고 적 넥서스를 파괴하라',
    allowedUnits: U14, enemies: ['pandemonium', 'marionetta'], allies: ['sylvarin'], botDifficulty: 'normal',
    allyNote: '🤝 걸어가는 숲이 뒤를 따른다!',
    mission: 'destroy', seed: seedOf(14),
    warcamp: { everySec: 80, units: ['p_deadman', 'p_deadman', 'p_skeleton', 'p_hound'] },
    spawns: [{ defId: 'c_ash_revenant', label: '재의 원귀', everySec: 150, count: 2 }],
    briefing: [
      { who: '사도', text: '숲은 도망치는 법을 잊었다. 이제 걸어가는 법을 기억해낼 것이다. (사도·고대 트렌트 합류!)' },
    ],
    outro: [
      { who: '티아', text: '나무들이… 행진해요. 태어나서 이런 건 처음 봐요.' },
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
      { who: '실피', text: '…시끄러운 뼈다귀.' },
    ],
    outro: [
      { who: '카엘', text: '(상자를 연다) …투구 속에서, 300년 동안 감지 못한 눈이 우리를 본다.' },
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
      { who: '카엘', text: '숲은 겨울마다 죽어. 그리고 매번 돌아와. 그게 우리와 너의 차이다.' },
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
export function localSave(): { cleared: number; perks: Record<string, number>; boons: Record<string, string>; updatedAt: number } {
  return { cleared: campaignCleared(), perks: perkAlloc(), boons: boonChoices(), updatedAt: Date.now() };
}

/** 클라우드에서 받은 진행 상황을 로컬에 통째로 덮어쓴다 (동기화). */
export function applySave(save: { cleared: number; perks: Record<string, number>; boons: Record<string, string> }): void {
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
}

export const PERKS: readonly PerkDef[] = [
  { id: 'sap', name: '생명의 수액', icon: '🌿', desc: '내 유닛 최대체력 +3%', max: 5 },
  { id: 'thorn', name: '가시 세례', icon: '⚔', desc: '내 유닛 공격력 +2%', max: 5 },
  { id: 'fruit', name: '풍요의 열매', icon: '💰', desc: '시작 자금 +50', max: 4 },
  { id: 'season', name: '계절의 흐름', icon: '⏱', desc: '5초마다 수입 +2', max: 4 },
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
export const BOON_UNLOCKS: Record<number, string> = {
  3: 's_gouto',
  5: 's_elf_archer',
  6: 's_marmot',
  7: 's_vine_hunter',
  8: 's_mushroom_bomber',
  // 숲올빼미 강화는 9 클리어 보상 — 9라운드는 "지상으로 뚫는" 라운드라
  // 올빼미(무리 사냥)를 미리 주면 공중 스팸으로 의도가 무너진다 (실플레이 확인)
  9: 's_owl',
  10: 's_druid',
  11: 's_butterfly',
  12: 's_thorn_witch',
};

const BOON_KEY = 'camp_boons';

/** 유닛별 선택된 강화 (unit defId → boon id). 언제든 다시 고를 수 있다. */
export function boonChoices(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(BOON_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveBoonChoice(unit: string, boonId: string | null): void {
  const all = boonChoices();
  if (boonId === null) delete all[unit];
  else all[unit] = boonId;
  localStorage.setItem(BOON_KEY, JSON.stringify(all));
  onProgressChanged?.();
}

/** 현재 클리어 수 기준으로 개방된 강화 유닛 목록 (개방 순서대로). */
export function unlockedBoonUnits(): string[] {
  const cleared = campaignCleared();
  return Object.entries(BOON_UNLOCKS)
    .filter(([stage]) => Number(stage) <= cleared)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, unit]) => unit);
}

/** 게임에 넘길 유효 강화 id 배열 — 개방된 유닛의 선택만 인정한다. */
export function selectedBoonIds(): string[] {
  const unlocked = new Set(unlockedBoonUnits());
  const all = boonChoices();
  const out: string[] = [];
  for (const [unit, boonId] of Object.entries(all)) {
    if (unlocked.has(unit)) out.push(boonId);
  }
  return out;
}

export function perksToHero(alloc: Record<string, number>): { hpPct: number; dmgPct: number; startMoney: number; incomeAdd: number } {
  return {
    hpPct: (alloc.sap ?? 0) * 3,
    dmgPct: (alloc.thorn ?? 0) * 2,
    startMoney: (alloc.fruit ?? 0) * 50,
    incomeAdd: (alloc.season ?? 0) * 2,
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
      box.classList.toggle('dlg-right', speakerSide(line.who) === 'right');
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
