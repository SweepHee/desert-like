/**
 * 절차 생성 도트 스프라이트 (플레이스홀더).
 *
 * 문자 픽셀맵 → 캔버스 → PIXI 텍스처. 종족 팔레트 스왑 + 팀 컬러 채널('t')로
 * 소수의 실루엣을 재활용한다. 나중에 진짜 도트 에셋(PNG 스프라이트시트)이
 * 생기면 이 파일만 교체하면 된다.
 *
 * 문자: . 투명 / o 외곽선 / a 주색 / A 주색 음영 / b 강조색 / s 피부
 *       w 강철 / d 나무·가죽 / t 팀컬러 / g 발광
 */
import { Texture } from 'pixi.js';
import { DEFS } from '@desertlike/sim';

type Palette = Record<string, string>;

const BASE: Palette = {
  o: '#241812',
  s: '#e8b48c',
  w: '#c2ccd4',
  d: '#8a5c34',
  g: '#ffe98a',
};

const RACE_PAL: Record<string, Palette> = {
  sylvarin: { a: '#4e9a4e', A: '#33673a', b: '#c9e08a', s: '#e8c9a0' },
  pandemonium: { a: '#5a4a72', A: '#38304a', b: '#7fe89a', s: '#cfd6dd' },
  marionetta: { a: '#c96a8e', A: '#8a4560', b: '#e8c559', s: '#f0e0d0' },
  none: { a: '#8a8a8a', A: '#5e5e5e', b: '#d0d0d0' },
};

const TEAM_COLOR = ['#57a0ff', '#ff6a57'] as const;

// ── 실루엣 ────────────────────────────────────────────────────────────────

