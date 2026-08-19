/**
 * 타이틀 화면.
 *
 * 종족 아트 4종 중 하나가 들어올 때마다 무작위로 걸린다. 메뉴 버튼은 그림에
 * 이미 그려져 있으므로, 클릭은 그 위에 얹은 투명 핫스팟이 받는다. 핫스팟
 * 좌표는 원본 아트(767×511) 기준 픽셀을 비율로 환산해 넣기 때문에 화면이
 * 커지든 작아지든 그림 속 버튼과 어긋나지 않는다 — 아트마다 메뉴 상자의
 * 위치·크기가 조금씩 달라서 좌표도 변종별로 따로 잰다.
 *
 * 넷째 칸 「로그인」도 나머지와 똑같은 버튼이다. 공식 구글 버튼은 크로스
 * 오리진 iframe 이라 우리 UI 와 섞이지 않으므로(마우스 이벤트가 안 넘어와
 * 호버 불이 안 켜졌다), 클릭하면 OAuth2 팝업을 직접 여는 방식으로 바꿨다.
 * 로그인한 뒤에는 그 칸이 계정 이름 패널로 바뀌고, 누르면 로그아웃한다.
 *
 * 고른 아트는 타이틀에서 끝나지 않고, 이어지는 메뉴 화면의 배경(흐림)과
 * 강조색으로 남는다 — 캠페인·대전으로 넘어가는 흐름을 끊지 않으려고.
 */
import type { Audio } from './audio.ts';

export type TitleAction = 'campaign' | 'solo' | 'versus' | 'login' | 'quit';

/** 아트 원본 크기. 아래 좌표는 전부 이 기준의 픽셀. */
const ART_W = 767;
const ART_H = 511;

/** 그림에 그려진 메뉴 상자 — 아트마다 위치·크기가 다르다. */
interface MenuBox {
  readonly x: number;
  readonly w: number;
  /** 버튼 5개의 윗변 y. */
  readonly tops: readonly [number, number, number, number, number];
  /** 버튼 5개의 높이. */
  readonly hs: readonly [number, number, number, number, number];
}

interface Variant {
  id: string;
  /** 아트에 새겨진 종족명. 이어지는 화면의 부제로 그대로 쓴다. */
  sub: string;
  src: string;
  /** 강조색 (r g b) — 메뉴 화면의 --gold 를 이 색으로 물들인다. */
  rgb: string;
  menu: MenuBox;
}

const VARIANTS: Variant[] = [
  { id: 'sylvarin', sub: 'SYLVARIN', src: '/assets/ui/title_sylvarin.jpg',
    rgb: '141 206 74',
    menu: { x: 422, w: 169, tops: [211, 258, 302, 348, 395], hs: [38, 36, 37, 38, 37] } },
  { id: 'pandemonium', sub: 'PANDEMONIUM', src: '/assets/ui/title_pandemonium.jpg',
    rgb: '166 122 224',
    menu: { x: 320, w: 197, tops: [238, 287, 335, 383, 432], hs: [40, 39, 39, 40, 39] } },
  { id: 'marioneta', sub: 'MARIONETA', src: '/assets/ui/title_marioneta.jpg',
    rgb: '224 106 132',
    menu: { x: 332, w: 199, tops: [238, 287, 335, 383, 432], hs: [40, 39, 39, 40, 39] } },
  { id: 'karja', sub: 'KARJA', src: '/assets/ui/title_karja.jpg',
    rgb: '232 178 92',
    menu: { x: 419, w: 172, tops: [211, 258, 302, 348, 395], hs: [38, 36, 37, 38, 37] } },
];

/** 그림에 그려진 순서 그대로. 핫스팟 i 번이 곧 이 순서. */
const ITEMS: { action: TitleAction; label: string }[] = [
  { action: 'campaign', label: '캠페인' },
  { action: 'solo', label: '연습모드' },
  { action: 'versus', label: '대전게임' },
  { action: 'login', label: '로그인' },
  { action: 'quit', label: '종료' },
];
/** 「로그인」 칸의 순서 — 구글 버튼을 덮을 자리. */
const LOGIN_I = 3;

