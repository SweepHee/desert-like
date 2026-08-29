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
  TilingSprite,
} from 'pixi.js';
import {
  DEFS, FP, MAPS, DEFAULT_MAP, laneCenterY, laneHalfWAt, mapHalfH, tiles,
  type Game, type MapDef,
} from '@desertlike/sim';
import { artOf } from './sprites.ts';
import { MAP_DECO, MAP_PROPS, MAP_WATER_SPANS, decoAt, inWaterSpan } from './mapdeco.ts';
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

/**
 * 렌더 기준 맵 반높이 (시뮬 반높이 + 바깥 지형 여백).
 *
 * 배경 그림 한 장을 까는 맵(bgImage)은 여백이 필요 없다 — 그릴 바깥 지형이
 * 애초에 없어서, 여백만큼 갈색 배경이 그대로 드러났다 (5·6라운드).
 */
function renderHalfH(m: MapDef = curMap): number {
  return mapHalfH(m) + (m.bgImage ? 0 : EDGE_MARGIN);
}

/** 시뮬 y 좌표(FP) → 월드 픽셀 y (미니맵 점프용). */
export function worldYOf(yFP: number): number {
  const sq = curMap.vertical ? 1 : Y_SQUASH;
  return ((yFP + renderHalfH()) / FP) * TILE * sq + PAD_TOP;
}

/** worldYOf 의 역변환: 월드 픽셀 y → FP y (미니맵 뷰포트 표시용). */
export function worldYToFP(wy: number): number {
  const sq = curMap.vertical ? 1 : Y_SQUASH;
  return Math.floor(((wy - PAD_TOP) / (TILE * sq)) * FP) - renderHalfH();
}

/** 월드 픽셀 크기 (줌 적용 전, 현재 맵 기준). */
export function worldW(): number {
  return (curMap.length / FP) * TILE;
}
export function worldH(): number {
  const sq = curMap.vertical ? 1 : Y_SQUASH;
  return ((renderHalfH() * 2) / FP) * TILE * sq + PAD_TOP + PAD_BOTTOM;
}

/**
 * 픽셀랩 등 외부 에셋으로 교체된 유닛. 없으면 절차 생성 스프라이트 사용.
 * 배열이면 외형 변형(variant) — 유닛 id 로 결정론적으로 배정된다.
 * (예: 엘프 궁수는 생산 시 여/남 50:50 — docs/races/sylvarin.md)
 */
