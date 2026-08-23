/**
 * 좌하단 미니맵 (HTML 캔버스 2D).
 *
 * - 코리도어 형태(직선/계곡 등)를 그대로 축소해 그린다
 * - 유닛: 팀 컬러 점 / 구조물: 큰 사각형 / 수호자: 다이아몬드
 * - 흰 사각형 = 현재 카메라 뷰포트. 클릭·드래그로 카메라 이동.
 */
import { DEFS, FP, MAPS, DEFAULT_MAP, laneCenterY, laneHalfWAt, mapHalfH, type Game, type MapDef } from '@desertlike/sim';
import { worldW, worldYOf, worldYToFP, type Renderer } from './render.ts';
import { MAP_DECO, decoAt } from './mapdeco.ts';

const MINI_W = 280;
const TEAM_COLOR = ['#57a0ff', '#ff6a57'] as const;

export interface Minimap {
  setMap(m: MapDef): void;
  draw(g: Game): void;
}

export function createMinimap(canvas: HTMLCanvasElement, renderer: Renderer): Minimap {
  let m: MapDef = MAPS[DEFAULT_MAP]!;
  let scale = 1;
  let MINI_H = 44;
  const ctx = canvas.getContext('2d')!;

  /** 세로 맵이면 미니맵도 세운다 — 진행축이 위아래가 된다. */
  let vertical = false;
  /** 손으로 그린 지형 배경 (있으면 미니맵도 이 그림을 쓴다). */
  let bgImg: HTMLImageElement | null = null;
  /** 통행 마스크로 미리 그려 둔 지형 — 매 프레임 다시 칠하지 않는다. */
  let maskCanvas: HTMLCanvasElement | null = null;

  /**
   * 통행 마스크(+장식 격자)를 한 번만 그려 캐시한다.
   * 미니맵 축척과 무관하게 격자 해상도로 그려 두고, 그릴 때 늘려 쓴다.
   */
  function buildMaskCanvas(map: MapDef): HTMLCanvasElement | null {
    const mk = map.mask;
    if (!mk) return null;
    const deco = MAP_DECO[map.id];
    const c = document.createElement('canvas');
    // 가로 맵은 진행축(rows)이 가로, 세로 맵은 세로
    c.width = map.vertical ? mk.cols : mk.rows;
    c.height = map.vertical ? mk.rows : mk.cols;
    const cx = c.getContext('2d');
    if (!cx) return null;
    const img = cx.createImageData(c.width, c.height);
    for (let row = 0; row < mk.rows; row++) {
      for (let col = 0; col < mk.cols; col++) {
        const walk = mk.data[row * mk.cols + col] === '.';
        const d = deco ? decoAt(deco, row, col) : '.';
        // 길 = 흙빛, 물 = 청록, 바위 = 회색, 나머지 = 숲
        const rgb = walk ? [176, 145, 108]
          : d === '~' ? [72, 138, 150]
            : d === 'o' ? [104, 102, 96]
              : [40, 62, 36];
        const px = map.vertical ? col : row;
        const py = map.vertical ? mk.rows - 1 - row : col;
        const o = (py * c.width + px) * 4;
        img.data[o] = rgb[0]!;
        img.data[o + 1] = rgb[1]!;
        img.data[o + 2] = rgb[2]!;
        img.data[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return c;
  }

  function setMap(next: MapDef): void {
    m = next;
    vertical = !!next.vertical;
    // 지형 그림이 있으면 그대로 축소해 쓴다 — 손으로 그린 길이 그대로 보인다
    bgImg = null;
    maskCanvas = buildMaskCanvas(next);
    if (next.bgImage) {
      const img = new Image();
      img.src = next.bgImage;
      img.onload = () => { bgImg = img; };
    }
    if (vertical) {
      // 폭(코리도어)이 가로, 길이가 세로. 화면을 너무 잡아먹지 않게 높이를 제한한다.
      const wTiles = (mapHalfH(m) * 2) / FP;
      const lTiles = m.length / FP;
      const MAX_H = 190;
      scale = Math.min(MINI_W / wTiles, MAX_H / lTiles);
      canvas.width = Math.max(28, Math.round(wTiles * scale) + 8);
      MINI_H = Math.max(28, Math.round(lTiles * scale) + 8);
      canvas.height = MINI_H;
      return;
    }
    scale = MINI_W / (m.length / FP); // px per tile
    MINI_H = Math.max(28, Math.round(((mapHalfH(m) * 2) / FP) * scale) + 8);
    canvas.width = MINI_W;
    canvas.height = MINI_H;
  }
  setMap(m);

  // 가로 맵: x → 미니맵 가로, y → 미니맵 세로.
  // 세로 맵: y(코리도어 폭) → 미니맵 가로, x(진행축) → 미니맵 세로(아래가 출발).
  const tx = (x: number, y = 0) => vertical
    ? ((y + mapHalfH(m)) / FP) * scale + 4
    : (x / FP) * scale;
  const ty = (y: number, x = 0) => vertical
    ? MINI_H - 4 - (x / FP) * scale
    : ((y + mapHalfH(m)) / FP) * scale + 4;

  let dragging = false;
  const jump = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    // 세로도 반영 — Y자 맵(둥지 방어)에서 12시 가지로 점프할 수 있어야 한다
    const fy = (ev.clientY - rect.top) / rect.height;
    if (vertical) {
      // 미니맵 가로 = 코리도어 폭(월드 y), 세로 = 진행축(월드 x, 아래가 출발)
      const yFP = ((fx * canvas.width - 4) / scale) * FP - mapHalfH(m);
      const xTiles = Math.max(0, ((1 - fy) * MINI_H - 4) / scale);
      const xPx = (xTiles / (m.length / FP)) * worldW();
      renderer.centerOn(xPx, worldYOf(yFP));
      return;
    }
    const yFP = ((fy * MINI_H - 4) / scale) * FP - mapHalfH(m);
    renderer.centerOn(fx * worldW(), worldYOf(yFP));
  };
  canvas.addEventListener('pointerdown', (ev) => {
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    jump(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging) jump(ev);
  });
  canvas.addEventListener('pointerup', (ev) => {
    dragging = false;
    canvas.releasePointerCapture(ev.pointerId);
  });

  function draw(g: Game): void {
    // 배경: 지형 그림이 있으면 그걸 깐다 (없으면 색으로 그린 코리도어)
    const hasBg = bgImg !== null || maskCanvas !== null;
    if (bgImg) ctx.drawImage(bgImg, 0, 0, canvas.width, MINI_H);
    else if (maskCanvas) {
      // 마스크 지형은 4px 여백 안쪽에 맞춘다 (tx/ty 의 +4 와 같은 기준)
      ctx.fillStyle = '#1a2416';
      ctx.fillRect(0, 0, canvas.width, MINI_H);
      ctx.imageSmoothingEnabled = false;
      // 세로 맵은 가로도 4px 들여쓰기 (tx 가 +4 를 더한다)
      const ox = vertical ? 4 : 0;
      ctx.drawImage(maskCanvas, ox, 4, canvas.width - ox * 2, MINI_H - 8);
      ctx.imageSmoothingEnabled = true;
    }
    const forest = m.id === 'plains';
    if (!hasBg) {
      ctx.fillStyle = forest ? '#24351f' : '#5a4630';
      ctx.fillRect(0, 0, canvas.width, MINI_H);
    }
    const mid = m.length / 2;
    if (hasBg) {
      // 지형 그림이 이미 길을 그려 준다 — 색칠한 코리도어는 생략
    } else if (vertical) {
      // 세로 맵: 진행축을 아래→위로 그린다. 가운데가 갈라진 구간(호수)은 비운다.
      const steps = Math.round((m.length / FP) * scale);
      for (let py = 0; py < steps; py++) {
        const x = Math.floor(((steps - py) / scale) * FP);
        const cx = tx(0, laneCenterY(m, x));
        const halfPx = (laneHalfWAt(m, x) / FP) * scale;
        const yy = MINI_H - 4 - (x / FP) * scale;
        ctx.fillStyle = x >= mid ? '#4a4038' : '#3f6b34';
        ctx.fillRect(cx - halfPx - 1, yy, halfPx * 2 + 2, 1.4);
        ctx.fillStyle = x >= mid ? '#7d7268' : '#7fb45c';
        const gap = (m.splits ?? []).find((sp) => x >= sp.x0 && x <= sp.x1);
        if (gap) {
          // 두 갈래 — 가운데 물을 비우고 좌우 길만 칠한다
          const gPx = (gap.gap / FP) * scale;
          ctx.fillRect(cx - halfPx, yy, halfPx - gPx, 1.4);
          ctx.fillRect(cx + gPx, yy, halfPx - gPx, 1.4);
        } else {
          ctx.fillRect(cx - halfPx, yy, halfPx * 2, 1.4);
        }
      }
    } else {
    for (let px = 0; px < MINI_W; px++) {
      const x = Math.floor((px / scale) * FP);
      const cy = ty(laneCenterY(m, x));
      const laneHalfPx = (laneHalfWAt(m, x) / FP) * scale; // 초크 구간은 좁게
      if (forest) {
        // 오른쪽 절반은 불탄 숲 (잿빛)
        ctx.fillStyle = x >= mid ? '#4a4038' : '#3f6b34';
        ctx.fillRect(px, cy - laneHalfPx - 2, 1, laneHalfPx * 2 + 4);
        ctx.fillStyle = x >= mid ? '#7d7268' : '#7fb45c';
      } else {
        ctx.fillStyle = x < m.towerX[0] ? '#cfb887' : x >= m.towerX[1] ? '#d0a887' : '#c7a566';
      }
      ctx.fillRect(px, cy - laneHalfPx, 1, laneHalfPx * 2);
    }
    }
    // 가지 길 (12시 능선 등) — 코리도어와 같은 색의 세로 막대
    for (const b of hasBg ? [] : (m.branches ?? [])) {
      const bw = ((b.halfW ?? m.halfW) / FP) * scale;
      const bx = tx(b.x);
      const y0 = ty(b.y0);
      const y1 = ty(b.y1);
      ctx.fillStyle = '#c7a566';
      ctx.fillRect(bx - bw, y0, bw * 2, y1 - y0);
    }

    for (const e of g.entities) {
      if (!e.alive) continue;
      if (g.tick < e.stealthUntil) continue; // 은신(인큐버스): 미니맵에서도 사라진다
      if (g.tick < e.vanishUntil) continue; // 「커튼콜」 무대 밖
      const d = DEFS[e.defId]!;
      const x = tx(e.x, e.y);
      const y = ty(e.y, e.x);
      ctx.fillStyle = e.team === 2 ? '#b0a068' : TEAM_COLOR[e.team]; // 야생 = 회갈색
      if (d.tier === 'structure') {
        const s = e.defId === 'nexus' ? 7 : 5;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
        ctx.strokeStyle = '#1a130d';
        ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      } else if (d.tier === 'guardian') {
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 4, y);
        ctx.fill();
      } else {
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    const v = renderer.view();
    if (vertical) {
      // v.x0~x1 = 화면 가로 스크롤(= 월드 y 픽셀), v.y0~y1 = 화면 세로 스크롤.
      // 화면 세로는 「아래가 출발」이라 진행축으로 되돌릴 때 뒤집는다.
      const lenTiles = m.length / FP;
      const scrollH = worldW(); // 회전 후 화면 세로 전체 크기 = 월드 길이(px)
      const mx0 = Math.max(1, ((worldYToFP(v.x0) + mapHalfH(m)) / FP) * scale + 4);
      const mx1 = Math.min(canvas.width - 1, ((worldYToFP(v.x1) + mapHalfH(m)) / FP) * scale + 4);
      // 화면 세로 스크롤 y → 진행축 타일
      const tileAt = (sy: number) => ((scrollH - sy) / scrollH) * lenTiles;
      const my0 = MINI_H - 4 - tileAt(v.y0) * scale; // 화면 위쪽
      const my1 = MINI_H - 4 - tileAt(v.y1) * scale; // 화면 아래쪽
      const top = Math.max(1, Math.min(my0, my1));
      const bot = Math.min(MINI_H - 1, Math.max(my0, my1));
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mx0, top, Math.max(6, mx1 - mx0), Math.max(6, bot - top));
      return;
    }
    const vx0 = (v.x0 / worldW()) * MINI_W;
    const vx1 = (v.x1 / worldW()) * MINI_W;
    // 세로도 실제 카메라가 보는 만큼만 — 항상 세로 100% 로 그리면
    // Y자 맵(둥지)에서 내가 어느 높이를 보고 있는지 알 수 없다
    const vy0 = Math.max(1, ty(worldYToFP(v.y0)));
    const vy1 = Math.min(MINI_H - 1, ty(worldYToFP(v.y1)));
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx0, vy0, Math.max(6, vx1 - vx0), Math.max(6, vy1 - vy0));
  }

  return { setMap, draw };
}
