/**
 * PixiJS 탑뷰 렌더러 + 카메라 + 코드 연출(FX).
 *
 * 프레임 애니메이션 없이 정지 스프라이트를 코드로 움직인다:
 *  - 걷기: 통통 바운스 + 좌우 기울기
 *  - 근접 공격: 대상 방향 돌진 후 복귀
 *  - 원거리 공격: 반동 + 투사체 비행 + 명중 임팩트
 *  - 피격: 붉은 플래시 / 사망: 옆으로 쓰러지며 페이드아웃
 * 전부 시각 연출일 뿐 시뮬 상태는 건드리지 않는다 (결정론 무관).
 */
import {
  Application, Assets, ColorMatrixFilter, Container, Graphics, Rectangle, Sprite, Text, Texture,
} from 'pixi.js';
import {
  DEFS, FP, MAPS, DEFAULT_MAP, laneCenterY, laneHalfWAt, mapHalfH, tiles,
  type Game, type MapDef,
} from '@desertlike/sim';
import { artOf } from './sprites.ts';
import type { Audio, SfxKey } from './audio.ts';

export const TILE = 26;
const Y_SQUASH = 0.86;
const PAD_TOP = 46;
const PAD_BOTTOM = 26;

// 현재 맵 (renderer.setMap 으로 교체)
let curMap: MapDef = MAPS[DEFAULT_MAP]!;

/**
 * 코리도어 바깥 지형을 보여주기 위한 "렌더 전용" 세로 여백 (FP).
 *
 * 평원처럼 레인 반폭이 맵 반높이와 같은 맵은 화면 전체가 레인 안으로 판정돼
 * 경계 타일도 소품도 나오지 않는다. 시뮬 좌표는 건드리지 않고 렌더 캔버스만
 * 위아래로 넓혀서 숲/암반 지대가 실제로 보이게 한다.
 */
const EDGE_MARGIN = tiles(3);

/** 렌더 기준 맵 반높이 (시뮬 반높이 + 바깥 지형 여백). */
function renderHalfH(m: MapDef = curMap): number {
  return mapHalfH(m) + EDGE_MARGIN;
}

/** 시뮬 y 좌표(FP) → 월드 픽셀 y (미니맵 점프용). */
export function worldYOf(yFP: number): number {
  return ((yFP + renderHalfH()) / FP) * TILE * Y_SQUASH + PAD_TOP;
}

/** worldYOf 의 역변환: 월드 픽셀 y → FP y (미니맵 뷰포트 표시용). */
export function worldYToFP(wy: number): number {
  return Math.floor(((wy - PAD_TOP) / (TILE * Y_SQUASH)) * FP) - renderHalfH();
}

/** 월드 픽셀 크기 (줌 적용 전, 현재 맵 기준). */
export function worldW(): number {
  return (curMap.length / FP) * TILE;
}
export function worldH(): number {
  return ((renderHalfH() * 2) / FP) * TILE * Y_SQUASH + PAD_TOP + PAD_BOTTOM;
}

/**
 * 픽셀랩 등 외부 에셋으로 교체된 유닛. 없으면 절차 생성 스프라이트 사용.
 * 배열이면 외형 변형(variant) — 유닛 id 로 결정론적으로 배정된다.
 * (예: 엘프 궁수는 생산 시 여/남 50:50 — docs/races/sylvarin.md)
 */
export const ASSET_UNITS: Record<string, string | string[]> = {
  s_gouto: '/assets/units/s_gouto.png',
  s_elf_archer: ['/assets/units/s_elf_archer_f.png', '/assets/units/s_elf_archer_m.png'],
  s_marmot: '/assets/units/s_marmot.png',
  s_vine_hunter: '/assets/units/s_vine_hunter.png',
  s_mushroom_bomber: '/assets/units/s_mushroom_bomber.png',
  s_druid: '/assets/units/s_druid.png',
  s_treekeeper: '/assets/units/s_treekeeper.png',
  s_thorn_witch: '/assets/units/s_thorn_witch.png',
  s_treant: '/assets/units/s_treant.png',
  s_apostle: '/assets/units/s_apostle.png',
  s_owl: '/assets/units/s_owl.png',
  s_butterfly: '/assets/units/s_butterfly.png',
  s_wyvern: '/assets/units/s_wyvern.png',
  s_unicorn: '/assets/units/s_unicorn.png',
  s_fairy: '/assets/units/s_fairy.png',
  s_marksman: '/assets/units/s_marksman.png',
  s_sage: '/assets/units/s_sage.png',
  m_plushbear: '/assets/units/m_plushbear.png',
  m_clockwork_soldier: '/assets/units/m_clockwork_soldier.png',
  m_button_doll: '/assets/units/m_button_doll.png',
  m_puppet_swordsman: '/assets/units/m_puppet_swordsman.png',
  m_clockwork_spider: '/assets/units/m_clockwork_spider.png',
  m_clown_doll: '/assets/units/m_clown_doll.png',
  m_cursed_doll: '/assets/units/m_cursed_doll.png',
  m_casper: '/assets/units/m_casper.png',
  m_puppet_ann: '/assets/units/m_puppet_ann.png',
  m_specter_teddy: '/assets/units/m_specter_teddy.png',
  m_gore_teddy: '/assets/units/m_gore_teddy.png',
  m_alice: '/assets/units/m_alice.png',
  m_grandfather_clock: '/assets/units/m_grandfather_clock.png',
  m_pennywise: '/assets/units/m_pennywise.png',
  m_thread_needle: '/assets/units/m_thread_needle.png',
  m_clocktower_gear: '/assets/units/m_clocktower_gear.png',
  p_deadman: '/assets/units/p_deadman.png',
  p_skeleton: '/assets/units/p_skeleton.png',
  p_hound: '/assets/units/p_hound.png',
  p_bone_thrower: '/assets/units/p_bone_thrower.png',
  p_headless_knight: '/assets/units/p_headless_knight.png',
  p_corpsecaller: '/assets/units/p_corpsecaller.png',
  p_banshee: '/assets/units/p_banshee.png',
  p_thanatos: '/assets/units/p_thanatos.png',
  p_corpse_golem: '/assets/units/p_corpse_golem.png',
  p_wraith: '/assets/units/p_wraith.png',
  p_mammon: '/assets/units/p_mammon.png',
  p_summoner: '/assets/units/p_summoner.png',
  p_lich: '/assets/units/p_lich.png',
  p_demilich: '/assets/units/p_demilich.png',
  p_minion_ghoul: '/assets/units/p_minion_ghoul.png',
  p_minion_undead: '/assets/units/p_minion_undead.png',
  p_minion_skeleton: '/assets/units/p_minion_skeleton.png',
  p_minion_rat: '/assets/units/p_minion_rat.png',
  // 캠페인 전용 특수 유닛 — 기존 에셋 재활용 (크기 배율로 위압감)
  c_ash_revenant: '/assets/units/p_wraith.png',
  c_mad_ballerina: '/assets/units/m_puppet_ann.png',
  c_bone_colossus: '/assets/units/p_corpse_golem.png',
  c_dread_gargoyle: '/assets/units/p_demilich.png',
  c_kurga: '/assets/units/p_lich.png',
  c_mammon_lord: '/assets/units/p_mammon.png',
  c_balthar: '/assets/units/p_demilich.png',
  // 구조물·수호자 (종족 무관)
  nexus: '/assets/units/nexus.png',
  tower: '/assets/units/tower.png',
  dragon: '/assets/units/dragon.png',
  hollow: '/assets/units/hollow.png',
  teddy_guardian: '/assets/units/teddy_guardian.png',
  // 장난감 나라(toybox) 전용 건물 스킨 — 스프라이트 생성 시 맵으로 갈린다
  tower_toy: '/assets/units/tower_toy.png',
  nexus_toy: '/assets/units/nexus_toy.png',
  // 사령(판데모니엄) 건물 스킨 — 캠페인 enemySkin: 'bone'
  tower_bone: '/assets/units/tower_bone.png',
  nexus_bone: '/assets/units/nexus_bone.png',
  // 마몬의 상점 (캠페인 점령 오브젝트 — 전투 개입 없음, 그림+점령 표시만)
  mercshop: '/assets/units/mercshop.png',
  // 호위전(13) 소품 — 보급 마차 + 불타는 숲 장애물
  c_supply_cart: '/assets/units/c_supply_cart.png',
  // 앨리스의 지원 병력 (13) — 원본 마리오네타 유닛 그림을 그대로 쓴다
  c_alice_soldier: '/assets/units/m_clockwork_soldier.png',
  c_alice_teddy: '/assets/units/m_gore_teddy.png',
  c_elowyn: '/assets/units/s_sage.png',
  c_sage_watchtower: '/assets/units/c_sage_watchtower.png',
  c_sylvarin_tent: '/assets/units/c_sylvarin_tent.png',
  c_sylvarin_tent2: '/assets/units/c_sylvarin_tent2.png',
  c_camp_fire: '/assets/units/c_camp_fire.png',
  c_camp_crates: '/assets/units/c_camp_crates.png',
  c_sylvarin_banner: '/assets/units/c_sylvarin_banner.png',
  c_burning_tree: '/assets/units/c_burning_tree.png',
  c_ember_tree: '/assets/units/c_ember_tree.png',
  c_ember_tree2: '/assets/units/c_ember_tree2.png',
  c_burning_log: '/assets/units/c_burning_log.png',
  // 둥지 (11스테이지) — nest 맵의 아군 넥서스 스킨
  nexus_nest: '/assets/units/nexus_nest.png',
  // 12스테이지 보스 — 발타르의 선봉장
  c_balthar_general: '/assets/units/c_balthar_general.png',
  // 마몬의 용병 — 원본 판데모니엄 그림 재사용 (스펙만 독립)
  merc_headless_knight: '/assets/units/p_headless_knight.png',
  merc_lich: '/assets/units/p_lich.png',
  merc_thanatos: '/assets/units/p_thanatos.png',
  // 둥지 수호탑 (11스테이지) — 원본 공중 유닛 그림 재사용
  c_nest_wyvern: '/assets/units/s_wyvern.png',
  c_nest_unicorn: '/assets/units/s_unicorn.png',
  c_nest_fairy: '/assets/units/s_fairy.png',
  // 야생 무리 (11스테이지)
  c_wild_wolf_gray: '/assets/units/c_wild_wolf_gray.png',
  c_wild_snake: '/assets/units/c_wild_snake.png',
  c_wild_wolf_black: '/assets/units/c_wild_wolf_black.png',
  c_wild_tarantula: '/assets/units/c_wild_tarantula.png',
  c_wild_kestrel: '/assets/units/c_wild_kestrel.png',
  c_wild_bear_gray: '/assets/units/c_wild_bear_gray.png',
  c_wild_direwolf: '/assets/units/c_wild_direwolf.png',
  c_wild_grizzly: '/assets/units/c_wild_grizzly.png',
  c_wild_blackbird: '/assets/units/c_wild_blackbird.png',
};

/** 상점 아이콘용 정면(south) 스프라이트. 전장은 측면, 아이콘은 정면. */
const ASSET_ICONS: Record<string, string> = {
  s_gouto: '/assets/units/s_gouto_icon.png',
  s_elf_archer: '/assets/units/s_elf_archer_icon.png',
  s_marmot: '/assets/units/s_marmot_icon.png',
  s_vine_hunter: '/assets/units/s_vine_hunter_icon.png',
  s_mushroom_bomber: '/assets/units/s_mushroom_bomber_icon.png',
  s_druid: '/assets/units/s_druid_icon.png',
  s_treekeeper: '/assets/units/s_treekeeper_icon.png',
  s_thorn_witch: '/assets/units/s_thorn_witch_icon.png',
  s_treant: '/assets/units/s_treant_icon.png',
  s_apostle: '/assets/units/s_apostle_icon.png',
  s_owl: '/assets/units/s_owl_icon.png',
  s_butterfly: '/assets/units/s_butterfly_icon.png',
  s_wyvern: '/assets/units/s_wyvern_icon.png',
  s_unicorn: '/assets/units/s_unicorn_icon.png',
  s_fairy: '/assets/units/s_fairy_icon.png',
  s_marksman: '/assets/units/s_marksman_icon.png',
  s_sage: '/assets/units/s_sage_icon.png',
  m_plushbear: '/assets/units/m_plushbear_icon.png',
  m_clockwork_soldier: '/assets/units/m_clockwork_soldier_icon.png',
  c_alice_soldier: '/assets/units/m_clockwork_soldier_icon.png',
  c_alice_teddy: '/assets/units/m_gore_teddy_icon.png',
  m_button_doll: '/assets/units/m_button_doll_icon.png',
  m_puppet_swordsman: '/assets/units/m_puppet_swordsman_icon.png',
  m_clockwork_spider: '/assets/units/m_clockwork_spider_icon.png',
  m_clown_doll: '/assets/units/m_clown_doll_icon.png',
  m_cursed_doll: '/assets/units/m_cursed_doll_icon.png',
  m_casper: '/assets/units/m_casper_icon.png',
  m_puppet_ann: '/assets/units/m_puppet_ann_icon.png',
  m_specter_teddy: '/assets/units/m_specter_teddy_icon.png',
  m_gore_teddy: '/assets/units/m_gore_teddy_icon.png',
  m_alice: '/assets/units/m_alice_icon.png',
  m_grandfather_clock: '/assets/units/m_grandfather_clock_icon.png',
  m_pennywise: '/assets/units/m_pennywise_icon.png',
  m_thread_needle: '/assets/units/m_thread_needle_icon.png',
  m_clocktower_gear: '/assets/units/m_clocktower_gear_icon.png',
  p_deadman: '/assets/units/p_deadman_icon.png',
  p_skeleton: '/assets/units/p_skeleton_icon.png',
  p_hound: '/assets/units/p_hound_icon.png',
  p_bone_thrower: '/assets/units/p_bone_thrower_icon.png',
  p_headless_knight: '/assets/units/p_headless_knight_icon.png',
  merc_headless_knight: '/assets/units/p_headless_knight_icon.png',
  merc_lich: '/assets/units/p_lich_icon.png',
  merc_thanatos: '/assets/units/p_thanatos_icon.png',
  p_corpsecaller: '/assets/units/p_corpsecaller_icon.png',
  p_banshee: '/assets/units/p_banshee_icon.png',
  p_thanatos: '/assets/units/p_thanatos_icon.png',
  p_corpse_golem: '/assets/units/p_corpse_golem_icon.png',
  p_wraith: '/assets/units/p_wraith_icon.png',
  p_mammon: '/assets/units/p_mammon_icon.png',
  p_summoner: '/assets/units/p_summoner_icon.png',
  p_lich: '/assets/units/p_lich_icon.png',
  p_demilich: '/assets/units/p_demilich_icon.png',
};