const LS_LAST = 'dl_title_last';
/** 페이드 아웃이 끝나고 다음 화면을 여는 시점 (CSS transition 과 맞춤). */
const FADE_MS = 340;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let variant: Variant = VARIANTS[0]!;
let hots: HTMLElement[] = [];
let sel = 0;
/** 「로그인」 칸 (구글 버튼과 계정 패널이 그 안에 들어 있다). */
let loginHot: HTMLElement | null = null;

/** 이번 접속에 걸린 아트의 종족명 (메뉴 화면 부제용). */
export function titleSubtitle(): string {
  return variant.sub;
}

/**
 * 「로그인」 칸을 계정 상태에 맞춰 바꾼다 (null = 로그아웃 상태).
 * 로그인하면 그림에 그려진 「로그인」 글자를 계정 이름 패널이 덮는다.
 */
export function setTitleAccount(p: { name: string; picture: string } | null): void {
  if (!loginHot) return;
  const me = $('#tl-me');
  me.classList.toggle('hidden', !p);
  loginHot.classList.toggle('me', !!p);
  if (p) {
    ($('#tl-pic') as HTMLImageElement).src = p.picture || '';
    $('#tl-name').textContent = p.name;
  }
}

/** 그림이 화면에서 차지한 크기를 재서 --art-scale 로 알린다 (계정 패널 글자 크기용). */
function syncArtScale(): void {
  const img = document.querySelector('#title-img') as HTMLImageElement | null;
  const w = img?.clientWidth ?? 0;
  if (w > 0) document.documentElement.style.setProperty('--art-scale', (w / ART_W).toFixed(4));
}

/** 직전에 봤던 아트는 빼고 뽑는다 — 같은 그림이 연달아 나오면 랜덤이 아닌 것처럼 보인다. */
function pickVariant(): Variant {
  let last: string | null = null;
  try { last = localStorage.getItem(LS_LAST); } catch { /* 사생활 모드 */ }
  const pool = VARIANTS.filter((v) => v.id !== last);
  const from = pool.length > 0 ? pool : VARIANTS;
  const v = from[Math.floor(Math.random() * from.length)]!;
  try { localStorage.setItem(LS_LAST, v.id); } catch { /* 사생활 모드 */ }
  return v;
}

function paint(): void {
  hots.forEach((b, i) => b.classList.toggle('sel', i === sel));
}

function visible(): boolean {
  const el = $('#title');
  return !el.classList.contains('hidden') && !el.classList.contains('fading');
}

export function showTitle(): void {
  const el = $('#title');
  el.classList.remove('fading');
  el.classList.remove('hidden');
  sel = 0;
  paint();
  syncArtScale(); // 숨어 있는 동안엔 크기를 잴 수 없었다
}

export function hideTitle(): void {
  const el = $('#title');
  el.classList.remove('fading');
  el.classList.add('hidden');
}

/**
 * 아트를 고르고 핫스팟을 얹는다. 실제 화면 표시는 showTitle 이 맡는다
 * (캠페인 자동 진입처럼 타이틀을 건너뛰는 경로가 있어서 분리했다).
 */
