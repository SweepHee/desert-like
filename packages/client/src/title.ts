/**
 * 타이틀 화면.
 *
 * 종족 아트 4종 중 하나가 들어올 때마다 무작위로 걸린다. 메뉴 버튼은 그림에
 * 이미 그려져 있으므로, 클릭은 그 위에 얹은 투명 핫스팟이 받는다. 핫스팟
 * 좌표는 원본 아트(756×504) 기준 픽셀을 비율로 환산해 넣기 때문에 화면이
 * 커지든 작아지든 그림 속 버튼과 어긋나지 않는다.
 *
 * 고른 아트는 타이틀에서 끝나지 않고, 이어지는 메뉴 화면의 배경(흐림)과
 * 강조색으로 남는다 — 캠페인·대전으로 넘어가는 흐름을 끊지 않으려고.
 */
import type { Audio } from './audio.ts';

export type TitleAction = 'campaign' | 'solo' | 'versus' | 'quit';

/** 아트 원본 크기. 아래 좌표는 전부 이 기준의 픽셀. */
const ART_W = 756;
const ART_H = 504;
/** 메뉴 버튼 상자 — 4종 아트가 가로 위치·크기는 같고 세로 시작만 다르다. */
const MENU_X = 479;
const MENU_W = 214;
const MENU_H = 41;

interface Variant {
  id: string;
  /** 아트에 새겨진 종족명. 이어지는 화면의 부제로 그대로 쓴다. */
  sub: string;
  src: string;
  /** 강조색 (r g b) — 메뉴 화면의 --gold 를 이 색으로 물들인다. */
  rgb: string;
  /** 버튼 4개의 윗변 y. 위쪽 아트 두 종이 아래쪽보다 12px 낮게 그려져 있다. */
  tops: [number, number, number, number];
}

const VARIANTS: Variant[] = [
  { id: 'sylvarin', sub: 'SYLVARIN', src: '/assets/ui/title_sylvarin.jpg',
    rgb: '141 206 74', tops: [249, 299, 346, 394] },
  { id: 'pandemonium', sub: 'PANDEMONIUM', src: '/assets/ui/title_pandemonium.jpg',
    rgb: '166 122 224', tops: [261, 310, 358, 406] },
  { id: 'marioneta', sub: 'MARIONETA', src: '/assets/ui/title_marioneta.jpg',
    rgb: '224 106 132', tops: [261, 310, 358, 406] },
  { id: 'karja', sub: 'KARJA', src: '/assets/ui/title_karja.jpg',
    rgb: '232 178 92', tops: [249, 299, 346, 394] },
];

/** 그림에 그려진 순서 그대로. 핫스팟 i 번이 곧 이 순서. */
const ITEMS: { action: TitleAction; label: string }[] = [
  { action: 'campaign', label: '캠페인' },
  { action: 'solo', label: '연습모드' },
  { action: 'versus', label: '대전게임' },
  { action: 'quit', label: '종료' },
];

const LS_LAST = 'dl_title_last';
/** 페이드 아웃이 끝나고 다음 화면을 여는 시점 (CSS transition 과 맞춤). */
const FADE_MS = 340;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let variant: Variant = VARIANTS[0]!;
let hots: HTMLButtonElement[] = [];
let sel = 0;

/** 이번 접속에 걸린 아트의 종족명 (메뉴 화면 부제용). */
export function titleSubtitle(): string {
  return variant.sub;
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
  const ready = (): void => img.classList.add('ready');
  img.addEventListener('load', ready, { once: true });
  img.src = variant.src;
  if (img.complete) ready();

  const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;
  hots = ITEMS.map((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'title-hot';
    b.setAttribute('aria-label', it.label);
    b.style.left = pct(MENU_X / ART_W);
    b.style.width = pct(MENU_W / ART_W);
    b.style.top = pct(variant.tops[i]! / ART_H);
    b.style.height = pct(MENU_H / ART_H);
    b.addEventListener('pointerenter', () => {
      if (sel === i) return;
      sel = i;
      paint();
      audio.play('ui_click', { volume: 0.18 });
    });
    b.addEventListener('click', () => {
      sel = i;
      paint();
      choose(audio, onPick, it.action);
    });
    art.appendChild(b);
    return b;
  });
  paint();

  // 키보드로도 고를 수 있게 (패드처럼 위아래 + Enter)
  window.addEventListener('keydown', (e) => {
    if (!visible()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      sel = (sel + (e.key === 'ArrowDown' ? 1 : ITEMS.length - 1)) % ITEMS.length;
      paint();
      audio.play('ui_click', { volume: 0.18 });
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === ' ') {
      choose(audio, onPick, ITEMS[sel]!.action);
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