/** 상점 아이콘 등에 쓸 대표 에셋 URL. 정면 아이콘 > 전장 스프라이트 순. */
export function assetIconUrl(defId: string): string | undefined {
  const icon = ASSET_ICONS[defId];
  if (icon) return icon;
  const v = ASSET_UNITS[defId];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 공격 중 잠시 교체되는 "공격 자세" 스프라이트 (원거리 조준 등).
 * 변형 배열은 ASSET_UNITS 와 같은 순서로 대응해야 한다.
 */
/** 공격 애니메이션: [변형][프레임] URL. 공격 순간 프레임을 순차 재생한다. */
const atk4 = (id: string): string[][] => [[0, 1, 2, 3].map((n) => `/assets/units/${id}_atk${n}.png`)];

/**
 * 이동 방향별 그림을 보유한 유닛. `<defId>_e/_w/_n/_s.png` 4장이 모두 있어야
 * 등록된다 (하나라도 빠지면 기존 좌우 반전 방식 유지).
 * 엘프 궁수는 여/남 변형이라 제외 — 변형과 방향을 함께 다루려면 별도 작업 필요.
 */
const DIR_SPRITE_UNITS: string[] = [
  's_gouto', 's_vine_hunter', 's_marmot', 's_druid', 's_mushroom_bomber',
  's_owl', 's_butterfly', 's_thorn_witch', 's_treekeeper', 's_apostle',
  's_treant', 's_marksman', 's_sage', 's_wyvern', 's_unicorn', 's_fairy',
  'p_deadman', 'p_skeleton', 'p_hound', 'p_bone_thrower', 'p_headless_knight',
  'p_corpsecaller', 'p_banshee', 'p_thanatos', 'p_corpse_golem', 'p_wraith',
  'p_summoner', 'p_lich', 'p_demilich', 'p_mammon',
  'p_minion_ghoul', 'p_minion_undead', 'p_minion_skeleton', 'p_minion_rat',
  'm_plushbear', 'm_clockwork_soldier', 'm_button_doll', 'm_puppet_swordsman',
  'm_clockwork_spider', 'm_clown_doll', 'm_cursed_doll', 'm_casper',
  'm_puppet_ann', 'm_specter_teddy', 'm_grandfather_clock', 'm_pennywise',
  'm_thread_needle', 'm_clocktower_gear', 'm_gore_teddy', 'm_alice',
  'dragon', 'hollow', 'teddy_guardian',
  'c_wild_wolf_gray', 'c_wild_wolf_black', 'c_wild_direwolf', 'c_wild_bear_gray',
  'c_wild_grizzly', 'c_wild_snake', 'c_wild_tarantula', 'c_wild_kestrel', 'c_wild_blackbird',
  'c_balthar_general',
  // 엘프 궁수는 여/남 변형별 세트 — 렌더에서 변형 인덱스로 키를 고른다
  's_elf_archer_f', 's_elf_archer_m',
];

/** 공중 타겟 전용 공격 프레임 — 등록된 유닛은 지상/공중 모션이 갈린다. */
const ASSET_ATTACK_ANIMS_AIR: Record<string, string[][]> = {
  // 곰인형 수호자: 공중엔 양팔 치켜들어 내리찍기, 지상엔 포효하며 땅찍기
  teddy_guardian: [[0, 1, 2, 3].map((n) => `/assets/units/teddy_guardian_air${n}.png`)],
};

const ASSET_ATTACK_ANIMS: Record<string, string[][]> = {
  // 엘프 궁수: 변형(여/남)별 4프레임 발사 모션 (화살 뽑기→시위 당기기→발사)
  s_elf_archer: [
    [0, 1, 2, 3].map((n) => `/assets/units/s_elf_archer_f_atk${n}.png`),
    [0, 1, 2, 3].map((n) => `/assets/units/s_elf_archer_m_atk${n}.png`),
  ],
  s_gouto: atk4('s_gouto'),
  m_plushbear: atk4('m_plushbear'),
  m_clockwork_spider: atk4('m_clockwork_spider'),
  m_clown_doll: atk4('m_clown_doll'),
  m_casper: atk4('m_casper'),
  m_specter_teddy: atk4('m_specter_teddy'),
  m_puppet_ann: atk4('m_puppet_ann'),
  s_marmot: atk4('s_marmot'),
  s_vine_hunter: atk4('s_vine_hunter'),
  s_mushroom_bomber: atk4('s_mushroom_bomber'),
  s_druid: atk4('s_druid'),
  s_treekeeper: atk4('s_treekeeper'),
  s_thorn_witch: atk4('s_thorn_witch'),
  s_treant: atk4('s_treant'),
  s_apostle: atk4('s_apostle'),
  s_owl: atk4('s_owl'),
  s_butterfly: atk4('s_butterfly'),
  s_wyvern: atk4('s_wyvern'),
  s_unicorn: atk4('s_unicorn'),
  s_fairy: atk4('s_fairy'),
  s_marksman: atk4('s_marksman'),
  s_sage: atk4('s_sage'),
  m_clockwork_soldier: atk4('m_clockwork_soldier'),
  c_alice_soldier: atk4('m_clockwork_soldier'),
  c_alice_teddy: atk4('m_gore_teddy'),
  m_puppet_swordsman: atk4('m_puppet_swordsman'),
  m_cursed_doll: atk4('m_cursed_doll'),
  m_button_doll: atk4('m_button_doll'),
  m_alice: atk4('m_alice'),
  m_grandfather_clock: atk4('m_grandfather_clock'),
  m_pennywise: atk4('m_pennywise'),
  m_thread_needle: atk4('m_thread_needle'),
  m_clocktower_gear: atk4('m_clocktower_gear'),
  m_gore_teddy: atk4('m_gore_teddy'),
  p_deadman: atk4('p_deadman'),
  p_skeleton: atk4('p_skeleton'),
  p_hound: atk4('p_hound'),
  p_bone_thrower: atk4('p_bone_thrower'),
  p_headless_knight: atk4('p_headless_knight'),
  merc_headless_knight: atk4('p_headless_knight'),
  merc_lich: atk4('p_lich'),
  merc_thanatos: atk4('p_thanatos'),
  p_corpsecaller: atk4('p_corpsecaller'),
  p_banshee: atk4('p_banshee'),
  p_thanatos: atk4('p_thanatos'),
  p_corpse_golem: atk4('p_corpse_golem'),
  p_wraith: atk4('p_wraith'),
  p_mammon: atk4('p_mammon'),
  p_summoner: atk4('p_summoner'),
  p_lich: atk4('p_lich'),
  p_demilich: atk4('p_demilich'),
  p_minion_ghoul: atk4('p_minion_ghoul'),
  p_minion_undead: atk4('p_minion_undead'),
  p_minion_skeleton: atk4('p_minion_skeleton'),
  p_minion_rat: atk4('p_minion_rat'),
  // 수호자 (중간보스)
  dragon: atk4('dragon'),
  hollow: atk4('hollow'),
  teddy_guardian: atk4('teddy_guardian'),
  // 캠페인 특수 유닛 — 원본 유닛 모션 재활용
  c_ash_revenant: atk4('p_wraith'),
  c_mad_ballerina: atk4('m_puppet_ann'),
  c_bone_colossus: atk4('p_corpse_golem'),
  c_dread_gargoyle: atk4('p_demilich'),
  c_kurga: atk4('p_lich'),
  c_mammon_lord: atk4('p_mammon'),
  c_balthar: atk4('p_demilich'),
};

/**
 * 원거리 공격의 투사체 그림. 유닛별로 어떤 탄이 날아가는지 지정한다.
 * 여기 없는 유닛은 기존처럼 종족색 선분으로 폴백한다.
 */
type ProjKind = 'arrow' | 'bullet' | 'bone' | 'bolt_nature' | 'bolt_curse' | 'bomb' | 'pollen' | 'fireball';

const PROJECTILE_OF: Record<string, ProjKind> = {
  // 실바린
  s_elf_archer: 'arrow',
  s_owl: 'arrow',
  s_mushroom_bomber: 'bomb',
  s_druid: 'bolt_nature',
  s_thorn_witch: 'bolt_nature',
  s_apostle: 'bolt_nature',
  s_butterfly: 'pollen',
  s_unicorn: 'bolt_nature',
  s_fairy: 'bolt_nature',
  s_marksman: 'arrow',
  s_sage: 'bolt_nature',
  // 판데모니엄
  p_bone_thrower: 'bone',
  p_corpsecaller: 'bolt_curse',
  p_banshee: 'bolt_curse',
  p_lich: 'fireball',
  c_kurga: 'fireball',
  c_balthar: 'bolt_curse',
  c_dread_gargoyle: 'bolt_curse',
  p_demilich: 'bolt_curse',
  // 마리오네타
  m_clockwork_soldier: 'bullet',
  m_casper: 'bolt_curse',
  m_puppet_ann: 'bolt_curse',
  m_specter_teddy: 'pollen',
  m_alice: 'bolt_curse',
  m_grandfather_clock: 'bomb',
  m_thread_needle: 'arrow',
  m_clocktower_gear: 'bullet',
  m_pennywise: 'bolt_curse',
  // 구조물·수호자
  tower: 'bullet',
  nexus: 'bullet',
  dragon: 'fireball',
  hollow: 'bolt_curse',
};

/**
 * 탄종별 표시 설정.
 *  size   — 화면 px
 *  rotate — 날아가는 방향으로 돌릴지 (구형 탄은 false)
 *  spin   — 회전하지 않는 탄이 스스로 도는 속도 (rad/ms)
 *  aim    — 그림이 이미 향하고 있는 각도(rad). 생성된 그림이 오른쪽이 아니라
 *           대각선을 보고 있어서, 그만큼 빼줘야 진행 방향과 맞는다.
 */
const D45 = -Math.PI / 4; // 우상향 대각선으로 그려진 탄들
const PROJECTILE_STYLE: Record<ProjKind, { size: number; rotate: boolean; spin?: number; aim?: number }> = {
  arrow: { size: 18, rotate: true, aim: D45 },
  bullet: { size: 13, rotate: true, aim: -Math.PI / 2 }, // 총알 그림은 위를 향해 그려졌다
  bone: { size: 15, rotate: false, spin: 0.02 }, // 던진 뼈는 빙글빙글
  bolt_nature: { size: 16, rotate: true, aim: D45 },
  bolt_curse: { size: 16, rotate: true, aim: D45 },
  bomb: { size: 17, rotate: false, spin: 0.008 },
  pollen: { size: 16, rotate: false },
  fireball: { size: 20, rotate: true },
};

/**
 * 구조물 팀 색. 넥서스·수호탑은 양 팀이 같은 그림이라 편이 구분되지 않았다.
 * 2팀은 붉게 물들여 한눈에 갈리도록 한다 (팀 컬러와 동일 계열).
 */
const STRUCTURE_TEAM_TINT: readonly [number, number] = [0xbcd4ff, 0xff8a72];

/** 스프라이트 폭 배율 오버라이드 (기본 공식: 충돌반경×2×2.2타일). */
const ASSET_SIZE_MUL: Record<string, number> = {
  nexus: 0.85,  // 세로로 긴 건물이라 폭 축소
  tower: 0.8,
  // 캠페인 특수 유닛: 원본보다 크게 — 한눈에 "특별한 놈"으로 읽히게
  c_ash_revenant: 1.5,
  c_mad_ballerina: 1.4,
  c_bone_colossus: 1.9,
  c_dread_gargoyle: 1.5,
  c_kurga: 1.7,
  c_mammon_lord: 1.6,
  c_balthar: 2.1,
  teddy_guardian: 1.25, // 수호자 위용 — radius 보정 위에 한 번 더
  c_nest_wyvern: 1.3, c_nest_unicorn: 1.3, c_nest_fairy: 1.3, // 둥지 수호탑 — 타워 위용
  c_wild_blackbird: 1.4, c_wild_grizzly: 1.2, c_wild_direwolf: 1.15,
  c_balthar_general: 1.5, // 12 보스 — 슬리피 할로우급 거구
  // 호위전 소품: 나무는 반경보다 훨씬 크게 — 숲이 우거진 인상
  c_burning_tree: 1.35, c_ember_tree: 1.3, c_ember_tree2: 1.35, c_burning_log: 0.95, c_supply_cart: 1.15,
  s_fairy: 1.9, // 거대 나비(radius 0.42)보다 커 보이게 — 요정 여왕의 위용

  c_sage_watchtower: 1.5, c_sylvarin_tent: 1.2, c_elowyn: 1.25,
  c_sylvarin_tent2: 1.25, c_camp_fire: 1.1, c_camp_crates: 1.1, c_sylvarin_banner: 1.6,
};

/**
 * 지형 테마 (픽셀랩 Wang 타일셋 32px 16타일 + 바깥 지대 소품).
 *
 * wang: 코너 인덱스 = NW*8 + NE*4 + SW*2 + SE → 시트 내 좌표.
 *       1 = upper = 걷는 길(레인), 0 = lower = 바깥 지형(진입 불가).
 *       좌표는 타일셋 메타데이터의 bounding_box 에서 추출한 값이라 시트마다 다르다.
 */
const TILE_PX = 32;

/** 16타일 시트의 표준 배치. 현재 생성한 세 시트 모두 이 배치를 쓴다. */
const WANG_16: Record<number, readonly [number, number]> = {
  0: [64, 32], 1: [96, 32], 2: [64, 64], 3: [32, 64],
  4: [64, 0], 5: [96, 64], 6: [0, 32], 7: [96, 96],
  8: [32, 32], 9: [64, 96], 10: [32, 0], 11: [0, 64],
  12: [96, 0], 13: [0, 0], 14: [32, 96], 15: [0, 96],
};

interface GroundTheme {
  readonly sheet: string;
  /** 배치가 다른 시트를 쓰게 되면 여기서 덮어쓴다. */
  readonly wang: Record<number, readonly [number, number]>;
  /** 레인 밖에 흩뿌릴 소품 파일명 (assets/tiles/<name>.png). */
  readonly props: readonly string[];
  /** 레인 안(걷는 길)에 낮은 밀도로 깔 납작한 지면 장식. */
  readonly laneProps?: readonly string[];
  /**
   * 길 안쪽(완전히 걷는 길인 칸, wang idx 15)의 변형 타일 파일명들.
   * 시트의 기본 타일과 해시로 섞여 "여러 타입의 바닥"을 만든다.
   */
  readonly fullVariants?: readonly string[];
  /**
   * 지면 타일에 탈색·감광 필터를 씌운다 (불탄 지형).
   * 같은 숲 시트를 재활용하므로 초록 구역과 형태가 이어져 경계가 자연스럽다.
   * 소품은 필터를 타지 않아 잔불이 그대로 빛난다.
   */
  readonly scorched?: boolean;
  /** 대형 랜드마크 소품 (선택). */
  landmark?: string;
  /**
   * 바깥 지형(idx 0) 변형 무늬 — 64px 는 2×2 블록으로 깔린다.
   * 기본 타일과 해시로 섞여 반복 잔무늬의 피로를 줄인다.
   */
  outerVariants?: string[];
}

const THEMES: Record<string, GroundTheme> = {
  forest: {
    sheet: '/assets/tiles/forest.png',
    wang: WANG_16,
    props: ['forest_tree', 'forest_bush', 'forest_grass'],
    // 길 위 장식 (투명 배경 소품) — 이동엔 영향 없는 순수 그림.
    // 풀·꽃은 자주, 묘목은 드물게 (가중치 = 배열 중복 등장 횟수)
    laneProps: ['lane_grass', 'lane_grass', 'lane_flowers', 'lane_leaves', 'lane_leaves', 'lane_sapling'],
  },
  burnt: {
    sheet: '/assets/tiles/forest.png',
    wang: WANG_16,
    scorched: true,
    props: ['burnt_tree', 'burnt_stump'],
    laneProps: ['lane_embers', 'lane_charred', 'lane_charred'],
  },
  desert: {
    sheet: '/assets/tiles/desert.png',
    wang: WANG_16,
    props: [
      'prop_cactus', 'prop_cactus2', 'prop_cactus3', 'prop_cactus4',
      'prop_skull', 'prop_skull2', 'prop_bones1', 'prop_bones2',
      'prop_tree', 'prop_tree2', 'prop_tree3', 'prop_tree4',
    ],
    laneProps: ['lane_gravel', 'lane_gravel', 'lane_dryweed'],
    /** 대형 랜드마크 — 맵당 몇 곳에만 큼지막하게 자리 잡는다. */
    landmark: 'prop_giant_ribcage',
    outerVariants: ['desert_out1', 'desert_out2', 'desert_out3'],
  },
  // 고산 지대 (캠페인 11 — 바람의 둥지): 안개 낀 설산 바위 사이 판석 길
  alpine: {
    sheet: '/assets/tiles/alpine.png',
    wang: WANG_16,
    props: ['prop_pine_snow', 'prop_alpine_rock', 'prop_alpine_rock'],
    laneProps: ['lane_alpinegrass', 'lane_pebbles', 'lane_alpinegrass'],
  },
  // 저주받은 땅 (캠페인 12 — 발타르군 요새 앞): 검은 현무암 길 + 소울파이어 균열
  necro: {
    sheet: '/assets/tiles/necro.png',
    wang: WANG_16,
    props: ['prop_necro_candles', 'prop_necro_pillar', 'prop_skull2', 'prop_bones1'],
    laneProps: ['lane_ash', 'lane_ash', 'lane_charred'],
  },
  // 장난감 나라 (캠페인 2막 — 마리오네타 왕국)
  toy: {
    sheet: '/assets/tiles/toy.png',
    wang: WANG_16,
    props: ['prop_teddy', 'prop_rockinghorse', 'prop_blocks'],
    laneProps: ['lane_crayon', 'lane_marbles', 'lane_marbles'],
    fullVariants: ['toy_full_puzzle2', 'toy_full_puzzle3'],
  },
};

/**
 * 맵별 지형 테마. 2개면 왼쪽(1팀)→오른쪽(2팀)으로 갈리며 경계는 들쭉날쭉하다.
 * 평원: 생생한 숲 → 슬리피 할로우가 태운 불탄 숲.
 */
const MAP_THEMES: Record<string, readonly string[]> = {
  plains: ['forest', 'burnt'],
  valley: ['desert'],
  greedvalley: ['desert'],
  nest: ['alpine'],
  confluence: ['necro'],
  toybox: ['toy'],
  ashroad: ['burnt'], // 불탄 숲길 — 평원의 「탄 쪽」 지형을 전체에 깐다
};

/** 맵 바깥(캔버스 여백) 색. 지형과 이어지는 톤으로. */
const MAP_BG: Record<string, number> = {
  confluence: 0x131a14, // 소울파이어가 스민 칠흑
  nest: 0x2b3240, // 고산의 푸른 안개
  greedvalley: 0x2a2013, // 금빛이 스민 협곡 그늘
  plains: 0x1d2a19, // 깊은 숲 그늘
  valley: 0x9c7c4e,
  toybox: 0x3a2438, // 장난감 방의 어둑한 자주빛
  ashroad: 0x1f120c, // 잿불이 스민 검붉은 어둠
};

/** 액티브 스킬 시전 모션 프레임 (없는 유닛은 공격 모션 재활용). */
const skill4 = (id: string): string[] => [0, 1, 2, 3].map((n) => `/assets/units/${id}_skill${n}.png`);

const ASSET_SKILL_ANIMS: Record<string, string[]> = {
  m_clockwork_soldier: skill4('m_clockwork_soldier'), // 태엽 감기
  s_treekeeper: skill4('s_treekeeper'),               // 뿌리박기
};

/**
 * 비행 유닛의 부유 모션 프레임. 2장 이상이면 순환 재생(진짜 프레임 애니메이션),
 * 1장이면 기본 포즈와 교대. 없는 비행 유닛은 스쿼시 착시로 폴백.
 */
const fly4 = (id: string): string[] => [0, 1, 2, 3].map((n) => `/assets/units/${id}_fly${n}.png`);

const ASSET_FLAP_FRAMES: Record<string, string[]> = {
  s_owl: fly4('s_owl'),
  s_butterfly: fly4('s_butterfly'),
  // 앤: 실에 매달려 팔다리가 흔들리는 4프레임
  m_puppet_ann: fly4('m_puppet_ann'),
  // 수호자: 드래곤 날갯짓, 할로우 유령마 부유 질주
  dragon: fly4('dragon'),
  hollow: fly4('hollow'),
  p_demilich: fly4('p_demilich'),
  c_dread_gargoyle: fly4('p_demilich'),
  c_balthar: fly4('p_demilich'),
  m_casper: fly4('m_casper'),
  m_pennywise: fly4('m_pennywise'),
  m_thread_needle: fly4('m_thread_needle'),
  s_wyvern: fly4('s_wyvern'),
  s_unicorn: fly4('s_unicorn'),
  s_fairy: fly4('s_fairy'),
};

/**
 * 업그레이드 보유 시 교체되는 외형 스킨 (다음 웨이브 스폰부터 적용).
 * 스킨 사용 중에는 공격/부유 프레임 애니메이션은 생략된다 (코드 연출만).
 */
const ASSET_UPGRADE_SKINS: Record<string, { upgrade: string; url: string; scaleMul: number; atk?: string[] }> = {
  // 검은 군마: 목없는 기사가 흑마를 타고 다닌다 (기마 전용 공격 프레임 포함)
  p_headless_knight: {
    upgrade: 'pu_knight_horse',
    url: '/assets/units/p_headless_knight_horse.png',
    scaleMul: 1.35,
    atk: [0, 1, 2, 3].map((n) => `/assets/units/p_headless_knight_horse_atk${n}.png`),
  },
};

function sx(x: number): number {
  return (x / FP) * TILE;
}
function sy(y: number): number {
  return ((y + renderHalfH()) / FP) * TILE * Y_SQUASH + PAD_TOP;
}

const RANGED_THRESHOLD = tiles(2);

interface UnitFx {
  lastCooldown: number;
  lastHealCd: number;
  lastSkillCd: number;
  /** 스킬별 직전 쿨 — 어느 스킬이 방금 발동했는지 판별용. */
  lastSkillCds: number[];
  lastHp: number;
  /** ms 타임스탬프. 0 = 비활성. */
  flashUntil: number;
  lungeStart: number;
  lungeDx: number;
  lungeDy: number;
  recoilStart: number;
  recoilDx: number;
  /** 공격 애니메이션 재생 구간 [aimStart, aimUntil). */
  aimStart: number;
  aimUntil: number;
  /** 직전 공격의 타겟이 공중 유닛이었나 — 공중 전용 모션 분기. */
  atkAir: boolean;
  /** 바라보는 방향 (이동 벡터 기반, 방향 그림 보유 유닛용). */
  faceDir: 'e' | 'w' | 'n' | 's';
  /** 내리꽂기(지상 전용 strike) 연출 구간 — 솟구쳤다 내리찍는다. 0 = 비활성. */
  diveStart: number;
  diveUntil: number;
  /** 스킬 시전 애니메이션 재생 구간 (전용 프레임 보유 유닛만). */
  skillStart: number;
  skillUntil: number;
  /** 회복 이펙트 표시 종료 시각 (ms). */
  healGlowUntil: number;
  walkPhase: number;
  moving: boolean;
  /** 생성 시점의 기본 스케일 (팀 반전 포함). 날갯짓 스쿼시의 기준값. */
  baseScaleX: number;
  baseScaleY: number;
  /** 업그레이드 스킨 사용 중 — 프레임 애니메이션 텍스처 교체를 생략한다. */
  hasSkin: boolean;
}

interface Projectile {
  x0: number; y0: number; x1: number; y1: number;
  start: number; dur: number;
  color: number;
  splash: number; // 화면 px, 0 = 단일
  /** 탄 그림 종류. 없으면 색 선분으로 그린다. */
  kind?: ProjKind;
  /** 회전 탄(뼈·폭탄)의 시작 각도 — 탄마다 달라야 돌아가는 게 자연스럽다. */
  spin0: number;
}

interface Impact {
  x: number; y: number; start: number; radius: number; color: number;
}

interface Corpse {
  sp: Sprite;
  start: number;
}

export interface Renderer {
  app: Application;
  /** 게임 시작 시 맵 교체 — 지형을 다시 그리고 카메라를 리셋한다. */
  setMap(m: MapDef): void;
  /** 적(팀1) 건물 스킨 설정 (캠페인). null = 기본/맵 자동. */
  setEnemySkin(skin: 'toy' | 'bone' | null): void;
  /**
   * 호위전 거점 표시 (캠페인 13). 매 프레임 상태를 넘겨 받아 링·깃발을 그린다.
   * null = 표시 끔.
   */
  setEscort(cfg: {
    pointsX: readonly number[]; // FP
    radius: number; // FP
    frontier: number;
    progress01: number;
    contested: boolean;
  } | null): void;
  /** 시뮬 스텝 직전에 호출 — 보간용 이전 위치 스냅샷. */
  beforeStep(g: Game): void;
  draw(g: Game, alpha: number): void;
  panBy(dxScreenPx: number, dyScreenPx?: number): void;
  centerOn(xWorldPx: number, yWorldPx?: number): void;
  zoomBy(factor: number, anchorX?: number, anchorY?: number): void;
  view(): { x0: number; x1: number; y0: number; y1: number };
  /** 화면 좌표에서 가장 가까운 유닛 id (없으면 null). 클릭 선택용. */
  pick(g: Game, screenX: number, screenY: number): number | null;
  /** 선택 표시 링을 그릴 유닛 id (null = 해제). */
  setSelected(id: number | null): void;
  /** 효과음 재생기 연결 (없으면 무음으로 동작). */
  setAudio(a: Audio): void;
}

export async function createRenderer(mount: HTMLElement): Promise<Renderer> {
  const app = new Application();
  await app.init({
    resizeTo: mount,
    // 맵 바깥 여백색. setMap 에서 맵 테마에 맞춰 바꾼다.
    backgroundColor: MAP_BG[DEFAULT_MAP] ?? 0x9c7c4e,
    antialias: false,
    roundPixels: true,
  });
  app.canvas.id = 'gamecanvas'; // CSS 가 미니맵 캔버스와 구분해서 잡도록
  mount.appendChild(app.canvas);

  // 모바일 화면 회전: 버퍼를 즉시 새 크기로 — 안 하면 세로 버퍼가 가로 CSS 로
  // 늘어나 전장이 찌그러져 보인다. 회전 직후엔 크기가 늦게 잡히는 브라우저가
  // 있어 한 박자 뒤 한 번 더 맞춘다.
  const onViewportChange = (): void => {
    app.resize();
    setTimeout(() => app.resize(), 280);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  // 외부 에셋 로드 (실패하면 절차 생성으로 폴백)
  const assetTex = new Map<string, Texture[]>();
  await Promise.all(
    Object.entries(ASSET_UNITS).map(async ([defId, urls]) => {
      const list = Array.isArray(urls) ? urls : [urls];
      const texs: Texture[] = [];
      for (const url of list) {
        try {
          const tex: Texture = await Assets.load(url);
          tex.source.scaleMode = 'nearest';
          texs.push(tex);
        } catch {
          // 이 변형만 폴백 — 나머지 변형은 계속 로드
        }
      }
      if (texs.length > 0) assetTex.set(defId, texs);
    }),
  );
  async function loadTex(url: string): Promise<Texture | null> {
    try {
      const tex: Texture = await Assets.load(url);
      tex.source.scaleMode = 'nearest';
      return tex;
    } catch {
      return null;
    }
  }

  // 공격 애니메이션 텍스처: [변형][프레임] (없으면 교체 없이 기본 자세 유지)
  const attackTex = new Map<string, Texture[][]>();
  const airAttackTex = new Map<string, Texture[][]>();
  /**
   * 이동 방향별 스프라이트 (있는 유닛만): east 는 기존 기본 그림, 나머지는
   * `<defId>_w/_n/_s.png`. 등록된 유닛은 좌우 반전 대신 실제 방향 그림을 쓴다.
   */
  const dirTex = new Map<string, { e?: Texture; w?: Texture; n?: Texture; s?: Texture }>();
  await Promise.all(
    Object.entries(ASSET_ATTACK_ANIMS).map(async ([defId, variants]) => {
      const loaded: Texture[][] = [];
      for (const frames of variants) {
        const texs: Texture[] = [];
        for (const url of frames) {
          const t = await loadTex(url);
          if (t) texs.push(t);
          else break; // 프레임은 앞에서부터 연속으로만 사용
        }
        if (texs.length > 0) loaded.push(texs);
      }
      if (loaded.length > 0) attackTex.set(defId, loaded);
    }),
  );
  await Promise.all(
    DIR_SPRITE_UNITS.map(async (defId) => {
      // ?v= 캐시 버스터: 방향 그림을 교체(고우토 등)해도 브라우저 캐시에 안 가리게
      const [eTex, w, n, sTex] = await Promise.all([
        loadTex(`/assets/units/${defId}_e.png?v=3`),
        loadTex(`/assets/units/${defId}_w.png?v=3`),
        loadTex(`/assets/units/${defId}_n.png?v=3`),
        loadTex(`/assets/units/${defId}_s.png?v=3`),
      ]);
      // 4방향이 온전히 갖춰진 유닛만 등록 — 한 캐릭터의 그림으로 일관되게 돈다
      if (eTex && w && n && sTex) {
        dirTex.set(defId, { e: eTex, w, n, s: sTex });
      }
    }),
  );
  await Promise.all(
    Object.entries(ASSET_ATTACK_ANIMS_AIR).map(async ([defId, variants]) => {
      const loaded: Texture[][] = [];
      for (const frames of variants) {
        const texs: Texture[] = [];
        for (const url of frames) {
          const t = await loadTex(url);
          if (t) texs.push(t);
          else break;
        }
        if (texs.length > 0) loaded.push(texs);
      }
      if (loaded.length > 0) airAttackTex.set(defId, loaded);
    }),
  );
  // 업그레이드 스킨 텍스처 (+ 스킨 전용 공격 프레임)
  const skinTex = new Map<string, Texture>();
  const skinAtkTex = new Map<string, Texture[]>();
  await Promise.all(
    Object.entries(ASSET_UPGRADE_SKINS).map(async ([defId, cfg]) => {
      const t = await loadTex(cfg.url);
      if (t) skinTex.set(defId, t);
      if (cfg.atk) {
        const texs: Texture[] = [];
        for (const url of cfg.atk) {
          const f = await loadTex(url);
          if (f) texs.push(f);
          else break;
        }
        if (texs.length > 0) skinAtkTex.set(defId, texs);
      }
    }),
  );
  // 스킬 시전 모션 프레임
  const skillAnimTex = new Map<string, Texture[]>();
  await Promise.all(
    Object.entries(ASSET_SKILL_ANIMS).map(async ([defId, urls]) => {
      const texs: Texture[] = [];
      for (const url of urls) {
        const t = await loadTex(url);
        if (t) texs.push(t);
        else break;
      }
      if (texs.length > 0) skillAnimTex.set(defId, texs);
    }),
  );
  // 지형 테마별 Wang 타일 + 소품 텍스처. 시트가 없는 테마는 코드 지형으로 폴백.
  const themeTiles = new Map<string, Map<number, Texture>>();
  const themeFullVariants = new Map<string, Texture[][]>();
  const themeOuterVariants = new Map<string, Texture[][]>();
  const themeProps = new Map<string, Texture[]>();
  const themeLandmarks = new Map<string, Texture>();
  const themeLaneProps = new Map<string, Texture[]>();
  await Promise.all(
    Object.entries(THEMES).map(async ([name, theme]) => {
      const sheet = await loadTex(theme.sheet);
      if (sheet) {
        const tiles = new Map<number, Texture>();
        for (const [idx, [tx, ty]] of Object.entries(theme.wang)) {
          tiles.set(Number(idx), new Texture({
            source: sheet.source,
            frame: new Rectangle(tx, ty, TILE_PX, TILE_PX),
          }));
        }
        themeTiles.set(name, tiles);
      }
      const props: Texture[] = [];
      for (const p of theme.props) {
        const t = await loadTex(`/assets/tiles/${p}.png`);
        if (t) props.push(t);
      }
      if (props.length > 0) themeProps.set(name, props);
      if (theme.landmark) {
        const lt = await loadTex(`/assets/tiles/${theme.landmark}.png`);
        if (lt) themeLandmarks.set(name, lt);
      }
      const lane: Texture[] = [];
      for (const p of theme.laneProps ?? []) {
        const t = await loadTex(`/assets/tiles/${p}.png`);
        if (t) lane.push(t);
      }
      if (lane.length > 0) themeLaneProps.set(name, lane);
      const fulls: Texture[][] = [];
      for (const v of theme.fullVariants ?? []) {
        const t = await loadTex(`/assets/tiles/${v}.png`);
        if (!t) continue;
        if (t.width >= 64) {
          // 64px 변형: 2×2 타일에 걸쳐 깔리는 큰 무늬 — 사분면 [좌상, 우상, 좌하, 우하]
          const h2 = t.width / 2;
          const v2 = t.height / 2;
          fulls.push([
            new Texture({ source: t.source, frame: new Rectangle(0, 0, h2, v2) }),
            new Texture({ source: t.source, frame: new Rectangle(h2, 0, h2, v2) }),
            new Texture({ source: t.source, frame: new Rectangle(0, v2, h2, v2) }),
            new Texture({ source: t.source, frame: new Rectangle(h2, v2, h2, v2) }),
          ]);
        } else {
          fulls.push([t]); // 32px 변형: 단일 타일
        }
      }
      if (fulls.length > 0) themeFullVariants.set(name, fulls);
      const outers: Texture[][] = [];
      for (const v of theme.outerVariants ?? []) {
        const t = await loadTex(`/assets/tiles/${v}.png`);
        if (!t) continue;
        if (t.width >= 64) {
          const h2 = t.width / 2;
          const v2 = t.height / 2;
          outers.push([
            new Texture({ source: t.source, frame: new Rectangle(0, 0, h2, v2) }),
            new Texture({ source: t.source, frame: new Rectangle(h2, 0, h2, v2) }),
            new Texture({ source: t.source, frame: new Rectangle(0, v2, h2, v2) }),
            new Texture({ source: t.source, frame: new Rectangle(h2, v2, h2, v2) }),
          ]);
        } else {
          outers.push([t]);
        }
      }
      if (outers.length > 0) themeOuterVariants.set(name, outers);
    }),
  );
  // 투사체 그림 (없으면 색 선분 폴백)
  const projTex = new Map<ProjKind, Texture>();
  await Promise.all(
    (Object.keys(PROJECTILE_STYLE) as ProjKind[]).map(async (kind) => {
      const t = await loadTex(`/assets/fx/proj_${kind}.png`);
      if (t) projTex.set(kind, t);
    }),
  );

  // 장판 데칼 (없으면 코드 타원 폴백)
  const zoneTex = new Map<string, Texture>();
  /** 장판 성장 프레임 (가시밭): 돋아남 → 반쯤 자람 → 만개(zone_thorns.png). */
  const zoneGrowTex = new Map<string, Texture[]>();
  await Promise.all(
    [
      'thorns', 'spores', 'forest', 'grave', 'blaze',
      // 마법 시전 자국 (효과 없음 — 그림만)
      'quake', 'frost', 'gravity', 'hellfire', 'fireburst', 'feast',
    ].map(async (kind) => {
      const t = await loadTex(`/assets/fx/zone_${kind}.png`);
      if (t) zoneTex.set(kind, t);
    }),
  );
  {
    // 가시밭: 솟아오르는 성장 프레임 (없으면 조용히 단일 데칼로)
    const frames: Texture[] = [];
    for (const n of [0, 1]) {
      const t = await loadTex(`/assets/fx/zone_thorns_grow${n}.png`);
      if (t) frames.push(t);
    }
    if (frames.length > 0) zoneGrowTex.set('thorns', frames);
  }
  // 부유/날갯짓 프레임
  const flapTex = new Map<string, Texture[]>();
  await Promise.all(
    Object.entries(ASSET_FLAP_FRAMES).map(async ([defId, urls]) => {
      const texs: Texture[] = [];
      for (const url of urls) {
        const t = await loadTex(url);
        if (t) texs.push(t);
        else break;
      }
      if (texs.length > 0) flapTex.set(defId, texs);
    }),
  );

  const world = new Container();
  const groundTiles = new Container();  // 픽셀 지형 타일 (Wang)
  const scorchedTiles = new Container(); // 불탄 구역 타일 — 탈색 필터를 씌운다
  const groundProps = new Container();   // 나무·덤불·지면 장식 (필터 없음)
  groundProps.sortableChildren = true;
  {
    // 채도를 크게 낮추고 살짝 어둡게 → 재에 덮인 숲
    const f = new ColorMatrixFilter();
    f.desaturate();
    f.brightness(0.62, true);
    scorchedTiles.filters = [f];
  }
  const ground = new Graphics();       // 폴백 지형 + 진영 틴트/중앙선 오버레이
  const zonesGr = new Graphics(); // 장판 폴백 (데칼 텍스처가 없을 때)
  /** 마몬의 상점 (캠페인 점령 오브젝트) — 필요할 때만 생성. */
  let mercShopSp: Sprite | null = null;
  /** 앨리스 베이스 장식 (합류점 맵 위 갈래 끝) — 순수 그림. */
  let allyBaseSp: Sprite | null = null;
  let mercShopLabel: Text | null = null;
  const zoneLayer = new Container(); // 장판 픽셀 데칼
  /** 고산 구름·안개 (nest 맵): 전장 위를 느리게 흐르는 반투명 레이어. */
  const cloudLayer = new Container();
  const shadows = new Graphics();
  const corpseLayer = new Container();
  const units = new Container();
  units.sortableChildren = true;
  /** 맵 경계 장식 (렌더 전용 — 심 엔티티가 아니라 밸런스 영향 없음). */
  let mapDecos: Sprite[] = [];

  /**
   * 잿길(ashroad): 걷는 길과 바깥 지형의 경계를 따라 불탄 나무를 촘촘히 심는다.
   * 유닛이 다니지 않는 경계 바깥이라 게임엔 영향이 없고, 불타는 숲의 분위기만
   * 만든다. 결정론이 필요 없는 순수 그림이지만 배치는 고정 시드로 뽑아
   * 접속할 때마다 같은 숲이 보이게 한다.
   */
  function buildMapDecos(): void {
    for (const d of mapDecos) d.destroy();
    mapDecos = [];
    if (curMap.id !== 'ashroad') return;
    let seed = 20260819;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    /** 종류 뽑기 — 잿불 고목 2종 도배 + 가끔 쓰러진 둥치. */
    const pickKind = (): string => {
      const r = rnd();
      if (r < 0.46) return 'c_ember_tree';
      if (r < 0.9) return 'c_ember_tree2';
      return 'c_burning_log';
    };
    const put = (xFP: number, yFP: number, deep: boolean): void => {
      const kind = pickKind();
      const tex = assetTex.get(kind)?.[0];
      if (!tex) return;
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 1);
      const w = TILE * (kind === 'c_burning_log' ? 2.2 : 1.9 + rnd() * 1.4);
      sp.scale.set(w / tex.width);
      if (rnd() < 0.5) sp.scale.x = -sp.scale.x;
      // 깊은 숲일수록 살짝 어둡게 — 원근감
      if (deep) sp.tint = rnd() < 0.5 ? 0xb8aca4 : 0xcabfb6;
      sp.x = sx(xFP);
      sp.y = sy(yFP);
      sp.zIndex = sp.y;
      units.addChild(sp);
      mapDecos.push(sp);
    };
    // 바깥 지형 전체를 불탄 숲으로 도배: 경계선부터 화면 끝까지 줄줄이 심는다
    const limit = renderHalfH() - Math.floor(0.6 * FP);
    for (const side of [-1, 1]) {
      for (let t = 2; t < 127; t += 1.6 + rnd() * 1.5) {
        const xFP = Math.floor(t * FP);
        const half = laneHalfWAt(curMap, xFP);
        const edge = laneCenterY(curMap, xFP) + side * (half + Math.floor(500 + rnd() * 900));
        // 경계에서 바깥으로 한 줄씩 — 줄 간격·좌우를 흔들어 자연스러운 숲으로
        let off = 0;
        let deep = false;
        for (let yFP = edge; Math.abs(yFP) < limit; yFP += side * Math.floor((1500 + rnd() * 1300))) {
          put(xFP + Math.floor((rnd() - 0.5) * 1400), yFP + off, deep);
          off = Math.floor((rnd() - 0.5) * 600);
          deep = true; // 두 번째 줄부터는 깊은 숲
        }
      }
    }
  }
  const fx = new Graphics();
  const projLayer = new Container(); // 투사체 스프라이트 (유닛 위, 체력바 아래)
  const bars = new Graphics();
  world.addChild(
    groundTiles, scorchedTiles, groundProps, ground,
    zonesGr, zoneLayer, shadows, corpseLayer, units, fx, projLayer, bars,
    cloudLayer, // 구름은 모든 것 위로 흐른다 (반투명)
  );
  app.stage.addChild(world);

  /** 지형 타일 격자 재구축 (맵 교체·초기화 시). 타일이 없으면 drawGround 폴백. */
  function buildGroundTiles(): void {
    for (const layer of [groundTiles, scorchedTiles, groundProps]) {
      for (const c of layer.removeChildren()) c.destroy();
    }
    const m = curMap;
    const names = MAP_THEMES[m.id] ?? ['desert'];
    if (!names.some((n) => themeTiles.has(n))) return;

    const tilesX = m.length / FP;
    const halfH = renderHalfH(m);
    const tilesY = Math.ceil((halfH * 2) / FP);
    const th = TILE * Y_SQUASH;
    const laneHalf = m.halfW / FP;

    /**
     * 이 칸에 쓸 테마. 테마가 2개면 맵 중앙에서 갈린다.
     * 경계는 행마다 물결치고, 그 부근 몇 칸은 두 테마를 흩뿌려 섞어서
     * 칼로 자른 직선이 아니라 "불이 번지다 만" 자국처럼 보이게 한다.
     */
    const BLEND = 4; // 섞이는 띠의 반폭 (타일)
    const themeAt = (i: number, j: number): string => {
      if (names.length < 2) return names[0]!;
      const wave = Math.sin(j * 0.9) * 2.2 + Math.sin(j * 0.37 + 1.3) * 1.7;
      const d = i - (tilesX / 2 + wave); // 경계로부터의 거리 (+ = 불탄 쪽)
      if (d <= -BLEND) return names[0]!;
      if (d >= BLEND) return names[1]!;
      const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
      const burntChance = ((d + BLEND) / (BLEND * 2)) * 1000;
      return h % 1000 < burntChance ? names[1]! : names[0]!;
    };
    // Wang 코너 판정: 꼭짓점이 코리도어(걷는 길) 안인가 — 메인 레인 + 가지 길
    const laneV = (vx: number, vy: number): number => {
      const wx = Math.max(0, Math.min(m.length, vx * FP));
      const cy = (laneCenterY(m, wx) + halfH) / FP;
      const hw = laneHalfWAt(m, wx) / FP; // 초크 구간은 좁다
      if (Math.abs(vy - cy) <= hw) return 1;
      for (const b of m.branches ?? []) {
        const bw = (b.halfW ?? m.halfW) / FP;
        const bx = b.x / FP;
        const by0 = (b.y0 + halfH) / FP;
        const by1 = (b.y1 + halfH) / FP;
        if (Math.abs(vx - bx) <= bw && vy >= by0 - 0.5 && vy <= by1 + bw) return 1;
      }
      return 0;
    };
    // 같은 타일이 반복될 때의 단조로움을 덜기 위한 아주 미세한 명암 변주.
    // 규칙적인 식으로 고르면 체커보드가 보이므로 해시로 흩는다.
    const SHADES = [0xffffff, 0xfafafa, 0xf5f5f5];
    for (let i = 0; i < tilesX; i++) {
      for (let j = 0; j < tilesY; j++) {
        const name = themeAt(i, j);
        const tiles = themeTiles.get(name);
        if (!tiles) continue;
        const idx = laneV(i, j) * 8 + laneV(i + 1, j) * 4 + laneV(i, j + 1) * 2 + laneV(i + 1, j + 1);
        let tex = tiles.get(idx);
        // 길 안쪽 칸: 변형 무늬와 해시로 섞는다. 64px 변형은 2×2 블록에 걸쳐
        // 깔려 큼지막한 무늬가 되고, 블록 단위로 종류를 고르므로 무늬가 안 끊긴다.
        if (idx === 0) {
          const outers = themeOuterVariants.get(name);
          if (outers && outers.length > 0) {
            const bi = i >> 1;
            const bj = j >> 1;
            const vh = ((bi * 2654435761) ^ (bj * 40503)) >>> 0;
            // 변형만 사용 — 원본 잔무늬 타일은 반복 피로의 원인이라 아예 걷어낸다.
            // 변형끼리는 같은 팔레트라 경계가 자연스럽다.
            const quads = outers[vh % outers.length]!;
            tex = quads.length === 4 ? quads[(j & 1) * 2 + (i & 1)]! : quads[0]!;
          }
        }
        if (idx === 15) {
          const variants = themeFullVariants.get(name);
          if (variants && variants.length > 0) {
            const bi = i >> 1;
            const bj = j >> 1;
            const vh = ((bi * 2654435761) ^ (bj * 40503)) >>> 0;
            // 길 안쪽은 변형 무늬만 사용 — 시트의 잔무늬 기본 타일이 섞이면 얼룩져 보인다
            const quads = variants[vh % variants.length]!;
            tex = quads.length === 4 ? quads[(j & 1) * 2 + (i & 1)]! : quads[0]!;
          }
        }
        if (!tex) continue;
        const sp = new Sprite(tex);
        sp.x = i * TILE;
        sp.y = PAD_TOP + j * th;
        sp.width = TILE;
        sp.height = th;
        sp.tint = SHADES[(((i * 73856093) ^ (j * 83492791)) >>> 0) % SHADES.length]!;
        (THEMES[name]?.scorched ? scorchedTiles : groundTiles).addChild(sp);
      }
    }
    // 소품 산포. 레인 밖은 나무·덤불처럼 서 있는 것, 레인 안은 납작한 지면 장식만.
    for (let i = 1; i < tilesX - 1; i++) {
      const cyT = (laneCenterY(m, i * FP + 500) + halfH) / FP;
      for (let j = 0; j < tilesY; j++) {
        // 레인 경계에서 얼마나 벗어났나 (0 이하 = 길 위)
        const out = Math.abs(j + 0.5 - cyT) - (laneHalf + 0.6);
        const inBand = out <= 0;
        const theme = themeAt(i, j);
        const props = inBand ? themeLaneProps.get(theme) : themeProps.get(theme);
        if (!props || props.length === 0) continue;
        const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
        // 길가는 우거지게, 멀어질수록 성기게 (협곡처럼 바깥이 넓은 맵에서 과밀 방지)
        const density = inBand ? 14 : out < 2 ? 24 : out < 5 ? 13 : 6;
        if (h % 100 >= density) continue;
        const tex = props[h % props.length]!;
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 1);
        sp.scale.set(((inBand ? TILE * 0.85 : TILE * 1.5) / tex.width));
        sp.x = i * TILE + ((h >> 4) % TILE);
        sp.y = PAD_TOP + j * th + ((h >> 8) % Math.max(1, Math.floor(th))) + th * 0.5;
        // 앞줄이 뒷줄을 가리도록 y 순으로 겹치기 (지면 장식은 항상 아래)
        sp.zIndex = inBand ? 0 : sp.y;
        groundProps.addChild(sp);
      }
    }
    // 대형 랜드마크: 맵 25%·75% 지점 길가 바깥에 하나씩 큼지막하게.
    // 위치는 맵 길이 기반 고정 — 어느 시드든 같은 자리라 지형지물로 기억된다.
    for (const [name, ltex] of themeLandmarks) {
      if (!MAP_THEMES[m.id]?.includes(name)) continue;
      for (const frac of [0.25, 0.75]) {
        const i = Math.floor(tilesX * frac);
        const cyT = (laneCenterY(m, i * FP) + halfH) / FP;
        const above = frac < 0.5; // 하나는 길 위쪽, 하나는 아래쪽
        const j = cyT + (above ? -(laneHalf + 3.2) : laneHalf + 4.6);
        const sp = new Sprite(ltex);
        sp.anchor.set(0.5, 1);
        sp.scale.set((TILE * 7) / ltex.width);
        sp.x = i * TILE;
        sp.y = PAD_TOP + j * th;
        sp.zIndex = sp.y;
        groundProps.addChild(sp);
      }
    }
  }

  // 고산 구름: nest 맵에서만 — 화면을 가로질러 느리게 흐른다
  const cloudTexs: Texture[] = [];
  for (const n of ['fx_cloud', 'fx_mist']) {
    const t = await loadTex(`/assets/tiles/${n}.png`);
    if (t) cloudTexs.push(t);
  }
  interface Drifter { sp: Sprite; vx: number }
  const drifters: Drifter[] = [];
  function rebuildClouds(): void {
    for (const d of drifters) d.sp.destroy();
    drifters.length = 0;
    cloudLayer.removeChildren();
    if (curMap.id !== 'nest' || cloudTexs.length === 0) return;
    const w = worldW();
    const h = worldH();
    for (let k = 0; k < 8; k++) {
      const tex = cloudTexs[k % cloudTexs.length]!;
      const sp = new Sprite(tex);
      sp.anchor.set(0.5);
      const scale2 = 1.6 + (k % 3) * 0.7;
      sp.scale.set(scale2);
      sp.alpha = 0.16 + (k % 3) * 0.05;
      sp.x = ((k * 977) % Math.max(1, Math.floor(w)));
      sp.y = ((k * 613) % Math.max(1, Math.floor(h)));
      cloudLayer.addChild(sp);
      drifters.push({ sp, vx: 0.12 + (k % 4) * 0.05 });
    }
  }

  const tiled = (): boolean => groundTiles.children.length + scorchedTiles.children.length > 0;
  buildGroundTiles();
  drawGround(ground, tiled());

  const sprites = new Map<number, Sprite>();
  /** 스프라이트 id → defId. 유닛이 사라진 뒤(=사망) 어떤 소리를 낼지 알아야 해서 따로 들고 있는다. */
  const spriteDefId = new Map<number, string>();
  // 전향(인형의 실) 감지: 스폰 시 팀을 기억해뒀다가 달라지면 표식을 남긴다
  const spriteTeam = new Map<number, 0 | 1 | 2>();
  const charmedIds = new Set<number>();
  const zoneSprites = new Map<number, { sp: Sprite; born: number }>();
  const prevPos = new Map<number, { x: number; y: number }>();
  /** 보급 마차 이동 추적 (캠페인 레이어가 심 밖에서 움직여서 별도 추적). */
  const cartMotion = new Map<number, { x: number; until: number }>();
  const unitFx = new Map<number, UnitFx>();
  const projectiles: Projectile[] = [];
  const projPool: Sprite[] = []; // 투사체 스프라이트 재사용 풀
  const impacts: Impact[] = [];
  /** 내리꽂기: 전체 연출 길이와 "착지" 시점 비율 (앞 40% 상승, 뒤 60% 급강하). */
  const DIVE_MS = 430;
  const DIVE_DOWN_AT = 0.55;
  /** 착지 흙먼지 (튀어오르는 파편). */
  const diveDusts: { x: number; y: number; start: number; r: number }[] = [];
  const corpses: Corpse[] = [];

  // 카메라
  let camX = 0;
  let camY = 0;
  let userZoom = 1;
  let zoom = 1;
  // 선택된 유닛 (클릭 정보창)
  /** 전용 스킨 텍스처를 쓰는 구조물 id — 팀 틴트를 입히지 않는다. */
  const skinnedStructures = new Set<number>();
  let selectedId: number | null = null;
  // 효과음 (setAudio 로 주입, 없으면 무음)
  let audio: Audio | null = null;
  const sfx = (key: SfxKey, screenX: number, volume = 1): void => {
    audio?.play(key, { screenX, volume });
  };
  // 마법 속성별 시전음 — fxZone/장판 종류가 가장 정확하고, 없으면 스킬 kind 로 가른다
  const castSfxOf = (a: { kind?: string; fxZone?: string; zone?: { kind?: string } } | undefined): SfxKey => {
    const z = a?.fxZone ?? a?.zone?.kind;
    if (z === 'blaze' || z === 'hellfire' || z === 'fireburst') return 'cast_fire';
    if (z === 'frost' || a?.kind === 'freeze') return 'cast_ice';
    if (z === 'quake' || a?.kind === 'slowfield') return 'cast_quake';
    if (a?.kind === 'ground') return 'cast_gravity';
    if (z === 'feast' || z === 'grave') return 'cast_dark';
    if (a?.kind === 'fear') return 'cast_bell';
    if (a?.kind === 'confuse' || a?.kind === 'charm') return 'cast_puppet';
    if (a?.kind === 'sleep') return 'cast_sleep';
    return 'cast_skill';
  };

  /** 유닛의 피격음 키 — 장갑/존재 태그에 따라 재질이 갈린다. */
  const hitKeyOf = (defId: string): SfxKey => {
    const tags = DEFS[defId]?.tags ?? [];
    if (tags.includes('construct')) return 'hit_construct';
    if (tags.includes('plate')) return 'hit_plate';
    if (tags.includes('leather')) return 'hit_leather';
    return 'hit_cloth';
  };
  /** 유닛의 사망음 키. */
  /** 네임드 전용 사망음 — 태그보다 우선한다. */
  const DEATH_SFX_OF: Record<string, SfxKey> = {
    m_alice: 'death_alice',
  };
  const deathKeyOf = (defId: string, entityId: number): SfxKey => {
    const named = DEATH_SFX_OF[defId];
    if (named) return named;
    // 엘프 궁수: 스프라이트 변형 [여, 남] 중 어느 쪽으로 그려졌는지에 맞춘다
    // (개체마다 갈려 data.ts 성별 태그를 붙일 수 없는 유일한 유닛)
    if (defId === 's_elf_archer') {
      const variants = assetTex.get(defId);
      const n = variants?.length ?? 2;
      return entityId % n === 0 ? 'death_female' : 'death_male';
    }
    const tags = DEFS[defId]?.tags ?? [];
    const female = tags.includes('female');
    const male = tags.includes('male');
    // 인형(기물)은 같은 성별이라도 어린 목소리로 — 사람과 확실히 구분된다
    if (tags.includes('construct')) {
      if (female) return 'death_doll_female';
      if (male) return 'death_doll_male';
      return 'death_construct';
    }
    // 인간형 성별 음성이 재질음보다 우선 (data.ts 의 'male'/'female' 태그)
    if (female) return 'death_female';
    if (male) return 'death_male';
    if (tags.includes('undead')) return 'death_undead';
    return 'death_bio';
  };
  const USER_ZOOM_MIN = 0.3;
  const USER_ZOOM_MAX = 3.0;

  function visibleW(): number {
    return app.screen.width / zoom;
  }
  function visibleH(): number {
    return app.screen.height / zoom;
  }
  function clampCam(): void {
    const maxX = Math.max(0, worldW() - visibleW());
    camX = Math.min(Math.max(camX, 0), maxX);
    const maxY = Math.max(0, worldH() - visibleH());
    camY = Math.min(Math.max(camY, 0), maxY);
  }
  function applyCamera(): void {
    const fit = Math.min(2.4, Math.max(0.8, app.screen.height / worldH()));
    zoom = fit * userZoom;
    clampCam();
    world.scale.set(zoom);
    world.x = worldW() * zoom <= app.screen.width
      ? (app.screen.width - worldW() * zoom) / 2
      : -camX * zoom;
    world.y = worldH() * zoom <= app.screen.height
      ? (app.screen.height - worldH() * zoom) / 2
      : -camY * zoom;
  }

  /** 유닛별 투사체·착탄 색 오버라이드 — 비슷한 폭발형끼리 헷갈리지 않게. */
  const PROJECTILE_COLOR_OF: Record<string, number> = {
    s_thorn_witch: 0xe0559a,      // 가시 마녀 — 진분홍 (가시밭 장판과 같은 계열)
    s_mushroom_bomber: 0xb07fe0,  // 버섯 폭탄병 — 보라 (포자 구름과 같은 계열)
  };
  const idivSafe = (a: number, b: number): number => Math.floor(a / b);
  const raceColor = (defId: string): number => {
    const override = PROJECTILE_COLOR_OF[defId];
    if (override !== undefined) return override;
    const race = DEFS[defId]?.race;
    return race === 'sylvarin' ? 0xc9e08a : race === 'pandemonium' ? 0x9a7fe8 : race === 'marionetta' ? 0xffb35c : 0xffe98a;
  };

  function draw(g: Game, alpha: number): void {
    applyCamera();
    const now = performance.now();
    // 화면 밖 소리를 버리고 좌우 팬을 계산하기 위해 가시 범위를 알려준다
    audio?.setViewport(camX, camX + visibleW());
    shadows.clear();
    fx.clear();
    // 고산 구름 드리프트 — 오른쪽으로 흘러가 끝에 닿으면 왼쪽에서 다시
    if (drifters.length > 0) {
      const w = worldW();
      for (const dr of drifters) {
        dr.sp.x += dr.vx;
        if (dr.sp.x - dr.sp.width / 2 > w) dr.sp.x = -dr.sp.width / 2;
      }
    }
    // ── 마몬의 상점 (점령제 용병 상점): 맵 중앙 길가에 상점 + 점령 팀 깃발 링 ──
    if (g.mercCaptureRequired) {
      const shopWx = idivSafe(g.map.length, 2);
      const shopPx = sx(shopWx);
      const cyLane = sy(laneCenterY(g.map, shopWx));
      // 상점을 점령 반경 상단 가장자리에 붙여 "이 링이 상점의 영역"임이 읽히게
      const shopPy = cyLane - (tiles(2.2) / FP) * TILE * 0.62;
      const tex0 = assetTex.get('mercshop')?.[0];
      if (tex0 && !mercShopSp) {
        mercShopSp = new Sprite(tex0);
        mercShopSp.anchor.set(0.5, 1);
        mercShopSp.scale.set((TILE * 3.2) / tex0.width);
        zoneLayer.addChild(mercShopSp);
        mercShopLabel = new Text({
          text: '🚩 마몬의 상점 — 점령 지역',
          style: { fontSize: 13, fill: 0xffd76a, stroke: { color: 0x000000, width: 3 }, fontWeight: 'bold' },
        });
        mercShopLabel.anchor.set(0.5, 1);
        zoneLayer.addChild(mercShopLabel);
      }
      if (mercShopSp) {
        mercShopSp.x = shopPx;
        mercShopSp.y = shopPy;
      }
      if (mercShopLabel) {
        mercShopLabel.x = shopPx;
        mercShopLabel.y = shopPy - (mercShopSp?.height ?? 60) - 4;
        const capLeft = g.mercCapturingTeam !== -1 ? Math.ceil((200 - g.mercCaptureTicks) / 20) : 0;
        mercShopLabel.text = g.mercCapturingTeam === 0 ? `🚩 점령 중… ${capLeft}초`
          : g.mercCapturingTeam === 1 ? `⚠ 적이 점령 중… ${capLeft}초`
          : g.mercOwner === 0 ? '🚩 마몬의 상점 — 아군 소유'
          : g.mercOwner === 1 ? '🚩 마몬의 상점 — 적 소유'
          : '🚩 마몬의 상점 — 점령 지역';
      }
      // 점령 링: 내 팀 = 파랑, 적 = 빨강, 중립 = 금색. 펄스 이중 링 + 채움으로 확실히 보이게
      const capturing = g.mercCapturingTeam;
      const ringColor = capturing === 0 ? 0x5fa8ff : capturing === 1 ? 0xff6a57
        : g.mercOwner === 0 ? 0x5fa8ff : g.mercOwner === 1 ? 0xff6a57 : 0xffd23d;
      const rr = (tiles(3.5) / FP) * TILE;
      const pulse2 = capturing !== -1
        ? 0.6 + 0.4 * Math.sin(now * 0.012) // 채널링: 빠른 펄스
        : 0.75 + 0.25 * Math.sin(now * 0.004);
      fx.ellipse(shopPx, cyLane, rr, rr * 0.62).fill({ color: ringColor, alpha: 0.1 });
      fx.ellipse(shopPx, cyLane, rr, rr * 0.62).stroke({ color: ringColor, width: 3.5, alpha: 0.85 * pulse2 });
      fx.ellipse(shopPx, cyLane, rr * 0.9, rr * 0.9 * 0.62).stroke({ color: ringColor, width: 1.5, alpha: 0.45 * pulse2 });
      // 채널링 진행 호: 위에서 시계방향으로 차오른다
      if (capturing !== -1) {
        const prog = Math.min(1, g.mercCaptureTicks / 200);
        const seg = 40;
        for (let k = 0; k < Math.floor(seg * prog); k++) {
          const ang = -Math.PI / 2 + (k / seg) * Math.PI * 2;
          const px2 = shopPx + Math.cos(ang) * rr * 1.08;
          const py2 = cyLane + Math.sin(ang) * rr * 1.08 * 0.62;
          fx.circle(px2, py2, 2.4).fill({ color: ringColor, alpha: 0.95 });
        }
      }
    } else if (mercShopSp) {
      mercShopSp.destroy();
      mercShopSp = null;
      mercShopLabel?.destroy();
      mercShopLabel = null;
    }
    // ── 호위전 거점 (캠페인 13): 확보 = 초록, 현재 목표 = 금색 펄스 + 진행 호, 미래 = 잿빛 ──
    if (escortCfg) {
      const ec = escortCfg;
      const rr = (ec.radius / FP) * TILE;
      for (let i = 0; i < ec.pointsX.length; i++) {
        const px2 = sx(ec.pointsX[i]!);
        const py2 = sy(laneCenterY(g.map, ec.pointsX[i]!));
        const captured = i < ec.frontier;
        const current = i === ec.frontier;
        const color = captured ? 0x67d76a : current ? (ec.contested ? 0xff6a57 : 0xffd23d) : 0x8a7f6a;
        const pulse2 = current ? 0.6 + 0.4 * Math.sin(now * 0.01) : 0.7;
        // 캠프 바닥: 다져진 흙 마당 — 사각 타일을 섞지 않고 부드러운 타원 데칼로
        // "사람이 지내는 자리" 느낌만 얹는다 (외곽으로 갈수록 옅어지는 3겹)
        fx.ellipse(px2, py2, rr * 1.12, rr * 0.62 * 1.12).fill({ color: 0x594636, alpha: 0.16 });
        fx.ellipse(px2, py2, rr * 0.86, rr * 0.62 * 0.86).fill({ color: 0x64503c, alpha: 0.16 });
        fx.ellipse(px2, py2, rr * 0.55, rr * 0.62 * 0.55).fill({ color: 0x705a42, alpha: 0.14 });
        fx.ellipse(px2, py2, rr, rr * 0.62).fill({ color, alpha: captured ? 0.05 : current ? 0.1 : 0.03 });
        fx.ellipse(px2, py2, rr, rr * 0.62)
          .stroke({ color, width: current ? 3.5 : 2, alpha: (current ? 0.9 : 0.5) * pulse2 });
        if (current && ec.progress01 > 0) {
          // 점령 진행 호 — 위에서 시계방향으로 차오른다
          const seg = 40;
          for (let k = 0; k < Math.floor(seg * ec.progress01); k++) {
            const ang = -Math.PI / 2 + (k / seg) * Math.PI * 2;
            fx.circle(px2 + Math.cos(ang) * rr * 1.08, py2 + Math.sin(ang) * rr * 1.08 * 0.62, 2.4)
              .fill({ color, alpha: 0.95 });
          }
        }
        // 깃발 라벨 — 나무·망루에 가리지 않게 유닛 레이어 맨 위에 얹는다
        if (!escortLabels[i]) {
          const t = new Text({
            text: '', style: { fontSize: 12, fill: 0xffffff, stroke: { color: 0x000000, width: 3 }, fontWeight: 'bold' },
          });
          t.anchor.set(0.5, 1);
          t.zIndex = Number.MAX_SAFE_INTEGER; // 항상 오브젝트 위
          units.addChild(t);
          escortLabels[i] = t;
        }
        const lbl = escortLabels[i]!;
        lbl.x = px2;
        lbl.y = py2 - rr * 0.62 - 46; // 캠프 오브젝트(나무·망루) 키를 넘겨서
        lbl.style.fill = color;
        lbl.text = captured ? `🚩 실바린 캠프 ${i + 1} — 확보` : current
          ? (ec.contested ? `⚔ 캠프 ${i + 1} — 교전 중!` : `🏳 캠프 ${i + 1} — 점령 목표`)
          : `캠프 ${i + 1}`;
      }
    }
    bars.clear();

    // ── 장판 ──
    zonesGr.clear();
    const zoneSeen = new Set<number>();
    for (const z of g.zones) {
      const remain = z.untilTick - g.tick;
      if (remain <= 0) continue;
      // 생성 직후 0.3초 확대 등장, 만료 0.5초 전부터 페이드아웃 + 은은한 맥동
      const fade = Math.min(1, remain / 10);
      const pulse = 0.88 + 0.12 * Math.sin(now * 0.003 + z.id * 2.1);
      const cx = sx(z.x), cy = sy(z.y);
      const r = (z.radius / FP) * TILE;
      const tex = zoneTex.get(z.kind);
      if (tex) {
        zoneSeen.add(z.id);
        let zs = zoneSprites.get(z.id);
        if (!zs) {
          const sp = new Sprite(tex);
          sp.anchor.set(0.5);
          zs = { sp, born: now };
          zoneSprites.set(z.id, zs);
          zoneLayer.addChild(sp);
        }
        const sp = zs.sp;
        const age = now - zs.born;
        // 성장 프레임 보유 장판(가시밭): 돋아남(0~220ms) → 반쯤(~440ms) → 만개.
        // 가시가 "솟아오르는" 게 보이도록 초반엔 세로로 눌렸다가 튀어오른다.
        const growFrames = zoneGrowTex.get(z.kind);
        const want = growFrames
          ? (age < 220 ? growFrames[0]! : age < 440 ? (growFrames[1] ?? tex) : tex)
          : tex;
        if (sp.texture !== want) sp.texture = want;
        sp.x = cx;
        sp.y = cy;
        // 데칼 폭을 장판 지름에 맞춘다 (데칼 자체가 납작한 타원이라 y 는 비율 유지).
        const grow = Math.min(1, 0.55 + (0.45 * age) / 250);
        const s = ((r * 2.15) / tex.width) * grow;
        if (growFrames) {
          // 세로 스쿼시 팝: 0.35 → 1.08 (오버슈트) → 1.0
          const t01 = Math.min(1, age / 480);
          const popY = t01 < 0.85 ? 0.35 + 0.85 * t01 : 1.08 - 0.08 * ((t01 - 0.85) / 0.15);
          sp.scale.set(s, s * popY);
        } else {
          sp.scale.set(s);
        }
        sp.alpha = 0.82 * fade * pulse;
      } else {
        const color = z.kind === 'thorns' ? 0xd4574a // 가시밭 — 핏빛 빨강
          : z.kind === 'spores' ? 0x6ab82a // 포자 구름 — 탁한 독초록 (가시밭과 확실히 구분)
          : z.kind === 'balm' ? 0x9fefad // 치유 포자 — 밝은 민트 (독초록과도 구분)
          : z.kind === 'grave' ? 0x7a5fd0 // 사후의 경계
          : z.kind === 'blaze' ? 0xff7a2e // 블레이즈 — 불구덩이
          : z.kind === 'quake' ? 0xa8845c // 어스퀘이크 — 갈라진 땅
          : z.kind === 'frost' ? 0x9fdcff // 블리자드 — 얼음
          : z.kind === 'gravity' ? 0xb06ad0 // 리버스그라비티 — 중력진
          : z.kind === 'hellfire' ? 0x7fe89a // 지옥불 — 저주 화염
          : z.kind === 'fireburst' ? 0xffa03d // 화염구 폭발
          : z.kind === 'feast' ? 0x9a5fd0 // 망자의 만찬
          : 0x5fcf6a;
        zonesGr.ellipse(cx, cy, r, r * 0.62).fill({ color, alpha: 0.14 * fade * pulse });
        zonesGr.ellipse(cx, cy, r, r * 0.62).stroke({ color, width: 1.5, alpha: 0.45 * fade * pulse });
      }
    }
    // 사라진 장판 스프라이트 정리
    for (const [id, zs] of zoneSprites) {
      if (!zoneSeen.has(id)) {
        zs.sp.destroy();
        zoneSprites.delete(id);
      }
    }
    const seen = new Set<number>();
    const byId = new Map<number, (typeof g.entities)[number]>();
    for (const e of g.entities) if (e.alive) byId.set(e.id, e);

    for (const e of g.entities) {
      if (!e.alive) continue;
      seen.add(e.id);
      const d = DEFS[e.defId]!;
      let sp = sprites.get(e.id);
      if (!sp) {
        // 적(팀1) 건물 스킨: 캠페인 명시 스킨 우선, 장난감 나라는 자동 — 아군 기지는 그대로.
        // 예외: 둥지 맵의 아군 넥서스는 「둥지」 그림 (지켜야 할 대상이 한눈에 보이게)
        const autoSkin = curMap?.id === 'toybox' ? 'toy' : null;
        const skin = enemySkin ?? autoSkin;
        const toyKey = curMap?.id === 'nest' && e.team === 0 && e.defId === 'nexus'
          ? 'nexus_nest'
          : skin && e.team === 1 && (e.defId === 'tower' || e.defId === 'nexus')
            ? `${e.defId}_${skin}` : undefined;
        if (toyKey && assetTex.has(toyKey)) skinnedStructures.add(e.id);
        const variants = (toyKey ? assetTex.get(toyKey) : undefined) ?? assetTex.get(e.defId);
        // 변형은 유닛 id 로 결정론적 배정 (엘프 궁수 여/남 50:50 등)
        const custom = variants ? variants[e.id % variants.length] : undefined;
        // 업그레이드 스킨: 소유 플레이어가 해당 업그레이드를 보유하면 교체
        const skinCfg = ASSET_UPGRADE_SKINS[e.defId];
        const useSkin = !!skinCfg && e.owner >= 0
          && !!g.players[e.owner]?.upgrades[skinCfg.upgrade] && skinTex.has(e.defId);
        sp = new Sprite(useSkin ? skinTex.get(e.defId)! : (custom ?? artOf(e.defId, e.team === 2 ? 0 : e.team).texture));
        sp.anchor.set(0.5, 1);
        const sizeMul = ASSET_SIZE_MUL[e.defId] ?? 1;
        const targetW = Math.max(20, (d.radius / FP) * 2 * TILE * 2.2) * (useSkin ? skinCfg!.scaleMul : 1) * sizeMul;
        sp.scale.set(targetW / sp.texture.width);
        const hasDir = dirTex.has(
          e.defId === 's_elf_archer' ? (e.id % 2 === 0 ? 's_elf_archer_f' : 's_elf_archer_m') : e.defId,
        );
        if (!hasDir && e.team === 1 && d.tier !== 'structure') sp.scale.x = -sp.scale.x;
        sprites.set(e.id, sp);
        spriteDefId.set(e.id, e.defId);
        spriteTeam.set(e.id, e.team);
        units.addChild(sp);
        prevPos.set(e.id, { x: e.x, y: e.y });
        unitFx.set(e.id, {
          lastCooldown: e.cooldown, lastHealCd: e.healCooldown,
          lastSkillCd: e.skillCds.reduce((a, b) => a + b, 0), lastSkillCds: [...e.skillCds], lastHp: e.hp, flashUntil: 0,
          lungeStart: 0, lungeDx: 0, lungeDy: 0, atkAir: false, diveStart: 0, diveUntil: 0,
          faceDir: e.team === 0 ? 'e' : 'w',
          recoilStart: 0, recoilDx: 0, aimStart: 0, aimUntil: 0, skillStart: 0, skillUntil: 0, healGlowUntil: 0,
          walkPhase: Math.random() * 6.28, moving: false,
          baseScaleX: sp.scale.x, baseScaleY: sp.scale.y,
          hasSkin: useSkin,
        });
      }
      const vfx = unitFx.get(e.id)!;

      // 전향(인형의 실): 팀이 바뀌었다 — 바라보는 방향을 뒤집고 표식을 남긴다
      if (spriteTeam.get(e.id) !== e.team) {
        spriteTeam.set(e.id, e.team);
        vfx.baseScaleX = -vfx.baseScaleX;
        sp.scale.x = -sp.scale.x;
        charmedIds.add(e.id);
      }

      // ── 이벤트 감지 (시뮬 상태 변화 → 연출 트리거) ──
      // 발사: 쿨다운이 늘었다 = 이번 스텝에 공격했다
      if (e.cooldown > vfx.lastCooldown && d.weapon) {
        const target = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
        vfx.atkAir = !!target && !!DEFS[target.defId]?.flying;
        // 수호자(중간보스) 광역 스윙: 넓은 충격파가 퍼진다 (드래곤 = 화염, 할로우 = 저주)
        if (target && d.tier === 'guardian' && d.weapon.splash) {
          const bossR = (d.weapon.splash / FP) * TILE;
          if (e.defId === 'teddy_guardian' && !vfx.atkAir) {
            // 곰인형 지상 강타: 자기 발밑에서 땅이 울리듯 흙빛 충격파가 3겹으로 퍼진다
            const gx = sx(e.x), gy = sy(e.y) - 2;
            impacts.push({ x: gx, y: gy, start: now, radius: bossR * 1.15, color: 0xc8a05a });
            impacts.push({ x: gx, y: gy, start: now + 110, radius: bossR * 0.85, color: 0xa8845c });
            impacts.push({ x: gx, y: gy, start: now + 220, radius: bossR * 0.55, color: 0x8a6c48 });
          } else {
            const bossColor = e.defId === 'dragon' ? 0xff8a3d
              : e.defId === 'teddy_guardian' ? 0xff9a7a : 0x9a6ae0;
            impacts.push({ x: sx(target.x), y: sy(target.y) - 4, start: now, radius: bossR, color: bossColor });
            impacts.push({ x: sx(target.x), y: sy(target.y) - 4, start: now + 120, radius: bossR * 0.65, color: bossColor });
          }
        }
        if (target) {
          const ranged = d.weapon.range >= RANGED_THRESHOLD;
          const fromX = sx(e.x), fromY = sy(e.y);
          const toX = sx(target.x), toY = sy(target.y);
          if (ranged) {
            vfx.recoilStart = now;
            vfx.recoilDx = fromX < toX ? -2.5 : 2.5;
            vfx.aimStart = now;
            vfx.aimUntil = now + 700; // 발사 애니메이션 구간
            projectiles.push({
              x0: fromX, y0: fromY - sp.height * 0.55,
              x1: toX, y1: toY - 8,
              start: now, dur: 100 + Math.hypot(toX - fromX, toY - fromY) * 1.1,
              color: raceColor(e.defId),
              splash: d.weapon.splash ? (d.weapon.splash / FP) * TILE : 0,
              ...(PROJECTILE_OF[e.defId] ? { kind: PROJECTILE_OF[e.defId] } : {}),
              spin0: (e.id % 17) * 0.37,
            });
          } else {
            vfx.lungeStart = now;
            const dx = toX - fromX, dy = toY - fromY;
            const len = Math.hypot(dx, dy) || 1;
            vfx.lungeDx = (dx / len) * 7;
            vfx.lungeDy = (dy / len) * 7;
            vfx.aimStart = now;
            vfx.aimUntil = now + 400; // 근접 휘두르기 애니메이션 (있는 유닛만)
          }
          // 공격음: 원거리는 마법/투사체로 나눠서. 가시·독은 전용음.
          const pu = e.owner >= 0 ? g.players[e.owner]?.upgrades : undefined;
          const poisonous = !!pu && (d.id === 's_elf_archer' ? !!pu['su_elf_poison'] : d.id === 's_vine_hunter' ? !!pu['su_vine_poison'] : false);
          const magic = ranged && d.weapon.range >= tiles(3) && (d.heal !== undefined || d.weapon.zone !== undefined);
          sfx(d.id === 's_thorn_witch' ? 'atk_thorn'
            : poisonous ? 'atk_poison'
            : ranged ? (magic ? 'atk_magic' : 'atk_ranged') : 'atk_melee', fromX, 0.6);
        }
      }
      vfx.lastCooldown = e.cooldown;
      // 힐 시전 감지 → 시전 애니메이션
      if (e.healCooldown > vfx.lastHealCd) {
        vfx.aimStart = now;
        vfx.aimUntil = now + 600;
        sfx('cast_heal', sx(e.x), 0.55);
      }
      vfx.lastHealCd = e.healCooldown;
      // 액티브 스킬 발동 감지 → 확산 링 이펙트 (strike 는 대상 위치, 그 외 자기 위치)
      // 쿨다운 합이 크게 뛰면 이번 스텝에 스킬을 시전한 것 (틱당 감소는 소폭).
      const skillCdSum = e.skillCds.length > 0 ? e.skillCds.reduce((a, b) => a + b, 0) : 0;
      if (skillCdSum > vfx.lastSkillCd + 4) {
        const strike = d.actives?.find((a) => a.kind === 'strike');
        const strikeTarget = strike && e.targetId >= 0 ? byId.get(e.targetId) : undefined;
        const cx = strikeTarget ? sx(strikeTarget.x) : sx(e.x);
        const cy = strikeTarget ? sy(strikeTarget.y) - 6 : sy(e.y) - 10;
        // 방금 발동한 스킬의 종류로 링 색을 가른다 (도발 = 보라, 반사 = 빨강)
        let castKind: string | undefined;
        let castSkill: import('@desertlike/sim').ActiveSkill | undefined;
        for (let i = 0; i < e.skillCds.length; i++) {
          if ((e.skillCds[i] ?? 0) > (vfx.lastSkillCds?.[i] ?? 0) + 4) {
            castKind = d.actives?.[i]?.kind;
            castSkill = d.actives?.[i];
          }
        }
        // 오라형 스킬(가호 등)은 실제 오라 반경만큼 링을 그려 범위를 보여준다
        const auraR = castSkill?.auraRadius ? (castSkill.auraRadius / FP) * TILE : 0;
        impacts.push({
          x: cx, y: cy, start: now,
          radius: castKind === 'allyarmor' && auraR ? auraR
            : castKind === 'taunt' ? 34 : castKind === 'reflect' ? 30
            : strike?.splash ? (strike.splash / FP) * TILE : 18,
          color: castKind === 'allyarmor' ? 0x8fd8ff // 가호 — 하늘빛 보호 오라
            : castKind === 'taunt' ? 0xb06ad0
            : castKind === 'reflect' ? 0xff4d4d
            : castKind === 'fear' ? 0x7a3de0
            : strikeTarget ? 0xffd23d : 0x7ddcff,
        });
        // 「내리꽂기」류(지상 전용 strike): 솟구쳤다 내리찍는 전용 연출
        const isDive = castKind === 'strike' && castSkill?.targets === 'ground';
        if (isDive) {
          vfx.diveStart = now;
          vfx.diveUntil = now + DIVE_MS;
          const gy = strikeTarget ? sy(strikeTarget.y) : sy(e.y);
          const gx = strikeTarget ? sx(strikeTarget.x) : sx(e.x);
          const r = castSkill?.splash ? (castSkill.splash / FP) * TILE : 24;
          // 착지 순간(하강 완료 시점)에 맞춰 흙먼지 3겹 + 바깥으로 퍼지는 균열 링
          const land = now + DIVE_MS * DIVE_DOWN_AT;
          impacts.push({ x: gx, y: gy, start: land, radius: r * 1.25, color: 0xd8b98a });
          impacts.push({ x: gx, y: gy, start: land + 70, radius: r * 0.95, color: 0xb08c5a });
          impacts.push({ x: gx, y: gy, start: land + 150, radius: r * 0.6, color: 0x8a6a42 });
          impacts.push({ x: gx, y: gy, start: land, radius: r * 1.6, color: 0xfff0c0 });
          diveDusts.push({ x: gx, y: gy, start: land, r });
        }
        if (skillAnimTex.has(e.defId)) {
          // 전용 시전 프레임 재생
          vfx.skillStart = now;
          vfx.skillUntil = now + 650;
        } else if (!isDive) {
          // 공격 모션 재활용
          vfx.aimStart = now;
          vfx.aimUntil = now + (strikeTarget ? 400 : 600);
        }
        sfx(isDive ? 'cast_quake' : castSfxOf(castSkill), cx, isDive ? 1 : 0.85);
      }
      vfx.lastSkillCd = skillCdSum;
      vfx.lastSkillCds = [...e.skillCds];
      // 회복 감지 (힐/재생/흡혈) → 초록 플러스 이펙트
      if (e.hp > vfx.lastHp) vfx.healGlowUntil = now + 450;
      // 피격: 체력이 줄었다 — 맞은 쪽 재질에 따라 타격음이 갈린다
      if (e.hp < vfx.lastHp) {
        vfx.flashUntil = now + 110;
        sfx(hitKeyOf(e.defId), sx(e.x), 0.5);
      }
      vfx.lastHp = e.hp;

      // ── 위치/보간 ──
      const pv = prevPos.get(e.id)!;
      const ix = pv.x + (e.x - pv.x) * alpha;
      const iy = pv.y + (e.y - pv.y) * alpha;
      const movedNow = e.x !== pv.x || e.y !== pv.y;
      vfx.moving = movedNow;
      // 엘프 궁수(여/남 변형): 스프라이트 변형과 같은 규칙으로 방향 세트를 고른다
      const dirKey = e.defId === 's_elf_archer'
        ? (e.id % 2 === 0 ? 's_elf_archer_f' : 's_elf_archer_m')
        : e.defId;
      if (movedNow && dirTex.has(dirKey)) {
        const mdx = e.x - pv.x;
        const mdy = e.y - pv.y;
        // 주 이동축 기준 4방향 — 대각선은 가로 우선 (그림이 자연스럽다)
        vfx.faceDir = Math.abs(mdx) >= Math.abs(mdy)
          ? (mdx >= 0 ? 'e' : 'w')
          : (mdy >= 0 ? 's' : 'n');
      }

      let px = sx(ix);
      let py = sy(iy);
      const shadowY = py;
      let rot = 0;

      // 보급 마차: 구르는 모션 — 이동 방향으로 몸을 틀고 덜컹이며 구른다.
      // 마차는 캠페인 레이어가 심 스텝 밖에서 움직이므로 prevPos 비교(movedNow)에
      // 안 잡힌다 — x 변화를 직접 추적하고, 프레임 사이 깜빡임은 여운(220ms)으로 잇는다.
      // 좌우는 반전, 위아래 경사는 좌우 그림 그대로 굴린다 (전용 상하 그림이 없다).
      if (e.defId === 'c_supply_cart') {
        const cm = cartMotion.get(e.id) ?? { x: e.x, until: 0 };
        if (e.x !== cm.x) {
          vfx.faceDir = e.x > cm.x ? 'e' : 'w';
          cm.until = now + 220;
          cm.x = e.x;
        }
        cartMotion.set(e.id, cm);
        if (now < cm.until) {
          vfx.walkPhase += 0.5;
          py -= Math.abs(Math.sin(vfx.walkPhase)) * 1.6; // 바퀴 덜컹임
          rot = Math.sin(vfx.walkPhase * 0.5) * 0.05; // 짐칸이 좌우로 흔들린다
        }
        sp.scale.x = Math.abs(vfx.baseScaleX) * (vfx.faceDir === 'w' ? -1 : 1);
      }
      // 걷기 바운스 (지상 유닛만)
      if (!d.flying && vfx.moving && d.speed > 0) {
        vfx.walkPhase += 0.35;
        py -= Math.abs(Math.sin(vfx.walkPhase)) * 2.2;
        rot = Math.sin(vfx.walkPhase) * 0.06;
      }
      // ── 내리꽂기: 솟구쳤다 급강하해 땅에 박는다 (비행 봅보다 우선) ──
      let diving = false;
      let diveSquash = 1;
      if (now < vfx.diveUntil) {
        diving = true;
        const dt = (now - vfx.diveStart) / DIVE_MS; // 0~1
        const up = 62; // 솟구치는 높이(px)
        if (dt < DIVE_DOWN_AT) {
          // 상승: 처음엔 빠르게, 정점에서 잠깐 머문다 (ease-out)
          const k = dt / DIVE_DOWN_AT;
          py -= up * Math.sin(k * Math.PI * 0.5);
          diveSquash = 1 + k * 0.12; // 솟구치며 살짝 늘어남
        } else {
          // 급강하 + 착지 스쿼시 (땅을 때리는 맛)
          const k = (dt - DIVE_DOWN_AT) / (1 - DIVE_DOWN_AT);
          const slam = Math.min(1, k * 3.2); // 매우 빠르게 내리꽂힘
          py -= up * (1 - slam);
          if (k > 0.31) {
            const s2 = (k - 0.31) / 0.69;
            diveSquash = 0.72 + 0.28 * s2; // 납작하게 눌렸다 복원
          } else {
            diveSquash = 1.1;
          }
        }
      }
      // 비행 봅 + 날갯짓 (리버스그라비티로 지상화되면 땅에 붙는다)
      const groundedNow = g.tick < e.groundedUntil;
      if (d.flying && !groundedNow && !diving) {
        py -= 26 + Math.sin((g.tick + e.id * 13) * 0.12) * 3;
        const flapFrames = vfx.hasSkin ? undefined : flapTex.get(e.defId);
        if (flapFrames && now >= vfx.aimUntil) {
          // 부유 모션 (공격 애니메이션 중에는 양보)
          let want: Texture | undefined;
          if (flapFrames.length >= 2) {
            // 다프레임: 순환 재생 (~140ms/프레임)
            const fi = Math.floor((now + e.id * 137) / 140) % flapFrames.length;
            want = flapFrames[fi];
          } else {
            // 1프레임: 기본 포즈와 교대
            const baseT = assetTex.get(e.defId)?.[e.id % (assetTex.get(e.defId)?.length ?? 1)];
            const up = Math.sin(now * 0.02 + e.id * 1.7) > 0;
            want = up ? flapFrames[0] : baseT;
          }
          if (want && sp.texture !== want) sp.texture = want;
          sp.scale.y = vfx.baseScaleY;
          sp.scale.x = vfx.baseScaleX;
        } else if (flapFrames) {
          sp.scale.y = vfx.baseScaleY;
          sp.scale.x = vfx.baseScaleX;
        } else {
          // 프레임이 없는 비행체는 스쿼시 착시로 폴백
          const flap = Math.sin(now * 0.02 + e.id * 1.7);
          sp.scale.y = vfx.baseScaleY * (1 + 0.09 * flap);
          sp.scale.x = vfx.baseScaleX * (1 - 0.05 * flap);
        }
      }
      // 근접 돌진 (150ms 왕복)
      if (vfx.lungeStart > 0) {
        const t = (now - vfx.lungeStart) / 150;
        if (t < 1) {
          const k = Math.sin(t * Math.PI); // 0→1→0
          px += vfx.lungeDx * k;
          py += vfx.lungeDy * k;
        } else vfx.lungeStart = 0;
      }
      // 원거리 반동 (120ms)
      if (vfx.recoilStart > 0) {
        const t = (now - vfx.recoilStart) / 120;
        if (t < 1) px += vfx.recoilDx * (1 - t);
        else vfx.recoilStart = 0;
      }

      // 내리꽂기 스쿼시: 세로로 눌리고 가로로 퍼진다 (땅을 때리는 맛)
      if (diving) {
        sp.scale.y = vfx.baseScaleY * diveSquash;
        sp.scale.x = (sp.scale.x < 0 ? -1 : 1) * Math.abs(vfx.baseScaleX) * (2 - diveSquash);
        rot += (1 - diveSquash) * 0.5; // 내리꽂을 때 앞으로 기운다
      }
      sp.x = px;
      sp.y = py;
      sp.rotation = rot;
      sp.zIndex = shadowY + (d.flying ? 4000 : 0);
      // 피격 플래시 > 무적(백금색) > 중독/화상(연녹색) > 혼란(보라) > 자가 버프(금색) > 기본
      const sbSkill = d.actives?.find((a) => a.kind === 'selfbuff');
      const buffedNow = sbSkill !== undefined && g.tick < e.buffUntil;
      // 영구 무적(불타는 나무·보급 마차 같은 소품)은 「무적 연출」 대상이 아니다 —
      // 링·틴트·체력바가 다 붙으면 소품이 유닛처럼 보여 화면만 시끄럽다
      const propInvuln = e.invulnUntil === Number.MAX_SAFE_INTEGER;
      const invulnNow = g.tick < e.invulnUntil && !propInvuln;
      const confusedNow = g.tick < e.confusedUntil;
      const asleepNow = g.tick < e.sleepUntil;
      const skinnedStructure = skinnedStructures.has(e.id);
      const weakenedNow = g.tick < e.weakenedUntil;
      const frozenNow = g.tick < e.frozenUntil;
      const fearedNow = g.tick < e.fearedUntil;
      // 수호자 생존 중인 넥서스는 보호막 상태 (때려도 안 들어간다)
      const shieldedNow = e.defId === 'nexus' && !g.guardianDown[e.team as 0 | 1];
      sp.tint = now < vfx.flashUntil ? 0xff7a6a
        : invulnNow ? 0xfff6d0
        // 빙결: 얼음빛 — 수면보다 차갑고 밝게
        : frozenNow ? 0x9fdcff
        : g.tick < e.dotUntil ? 0xb8f0a0
        // 혼란: 넋이 나간 듯 잿빛으로 (한눈에 "얘 지금 안 싸운다"가 읽히게)
        : confusedNow ? 0x8a8a8a
        // 수면: 푸르스름하게 가라앉힌다
        : asleepNow ? 0x8fa8d8
        // 공포: 새하얗게 질린다
        : fearedNow ? 0xe8e0f0
        : buffedNow ? 0xffe6a0
        // 약화: 핏기 빠진 회보라
        : weakenedNow ? 0xc4b0c8
        // 구조물은 팀 색으로 물들인다 (양 팀이 같은 그림이라 편 구분이 안 됐다).
        // 전용 스킨을 쓰는 건물은 생김새로 이미 구분되므로 원색 그대로 둔다.
        : d.tier === 'structure' && !skinnedStructure ? STRUCTURE_TEAM_TINT[e.team as 0 | 1] : 0xffffff;
      // 뿌리박기류: 지속 중 발밑에 갈색 뿌리 링
      if (buffedNow && sbSkill?.holdGround) {
        fx.ellipse(px, shadowY, 12, 5.5).stroke({ color: 0x8a6a3d, width: 2, alpha: 0.8 });
      }
      // 무적 (인비저블): 금색 보호막 링 (맥동)
      if (invulnNow) {
        const shim = 0.55 + 0.3 * Math.sin(now * 0.012);
        fx.ellipse(px, py - sp.height * 0.45, sp.width * 0.62, sp.height * 0.55)
          .stroke({ color: 0xffd86a, width: 2, alpha: shim });
      }
      // 혼란: 머리 위에서 별 세 개가 빙글빙글 (기절 만화 연출)
      if (confusedNow) {
        const hy = py - sp.height - 8;
        const spin = now * 0.005;
        for (let k = 0; k < 3; k++) {
          const a = spin + (k * Math.PI * 2) / 3;
          const ox = Math.cos(a) * 8;
          const oy = Math.sin(a) * 3; // 납작한 궤도 = 원근감
          const r = 1.6 + Math.sin(a) * 0.5; // 뒤로 갈수록 작게
          fx.circle(px + ox, hy + oy, r).fill({ color: 0xffe14d, alpha: 0.55 + Math.sin(a) * 0.35 });
        }
      }
      // 빙결: 유닛을 감싸는 얼음 결정 (육각 스파이크 링)
      if (frozenNow) {
        const icy = py - sp.height * 0.45;
        for (let k = 0; k < 6; k++) {
          const a = (k * Math.PI) / 3 + 0.3;
          const rx = Math.cos(a) * sp.width * 0.55;
          const ry = Math.sin(a) * sp.height * 0.5;
          fx.moveTo(px + rx * 0.6, icy + ry * 0.6).lineTo(px + rx, icy + ry)
            .stroke({ color: 0xcfeeff, width: 2, alpha: 0.85 });
        }
        fx.ellipse(px, icy, sp.width * 0.58, sp.height * 0.52)
          .stroke({ color: 0x9fdcff, width: 1.5, alpha: 0.7 });
      }
      // 가시 봉제 (공격 반사) 지속 중: 붉은 가시 링이 회전한다
      if (g.tick < e.reflectUntil) {
        const ry = py - sp.height * 0.45;
        const spin = now * 0.003;
        for (let k = 0; k < 8; k++) {
          const a = spin + (k * Math.PI) / 4;
          const rx = Math.cos(a) * sp.width * 0.6;
          const rz = Math.sin(a) * sp.height * 0.55;
          fx.moveTo(px + rx * 0.78, ry + rz * 0.78).lineTo(px + rx * 1.12, ry + rz * 1.12)
            .stroke({ color: 0xff5a4d, width: 2, alpha: 0.85 });
        }
        fx.ellipse(px, ry, sp.width * 0.62, sp.height * 0.56)
          .stroke({ color: 0xff5a4d, width: 1.5, alpha: 0.5 + 0.2 * Math.sin(now * 0.01) });
      }
      // 전향(인형의 실): 머리 위 분홍 실에 매달린 하트 표식
      if (charmedIds.has(e.id)) {
        const hy = py - sp.height - 12;
        const sway = Math.sin(now * 0.004 + e.id) * 2;
        fx.moveTo(px + sway, hy - 6).lineTo(px, hy + 1).stroke({ color: 0xff9ad0, width: 1, alpha: 0.8 });
        fx.circle(px - 1.4, hy + 2.4, 1.7).fill({ color: 0xff7ab8, alpha: 0.95 });
        fx.circle(px + 1.4, hy + 2.4, 1.7).fill({ color: 0xff7ab8, alpha: 0.95 });
        fx.moveTo(px - 3, hy + 3).lineTo(px, hy + 6.5).lineTo(px + 3, hy + 3)
          .stroke({ color: 0xff7ab8, width: 2.4, alpha: 0.95 });
      }
      // 공포: 머리 위에서 떨리는 보라 느낌표
      if (fearedNow) {
        const hy = py - sp.height - 9;
        const jit = Math.sin(now * 0.03 + e.id * 3) * 1.4;
        fx.rect(px - 1.2 + jit, hy - 6, 2.4, 6).fill({ color: 0xb06ad0, alpha: 0.95 });
        fx.circle(px + jit, hy + 3, 1.4).fill({ color: 0xb06ad0, alpha: 0.95 });
      }
      // 수면: 머리 위로 떠오르는 Z (세 개가 시차를 두고 위로 흘러간다)
      if (asleepNow) {
        const hy = py - sp.height - 6;
        for (let k = 0; k < 3; k++) {
          const t = ((now * 0.0006 + k / 3) % 1);
          const zx = px + 5 + t * 7;
          const zy = hy - t * 13;
          const s = 2.4 + t * 1.6;
          const al = 0.85 * (1 - t);
          fx.moveTo(zx - s, zy - s).lineTo(zx + s, zy - s)
            .lineTo(zx - s, zy + s).lineTo(zx + s, zy + s)
            .stroke({ color: 0xdfe8ff, width: 1.4, alpha: al });
        }
      }
      // 약화: 발밑에서 아래로 처지는 보라 화살표
      if (weakenedNow && !asleepNow) {
        const wy = shadowY - 2 + Math.sin(now * 0.006 + e.id) * 1.2;
        fx.moveTo(px - 4, wy - 3).lineTo(px, wy + 2).lineTo(px + 4, wy - 3)
          .stroke({ color: 0xb06ad0, width: 1.6, alpha: 0.9 });
      }
      // 넥서스 보호막: 수호자가 살아 있는 동안 청록 방벽이 맥동한다
      if (shieldedNow) {
        const shim = 0.4 + 0.25 * Math.sin(now * 0.004);
        fx.ellipse(px, py - sp.height * 0.4, sp.width * 0.75, sp.height * 0.68)
          .stroke({ color: 0x7ad8ff, width: 2.5, alpha: shim });
      }
      // 군세강화: 머리 위 주황 이중 화살촉
      if (g.tick < e.atkBuffUntil && !confusedNow) {
        const hy = py - sp.height - 5;
        const bob = Math.sin(now * 0.008 + e.id) * 1.2;
        for (const o of [0, 4]) {
          fx.moveTo(px - 4, hy + o + bob).lineTo(px, hy + o - 4 + bob).lineTo(px + 4, hy + o + bob)
            .stroke({ color: 0xff9a3d, width: 1.6, alpha: 0.9 });
        }
      }
      // 숲의 가호: 발밑 연둣빛 점
      if (g.tick < e.forestUntil) {
        const tw = 0.5 + 0.4 * Math.sin(now * 0.006 + e.id * 2.3);
        fx.circle(px + 7, shadowY - 3, 1.6).fill({ color: 0x9fe86a, alpha: tw });
        fx.circle(px - 7, shadowY - 5, 1.3).fill({ color: 0x9fe86a, alpha: 1 - tw * 0.6 });
      }
      // 회복: 초록 플러스 떠오름
      if (now < vfx.healGlowUntil) {
        const t = 1 - (vfx.healGlowUntil - now) / 450;
        const hy = py - sp.height - 4 - t * 10;
        fx.rect(px - 1.2, hy - 4, 2.4, 8).fill({ color: 0x6fe87a, alpha: 0.9 * (1 - t) });
        fx.rect(px - 4, hy - 1.2, 8, 2.4).fill({ color: 0x6fe87a, alpha: 0.9 * (1 - t) });
      }
      // 속박: 발밑에 포획 실 링 표시
      if (g.tick < e.rootedUntil) {
        fx.ellipse(px, shadowY, 10, 4.5).stroke({ color: 0xf0f0f0, width: 1.5, alpha: 0.85 });
        fx.moveTo(px - 8, shadowY - 2).lineTo(px + 8, shadowY + 2).stroke({ color: 0xf0f0f0, width: 1, alpha: 0.6 });
        fx.moveTo(px - 8, shadowY + 2).lineTo(px + 8, shadowY - 2).stroke({ color: 0xf0f0f0, width: 1, alpha: 0.6 });
      }
      // 공격 애니메이션 재생. 업그레이드 스킨 중엔 스킨 전용 프레임을 사용.
      if (vfx.hasSkin) {
        const frames = skinAtkTex.get(e.defId);
        if (frames) {
          if (now < vfx.aimUntil && vfx.aimUntil > vfx.aimStart) {
            const prog = (now - vfx.aimStart) / (vfx.aimUntil - vfx.aimStart);
            const fi = Math.min(frames.length - 1, Math.floor(prog * frames.length));
            const want = frames[fi];
            if (want && sp.texture !== want) sp.texture = want;
          } else {
            const base = skinTex.get(e.defId);
            if (base && sp.texture !== base) sp.texture = base;
          }
        }
      } else if (now < vfx.skillUntil && vfx.skillUntil > vfx.skillStart && skillAnimTex.has(e.defId)) {
        // 스킬 시전 프레임 재생 (공격 모션보다 우선)
        const frames = skillAnimTex.get(e.defId)!;
        const prog = (now - vfx.skillStart) / (vfx.skillUntil - vfx.skillStart);
        const fi = Math.min(frames.length - 1, Math.floor(prog * frames.length));
        const want = frames[fi];
        if (want && sp.texture !== want) sp.texture = want;
      } else {
        const atkVariants = (vfx.atkAir ? airAttackTex.get(e.defId) : undefined) ?? attackTex.get(e.defId);
        if (atkVariants) {
          const baseVariants = assetTex.get(e.defId);
          const vi = e.id % (baseVariants?.length ?? atkVariants.length);
          if (now < vfx.aimUntil && vfx.aimUntil > vfx.aimStart) {
            const frames = atkVariants[vi % atkVariants.length]!;
            const prog = (now - vfx.aimStart) / (vfx.aimUntil - vfx.aimStart);
            const fi = Math.min(frames.length - 1, Math.floor(prog * frames.length));
            const want = frames[fi];
            if (want && sp.texture !== want) sp.texture = want;
          } else if (!flapTex.has(e.defId)) {
            // 부유 프레임 보유 유닛의 평시 텍스처는 부유 로직이 관리한다
            const want = baseVariants?.[vi];
            if (want && sp.texture !== want) sp.texture = want;
          }
        }
        // 이동 방향별 그림: 공격 애니 중이 아닐 때 바라보는 방향으로 스왑
        const dt = dirTex.get(dirKey);
        if (dt && !(now < vfx.aimUntil)) {
          const face = vfx.faceDir;
          const want = face === 'w' ? dt.w : face === 'n' ? dt.n : face === 's' ? dt.s : dt.e;
          const pick2 = want ?? assetTex.get(e.defId)?.[0];
          if (pick2 && sp.texture !== pick2) sp.texture = pick2;
          // 방향 그림 유닛은 좌우 반전을 쓰지 않는다 (그림이 이미 그 방향을 본다)
          if (sp.scale.x < 0) sp.scale.x = -sp.scale.x;
        } else if (dt && now < vfx.aimUntil) {
          // 공격 중엔 동향 프레임 재생 — 서쪽을 보고 있었다면 반전으로 맞춘다
          const flip = vfx.faceDir === 'w';
          const ax = Math.abs(sp.scale.x);
          sp.scale.x = flip ? -ax : ax;
        }
      }

      const on = px > camX - 60 && px < camX + visibleW() + 60;
      sp.visible = on;
      if (!on) continue;

      // 그림자
      const rw = Math.max(6, (d.radius / FP) * TILE * 1.6);
      shadows.ellipse(sx(ix), shadowY - 1, rw, rw * 0.42).fill({ color: 0x3a2a18, alpha: d.flying ? 0.2 : 0.32 });
      // 선택 링
      if (e.id === selectedId) {
        fx.ellipse(sx(ix), shadowY - 1, rw + 4, (rw + 4) * 0.42).stroke({ color: 0xffe98a, width: 2 });
      }

      // 체력바
      const isStruct = d.tier === 'structure';
      if ((e.hp < d.maxHp || isStruct) && !propInvuln) {
        const w = isStruct ? 40 : 18;
        // 업그레이드로 최대 체력이 늘어난 유닛은 유효 정의 기준으로 비율 계산
        const maxHp = e.defOv?.maxHp ?? d.maxHp;
        const hpr = Math.min(1, Math.max(0, e.hp / maxHp));
        const bx = px - w / 2;
        const by = py - sp.height - 5;
        bars.rect(bx, by, w, 3.5).fill({ color: 0x120d08, alpha: 0.85 });
        bars.rect(bx, by, w * hpr, 3.5).fill(hpr > 0.5 ? 0x6fce62 : hpr > 0.25 ? 0xe0b840 : 0xe0524a);
      }
    }

    // ── 사망 처리: 사라진 유닛 → 시체 연출 ──
    for (const [id, sp] of sprites) {
      if (seen.has(id)) continue;
      const deadDefId = spriteDefId.get(id);
      // 구조물 파괴는 별도 이벤트(towerDown)로 처리하므로 여기선 유닛만
      if (deadDefId && DEFS[deadDefId]?.tier !== 'structure') {
        sfx(deathKeyOf(deadDefId, id), sp.x, deadDefId === 'm_alice' ? 0.9 : 0.45);
      }
      sprites.delete(id);
      spriteTeam.delete(id);
      charmedIds.delete(id);
      skinnedStructures.delete(id);
      spriteDefId.delete(id);
      prevPos.delete(id);
      unitFx.delete(id);
      // 구조물은 그냥 제거, 유닛은 쓰러지는 시체로 전환
      units.removeChild(sp);
      corpseLayer.addChild(sp);
      sp.rotation = sp.scale.x >= 0 ? Math.PI / 2 : -Math.PI / 2;
      sp.tint = 0xb8b8b8;
      corpses.push({ sp, start: now });
    }
    // 시체 페이드아웃 (1.6초)
    for (let i = corpses.length - 1; i >= 0; i--) {
      const c = corpses[i]!;
      const t = (now - c.start) / 1600;
      if (t >= 1) {
        c.sp.destroy();
        corpses.splice(i, 1);
      } else {
        c.sp.alpha = 1 - t * t;
      }
    }

    // ── 투사체 ──
    // 스프라이트는 매 프레임 만들지 않고 풀에서 재사용한다 (교전 중 수십 발이 동시에 난다)
    let projUsed = 0;
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i]!;
      const t = (now - p.start) / p.dur;
      if (t >= 1) {
        impacts.push({ x: p.x1, y: p.y1, start: now, radius: p.splash > 0 ? p.splash : 7, color: p.color });
        // 광역 투사체만 폭발음 (단발 착탄은 피격음으로 충분 — 소리 과밀 방지)
        if (p.splash > 0) sfx('explosion', p.x1, 0.7);
        projectiles.splice(i, 1);
        continue;
      }
      const cx = p.x0 + (p.x1 - p.x0) * t;
      // 살짝 포물선
      const arc = Math.sin(t * Math.PI) * 9;
      const cy = p.y0 + (p.y1 - p.y0) * t - arc;
      const ang = Math.atan2(p.y1 - p.y0, p.x1 - p.x0);

      const tex = p.kind ? projTex.get(p.kind) : undefined;
      if (tex && p.kind) {
        // 스프라이트 탄: 이번 프레임에 쓸 것만 풀에서 꺼내 쓴다
        const style = PROJECTILE_STYLE[p.kind];
        const sp = projPool[projUsed] ?? (() => {
          const s = new Sprite();
          s.anchor.set(0.5);
          projLayer.addChild(s);
          projPool.push(s);
          return s;
        })();
        projUsed++;
        if (sp.texture !== tex) sp.texture = tex;
        sp.visible = true;
        sp.x = cx;
        sp.y = cy;
        sp.scale.set(style.size / tex.width);
        // 화살·탄환은 날아가는 방향으로, 뼈·폭탄은 빙글빙글
        // 왼쪽으로 날아갈 땐 좌우로 뒤집어 그림이 거꾸로 서지 않게 한다.
        const leftward = style.rotate && Math.abs(ang) > Math.PI / 2;
        if (style.rotate) {
          sp.rotation = leftward ? ang + Math.PI + (style.aim ?? 0) : ang - (style.aim ?? 0);
        } else {
          sp.rotation = p.spin0 + (style.spin ?? 0) * (now - p.start);
        }
        sp.scale.x = Math.abs(sp.scale.x) * (leftward ? -1 : 1);
      } else {
        const lx = Math.cos(ang) * 4, ly = Math.sin(ang) * 4;
        fx.moveTo(cx - lx, cy - ly).lineTo(cx + lx, cy + ly).stroke({ color: p.color, width: 2 });
      }
    }
    // 이번 프레임에 안 쓴 풀 스프라이트는 숨긴다
    for (let i = projUsed; i < projPool.length; i++) projPool[i]!.visible = false;
    // ── 임팩트 링 (220ms) ──
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i]!;
      const t = (now - im.start) / 220;
      if (t >= 1) {
        impacts.splice(i, 1);
        continue;
      }
      if (t < 0) continue; // 예약된 2차 충격파 (수호자 이중 링) — 아직 시작 전
      fx.circle(im.x, im.y, im.radius * (0.4 + t * 0.6)).stroke({ color: im.color, width: 2, alpha: 1 - t });
    }
    // ── 내리꽂기 착지 흙먼지: 사방으로 튀는 파편 (420ms) ──
    for (let i = diveDusts.length - 1; i >= 0; i--) {
      const du = diveDusts[i]!;
      const t = (now - du.start) / 420;
      if (t >= 1) {
        diveDusts.splice(i, 1);
        continue;
      }
      if (t < 0) continue;
      const ease = 1 - (1 - t) * (1 - t); // 빠르게 퍼졌다 느려짐
      for (let k = 0; k < 10; k++) {
        const ang = (k / 10) * Math.PI * 2 + du.r * 0.03;
        const dist = du.r * (0.25 + ease * 0.95);
        const hop = Math.sin(t * Math.PI) * 9; // 튀어올랐다 떨어지는 포물선
        fx.circle(
          du.x + Math.cos(ang) * dist,
          du.y + Math.sin(ang) * dist * 0.5 - hop,
          3.2 * (1 - t) + 0.8,
        ).fill({ color: k % 3 === 0 ? 0xe8d0a8 : 0xb08c5a, alpha: (1 - t) * 0.85 });
      }
    }
  }

  let enemySkin: 'toy' | 'bone' | null = null;
  /** 호위전 거점 상태 (setEscort 로 매 프레임 갱신). */
  let escortCfg: {
    pointsX: readonly number[]; radius: number;
    frontier: number; progress01: number; contested: boolean;
  } | null = null;
  /** 거점 깃발 라벨 (거점 수만큼 lazy 생성). */
  let escortLabels: Text[] = [];
  return {
    app,
    setEnemySkin(skin) {
      enemySkin = skin;
    },
    setEscort(cfg) {
      escortCfg = cfg;
      if (!cfg && escortLabels.length > 0) {
        for (const t of escortLabels) t.destroy();
        escortLabels = [];
      }
    },
    setMap(m) {
      curMap = m;
      app.renderer.background.color = MAP_BG[m.id] ?? 0x9c7c4e;
      buildGroundTiles();
      drawGround(ground, tiled());
      buildMapDecos();
      rebuildClouds();
      // 합류점 맵: 위 갈래 끝에 앨리스의 성(장난감 넥서스 그림)을 세워 둔다
      if (allyBaseSp) { allyBaseSp.destroy(); allyBaseSp = null; }
      const br = m.branches?.[0];
      if (m.id === 'confluence' && br) {
        const t = assetTex.get('nexus_toy')?.[0];
        if (t) {
          allyBaseSp = new Sprite(t);
          allyBaseSp.anchor.set(0.5, 1);
          allyBaseSp.scale.set((TILE * 3.4) / t.width);
          allyBaseSp.x = sx(br.x);
          allyBaseSp.y = sy(br.y0) + 10;
          zoneLayer.addChild(allyBaseSp);
        }
      }
      camX = 0;
      camY = 0;
      clampCam();
    },
    beforeStep(g) {
      // 스텝 전 위치를 저장해 두면 draw()가 prev→current 를 alpha 로 보간한다.
      // (매 프레임이 아니라 스텝 직전에만 갱신해야 20Hz 계단 현상이 없다)
      for (const e of g.entities) {
        if (e.alive) prevPos.set(e.id, { x: e.x, y: e.y });
      }
    },
    draw,
    panBy(dx, dy = 0) {
      camX += dx / zoom;
      camY += dy / zoom;
      clampCam();
    },
    centerOn(x, y) {
      applyCamera(); // 첫 호출 시 줌이 아직 fit 계산 전일 수 있어 먼저 확정
      camX = x - visibleW() / 2;
      if (y !== undefined) camY = y - visibleH() / 2;
      clampCam();
    },
    zoomBy(factor, anchorX, anchorY) {
      const ax = anchorX ?? app.screen.width / 2;
      const ay = anchorY ?? app.screen.height / 2;
      const wx = (ax - world.x) / zoom;
      const wy = (ay - world.y) / zoom;
      userZoom = Math.min(USER_ZOOM_MAX, Math.max(USER_ZOOM_MIN, userZoom * factor));
      applyCamera();
      camX = wx - ax / zoom;
      camY = wy - ay / zoom;
      clampCam();
    },
    view() {
      return { x0: camX, x1: camX + visibleW(), y0: camY, y1: camY + visibleH() };
    },
    pick(g, screenX, screenY) {
      // 화면 → 월드 px 역변환 후 발밑 기준 최근접 탐색
      const wx = (screenX - world.x) / zoom;
      const wy = (screenY - world.y) / zoom;
      let best: number | null = null;
      let bestD = 26 * 26; // 최대 26px 반경
      for (const e of g.entities) {
        if (!e.alive) continue;
        const d = DEFS[e.defId]!;
        const px = sx(e.x);
        const py = sy(e.y) - (d.flying ? 26 : 0) - 8; // 몸통 중심 근사
        const dx = px - wx;
        const dy = py - wy;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = e.id;
        }
      }
      return best;
    },
    setSelected(id) {
      selectedId = id;
    },
    setAudio(a) {
      audio = a;
    },
  };
}

