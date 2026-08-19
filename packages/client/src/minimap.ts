/**
 * 좌하단 미니맵 (HTML 캔버스 2D).
 *
 * - 코리도어 형태(직선/계곡 등)를 그대로 축소해 그린다
 * - 유닛: 팀 컬러 점 / 구조물: 큰 사각형 / 수호자: 다이아몬드
 * - 흰 사각형 = 현재 카메라 뷰포트. 클릭·드래그로 카메라 이동.
 */
import { DEFS, FP, MAPS, DEFAULT_MAP, laneCenterY, laneHalfWAt, mapHalfH, type Game, type MapDef } from '@desertlike/sim';
import { worldW, worldYOf, worldYToFP, type Renderer } from './render.ts';

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

  function setMap(next: MapDef): void {
    m = next;
    scale = MINI_W / (m.length / FP); // px per tile
    MINI_H = Math.max(28, Math.round(((mapHalfH(m) * 2) / FP) * scale) + 8);
    canvas.width = MINI_W;
    canvas.height = MINI_H;
  }
  setMap(m);

  const tx = (x: number) => (x / FP) * scale;
  const ty = (y: number) => ((y + mapHalfH(m)) / FP) * scale + 4;

  let dragging = false;
  const jump = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    // 세로도 반영 — Y자 맵(둥지 방어)에서 12시 가지로 점프할 수 있어야 한다
    const fy = (ev.clientY - rect.top) / rect.height;
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
    // 배경: 바깥 지대 + 코리도어(걷는 길). 맵 테마에 맞춰 색을 고른다.
    const forest = m.id === 'plains';
    ctx.fillStyle = forest ? '#24351f' : '#5a4630';
    ctx.fillRect(0, 0, MINI_W, MINI_H);
    const mid = m.length / 2;
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
    // 가지 길 (12시 능선 등) — 코리도어와 같은 색의 세로 막대
    for (const b of m.branches ?? []) {
      const bw = ((b.halfW ?? m.halfW) / FP) * scale;
      const bx = tx(b.x);
      const y0 = ty(b.y0);
      const y1 = ty(b.y1);
      ctx.fillStyle = '#c7a566';
      ctx.fillRect(bx - bw, y0, bw * 2, y1 - y0);
    }

    for (const e of g.entities) {
      if (!e.alive) continue;
      const d = DEFS[e.defId]!;
      const x = tx(e.x);
      const y = ty(e.y);
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
