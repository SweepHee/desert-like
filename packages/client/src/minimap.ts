/**
 * 좌하단 미니맵 (HTML 캔버스 2D).
 *
 * - 코리도어 형태(직선/계곡 등)를 그대로 축소해 그린다
 * - 유닛: 팀 컬러 점 / 구조물: 큰 사각형 / 수호자: 다이아몬드
 * - 흰 사각형 = 현재 카메라 뷰포트. 클릭·드래그로 카메라 이동.
 */
import { DEFS, FP, MAPS, DEFAULT_MAP, laneCenterY, mapHalfH, type Game, type MapDef } from '@desertlike/sim';
import { worldW, type Renderer } from './render.ts';

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
    renderer.centerOn(fx * worldW());
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
    const laneHalfPx = (m.halfW / FP) * scale;
    const mid = m.length / 2;
    for (let px = 0; px < MINI_W; px++) {
      const x = Math.floor((px / scale) * FP);
      const cy = ty(laneCenterY(m, x));
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

    for (const e of g.entities) {
      if (!e.alive) continue;
      const d = DEFS[e.defId]!;
      const x = tx(e.x);
      const y = ty(e.y);
      ctx.fillStyle = TEAM_COLOR[e.team];
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
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx0, 1, Math.max(6, vx1 - vx0), MINI_H - 2);
  }

  return { setMap, draw };
}