function drawGround(gr: Graphics, tiled = false): void {
  gr.clear();
  const m = curMap;
  const tilesX = m.length / FP;
  const halfH = renderHalfH(m);
  const tilesY = Math.ceil((halfH * 2) / FP);
  const th = TILE * Y_SQUASH;
  const laneHalfTiles = m.halfW / FP;

  // 코리도어 밖 = 암반, 안 = 모래 체커. 열 단위로 중앙선을 따라간다.
  // (tiled = 픽셀 타일이 깔린 경우: 베이스는 생략하고 진영 틴트·중앙선만 오버레이)
  for (let i = 0; i < tilesX; i++) {
    const cx = i * FP + 500; // 타일 중심 x (FP)
    const centerTileY = (laneCenterY(m, cx) + halfH) / FP; // 타일 좌표계 중심
    if (!tiled) {
      for (let j = 0; j < tilesY; j++) {
        const inLane = Math.abs(j + 0.5 - centerTileY) <= laneHalfTiles;
        if (inLane) {
          const even = (i + j) % 2 === 0;
          gr.rect(i * TILE, PAD_TOP + j * th, TILE, th).fill(even ? 0xcfae70 : 0xc7a566);
          if ((i * 7 + j * 13) % 5 === 0) {
            gr.rect(i * TILE + ((i * 11) % 18) + 3, PAD_TOP + j * th + ((j * 7) % 14) + 3, 3, 2)
              .fill({ color: 0xb8955a, alpha: 0.7 });
          }
        } else {
          // 절벽/암반 지대
          const even = (i * 3 + j) % 2 === 0;
          gr.rect(i * TILE, PAD_TOP + j * th, TILE, th).fill(even ? 0x6e5638 : 0x645034);
        }
      }
    }
    // 진영 바닥 표시 (코리도어 안에서만)
    const tint = i * FP < m.towerX[0] ? 0x5788cc : i * FP >= m.towerX[1] ? 0xcc6a57 : 0;
    if (tint !== 0) {
      const top = (centerTileY - laneHalfTiles) * th;
      gr.rect(i * TILE, PAD_TOP + top, TILE, laneHalfTiles * 2 * th).fill({ color: tint, alpha: 0.06 });
    }
  }
  // 중앙선
  gr.rect(worldW() / 2 - 1, PAD_TOP, 2, tilesY * th).fill({ color: 0x8a6c42, alpha: 0.5 });
}

export { sx as worldToPxX };