const SHAPES: Record<string, string[]> = {
  soldier: [
    '...ooo....',
    '..ossso...',
    '..ossso...',
    '.woaaao...',
    '.woabatoo.',
    '.woabato..',
    '.woaaao...',
    '..oAAAo...',
    '..oA.Ao...',
    '..oo.oo...',
  ],
  axeman: [
    '...ooo....',
    '..osssoww.',
    '..osssoow.',
    '..oaaaodw.',
    '..oabado..',
    '..oabado..',
    '..oaaado..',
    '..oAAAo...',
    '..oA.Ao...',
    '..oo.oo...',
  ],
  archer: [
    '...ooo..d.',
    '..osssod..',
    '..osssod..',
    '..oaaaod..',
    '..oabaodd.',
    '..oabaod..',
    '..oaaaod..',
    '..oAAAod..',
    '..oA.Ao.d.',
    '..oo.oo...',
  ],
  rider: [
    '....ooo...',
    '...osssow.',
    '...oaaaow.',
    '..ooabaow.',
    '.oaaaaaao.',
    'oAaaaaaaAo',
    'o.AAAAAA.o',
    '.oA.oo.Ao.',
    '.oo....oo.',
  ],
  brute: [
    '...oooo..ww.',
    '..ossssooww.',
    '..ossssoodd.',
    '.oaaaaaaod..',
    '.oaabbaaod..',
    '.oaabbaaod..',
    '.oaaaaaaod..',
    '..oAAAAo.d..',
    '..oA..Ao....',
    '..oo..oo....',
  ],
  mage: [
    '....ooo...',
    '...osssog.',
    '...osssod.',
    '...oaaaod.',
    '..oabbaod.',
    '..oabbaod.',
    '.oaaaaaod.',
    '.oAAAAAod.',
    '.oAAAAAo..',
    '.ooooooo..',
  ],
  priest: [
    '..g.ooo.g.',
    '...osssso.',
    '...ossso..',
    '..obbbbo..',
    '..obaabo..',
    '..obaabo..',
    '.obbbbbbo.',
    '.oAAAAAAo.',
    '.oAAAAAAo.',
    '.oooooooo.',
  ],
  golem: [
    '..oooooo..',
    '.obaaaabo.',
    '.oag..gao.',
    '.oaaaaaao.',
    'ooaabbaaoo',
    'oaoaaaaoao',
    'oaoAAAAoao',
    '.o.AAAA.o.',
    '..oA..Ao..',
    '..oo..oo..',
  ],
  ballista: [
    '.w........w.',
    '..w..oo..w..',
    '...woooow...',
    '..oddddddo..',
    '.odaaaaaado.',
    '.odabbaaado.',
    '.oddddddddo.',
    '..oo.oo.oo..',
    '..o..oo..o..',
  ],
  mammoth: [
    '....oooooo......',
    '..ooaaaaaaoo....',
    '.oaaaaaaaaaaoo..',
    'oaabaaaaaaaaaao.',
    'oabaoaaaaaaaaao.',
    'oaao.oaaaaaaao..',
    '.ow..oAAAAAAo...',
    '.ow..oA.oo.Ao...',
    '.....oo....oo...',
  ],
  flyer: [
    '.oo........oo.',
    'oaao......oaao',
    'oaaaoooooaaaao',
    '.oaaaaaaaaaao.',
    '..oaabssbaao..',
    '...oaaaaaao...',
    '....oAAAo.....',
    '.....oAo......',
    '......o.......',
  ],
  shaman: [
    '.g..ooo..g.',
    '.d.osssod..',
    '.dooaaaood.',
    '..obabbao..',
    '..obabbao..',
    '.oaaaaaao..',
    '.oAAAAAAo..',
    '.oAAAAAAo..',
    '.ooooooo...',
  ],
  tower: [
    '....oooooo....',
    '...ot.tt.to...',
    '...oaaaaaao...',
    '..oobbbbbboo..',
    '..oaaaaaaaao..',
    '..oaag..gaao..',
    '..oaaaaaaaao..',
    '..oAaaaaaaAo..',
    '..oAaaaaaaAo..',
    '..oAAaaaaAAo..',
    '.ooAAAAAAAAoo.',
    '.oAAAAAAAAAAo.',
    '.oooooooooooo.',
  ],
  nexus: [
    '.......oo.......',
    '......oggo......',
    '.....oggggo.....',
    '.....oggggo.....',
    '....obggggbo....',
    '....obaaaabo....',
    '...otaaaaaato...',
    '...oaaaggaaao...',
    '..oaaaaggaaaao..',
    '..oaaaaggaaaao..',
    '..oAaaaaaaaaAo..',
    '.ooAAaaaaaaAAoo.',
    '.oAAAAAAAAAAAAo.',
    '.oooooooooooooo.',
  ],
  dragon: [
    '..oo..........oo..',
    '.oaao........oaao.',
    '.oaaao......oaaao.',
    '..oaaaoooooaaaao..',
    '...oaaaaaaaaaao...',
    '.oooabbaaabbaooo..',
    'og.oaaaaaaaaaao.g.',
    '.ooaaosaaasoaaoo..',
    '...oaaaaaaaaao....',
    '....oAAAAAAAo.....',
    '.....oA...Ao......',
    '......o...o.......',
  ],
  // 슬리피 할로우: 목 없는 기사. 투구를 옆구리에 끼고 떠다닌다.
  hollow: [
    '......gg........',
    '.....g..g.......',
    '....oooooo..w...',
    '...oaabbaao.w...',
    '..oaaaaaaaaow...',
    '..oaagaagaaow...',
    '.oaaaaaaaaaaow..',
    '.oaabaaaabaao...',
    '.oaaaaaaaaaao...',
    '..oAAAAAAAAogo..',
    '..oAAAAAAAoggo..',
    '...oAAAAAo.gg...',
    '....ooooo.......',
  ],
};

/**
 * defId → 실루엣 + 팔레트 배정.
 * 픽셀랩 에셋이 도착하기 전까지의 플레이스홀더 매핑 — 실루엣은 역할만 얼추 맞춘 것.
 */