export function initTitle(audio: Audio, onPick: (a: TitleAction) => void): void {
  variant = pickVariant();
  const root = document.documentElement;
  root.style.setProperty('--title-art', `url("${variant.src}")`);
  root.style.setProperty('--tt-rgb', variant.rgb);

  const art = $('.title-art');
  const img = $<HTMLImageElement>('#title-img');
  const ready = (): void => {
    img.classList.add('ready');
    syncArtScale();
  };
  img.addEventListener('load', ready, { once: true });
  img.src = variant.src;
  if (img.complete) ready();

  // 아트가 화면에 맞춰 늘고 줄면 계정 패널 글자도 같은 비율로 따라간다
  new ResizeObserver(syncArtScale).observe(img);
  window.addEventListener('resize', syncArtScale);
  syncArtScale();

  const m = variant.menu;
  const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;
  hots = ITEMS.map((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'title-hot';
    b.setAttribute('aria-label', it.label);
    b.style.left = pct(m.x / ART_W);
    b.style.width = pct(m.w / ART_W);
    b.style.top = pct(m.tops[i]! / ART_H);
    b.style.height = pct(m.hs[i]! / ART_H);
    if (i === LOGIN_I) {
      // 로그인하면 그림 속 「로그인」 글자를 계정 패널이 덮는다
      b.classList.add('title-login');
      b.innerHTML = '<span class="tl-me hidden" id="tl-me">'
        + '<img id="tl-pic" alt="" /><span id="tl-name"></span>'
        + '<span class="tl-out">로그아웃</span></span>';
      loginHot = b;
    }
    b.addEventListener('click', () => {
      sel = i;
      paint();
      // 로그인은 화면을 넘기지 않는다 — 팝업만 뜨고 타이틀에 그대로 머문다
      if (i === LOGIN_I) { audio.play('ui_click', { volume: 0.5 }); onPick('login'); return; }
      choose(audio, onPick, it.action);
    });
    art.appendChild(b);
    return b;
  });
  paint();

  /*
   * 어느 칸에 불을 켤지는 커서 좌표로 직접 판정한다.
   *
   * 칸마다 pointerenter 를 걸면 「로그인」 칸에서는 신뢰할 수 없다 — 그 칸은
   * 구글 버튼이 통째로 덮고 있어서, 브라우저·GIS 버전에 따라 진입 이벤트가
   * 우리 칸까지 오지 않는 경우가 있다(위에서 내려올 때만 불이 안 켜지는 증상).
   * 좌표로 재면 덮개가 무엇이든 상관없다.
   */
  const hoverAt = (x: number, y: number): void => {
    const i = hots.findIndex((h) => {
      const r = h.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (i === sel) return;
    // 칸 사이(빈 곳)로 나가면 불을 끈다. 이게 없으면 「로그인」 칸처럼 진입
    // 이벤트를 놓칠 수 있는 자리에서 직전 칸(대전게임)이 계속 켜진 채로 남는다.
    sel = i;
    paint();
    if (i >= 0) audio.play('ui_click', { volume: 0.18 });
  };
  // capture 단계 + document 레벨 — 중간에서 이벤트를 삼켜도 우리에게는 온다
  document.addEventListener('pointermove', (e) => {
    if (!visible()) return;
    hoverAt(e.clientX, e.clientY);
  }, { capture: true, passive: true });
  // 덮개(구글 버튼) 위에서는 pointermove 가 안 올 수도 있어, 진입 시점도 함께 본다
  art.addEventListener('pointerover', (e) => {
    if (!visible()) return;
    hoverAt(e.clientX, e.clientY);
  }, { capture: true, passive: true });
  // 그림 밖으로 나가면 아무것도 켜 두지 않는다
  art.addEventListener('pointerleave', () => {
    if (!visible() || sel < 0) return;
    sel = -1;
    paint();
  });

  // 키보드로도 고를 수 있게 (패드처럼 위아래 + Enter)
  window.addEventListener('keydown', (e) => {
    if (!visible()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 마우스가 칸 밖에 있어 꺼진 상태(-1)면 첫 칸부터 시작한다
      const from = sel < 0 ? (e.key === 'ArrowDown' ? -1 : 0) : sel;
      sel = (from + (e.key === 'ArrowDown' ? 1 : ITEMS.length - 1) + ITEMS.length) % ITEMS.length;
      paint();
      audio.play('ui_click', { volume: 0.18 });
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (sel < 0) { sel = 0; paint(); e.preventDefault(); return; }
      hots[sel]!.click();
      e.preventDefault();
    }
  });
}

/** 고른 항목을 밝히고 → 화면을 어둡게 걷어낸 다음 → 다음 화면을 연다. */
function choose(audio: Audio, onPick: (a: TitleAction) => void, action: TitleAction): void {
  const el = $('#title');
  if (el.classList.contains('fading')) return; // 연타로 두 번 넘어가지 않게
  audio.play('ui_buy', { volume: 0.7 });
  el.classList.add('fading');
  setTimeout(() => {
    hideTitle();
    onPick(action);
  }, FADE_MS);
}