export const ASSET_UNITS: Record<string, string | string[]> = {
  // ⛏ 엘프 광부 (15 금광 고원)
  c_elf_miner: '/assets/units/c_elf_miner.png',
  // 🏜️ 카르자 (캠페인 전용) — packages/client/tools/fetch_karja.mjs 가 받아 온다
  k_scimitar: '/assets/units/k_scimitar.png',
  k_hunter: '/assets/units/k_hunter.png',
  k_wolf: '/assets/units/k_wolf.png',
  k_wolfrider: '/assets/units/k_wolfrider.png',
  k_apprentice: '/assets/units/k_apprentice.png',
  k_tribal: '/assets/units/k_tribal.png',
  k_shaman: '/assets/units/k_shaman.png',
  k_spiritcaller: '/assets/units/k_spiritcaller.png',
  k_highlander: '/assets/units/k_highlander.png',
  k_sandgiant: '/assets/units/k_sandgiant.png',
  k_falconer: '/assets/units/k_falconer.png',
  k_eagle: '/assets/units/k_eagle.png',
  k_beeswarm: '/assets/units/k_beeswarm.png',
  k_sandwraith: '/assets/units/k_sandwraith.png',
  k_grandshaman: '/assets/units/k_grandshaman.png',
  k_totem: '/assets/units/k_totem.png',
  k_falcon: '/assets/units/k_falcon.png',
  k_spirit: '/assets/units/k_spirit.png',
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
  c_alice_hero: '/assets/units/m_alice.png',
  m_grandfather_clock: '/assets/units/m_grandfather_clock.png',
  m_pennywise: '/assets/units/m_pennywise.png',
  m_thread_needle: '/assets/units/m_thread_needle.png',
  m_clocktower_gear: '/assets/units/m_clocktower_gear.png',
  p_deadman: '/assets/units/p_deadman.png',
  p_skeleton: '/assets/units/p_skeleton.png',
  p_hound: '/assets/units/p_hound.png',
  p_bone_thrower: '/assets/units/p_bone_thrower.png',
  p_headless_knight: '/assets/units/p_headless_knight.png',
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
  c_rotting_corpse: '/assets/units/c_rotting_corpse.png',
  c_villager_child_m: '/assets/units/c_villager_child_m.png',
  c_villager_child_f: '/assets/units/c_villager_child_f.png',
  c_villager_adult_m: '/assets/units/c_villager_adult_m.png',
  c_villager_adult_f: '/assets/units/c_villager_adult_f.png',
  c_villager_elder_m: '/assets/units/c_villager_elder_m.png',
  c_villager_elder_f: '/assets/units/c_villager_elder_f.png',
  c_village_a: '/assets/tiles/vg_house_a.png',
  c_village_b: '/assets/tiles/vg_house_b.png',
  c_village_c: '/assets/tiles/vg_house_c.png',
  c_village_d: '/assets/tiles/vg_house_d.png',
  c_mad_ballerina: '/assets/units/m_puppet_ann.png',
  c_bone_colossus: '/assets/units/p_corpse_golem.png',
  // 라다만토스: 디멘터를 그대로 키운 것 — 같은 그림에 크기만 크게
  c_radamanthus: '/assets/units/p_dementor.png',
  // 공허 강령술사: 스켈레톤 소환사를 그대로 키운 것
  c_void_necromancer: '/assets/units/p_summoner.png',
  c_dread_gargoyle: '/assets/units/p_demilich.png',
  c_kurga: '/assets/units/p_lich.png',
  c_mammon_lord: '/assets/units/p_mammon.png',
  c_balthar: '/assets/units/p_demilich.png',
  // 구조물·수호자 (종족 무관)
  nexus: '/assets/units/nexus.png?v=2',
  tower: '/assets/units/tower.png?v=2',
  dragon: '/assets/units/dragon.png',
  hollow: '/assets/units/hollow.png',
  // 판데모니엄 확장 로스터 (v1.1)
  p_bone_dragon: '/assets/units/p_bone_dragon.png',
  p_coffin_bearer: '/assets/units/p_coffin_bearer.png',
  p_succubus: '/assets/units/p_succubus.png',
  p_succubus_demon: '/assets/units/p_succubus_demon.png',
  p_dream_mare: '/assets/units/p_dream_mare.png',
  p_incubus: '/assets/units/p_incubus.png',
  p_dementor: '/assets/units/p_dementor.png',
  s_dryad: '/assets/units/s_dryad.png',
  s_elurion: '/assets/units/s_elurion.png',
  s_oberon: '/assets/units/s_oberon.png',
  c_grave_warden: '/assets/units/p_thanatos.png', // 타나토스와 같은 모습
  c_bone_grave: '/assets/units/c_bone_grave.png',
  m_ballista: '/assets/units/m_ballista.png',
  m_white_rabbit: '/assets/units/m_white_rabbit.png',
  m_mad_hatter: '/assets/units/m_mad_hatter.png',
  // 「모자 바꾸기」로 실제로 갈아쓰는 모자들
  m_mad_hatter_red: '/assets/units/m_mad_hatter_red.png',
  m_mad_hatter_blue: '/assets/units/m_mad_hatter_blue.png',
  m_mad_hatter_gold: '/assets/units/m_mad_hatter_gold.png',
  m_drosselmeyer: '/assets/units/m_drosselmeyer.png',
  m_nutcracker: '/assets/units/m_nutcracker.png',
  teddy_guardian: '/assets/units/teddy_guardian.png',
  // 장난감 나라(toybox) 전용 건물 스킨 — 스프라이트 생성 시 맵으로 갈린다
  tower_toy: '/assets/units/tower_toy.png?v=2',
  nexus_toy: '/assets/units/nexus_toy.png?v=2',
  // 사령(판데모니엄) 건물 스킨 — 캠페인 enemySkin: 'bone'
  tower_bone: '/assets/units/tower_bone.png',
  nexus_bone: '/assets/units/nexus_bone.png?v=2',
  // 마몬의 상점 (캠페인 점령 오브젝트 — 전투 개입 없음, 그림+점령 표시만)
  mercshop: '/assets/units/mercshop.png',
  // 호위전(13) 소품 — 보급 마차 + 불타는 숲 장애물
  c_supply_cart: '/assets/units/c_supply_cart.png',
  // 앨리스의 지원 병력 (13) — 원본 마리오네타 유닛 그림을 그대로 쓴다
  c_alice_soldier: '/assets/units/m_clockwork_soldier.png',
  c_alice_teddy: '/assets/units/m_gore_teddy.png',
  c_elowyn: '/assets/units/s_sage.png',
  c_evergreen: '/assets/units/c_evergreen.png',
  c_kael: '/assets/units/c_kael.png',
  c_bone_cannon: '/assets/units/c_bone_cannon.png',
  c_sage_watchtower: '/assets/units/c_sage_watchtower.png',
  c_sage_watchtower_s: '/assets/units/c_sage_watchtower_s.png',
  // 실바린 야영지 넥서스 (캠페인 14) — 큰 엘프 천막
  nexus_elfcamp: '/assets/units/nexus_elfcamp.png',
  // 적 주둔지 (캠페인 14) — 부술 수 있는 거점 건물
  // 네 변형이 id 로 배정돼 거점마다 조금씩 다르게 보인다
  c_demon_camp: ['/assets/units/c_demon_camp.png', '/assets/units/c_demon_camp2.png',
    '/assets/units/c_demon_camp3.png', '/assets/units/c_demon_camp4.png'],
  c_sylvarin_tent: '/assets/units/c_sylvarin_tent.png?v=2',
  c_sylvarin_tent2: '/assets/units/c_sylvarin_tent2.png',
  c_camp_fire: '/assets/units/c_camp_fire.png',
  c_camp_crates: '/assets/units/c_camp_crates.png',
  c_sylvarin_banner: '/assets/units/c_sylvarin_banner.png',
  c_burning_tree: '/assets/units/c_burning_tree.png',
  c_ember_tree: '/assets/units/c_ember_tree.png',
  // 잿불 숲 바깥 지형 장식 (심에는 없는 순수 그림)
  c_green_tree: '/assets/units/c_green_tree.png',
  c_green_bush: '/assets/units/c_green_bush.png',
  c_mossy_rock: '/assets/units/c_mossy_rock.png',
  c_wildflowers: '/assets/units/c_wildflowers.png',
  c_ember_tree2: '/assets/units/c_ember_tree2.png',
  c_burning_log: '/assets/units/c_burning_log.png',
  // 둥지 (11스테이지) — nest 맵의 아군 넥서스 스킨
  nexus_nest: '/assets/units/nexus_nest.png?v=2',
  // 잿길 (13스테이지) — 아군은 세계수 수정이 선 실바린 본영, 적은 악마 요새
  nexus_forestcamp: '/assets/units/nexus_forestcamp.png',
  // 올빼미 성채(5): 우리는 올빼미 둥지 요새, 적은 뼈 야영지 — 둘 다 언덕 위
  nexus_owlnest: '/assets/units/nexus_owlnest.png',
  nexus_bonecamp: '/assets/units/nexus_bonecamp.png',
  nexus_demon: '/assets/units/nexus_demon.png',
  // 잿불 숲 우측(2팀) — 불에 탄 숲 쪽 진영. 좌측은 기본 그림을 그대로 쓴다.
  nexus_ash: '/assets/units/nexus_ash.png',
  tower_ash: '/assets/units/tower_ash.png',
  // 12스테이지 보스 — 발타르의 선봉장
  c_balthar_general: '/assets/units/c_balthar_general.png',
  c_ghoul_lord: '/assets/units/p_minion_ghoul.png',
  c_elf_watchtower: '/assets/units/c_elf_watchtower.png',
  c_skullrender: '/assets/units/p_bone_dragon.png',
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
  c_elf_miner: '/assets/units/c_elf_miner_icon.png',
  // 🏜️ 카르자 — 상점 아이콘(정면)
  k_scimitar: '/assets/units/k_scimitar_icon.png',
  k_hunter: '/assets/units/k_hunter_icon.png',
  k_wolf: '/assets/units/k_wolf_icon.png',
  k_wolfrider: '/assets/units/k_wolfrider_icon.png',
  k_apprentice: '/assets/units/k_apprentice_icon.png',
  k_tribal: '/assets/units/k_tribal_icon.png',
  k_shaman: '/assets/units/k_shaman_icon.png',
  k_spiritcaller: '/assets/units/k_spiritcaller_icon.png',
  k_highlander: '/assets/units/k_highlander_icon.png',
  k_sandgiant: '/assets/units/k_sandgiant_icon.png',
  k_falconer: '/assets/units/k_falconer_icon.png',
  k_eagle: '/assets/units/k_eagle_icon.png',
  k_beeswarm: '/assets/units/k_beeswarm_icon.png',
  k_sandwraith: '/assets/units/k_sandwraith_icon.png',
  k_grandshaman: '/assets/units/k_grandshaman_icon.png',
  k_totem: '/assets/units/k_totem_icon.png',
  k_falcon: '/assets/units/k_falcon_icon.png',
  k_spirit: '/assets/units/k_spirit_icon.png',
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
  c_evergreen: '/assets/units/c_evergreen_icon.png',
  c_kael: '/assets/units/c_kael_icon.png',
  c_bone_cannon: '/assets/units/c_bone_cannon_icon.png',
  m_plushbear: '/assets/units/m_plushbear_icon.png',
  p_bone_dragon: '/assets/units/p_bone_dragon.png',
  p_coffin_bearer: '/assets/units/p_coffin_bearer_icon.png',
  p_succubus: '/assets/units/p_succubus_icon.png',
  p_incubus: '/assets/units/p_incubus_icon.png',
  p_dementor: '/assets/units/p_dementor_icon.png',
  c_radamanthus: '/assets/units/p_dementor_icon.png',
  c_void_necromancer: '/assets/units/p_summoner_icon.png',
  s_dryad: '/assets/units/s_dryad_icon.png',
  s_elurion: '/assets/units/s_elurion_icon.png',
  s_oberon: '/assets/units/s_oberon_icon.png',
  c_grave_warden: '/assets/units/p_thanatos_icon.png',
  m_ballista: '/assets/units/m_ballista_icon.png',
  m_white_rabbit: '/assets/units/m_white_rabbit_icon.png',
  m_mad_hatter: '/assets/units/m_mad_hatter_icon.png',
  m_drosselmeyer: '/assets/units/m_drosselmeyer_icon.png',
  m_nutcracker: '/assets/units/m_nutcracker_icon.png',
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
  c_alice_hero: '/assets/units/m_alice_icon.png',
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
// ?v= 캐시버스터: 스프라이트를 새로 뽑아 교체해도 브라우저가 옛 그림을 붙들지 않게.
// 방향 그림(_e/_w/_n/_s)에만 있었고 프레임 계열엔 없어서, 망령 공격 모션을 바꿔도
// 옛 로브 모습이 그대로 보이는 일이 있었다.
const atk4 = (id: string): string[][] => [[0, 1, 2, 3].map((n) => `/assets/units/${id}_atk${n}.png?v=7`)];

/**
 * 이동 방향별 그림을 보유한 유닛. `<defId>_e/_w/_n/_s.png` 4장이 모두 있어야
 * 등록된다 (하나라도 빠지면 기존 좌우 반전 방식 유지).
 * 엘프 궁수는 여/남 변형이라 제외 — 변형과 방향을 함께 다루려면 별도 작업 필요.
 */
const DIR_SPRITE_UNITS: string[] = [
  'c_evergreen',
  'c_kael',
  // 마을 주민 — 상하좌우 그림이 다 있다 (없으면 좌우 반전이라 위/아래가 어색하다)
  'c_villager_child_m', 'c_villager_child_f', 'c_villager_adult_m',
  'c_villager_adult_f', 'c_villager_elder_m', 'c_villager_elder_f',
  's_gouto', 's_vine_hunter', 's_marmot', 's_druid', 's_mushroom_bomber',
  's_owl', 's_butterfly', 's_thorn_witch', 's_treekeeper', 's_apostle',
  's_treant', 's_marksman', 's_sage', 's_wyvern', 's_unicorn', 's_fairy',
  'p_deadman', 'p_skeleton', 'p_hound', 'p_bone_thrower', 'p_headless_knight',
  'p_banshee', 'p_thanatos', 'p_corpse_golem', 'p_wraith',
  'p_summoner', 'p_lich', 'p_demilich', 'p_mammon',
  'p_dementor',
  's_dryad', 's_elurion', 's_oberon',
  'm_ballista', 'm_white_rabbit', 'm_mad_hatter', 'm_drosselmeyer', 'm_nutcracker',
  'p_minion_ghoul', 'p_minion_undead', 'p_minion_skeleton', 'p_minion_rat',
  'm_plushbear', 'm_clockwork_soldier', 'm_button_doll', 'm_puppet_swordsman',
  'm_clockwork_spider', 'm_clown_doll', 'm_cursed_doll', 'm_casper',
  'm_puppet_ann', 'm_specter_teddy', 'm_grandfather_clock', 'm_pennywise',
  'm_thread_needle', 'm_clocktower_gear', 'm_gore_teddy', 'm_alice', 'c_alice_hero',
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
  // 갑옷 마멋: 망치는 하늘에 닿지 않으니 공중엔 새총을 쏜다
  s_marmot: [[0, 1, 2, 3].map((n) => `/assets/units/s_marmot_air${n}.png?v=7`)],
};

const ASSET_ATTACK_ANIMS: Record<string, string[][]> = {
  // ⛏ 광부는 「공격」 자리에 곡괭이질을 넣는다 — 갱에 서면 계속 캐는 것처럼 보인다
  c_elf_miner: atk4('c_elf_miner'),
  // 🏜️ 카르자 — 유닛마다 제 무기 동작 (east 4프레임, fetch_karja.mjs 가 굽는다)
  k_scimitar: atk4('k_scimitar'),
  k_hunter: atk4('k_hunter'),
  k_wolf: atk4('k_wolf'),
  k_wolfrider: atk4('k_wolfrider'),
  k_apprentice: atk4('k_apprentice'),
  k_tribal: atk4('k_tribal'),
  k_shaman: atk4('k_shaman'),
  k_spiritcaller: atk4('k_spiritcaller'),
  k_highlander: atk4('k_highlander'),
  k_sandgiant: atk4('k_sandgiant'),
  k_falconer: atk4('k_falconer'),
  k_sandwraith: atk4('k_sandwraith'),
  k_grandshaman: atk4('k_grandshaman'),
  // 엘프 궁수: 변형(여/남)별 4프레임 발사 모션 (화살 뽑기→시위 당기기→발사)
  s_elf_archer: [
    [0, 1, 2, 3].map((n) => `/assets/units/s_elf_archer_f_atk${n}.png?v=7`),
    [0, 1, 2, 3].map((n) => `/assets/units/s_elf_archer_m_atk${n}.png?v=7`),
  ],
  // 에버그린: 활 들어올림 → 당김 → 최대 → 발사
  c_evergreen: atk4('c_evergreen'),
  // 카엘: 방패 들고 창 찌르기 4프레임
  c_kael: atk4('c_kael'),
  s_gouto: atk4('s_gouto'),
  m_plushbear: atk4('m_plushbear'),
  m_clockwork_spider: atk4('m_clockwork_spider'),
  m_clown_doll: atk4('m_clown_doll'),
  m_casper: atk4('m_casper'),
  m_specter_teddy: atk4('m_specter_teddy'),
  m_puppet_ann: atk4('m_puppet_ann'),
  s_marmot: atk4('s_marmot'),
  s_vine_hunter: atk4('s_vine_hunter'),
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
  m_clockwork_soldier: atk4('m_clockwork_soldier'),
  c_alice_soldier: atk4('m_clockwork_soldier'),
  c_alice_teddy: atk4('m_gore_teddy'),
  m_puppet_swordsman: atk4('m_puppet_swordsman'),
  m_cursed_doll: atk4('m_cursed_doll'),
  m_button_doll: atk4('m_button_doll'),
  m_alice: atk4('m_alice'),
  c_alice_hero: atk4('m_alice'),
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
  p_banshee: atk4('p_banshee'),
  p_thanatos: atk4('p_thanatos'),
  p_corpse_golem: atk4('p_corpse_golem'),
  p_wraith: atk4('p_wraith'),
  p_mammon: atk4('p_mammon'),
  p_summoner: atk4('p_summoner'),
  p_lich: atk4('p_lich'),
  p_demilich: atk4('p_demilich'),
  p_minion_ghoul: atk4('p_minion_ghoul'),
  c_ghoul_lord: atk4('p_minion_ghoul'),
  p_minion_undead: atk4('p_minion_undead'),
  p_minion_skeleton: atk4('p_minion_skeleton'),
  p_minion_rat: atk4('p_minion_rat'),
  // 수호자 (중간보스)
  dragon: atk4('dragon'),
  hollow: atk4('hollow'),
  p_bone_dragon: atk4('p_bone_dragon'),
  c_skullrender: atk4('p_bone_dragon'),
  s_elurion: atk4('s_elurion'),
  p_coffin_bearer: atk4('p_coffin_bearer'),
  p_succubus: atk4('p_succubus'),
  p_incubus: atk4('p_incubus'),
  teddy_guardian: atk4('teddy_guardian'),
  // 캠페인 특수 유닛 — 원본 유닛 모션 재활용
  c_ash_revenant: atk4('p_wraith'),
  c_rotting_corpse: atk4('c_rotting_corpse'),
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
type ProjKind = 'arrow' | 'bullet' | 'bone' | 'bolt_nature' | 'bolt_curse' | 'bomb' | 'pollen' | 'fireball' | 'heart';

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
  c_evergreen: 'arrow',
  c_bone_cannon: 'bolt_curse',
  // 판데모니엄
  p_bone_thrower: 'bone',
  p_banshee: 'bolt_curse',
  p_succubus: 'heart',
  p_dream_mare: 'bolt_curse',
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
  c_alice_hero: 'bolt_curse',
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
  heart: { size: 16, rotate: false, spin: 0.004 }, // 서큐버스 — 하트가 두근두근 날아간다
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
  c_rotting_corpse: 1.5,
  // 마을 집: 작가 그림(완성.png) 안에서 잰 폭에 맞춘 값 —
  // 기본 공식(반경 1.3 x2 x2.2 = 5.72타일)에 이걸 곱하면 그림과 같은 크기가 된다
  c_village_a: 1.54, c_village_b: 1.35, c_village_c: 1.26, c_village_d: 1.56,
  c_mad_ballerina: 1.4,
  c_bone_colossus: 1.9, c_radamanthus: 1.5, c_void_necromancer: 1.7,
  c_dread_gargoyle: 1.5,
  c_kurga: 1.7,
  c_mammon_lord: 1.6,
  c_balthar: 2.1,
  teddy_guardian: 1.25, // 수호자 위용 — radius 보정 위에 한 번 더
  c_nest_wyvern: 1.3, c_nest_unicorn: 1.3, c_nest_fairy: 1.3, // 둥지 수호탑 — 타워 위용
  c_wild_blackbird: 1.4, c_wild_grizzly: 1.2, c_wild_direwolf: 1.15,
  c_balthar_general: 1.5, // 12 보스 — 슬리피 할로우급 거구
  c_ghoul_lord: 1.5,      // 14 보스 — 카르가스급 덩치
  c_elf_watchtower: 1.25, // 야영지 망루 — 작은 망루라 아담하게
  c_skullrender: 2.175,   // 14 보스 — 기존 1.45의 정확히 1.5배
  // 호위전 소품: 나무는 반경보다 훨씬 크게 — 숲이 우거진 인상
  c_burning_tree: 1.35, c_ember_tree: 1.3, c_ember_tree2: 1.35, c_burning_log: 0.95, c_supply_cart: 1.15,
  s_fairy: 1.9, // 거대 나비(radius 0.42)보다 커 보이게 — 요정 여왕의 위용
  p_bone_dragon: 1.26, // 엘루리온과 같은 덩치로 (radius 가 달라 배율로 맞춘다) p_coffin_bearer: 1.15, p_succubus: 1.2, p_dream_mare: 1.15, p_incubus: 1.25,
  p_dementor: 1.45, // 리치보다 확실히 큰 실루엣 — 멀리서도 알아보게
  m_ballista: 1.0, m_drosselmeyer: 0.95, m_mad_hatter: 1.25, m_white_rabbit: 1.0, m_nutcracker: 0.95,
  c_grave_warden: 1.5, // 캠페인 엘리트 — 타나토스보다 크게
  c_bone_grave: 1.15,
  s_elurion: 0.98, s_oberon: 1.25, s_dryad: 1.2,

  c_sage_watchtower: 1.5, c_sage_watchtower_s: 1.15, c_sylvarin_tent: 1.2, c_elowyn: 1.25, c_evergreen: 1.25, c_kael: 1.3, c_bone_cannon: 1.5,
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

/**
 * 건물 스킨별 크기 보정. 넓게 퍼진 캠프 그림은 기본 넥서스보다 훨씬 커야
 * 「본거지」로 읽힌다 (기본값은 세로로 긴 탑 기준이라 캠프엔 작다).
 */
const SKIN_SIZE_MUL: Record<string, number> = {
  nexus_forestcamp: 2.1,
  nexus_demon: 1.9,
  /*
   * 언덕 상면을 채우되 맵 밖으로 나가지 않는 크기.
   *
   * 스프라이트는 바닥 중심 기준으로 위로 자라므로(anchor 0.5,1) 배율이 크면
   * 맵 위쪽 끝을 뚫는다. 적 언덕은 맵 꼭대기라 여유가 5.8타일뿐이다 —
   * 1.5 면 높이 약 8타일로 언덕 안에 들어온다 (2.3 은 12.3타일이라 넘쳤다).
   */
  nexus_owlnest: 1.5,
  nexus_bonecamp: 1.5,
};

interface GroundTheme {
  readonly sheet: string;
  /** 배치가 다른 시트를 쓰게 되면 여기서 덮어쓴다. */
  readonly wang: Record<number, readonly [number, number]>;
  /** 레인 밖에 흩뿌릴 소품 파일명 (assets/tiles/<name>.png). */
  readonly props: readonly string[];
  /** 레인 안(걷는 길)에 낮은 밀도로 깔 납작한 지면 장식. */
  readonly laneProps?: readonly string[];
  /** 길과 맞닿은 바깥 칸 전용 소품 (낮은 것만 — 길을 덮지 않는다). */
  readonly edgeProps?: readonly string[];
  /** 길 바로 아래(남쪽) 두세 칸 전용 — 큰 나무는 위로 뻗어 길을 가린다. */
  readonly midProps?: readonly string[];
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
  // 악마의 성 (캠페인 14 — 발타르의 성): 흑요석 마당에 핏빛 용암이 갈라져 흐른다
  hellstone: {
    sheet: '/assets/tiles/hellstone.png',
    wang: WANG_16,
    props: ['prop_necro_pillar', 'prop_skull2', 'prop_bones1', 'prop_necro_candles'],
    laneProps: ['lane_ash', 'lane_embers', 'lane_charred'],
  },
  // 숲길 (캠페인 13 — 잿길): 손그림 지형을 옮긴 Wang 흙길 + 침엽수림
  woodroad: {
    sheet: '/assets/tiles/woodroad.png',
    wang: WANG_16,
    props: [
      'wr_pine1', 'wr_pine2', 'wr_pine3', 'wr_pine4',
      'wr_pine1', 'wr_pine2', 'wr_pine3', 'wr_pine4',
      'wr_bush1', 'wr_bush2',
    ],
    // 길과 맞닿은 칸에는 키 큰 나무 대신 낮은 덤불·풀만 — 침엽수를 심으면
    // 가지가 길 위를 덮어 「지나갈 수 없는 길」처럼 보인다
    edgeProps: ['wr_bush1', 'wr_bush2', 'wr_grass1', 'wr_grass2', 'wr_grass3', 'wr_grass6'],
    // 길 남쪽 두세 칸: 스프라이트가 아래에서 위로 자라 길을 덮으므로 작은 나무만
    midProps: ['wr_pine4', 'wr_pine3', 'wr_bush1', 'wr_pine4', 'wr_bush2'],
    laneProps: ['wr_grass4', 'wr_pebble3', 'wr_pebble4', 'wr_leaf3', 'wr_leaf4', 'wr_pebble3'],
  },
  /**
   * 「걸어가는 숲」(14스테이지) 전용.
   *
   * 잿길(13)과 같은 woodroad 시트를 쓰다가, 14를 손보면 13 지형까지 같이
   * 바뀌는 사고가 났다. 파일을 갈라 두 스테이지가 서로 영향을 주지 않게 한다.
   */
  greatwood: {
    sheet: '/assets/tiles/greatwood.png',
    wang: WANG_16,
    props: [
      'wr_pine1', 'wr_pine2', 'wr_pine3', 'wr_pine4',
      'wr_pine1', 'wr_pine2', 'wr_pine3', 'wr_pine4',
      'wr_bush1', 'wr_bush2',
    ],
    edgeProps: ['wr_bush1', 'wr_bush2', 'wr_grass1', 'wr_grass2', 'wr_grass3', 'wr_grass6'],
    midProps: ['wr_pine4', 'wr_pine3', 'wr_bush1', 'wr_pine4', 'wr_bush2'],
    laneProps: ['wr_grass4', 'wr_pebble3', 'wr_pebble4', 'wr_leaf3', 'wr_leaf4', 'wr_pebble3'],
  },
  /**
   * 독 늪 (캠페인 4 — 독이 스민 숲): 진창 흙길 양옆이 형광 산성 늪이다.
   * 길(갈색)과 바깥(형광 초록)의 명도 차를 크게 잡았다 — 첫 판본은 둘 다
   * 올리브색이라 어디가 길인지 안 보였다.
   */
  mire: {
    sheet: '/assets/tiles/mire.png',
    wang: WANG_16,
    props: ['mire_deadtree', 'mire_deadtree', 'mire_shrooms', 'mire_log'],
    // 길과 맞닿은 칸엔 키 큰 고사목 대신 낮은 것만 (가지가 길을 덮는다)
    edgeProps: ['mire_shrooms', 'mire_log'],
    laneProps: ['lane_leaves', 'lane_charred', 'lane_leaves'],
  },
  /**
   * 올빼미 성채 (캠페인 5): 굽이치는 이끼 낀 판석길 + 검은 침엽수림.
   * 잿길(13)의 침엽수 소품을 그대로 쓴다 — 같은 숲이라 결이 이어진다.
   */
  owlkeep: {
    sheet: '/assets/tiles/owlkeep.png',
    wang: WANG_16,
    props: [
      'wr_pine1', 'wr_pine2', 'wr_pine3', 'wr_pine4',
      'wr_pine1', 'wr_pine2', 'wr_pine3', 'wr_pine4',
      'wr_bush1', 'wr_bush2',
    ],
    edgeProps: ['wr_bush1', 'wr_bush2', 'wr_grass1', 'wr_grass2', 'wr_grass3', 'wr_grass6'],
    midProps: ['wr_pine4', 'wr_pine3', 'wr_bush1', 'wr_pine4', 'wr_bush2'],
    laneProps: ['wr_grass4', 'wr_pebble3', 'wr_pebble4', 'wr_leaf3', 'wr_leaf4'],
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
  mire: ['mire'],       // 4 독이 스민 숲
  owlkeep: ['owlkeep'], // 5 올빼미 성채 (굽이치는 산길)
  ashroad: ['woodroad'], // 손그림 숲길 — Wang 흙길 위에 침엽수·바위를 심는다
  greatroot: ['greatwood'], // 14 전용 시트 (13 과 파일을 나눠 서로 안 건드린다)
};

/**
 * 절벽(높낮이)을 그리는 맵.
 * 숲·바위를 높은 땅으로 보고, 길·물과 맞닿은 「화면 아래쪽」 가장자리에 벽면을 세운다.
 * 길이 바위를 깎아 낸 것처럼 보여 평평하던 지형에 깊이가 생긴다.
 */
/**
 * 계단식 지형 — 진행축(x) 위의 단 경계들.
 *
 * 아래(우리 진영)에서 위(적 진영)로 갈수록 한 단씩 높아진다. 경계마다 절벽 벽면을
 * 세우고, 길·물이 지나는 자리는 비워 비탈길이 되게 한다.
 * 단이 높을수록 지면을 밝게 칠해 「올라간다」가 눈에 들어오게 한다.
 *
 * 앞서 「높은 땅이 낮은 땅과 맞닿는 모서리」에서 벽을 유도해 봤지만, 이 지도는
 * 길이 세로로 흘러 가로 모서리가 거의 없었다 (3칸 이상 이어진 곳이 10곳뿐).
 * 단 경계는 맵 폭을 가로지르므로 벽이 길게 이어진다.
 */
/**
 * 고원(높은 지대) 층을 쓰는 맵과 그 시트.
 *
 * 「길·물은 낮고, 깊은 숲은 높다」로 보고 숲 안쪽을 고원으로 칠한다.
 * 높이는 벽 스프라이트를 따로 얹는 게 아니라 **타일 자체가 두께를 갖는다** —
 * 그래서 남쪽뿐 아니라 모든 방향의 가장자리에 절벽 면이 생긴다.
 */
const MAP_PLATEAU: Record<string, string> = {};

/**
 * 돌계단 구역 — 언덕으로 오르는 길목의 바닥을 층계 타일로 갈아 깐다.
 *
 * 소품 한 장을 얹으면 바닥에 놓인 판때기로 보인다. 길 자체를 계단으로 칠해야
 * 「올라간다」가 읽힌다. 중심에서 멀어질수록 옅어져 흙길과 자연히 이어진다.
 */
const MAP_STAIRS: Record<string, readonly { x: number; y: number; r: number }[]> = {
  greatroot: [
    { x: 52.0, y: -8.1, r: 3.6 },   // 서쪽 길에서 적 기지로 오르는 층계
    { x: 50.0, y: 7.3, r: 3.6 },    // 동쪽 길
  ],
};

const MAP_TERRACES: Record<string, readonly number[]> = {
  // 지금은 어느 맵에도 켜지 않는다.
  // 흙벽·돌벽 양쪽으로 세워 봤지만, 벽 위아래 땅이 똑같아 「무엇을 떠받치는지」가
  // 없어서 바닥에 누운 띠로 보였다. 탑뷰에서 높이를 만들려면 지형 자체가
  // 단을 갖고 그려져야 한다 — 마스크 위에 벽만 얹어서는 안 된다.
};
/** 단마다의 밝기 — 낮은 단일수록 그늘진다 (맨 위가 1.0). */
const TERRACE_SHADE = [0.70, 0.80, 0.90, 1];


/** 맵 바깥(캔버스 여백) 색. 지형과 이어지는 톤으로. */
const MAP_BG: Record<string, number> = {
  confluence: 0x131a14, // 소울파이어가 스민 칠흑
  nest: 0x2b3240, // 고산의 푸른 안개
  greedvalley: 0x2a2013, // 금빛이 스민 협곡 그늘
  plains: 0x1d2a19, // 깊은 숲 그늘
  valley: 0x9c7c4e,
  toybox: 0x3a2438, // 장난감 방의 어둑한 자주빛
  ashroad: 0x16200f, // 침엽수림의 깊은 그늘
  greatroot: 0x16200f, // 침엽수림의 깊은 그늘 (13스테이지와 같은 톤)
};

/** 액티브 스킬 시전 모션 프레임 (없는 유닛은 공격 모션 재활용). */
const skill4 = (id: string): string[] => [0, 1, 2, 3].map((n) => `/assets/units/${id}_skill${n}.png?v=7`);

const ASSET_SKILL_ANIMS: Record<string, string[]> = {
  m_clockwork_soldier: skill4('m_clockwork_soldier'), // 태엽 감기
  s_treekeeper: skill4('s_treekeeper'),               // 뿌리박기
};

/**
 * 비행 유닛의 부유 모션 프레임. 2장 이상이면 순환 재생(진짜 프레임 애니메이션),
 * 1장이면 기본 포즈와 교대. 없는 비행 유닛은 스쿼시 착시로 폴백.
 */
const fly4 = (id: string): string[] => [0, 1, 2, 3].map((n) => `/assets/units/${id}_fly${n}.png?v=7`);

const ASSET_FLAP_FRAMES: Record<string, string[]> = {
  // 🏜️ 카르자 공중
  k_eagle: fly4('k_eagle'),
  k_beeswarm: fly4('k_beeswarm'),
  k_falcon: fly4('k_falcon'),
  k_spirit: fly4('k_spirit'),
  s_owl: fly4('s_owl'),
  s_butterfly: fly4('s_butterfly'),
  // 앤: 실에 매달려 팔다리가 흔들리는 4프레임
  m_puppet_ann: fly4('m_puppet_ann'),
  // 수호자: 드래곤 날갯짓, 할로우 유령마 부유 질주
  dragon: fly4('dragon'),
  hollow: fly4('hollow'),
  p_bone_dragon: fly4('p_bone_dragon'),
  c_skullrender: fly4('p_bone_dragon'),
  s_elurion: fly4('s_elurion'),
  p_dream_mare: fly4('p_dream_mare'),
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

/**
 * 시뮬 좌표 → 월드 픽셀.
 *
 * 세로 맵(vertical)은 화면을 90도 돌린다: 시뮬의 진행축(x)이 화면 세로가 되고,
 * 코리도어 폭(y)이 화면 가로가 된다. 진행 방향은 아래(6시) → 위(12시).
 * 시뮬은 전혀 손대지 않는다 — 보이는 것만 세운다.
 */
function sx(x: number): number {
  return (x / FP) * TILE;
}
function sy(y: number): number {
  // 세로 맵은 원근 압축을 쓰지 않는다 (돌려 놓으면 가로가 눌려 어색해진다)
  const sq = curMap.vertical ? 1 : Y_SQUASH;
  return ((y + renderHalfH()) / FP) * TILE * sq + PAD_TOP;
}

/*
 * 화면 기준 오프셋 → 월드 좌표.
 *
 * 세로 맵은 월드가 -90도 돌아 있다 (world.rotation = -PI/2): 월드 +x 가 화면
 * 위쪽, 월드 +y 가 화면 오른쪽이다. 「위로 떠오른다」·「아래로 떨어진다」처럼
 * 화면 기준으로 읽혀야 하는 연출은 반드시 이 자를 거쳐 그린다.
 */
function ovx(bx: number, dx: number, dy: number): number {
  return curMap.vertical ? bx - dy : bx + dx;
}
function ovy(by: number, dx: number, dy: number): number {
  return curMap.vertical ? by + dx : by + dy;
}
/** 화면 기준 타원 반지름(가로 w · 세로 h) → 월드 반지름. */
function ovw(w: number, h: number): number { return curMap.vertical ? h : w; }
function ovh(w: number, h: number): number { return curMap.vertical ? w : h; }

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
  /** 이번 다이브가 맹금의 급강하인가 (더 높이 솟구치고 깃털이 터진다). */
  diveFeather: boolean;
  /** 급강하 목표까지의 화면 오프셋(px) — 제자리가 아니라 달려든다. */
  diveDx: number;
  diveDy: number;
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
  /** 화면 좌표 → 월드 y (FP). 두 갈래 맵에서 출정 레인을 고를 때 쓴다. */
  pickLaneY(screenY: number): number;
  /**
   * 화면 좌표가 집합지 표식(노란 원) 안인가 — 맞으면 그 칸 번호, 아니면 null.
   * 표식을 직접 눌러야만 집합지가 바뀌게 하려고 쓴다 (빈 땅은 아무 일도 안 한다).
   */
  pickLaneMark(screenX: number, screenY: number): number | null;
  /**
   * 출정 레인 표시 — 고른 칸(chosenIdx)에 불이 들어온다. null = 표시 안 함.
   * y 가 아니라 번호를 받는다: 「가운데 대기」는 y 가 0 이라, 아직 아무 길도
   * 고르지 않은 상태(deployLaneY 0)와 y 로는 구분되지 않는다.
   */
  /**
   * 이 유닛이 사라질 때 시체 연출을 내지 않는다 (마을 주민 대피).
   * 「죽은 게 아니라 빠져나간 것」이라 쓰러지는 그림이 나오면 안 된다.
   */
  quietRemove(id: number): void;
  setDeployLanes(lanes: { y: number; label: string; hold?: boolean; x?: number; r?: number }[] | null, chosenIdx: number): void;
  /**
   * 「다음 턴에 적이 여기로 온다」 예고 표식 (마을 방어전).
   * 숲길 입구에서 마을 쪽으로 흘러가는 붉은 화살표 + 맥동하는 고리.
   */
  setLaneWarnings(marks: { x: number; y: number; toX: number; toY: number; label: string }[] | null): void;
  /**
   * 금광 소유 표식 (15 「에메랄드 숲의 값」).
   *
   * 갱 그림은 배경에 구워져 있고 중립이다 — 누구 것인지는 이 깃발이 말한다.
   * owner: 0 우리(청록) / 1 카르자(붉은) / -1 중립. hold 는 점령 진행(0~1),
   * 부호로 어느 쪽이 밀고 있는지 나타낸다.
   */
  setGoldMines(mines: { x: number; y: number; owner: number; hold: number }[] | null): void;
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

  /**
   * 불러온 텍스처 소스 전부. WebGL 컨텍스트가 끊겼다 돌아오면 GPU 쪽 사본이
   * 날아가는데, 시트에서 잘라 쓴 Wang 타일처럼 소스를 공유하는 텍스처는
   * 자동 복구가 어긋나 단색 덩어리로 남곤 한다 — 그때 통째로 다시 올린다.
   *
   * (겹쳐 놓은 UI 가 backdrop-filter 같은 합성 레이어를 많이 만들면 GPU 메모리가
   *  모자라 컨텍스트가 끊긴다. 게임 캔버스 위에 그런 효과를 얹으면 특히 잘 난다.)
   */
  const texSources = new Set<Texture['source']>();

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
          texSources.add(tex.source);
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
      texSources.add(tex.source);
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
        loadTex(`/assets/units/${defId}_e.png?v=7`),
        loadTex(`/assets/units/${defId}_w.png?v=7`),
        loadTex(`/assets/units/${defId}_n.png?v=7`),
        loadTex(`/assets/units/${defId}_s.png?v=7`),
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
  /** 손으로 그린 지형 배경 (bgImage 맵용). */
  const bgTex = new Map<string, Texture>();
  await Promise.all(
    Object.values(MAPS)
      .map((mm) => mm.bgImage)
      .filter((u): u is string => !!u)
      .map(async (url) => {
        const t = await loadTex(url);
        if (t) bgTex.set(url, t);
      }),
  );
  const themeTiles = new Map<string, Map<number, Texture>>();
  const themeFullVariants = new Map<string, Texture[][]>();
  const themeOuterVariants = new Map<string, Texture[][]>();
  const themeProps = new Map<string, Texture[]>();
  const themeLandmarks = new Map<string, Texture>();
  const themeLaneProps = new Map<string, Texture[]>();
  const themeEdgeProps = new Map<string, Texture[]>();
  const themeMidProps = new Map<string, Texture[]>();
  await Promise.all(
    Object.entries(THEMES).map(async ([name, theme]) => {
      const sheet = await loadTex(theme.sheet);
      // 시트가 안 열리면 지형이 통째로 안 깔린다 — 조용히 넘어가면 원인 찾기가 어렵다
      if (!sheet) console.error(`[desertlike] 지형 시트 로드 실패: ${theme.sheet} (테마 ${name})`);
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
      const edge: Texture[] = [];
      for (const pp of theme.edgeProps ?? []) {
        const t = await loadTex(`/assets/tiles/${pp}.png`);
        if (t) edge.push(t);
      }
      if (edge.length > 0) themeEdgeProps.set(name, edge);
      const mid: Texture[] = [];
      for (const pp of theme.midProps ?? []) {
        const t = await loadTex(`/assets/tiles/${pp}.png`);
        if (t) mid.push(t);
      }
      if (mid.length > 0) themeMidProps.set(name, mid);
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

  // 물길 Wang 시트 — 장식 격자('~')를 따라 지면 위에 한 겹 더 깐다.
  // 숲 쪽(idx 0) 타일은 그리지 않으므로 아래 지면이 그대로 이어져 보인다.
  /** 물빛 미세 변화 — 얕은 여울부터 깊은 소까지. */
  const WATER_SHADES = [0xffffff, 0xe8f4ff, 0xd2e8f6, 0xc4e2f2, 0xf0f8ff, 0xdceef8];
  /** 언덕으로 오르는 층계 바닥. */
  const stairTile = await loadTex('/assets/tiles/wr_stairtile.png');
  /** 절벽 벽면 — 높은 지대의 화면 아래쪽 가장자리에 세워 높낮이를 만든다. */
  const cliffFace = await loadTex('/assets/tiles/cliff_face.png');
  /** 벽이 끝나며 안쪽으로 꺾이는 조각 (왼쪽 끝 / 오른쪽 끝). */
  const cliffEndL = await loadTex('/assets/tiles/cliff_end_l.png');
  const cliffEndR = await loadTex('/assets/tiles/cliff_end_r.png');
  /** 길이 단을 넘는 자리 — 계단. */
  const cliffStair = await loadTex('/assets/tiles/cliff_stair.png');
  /** 강 위에만 놓이는 소품 (여울 바위·잠긴 통나무). */
  const riverProps: Texture[] = [];
  for (const nm of ['wr_river_rocks', 'wr_river_log']) {
    const t = await loadTex(`/assets/tiles/${nm}.png`);
    if (t) riverProps.push(t);
  }
  /**
   * 물길 시트도 맵마다 따로 둔다 (13·14 가 서로 안 건드리게).
   * 맵에 지정이 없으면 기본 woodwater 를 쓴다.
   */
  const MAP_WATER_SHEET: Record<string, string> = { greatroot: 'greatwater' };
  /** 고원 시트 — 타일에 두께가 있어 세로로 길다. */
  const plateauSheets = new Map<string, { tiles: Map<number, Texture>; h: number }>();
  for (const nm of new Set(Object.values(MAP_PLATEAU))) {
    const ps = await loadTex(`/assets/tiles/${nm}.png`);
    if (!ps) continue;
    const tw = Math.floor(ps.width / 4);
    const thh = Math.floor(ps.height / 4);
    const tiles = new Map<number, Texture>();
    for (let k = 0; k < 16; k++) {
      tiles.set(k, new Texture({
        source: ps.source,
        frame: new Rectangle((k % 4) * tw, Math.floor(k / 4) * thh, tw, thh),
      }));
    }
    plateauSheets.set(nm, { tiles, h: thh / tw });
  }
  const waterSheets = new Map<string, Map<number, Texture>>();
  for (const nm of ['woodwater', ...Object.values(MAP_WATER_SHEET)]) {
    if (waterSheets.has(nm)) continue;
    const ws = await loadTex(`/assets/tiles/${nm}.png`);
    if (!ws) continue;
    const set = new Map<number, Texture>();
    for (const [idx, [tx, ty]] of Object.entries(WANG_16)) {
      set.set(Number(idx), new Texture({
        source: ws.source,
        frame: new Rectangle(tx, ty, TILE_PX, TILE_PX),
      }));
    }
    waterSheets.set(nm, set);
  }
  // 바위 소품 (장식 격자 'o' 자리에만 놓는다)
  const rockProps: Texture[] = [];
  for (const n of ['wr_rock1', 'wr_rock2', 'wr_rock3']) {
    const t = await loadTex(`/assets/tiles/${n}.png`);
    if (t) rockProps.push(t);
  }
  // 손으로 배치한 지형지물 (캠프·다리·천막) 텍스처
  const placedTex = new Map<string, Texture>();
  for (const list of Object.values(MAP_PROPS)) {
    for (const pr of list) {
      if (placedTex.has(pr.name)) continue;
      const t = await loadTex(`/assets/tiles/${pr.name}.png`);
      if (t) placedTex.set(pr.name, t);
    }
  }
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
      'stormwing', 'moonveil', 'threadstorm',
    ].map(async (kind) => {
      const t = await loadTex(`/assets/fx/zone_${kind}.png`);
      if (t) zoneTex.set(kind, t);
    }),
  );
  // 메테오는 일반 장판과 달리 대형 낙하체와 전용 착탄 데칼을 따로 쓴다.
  const goldFlagTex = [
    await loadTex('/assets/tiles/gm_flag_ally.png'),
    await loadTex('/assets/tiles/gm_flag_foe.png'),
  ];
  let goldMines: { x: number; y: number; owner: number; hold: number }[] | null = null;
  const goldFlagSp: Sprite[] = [];
  const meteorTex = await loadTex('/assets/fx/fx_meteor_large.png');
  const meteorZoneTex = await loadTex('/assets/fx/zone_meteor.png');
  // 스킬 시전 이펙트 그림 — 시전 위치에 잠깐 떴다 커지며 사라진다
  const castFxTex = new Map<string, Texture>();
  await Promise.all(
    ['bark', 'roar', 'regen', 'curtain', 'curtain_closed'].map(async (k) => {
      const t = await loadTex(`/assets/fx/fx_${k}.png`);
      if (t) castFxTex.set(k, t);
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
  /** 시체 연출 없이 지울 유닛 id (대피한 주민). */
  const quietIds = new Set<number>();
  const units = new Container();
  // 하늘에서 떨어지는 운석은 유닛보다 위, 섬광·UI보다 아래에 그린다.
  const meteorLayer = new Container();
  units.sortableChildren = true;
  /** 맵 경계 장식 (렌더 전용 — 심 엔티티가 아니라 밸런스 영향 없음). */
  let mapDecos: Sprite[] = [];

  /**
   * 평원(plains): 걷는 길 바깥에 숲을 촘촘히 심는다. 왼쪽은 살아 있는 숲,
   * 오른쪽은 불탄 숲 — 맵 테마 그대로다. 유닛이 다니지 않는 경계 바깥이라
   * 게임엔 영향이 없다. 결정론이 필요 없는 순수 그림이지만 배치는 고정 시드로
   * 뽑아 접속할 때마다 같은 숲이 보이게 한다.
   *
   * 잿길(ashroad)은 여기서 빠져 있다 — 손그림을 옮긴 뒤로는 지형 타일이
   * 마스크를 따라 직접 침엽수를 심으므로, 예전의 불탄 나무 도배는 새 숲과
   * 섞여 어긋나기만 했다.
   */
  function buildMapDecos(): void {
    for (const d of mapDecos) d.destroy();
    mapDecos = [];
    if (curMap.id !== 'plains') return;
    let seed = 20260819;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    /**
     * 종류 뽑기. 잿길은 불탄 숲 일색이고, 잿불 숲(plains)은 맵 절반을 기준으로
     * 왼쪽(1팀)은 살아 있는 숲, 오른쪽(2팀)은 불에 탄 숲 — 맵 설정 그대로다.
     * 경계 근처는 두 숲이 섞이게 확률을 흐려 「타일이 뚝 끊기는」 느낌을 지운다.
     */
    const pickKind = (xFP: number): string => {
      const r = rnd();
      if (curMap.id === 'plains') {
        // 0(왼쪽 끝) ~ 1(오른쪽 끝). 중앙 근처에서 서서히 불탄 쪽으로 넘어간다
        const t01 = xFP / Math.max(1, curMap.length);
        const burnt = t01 < 0.38 ? 0 : t01 > 0.62 ? 1 : (t01 - 0.38) / 0.24;
        if (rnd() < burnt) {
          if (r < 0.45) return 'c_ember_tree';
          if (r < 0.85) return 'c_ember_tree2';
          return 'c_burning_log';
        }
        if (r < 0.40) return 'c_green_tree';
        if (r < 0.68) return 'c_green_bush';
        if (r < 0.86) return 'c_wildflowers';
        return 'c_mossy_rock';
      }
      if (r < 0.40) return 'c_green_tree';
      if (r < 0.68) return 'c_green_bush';
      if (r < 0.86) return 'c_wildflowers';
      return 'c_mossy_rock';
    };
    /** 종류별 화면 폭(타일). 덤불·꽃·바위는 나무보다 작게 깔린다. */
    const widthOf = (kind: string): number => {
      if (kind === 'c_burning_log') return 2.2;
      if (kind === 'c_green_bush') return 1.2 + rnd() * 0.5;
      if (kind === 'c_wildflowers') return 0.9 + rnd() * 0.4;
      if (kind === 'c_mossy_rock') return 1.0 + rnd() * 0.5;
      if (kind === 'c_green_tree') return 2.0 + rnd() * 1.2;
      return 1.9 + rnd() * 1.4;
    };
    const put = (xFP: number, yFP: number, depth: number): void => {
      const kind = pickKind(xFP);
      const tex = assetTex.get(kind)?.[0];
      if (!tex) return;
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 1);
      const w = TILE * widthOf(kind);
      sp.scale.set(w / tex.width);
      if (rnd() < 0.5) sp.scale.x = -sp.scale.x;
      // 깊은 숲일수록 살짝 어둡게 — 원근감. 줄이 멀어질수록 한 단계씩 더 죽인다.
      const living = kind === 'c_green_tree' || kind === 'c_green_bush'
        || kind === 'c_wildflowers' || kind === 'c_mossy_rock';
      if (depth > 0) {
        const step = Math.min(depth, 3);
        sp.tint = living
          ? [0xffffff, 0xe4ece0, 0xd8e4d0, 0xccdcc4][step]!   // 살아있는 숲은 아주 살짝만
          : [0xffffff, 0xcabfb6, 0xb8aca4, 0xa89c94][step]!;
      }
      sp.x = sx(xFP);
      sp.y = sy(yFP);
      sp.zIndex = sp.y;
      units.addChild(sp);
      mapDecos.push(sp);
    };
    /*
     * 길 바깥을 숲으로 채운다.
     *
     * 잿불 숲은 레인 반폭 7타일 + 여백 3타일이라, 나무가 들어갈 띠가 2.4타일뿐이다.
     * 예전 간격(가로 2.4 / 세로 2.2타일)으로는 한두 줄밖에 안 들어가서 가장자리가
     * 휑했다. 간격을 절반 아래로 좁혀 세 줄 남짓 겹치게 심는다 — 나무 폭이 2~3타일이라
     * 겹쳐야 비로소 「숲」으로 읽힌다.
     *
     * 여백은 넓히지 않는다: 화면 줌이 월드 높이에 맞춰지므로(worldH) 여백을 키우면
     * 정작 싸움이 벌어지는 길이 그만큼 작게 보인다.
     */
    // 맨 바깥 줄은 여백을 살짝 넘겨 심는다 — 그래야 숲이 잘린 선으로 끝나지 않는다
    const limit = renderHalfH() + Math.floor(0.5 * FP);
    for (const side of [-1, 1]) {
      const tEnd = curMap.length / FP - 1;
      for (let t = 2; t < tEnd; t += 0.85 + rnd() * 0.85) {
        const xFP = Math.floor(t * FP);
        const half = laneHalfWAt(curMap, xFP);
        // 길가에 바짝 붙여 시작 — 길과 숲 사이가 벌어지면 그 틈이 허전해 보인다
        const edge = laneCenterY(curMap, xFP) + side * (half + Math.floor(150 + rnd() * 450));
        // 경계에서 바깥으로 한 줄씩 — 줄 간격·좌우를 흔들어 자연스러운 숲으로
        let off = 0;
        let depth = 0;
        for (let yFP = edge; Math.abs(yFP) < limit; yFP += side * Math.floor(700 + rnd() * 700)) {
          put(xFP + Math.floor((rnd() - 0.5) * 900), yFP + off, depth);
          off = Math.floor((rnd() - 0.5) * 500);
          depth++;
        }
      }
    }
  }
  const fx = new Graphics();
  /** 유닛별 보호막 최대치 기억 (바가 줄어드는 비율의 기준). */
  const shieldPeak = new Map<number, number>();
  const projLayer = new Container(); // 투사체 스프라이트 (유닛 위, 체력바 아래)
  const bars = new Graphics();
  world.addChild(
    groundTiles, scorchedTiles, groundProps, ground,
    zonesGr, zoneLayer, shadows, corpseLayer, units, meteorLayer, fx, projLayer, bars,
    cloudLayer, // 구름은 모든 것 위로 흐른다 (반투명)
  );
  app.stage.addChild(world);

  /** 지형 타일 격자 재구축 (맵 교체·초기화 시). 타일이 없으면 drawGround 폴백. */
  function buildGroundTiles(): void {
    for (const layer of [groundTiles, scorchedTiles, groundProps]) {
      for (const c of layer.removeChildren()) c.destroy();
    }
    const m = curMap;
    // 손으로 그린 배경 한 장을 쓰는 맵 — 오토타일링을 건너뛰고 그대로 깐다.
    // 세로 맵이면 월드가 -90도 돌아가므로 그림도 같이 돌려 세운다.
    if (m.bgImage) {
      const tex = bgTex.get(m.bgImage);
      if (tex) {
        const sp = new Sprite(tex);
        sp.anchor.set(0.5);
        /*
         * 그림을 「통행 마스크가 덮는 범위」에 정확히 맞춘다.
         *
         * worldW/worldH 는 가장자리 여백(EDGE_MARGIN)과 위아래 패딩까지 포함한
         * 화면 상자다. 그 상자에 그림을 늘리면 그림 속 길과 실제 걸을 수 있는
         * 칸이 어긋난다 (올빼미 성채에서 폭이 15% 벌어져, 유닛이 그림상 절벽
         * 밖을 걸어 다니는 것처럼 보였다).
         * 마스크는 x 0~length, y -mapHalfH~+mapHalfH 를 덮으므로 거기에 맞춘다.
         */
        const boxW = worldW();
        const halfH = mapHalfH(m);
        const yTop = sy(-halfH);
        const boxH = sy(halfH) - yTop;
        if (m.vertical) {
          // 컨테이너가 -90도 돌아 있으니 그림은 +90도 돌려 화면에서 바로 세운다.
          // 회전하면 스프라이트의 가로가 월드 y축, 세로가 월드 x축을 덮는다.
          sp.rotation = Math.PI / 2;
          sp.width = boxH;
          sp.height = boxW;
        } else {
          sp.width = boxW;
          sp.height = boxH;
        }
        sp.x = boxW / 2;
        sp.y = yTop + boxH / 2;
        groundTiles.addChild(sp);
      }
      return;
    }
    const names = MAP_THEMES[m.id] ?? ['desert'];
    if (!names.some((n) => themeTiles.has(n))) return;

    const tilesX = m.length / FP;
    const halfH = renderHalfH(m);
    const tilesY = Math.ceil((halfH * 2) / FP);
    // 세로 맵은 원근 압축을 쓰지 않는다 (sx/sy 와 반드시 같아야 한다).
    // 이게 어긋나면 지형과 유닛이 서로 3타일쯤 밀려 그려진다 — 본진이
    // 중앙에서 벗어나 보이던 원인이었다.
    const th = TILE * (m.vertical ? 1 : Y_SQUASH);
    const laneHalf = m.halfW / FP;

    /**
     * 이 칸에 쓸 테마. 테마가 2개면 맵 중앙에서 갈린다.
     * 경계는 행마다 물결치고, 그 부근 몇 칸은 두 테마를 흩뿌려 섞어서
     * 칼로 자른 직선이 아니라 "불이 번지다 만" 자국처럼 보이게 한다.
     */
    const BLEND = 4; // 섞이는 띠의 반폭 (타일)
    /**
     * 이 칸이 얼마나 탔는가 (0 = 온전한 숲, 1 = 완전히 탄 곳).
     * 예전엔 칸마다 둘 중 하나를 확률로 골라서, 네모 타일이 체스판처럼 딱딱 갈렸다.
     * 지금은 비율을 그대로 돌려주고 두 지형을 겹쳐 그린다 — 경계가 녹아 이어진다.
     */
    const burntAt = (i: number, j: number): number => {
      if (names.length < 2) return 0;
      const wave = Math.sin(j * 0.9) * 2.2 + Math.sin(j * 0.37 + 1.3) * 1.7;
      const d = i - (tilesX / 2 + wave); // 경계로부터의 거리 (+ = 불탄 쪽)
      if (d <= -BLEND) return 0;
      if (d >= BLEND) return 1;
      const t = (d + BLEND) / (BLEND * 2); // 0~1 선형
      // 칸마다 ±0.18 의 얼룩을 섞어 경계선이 자로 그은 듯 곧게 보이지 않게 한다
      const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
      const jitter = ((h % 1000) / 1000 - 0.5) * 0.36;
      return Math.max(0, Math.min(1, t + jitter));
    };
    const themeAt = (i: number, j: number): string =>
      (names.length < 2 || burntAt(i, j) < 0.5) ? names[0]! : names[1]!;
    /**
     * 통행 마스크가 있는 맵(손그림 지형)의 격자 조회.
     * 마스크는 타일의 2배 해상도(반타일)라 타일 (i, j) 는 칸 (2i, 2j)~(2i+1, 2j+1) 을 덮는다.
     */
    const mk = m.mask;
    // 타일 격자는 맵 바깥으로 EDGE_MARGIN 만큼 더 깔린다 (여백 지대).
    // 마스크·장식 격자는 그 여백을 모르므로 열 번호를 그만큼 당겨서 맞춘다.
    // 이걸 빼먹으면 지형 그림이 통행 범위보다 3타일 아래로 밀려, 유닛이
    // 「강 위를 걸어가고」 넥서스가 중앙에서 벗어나 보인다.
    /** 마스크 한 칸이 타일의 몇 분의 1인가 (2 = 반타일, 4 = 1/4타일). */
    const CELLS = mk ? Math.max(1, Math.round(mk.rows / (m.length / FP))) : 1;
    const cellOff = Math.round((renderHalfH(m) - mapHalfH(m)) / FP) * CELLS;
    const cellPath = (row: number, col: number): boolean => {
      if (!mk) return false;
      const c = col - cellOff;
      if (row < 0 || row >= mk.rows || c < 0 || c >= mk.cols) return false;
      return mk.data[row * mk.cols + c] === '.';
    };
    /** 장식 격자 조회 — 마스크와 같은 여백 보정을 쓴다. */
    const decoCell = (row: number, col: number): string => (
      deco ? decoAt(deco, row, col - cellOff) : '.'
    );
    /**
     * 타일 꼭짓점 (i, j) 가 길인가 — 맞닿은 네 칸 중 하나라도 길이면 길로 친다.
     * 다수결로 하면 그려진 길이 실제 통행 칸보다 좁아져, 유닛이 「나무 위를
     * 걸어가는」 자리가 생긴다. 그림이 통행 범위를 덮도록 넉넉하게 잡는다.
     */
    const maskCorner = (vx: number, vy: number): number => (
      cellPath(vx * 2 - 1, vy * 2 - 1) || cellPath(vx * 2, vy * 2 - 1)
        || cellPath(vx * 2 - 1, vy * 2) || cellPath(vx * 2, vy * 2)
    ) ? 1 : 0;
    /**
     * 타일 (i, j) 에 걸을 수 있는 칸이 하나라도 있는가.
     * 여기에 해당하면 나무를 절대 심지 않는다 — 반 칸이라도 길이면 유닛이 지나간다.
     */
    const maskTile = (i: number, j: number): boolean => {
      for (let a = 0; a < CELLS; a++) {
        for (let b = 0; b < CELLS; b++) if (cellPath(i * CELLS + a, j * CELLS + b)) return true;
      }
      return false;
    };
    // Wang 코너 판정: 꼭짓점이 코리도어(걷는 길) 안인가 — 메인 레인 + 가지 길
    const laneV = (vx: number, vy: number): number => {
      if (mk) return maskCorner(vx, vy);
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
    /**
     * 손그림 맵은 「반 타일」 해상도로 지면을 깐다.
     *
     * 마스크는 타일당 2칸인데 지면을 타일 단위로 그리면, 3칸(1.5타일)짜리 좁은
     * 길과 고리가 전부 한 덩어리로 뭉개져 그림이 통째로 뭉텅이가 된다.
     * 칸 단위로 깔면 그려진 길 폭이 그대로 살아난다 (타일 수는 4배).
     */
    const SUB = CELLS;
    const stepW = TILE / SUB;
    const stepH = th / SUB;
    /**
     * 숲 바닥 한 장을 통째로 깔아 둔다 (마스크 맵 전용).
     * 그 위에 「길이 조금이라도 닿는 칸」만 타일로 덮는다 — 스프라이트가 1/3로 준다.
     */
    /** 반타일 격자의 Wang 코너 — 맞닿은 마스크 칸 중 둘 이상이 길이면 길. */
    const subCorner = (vx: number, vy: number): number => (
      (cellPath(vx - 1, vy - 1) ? 1 : 0) + (cellPath(vx, vy - 1) ? 1 : 0)
      + (cellPath(vx - 1, vy) ? 1 : 0) + (cellPath(vx, vy) ? 1 : 0)
    ) >= 2 ? 1 : 0;
    const cornerV = mk ? subCorner : laneV;
    /** 이 맵의 단 경계 (없으면 계단 없음). */
    const terraces = MAP_TERRACES[m.id];
    /** 단 경계의 x — 자로 그은 듯 곧지 않게 살짝 물결진다. */
    const terraceX = (base: number, j: number): number => base + Math.round(0.8 * Math.sin(j * 0.28));
    /** 타일 (i, j) 가 몇 단인가 (0 = 가장 낮은 단). */
    const levelAt = (i: number, j: number): number => {
      if (!terraces) return TERRACE_SHADE.length - 1;
      let lv = 0;
      for (const b of terraces) if (i >= terraceX(b, j)) lv++;
      return Math.min(lv, TERRACE_SHADE.length - 1);
    };
    /** 색을 f 배로 어둡게 (0~1). */
    const dimTint = (c: number, f: number): number => {
      const r = Math.round(((c >> 16) & 0xff) * f);
      const g2 = Math.round(((c >> 8) & 0xff) * f);
      const b2 = Math.round((c & 0xff) * f);
      return (r << 16) | (g2 << 8) | b2;
    };
    let plainFloor = false;
    if (mk && names.length === 1) {
      const base = themeTiles.get(names[0]!)?.get(0);
      if (base && !themeOuterVariants.get(names[0]!)) {
        // 단마다 따로 깐다 — 한 장으로 덮으면 단별 밝기 차가 통째로 사라져
        // 절벽이 「무엇을 떠받치는지」 알 수 없는 갈색 띠로 보인다.
        const bounds = [0, ...(terraces ?? []), tilesX];
        for (let k = 0; k + 1 < bounds.length; k++) {
          const x0 = bounds[k]! * TILE;
          const x1 = bounds[k + 1]! * TILE;
          const bg = new TilingSprite({
            texture: base,
            width: x1 - x0,
            height: tilesY * th,
          });
          bg.tileScale.set(stepW / TILE_PX, stepH / TILE_PX);
          bg.tilePosition.x = -x0;
          bg.x = x0;
          bg.y = PAD_TOP;
          bg.tint = terraces
            ? dimTint(0x8ba47c, TERRACE_SHADE[Math.min(k, TERRACE_SHADE.length - 1)]!)
            : 0x8ba47c;
          groundTiles.addChild(bg);
        }
        plainFloor = true;
      }
    }
    for (let i = 0; i < tilesX * SUB; i++) {
      for (let j = 0; j < tilesY * SUB; j++) {
        const ti = Math.floor(i / SUB);
        const tj = Math.floor(j / SUB);
        const burnt = burntAt(ti, tj);
        // 경계 구간이면 「온전한 숲」 위에 「탄 숲」을 투명도로 덮어 서서히 넘어가게 한다.
        // 두 테마가 같은 시트를 쓰므로 무늬가 정확히 겹치고, 탈색 필터만 다르게 걸린다.
        const layers: { name: string; alpha: number }[] = names.length < 2 || burnt <= 0.02
          ? [{ name: names[0]!, alpha: 1 }]
          : burnt >= 0.98
            ? [{ name: names[1]!, alpha: 1 }]
            : [{ name: names[0]!, alpha: 1 }, { name: names[1]!, alpha: burnt }];
        for (const layer of layers) {
        const name = layer.name;
        const tiles = themeTiles.get(name);
        if (!tiles) continue;
        const idx = cornerV(i, j) * 8 + cornerV(i + 1, j) * 4 + cornerV(i, j + 1) * 2 + cornerV(i + 1, j + 1);
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
        // 숲만 있는 칸(idx 0)은 아래 깔린 배경 한 장이 그대로 보이므로 건너뛴다.
        // 1/4 타일까지 쪼개면 칸이 4만 개가 넘어 스프라이트 수가 감당이 안 된다.
        if (idx === 0 && plainFloor && layers.length === 1) continue;
        const sp = new Sprite(tex);
        sp.x = i * stepW;
        sp.y = PAD_TOP + j * stepH;
        sp.width = stepW;
        sp.height = stepH;
        sp.alpha = layer.alpha;
        // 손그림 맵의 숲 칸은 한 단 어둡게 — 위에 심는 침엽수 캐노피의 그늘이 된다
        const baseTint = mk && idx === 0
          ? 0x8ba47c
          : SHADES[(((i * 73856093) ^ (j * 83492791)) >>> 0) % SHADES.length]!;
        sp.tint = terraces ? dimTint(baseTint, TERRACE_SHADE[levelAt(Math.floor(i / SUB), Math.floor(j / SUB))]!) : baseTint;
        (THEMES[name]?.scorched ? scorchedTiles : groundTiles).addChild(sp);
        }
      }
    }
    // 물길: 장식 격자('~')를 Wang 으로 지면 위에 덮는다. 숲뿐인 칸은 건너뛴다.
    const deco = MAP_DECO[m.id];
    const waterTiles = waterSheets.get(MAP_WATER_SHEET[m.id] ?? 'woodwater') ?? new Map<number, Texture>();
    if (deco && waterTiles.size > 0) {
      // 지면과 같은 반타일 격자를 쓴다 — 강만 타일 단위로 깔면 물가가 뭉텅이가 된다
      // 다리 밑에서는 길 위에도 강을 이어 그린다 (통행 판정과는 무관 — 그림만)
      const spans = MAP_WATER_SPANS[m.id] ?? [];
      /** 반타일 칸이 물인가 — 장식 격자에 있거나, 이어 붙인 강줄기 안이거나. */
      const isWet = (row: number, col: number): boolean => {
        if (decoCell(row, col) === '~') return true;
        if (spans.length === 0) return false;
        // 칸 중심의 타일 좌표. 장식 격자의 열은 맵 위쪽 끝(-mapHalfH)에서 시작한다.
        const tx = (row + 0.5) / CELLS;
        const ty = (col - cellOff + 0.5) / CELLS - mapHalfH(m) / FP;
        return inWaterSpan(spans, tx, ty);
      };
      const waterV = (vx: number, vy: number): number => {
        let n = 0;
        if (isWet(vx - 1, vy - 1)) n++;
        if (isWet(vx, vy - 1)) n++;
        if (isWet(vx - 1, vy)) n++;
        if (isWet(vx, vy)) n++;
        return n >= 2 ? 1 : 0;
      };
      for (let i = 0; i < tilesX * SUB; i++) {
        for (let j = 0; j < tilesY * SUB; j++) {
          const idx = waterV(i, j) * 8 + waterV(i + 1, j) * 4 + waterV(i, j + 1) * 2 + waterV(i + 1, j + 1);
          if (idx === 0) continue; // 물이 하나도 안 닿는 칸 — 지면 그대로 둔다
          const tex = waterTiles.get(idx);
          if (!tex) continue;
          const sp = new Sprite(tex);
          sp.x = i * stepW;
          sp.y = PAD_TOP + j * stepH;
          sp.width = stepW;
          sp.height = stepH;
          // 물빛을 칸마다 살짝 흔든다 — 한 장짜리 시트를 그대로 깔면
          // 강이 「색종이를 오려 붙인 띠」처럼 납작해 보인다
          const wh = ((i * 374761393) ^ (j * 668265263)) >>> 0;
          sp.tint = WATER_SHADES[wh % WATER_SHADES.length]!;
          groundTiles.addChild(sp);
          // 강 한복판에는 이따금 여울·통나무를 띄운다 (물 위에만 사는 소품)
          if (idx === 15 && riverProps.length > 0 && wh % 100 < 4) {
            const rt = riverProps[(wh >>> 7) % riverProps.length]!;
            const rp = new Sprite(rt);
            rp.anchor.set(0.5, 0.5);
            if (m.vertical) rp.rotation = Math.PI / 2;
            const wide = TILE * (wh % 3 === 0 ? 1.15 : 0.85);
            rp.scale.set(wide / rt.width);
            rp.x = i * stepW + stepW * 0.5 + ((wh >>> 11) % 9) - 4;
            rp.y = PAD_TOP + j * stepH + stepH * 0.5 + ((wh >>> 15) % 9) - 4;
            rp.alpha = 0.94;
            groundTiles.addChild(rp);
          }
        }
      }
    }
    // ── 계단 절벽: 단 경계마다 돌벽을 세우고, 길이 넘는 자리엔 계단을 놓는다 ──
    //
    // 조각은 모두 아래 끝을 맞춰 놓는다 (벽 57px, 끝 조각 72px, 계단 36px / 타일 32px).
    // 벽이 끊기는 자리(길·물)에는 끝 조각을 세워 뚝 잘린 티를 없앤다.
    const wallTiles = new Set<number>();
    if (mk && cliffFace && terraces) {
      const lowTile = (i: number, j: number): boolean => {
        for (let a = 0; a < CELLS; a++) {
          for (let b = 0; b < CELLS; b++) {
            if (cellPath(i * CELLS + a, j * CELLS + b)) return true;
            if (decoCell(i * CELLS + a, j * CELLS + b) === '~') return true;
          }
        }
        return false;
      };
      const FACE_H = 57 / 32;   // 벽 높이 (타일)
      /** 조각 하나를 단 경계에 세운다. 아래 끝을 벽과 맞춘다. */
      const stamp = (tex: Texture, i: number, j: number, hTiles: number): void => {
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 0);
        const lift = (hTiles - FACE_H) * TILE;   // 큰 조각은 그만큼 위에서 시작
        if (m.vertical) {
          sp.rotation = Math.PI / 2;
          sp.x = i * TILE + lift;
          sp.y = PAD_TOP + (j + 0.5) * th;
          sp.width = th;
          sp.height = hTiles * TILE;
        } else {
          sp.x = i * TILE + TILE * 0.5;
          sp.y = PAD_TOP + (j + 1) * th - lift * Y_SQUASH;
          sp.width = TILE;
          sp.height = hTiles * TILE * Y_SQUASH;
        }
        // 흙벽이 주변보다 붉고 선명하다 — 채도를 눌러 숲·길과 같은 톤으로
        sp.tint = 0xc2c6b4;
        sp.zIndex = 2;
        groundProps.addChild(sp);
      };
      for (const base of terraces) {
        // 이 단 경계에서 각 칸이 벽인지 계단인지 먼저 정한다
        const kind: ('wall' | 'ramp' | 'none')[] = [];
        for (let j = 0; j < tilesY; j++) {
          const i = terraceX(base, j);
          kind.push(i < 1 || i >= tilesX - 1 ? 'none' : (lowTile(i, j) ? 'ramp' : 'wall'));
        }
        for (let j = 0; j < tilesY; j++) {
          const i = terraceX(base, j);
          if (kind[j] === 'none') continue;
          if (kind[j] === 'ramp') {
            if (cliffStair) stamp(cliffStair, i, j, 36 / 32);
            continue;
          }
          wallTiles.add(i * 1000 + j);
          // 벽줄의 양 끝이면 꺾이는 조각으로 마무리한다
          const headEnd = kind[j - 1] !== 'wall';
          const tailEnd = kind[j + 1] !== 'wall';
          const capTex = headEnd ? cliffEndL : tailEnd ? cliffEndR : null;
          stamp(capTex ?? cliffFace, i, j, capTex ? 72 / 32 : FACE_H);
        }
      }
    }
    // ── 오르는 층계: 길 바닥을 돌계단 타일로 갈아 깐다 ──
    const stairZones = MAP_STAIRS[m.id];
    if (mk && stairTile && stairZones) {
      const halfT = halfH / FP;
      for (const z of stairZones) {
        const i0 = Math.floor(z.x - z.r);
        const i1 = Math.ceil(z.x + z.r);
        const j0 = Math.floor(z.y + halfT - z.r);
        const j1 = Math.ceil(z.y + halfT + z.r);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            if (i < 0 || i >= tilesX || j < 0 || j >= tilesY) continue;
            if (!maskTile(i, j)) continue;        // 길 위에만 깐다
            const d = Math.hypot(i + 0.5 - z.x, j + 0.5 - (z.y + halfT));
            if (d > z.r) continue;
            const sp = new Sprite(stairTile);
            sp.x = i * TILE;
            sp.y = PAD_TOP + j * th;
            sp.width = TILE;
            sp.height = th;
            // 가장자리는 서서히 옅어져 흙길과 이어진다
            sp.alpha = d < z.r * 0.55 ? 1 : 1 - (d - z.r * 0.55) / (z.r * 0.45);
            groundTiles.addChild(sp);
          }
        }
      }
    }
    const placed = MAP_PROPS[m.id] ?? [];
    // 손그림 지형: 소품도 마스크를 따른다 — 길 밖에만 나무를 심고,
    // 장식 격자가 바위('o')·물('~')이라고 한 칸은 각각 바위를 놓거나 비운다.
    if (mk) {
      for (let i = 1; i < tilesX - 1; i++) {
        for (let j = 0; j < tilesY; j++) {
          const onPath = maskTile(i, j);
          const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
          const theme = themeAt(i, j);
          if (onPath) {
            const lane = themeLaneProps.get(theme);
            if (!lane || lane.length === 0 || h % 100 >= 18) continue;
            const tex = lane[h % lane.length]!;
            const sp = new Sprite(tex);
            sp.anchor.set(0.5, 1);
            if (m.vertical) sp.rotation = Math.PI / 2; // 세로 맵: 월드가 90도 돌아가 있어 소품만 되세운다
            sp.scale.set((TILE * 0.85) / tex.width);
            sp.x = i * TILE + ((h >>> 4) % TILE);
            sp.y = PAD_TOP + j * th + ((h >>> 8) % Math.max(1, Math.floor(th))) + th * 0.5;
            sp.zIndex = 0;
            groundProps.addChild(sp);
            continue;
          }
          // 벽을 세운 칸엔 나무를 심지 않는다 (벽 위에 나무가 떠 보인다)
          if (wallTiles.has(i * 1000 + j)) continue;
          // 물 위엔 아무것도 심지 않는다 (반타일 4칸 중 하나라도 물이면 비움)
          let wet = false;
          if (deco) {
            for (let a = 0; a < CELLS && !wet; a++) {
              for (let b = 0; b < CELLS && !wet; b++) {
                if (decoCell(i * CELLS + a, j * CELLS + b) === '~') wet = true;
              }
            }
          }
          if (wet) continue;
          // 손으로 놓은 캠프·다리 자리엔 나무를 심지 않는다 (그림이 가려진다)
          let nearPlaced = false;
          for (const pr of placed) {
            const r = pr.clear ?? 0;
            if (r <= 0) continue;
            const dxT = i + 0.5 - pr.x;
            const dyT = j + 0.5 - (pr.y + halfH / FP);
            if (dxT * dxT + dyT * dyT < r * r) { nearPlaced = true; break; }
          }
          if (nearPlaced) continue;
          const rocky = decoCell(i * CELLS, j * CELLS) === 'o';
          // 길에서 얼마나 떨어진 칸인가.
          // 스프라이트는 발밑을 기준으로 「위로」 자라므로, 길 남쪽 두세 칸에
          // 큰 나무를 심으면 가지가 길을 통째로 덮어 못 지나가는 길처럼 보인다.
          let roadside = false;
          let nearRoad = false;
          for (let a = -1; a <= 1; a++) {
            for (let b = -4; b <= 1; b++) {
              if (a === 0 && b === 0) continue;
              if (!maskTile(i + a, j + b)) continue;
              nearRoad = true;
              if (b >= -2) roadside = true; // 길에서 두 칸까지는 낮은 것만
            }
          }
          const edge = themeEdgeProps.get(theme);
          const mid = themeMidProps.get(theme);
          const pool = rocky && rockProps.length > 0 ? rockProps
            : roadside && edge && edge.length > 0 ? edge
              : nearRoad && mid && mid.length > 0 ? mid
                : themeProps.get(theme);
          if (!pool || pool.length === 0) continue;
          // 깊은 숲은 빽빽하게, 길가는 성기고 낮게 — 길 경계가 눈에 들어오게
          if (h % 100 >= (rocky ? 70 : roadside ? 42 : nearRoad ? 62 : 84)) continue;
          const tex = pool[h % pool.length]!;
          const widthT = rocky ? 1.15 : roadside ? 1.0 : nearRoad ? 1.35 : 1.9;
          const offX = (h >>> 4) % TILE;
          const offY = (h >>> 8) % Math.max(1, Math.floor(th));
          /**
           * 이 소품이 「걸을 수 있는 칸」을 조금이라도 덮는가.
           *
           * 스프라이트는 발밑에서 위로 자라므로, 숲 칸에 심어도 키가 크면 위쪽
           * 길을 덮어 버린다 — 유닛이 나무를 밟고 지나가는 것처럼 보인다.
           * 한 칸이라도 덮으면 아예 심지 않는다 (그 자리는 풀만 남는다).
           */
          const hT = (widthT * (tex.height / tex.width)) / Y_SQUASH; // 화면 높이(타일)
          const baseT = j + 0.5 + offY / th;
          const leftT = i + offX / TILE - widthT / 2;
          const rightT = i + offX / TILE + widthT / 2;
          let covers = false;
          for (let cj = Math.floor(baseT - hT); cj <= Math.floor(baseT) && !covers; cj++) {
            for (let ci = Math.floor(leftT); ci <= Math.floor(rightT); ci++) {
              if (maskTile(ci, cj)) { covers = true; break; }
            }
          }
          if (covers) continue;
          const sp = new Sprite(tex);
          sp.anchor.set(0.5, 1);
          if (m.vertical) sp.rotation = Math.PI / 2; // 세로 맵: 월드가 90도 돌아가 있어 소품만 되세운다
          sp.scale.set((TILE * widthT) / tex.width);
          sp.x = i * TILE + offX;
          sp.y = PAD_TOP + j * th + offY + th * 0.5;
          sp.zIndex = sp.y;
          groundProps.addChild(sp);
        }
      }
      // 손으로 배치한 캠프·다리·천막 — 산포 나무 위에 얹는다
      for (const pr of placed) {
        const tex = placedTex.get(pr.name);
        if (!tex) continue;
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 1);
        if (m.vertical) sp.rotation = Math.PI / 2; // 세로 맵: 월드가 90도 돌아가 있어 소품만 되세운다
        sp.scale.set((TILE * pr.w) / tex.width);
        sp.x = pr.x * TILE;
        sp.y = PAD_TOP + (pr.y + halfH / FP) * th + sp.height * 0.34;
        sp.zIndex = sp.y;
        groundProps.addChild(sp);
      }
      return;
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
        if (m.vertical) sp.rotation = Math.PI / 2; // 세로 맵: 월드가 90도 돌아가 있어 소품만 되세운다
        sp.scale.set(((inBand ? TILE * 0.85 : TILE * 1.5) / tex.width));
        sp.x = i * TILE + ((h >>> 4) % TILE);
        sp.y = PAD_TOP + j * th + ((h >>> 8) % Math.max(1, Math.floor(th))) + th * 0.5;
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
        if (m.vertical) sp.rotation = Math.PI / 2; // 세로 맵: 월드가 90도 돌아가 있어 소품만 되세운다
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

  /*
   * WebGL 컨텍스트가 날아갔다 돌아오면 지형을 다시 깐다.
   *
   * 컨텍스트가 끊기면 GPU 에 올라가 있던 텍스처가 통째로 사라진다. Pixi 가
   * 대부분 알아서 복구하지만, 시트에서 잘라 쓴 Wang 타일처럼 소스를 공유하는
   * 텍스처는 복구가 어긋나 「타일이 단색 덩어리로 보이는」 상태가 남곤 했다.
   * 유닛은 멀쩡한데 바닥만 뭉개져 보이면 이 경우다 — 그때 다시 깔아 준다.
   */
  app.canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault(); // 기본 동작을 막아야 복구 이벤트가 온다
    console.warn('[desertlike] WebGL 컨텍스트 손실 — 복구 대기');
  });
  app.canvas.addEventListener('webglcontextrestored', () => {
    console.warn(`[desertlike] WebGL 컨텍스트 복구 — 텍스처 ${texSources.size}개 재업로드`);
    for (const src of texSources) src.update(); // GPU 사본 강제 재생성
    buildGroundTiles();
    rebuildClouds();
  });
  drawGround(ground, tiled());

  const sprites = new Map<number, Sprite>();
  /** 스프라이트 id → defId. 유닛이 사라진 뒤(=사망) 어떤 소리를 낼지 알아야 해서 따로 들고 있는다. */
  const spriteDefId = new Map<number, string>();
  // 전향(인형의 실) 감지: 스폰 시 팀을 기억해뒀다가 달라지면 표식을 남긴다
  const spriteTeam = new Map<number, 0 | 1 | 2>();
  const charmedIds = new Set<number>();
  const zoneSprites = new Map<number, { sp: Sprite; born: number }>();
  const meteorCraterSprites = new Map<number, { sp: Sprite; born: number }>();
  const meteorSprites = new Map<string, Sprite>();
  /** true=직전 프레임에 낙하 중. true→false 전환이 실제 착탄 순간이다. */
  const meteorWasFalling = new Map<string, boolean>();
  const prevPos = new Map<number, { x: number; y: number }>();
  /** 보급 마차 이동 추적 (캠페인 레이어가 심 밖에서 움직여서 별도 추적). */
  const cartMotion = new Map<number, { x: number; until: number }>();
  const unitFx = new Map<number, UnitFx>();
  const projectiles: Projectile[] = [];
  const projPool: Sprite[] = []; // 투사체 스프라이트 재사용 풀
  const impacts: Impact[] = [];
  /** 「정각의 일격」 치명타 표시 — 떠올랐다 사라지는 텍스트 풀. */
  const critTexts: { t: Text; until: number; x: number; y: number; start: number }[] = [];
  /** 출정 레인 표시 (두 갈래 맵). */
  let deployLanes: { y: number; label: string; hold?: boolean; x?: number; r?: number }[] | null = null;
  /** 적 진입 예고 (마을 방어전) — 숲길 입구에서 마을 쪽으로 흐르는 화살표. */
  let laneWarns: { x: number; y: number; toX: number; toY: number; label: string }[] | null = null;
  const warnLabels: Text[] = [];
  /** 레인 이름표 — 출정구 옆에 상시 떠 있어 「여길 눌러라」가 읽힌다. */
  const laneLabels: Text[] = [];
  let deployChosenIdx = -1;
  /** 내리꽂기: 전체 연출 길이와 "착지" 시점 비율 (앞 40% 상승, 뒤 60% 급강하). */
  const DIVE_MS = 430;
  const DIVE_DOWN_AT = 0.55;
  /** 착지 흙먼지 (튀어오르는 파편). */
  const diveDusts: { x: number; y: number; start: number; r: number; feather?: boolean }[] = [];
  /** 시전 이펙트 그림 (스프라이트) — 떴다 커지며 사라진다. */
  const castFxSprites: { sp: Sprite; start: number; until: number; r: number }[] = [];
  /** 스킬 종류 → 이펙트 그림 키. 없으면 코드 도형 연출만 나간다. */
  const CAST_FX_OF: Record<string, string> = {
    wardShield: 'bark', selfShield: 'bark',
    regenAura: 'regen', hasteAlly: 'regen',
    airTaunt: 'roar', ram: 'roar',
  };
  /** 「나무껍질 장막」 — 잎사귀가 솟아 감싸는 연출. */
  const barkBursts: { x: number; y: number; start: number; r: number }[] = [];
  /** 「커튼콜」 — 무대가 열려 빨아들이다 닫히는 연출. */
  const curtainFx: { x: number; y: number; start: number; r: number; close: number; sp?: Sprite }[] = [];
  /** 열려 있는 무대 (sim 좌표 키 → 화면 좌표). 사라지면 닫힘 연출로 넘긴다. */
  const curtainSeen = new Map<string, { x: number; y: number; r: number; closed: number }>();
  const curtainSprites = new Map<string, Sprite>();
  /** 「들이받기」 — 출발점에서 목표까지 그어지는 속도선과 잔상. */
  const ramTrails: { x0: number; y0: number; x1: number; y1: number; start: number }[] = [];
  /** 「실의 폭풍」 — 위에서 떨어져 내리는 실 그물. */
  const threadNets: { x: number; y: number; start: number; r: number }[] = [];
  /** 「가호」 시전 순간 — 시전자에서 솟아오르는 빛기둥과 흩날리는 성광 (900ms). */
  const blessBursts: { x: number; y: number; start: number; r: number }[] = [];
  /** 「질풍의 노래」(에버그린) — 초록 바람이 소용돌이치며 잎과 음표를 실어 나른다. */
  const galeSongs: { x: number; y: number; start: number; r: number }[] = [];
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
  const castSfxOf = (
    a: { kind?: string; fxZone?: string; zone?: { kind?: string } } | undefined,
    casterId?: string,
  ): SfxKey => {
    const z = a?.fxZone ?? a?.zone?.kind;
    if (z === 'stormwing') return 'cast_storm';
    if (z === 'moonveil') return 'cast_moonveil';
    // 확장 로스터: 스킬 종류로 소리를 고른다
    if (a?.kind === 'curtainCall') return 'cast_curtain';
    if (a?.kind === 'puppetShow') return 'cast_puppetshow';
    if (a?.kind === 'summonAtFoe') return 'cast_puppetarmy';
    if (a?.kind === 'threadStorm') return 'cast_threadstorm';
    if (a?.kind === 'randomBuff') return 'cast_hat';
    if (a?.kind === 'airTaunt' || a?.kind === 'ram') return 'cast_roar';
    if (a?.kind === 'wardShield' || a?.kind === 'regenAura' || a?.kind === 'selfShield') return 'cast_bark';
    if (a?.kind === 'diveStrike' || a?.kind === 'debuffZone') return 'cast_moonveil';
    if (a?.kind === 'leap') return 'cast_leap';
    if (a?.kind === 'levitate') return 'cast_gravity';
    if (casterId === 'c_kael'
      && (a?.kind === 'taunt' || a?.kind === 'invuln' || a?.kind === 'reflect')) return 'cast_bulwark';
    if (a?.kind === 'hasteAlly') return casterId === 'c_evergreen' ? 'cast_windsong' : 'cast_bless';
    if (a?.kind === 'critAura') return 'cast_bless';
    if (a?.kind === 'slowFoe' || a?.kind === 'timelock') return 'cast_ice';
    if (a?.kind === 'burrow') return 'cast_quake';
    if (a?.kind === 'meteor') return 'cast_meteor';
    if (z === 'silverrain') return 'cast_silverrain';
    if (z === 'blaze' || z === 'hellfire' || z === 'fireburst') return 'cast_fire';
    if (z === 'frost' || a?.kind === 'freeze') return 'cast_ice';
    if (z === 'quake' || a?.kind === 'slowfield') return 'cast_quake';
    if (a?.kind === 'ground') return 'cast_gravity';
    if (z === 'feast' || z === 'grave') return 'cast_dark';
    if (a?.kind === 'fear') return 'cast_bell';
    if (a?.kind === 'confuse' || a?.kind === 'charm') return 'cast_puppet';
    if (a?.kind === 'seduce' || a?.kind === 'summonMare') return 'cast_charm';
    if (a?.kind === 'allyarmor') return 'cast_bless';
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
    c_alice_hero: 'death_alice',
    p_succubus: 'die_succubus', // 예쁘게 스러진다 — 전용 사망음
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
  /**
   * 카메라가 훑을 수 있는 전체 크기 (화면 기준).
   * 세로 맵은 컨테이너가 -90도 돌아 있어 가로·세로가 뒤바뀐다:
   * 화면 가로 = 월드 높이(코리도어 폭), 화면 세로 = 월드 길이(진행축).
   */
  function scrollW(): number {
    return curMap.vertical ? worldH() : worldW();
  }
  function scrollH(): number {
    return curMap.vertical ? worldW() : worldH();
  }
  /**
   * 지금 화면에 보이는 「진행축(월드 x)」 범위.
   *
   * 세로 맵은 컨테이너가 -90도 돌아 있고 진행 방향이 아래→위라,
   * 화면 세로 좌표가  (진행길이 - camY - 월드x) * zoom  으로 나온다.
   * 즉 월드 x 는 camY 와 **반대 방향**이다. 이걸 놓치고 [camY, camY+높이] 로
   * 견주면 맵 한가운데만 맞고 양 끝은 통째로 잘려 나간다.
   */
  function viewAxisX(): [number, number] {
    if (!curMap.vertical) return [camX, camX + visibleW()];
    const hi = scrollH() - camY;
    return [hi - visibleH(), hi];
  }
  function clampCam(): void {
    /*
     * 배경 그림 맵은 「그림이 있는 띠」 밖으로 못 나가게 막는다.
     *
     * sy() 가 위아래로 PAD_TOP·PAD_BOTTOM 만큼 띄워 놓기 때문에, 화면을 덮을
     * 만큼 확대해도 카메라가 그 여백 쪽으로 밀리면 갈색 배경이 드러났다
     * (5·6라운드에서 왼쪽에 34px 띠가 남았다). 그 축만 여백만큼 좁힌다 —
     * 세로 맵은 컨테이너가 돌아 있어 그 축이 camX 다.
     */
    const pad = curMap.bgImage;
    const lo0 = pad && curMap.vertical ? PAD_TOP : 0;
    const hi0 = pad && curMap.vertical ? PAD_BOTTOM : 0;
    const lo1 = pad && !curMap.vertical ? PAD_TOP : 0;
    const hi1 = pad && !curMap.vertical ? PAD_BOTTOM : 0;
    const maxX = Math.max(lo0, scrollW() - hi0 - visibleW());
    camX = Math.min(Math.max(camX, lo0), maxX);
    const maxY = Math.max(lo1, scrollH() - hi1 - visibleH());
    camY = Math.min(Math.max(camY, lo1), maxY);
  }
  function applyCamera(): void {
    if (curMap.vertical) {
      // 세로 맵: 컨테이너를 -90도 돌린다. 시뮬 x(진행축)가 화면 세로가 되고
      // 진행 방향은 아래에서 위로 향한다.
      const sw = scrollW();
      const sh = scrollH();
      // 세로가 긴 맵이라 화면 높이에 맞추면 너무 작아진다 — 가로 기준으로도 재고 큰 쪽을 쓴다
      const fitH = app.screen.height / sh;
      const fitW = app.screen.width / sw;
      const fit = Math.min(2.4, Math.max(0.35, Math.max(fitH, fitW * 0.9)));
      /*
       * 축소 하한 = 「화면을 맵이 덮는」 배율.
       *
       * 예전엔 「맵 전체가 들어오는」 배율까지 허용했는데, 맵과 화면의 비율이
       * 다르면 남는 쪽에 갈색 배경이 그대로 드러났다. 여기서 막으면 맵 밖이
       * 아예 안 보인다 — 전체 조망은 미니맵이 맡는다.
       */
      // 세로 맵은 축이 돌아 있다 — 그림이 실제로 덮는 길이는 sw(=worldH) 쪽에서
      // 위아래 패딩을 뺀 값이다
      const drawnW = curMap.bgImage ? sw - PAD_TOP - PAD_BOTTOM : sw;
      const coverZoom = Math.max(app.screen.width / drawnW, app.screen.height / sh);
      zoom = Math.max(coverZoom, fit * userZoom);
      clampCam();
      world.rotation = -Math.PI / 2;
      world.scale.set(zoom);
      // 회전 기준점 보정: 월드 (0,0) 이 화면 좌하단으로 가므로 세로로 한 번 내린다
      world.x = sw * zoom <= app.screen.width
        ? (app.screen.width - sw * zoom) / 2 : -camX * zoom;
      world.y = (sh * zoom <= app.screen.height
        ? (app.screen.height - sh * zoom) / 2 : -camY * zoom) + sh * zoom;
      return;
    }
    world.rotation = 0;
    const fit = Math.min(2.4, Math.max(0.8, app.screen.height / worldH()));
    // 세로 맵과 같은 규칙 — 맵 밖(갈색 배경)이 드러나지 않는 선까지만 축소한다.
    // 잿불 숲처럼 가로로 긴 맵은 원래 세로가 꽉 차 있어 이 값이 걸리지 않는다.
    const drawnH = curMap.bgImage ? worldH() - PAD_TOP - PAD_BOTTOM : worldH();
    const coverZoom = Math.max(app.screen.width / worldW(), app.screen.height / drawnH);
    zoom = Math.max(coverZoom, fit * userZoom);
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
    s_mushroom_bomber: 0xb07fe0,  // 레쉬 — 보라 (포자 구름과 같은 계열)
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
    // 소리 호출부는 진행축 좌표(sx(e.x))를 넘긴다 — 세로 맵은 그 축이 화면 세로이므로
    // camY·visibleH 로 알려야 한다. 안 그러면 확대할 때 소리가 통째로 잘린다.
    const [av0, av1] = viewAxisX();
    audio?.setViewport(av0, av1);
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
    const meteorZoneSeen = new Set<number>();
    const meteorSpriteSeen = new Set<string>();
    for (const z of g.zones) {
      /*
       * 지형 해저드(진흙길·덩굴길)는 그림을 그리지 않는다.
       * 작가가 지형 배경에 이미 그려 넣은 자리라, 여기서 데칼·타원을 또 얹으면
       * 그림 위에 색판이 덧칠된다. 효과(둔화·지속피해)는 심에서 그대로 돈다.
       */
      if (z.kind === 'mud' || z.kind === 'vinepath') continue;
      const remain = z.untilTick - g.tick;
      if (remain <= 0) continue;
      // 생성 직후 0.3초 확대 등장, 만료 0.5초 전부터 페이드아웃 + 은은한 맥동
      const fade = Math.min(1, remain / 10);
      const pulse = 0.88 + 0.12 * Math.sin(now * 0.003 + z.id * 2.1);
      const cx = sx(z.x), cy = sy(z.y);
      const r = (z.radius / FP) * TILE;
      if (z.kind === 'meteor') {
        /*
         * 「메테오 스트라이크」 — 그을린 땅 위로 운석이 쉬지 않고 떨어진다.
         * 피해는 시전 순간 한 번에 끝났으므로 여기는 순수 연출이다.
         * 운석마다 z.id 와 번호로 고정된 유사난수를 뽑아, 같은 장판이면
         * 프레임이 바뀌어도 같은 자리에 같은 리듬으로 떨어지게 한다.
         */
        const rnd = (n: number): number => {
          const v = Math.sin(z.id * 127.1 + n * 311.7) * 43758.5453;
          return v - Math.floor(v);
        };
        /*
         * 세로 맵은 월드가 -90도 돌아 있다 (world.rotation = -PI/2) — 월드 +x 가
         * 화면의 「위」, 월드 +y 가 화면의 「오른쪽」이 된다. 운석은 화면 기준으로
         * 위에서 떨어져야 하므로 낙하 축을 맵 방향에 맞춰 돌린다.
         * (이걸 안 하면 세로 맵에서 운석이 옆에서 날아든다 — 14 「걸어가는 숲」)
         * 그을린 자국도 마찬가지다: 세로 맵은 원근 압축(Y_SQUASH)을 안 쓰므로 동그랗다.
         */
        const vert = curMap.vertical === true;
        const sq = vert ? 1 : 0.62;
        /** 착탄점에서 「화면 위쪽」으로 d 픽셀. */
        const up = (bx: number, by: number, d: number): [number, number] =>
          (vert ? [bx + d, by] : [bx, by - d]);
        /** 「화면 가로」로 d 픽셀 (불꼬리를 살짝 비껴 그린다). */
        const side = (bx: number, by: number, d: number): [number, number] =>
          (vert ? [bx, by + d] : [bx + d, by]);
        meteorZoneSeen.add(z.id);
        // 픽셀랩 착탄 데칼: 룬 경고진 + 검게 탄 바닥 + 중심부 용암 균열.
        if (meteorZoneTex) {
          let mz = meteorCraterSprites.get(z.id);
          if (!mz) {
            const sp = new Sprite(meteorZoneTex);
            sp.anchor.set(0.5);
            mz = { sp, born: now };
            meteorCraterSprites.set(z.id, mz);
            zoneLayer.addChild(sp);
          }
          const age = now - mz.born;
          const appear = Math.min(1, age / 260);
          const scale = (r * 2.25) / meteorZoneTex.width;
          mz.sp.x = cx;
          mz.sp.y = cy;
          // 세로 맵에서는 월드 회전을 되감아 룬 문양이 눕지 않게 한다.
          mz.sp.rotation = vert ? Math.PI / 2 : 0;
          mz.sp.scale.set(scale * appear, scale * (vert ? 1 : 0.9) * appear);
          mz.sp.alpha = fade * (0.72 + 0.18 * pulse);
        }
        // 데칼 아래에 깔리는 넓은 위험 범위와 맥동하는 외곽 경고선.
        zonesGr.ellipse(cx, cy, r, r * sq).fill({ color: 0x210907, alpha: 0.24 * fade });
        zonesGr.ellipse(cx, cy, r * (0.96 + pulse * 0.04), r * sq * (0.96 + pulse * 0.04))
          .stroke({ color: 0xff3d18, width: 3.2, alpha: 0.62 * fade });
        zonesGr.ellipse(cx, cy, r * 0.74, r * sq * 0.74)
          .stroke({ color: 0xffb13b, width: 1.6, alpha: 0.42 * pulse * fade });

        // 작은 불티 14개 대신, 화면을 가르는 큼지막한 운석 7개를 쏟아 붓는다.
        const COUNT = 7;
        for (let k = 0; k < COUNT; k++) {
          const ang = rnd(k * 4) * Math.PI * 2;
          const rad = Math.sqrt(rnd(k * 4 + 1)) * r;
          const tx = cx + Math.cos(ang) * rad;
          const ty = cy + Math.sin(ang) * rad * sq;
          const period = 920 + rnd(k * 4 + 2) * 760;
          const t = (((now + rnd(k * 4 + 3) * period) % period) / period);
          const key = `${z.id}:${k}`;
          const falling = t < 0.66;
          const wasFalling = meteorWasFalling.get(key);
          meteorWasFalling.set(key, falling);
          if (falling) {
            // 낙하 — 큰 스프라이트가 멀리서는 작고, 착탄 직전에는 화면을 덮을 만큼 커진다.
            const p = t / 0.66;
            const eased = p * p * (3 - 2 * p);
            const [mx, my] = up(tx, ty, (1 - eased) * (r * 1.75 + 150));
            const [mx2, my2] = side(mx, my, (1 - p) * -22);
            if (meteorTex) {
              meteorSpriteSeen.add(key);
              let sp = meteorSprites.get(key);
              if (!sp) {
                sp = new Sprite(meteorTex);
                sp.anchor.set(0.5);
                meteorSprites.set(key, sp);
                meteorLayer.addChild(sp);
              }
              const pxSize = (k === 0 ? 76 : 46 + rnd(k * 9 + 5) * 24) * (0.55 + eased * 0.75);
              const sc = pxSize / meteorTex.width;
              sp.visible = true;
              sp.x = mx2;
              sp.y = my2;
              // 원본은 ↘ 방향. 화면 아래로 꽂히도록 회전하고 세로 맵의 월드 회전을 보정한다.
              sp.rotation = Math.PI / 4 + (vert ? Math.PI / 2 : 0);
              sp.scale.set(sc);
              sp.alpha = fade;
            }
            // 거대한 불꼬리 뒤로 흩날리는 백열 파편.
            const [tlx0, tly0] = up(mx2, my2, 42 + eased * 22);
            const [tlx, tly] = side(tlx0, tly0, -10);
            zonesGr.moveTo(tlx, tly).lineTo(mx2, my2)
              .stroke({ color: 0xff8a24, width: 6 + eased * 5, alpha: 0.26 * fade });
            zonesGr.moveTo(tlx, tly).lineTo(mx2, my2)
              .stroke({ color: 0xffe39a, width: 2.2 + eased * 2, alpha: 0.7 * fade });
          } else {
            const sp = meteorSprites.get(key);
            if (sp) sp.visible = false;
            if (t < 0.86) {
              // 착탄 — 중심 백열 섬광, 용암색 충격파, 검은 잔해가 차례로 퍼진다.
              const p = (t - 0.66) / 0.2;
              const ringR = 12 + r * 0.32 * p;
              fx.ellipse(tx, ty, ringR, ringR * sq)
                .stroke({ color: 0xffd27a, width: 7 * (1 - p), alpha: 0.92 * (1 - p) * fade });
              fx.circle(tx, ty, 18 * (1 - p) + 4)
                .fill({ color: p < 0.45 ? 0xffffff : 0xff6a20, alpha: 0.9 * (1 - p) * fade });
              for (let q = 0; q < 6; q++) {
                const qa = rnd(k * 40 + q) * Math.PI * 2;
                const qd = (10 + 38 * p) * (0.65 + rnd(k * 40 + q + 10) * 0.5);
                fx.circle(tx + Math.cos(qa) * qd, ty + Math.sin(qa) * qd * sq, 2.5 * (1 - p))
                  .fill({ color: q % 2 ? 0x2a1710 : 0xff7a2e, alpha: 0.8 * (1 - p) * fade });
              }
            }
            // 한 낙하가 착탄으로 넘어가는 바로 그 프레임에만 소리와 큰 충격파를 예약한다.
            if (wasFalling === true && t < 0.86) {
              sfx('meteor_impact', tx, k === 0 ? 1 : 0.68);
              impacts.push({ x: tx, y: ty, start: now, radius: k === 0 ? 92 : 58, color: 0xfff0c0 });
              impacts.push({ x: tx, y: ty, start: now + 70, radius: k === 0 ? 124 : 78, color: 0xff5a22 });
            }
          }
        }
        continue;
      }
      if (z.kind === 'silverrain') {
        /*
         * 「은빛 화살비」(에버그린) — 전용 연출이 없어 옅은 타원만 깔렸고,
         * 12초짜리 궁극기를 쓰는지도 몰랐다. 하늘에서 은화살이 쉬지 않고
         * 꽂히고, 바닥에는 달빛 고리가 돈다.
         *
         * 좌표는 화면 기준이다 — 세로 맵은 월드가 -90도 돌아 있어 그냥 그리면
         * 화살이 옆에서 날아든다 (메테오와 같은 자).
         */
        const vert = curMap.vertical === true;
        const sq = vert ? 1 : 0.62;
        const up = (bx: number, by: number, d: number): [number, number] =>
          (vert ? [bx + d, by] : [bx, by - d]);
        const rnd = (n: number): number => {
          const v = Math.sin(z.id * 91.7 + n * 233.3) * 43758.5453;
          return v - Math.floor(v);
        };
        // 바닥: 달빛 고리 두 겹이 반대로 돈다
        zonesGr.ellipse(cx, cy, r, r * sq).fill({ color: 0x8fa8d8, alpha: 0.10 * fade });
        for (const [rr, spd, w] of [[r, 0.0011, 2], [r * 0.72, -0.0017, 1.5]] as const) {
          const seg = 26;
          for (let k = 0; k < seg; k++) {
            if ((k + Math.floor(now * spd * 12)) % 3 === 0) continue;   // 점선으로 돈다
            const a0 = now * spd + (k / seg) * Math.PI * 2;
            zonesGr.circle(cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr * sq, w)
              .fill({ color: 0xdfe8ff, alpha: 0.75 * fade });
          }
        }
        // 쏟아지는 은화살 — 착탄점마다 제 리듬으로 떨어진다
        const N = 18;
        for (let k = 0; k < N; k++) {
          const ang = rnd(k * 3) * Math.PI * 2;
          const rad = Math.sqrt(rnd(k * 3 + 1)) * r;
          const tx = cx + Math.cos(ang) * rad;
          const ty = cy + Math.sin(ang) * rad * sq;
          const period = 460 + rnd(k * 3 + 2) * 420;
          const t = (((now + rnd(k * 3 + 2) * period * 3) % period) / period);
          if (t < 0.7) {
            const p = t / 0.7;
            const [ax, ay] = up(tx, ty, (1 - p) * (r * 1.1 + 120));
            const [bx, by] = up(ax, ay, 16 + (1 - p) * 10);
            // 화살대 + 은빛 머리
            zonesGr.moveTo(bx, by).lineTo(ax, ay)
              .stroke({ color: 0xdfe8ff, width: 1.8, alpha: (0.35 + p * 0.5) * fade });
            fx.circle(ax, ay, 1.9).fill({ color: 0xffffff, alpha: 0.9 * fade });
          } else if (t < 0.86) {
            // 착탄 — 짧게 퍼지는 은빛 파문
            const p = (t - 0.7) / 0.16;
            fx.ellipse(tx, ty, 3 + 15 * p, (3 + 15 * p) * sq)
              .stroke({ color: 0xeaf2ff, width: 2 * (1 - p), alpha: 0.85 * (1 - p) * fade });
          }
        }
        continue;
      }
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
          : z.kind === 'venom' ? 0xb6e02a // 역병 늪 — 형광 산성 노랑초록 (포자보다 밝고 독하게)
          : z.kind === 'grave' ? 0x7a5fd0 // 사후의 경계
          : z.kind === 'blaze' ? 0xff7a2e // 블레이즈 — 불구덩이
          : z.kind === 'quake' ? 0xa8845c // 어스퀘이크 — 갈라진 땅
          : z.kind === 'frost' ? 0x9fdcff // 블리자드 — 얼음
          : z.kind === 'gravity' ? 0xb06ad0 // 리버스그라비티 — 중력진
          : z.kind === 'hellfire' ? 0x7fe89a // 지옥불 — 저주 화염
          : z.kind === 'fireburst' ? 0xffa03d // 화염구 폭발
          : z.kind === 'feast' ? 0x9a5fd0 // 망자의 만찬
          : z.kind === 'stormwing' ? 0x4a4a68 // 검은 폭풍 — 잿빛 도는 흑청
          : z.kind === 'moonveil' ? 0xa87fd0 // 인분의 장막
          : z.kind === 'threadstorm' ? 0xc8d4e8 // 실의 폭풍
          // 은빛 화살비는 위에서 전용 연출로 빠진다 (여기 오지 않는다)
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
    for (const [id, mz] of meteorCraterSprites) {
      if (!meteorZoneSeen.has(id)) {
        mz.sp.destroy();
        meteorCraterSprites.delete(id);
      }
    }
    for (const [key, sp] of meteorSprites) {
      if (!meteorSpriteSeen.has(key)) {
        sp.destroy();
        meteorSprites.delete(key);
        meteorWasFalling.delete(key);
      }
    }
    const seen = new Set<number>();
    const byId = new Map<number, (typeof g.entities)[number]>();
    for (const e of g.entities) if (e.alive) byId.set(e.id, e);

    for (const e of g.entities) {
      if (!e.alive) continue;
      seen.add(e.id);
      // 업그레이드·변신 반영본(defOv)이 있으면 그쪽을 본다.
      // 기본 정의만 보면 서큐버스가 악마로 변신해 flying 이 켜져도 렌더는 모른 채
      // 땅에 붙어 있었다 (떠오르지도, 공중 레이어로 올라가지도 않았다).
      const d = (e.defOv ?? DEFS[e.defId])!;
      let sp = sprites.get(e.id);
      if (!sp) {
        // 적(팀1) 건물 스킨: 캠페인 명시 스킨 우선, 장난감 나라는 자동 — 아군 기지는 그대로.
        // 예외: 둥지 맵의 아군 넥서스는 「둥지」 그림 (지켜야 할 대상이 한눈에 보이게)
        const autoSkin = curMap?.id === 'toybox' ? 'toy' : null;
        const skin = enemySkin ?? autoSkin;
        const toyKey = curMap?.id === 'owlkeep' && e.defId === 'nexus'
          // 올빼미 성채: 우리는 올빼미 둥지, 적은 뼈 야영지
          ? (e.team === 0 ? 'nexus_owlnest' : 'nexus_bonecamp')
          : curMap?.id === 'nest' && e.team === 0 && e.defId === 'nexus'
          ? 'nexus_nest'
          : curMap?.id === 'greatroot' && e.defId === 'nexus'
            // 걸어가는 숲: 우리는 엘프 야영지, 적은 언덕 위 악마 요새
            ? (e.team === 0 ? 'nexus_elfcamp' : 'nexus_demon')
            : curMap?.id === 'ashroad' && e.defId === 'nexus'
              ? (e.team === 0 ? 'nexus_forestcamp' : 'nexus_demon')
            /*
             * 적(팀1) 기지 스킨. 캠페인이 명시한 enemySkin 이 맵 자동 규칙보다 우선이다 —
             * 예전엔 잿불 숲 규칙이 먼저 걸려 1막에 'bone' 을 지정해도 무시됐다.
             */
            : skin && e.team === 1 && (e.defId === 'tower' || e.defId === 'nexus')
              ? `${e.defId}_${skin}`
            // 잿불 숲: 맵 절반을 기준으로 왼쪽은 살아 있는 숲, 오른쪽은 불에 탄 숲이다.
            // 양쪽 기지가 같은 그림이면 어느 쪽이 내 진영인지 한눈에 안 들어와서,
            // 오른쪽만 잿빛으로 갈아 끼운다 (왼쪽은 기본 그림 유지).
            : curMap?.id === 'plains' && e.team === 1
              && (e.defId === 'nexus' || e.defId === 'tower')
              ? `${e.defId}_ash` : undefined;
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
        const sizeMul = (ASSET_SIZE_MUL[e.defId] ?? 1) * (toyKey ? (SKIN_SIZE_MUL[toyKey] ?? 1) : 1);
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
          lungeStart: 0, lungeDx: 0, lungeDy: 0, atkAir: false, diveStart: 0, diveUntil: 0, diveFeather: false, diveDx: 0, diveDy: 0,
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
            /*
             * 다중 사격(에버그린 삼연사): 심은 셋을 동시에 때리는데 화면엔 한 발만
             * 날아가면 「왜 셋이 닳지?」가 된다. 가까운 적 순으로 나머지 화살도 띄운다.
             * 순수 연출이라 맞는 대상과 정확히 일치하지 않아도 된다.
             */
            const extra = (d.weapon.multiTargets ?? 1) - 1;
            if (extra > 0 && target) {
              const reach = d.weapon.range + d.radius;
              const near: { v: typeof target; d2: number }[] = [];
              for (const v of g.entities) {
                if (!v.alive || v.team === e.team || v.id === target.id || v.owner < -1) continue;
                const vd = DEFS[v.defId];
                if (!vd || vd.tier === 'structure') continue;
                const ddx = v.x - e.x, ddy = v.y - e.y;
                const d2 = ddx * ddx + ddy * ddy;
                if (d2 > (reach + vd.radius) * (reach + vd.radius)) continue;
                near.push({ v, d2 });
              }
              near.sort((a, b) => a.d2 - b.d2);
              for (const q of near.slice(0, extra)) {
                const qx = sx(q.v.x), qy = sy(q.v.y);
                projectiles.push({
                  x0: fromX, y0: fromY - sp.height * 0.55,
                  x1: qx, y1: qy - 8,
                  start: now + 40, dur: 100 + Math.hypot(qx - fromX, qy - fromY) * 1.1,
                  color: raceColor(e.defId),
                  splash: 0,
                  ...(PROJECTILE_OF[e.defId] ? { kind: PROJECTILE_OF[e.defId] } : {}),
                  spin0: (q.v.id % 17) * 0.37,
                });
              }
            }
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
          sfx(d.id === 'c_evergreen' ? 'atk_bow_triple'
            : d.id === 'c_kael' ? 'atk_spear'
            : d.id === 'p_bone_dragon' ? 'atk_bone'
            : d.id === 's_thorn_witch' ? 'atk_thorn'
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
        // ── 확장 로스터 스킬 연출 ──────────────────────────────────────
        // 오라·장막류는 시전자에게서 고리가 퍼지고, 색으로 성격을 구분한다.
        {
          const R = (castSkill?.auraRadius ?? castSkill?.splash ?? 0) / FP * TILE;
          const ring = (rad: number, color: number, delay = 0): void => {
            impacts.push({ x: cx, y: cy, start: now + delay, radius: rad, color });
          };
          // 전용 그림이 있는 스킬은 시전 자리에 이미지를 띄운다
          const fxKey = castKind ? CAST_FX_OF[castKind] : undefined;
          const fxTex = fxKey ? castFxTex.get(fxKey) : undefined;
          if (fxTex) {
            const sp2 = new Sprite(fxTex);
            sp2.anchor.set(0.5);
            sp2.x = cx;
            sp2.y = cy;
            sp2.zIndex = Number.MAX_SAFE_INTEGER - 1;
            units.addChild(sp2);
            castFxSprites.push({ sp: sp2, start: now, until: now + 700, r: Math.max(R, 46) });
          }
          if (castKind === 'wardShield') {          // 나무껍질 장막 — 초록 방벽
            ring(Math.max(R, 40), 0x6fe06a);
            ring(Math.max(R, 40) * 0.7, 0xc8f5a0, 90);
            barkBursts.push({ x: cx, y: cy, start: now, r: Math.max(R, 40) });
          } else if (castKind === 'regenAura') {    // 생명의 숨결 — 연둣빛 파문
            ring(Math.max(R, 44), 0x9fef7a);
            ring(Math.max(R, 44) * 0.62, 0xe0ffc0, 110);
          } else if (castKind === 'selfShield') {   // 비늘 방벽 — 금빛 껍질
            ring(46, 0xffd86a);
            ring(30, 0xfff2c0, 80);
          } else if (castKind === 'airTaunt') {     // 창공의 포효 — 붉은 충격파
            ring(Math.max(R, 50), 0xff8a5a);
            ring(Math.max(R, 50) * 1.25, 0xffc9a0, 100);
            ring(Math.max(R, 50) * 1.5, 0xff6a3a, 200);
          } else if (castKind === 'ram') {          // 들이받기 — 속도선을 남기고 꽂힌다
            ring(52, 0xffffff);
            ring(34, 0xffe0a0, 70);
            ring(70, 0xffd06a, 150);
            // 떠나온 자리(vfx 에 남은 복귀 좌표)에서 지금 위치까지 선을 긋는다
            ramTrails.push({ x0: sx(e.returnX), y0: sy(e.returnY), x1: sx(e.x), y1: sy(e.y), start: now });
          } else if (castKind === 'leap') {         // 도약 강습 — 뛰어온 자국 + 착지 파문
            ring(Math.max(R, 30), 0xffe9b0);
            ring(Math.max(R, 30) * 0.62, 0xffffff, 80);
            /*
             * 심이 유닛을 착지 지점으로 이미 옮겨 놨으므로, 직전 프레임 좌표가
             * 곧 「뛰기 전 자리」다 (prevPos 는 프레임 끝에서 갱신된다).
             * 그 사이를 속도선으로 이어야 「뛰었다」가 보인다 — 이게 없으면
             * 유닛이 그냥 순간이동한 것처럼 보인다.
             */
            const from = prevPos.get(e.id);
            if (from && (from.x !== e.x || from.y !== e.y)) {
              ramTrails.push({ x0: sx(from.x), y0: sy(from.y), x1: sx(e.x), y1: sy(e.y), start: now });
            }
          } else if (castKind === 'threadStorm') {  // 실의 폭풍 — 은빛 실 그물
            ring(Math.max(R, 60), 0xdfe4f0);
            ring(Math.max(R, 60) * 0.72, 0xb0b8d0, 120);
            threadNets.push({ x: cx, y: cy, start: now, r: Math.max(R, 60) });
          } else if (castKind === 'summonAtFoe') {  // 호두까기 병단 — 목빛 파문
            ring(46, 0xd8a05a);
            ring(30, 0xffd8a0, 90);
          } else if (castKind === 'levitate') {     // 부양 — 보랏빛 상승 고리
            ring(Math.max(R, 46), 0xb08ae0);
            ring(Math.max(R, 46) * 0.66, 0xe0c8ff, 110);
          } else if (castKind === 'randomBuff') {   // 모자 바꾸기 — 무지개 팡
            ring(40, 0xffe14d);
            ring(28, 0xff7ac8, 80);
            ring(52, 0x7ad0ff, 160);
          } else if (castKind === 'puppetShow') {   // 인형극 — 실이 튕기는 금빛 파문
            ring(48, 0xffd86a);
            ring(32, 0xfff2c0, 90);
          } else if (castKind === 'diveStrike') {   // 그림자 도약 — 보라 섬광
            ring(44, 0x9a6ad0);
            ring(28, 0xe0c0ff, 70);
          } else if (castKind === 'debuffZone') {   // 인분의 장막 — 은은한 인분
            ring(Math.max(R, 60), 0xc8a0e8);
            ring(Math.max(R, 60) * 0.7, 0xe8d0ff, 130);
          } else if (castKind === 'hasteAlly') {
            // 에버그린 「질풍의 노래」는 전용 연출 — 공용 노란 고리와 겹치지 않게 나눈다
            if (e.defId === 'c_evergreen') {
              const gr = Math.max(R, 44);
              galeSongs.push({ x: cx, y: cy, start: now, r: gr });
              impacts.push({ x: cx, y: cy, start: now, radius: gr * 0.4, color: 0xd8ffd0 });
              impacts.push({ x: cx, y: cy, start: now + 110, radius: gr * 0.78, color: 0x9ae86a });
              impacts.push({ x: cx, y: cy, start: now + 230, radius: gr * 1.1, color: 0xe8fff0 });
            } else ring(Math.max(R, 40), 0xffe14d);
          } else if (castKind === 'slowFoe') {
            ring(Math.max(R, 44), 0x7ad0ff);
          } else if (castKind === 'critAura') {
            ring(Math.max(R, 44), 0xffb03d);
            ring(Math.max(R, 44) * 0.65, 0xfff0a0, 100);
          } else if (castKind === 'timelock') {
            ring(46, 0xd8f0ff);
            ring(30, 0xffffff, 90);
          } else if (castKind === 'burrow') {
            ring(34, 0xb08c5a);
            diveDusts.push({ x: cx, y: cy, start: now, r: 34 });
          }
        }
        // 「가호」는 링 하나로는 눈에 안 띈다 — 시전자에게서 빛이 터지고
        // 파문이 세 겹으로 퍼져 나가며 축복 범위를 확실히 알린다
        if (castKind === 'allyarmor' && auraR) {
          impacts.push({ x: cx, y: cy, start: now, radius: auraR * 0.35, color: 0xffffff });
          impacts.push({ x: cx, y: cy, start: now + 90, radius: auraR * 0.7, color: 0xd8f0ff });
          impacts.push({ x: cx, y: cy, start: now + 190, radius: auraR * 1.05, color: 0xffe9a8 });
          blessBursts.push({ x: cx, y: cy, start: now, r: auraR });
        }
        // 「내리꽂기」류: 솟구쳤다 내리찍는 전용 연출.
        // 지상 전용 strike(와이번)에 더해, 나는 유닛의 strike 도 포함한다 —
        // 숲올빼미 「급강하」는 대공도 되는 탓에 targets 가 'ground' 가 아니라
        // 전용 연출을 못 받아, 링 하나에 평타 모션만 나오고 있었다.
        /*
         * 「도약 강습」(고우토): 심이 유닛을 착지 지점으로 이미 옮겨 놨다.
         * 그래서 목표까지 날아가는 오프셋은 주지 않고, 제자리에서 솟구쳤다
         * 꽂히는 동작 + 흙먼지만 쓴다 — 뛰어온 자국은 아래 속도선이 그린다.
         */
        const isLeapSlam = castKind === 'leap' && !!castSkill?.damage;
        const isDive = isLeapSlam || (castKind === 'strike' && (castSkill?.targets === 'ground' || d.flying));
        // 맹금이 덮치는 급강하는 흙먼지가 아니라 깃털이 터진다 (공중 목표도 있으니)
        const featherDive = isDive && !isLeapSlam && d.flying && castSkill?.targets !== 'ground';
        if (isDive) {
          vfx.diveStart = now;
          vfx.diveUntil = now + (featherDive ? DIVE_MS * 1.6 : DIVE_MS);
          vfx.diveFeather = featherDive;
          const gy = strikeTarget ? sy(strikeTarget.y) : sy(e.y);
          const gx = strikeTarget ? sx(strikeTarget.x) : sx(e.x);
          // 급강하는 제자리 동작이 아니다 — 목표에게 달려들어 그 자리를 찍고 돌아온다.
          // (심 좌표는 그대로 두고 화면 오프셋만 준다 — 원거리 유닛이 실제로 적진에
          //  박히면 곧바로 죽어버리므로, 이동은 연출로만 표현한다)
          vfx.diveDx = featherDive ? gx - sx(e.x) : 0;
          vfx.diveDy = featherDive ? gy - sy(e.y) : 0;
          const r = castSkill?.splash ? (castSkill.splash / FP) * TILE : 24;
          // 착지 순간(하강 완료 시점)에 맞춰 흙먼지 3겹 + 바깥으로 퍼지는 균열 링
          const land = now + (featherDive ? DIVE_MS * 1.6 : DIVE_MS) * DIVE_DOWN_AT;
          if (featherDive) {
            // 급강하 반경(1.2타일)은 그대로 그리면 너무 작아 눈에 안 들어온다 —
            // 연출만 실제 범위보다 넉넉히 키우고 최소 크기를 보장한다
            const vr = Math.max(r * 2.1, 54);
            impacts.push({ x: gx, y: gy, start: land, radius: vr, color: 0xffffff });
            impacts.push({ x: gx, y: gy, start: land + 55, radius: vr * 0.72, color: 0xfff2d0 });
            impacts.push({ x: gx, y: gy, start: land + 130, radius: vr * 0.45, color: 0xd8c49a });
            impacts.push({ x: gx, y: gy, start: land + 210, radius: vr * 1.25, color: 0xffffff });
          } else {
            impacts.push({ x: gx, y: gy, start: land, radius: r * 1.25, color: 0xd8b98a });
            impacts.push({ x: gx, y: gy, start: land + 70, radius: r * 0.95, color: 0xb08c5a });
            impacts.push({ x: gx, y: gy, start: land + 150, radius: r * 0.6, color: 0x8a6a42 });
            impacts.push({ x: gx, y: gy, start: land, radius: r * 1.6, color: 0xfff0c0 });
          }
          diveDusts.push({ x: gx, y: gy, start: land, r: featherDive ? Math.max(r * 2.1, 54) : r, feather: featherDive });
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
        // 땅을 찍는 내리꽂기는 지진음, 맹금의 급강하는 날갯짓·울음소리
        sfx(featherDive ? 'cast_dive'
          : isLeapSlam ? 'cast_leap'
          : isDive ? 'cast_quake' : castSfxOf(castSkill, e.defId), cx, isDive ? 1 : 0.85);
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
      if (dirTex.has(dirKey)) {
        // 겨누는 목표가 있으면 그쪽을 본다. 이동 방향만 보던 시절엔 전진하다
        // 멈춰 옆·뒤의 적을 때릴 때 엉뚱한 데를 보고 휘두르는 그림이 나왔다.
        const faceTgt = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
        // 사거리 안에 목표가 있으면 이동 중이어도 그쪽을 본다.
        // 원거리 유닛(세이지 등)은 조금씩 자리를 옮기며 쏘는데, 이동 방향만 보면
        // 그 순간마다 몸이 홱 돌아가 「엉뚱한 데 보고 쏘는」 그림이 됐다.
        let inRange = false;
        if (faceTgt && d.weapon) {
          const wr = Math.max(d.weapon.range, d.weapon.airRange ?? 0);
          const reachF = wr + d.radius + (DEFS[faceTgt.defId]?.radius ?? 0);
          const dxF = faceTgt.x - e.x;
          const dyF = faceTgt.y - e.y;
          inRange = dxF * dxF + dyF * dyF <= reachF * reachF;
        }
        const aiming = faceTgt !== undefined && (inRange || !movedNow || now < vfx.aimUntil);
        const fdx = aiming ? faceTgt.x - e.x : e.x - pv.x;
        const fdy = aiming ? faceTgt.y - e.y : e.y - pv.y;
        // 주 축 기준 4방향 — 대각선은 가로 우선 (그림이 자연스럽다)
        if (aiming || movedNow) {
          vfx.faceDir = Math.abs(fdx) >= Math.abs(fdy)
            ? (fdx >= 0 ? 'e' : 'w')
            : (fdy >= 0 ? 's' : 'n');
        }
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
        const dt = (now - vfx.diveStart) / Math.max(1, vfx.diveUntil - vfx.diveStart); // 0~1
        // 맹금은 더 높이 솟구친다 — 비행 유닛은 다이브 중 평소의 부유 보정(26px)이
        // 사라져 상승분이 그만큼 상쇄되므로, 그걸 메우고도 남게 잡는다
        const up = vfx.diveFeather ? 104 : 62; // 솟구치는 높이(px)
        if (dt < DIVE_DOWN_AT) {
          // 상승: 처음엔 빠르게, 정점에서 잠깐 머문다 (ease-out)
          const k = dt / DIVE_DOWN_AT;
          py -= up * Math.sin(k * Math.PI * 0.5);
          diveSquash = 1 + k * 0.12; // 솟구치며 살짝 늘어남
          // 목표 쪽으로 미리 15%쯤 흘러간다 (덮치기 직전의 조준)
          px += vfx.diveDx * k * 0.15;
          py += vfx.diveDy * k * 0.15;
        } else {
          // 급강하 + 착지 스쿼시 (땅을 때리는 맛)
          const k = (dt - DIVE_DOWN_AT) / (1 - DIVE_DOWN_AT);
          const slam = Math.min(1, k * 3.2); // 매우 빠르게 내리꽂힘
          py -= up * (1 - slam);
          // 목표 지점으로 쏘아지듯 날아가 찍고(k=0.31 무렵) 천천히 제자리로 돌아온다
          const back = (k - 0.31) / 0.69;
          const reach = k < 0.31 ? 0.15 + (k / 0.31) * 0.85 : 1 - back * back;
          px += vfx.diveDx * reach;
          py += vfx.diveDy * reach;
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
      // 은신(인큐버스): 적이 쓰면 완전히 사라지고, 내 유닛이면 반투명으로 보인다
      const stealthedNow = g.tick < e.stealthUntil;
      // 「커튼콜」로 무대 밖에 치워진 동안엔 아예 보이지 않는다 (죽은 게 아니라 없는 것)
      const vanishedNow = g.tick < e.vanishUntil;
      sp.visible = (!stealthedNow || e.team === 0) && !vanishedNow;
      sp.alpha = stealthedNow ? 0.45 : 1;
      sp.x = px;
      sp.y = py;
      // 세로 맵: 월드가 -90도 돌아 있으므로 유닛은 되돌려 세운다
      sp.rotation = rot + (curMap.vertical ? Math.PI / 2 : 0);
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
      // 「인형의 실」로 빼앗긴 유닛: 형상만 남기고 온통 새까맣게 —
      // 누구를 빼앗겼는지 한눈에 읽히도록 다른 어떤 틴트보다 앞에 둔다.
      sp.tint = e.puppetized ? (now < vfx.flashUntil ? 0x3a0f0f : 0x000000)
        : now < vfx.flashUntil ? 0xff7a6a
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
      /*
       * ── 상태 표시의 좌표 자 ──
       *
       * 세로 맵은 월드가 -90도 돌아 있다 (world.rotation = -PI/2): 월드 +x 가
       * 화면 위쪽, 월드 +y 가 화면 오른쪽이다. 아래의 표시들은 전부 「머리 위」
       * 「발밑」처럼 화면 기준으로 읽혀야 하는 것들이라, 화면 오프셋을 월드로
       * 옮겨 주는 자를 두고 그것만 쓴다. (안 쓰면 세로 맵에서 죄다 옆으로 눕는다)
       *   ex/ey(dx, dy) — 유닛에서 화면 오른쪽 dx · 화면 아래 dy
       *   ow/oh(w, h)   — 화면 기준 가로 w · 세로 h 인 타원의 월드 반지름
       *   erect(...)    — 화면 기준 사각형
       */
      const vertM = curMap.vertical === true;
      const ex = (dx: number, dy: number): number => (vertM ? px - dy : px + dx);
      const ey = (dx: number, dy: number): number => (vertM ? py + dx : py + dy);
      const ow = (w: number, h: number): number => (vertM ? h : w);
      const oh = (w: number, h: number): number => (vertM ? w : h);
      const erect = (dx: number, dy: number, w: number, h: number): [number, number, number, number] =>
        (vertM ? [px - dy - h, py + dx, h, w] : [px + dx, py + dy, w, h]);
      // 뿌리박기류: 지속 중 발밑에 갈색 뿌리 링
      if (buffedNow && sbSkill?.holdGround) {
        fx.ellipse(px, shadowY, ow(12, 5.5), oh(12, 5.5)).stroke({ color: 0x8a6a3d, width: 2, alpha: 0.8 });
      }
      // 「가호」 지속 중: 하늘빛 방어막을 두른다 — 12초 내내 누가 축복받았는지
      // 한눈에 보이게 발밑 이중 링 + 몸을 감싸는 맥동 방패 + 떠오르는 성광
      if (g.tick < e.armorBuffUntil && !propInvuln) {
        const pulse = 0.5 + 0.32 * Math.sin(now * 0.006 + e.id);
        const bw = sp.width * 0.66;
        const bh = sp.height * 0.6;
        const bcx = ex(0, -sp.height * 0.45);
        const bcy = ey(0, -sp.height * 0.45);
        // 몸을 덮던 하늘빛 채움은 뺐다 — 축복받은 부대가 뭉치면 방패가 겹쳐
        // 한 덩어리 파란 얼룩이 되어 어느 유닛이 어느 유닛인지 안 보였다.
        // 몸에 남는 건 가는 윤곽선 하나뿐이고, 「누가 축복받았나」는 스프라이트를
        // 가리지 않는 발밑 이중 링이 맡는다.
        fx.ellipse(bcx, bcy, ow(bw, bh), oh(bw, bh)).stroke({ color: 0xbfeaff, width: 1, alpha: 0.14 + pulse * 0.13 });
        fx.ellipse(px, shadowY, ow(13, 5.5), oh(13, 5.5)).stroke({ color: 0x8fd8ff, width: 2, alpha: 0.5 + pulse * 0.32 });
        fx.ellipse(px, shadowY, ow(9, 3.8), oh(9, 3.8)).stroke({ color: 0xfff2c8, width: 1, alpha: 0.32 + pulse * 0.28 });
        // 방패를 타고 천천히 떠오르는 빛 알갱이 2개 (개체마다 위상이 어긋난다)
        for (let k = 0; k < 2; k++) {
          const ph = ((now * 0.0009 + e.id * 0.37 + k * 0.5) % 1);
          const ang = (e.id * 1.7 + k * Math.PI) % (Math.PI * 2);
          fx.circle(ex(Math.cos(ang) * bw * 0.8, -ph * bh * 2.1), ey(Math.cos(ang) * bw * 0.8, -ph * bh * 2.1), 1.6)
            .fill({ color: 0xfff0b0, alpha: (1 - ph) * 0.8 });
        }
      }
      // 디멘터 오라: 발밑에 유형별 고리가 깔린다. 색이 「본색 → 검정 → 본색」으로
      // 천천히 오가며 숨 쉬듯 도는데, 이게 이 부대가 무슨 축복을 받고 있는지 알리는 신호다.
      if (e.auraKind > 0 && !propInvuln) {
        const k = e.auraKind;
        const base = k === 1 ? [0x4a7bd8, 0x2a4a90]    // 파랑 (검푸른 장막)
          : k === 2 ? [0x3fbf5a, 0x1f6a33]             // 초록 (뻗은 손톱)
          : k === 3 ? [0xc8b8a0, 0x6a5a48]             // 잿빛 (재의 장막)
          : [0x9a3fd0, 0x4a1a68];                      // 보라 (종말)
        // 0→1→0 을 오가는 삼각파. 개체마다 위상을 어긋내 무리가 물결치듯 보인다
        const ph = ((now * 0.0006 + e.id * 0.11) % 1);
        const tri = ph < 0.5 ? ph * 2 : (1 - ph) * 2;
        const mix = (a: number, b: number, t: number): number => {
          const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
          const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
          return (((ar + (br - ar) * t) | 0) << 16) | (((ag + (bg - ag) * t) | 0) << 8) | ((ab + (bb - ab) * t) | 0);
        };
        // 본색 ↔ 검정 사이를 오간다
        const col = mix(base[0]!, 0x101014, tri * 0.85);
        const glow = mix(base[1]!, 0x000000, tri * 0.7);
        fx.ellipse(px, shadowY, ow(12, 5), oh(12, 5)).fill({ color: glow, alpha: 0.2 + tri * 0.12 });
        fx.ellipse(px, shadowY, ow(12, 5), oh(12, 5)).stroke({ color: col, width: 2, alpha: 0.6 + tri * 0.3 });
        fx.ellipse(px, shadowY, ow(7.5, 3), oh(7.5, 3)).stroke({ color: col, width: 1, alpha: 0.35 + tri * 0.3 });
      }
      // 보호막(재의 장막): 남아 있는 동안 몸을 감싸는 옅은 재빛 껍질
      if (e.shieldHp > 0 && !propInvuln) {
        const sh = 0.4 + 0.25 * Math.sin(now * 0.005 + e.id);
        fx.ellipse(ex(0, -sp.height * 0.45), ey(0, -sp.height * 0.45),
          ow(sp.width * 0.6, sp.height * 0.52), oh(sp.width * 0.6, sp.height * 0.52))
          .stroke({ color: 0xe8dcc8, width: 2, alpha: sh });
      }
      // 디멘터: 발밑에 검은 안개가 늘 깔려 감돈다 (오라 유무와 무관한 고유 연출)
      if (e.defId === 'p_dementor') {
        for (let k = 0; k < 5; k++) {
          const a2 = now * 0.0007 + e.id * 0.5 + (k * Math.PI * 2) / 5;
          const rr = 11 + Math.sin(now * 0.0016 + k * 1.7) * 4;
          fx.ellipse(ex(Math.cos(a2) * rr, Math.sin(a2) * rr * 0.42), ey(Math.cos(a2) * rr, Math.sin(a2) * rr * 0.42),
            ow(7.5, 3.4), oh(7.5, 3.4))
            .fill({ color: k % 2 === 0 ? 0x1a1a26 : 0x2e2440, alpha: 0.3 });
        }
      }
      // 무적 (인비저블): 금색 보호막 링 (맥동)
      if (invulnNow) {
        const shim = 0.55 + 0.3 * Math.sin(now * 0.012);
        fx.ellipse(ex(0, -sp.height * 0.45), ey(0, -sp.height * 0.45),
          ow(sp.width * 0.62, sp.height * 0.55), oh(sp.width * 0.62, sp.height * 0.55))
          .stroke({ color: 0xffd86a, width: 2, alpha: shim });
      }
      // 매혹(서큐버스): 머리 위에서 분홍 하트 세 개가 빙글빙글
      if (g.tick < e.seducedUntil) {
        const hd = -sp.height - 8;   // 머리 위 (화면 기준)
        const spin = now * 0.005;
        for (let k = 0; k < 3; k++) {
          const a = spin + (k * Math.PI * 2) / 3;
          const ox = Math.cos(a) * 9;
          const oy = Math.sin(a) * 3;
          const r = 2.2 + Math.sin(a) * 0.6;
          // 작은 하트: 원 두 개 + 아래 꼭짓점 삼각형
          const hl: [number, number] = [ox - r * 0.5, hd + oy - r * 0.3];
          const hr: [number, number] = [ox + r * 0.5, hd + oy - r * 0.3];
          fx.circle(ex(...hl), ey(...hl), r * 0.62).fill({ color: 0xff7ac8, alpha: 0.9 });
          fx.circle(ex(...hr), ey(...hr), r * 0.62).fill({ color: 0xff7ac8, alpha: 0.9 });
          fx.poly([ex(ox - r, hd + oy), ey(ox - r, hd + oy), ex(ox + r, hd + oy), ey(ox + r, hd + oy),
            ex(ox, hd + oy + r * 1.3), ey(ox, hd + oy + r * 1.3)])
            .fill({ color: 0xff7ac8, alpha: 0.9 });
        }
      }
      // 혼란: 머리 위에서 별 세 개가 빙글빙글 (기절 만화 연출)
      if (confusedNow) {
        const hd = -sp.height - 8;
        const spin = now * 0.005;
        for (let k = 0; k < 3; k++) {
          const a = spin + (k * Math.PI * 2) / 3;
          const ox = Math.cos(a) * 8;
          const oy = Math.sin(a) * 3; // 납작한 궤도 = 원근감
          const r = 1.6 + Math.sin(a) * 0.5; // 뒤로 갈수록 작게
          fx.circle(ex(ox, hd + oy), ey(ox, hd + oy), r).fill({ color: 0xffe14d, alpha: 0.55 + Math.sin(a) * 0.35 });
        }
      }
      // 빙결: 유닛을 감싸는 얼음 결정 (육각 스파이크 링)
      if (frozenNow) {
        const icd = -sp.height * 0.45;
        for (let k = 0; k < 6; k++) {
          const a = (k * Math.PI) / 3 + 0.3;
          const rx = Math.cos(a) * sp.width * 0.55;
          const ry = Math.sin(a) * sp.height * 0.5;
          fx.moveTo(ex(rx * 0.6, icd + ry * 0.6), ey(rx * 0.6, icd + ry * 0.6))
            .lineTo(ex(rx, icd + ry), ey(rx, icd + ry))
            .stroke({ color: 0xcfeeff, width: 2, alpha: 0.85 });
        }
        fx.ellipse(ex(0, icd), ey(0, icd),
          ow(sp.width * 0.58, sp.height * 0.52), oh(sp.width * 0.58, sp.height * 0.52))
          .stroke({ color: 0x9fdcff, width: 1.5, alpha: 0.7 });
      }
      // 가시 봉제 (공격 반사) 지속 중: 붉은 가시 링이 회전한다
      if (g.tick < e.reflectUntil) {
        const rd = -sp.height * 0.45;
        const spin = now * 0.003;
        for (let k = 0; k < 8; k++) {
          const a = spin + (k * Math.PI) / 4;
          const rx = Math.cos(a) * sp.width * 0.6;
          const rz = Math.sin(a) * sp.height * 0.55;
          fx.moveTo(ex(rx * 0.78, rd + rz * 0.78), ey(rx * 0.78, rd + rz * 0.78))
            .lineTo(ex(rx * 1.12, rd + rz * 1.12), ey(rx * 1.12, rd + rz * 1.12))
            .stroke({ color: 0xff5a4d, width: 2, alpha: 0.85 });
        }
        fx.ellipse(ex(0, rd), ey(0, rd),
          ow(sp.width * 0.62, sp.height * 0.56), oh(sp.width * 0.62, sp.height * 0.56))
          .stroke({ color: 0xff5a4d, width: 1.5, alpha: 0.5 + 0.2 * Math.sin(now * 0.01) });
      }
      /*
       * 숲지기 카엘 전용 연출.
       *
       * 도발·무적·반사는 공용 표시가 있지만 전부 「한 번 번쩍」이라, 10초짜리
       * 도발이 지금 걸려 있는지 화면만 봐서는 알 수 없었다. 지속 중인 것은
       * 지속되는 표시로 보여 준다.
       */
      if (e.defId === 'c_kael') {
        // 숲의 맥박(패시브 재생): 발밑에서 초록 잎사귀가 천천히 떠오른다
        if (d.regenPerSec && d.regenPerSec > 0 && e.alive) {
          const period = 900;
          for (let k = 0; k < 3; k++) {
            const t2 = ((now + k * (period / 3) + e.id * 130) % period) / period;
            const ldx = Math.sin((t2 + k) * 6.2) * sp.width * 0.32;
            const ldy = -t2 * sp.height * 0.95;
            fx.circle(ex(ldx, ldy), ey(ldx, ldy), 1.8 * (1 - t2 * 0.4))
              .fill({ color: 0x8ce06a, alpha: 0.75 * (1 - t2) });
          }
        }
        // 숲의 부름(도발) 지속: 내가 도발한 적이 남아 있는 동안 발밑에 룬 고리
        let taunting = false;
        for (const v of g.entities) {
          if (v.alive && v.tauntedBy === e.id && g.tick < v.tauntedUntil) { taunting = true; break; }
        }
        if (taunting) {
          const spin = now * 0.0022;
          const rr = sp.width * 0.95;
          fx.ellipse(ex(0, -2), ey(0, -2), ow(rr, rr * 0.42), oh(rr, rr * 0.42))
            .stroke({ color: 0x9ad66a, width: 2, alpha: 0.5 + 0.25 * Math.sin(now * 0.008) });
          for (let k = 0; k < 6; k++) {
            const a = spin + (k * Math.PI * 2) / 6;
            const tdx = Math.cos(a) * rr;
            const tdy = -2 + Math.sin(a) * rr * 0.42;
            fx.circle(ex(tdx, tdy), ey(tdx, tdy), 2.4)
              .fill({ color: 0xd8f0a0, alpha: 0.8 });
          }
        }
        // 세계수의 방패(무적) 지속: 금빛 돔 + 안쪽에 나무 문장이 어른거린다
        if (invulnNow) {
          const domeR = sp.width * 0.78;
          const puls = 0.5 + 0.28 * Math.sin(now * 0.009);
          const dd = -sp.height * 0.45;
          fx.ellipse(ex(0, dd), ey(0, dd), ow(domeR, domeR * 0.92), oh(domeR, domeR * 0.92))
            .fill({ color: 0xffe9a8, alpha: 0.12 + puls * 0.06 });
          fx.ellipse(ex(0, dd), ey(0, dd), ow(domeR, domeR * 0.92), oh(domeR, domeR * 0.92))
            .stroke({ color: 0xffd86a, width: 2.5, alpha: 0.45 + puls * 0.4 });
          // 나무 문장 — 줄기 하나에 가지 넷
          fx.moveTo(ex(0, dd + domeR * 0.45), ey(0, dd + domeR * 0.45))
            .lineTo(ex(0, dd - domeR * 0.35), ey(0, dd - domeR * 0.35))
            .stroke({ color: 0xfff2c0, width: 2, alpha: 0.5 + puls * 0.3 });
          for (let k = 0; k < 4; k++) {
            const up = dd - domeR * (0.05 + k * 0.1);
            const wdt = domeR * (0.3 - k * 0.05);
            fx.moveTo(ex(0, up), ey(0, up)).lineTo(ex(-wdt, up - wdt * 0.7), ey(-wdt, up - wdt * 0.7))
              .stroke({ color: 0xfff2c0, width: 1.5, alpha: 0.45 + puls * 0.25 });
            fx.moveTo(ex(0, up), ey(0, up)).lineTo(ex(wdt, up - wdt * 0.7), ey(wdt, up - wdt * 0.7))
              .stroke({ color: 0xfff2c0, width: 1.5, alpha: 0.45 + puls * 0.25 });
          }
        }
        // 가시 껍질(반사) 지속: 몸 둘레에 초록 가시가 돋는다 (공용 붉은 가시 위에 덧댄다)
        if (g.tick < e.reflectUntil) {
          const rd2 = -sp.height * 0.45;
          const spin2 = -now * 0.0026;
          for (let k = 0; k < 10; k++) {
            const a = spin2 + (k * Math.PI * 2) / 10;
            const rx = Math.cos(a) * sp.width * 0.58;
            const rz = Math.sin(a) * sp.height * 0.52;
            fx.moveTo(ex(rx, rd2 + rz), ey(rx, rd2 + rz))
              .lineTo(ex(rx * 1.28, rd2 + rz * 1.28), ey(rx * 1.28, rd2 + rz * 1.28))
              .stroke({ color: 0x7ac04a, width: 2, alpha: 0.8 });
          }
        }
      }
      // 전향(인형의 실): 머리 위 분홍 실에 매달린 하트 표식
      if (charmedIds.has(e.id)) {
        const hd = -sp.height - 12;
        const sway = Math.sin(now * 0.004 + e.id) * 2;
        fx.moveTo(ex(sway, hd - 6), ey(sway, hd - 6)).lineTo(ex(0, hd + 1), ey(0, hd + 1))
          .stroke({ color: 0xff9ad0, width: 1, alpha: 0.8 });
        fx.circle(ex(-1.4, hd + 2.4), ey(-1.4, hd + 2.4), 1.7).fill({ color: 0xff7ab8, alpha: 0.95 });
        fx.circle(ex(1.4, hd + 2.4), ey(1.4, hd + 2.4), 1.7).fill({ color: 0xff7ab8, alpha: 0.95 });
        fx.moveTo(ex(-3, hd + 3), ey(-3, hd + 3)).lineTo(ex(0, hd + 6.5), ey(0, hd + 6.5))
          .lineTo(ex(3, hd + 3), ey(3, hd + 3))
          .stroke({ color: 0xff7ab8, width: 2.4, alpha: 0.95 });
      }
      // 공포: 머리 위에서 떨리는 보라 느낌표
      if (fearedNow) {
        const hd = -sp.height - 9;
        const jit = Math.sin(now * 0.03 + e.id * 3) * 1.4;
        fx.rect(...erect(-1.2 + jit, hd - 6, 2.4, 6)).fill({ color: 0xb06ad0, alpha: 0.95 });
        fx.circle(ex(jit, hd + 3), ey(jit, hd + 3), 1.4).fill({ color: 0xb06ad0, alpha: 0.95 });
      }
      // 수면: 머리 위로 떠오르는 Z (세 개가 시차를 두고 위로 흘러간다)
      if (asleepNow) {
        const hd = -sp.height - 6;
        for (let k = 0; k < 3; k++) {
          const t = ((now * 0.0006 + k / 3) % 1);
          const zx = 5 + t * 7;
          const zy = hd - t * 13;
          const s = 2.4 + t * 1.6;
          const al = 0.85 * (1 - t);
          fx.moveTo(ex(zx - s, zy - s), ey(zx - s, zy - s)).lineTo(ex(zx + s, zy - s), ey(zx + s, zy - s))
            .lineTo(ex(zx - s, zy + s), ey(zx - s, zy + s)).lineTo(ex(zx + s, zy + s), ey(zx + s, zy + s))
            .stroke({ color: 0xdfe8ff, width: 1.4, alpha: al });
        }
      }
      // 약화: 발밑에서 아래로 처지는 보라 화살표
      if (weakenedNow && !asleepNow) {
        const wd = -2 + Math.sin(now * 0.006 + e.id) * 1.2;
        fx.moveTo(ex(-4, wd - 3), ey(-4, wd - 3)).lineTo(ex(0, wd + 2), ey(0, wd + 2))
          .lineTo(ex(4, wd - 3), ey(4, wd - 3))
          .stroke({ color: 0xb06ad0, width: 1.6, alpha: 0.9 });
      }
      // 넥서스 보호막: 수호자가 살아 있는 동안 청록 방벽이 맥동한다
      if (shieldedNow) {
        const shim = 0.4 + 0.25 * Math.sin(now * 0.004);
        fx.ellipse(ex(0, -sp.height * 0.4), ey(0, -sp.height * 0.4),
          ow(sp.width * 0.75, sp.height * 0.68), oh(sp.width * 0.75, sp.height * 0.68))
          .stroke({ color: 0x7ad8ff, width: 2.5, alpha: shim });
      }
      // 군세강화: 머리 위 주황 이중 화살촉
      if (g.tick < e.atkBuffUntil && !confusedNow) {
        const hd = -sp.height - 5;
        const bob = Math.sin(now * 0.008 + e.id) * 1.2;
        for (const o of [0, 4]) {
          fx.moveTo(ex(-4, hd + o + bob), ey(-4, hd + o + bob))
            .lineTo(ex(0, hd + o - 4 + bob), ey(0, hd + o - 4 + bob))
            .lineTo(ex(4, hd + o + bob), ey(4, hd + o + bob))
            .stroke({ color: 0xff9a3d, width: 1.6, alpha: 0.9 });
        }
      }
      // 숲의 가호: 발밑 연둣빛 점
      if (g.tick < e.forestUntil) {
        const tw = 0.5 + 0.4 * Math.sin(now * 0.006 + e.id * 2.3);
        fx.circle(ex(7, -3), ey(7, -3), 1.6).fill({ color: 0x9fe86a, alpha: tw });
        fx.circle(ex(-7, -5), ey(-7, -5), 1.3).fill({ color: 0x9fe86a, alpha: 1 - tw * 0.6 });
      }
      // 회복: 초록 플러스 떠오름
      if (now < vfx.healGlowUntil) {
        const t = 1 - (vfx.healGlowUntil - now) / 450;
        const hd = -sp.height - 4 - t * 10;
        fx.rect(...erect(-1.2, hd - 4, 2.4, 8)).fill({ color: 0x6fe87a, alpha: 0.9 * (1 - t) });
        fx.rect(...erect(-4, hd - 1.2, 8, 2.4)).fill({ color: 0x6fe87a, alpha: 0.9 * (1 - t) });
      }
      // 속박: 발밑에 포획 실 링 표시
      if (g.tick < e.rootedUntil) {
        fx.ellipse(px, shadowY, ow(10, 4.5), oh(10, 4.5)).stroke({ color: 0xf0f0f0, width: 1.5, alpha: 0.85 });
        fx.moveTo(ex(-8, -2), ey(-8, -2)).lineTo(ex(8, 2), ey(8, 2)).stroke({ color: 0xf0f0f0, width: 1, alpha: 0.6 });
        fx.moveTo(ex(-8, 2), ey(-8, 2)).lineTo(ex(8, -2), ey(8, -2)).stroke({ color: 0xf0f0f0, width: 1, alpha: 0.6 });
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
        /*
         * 스킨 그림은 방향 세트가 없다 (동향 한 장 + 공격 프레임뿐).
         * 그런데 「방향 그림을 가진 유닛」으로 분류돼 스폰 때의 팀 반전도,
         * 아래의 방향 스왑도 타지 않았다 — 그래서 목없는 기사가 말을 타면
         * 서쪽으로 달리면서 계속 동쪽을 보고 있었다. 여기서 직접 뒤집는다.
         */
        const skinTgt = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
        const skinFlip = (now < vfx.aimUntil && skinTgt) ? skinTgt.x < e.x : vfx.faceDir === 'w';
        const sax = Math.abs(sp.scale.x);
        sp.scale.x = skinFlip ? -sax : sax;
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
          const atkTgt = e.targetId >= 0 ? byId.get(e.targetId) : undefined;
          if (attackTex.has(e.defId) || airAttackTex.has(e.defId)) {
            // 공격 프레임은 동향(east)으로 그려져 있다 — 서쪽 목표면 뒤집어 맞춘다.
            // 좌우는 faceDir 이 아니라 「목표가 실제로 어느 쪽인지」로 정한다
            // (faceDir 만 보면 위·아래 목표일 때 늘 동쪽을 향해 휘둘렀다).
            const flip = atkTgt ? atkTgt.x < e.x : vfx.faceDir === 'w';
            const ax = Math.abs(sp.scale.x);
            sp.scale.x = flip ? -ax : ax;
          } else {
            // 공격 프레임이 없는 유닛(발리스타·모자장수·하얀토끼·드로셀마이어 등)은
            // 방향 그림을 그대로 쓴다. 여기에 반전까지 걸면 서쪽 그림이 다시 뒤집혀
            // 「왼쪽을 치면서 오른쪽을 보는」 그림이 됐다.
            const face2 = atkTgt
              ? (Math.abs(atkTgt.x - e.x) >= Math.abs(atkTgt.y - e.y)
                ? (atkTgt.x >= e.x ? 'e' : 'w')
                : (atkTgt.y >= e.y ? 's' : 'n'))
              : vfx.faceDir;
            const want2 = face2 === 'w' ? dt.w : face2 === 'n' ? dt.n : face2 === 's' ? dt.s : dt.e;
            const pick3 = want2 ?? assetTex.get(e.defId)?.[0];
            if (pick3 && sp.texture !== pick3) sp.texture = pick3;
            if (sp.scale.x < 0) sp.scale.x = -sp.scale.x;
          }
        }
      }

      // 서큐버스 악마 변신: 지속 중엔 데몬 폼 그림으로.
      // 공격 프레임 적용보다 뒤여야 한다 — 앞에 두면 싸우는 내내 공격 프레임이
      // 데몬 폼을 덮어써서 변신한 티가 안 났다 (데몬 폼 전용 공격 프레임은 없다).
      if (e.defId === 'p_succubus' && g.tick < e.transformUntil) {
        const demonTex = assetTex.get('p_succubus_demon')?.[0];
        if (demonTex && sp.texture !== demonTex) sp.texture = demonTex;
      }
      // 모자장수 「모자 바꾸기」: 쓰고 있는 모자 색 그림으로 최종 교체한다.
      // 방향 그림 스왑보다 뒤여야 한다 — 앞에 두면 방향 그림이 모자를 덮어쓴다.
      // 모자 그림은 동향(east) 한 장뿐이라 서쪽을 볼 땐 좌우를 뒤집는다.
      if (e.defId === 'm_mad_hatter' && g.tick < e.hatUntil && e.hatKind > 0) {
        const hatKey = e.hatKind === 2 ? 'm_mad_hatter_blue'
          : e.hatKind === 4 ? 'm_mad_hatter_gold'
          : 'm_mad_hatter_red';   // 1·3 = 빨강
        const hatTex = assetTex.get(hatKey)?.[0];
        if (hatTex) {
          if (sp.texture !== hatTex) sp.texture = hatTex;
          // 거대화(3)·황금(4)은 실제로 몸집이 커진다
          const grow = (e.hatKind === 3 || e.hatKind === 4) ? 1.45 : 1;
          const ax = Math.abs(vfx.baseScaleX) * grow;
          sp.scale.set(vfx.faceDir === 'w' ? -ax : ax, vfx.baseScaleY * grow);
        }
      }

      // 화면 안팎 판정. 앞서 정한 「보이면 안 되는 상태」(은신·커튼콜)를 덮지 않는다 —
      // 이걸 그냥 on 으로 덮어써서, 무대 밖으로 치워진 유닛이 그 자리에 서 있었다.
      // 여유는 스프라이트 크기만큼 잡는다. 고정 60px 로 두면 적 요새처럼 큰 건물이
      // 화면을 가득 채우고 있어도 기준점(발밑)만 밖으로 나가면 통째로 사라진다.
      const pad = 60 + Math.max(Math.abs(sp.width), Math.abs(sp.height));
      // px 는 진행축(월드 x) 좌표다. 세로 맵은 컨테이너가 -90도 돌아 있어
      // 진행축이 화면 세로가 되므로 camY·visibleH 와 견줘야 한다.
      // camX·visibleW 로 견주면 월드 x 를 월드 y 범위와 비교하는 셈이라,
      // 확대할수록 창이 좁아져 유닛과 건물이 통째로 사라졌다.
      const [vx0, vx1] = viewAxisX();
      const on = px > vx0 - pad && px < vx1 + pad;
      const hidden = vanishedNow || (stealthedNow && e.team !== 0);
      sp.visible = on && !hidden;
      if (!on || hidden) {
        // 사라진 동안엔 그림자·체력바·상태 링도 함께 지운다
        if (hidden) sp.alpha = 0;
        continue;
      }

      // 그림자 — 바닥에 눕는 타원.
      // 세로 맵은 월드가 90도 돌아 있어, 납작한 타원을 그대로 그리면 화면에서
      // 길쭉하게 서 버린다 (선택 링이 늘어져 보이던 원인). 축을 바꿔 그린다.
      const rw = Math.max(6, (d.radius / FP) * TILE * 1.6);
      const vert = curMap.vertical;
      const ew = vert ? rw * 0.42 : rw;
      const eh = vert ? rw : rw * 0.42;
      /*
       * 건물에는 그림자를 깔지 않는다.
       * 그림 자체가 이미 땅에 닿은 밑동을 그려 두었는데 그 아래 타원을 또 얹으면
       * 건물이 받침대 위에 떠 있는 것처럼 보였다 (넥서스·수호탑·캠프 전부).
       * 발이 하나뿐인 유닛과 달리 건물은 바닥 면이 넓어 타원이 맞지도 않는다.
       */
      if (d.tier !== 'structure') {
        shadows.ellipse(sx(ix), shadowY - 1, ew, eh)
          .fill({ color: 0x3a2a18, alpha: d.flying ? 0.2 : 0.32 });
      }
      // 선택 링
      if (e.id === selectedId) {
        fx.ellipse(sx(ix), shadowY - 1, vert ? ew + 4 * 0.42 : ew + 4, vert ? eh + 4 : eh + 4 * 0.42)
          .stroke({ color: 0xffe98a, width: 2 });
      }

      // 체력바 (+ 보호막이 남아 있으면 그 위에 파란 칸을 하나 더)
      const isStruct = d.tier === 'structure';
      const shielded = e.shieldHp > 0 && !propInvuln;
      if ((e.hp < d.maxHp || isStruct || shielded) && !propInvuln) {
        const w = isStruct ? 40 : 18;
        // 업그레이드로 최대 체력이 늘어난 유닛은 유효 정의 기준으로 비율 계산
        const maxHp = e.defOv?.maxHp ?? d.maxHp;
        const hpr = Math.min(1, Math.max(0, e.hp / maxHp));
        /*
         * 세로 맵은 월드가 -90도 돌아 있다 — 진행축(월드 x)이 화면 세로,
         * 코리도어 폭(월드 y)이 화면 가로다. 그래서 가로 막대를 그대로 그리면
         * 화면에서 「유닛 왼쪽에 선 세로 막대」가 된다 (실제로 5라운드가 그랬다).
         * 스프라이트처럼 회전을 되돌릴 수 없는 Graphics 라서 축을 바꿔 그린다:
         *   길이 w 는 월드 y(화면 가로), 두께 3.5 는 월드 x(화면 세로),
         *   머리 위 = 월드 x 가 커지는 쪽.
         */
        const bar = (off: number, len: number, color: number, alpha = 1): void => {
          if (vert) bars.rect(px + sp.height + 5 + off, py - w / 2, 3.5, len).fill({ color, alpha });
          else bars.rect(px - w / 2, py - sp.height - 5 - off, len, 3.5).fill({ color, alpha });
        };
        bar(0, w, 0x120d08, 0.85);
        bar(0, w * hpr, hpr > 0.5 ? 0x6fce62 : hpr > 0.25 ? 0xe0b840 : 0xe0524a);
        // 보호막: 체력바 바로 위 한 칸. 기준은 「받을 수 있는 최대 보호막」이 아니라
        // 이 유닛이 실제로 받았던 양이라, 닳는 만큼 줄어드는 게 눈에 보인다.
        if (shielded) {
          const peak = Math.max(e.shieldHp, shieldPeak.get(e.id) ?? 0);
          shieldPeak.set(e.id, peak);
          const sr = Math.min(1, e.shieldHp / Math.max(1, peak));
          bar(4.5, w, 0x0c1626, 0.85);
          bar(4.5, w * sr, 0x5ab8ff);
        } else {
          shieldPeak.delete(e.id);
        }
      }
    }

    // ── 사망 처리: 사라진 유닛 → 시체 연출 ──
    for (const [id, sp] of sprites) {
      if (seen.has(id)) continue;
      // 대피한 주민: 소리도 시체도 없이 그냥 사라진다
      if (quietIds.has(id)) {
        quietIds.delete(id);
        sprites.delete(id);
        spriteTeam.delete(id);
        spriteDefId.delete(id);
        prevPos.delete(id);
        unitFx.delete(id);
        units.removeChild(sp);
        sp.destroy();
        continue;
      }
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
    /*
     * ── 금광 소유 깃발 (15) ──
     *
     * 갱 위에 깃발을 꽂아 주인을 알린다. 점령이 굴러가는 동안에는 갱 둘레에
     * 진행 고리가 차오른다 — 「지금 누가 밀고 있나」가 화면에서 바로 읽혀야
     * 부대를 어디로 보낼지 정할 수 있다.
     */
    if (goldMines) {
      while (goldFlagSp.length < goldMines.length) {
        const sp = new Sprite();
        sp.anchor.set(0.5, 1);
        sp.zIndex = Number.MAX_SAFE_INTEGER - 1;
        units.addChild(sp);
        goldFlagSp.push(sp);
      }
      for (let i = 0; i < goldFlagSp.length; i++) {
        const sp = goldFlagSp[i]!;
        const m = goldMines[i];
        if (!m) { sp.visible = false; continue; }
        const tex = m.owner === 0 ? goldFlagTex[0] : m.owner === 1 ? goldFlagTex[1] : undefined;
        const px = sx(m.x);
        const py = sy(m.y);
        if (tex) {
          sp.visible = true;
          if (sp.texture !== tex) sp.texture = tex;
          sp.scale.set(TILE * 1.6 / tex.width);
          sp.rotation = curMap.vertical ? Math.PI / 2 : 0;
          // 갱 바로 위에 꽂는다 — 세로 맵이면 화면 위쪽이 월드 +x 다
          sp.x = curMap.vertical ? px + 26 : px;
          sp.y = curMap.vertical ? py : py - 26;
        } else {
          sp.visible = false;
        }
        // 점령 진행 고리 — 미는 쪽 색으로 차오른다
        if (m.hold !== 0) {
          const t = Math.min(1, Math.abs(m.hold));
          const col = m.hold > 0 ? 0x6fd8ff : 0xff6a57;
          const rr = TILE * 1.5;
          fx.ellipse(px, py, rr, curMap.vertical ? rr : rr * 0.5)
            .stroke({ color: col, width: 2, alpha: 0.35 });
          const steps = Math.max(1, Math.round(t * 28));
          for (let k = 0; k < steps; k++) {
            const a = -Math.PI / 2 + (k / 28) * Math.PI * 2;
            const ax = px + Math.cos(a) * rr;
            const ay = py + Math.sin(a) * rr * (curMap.vertical ? 1 : 0.5);
            fx.circle(ax, ay, 2.2).fill({ color: col, alpha: 0.95 });
          }
        }
      }
    } else {
      for (const sp of goldFlagSp) sp.visible = false;
    }
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
    /*
     * ── 치명타: CRITICAL HIT!! 가 솟아올랐다 흩어진다 ──
     *
     * 글자는 월드 레이어(units) 에 붙는데, 세로 맵은 월드가 -90도 돌아 있다.
     * 그대로 두면 글자가 옆으로 누워 세로로 읽힌다 — 레인 이름표와 같은 방식으로
     * 되세우고(rotation +90도), 「떠오르는」 축도 화면 위쪽(월드 +x)으로 바꾼다.
     */
    const critVert = curMap.vertical === true;
    for (const c of g.crits) {
      let slot = critTexts.find((q) => q.until <= now);
      if (!slot) {
        const t = new Text({
          text: 'CRITICAL HIT!!',
          style: { fontSize: 13, fill: 0xffe14d, stroke: { color: 0x6a2000, width: 4 }, fontWeight: 'bold' },
        });
        t.anchor.set(0.5, 1);
        t.zIndex = Number.MAX_SAFE_INTEGER;
        units.addChild(t);
        slot = { t, until: 0, x: 0, y: 0, start: 0 };
        critTexts.push(slot);
      }
      slot.x = sx(c.x) + (critVert ? 18 : 0);
      slot.y = sy(c.y) - (critVert ? 0 : 18);
      slot.start = now;
      slot.until = now + 850;
    }
    for (const q of critTexts) {
      if (q.until <= now) { q.t.visible = false; continue; }
      const k = (now - q.start) / 850;
      q.t.visible = true;
      q.t.rotation = critVert ? Math.PI / 2 : 0;   // 세로 맵에서 글자를 되세운다
      q.t.x = q.x + (critVert ? k * 26 : 0);       // 화면 위로 떠오른다
      q.t.y = q.y - (critVert ? 0 : k * 26);
      q.t.alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      q.t.scale.set(k < 0.18 ? 0.6 + k * 2.2 : 1);  // 팟 하고 커졌다 유지
    }
    // ── 내리꽂기 착지 흙먼지: 사방으로 튀는 파편 (420ms) ──
    for (let i = diveDusts.length - 1; i >= 0; i--) {
      const du = diveDusts[i]!;
      const t = (now - du.start) / (du.feather ? 780 : 420); // 깃털은 더 오래 나풀거린다
      if (t >= 1) {
        diveDusts.splice(i, 1);
        continue;
      }
      if (t < 0) continue;
      const ease = 1 - (1 - t) * (1 - t); // 빠르게 퍼졌다 느려짐
      if (du.feather) {
        // 덮치는 순간의 섬광 — 초반 25% 동안 하얗게 번쩍인다 (가장 눈에 띄는 신호)
        if (t < 0.25) {
          const ft = t / 0.25;
          fx.circle(du.x, du.y, du.r * (0.5 + ft * 0.9)).fill({ color: 0xffffff, alpha: (1 - ft) * 0.75 });
          fx.circle(du.x, du.y, du.r * (0.3 + ft * 0.5)).fill({ color: 0xfff6e0, alpha: (1 - ft) * 0.9 });
        }
        // 급강하: 사방으로 터진 깃털이 빙글 돌며 천천히 내려앉는다 (흙먼지보다 오래 남음)
        for (let k = 0; k < 22; k++) {
          const ang = (k / 22) * Math.PI * 2 + du.r * 0.05;
          const dist = du.r * (0.2 + ease * 1.15) * (k % 3 === 0 ? 1.25 : 0.9);
          const fall = t * t * 18 - Math.sin(t * Math.PI) * 8; // 튀었다가 나풀나풀 낙하
          const spin = ang + t * 5.5;
          const fdx = Math.cos(ang) * dist;
          const fdy = Math.sin(ang) * dist * 0.5 + fall;
          const fx0 = ovx(du.x, fdx, fdy);
          const fy0 = ovy(du.y, fdx, fdy);
          const fl = 6.2 * (1 - t * 0.45);
          // 깃털 한 장 = 가늘고 긴 타원 (회전시켜 나풀거림 표현)
          const cos = Math.cos(spin), sin = Math.sin(spin);
          fx.poly([
            fx0 + cos * fl, fy0 + sin * fl,
            fx0 - sin * fl * 0.34, fy0 + cos * fl * 0.34,
            fx0 - cos * fl, fy0 - sin * fl,
            fx0 + sin * fl * 0.34, fy0 - cos * fl * 0.34,
          ]).fill({ color: k % 4 === 0 ? 0xfff6e4 : k % 4 === 1 ? 0xe4d3b2 : 0xc9b593, alpha: (1 - t) * 0.95 });
        }
        continue;
      }
      for (let k = 0; k < 10; k++) {
        const ang = (k / 10) * Math.PI * 2 + du.r * 0.03;
        const dist = du.r * (0.25 + ease * 0.95);
        const hop = Math.sin(t * Math.PI) * 9; // 튀어올랐다 떨어지는 포물선
        const ddx = Math.cos(ang) * dist;
        const ddy = Math.sin(ang) * dist * 0.5 - hop;
        fx.circle(ovx(du.x, ddx, ddy), ovy(du.y, ddx, ddy), 3.2 * (1 - t) + 0.8)
          .fill({ color: k % 3 === 0 ? 0xe8d0a8 : 0xb08c5a, alpha: (1 - t) * 0.85 });
      }
    }
    // ── 스킬 이펙트 그림: 커지며 옅어진다 ──
    for (let i = castFxSprites.length - 1; i >= 0; i--) {
      const q = castFxSprites[i]!;
      const t = (now - q.start) / (q.until - q.start);
      if (t >= 1) { q.sp.destroy(); castFxSprites.splice(i, 1); continue; }
      const base = (q.r * 2.2) / q.sp.texture.width;
      q.sp.scale.set(base * (0.55 + t * 0.7));
      q.sp.alpha = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75;
      q.sp.rotation = t * 0.5;
    }
    // ── 「커튼콜」 ──
    // 무대 좌표는 sim 이 갖고 있다 (적 한가운데에 열린다). 렌더가 시전자 자리에
    // 그리던 시절엔 「내 옆에서 열리는」 것처럼 보였다.
    {
      const live = new Set<string>();
      for (const cc of g.curtainCalls) {
        const key = `${cc.x},${cc.y}`;
        live.add(key);
        const cx2 = sx(cc.x);
        const cy2 = sy(cc.y);
        const rr2 = (cc.r / FP) * TILE;
        if (!curtainSeen.has(key)) curtainSeen.set(key, { x: cx2, y: cy2, r: rr2, closed: 0 });
        // 열린 무대: 바깥에서 안으로 빨려드는 붉은 소용돌이 + 커튼 그림
        const tex = castFxTex.get('curtain');
        if (tex) {
          let sp2 = curtainSprites.get(key);
          if (!sp2) {
            sp2 = new Sprite(tex);
            sp2.anchor.set(0.5);
            sp2.zIndex = Number.MAX_SAFE_INTEGER - 2;
            units.addChild(sp2);
            curtainSprites.set(key, sp2);
          }
          sp2.x = cx2;
          sp2.y = cy2;
          sp2.scale.set((rr2 * 2.1) / tex.width);
          sp2.rotation += 0.004;
          sp2.alpha = 0.9;
          sp2.visible = true;
        }
        const spin = now * 0.004;
        for (let k = 0; k < 10; k++) {
          const a0 = spin + (k * Math.PI * 2) / 10;
          const rr = rr2 * (1 - ((now * 0.0007 + k * 0.1) % 1) * 0.85);
          fx.circle(cx2 + Math.cos(a0) * rr, cy2 + Math.sin(a0) * rr * 0.5, 2.6)
            .fill({ color: k % 2 === 0 ? 0xff7a9a : 0xd04a6a, alpha: 0.85 });
        }
      }
      // 사라진 무대 = 방금 커튼이 닫혔다 → 닫힘 연출로 넘긴다
      for (const [key, info] of curtainSeen) {
        if (live.has(key)) continue;
        curtainSeen.delete(key);
        const spOld = curtainSprites.get(key);
        if (spOld) { spOld.destroy(); curtainSprites.delete(key); }
        curtainFx.push({ x: info.x, y: info.y, start: now, r: info.r, close: now });
      }
    }
    for (let i = curtainFx.length - 1; i >= 0; i--) {
      const c = curtainFx[i]!;
      const closing = now >= c.close;
      const t = closing ? (now - c.close) / 600 : (now - c.start) / Math.max(1, c.close - c.start);
      if (closing && t >= 1) { c.sp?.destroy(); curtainFx.splice(i, 1); continue; }
      if (t < 0) continue;
      if (!closing) {
        // 열린 무대: 바깥에서 안으로 빨려드는 붉은 소용돌이 (8가닥)
        const spin = now * 0.004;
        for (let k = 0; k < 8; k++) {
          const a0 = spin + (k * Math.PI * 2) / 8;
          const rr = c.r * (1 - ((now * 0.0007 + k * 0.12) % 1) * 0.85);
          fx.circle(c.x + Math.cos(a0) * rr, c.y + Math.sin(a0) * rr * 0.5, 2.6)
            .fill({ color: k % 2 === 0 ? 0xff7a9a : 0xd04a6a, alpha: 0.85 });
        }
        fx.ellipse(c.x, c.y, c.r, c.r * 0.5).stroke({ color: 0xd04a6a, width: 2, alpha: 0.5 });
      } else {
        // 닫히는 커튼: 장막 그림이 확 덮였다가 서서히 옅어진다
        const tex2 = castFxTex.get('curtain_closed');
        if (tex2) {
          if (!c.sp) {
            const sp3 = new Sprite(tex2);
            sp3.anchor.set(0.5);
            sp3.x = c.x;
            sp3.y = c.y;
            sp3.zIndex = Number.MAX_SAFE_INTEGER - 1;
            units.addChild(sp3);
            c.sp = sp3;
          }
          // 덮을 땐 빠르게 커지고, 그 뒤 천천히 사라진다
          const grow = t < 0.25 ? 0.75 + (t / 0.25) * 0.35 : 1.1;
          c.sp.scale.set((c.r * 2.1 * grow) / tex2.width);
          c.sp.alpha = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75;
        } else {
          const w = c.r * (1 - t);
          for (const side of [-1, 1]) {
            fx.ellipse(c.x + side * (c.r * 0.5 + w * 0.5), c.y, Math.max(1, w * 0.6), c.r * 0.62)
              .fill({ color: 0x8a1a3a, alpha: 0.75 * (1 - t * 0.4) });
          }
        }
        // 닫히는 순간 튀는 붉은 술 장식
        if (t < 0.35) {
          const ft = t / 0.35;
          for (let k = 0; k < 12; k++) {
            const ang = (k / 12) * Math.PI * 2;
            const dd = c.r * (0.3 + ft * 0.8);
            fx.circle(c.x + Math.cos(ang) * dd, c.y + Math.sin(ang) * dd * 0.5, 2.4 * (1 - ft) + 0.6)
              .fill({ color: k % 3 === 0 ? 0xffd86a : 0xff7a9a, alpha: (1 - ft) * 0.9 });
          }
        }
      }
    }
    // ── 「들이받기」: 지나온 길에 속도선이 쭉 남았다 흩어진다 (500ms) ──
    for (let i = ramTrails.length - 1; i >= 0; i--) {
      const r = ramTrails[i]!;
      const t = (now - r.start) / 500;
      if (t >= 1) { ramTrails.splice(i, 1); continue; }
      if (t < 0) continue;
      const fade = 1 - t;
      const dx = r.x1 - r.x0;
      const dy = r.y1 - r.y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;   // 진행 방향의 법선 — 선을 나란히 흩뿌린다
      const ny = dx / len;
      // 굵은 중심선 + 양옆으로 갈라지는 잔선 6가닥
      fx.moveTo(r.x0, r.y0).lineTo(r.x1, r.y1)
        .stroke({ color: 0xfff2c0, width: 3 * fade + 0.5, alpha: fade * 0.9 });
      for (let k = 0; k < 6; k++) {
        const off = ((k % 3) + 1) * 5 * (k < 3 ? 1 : -1) * (0.6 + t);
        // 뒤쪽부터 사라지도록 시작점을 앞으로 당긴다 (속도감)
        const s0 = Math.min(0.85, t * 1.3);
        const ax = r.x0 + dx * s0 + nx * off;
        const ay = r.y0 + dy * s0 + ny * off;
        const bx = r.x1 + nx * off * 0.4;
        const by = r.y1 + ny * off * 0.4;
        fx.moveTo(ax, ay).lineTo(bx, by)
          .stroke({ color: k % 2 === 0 ? 0xffffff : 0xffd88a, width: 1.4 * fade + 0.3, alpha: fade * 0.7 });
      }
      // 출발 지점에 남는 폭발적 먼지 고리
      if (t < 0.4) {
        const ft = t / 0.4;
        fx.ellipse(r.x0, r.y0, 10 + ft * 26, (10 + ft * 26) * 0.5)
          .stroke({ color: 0xffe0a0, width: 2 * (1 - ft), alpha: (1 - ft) * 0.8 });
      }
    }
    // ── 「나무껍질 장막」: 잎사귀가 솟아올라 감싼다 (700ms) ──
    for (let i = barkBursts.length - 1; i >= 0; i--) {
      const b = barkBursts[i]!;
      const t = (now - b.start) / 700;
      if (t >= 1) { barkBursts.splice(i, 1); continue; }
      if (t < 0) continue;
      const fade = 1 - t;
      for (let k = 0; k < 10; k++) {
        const ang = (k / 10) * Math.PI * 2 + b.r * 0.02;
        const dist = b.r * (0.3 + t * 0.75);
        const rise = t * 20;
        // 잎사귀 = 작은 마름모
        const lx = b.x + Math.cos(ang) * dist;
        const ly = b.y + Math.sin(ang) * dist * 0.5 - rise;
        const ls = 3.4 * fade + 1;
        fx.poly([lx, ly - ls, lx + ls * 0.6, ly, lx, ly + ls, lx - ls * 0.6, ly])
          .fill({ color: k % 3 === 0 ? 0xa8e878 : 0x5fbf4a, alpha: fade * 0.95 });
      }
    }
    // ── 「실의 폭풍」: 하늘에서 실이 쏟아져 그물을 짠다 (900ms) ──
    for (let i = threadNets.length - 1; i >= 0; i--) {
      const b = threadNets[i]!;
      const t = (now - b.start) / 900;
      if (t >= 1) { threadNets.splice(i, 1); continue; }
      if (t < 0) continue;
      const fade = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      const drop = Math.min(1, t * 2.4); // 실이 내려오는 진행도
      for (let k = 0; k < 14; k++) {
        const ang = (k / 14) * Math.PI * 2 + 0.2;
        const ex = b.x + Math.cos(ang) * b.r;
        const ey = b.y + Math.sin(ang) * b.r * 0.5;
        const topY = ey - 70 * (1 - drop);
        fx.moveTo(ex, topY).lineTo(ex, ey)
          .stroke({ color: 0xdfe4f0, width: 1, alpha: fade * 0.8 });
      }
      // 다 내려오면 바닥에 그물 고리
      if (drop >= 1) {
        fx.ellipse(b.x, b.y, b.r, b.r * 0.5).stroke({ color: 0xb0b8d0, width: 1.5, alpha: fade * 0.6 });
        fx.ellipse(b.x, b.y, b.r * 0.6, b.r * 0.3).stroke({ color: 0xdfe4f0, width: 1, alpha: fade * 0.5 });
      }
    }
    /*
     * ── 적 진입 예고 (마을 방어전) ──
     * 「다음 턴에 어느 숲길로 오는가」를 미리 알려 준다. 숲길 입구에서 마을
     * 쪽으로 붉은 화살표 세 개가 흘러가고, 입구에 맥동하는 고리가 남는다.
     * 이게 없으면 부대를 어디로 모을지 고를 근거가 없어 매 턴 도박이 된다.
     */
    if (laneWarns) {
      const beat = 0.5 + 0.5 * Math.sin(now * 0.006);
      for (let i = 0; i < laneWarns.length; i++) {
        const w = laneWarns[i]!;
        const ax = sx(w.x);
        const ay = sy(w.y);
        const bx = sx(w.toX);
        const by = sy(w.toY);
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const vert = curMap.vertical;
        // 입구 고리 — 바닥에 눕는 타원 (세로 맵은 축을 바꿔야 눕는다)
        const R = 30 * (1 + beat * 0.12);
        fx.ellipse(ax, ay, vert ? R * 0.55 : R, vert ? R : R * 0.55)
          .fill({ color: 0xff5a3c, alpha: 0.10 + beat * 0.08 });
        fx.ellipse(ax, ay, vert ? R * 0.55 : R, vert ? R : R * 0.55)
          .stroke({ color: 0xff8a6a, width: 3, alpha: 0.5 + beat * 0.4 });
        // 마을 쪽으로 흘러가는 화살촉 세 개
        for (let k = 0; k < 3; k++) {
          const t2 = ((now * 0.0009 + k * 0.33) % 1);
          const px2 = ax + ux * (34 + t2 * 78);
          const py2 = ay + uy * (34 + t2 * 78);
          const al = (1 - Math.abs(t2 - 0.5) * 2) * 0.95;
          const nx2 = -uy;
          const ny2 = ux;
          fx.poly([
            px2 + ux * 13, py2 + uy * 13,
            px2 - ux * 6 + nx2 * 9, py2 - uy * 6 + ny2 * 9,
            px2 - ux * 2, py2 - uy * 2,
            px2 - ux * 6 - nx2 * 9, py2 - uy * 6 - ny2 * 9,
          ]).fill({ color: 0xff7a55, alpha: al });
        }
        const lbl = warnLabels[i];
        if (lbl) {
          lbl.visible = true;
          lbl.x = ax;
          lbl.y = ay - 26;
          lbl.alpha = 0.75 + beat * 0.25;
          if (vert) { lbl.rotation = Math.PI / 2; lbl.x = ax - 34; lbl.y = ay; }
        }
      }
    } else {
      for (const t of warnLabels) t.visible = false;
    }
    // ── 출정 레인 표시 (두 갈래 맵): 고른 쪽에 불이 들어온다 ──
    if (deployLanes) {
      // 출정 표식: 굽은 길 위에 띠를 긋는 건 의미가 없다 (숲에 걸린다).
      // 대신 출정구에 큼지막한 관문 표식을 하나씩 세우고, 고른 쪽에 불을 켠다.
      /*
       * 출정 레인은 x 가 없어 출정구 한 줄에 나란히 서지만, 집합지(마을 방어전)는
       * 자기 x 를 들고 온다. 예전엔 전부 spawnX[0] 에 그려서 「1시 입구」와
       * 「11시 입구」 표식이 마을 한복판에 겹쳐 있었다.
       */
      const laneX0 = sx(g.map.spawnX[0]);
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.004);
      for (let li = 0; li < deployLanes.length; li++) {
        const lane = deployLanes[li]!;
        const chosen = li === deployChosenIdx;
        const gx = lane.x !== undefined ? sx(lane.x) : laneX0;
        const ly = sy(lane.x !== undefined ? laneCenterY(g.map, lane.x) + lane.y : lane.y);
        // 집합지는 「모였다」로 치는 실제 반경만큼 그린다 — 표식이 판정보다
        // 작으면 부대가 원 밖에 서 있는 것처럼 보인다 (마을 방어전)
        const R = lane.r ? (lane.r / FP) * TILE : 34;
        // 바닥에 눕는 원. 세로 맵은 월드가 90도 돌아 있어 축을 바꿔야 눕는다.
        const vertM = curMap.vertical;
        const grow = chosen ? 1 + pulse * 0.06 : 1;
        const rx = (vertM ? R * 0.55 : R) * grow;
        const ry = (vertM ? R : R * 0.55) * grow;
        const hue = lane.hold
          ? { fill: 0x4d9fd8, line: 0x9fd7ff }
          : { fill: 0xffb03d, line: 0xffd875 };
        fx.ellipse(gx, ly, rx, ry)
          .fill({ color: chosen ? hue.fill : 0x5c5140, alpha: chosen ? 0.16 + pulse * 0.1 : 0.12 });
        fx.ellipse(gx, ly, rx, ry)
          .stroke({ color: chosen ? hue.line : 0x9a8a6a, width: chosen ? 3 : 2, alpha: chosen ? 0.85 : 0.45 });
        // 안 고른 쪽엔 「눌러라」는 뜻으로 바깥 고리가 안쪽으로 오므라든다
        if (!chosen) {
          const t = (now * 0.0009) % 1;
          const k = 1.6 - t * 0.6;
          fx.ellipse(gx, ly, (vertM ? R * 0.55 : R) * k, (vertM ? R : R * 0.55) * k)
            .stroke({ color: 0xd8c088, width: 2, alpha: 0.35 * (1 - t) });
        }
        if (lane.hold) {
          // 「머무르기」는 나가지 않는다 — 화살표 대신 안으로 감기는 고리
          for (let k = 0; k < 3; k++) {
            const t2 = ((now * 0.0007 + k * 0.33) % 1);
            fx.ellipse(gx, ly, (vertM ? R * 0.55 : R) * (1.35 - t2 * 0.5),
              (vertM ? R : R * 0.55) * (1.35 - t2 * 0.5))
              .stroke({ color: chosen ? 0x9fd7ff : 0x8a99a8, width: 2, alpha: (chosen ? 0.55 : 0.25) * (1 - t2) });
          }
        } else {
          // 진군 방향 화살표 — 적진 쪽(+x)으로 흘러 나간다
          for (let k = 0; k < 3; k++) {
            const slide = (now * 0.0011 + k * 0.33) % 1;
            const ax = gx + R * 0.5 + slide * 46;
            const al = (1 - Math.abs(slide - 0.5) * 2) * (chosen ? 0.85 : 0.3);
            fx.poly([ax, ly - 8, ax + 13, ly, ax, ly + 8, ax + 4, ly])
              .fill({ color: chosen ? 0xffd070 : 0xbdae90, alpha: al });
          }
        }
        // 이름표를 관문 위에 얹는다
        const lbl = laneLabels[li];
        if (lbl) {
          lbl.visible = true;
          lbl.x = gx;
          lbl.y = ly - (curMap.vertical ? 0 : 44);
          if (curMap.vertical) { lbl.rotation = Math.PI / 2; lbl.x = gx - 52; }
          lbl.alpha = chosen ? 0.98 : 0.55;
          lbl.scale.set(chosen ? 1 + pulse * 0.05 : 0.9);
          lbl.style.fill = chosen ? 0xffe8a8 : 0xbfb49a;
        }
        // 고른 쪽 관문에 이는 불티
        if (chosen) {
          for (let k = 0; k < 6; k++) {
            const a = now * 0.0026 + k * 1.05;
            const rr = R * 0.75 + Math.sin(a * 1.7) * 6;
            fx.circle(gx + Math.cos(a) * rr, ly + Math.sin(a) * rr * 0.55, 2.6)
              .fill({ color: 0xffc84d, alpha: 0.55 + pulse * 0.35 });
          }
        }
      }
    }
    // ── 「가호」 시전: 빛기둥 + 위로 흩날리는 성광 (900ms) ──
    for (let i = blessBursts.length - 1; i >= 0; i--) {
      const bb = blessBursts[i]!;
      const t = (now - bb.start) / 900;
      if (t >= 1) {
        blessBursts.splice(i, 1);
        continue;
      }
      if (t < 0) continue;
      const fade = 1 - t;
      // 시전자에게 내리쬐는 빛기둥 — 위로 갈수록 옅어진다
      const colW = 13 * (0.6 + fade * 0.7);
      for (let k = 0; k < 3; k++) {
        const h = 46 - k * 12;
        fx.ellipse(ovx(bb.x, 0, -h * 0.5), ovy(bb.y, 0, -h * 0.5),
          ovw(colW * (1 - k * 0.22), h * 0.5), ovh(colW * (1 - k * 0.22), h * 0.5))
          .fill({ color: k === 0 ? 0xfff6d8 : 0xd8f0ff, alpha: fade * (0.22 - k * 0.05) });
      }
      // 발밑에 고이는 축복의 빛무리
      fx.ellipse(ovx(bb.x, 0, 4), ovy(bb.y, 0, 4),
        ovw(16 * (0.7 + t * 0.5), 6 * (0.7 + t * 0.5)), ovh(16 * (0.7 + t * 0.5), 6 * (0.7 + t * 0.5)))
        .fill({ color: 0xfff2c8, alpha: fade * 0.5 });
      // 사방으로 퍼지며 떠오르는 성광 알갱이 — 오라 반경까지 나아간다
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2 + 0.26;
        const ease = 1 - (1 - t) * (1 - t);
        const dist = bb.r * ease * 0.95;
        const rise = t * 22;
        const bdx = Math.cos(ang) * dist;
        const bdy = Math.sin(ang) * dist * 0.5 - rise;
        fx.circle(ovx(bb.x, bdx, bdy), ovy(bb.y, bdx, bdy), 2.6 * fade + 0.7)
          .fill({ color: k % 3 === 0 ? 0xfff0b0 : 0xc8ecff, alpha: fade * 0.95 });
      }
    }
    /*
     * 「질풍의 노래」 — 시전자를 축으로 초록 바람이 두 겹으로 돌아 나가고,
     * 그 바람에 잎사귀와 음표가 실려 반경 끝까지 흩어진다.
     * 공용 hasteAlly 고리(노란 원)와 색·모양을 모두 달리해 한눈에 구분된다.
     */
    for (let i = galeSongs.length - 1; i >= 0; i--) {
      const gs = galeSongs[i]!;
      const t = (now - gs.start) / 1100;
      if (t >= 1) { galeSongs.splice(i, 1); continue; }
      if (t < 0) continue;
      const fade = 1 - t;
      const ease = 1 - (1 - t) * (1 - t);
      // 소용돌이 두 겹 — 서로 반대로 돈다
      for (let arm = 0; arm < 2; arm++) {
        const dir = arm === 0 ? 1 : -1;
        for (let k = 0; k < 7; k++) {
          const a0 = dir * (now * 0.004) + (k / 7) * Math.PI * 2 + arm * 0.4;
          const rad = gs.r * (0.25 + ease * 0.8);
          const x0 = gs.x + Math.cos(a0) * rad;
          const y0 = gs.y + Math.sin(a0) * rad * 0.5;
          const a1 = a0 + dir * 0.5;
          const x1 = gs.x + Math.cos(a1) * rad * 1.12;
          const y1 = gs.y + Math.sin(a1) * rad * 0.5 * 1.12;
          fx.moveTo(x0, y0).lineTo(x1, y1)
            .stroke({ color: arm === 0 ? 0xb6f08a : 0xe8fff0, width: 2, alpha: fade * 0.8 });
        }
      }
      // 바람에 실린 잎사귀 — 나선을 그리며 위로 흩어진다
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 + t * 3.4;
        const dist = gs.r * ease * (0.5 + (k % 3) * 0.22);
        const rise = t * 26 + (k % 4) * 3;
        const lx = gs.x + Math.cos(a) * dist;
        const ly = gs.y + Math.sin(a) * dist * 0.5 - rise;
        // 잎: 짧은 선 두 개로 그린 갸름한 꼴
        const la = a + t * 5;
        fx.moveTo(lx - Math.cos(la) * 3, ly - Math.sin(la) * 1.6)
          .lineTo(lx + Math.cos(la) * 3, ly + Math.sin(la) * 1.6)
          .stroke({ color: k % 3 === 0 ? 0xffc8e8 : 0x8ce06a, width: 2.2, alpha: fade * 0.9 });
      }
      // 노래 — 음표 세 개가 천천히 떠오른다
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + t * 1.6;
        const nx = gs.x + Math.cos(a) * gs.r * 0.5;
        const ny = gs.y + Math.sin(a) * gs.r * 0.25 - t * 34 - 6;
        fx.circle(nx, ny, 2.4).fill({ color: 0xf0fff4, alpha: fade * 0.95 });
        fx.moveTo(nx + 2.2, ny).lineTo(nx + 2.2, ny - 7)
          .stroke({ color: 0xf0fff4, width: 1.6, alpha: fade * 0.95 });
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
      /*
       * 지형 생성이 도중에 터지면 그 뒤로 아무것도 안 깔린다 — 소품도 캠프도
       * 사라지고 지도가 단색 덩어리로 남는다. 실제로 그런 사고가 있었으므로
       * (해시를 부호 있는 시프트로 접어 인덱스가 음수가 됐다) 여기서 막고,
       * 대신 콘솔에 크게 남겨 원인을 바로 찾을 수 있게 한다.
       */
      try {
        buildGroundTiles();
      } catch (err) {
        console.error('[desertlike] 지형 생성 실패 — 그린 데까지만 남는다', err);
      }
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
      if (curMap.vertical) {
        // 세로 맵: 인자는 (월드 x 픽셀 = 진행축, 월드 y 픽셀 = 폭).
        // 화면 스크롤은 가로가 폭, 세로가 진행축(아래가 출발)이므로 축을 바꾼다.
        if (y !== undefined) camX = y - visibleW() / 2;
        camY = (scrollH() - x) - visibleH() / 2;
        clampCam();
        return;
      }
      camX = x - visibleW() / 2;
      if (y !== undefined) camY = y - visibleH() / 2;
      clampCam();
    },
    zoomBy(factor, anchorX, anchorY) {
      const ax = anchorX ?? app.screen.width / 2;
      const ay = anchorY ?? app.screen.height / 2;
      // 확대 기준점을 화면 스크롤 좌표로 잡아 둔다 (세로 맵도 같은 규칙 —
      // camX/camY 는 언제나 「화면」 가로·세로 스크롤이다)
      const sxAt = camX + ax / zoom;
      const syAt = camY + ay / zoom;
      userZoom = Math.min(USER_ZOOM_MAX, Math.max(USER_ZOOM_MIN, userZoom * factor));
      applyCamera();
      camX = sxAt - ax / zoom;
      camY = syAt - ay / zoom;
      clampCam();
      applyCamera(); // 바뀐 스크롤을 즉시 반영
    },
    view() {
      return { x0: camX, x1: camX + visibleW(), y0: camY, y1: camY + visibleH() };
    },
    pick(g, screenX, screenY) {
      // 화면 → 월드 px 역변환 후 발밑 기준 최근접 탐색.
      // 세로 맵은 컨테이너가 -90도 돌아 있으므로 축을 되돌린다.
      let wx: number;
      let wy: number;
      if (curMap.vertical) {
        const rx = (screenX - world.x) / zoom;
        const ry = (screenY - world.y) / zoom;
        wx = -ry;   // 화면 세로(위로 갈수록 진행) → 월드 x
        wy = rx;    // 화면 가로 → 월드 y
      } else {
        wx = (screenX - world.x) / zoom;
        wy = (screenY - world.y) / zoom;
      }
      let best: number | null = null;
      let bestD = 26 * 26; // 최대 26px 반경
      for (const e of g.entities) {
        if (!e.alive) continue;
        const d = (e.defOv ?? DEFS[e.defId])!;   // 변신 중이면 그 높이로 집는다
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
    pickLaneY(screenY) {
      // 세로 맵에서는 「레인」이 화면 가로 방향이므로 x 를 받아야 한다 —
      // 호출부가 화면 x 를 넘겨 준다 (main.ts 참조).
      const w = curMap.vertical ? (screenY - world.x) / zoom : (screenY - world.y) / zoom;
      return worldYToFP(w);
    },
    pickLaneMark(screenX, screenY) {
      // 세로 맵(14 출정 경로)은 월드가 90도 돌아 있어 이 판정을 쓰지 않는다 —
      // 거기선 예전처럼 빈 땅을 눌러 길을 고른다.
      if (!deployLanes || curMap.vertical) return null;
      const wx = (screenX - world.x) / zoom;
      const wy = (screenY - world.y) / zoom;
      const R = 34;
      // 그릴 때 쓰는 반지름과 같게. 누르기 쉽도록 조금만 넉넉히 잡는다.
      const rx = R * 1.2;
      const ry = R * 0.55 * 1.35;
      for (let i = 0; i < deployLanes.length; i++) {
        const lane = deployLanes[i]!;
        const gx = lane.x !== undefined ? sx(lane.x) : sx(curMap.spawnX[0]);
        const ly = sy(lane.x !== undefined ? laneCenterY(curMap, lane.x) + lane.y : lane.y);
        const dx = (wx - gx) / rx;
        const dy = (wy - ly) / ry;
        if (dx * dx + dy * dy <= 1) return i;
      }
      return null;
    },
    quietRemove(id) { quietIds.add(id); },
    setGoldMines(mines) {
      goldMines = mines;
    },
    setLaneWarnings(marks) {
      laneWarns = marks;
      while (warnLabels.length > (marks?.length ?? 0)) {
        const t = warnLabels.pop();
        if (t) { t.visible = false; t.destroy(); }
      }
      while (marks && warnLabels.length < marks.length) {
        const t = new Text({
          text: '',
          style: { fontFamily: 'sans-serif', fontSize: 15, fontWeight: '700',
            fill: 0xffb0a0, stroke: { color: 0x2a0d08, width: 4 }, align: 'center' },
        });
        t.anchor.set(0.5, 1);
        t.zIndex = 9000;
        units.addChild(t);
        warnLabels.push(t);
      }
      for (let i = 0; i < (marks?.length ?? 0); i++) warnLabels[i]!.text = marks![i]!.label;
    },
    setDeployLanes(lanes, chosenIdx) {
      deployLanes = lanes;
      deployChosenIdx = chosenIdx;
      // 이름표를 레인 수에 맞춰 만들어 두고, 좌표·강조는 매 프레임 갱신한다
      while (laneLabels.length > (lanes?.length ?? 0)) {
        const t = laneLabels.pop();
        if (t) { t.destroy(); }
      }
      while (lanes && laneLabels.length < lanes.length) {
        const t = new Text({
          text: '',
          style: { fontFamily: 'sans-serif', fontSize: 15, fontWeight: '700',
            fill: 0xffe8a8, stroke: { color: 0x1a1206, width: 4 }, align: 'center' },
        });
        t.anchor.set(0.5);
        t.zIndex = 9000;
        units.addChild(t);
        laneLabels.push(t);
      }
      for (let i = 0; i < (lanes?.length ?? 0); i++) laneLabels[i]!.text = lanes![i]!.label;
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
  /*
   * 손그림 지형(bgImage) 맵은 바닥을 아무것도 덧그리지 않는다.
   *
   * 아래의 진영 바닥 틴트와 중앙선은 코드 지형(모래 체커) 시절의 안내선이다.
   * 작가가 절벽·언덕·계단까지 그려 넣은 그림 위에 얹으면 맵 한복판을 가로지르는
   * 밝은 줄이 생겨 지형이 잘려 보인다.
   */
  if (curMap.bgImage) return;
  gr.clear();
  const m = curMap;
  const tilesX = m.length / FP;
  const halfH = renderHalfH(m);
  const tilesY = Math.ceil((halfH * 2) / FP);
  const th = TILE * (m.vertical ? 1 : Y_SQUASH);
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