const LOOK: Record<string, { shape: string; pal: string; accent?: string }> = {
  // 🌲 실바린 (v0.2)
  s_gouto: { shape: 'soldier', pal: 'sylvarin', accent: '#f0e6d0' },
  s_elf_archer: { shape: 'archer', pal: 'sylvarin' },
  s_marmot: { shape: 'brute', pal: 'sylvarin', accent: '#a8845c' },
  s_vine_hunter: { shape: 'rider', pal: 'sylvarin' },
  s_mushroom_bomber: { shape: 'shaman', pal: 'sylvarin', accent: '#e08a8a' },
  s_druid: { shape: 'priest', pal: 'sylvarin' },
  s_treekeeper: { shape: 'golem', pal: 'sylvarin', accent: '#8a6c42' },
  s_thorn_witch: { shape: 'mage', pal: 'sylvarin', accent: '#3d2e4a' },
  s_owl: { shape: 'flyer', pal: 'sylvarin', accent: '#c9a86a' },
  s_butterfly: { shape: 'flyer', pal: 'sylvarin', accent: '#e8a0d0' },
  s_treant: { shape: 'mammoth', pal: 'sylvarin', accent: '#8a6c42' },
  s_apostle: { shape: 'mammoth', pal: 'sylvarin', accent: '#ffe98a' },
  s_wyvern: { shape: 'dragon', pal: 'sylvarin', accent: '#6cbf5a' },
  s_unicorn: { shape: 'flyer', pal: 'sylvarin', accent: '#f0ead8' },
  s_fairy: { shape: 'flyer', pal: 'sylvarin', accent: '#ffe98a' },
  s_marksman: { shape: 'archer', pal: 'sylvarin', accent: '#c9d8a8' },
  s_sage: { shape: 'mage', pal: 'sylvarin', accent: '#f0f0f0' },
  // ☠️ 판데모니엄 (v0.2)
  p_deadman: { shape: 'soldier', pal: 'pandemonium' },
  p_skeleton: { shape: 'axeman', pal: 'pandemonium', accent: '#e8e4da' },
  p_hound: { shape: 'rider', pal: 'pandemonium', accent: '#8a8296' },
  p_bone_thrower: { shape: 'archer', pal: 'pandemonium', accent: '#e8e4da' },
  p_headless_knight: { shape: 'hollow', pal: 'pandemonium' },
  merc_headless_knight: { shape: 'hollow', pal: 'pandemonium' },
  merc_lich: { shape: 'mage', pal: 'pandemonium', accent: '#7fe89a' },
  merc_thanatos: { shape: 'shaman', pal: 'pandemonium', accent: '#2e2838' },
  p_banshee: { shape: 'priest', pal: 'pandemonium', accent: '#bcd4e8' },
  p_thanatos: { shape: 'shaman', pal: 'pandemonium', accent: '#2e2838' },
  p_corpse_golem: { shape: 'golem', pal: 'pandemonium' },
  p_wraith: { shape: 'flyer', pal: 'pandemonium', accent: '#bcd4e8' },
  p_mammon: { shape: 'brute', pal: 'pandemonium', accent: '#7fe89a' },
  p_summoner: { shape: 'shaman', pal: 'pandemonium', accent: '#e8e4da' },
  p_lich: { shape: 'mage', pal: 'pandemonium', accent: '#7fe89a' },
  p_demilich: { shape: 'flyer', pal: 'pandemonium', accent: '#e8c559' },
  p_minion_ghoul: { shape: 'soldier', pal: 'pandemonium', accent: '#8a9c6a' },
  p_minion_undead: { shape: 'soldier', pal: 'pandemonium' },
  p_minion_skeleton: { shape: 'axeman', pal: 'pandemonium', accent: '#e8e4da' },
  p_minion_rat: { shape: 'rider', pal: 'pandemonium', accent: '#8a8296' },
  // 🧸 마리오네타 (v0.2)
  m_plushbear: { shape: 'golem', pal: 'marionetta', accent: '#a8845c' },
  m_clockwork_soldier: { shape: 'archer', pal: 'marionetta' },
  m_button_doll: { shape: 'priest', pal: 'marionetta', accent: '#6ab8e8' },
  m_puppet_swordsman: { shape: 'soldier', pal: 'marionetta' },
  m_clockwork_spider: { shape: 'rider', pal: 'marionetta', accent: '#b8b8c4' },
  m_clown_doll: { shape: 'brute', pal: 'marionetta', accent: '#6ab8e8' },
  m_cursed_doll: { shape: 'soldier', pal: 'marionetta', accent: '#c94040' },
  m_casper: { shape: 'mage', pal: 'marionetta', accent: '#dce8f0' },
  m_puppet_ann: { shape: 'flyer', pal: 'marionetta', accent: '#c94040' },
  m_specter_teddy: { shape: 'flyer', pal: 'marionetta', accent: '#bcd4e8' },
  m_gore_teddy: { shape: 'mammoth', pal: 'marionetta', accent: '#8a3030' },
  m_alice: { shape: 'shaman', pal: 'marionetta', accent: '#e8c559' },
  m_grandfather_clock: { shape: 'golem', pal: 'marionetta', accent: '#a8845c' },
  m_pennywise: { shape: 'flyer', pal: 'marionetta', accent: '#c94040' },
  m_thread_needle: { shape: 'flyer', pal: 'marionetta', accent: '#c94040' },
  m_clocktower_gear: { shape: 'golem', pal: 'marionetta', accent: '#c9a86a' },
  // 캠페인 특수 유닛
  c_ash_revenant: { shape: 'flyer', pal: 'pandemonium', accent: '#bcd4e8' },
  c_mad_ballerina: { shape: 'flyer', pal: 'marionetta', accent: '#c94040' },
  c_bone_colossus: { shape: 'golem', pal: 'pandemonium', accent: '#e8e4da' },
  c_radamanthus: { shape: 'flyer', pal: 'pandemonium', accent: '#8a6fd0' },
  c_void_necromancer: { shape: 'mage', pal: 'pandemonium', accent: '#7de0a0' },
  c_dread_gargoyle: { shape: 'flyer', pal: 'pandemonium', accent: '#e8c559' },
  c_kurga: { shape: 'mage', pal: 'pandemonium', accent: '#7fe89a' },
  c_mammon_lord: { shape: 'brute', pal: 'pandemonium', accent: '#e8c559' },
  c_balthar: { shape: 'flyer', pal: 'pandemonium', accent: '#e8c559' },
  // 중립 구조물/수호자
  teddy_guardian: { shape: 'soldier', pal: 'none' },
  c_balthar_general: { shape: 'hollow', pal: 'pandemonium' },
  c_nest_wyvern: { shape: 'flyer', pal: 'sylvarin' },
  c_nest_unicorn: { shape: 'flyer', pal: 'sylvarin' },
  c_nest_fairy: { shape: 'flyer', pal: 'sylvarin' },
  c_wild_wolf_gray: { shape: 'rider', pal: 'none' },
  c_wild_snake: { shape: 'rider', pal: 'none' },
  c_wild_wolf_black: { shape: 'rider', pal: 'none' },
  c_wild_tarantula: { shape: 'rider', pal: 'none' },
  c_wild_kestrel: { shape: 'flyer', pal: 'none' },
  c_wild_bear_gray: { shape: 'rider', pal: 'none' },
  c_wild_direwolf: { shape: 'rider', pal: 'none' },
  c_wild_grizzly: { shape: 'rider', pal: 'none' },
  // 호위전(13) 소품 — PNG 누락 시 임시 형상
  c_supply_cart: { shape: 'golem', pal: 'none' },
  c_alice_soldier: { shape: 'archer', pal: 'marionetta' },
  c_elowyn: { shape: 'mage', pal: 'sylvarin' },
  c_evergreen: { shape: 'archer', pal: 'sylvarin' },
  c_kael: { shape: 'soldier', pal: 'sylvarin' },
  c_bone_cannon: { shape: 'tower', pal: 'pandemonium' },
  c_sage_watchtower: { shape: 'tower', pal: 'sylvarin' },
  c_sage_watchtower_s: { shape: 'tower', pal: 'sylvarin' },
  c_ember_tree2: { shape: 'tower', pal: 'none' },
  p_bone_dragon: { shape: 'dragon', pal: 'pandemonium' },
  p_coffin_bearer: { shape: 'brute', pal: 'pandemonium' },
  p_succubus: { shape: 'mage', pal: 'pandemonium' },
  p_succubus_demon: { shape: 'mage', pal: 'pandemonium' },
  p_dream_mare: { shape: 'rider', pal: 'pandemonium' },
  p_incubus: { shape: 'soldier', pal: 'pandemonium' },
  p_dementor: { shape: 'flyer', pal: 'pandemonium', accent: '#6a5a80' },
  m_ballista: { shape: 'golem', pal: 'marionetta', accent: '#c8543a' },
  m_white_rabbit: { shape: 'priest', pal: 'marionetta', accent: '#f4f0e8' },
  m_mad_hatter: { shape: 'mage', pal: 'marionetta', accent: '#3fa85a' },
  m_drosselmeyer: { shape: 'shaman', pal: 'marionetta', accent: '#2a3a80' },
  m_nutcracker: { shape: 'soldier', pal: 'marionetta', accent: '#c03030' },
  c_grave_warden: { shape: 'brute', pal: 'pandemonium', accent: '#8a7fd0' },
  c_bone_grave: { shape: 'golem', pal: 'pandemonium', accent: '#d8d0b8' },
  s_dryad: { shape: 'priest', pal: 'sylvarin', accent: '#5fbf4a' },
  s_elurion: { shape: 'dragon', pal: 'sylvarin', accent: '#3fa878' },
  s_oberon: { shape: 'flyer', pal: 'sylvarin', accent: '#9a6ad0' },
  c_sylvarin_tent: { shape: 'golem', pal: 'sylvarin' },
  c_sylvarin_tent2: { shape: 'golem', pal: 'sylvarin' },
  c_camp_fire: { shape: 'golem', pal: 'none' },
  c_camp_crates: { shape: 'golem', pal: 'none' },
  c_sylvarin_banner: { shape: 'tower', pal: 'sylvarin' },
  c_alice_teddy: { shape: 'mammoth', pal: 'marionetta', accent: '#8a3030' },
  c_burning_tree: { shape: 'tower', pal: 'none' },
  c_ember_tree: { shape: 'tower', pal: 'none' },
  c_burning_log: { shape: 'golem', pal: 'none' },
  c_wild_blackbird: { shape: 'flyer', pal: 'none' },
  tower: { shape: 'tower', pal: 'none' },
  nexus: { shape: 'nexus', pal: 'none', accent: '#7fe8d8' },
  dragon: { shape: 'dragon', pal: 'none' },
  hollow: { shape: 'hollow', pal: 'none' },
};

// 수호자·구조물은 좀 더 진한 고유색.
const SPECIAL_PAL: Record<string, Palette> = {
  dragon: { a: '#b8483a', A: '#7e2f26', b: '#e8a545', g: '#ffb35c' },
  hollow: { a: '#4a4a5c', A: '#2e2e3c', b: '#8a94b8', g: '#7fe89a' },
  tower: { a: '#b09a70', A: '#7e6c4c', b: '#8a7a52' },
  nexus: { a: '#c9b283', A: '#8e7c58', b: '#e0d0a8', g: '#7fe8d8' },
};

const PIXEL = 4; // 픽셀당 캔버스 px (텍스처 해상도)

export interface SpriteArt {
  canvas: HTMLCanvasElement;
  texture: Texture;
  /** 픽셀맵 크기 (스케일 전). */
  w: number;
  h: number;
}

const cache = new Map<string, SpriteArt>();

export function artOf(defId: string, team: 0 | 1): SpriteArt {
  const key = `${defId}:${team}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // 미등록 유닛은 게임을 죽이는 대신 기본 실루엣으로 폴백한다
  // (신유닛 추가 시 LOOK 등록 누락 = 종족 전체 시작 불가였던 사고 방지).
  const look = LOOK[defId] ?? { shape: 'soldier', pal: 'none' };
  // 등록은 됐지만 없는 shape 을 가리키는 경우까지 폴백한다 —
  // 예전엔 여기서 그대로 터져 종족 전체가 시작 불가였다 ('wing' 사고).
  const rows = SHAPES[look.shape] ?? SHAPES.soldier!;
  const pal: Palette = {
    ...BASE,
    ...(RACE_PAL[look.pal] ?? RACE_PAL.none!),
    ...(SPECIAL_PAL[defId] ?? {}),
    t: TEAM_COLOR[team],
  };
  if (look.accent) pal.b = look.accent;

  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const canvas = document.createElement('canvas');
  canvas.width = w * PIXEL;
  canvas.height = h * PIXEL;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const c = row[x]!;
      if (c === '.' || c === ' ') continue;
      ctx.fillStyle = pal[c] ?? '#ff00ff';
      ctx.fillRect(x * PIXEL, y * PIXEL, PIXEL, PIXEL);
    }
  }
  // 팀 식별 밑줄 (유닛 발밑 배너).
  const d = DEFS[defId];
  if (d && d.tier !== 'structure') {
    ctx.fillStyle = TEAM_COLOR[team];
    ctx.globalAlpha = 0.9;
    ctx.fillRect(Math.floor(w * PIXEL * 0.25), h * PIXEL - 2, Math.floor(w * PIXEL * 0.5), 2);
    ctx.globalAlpha = 1;
  }

  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  const art: SpriteArt = { canvas, texture, w, h };
  cache.set(key, art);
  return art;
}

/** 상점 버튼용 데이터 URL 아이콘. */
export function iconUrl(defId: string, team: 0 | 1): string {
  return artOf(defId, team).canvas.toDataURL();
}
