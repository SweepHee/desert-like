/**
 * 클라이언트 엔트리.
 *
 * 흐름: 메뉴(로비) → 방 만들기/참가 → 게임  또는  연습 게임(오프라인).
 * 멀티플레이는 결정론 동기화: 서버는 시드·좌석·명령 스트림·틱 시계만 주고,
 * 모든 클라이언트가 같은 시뮬을 로컬에서 돌린다 (전투 렌더링 지연 0).
 */
import {
  DEFS, FP, MAP, MAPS, DEFAULT_MAP, RACE_NAMES, TICK_HZ,
  createGame, stepGame, buyUnit, buyIncomeUpgrade, buyTechUp, buyUpgrade,
  findStructure, nextWaveInfo, hashGame, incomeUpgradeCost, techOfUnit, techUpCost,
  unitsOfRace, upgradesOfUnit,
  laneCenterY, spawnUnit,
  type BotDifficulty, type EntityDef, type Game, type RaceId, type TeamId,
} from '@desertlike/sim';
import { assetIconUrl, createRenderer, worldToPxX, type Renderer } from './render.ts';
import {
  SYLVARIN_CAMPAIGN, PERKS, campaignCleared, markCampaignCleared, runDialogue,
  perkAlloc, savePerkAlloc, perkPointsSpent, perksToHero,
  type CampaignStage,
} from './campaign.ts';
import { createAudio } from './audio.ts';
import { createMinimap, type Minimap } from './minimap.ts';
import { iconUrl } from './sprites.ts';
import { connect, serverUrl, type Net, type NetMsg } from './net.ts';

const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];
const RACE_DESC: Record<RaceId, string> = {
  sylvarin: '🌲 생명·자연·장기전. 회복과 영역으로 전장을 숲으로 만든다.',
  pandemonium: '☠️ 죽음·소모전. 힐러 없이 방어 무시·흡혈로 갈아버린다.',
  marionetta: '🧸 인형·실·호러. 연결과 조작, 순간 폭발로 무대를 지배한다.',
};
const TIER_LABEL: Record<string, string> = {
  basic: '기본', novice: '초급', mid: '중급', high: '고급', air: '공중', supreme: '최상급', final: '최종',
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ── 전역 상태 ─────────────────────────────────────────────────────────────
let game: Game | null = null;
const audio = createAudio();
let renderer: Renderer | null = null;
let minimap: Minimap | null = null;
let myIdx = 0;
let speed = 1;
const STEP_MS = 1000 / TICK_HZ;
let acc = 0;

// 멀티플레이 상태
let net: Net | null = null;
let isMp = false;
// 권위 틱 시계: tickBase + (now - tickBaseAt) * speed / STEP_MS
let mpTickBase = 0;
let mpTickBaseAtMs = 0;
let mpSpeed = 1;
let mpHostId: string | null = null;
interface MpCmd { playerIdx: number; executeTick: number; seq: number; cmd: { kind: string; defId?: string; id?: string } }
let mpQueue: MpCmd[] = [];
let lastHashTick = 0;
let roomStateCache: NetMsg | null = null;
let gameOverReported = false;

// 새로고침/닫기 경고: 방이나 멀티 게임에 있을 때
window.addEventListener('beforeunload', (e) => {
  const inRoom = roomStateCache !== null;
  const inMpGame = isMp && game && !game.over;
  if (net && (inRoom || inMpGame)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// 브라우저 기본 우클릭 메뉴 차단: 게임 화면에서 우클릭은 전부 게임 조작이다.
// (채팅 입력창 등 실제 텍스트 편집 영역에서는 기본 메뉴를 남겨둔다)
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
  e.preventDefault();
});

// ── 카메라 입력 ───────────────────────────────────────────────────────────
const heldKeys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  heldKeys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => heldKeys.clear());

function cameraPanFromKeys(deltaMS: number): void {
  if (!renderer) return;
  const px = (deltaMS / 1000) * 900;
  const left = heldKeys.has('arrowleft') || heldKeys.has('a');
  const right = heldKeys.has('arrowright') || heldKeys.has('d');
  const up = heldKeys.has('arrowup') || heldKeys.has('w');
  const down = heldKeys.has('arrowdown') || heldKeys.has('s');
  const dx = left === right ? 0 : left ? -px : px;
  const dy = up === down ? 0 : up ? -px : px;
  if (dx !== 0 || dy !== 0) renderer.panBy(dx, dy);
  const zin = heldKeys.has('+') || heldKeys.has('=');
  const zout = heldKeys.has('-') || heldKeys.has('_');
  if (zin !== zout) renderer.zoomBy(zin ? 1 + deltaMS * 0.0015 : 1 - deltaMS * 0.0015);
}

function attachCameraInput(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!renderer) return;
    const rect = canvas.getBoundingClientRect();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      renderer.panBy(e.deltaX * 1.2, 0);
    } else {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      renderer.zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
    }
  }, { passive: false });

  let drag: { x: number; y: number } | null = null;
  let dragDist = 0;
  // 손가락 두 개 = 핀치 줌. 그동안은 한 손가락 팬을 멈춘다.
  const touches = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  const twoFingerDist = (): number => {
    const [a, b] = [...touches.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  canvas.addEventListener('pointerdown', (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      drag = null; // 핀치 시작 — 팬 취소
      pinchDist = twoFingerDist();
      return;
    }
    drag = { x: e.clientX, y: e.clientY };
    dragDist = 0;
    canvas.classList.add('grabbing');
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      const d = twoFingerDist();
      if (pinchDist > 0 && d > 0) {
        const rect = canvas.getBoundingClientRect();
        const [a, b] = [...touches.values()];
        const cx = ((a!.x + b!.x) / 2) - rect.left;
        const cy = ((a!.y + b!.y) / 2) - rect.top;
        renderer?.zoomBy(d / pinchDist, cx, cy);
      }
      pinchDist = d;
      return;
    }
    if (!drag) return;
    dragDist += Math.abs(drag.x - e.clientX) + Math.abs(drag.y - e.clientY);
    renderer?.panBy(drag.x - e.clientX, drag.y - e.clientY);
    drag = { x: e.clientX, y: e.clientY };
  });

  const endDrag = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchDist = 0;
    // 거의 안 움직였으면 클릭 = 유닛 선택
    if (drag && dragDist < 6 && renderer && game) {
      const rect = canvas.getBoundingClientRect();
      selectUnit(renderer.pick(game, e.clientX - rect.left, e.clientY - rect.top));
    }
    drag = null;
    canvas.classList.remove('grabbing');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

// ── 전장 유닛 선택 정보창 ─────────────────────────────────────────────────
let selectedUnitId: number | null = null;

function selectUnit(id: number | null): void {
  selectedUnitId = id;
  renderer?.setSelected(id);
  const panel = $('#unit-info');
  if (id === null) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  refreshUnitInfo();
}

function refreshUnitInfo(): void {
  if (!game || selectedUnitId === null) return;
  const e = game.entities.find((x) => x.id === selectedUnitId);
  const panel = $('#unit-info');
  if (!e || !e.alive) {
    selectUnit(null);
    return;
  }
  const d = e.defOv ?? DEFS[e.defId]!;
  const ownerLabel = e.owner >= 0
    ? `${e.team + 1}팀 · ${game.players[e.owner]?.isBot ? 'AI' : '플레이어'} ${(e.owner % 3) + 1}번${e.owner === myIdx ? ' (나)' : ''}`
    : `${e.team + 1}팀`;
  const status: string[] = [];
  if (game.tick < e.slowedUntil) status.push('둔화');
  if (game.tick < e.dotUntil) status.push(`중독 (초당 ${e.dotDps})`);
  if (game.tick < e.rootedUntil) status.push('속박');
  if (game.tick < e.stunnedUntil) status.push('기절');
  if (game.tick < e.confusedUntil) status.push('혼란');
  if (game.tick < e.sleepUntil) status.push(`수면 (피격 ${e.sleepHits}/3)`);
  if (game.tick < e.weakenedUntil) status.push('약화 (공격력 -10%)');
  if (game.tick < e.frozenUntil) status.push('빙결');
  if (game.tick < e.chilledUntil) status.push('한기 (공속·이속 -20%)');
  if (game.tick < e.reflectUntil) status.push('가시 봉제 (평타 50% 반사)');
  if (game.tick < e.fearedUntil) status.push('공포 (도주 중)');
  if (game.tick < e.groundedUntil) status.push('지상화 (리버스그라비티)');
  if (game.tick < e.invulnUntil) status.push('무적');
  if (game.tick < e.armorBuffUntil) status.push(`가호 (방어력 +${e.armorBuffAdd})`);
  if (game.tick < e.atkBuffUntil) status.push('군세강화');
  if (game.tick < e.forestUntil) status.push('숲의 가호');
  if (e.defId === 'nexus' && !game.guardianDown[e.team]) status.push('보호막 (수호자 생존)');
  const tickNow = game.tick;
  (d.actives ?? []).forEach((a, i) => {
    if (a.kind === 'selfbuff' && tickNow < e.buffUntil) status.push(`「${a.name}」 지속 중`);
    else if ((e.skillCds[i] ?? 0) > 0) status.push(`「${a.name}」 대기 ${Math.ceil(e.skillCds[i]! / TICK_HZ)}초`);
  });
  panel.innerHTML =
    `<div class="ui-dim">${ownerLabel}${e.defOv ? ' · <span class="ui-bonus">업그레이드 적용</span>' : ''}</div>` +
    unitInfoHtml(d, e.hp) +
    (status.length > 0 ? `<div class="ui-row" style="color:#e0b060">상태: ${status.join(' · ')}</div>` : '');
}

// ── 화면 전환 ─────────────────────────────────────────────────────────────
function showScreen(id: 'menu-screen' | 'race-screen' | 'room-screen' | null): void {
  const overlay = $('#overlay');
  for (const s of ['menu-screen', 'race-screen', 'room-screen']) {
    $(`#${s}`).classList.toggle('hidden', s !== id);
  }
  overlay.classList.toggle('hidden', id === null);
  // 나가기·상점 접기는 게임 중(오버레이가 없을 때)에만 의미가 있다
  const inGame = id === null;
  ($('#btn-quit') as HTMLElement).style.display = inGame ? '' : 'none';
  ($('#btn-shop') as HTMLElement).style.display = inGame ? '' : 'none';
  // 채팅은 사람이 함께 있는 멀티에서만 (연습 게임은 상대가 AI 뿐)
  ($('#btn-chat') as HTMLElement).style.display = inGame && isMp ? '' : 'none';
  ($('#btn-roster') as HTMLElement).style.display = inGame ? '' : 'none';
  if (!inGame) {
    setChatOpen(false);
    $('#roster').classList.add('hidden');
  }
}

// ── 메뉴 ─────────────────────────────────────────────────────────────────
function initMenu(): void {
  $('#btn-solo').onclick = () => showSoloRaceSelect();
  $('#btn-campaign').onclick = () => showCampaignSelect();
  campaignAutoResume();
  $('#btn-create').onclick = () => {
    if (!net) return;
    sendName();
    net.send({ t: 'createRoom', name: `${nickname()}의 방` });
  };
  showScreen('menu-screen');
}

function nickname(): string {
  return ($('#nickname') as HTMLInputElement).value.trim() || '이름없는 자';
}

function sendName(): void {
  net?.send({ t: 'setName', name: nickname() });
}

function renderRoomList(list: { id: string; name: string; players: number; ais: number }[]): void {
  const wrap = $('#room-list');
  wrap.innerHTML = list.length === 0 ? '<div style="color:var(--dim);font-size:12px">열린 방이 없습니다</div>' : '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'roomrow';
    row.innerHTML = `<span>${r.name}</span><span style="color:var(--dim)">${r.players}명 + AI ${r.ais}</span>`;
    row.onclick = () => {
      if (!net) return;
      sendName();
      net.send({ t: 'joinRoom', roomId: r.id });
    };
    wrap.appendChild(row);
  }
}

// ── 대기실 ────────────────────────────────────────────────────────────────
/** 방장 자리 이동 모드: 선택된 출발 좌석 (null = 비활성). */
let moveFrom: number | null = null;

function renderRoom(state: NetMsg): void {
  roomStateCache = state;
  const s = state as unknown as {
    id: string; name: string; hostId: string; inGame: boolean; mapId: string;
    teamSize: [number, number];
    seats: {
      type: 'empty' | 'human' | 'ai'; name: string; race: RaceId;
      team: TeamId; clientId: string | null;
    }[];
  };
  const teamSize = s.teamSize ?? [3, 3];
  const isHost = net?.clientId === s.hostId;
  const mapName = MAPS[s.mapId]?.name ?? s.mapId;
  $('#room-title').textContent = `${s.name} — 🗺 ${mapName}`;
  $('#room-hint').textContent = isHost
    ? '방장: 팀 인원(1~3)을 정하고 시작하세요. 빈 자리는 그대로 빠집니다 — 팀당 1명씩이면 1:1 이 됩니다. AI 를 넣고 싶으면 「AI 추가」로 직접 채우세요.'
    : '방장이 시작하기를 기다리는 중… 내 종족 버튼으로 종족을 바꿀 수 있습니다.';
  ($('#btn-start') as HTMLButtonElement).style.display = isHost ? '' : 'none';
  // 방장 전용 맵 변경 버튼
  const mapBtn = $<HTMLButtonElement>('#btn-map');
  mapBtn.style.display = isHost ? '' : 'none';
  mapBtn.textContent = `맵 변경 (${mapName})`;
  mapBtn.onclick = () => {
    const ids = Object.keys(MAPS);
    const next = ids[(ids.indexOf(s.mapId) + 1) % ids.length]!;
    net?.send({ t: 'setMap', mapId: next });
  };

  const seats = $('#seats');
  seats.innerHTML = '';
  // 팀별 세로 컬럼: 왼쪽 = 1팀, 오른쪽 = 2팀
  const cols: HTMLElement[] = [0, 1].map((team) => {
    const col = document.createElement('div');
    col.className = `teamcol team${team}`;
    col.innerHTML = `<h4>${team + 1}팀 (${teamSize[team]}인)</h4>`;
    // 방장은 팀 인원을 1~3명으로 조절할 수 있다 (1:1, 1:3 같은 비대칭도 가능)
    if (isHost && !s.inGame) {
      const row = document.createElement('div');
      row.className = 'sizerow';
      for (const n of [1, 2, 3]) {
        const b = document.createElement('button');
        b.textContent = String(n);
        b.className = teamSize[team] === n ? 'on' : '';
        b.onclick = () => net?.send({
          t: 'setTeamSize',
          a: team === 0 ? n : teamSize[0],
          b: team === 1 ? n : teamSize[1],
        });
        row.appendChild(b);
      }
      col.appendChild(row);
    }
    seats.appendChild(col);
    return col;
  });
  s.seats.forEach((seat, i) => {
    const div = document.createElement('div');
    const mine = seat.clientId === net?.clientId;
    div.className = 'seat' + (mine ? ' me' : '');
    const team = seat.team ?? (i < teamSize[0] ? 0 : 1);
    const inTeam = team === 0 ? i : i - teamSize[0];
    const label = `<span class="slotlabel t${team}">${inTeam + 1}번</span>`;
    const name =
      seat.type === 'empty' ? '<span class="sname" style="color:var(--dim)">비어 있음</span>'
      : `<span class="sname">${seat.type === 'ai' ? '🤖 ' : ''}${seat.name}${mine ? ' (나)' : ''}</span>`;
    div.innerHTML = label + name;

    if (seat.type !== 'empty') {
      const raceBtn = document.createElement('button');
      raceBtn.textContent = RACE_NAMES[seat.race];
      const canEdit = mine || (isHost && seat.type === 'ai');
      raceBtn.disabled = !canEdit;
      raceBtn.onclick = () =>
        openRaceModal((race) => net?.send({ t: 'setRace', seat: i, race }));
      div.appendChild(raceBtn);
    }
    if (isHost && seat.type === 'empty' && moveFrom === null) {
      const add = document.createElement('button');
      add.textContent = 'AI 추가';
      add.onclick = () => net?.send({ t: 'addAI', seat: i });
      div.appendChild(add);
    }
    if (isHost && seat.type === 'ai' && moveFrom === null) {
      const rm = document.createElement('button');
      rm.textContent = '제거';
      rm.onclick = () => net?.send({ t: 'removeAI', seat: i });
      div.appendChild(rm);
    }
    // 방장의 자리 이동: 대상 좌석 선택 → 목적지 클릭 (빈 자리든 맞교환이든)
    if (isHost) {
      if (moveFrom === null) {
        if (seat.type !== 'empty') {
          const mv = document.createElement('button');
          mv.textContent = '이동';
          mv.onclick = () => {
            moveFrom = i;
            if (roomStateCache) renderRoom(roomStateCache);
          };
          div.appendChild(mv);
        }
      } else if (moveFrom === i) {
        div.classList.add('moving');
        const cancel = document.createElement('button');
        cancel.textContent = '취소';
        cancel.onclick = () => {
          moveFrom = null;
          if (roomStateCache) renderRoom(roomStateCache);
        };
        div.appendChild(cancel);
      } else {
        const here = document.createElement('button');
        here.textContent = '여기로';
        here.onclick = () => {
          net?.send({ t: 'moveSeat', from: moveFrom, to: i });
          moveFrom = null;
        };
        div.appendChild(here);
      }
    }
    cols[team]!.appendChild(div);
  });
  showScreen('room-screen');
}

// ── 종족 선택 아트 (3분할 클릭) ───────────────────────────────────────────
function raceChooserEl(onPick: (race: RaceId) => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'racechooser';
  box.innerHTML = `<img src="/assets/ui/races.png" alt="종족을 선택하세요"/>`;
  RACES.forEach((race, i) => {
    const spot = document.createElement('div');
    spot.className = 'hotspot';
    spot.style.left = `${i * 33.33}%`;
    spot.title = `${RACE_NAMES[race]} — ${RACE_DESC[race]}`;
    spot.onclick = () => onPick(race);
    box.appendChild(spot);
  });
  return box;
}

// ── 캠페인 ────────────────────────────────────────────────────────────────
let campaign: CampaignStage | null = null;
/** startGame 이 createGame 을 부를 때 주입되는 인컴·테크 상한. */
let campaignCaps: { incomeCap?: number; techCap?: number } | null = null;
/** 특수 유닛 스폰 규칙별 다음 발동 시각(초). Infinity = 소진. */
let campaignSpawnNext: number[] = [];
/** 특수 유닛 경고 배너 만료 시각 (performance.now 기준). */
let campaignAlertUntil = 0;
let campaignAlertText = '';
/** 협공 주둔지 엔티티 id (-1 = 없음) + 다음 후방 웨이브 시각(초). */
let campaignWarcampId = -1;
let campaignWarcampNext = Infinity;
/** 이번 스테이지에 적용 중인 영웅 특성. */
let campaignHeroPerks: ReturnType<typeof perksToHero> | null = null;
let campaignDone = false; // 이 스테이지의 승패가 이미 처리됐는가

function showCampaignSelect(): void {
  const wrap = $('#races');
  wrap.innerHTML = '';
  const cleared = campaignCleared();
  const title = document.createElement('h2');
  title.textContent = '🌲 실바린 캠페인 — 자정의 세계수';
  wrap.appendChild(title);
  const list = document.createElement('div');
  list.id = 'campaign-list';
  const ACT_TITLE: Record<number, string> = {
    1: '1막 — 재의 새벽', 2: '2막 — 태엽과 가시', 3: '3막 — 자정의 세계수',
  };
  let lastAct = 0;
  for (const st of SYLVARIN_CAMPAIGN) {
    if (st.act !== lastAct) {
      lastAct = st.act;
      const h = document.createElement('div');
      h.className = 'camp-act';
      h.textContent = ACT_TITLE[st.act]!;
      list.appendChild(h);
    }
    const btn = document.createElement('button');
    btn.className = 'camp-stage';
    const locked = st.id > cleared + 1;
    const done = st.id <= cleared;
    btn.disabled = locked;
    btn.innerHTML =
      `<span class="num">${st.id}</span>` +
      `<span style="flex:1">${locked ? '???' : st.title}</span>` +
      (done ? '<span class="done">✔</span>' : locked ? '<span>🔒</span>' : '');
    if (!locked) btn.onclick = () => void startCampaignStage(st);
    list.appendChild(btn);
  }
  wrap.appendChild(list);
  const row = document.createElement('div');
  row.className = 'menurow';
  const perkBtn = document.createElement('button');
  perkBtn.className = 'menubtn';
  const alloc0 = perkAlloc();
  perkBtn.textContent = `🌿 세계수의 축복 (${cleared - perkPointsSpent(alloc0)}P 남음)`;
  perkBtn.onclick = () => showPerkScreen();
  row.appendChild(perkBtn);
  const back = document.createElement('button');
  back.className = 'menubtn alt';
  back.textContent = '← 메뉴로';
  back.onclick = () => showScreen('menu-screen');
  row.appendChild(back);
  wrap.appendChild(row);
  showScreen('race-screen');
}

/** 영웅 특성 화면 — 포인트 = 클리어 수, 언제든 무료 재분배. */
function showPerkScreen(): void {
  const wrap = $('#races');
  wrap.innerHTML = '';
  const total = campaignCleared();
  const alloc = perkAlloc();

  const title = document.createElement('h2');
  title.textContent = '🌿 세계수의 축복';
  wrap.appendChild(title);
  const info = document.createElement('p');
  info.style.cssText = 'color:var(--dim);font-size:13px;max-width:480px;text-align:center';
  info.textContent = '스테이지를 클리어할 때마다 축복 1포인트. 언제든 무료로 다시 나눌 수 있다. — 티아';
  wrap.appendChild(info);
  const left = document.createElement('div');
  left.style.cssText = 'color:var(--gold);font-weight:bold';
  wrap.appendChild(left);

  const list = document.createElement('div');
  list.id = 'campaign-list';
  const rerender = (): void => {
    left.textContent = `남은 포인트: ${total - perkPointsSpent(alloc)} / ${total}`;
    list.innerHTML = '';
    for (const pk of PERKS) {
      const cur = alloc[pk.id] ?? 0;
      const row2 = document.createElement('div');
      row2.className = 'camp-stage';
      row2.style.cursor = 'default';
      const canUp = cur < pk.max && perkPointsSpent(alloc) < total;
      row2.innerHTML =
        `<span class="num">${pk.icon}</span>` +
        `<span style="flex:1"><b>${pk.name}</b> ${cur}/${pk.max}<br/><small style="color:var(--dim)">${pk.desc} / 포인트</small></span>`;
      const minus = document.createElement('button');
      minus.className = 'menubtn alt';
      minus.textContent = '−';
      minus.disabled = cur <= 0;
      minus.onclick = () => { alloc[pk.id] = cur - 1; savePerkAlloc(alloc); rerender(); };
      const plus = document.createElement('button');
      plus.className = 'menubtn';
      plus.textContent = '＋';
      plus.disabled = !canUp;
      plus.onclick = () => { alloc[pk.id] = cur + 1; savePerkAlloc(alloc); rerender(); };
      row2.appendChild(minus);
      row2.appendChild(plus);
      list.appendChild(row2);
    }
  };
  rerender();
  wrap.appendChild(list);

  const row3 = document.createElement('div');
  row3.className = 'menurow';
  const reset = document.createElement('button');
  reset.className = 'menubtn alt';
  reset.textContent = '전부 초기화';
  reset.onclick = () => { for (const pk of PERKS) alloc[pk.id] = 0; savePerkAlloc(alloc); rerender(); };
  row3.appendChild(reset);
  const back = document.createElement('button');
  back.className = 'menubtn';
  back.textContent = '← 캠페인으로';
  back.onclick = () => showCampaignSelect();
  row3.appendChild(back);
  wrap.appendChild(row3);
  showScreen('race-screen');
}

async function startCampaignStage(st: CampaignStage): Promise<void> {
  showScreen(null);
  await runDialogue(st.briefing);
  campaign = st;
  campaignDone = false;
  // 팀 0 = 나(실바린) + 아군 봇, 팀 1 = 적 봇. 시드 고정 — 같은 판은 같은 전개.
  const players = [
    { race: 'sylvarin' as RaceId, isBot: false, team: 0 as TeamId },
    ...st.allies.map((race) => ({ race, isBot: true, team: 0 as TeamId })),
    ...st.enemies.map((race) => ({ race, isBot: true, team: 1 as TeamId })),
  ];
  campaignCaps = {
    ...(st.incomeCap !== undefined ? { incomeCap: st.incomeCap } : {}),
    ...(st.techCap !== undefined ? { techCap: st.techCap } : {}),
    ...(st.enemyPreferredUnits ? { enemyPreferredUnits: st.enemyPreferredUnits } : {}),
  } as { incomeCap?: number; techCap?: number };
  campaignSpawnNext = (st.spawns ?? []).map((r) => r.atSec ?? r.everySec ?? Infinity);
  campaignAlertUntil = 0;
  campaignWarcampId = -1;
  campaignWarcampNext = st.warcamp ? st.warcamp.everySec : Infinity;
  campaignHeroPerks = perksToHero(perkAlloc());
  await startGame(st.seed, players, 0, false, st.mapId ?? DEFAULT_MAP, undefined, st.botDifficulty);
  campaignCaps = null;
  if (st.startMoney !== undefined && game) game.players[0]!.money = st.startMoney;
  if (st.noTowers && game) {
    // 수호탑·수호자 없이 넥서스전만: 탑을 걷어내고 보호막(수호자 생존 시 넥서스 무적)도 해제
    game.entities = game.entities.filter((e) => e.defId !== 'tower');
    game.guardianDown = [true, true];
  }
  if (st.allies.length > 0) {
    // 아군 AI 합류 알림 — "내가 안 산 유닛"이 아군 봇 부대임을 알린다
    campaignAlertText = st.allyNote ?? '🤝 아군 부대가 함께 싸운다!';
    campaignAlertUntil = performance.now() + 6000;
    $('#campaign-goal').textContent = campaignAlertText;
  }
  if (st.warcamp && game) {
    // 협공: 아군 진영 한복판에 적 주둔지를 박아 넣는다 (앞뒤 양면전)
    const campX = Math.floor((game.map.nexusX[0] + game.map.towerX[0]) / 2);
    const camp = spawnUnit(game, 'c_warcamp', 1, campX, laneCenterY(game.map, campX));
    campaignWarcampId = camp.id;
  }
  buildShop('sylvarin'); // 허용 유닛 필터 반영 재렌더
  const goal = $('#campaign-goal');
  goal.textContent = `[${st.id}. ${st.title}] ${st.goal}`;
  goal.classList.remove('hidden');
}

/** 캠페인 스테이지 종료 처리 — 승리 시 outro 대화 후 저장. */
function campaignFinish(win: boolean): void {
  if (!campaign || campaignDone) return;
  campaignDone = true;
  const st = campaign;
  if (win) markCampaignCleared(st.id);
  const showEnd = (): void => {
    const overlay = $('#overlay');
    const isLast = st.id === SYLVARIN_CAMPAIGN.length;
    overlay.innerHTML =
      `<h1>${win ? '스테이지 클리어!' : '패배…'}</h1>` +
      `<p>${st.id}. ${st.title}</p>` +
      (win && !isLast ? `<button id="camp-next">다음 스테이지 ▶</button>` : '') +
      (!win ? `<button id="camp-retry">다시 도전</button>` : '') +
      `<button id="camp-menu">캠페인 목록으로</button>`;
    overlay.classList.remove('hidden');
    const goNext = document.querySelector('#camp-next') as HTMLButtonElement | null;
    if (goNext) goNext.onclick = () => {
      sessionStorage.setItem('camp_auto', String(st.id + 1));
      location.reload();
    };
    const retry = document.querySelector('#camp-retry') as HTMLButtonElement | null;
    if (retry) retry.onclick = () => {
      sessionStorage.setItem('camp_auto', String(st.id));
      location.reload();
    };
    (document.querySelector('#camp-menu') as HTMLButtonElement).onclick = () => {
      sessionStorage.setItem('camp_auto', 'list');
      location.reload();
    };
  };
  $('#campaign-goal').classList.add('hidden');
  if (win) void runDialogue(st.outro).then(showEnd);
  else showEnd();
}

/** 새로고침 직후 캠페인 자동 진입 (다음 스테이지 / 재도전 / 목록). */
function campaignAutoResume(): void {
  const auto = sessionStorage.getItem('camp_auto');
  if (!auto) return;
  sessionStorage.removeItem('camp_auto');
  if (auto === 'list') {
    showCampaignSelect();
    return;
  }
  const id = Number(auto);
  const st = SYLVARIN_CAMPAIGN.find((x) => x.id === id);
  if (st && id <= campaignCleared() + 1) void startCampaignStage(st);
  else showCampaignSelect();
}

// ── 연습 게임 (오프라인) ──────────────────────────────────────────────────
let soloMapId = DEFAULT_MAP;
let soloDifficulty: BotDifficulty = 'easy';
const DIFFICULTY_LABEL: Record<BotDifficulty, string> = {
  easy: '쉬움', normal: '중간', hard: '어려움',
};

function showSoloRaceSelect(): void {
  const wrap = $('#races');
  wrap.innerHTML = '';
  // 맵 선택 토글
  const mapRow = document.createElement('div');
  mapRow.className = 'menurow';
  for (const m of Object.values(MAPS)) {
    const b = document.createElement('button');
    b.className = 'menubtn' + (m.id === soloMapId ? '' : ' alt');
    b.textContent = `맵: ${m.name}`;
    b.onclick = () => {
      soloMapId = m.id;
      showSoloRaceSelect();
    };
    mapRow.appendChild(b);
  }
  wrap.appendChild(mapRow);
  // AI 난이도 토글
  const diffRow = document.createElement('div');
  diffRow.className = 'menurow';
  for (const d of ['easy', 'normal', 'hard'] as const) {
    const b = document.createElement('button');
    b.className = 'menubtn' + (d === soloDifficulty ? '' : ' alt');
    b.textContent = `AI: ${DIFFICULTY_LABEL[d]}`;
    b.title = d === 'easy' ? '순정 AI'
      : d === 'normal' ? 'AI 인컴이 유저보다 12원씩 더 많음'
      : 'AI 가 내 인컴·테크를 따라오고 내 주력 유닛의 카운터를 뽑음';
    b.onclick = () => {
      soloDifficulty = d;
      showSoloRaceSelect();
    };
    diffRow.appendChild(b);
  }
  wrap.appendChild(diffRow);
  wrap.appendChild(raceChooserEl((race) => {
    // 연습 게임은 항상 3:3. 인원 조절은 사람끼리 하는 멀티 방에서만 쓴다.
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) | 0;
    const idx = Math.random() < 0.5 ? 0 : 3;
    const players = Array.from({ length: 6 }, (_, i) => ({
      race: i === idx ? race : RACES[Math.floor(Math.random() * 3)]!,
      isBot: i !== idx,
      team: (i < 3 ? 0 : 1) as TeamId,
    }));
    void startGame(seed, players, idx, false, soloMapId, undefined, soloDifficulty);
  }));
  showScreen('race-screen');
}

// ── 종족 선택 모달 (대기실에서 종족 버튼 클릭 시) ─────────────────────────
function openRaceModal(onPick: (race: RaceId) => void): void {
  document.querySelector('#race-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'race-modal';
  modal.appendChild(raceChooserEl((race) => {
    modal.remove();
    onPick(race);
  }));
  modal.addEventListener('pointerdown', (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

// ── 게임 시작 (솔로/멀티 공용) ────────────────────────────────────────────
async function startGame(
  seed: number,
  players: { race: RaceId; isBot: boolean; team: TeamId }[],
  myIdxV: number,
  mp: boolean,
  mapId: string = DEFAULT_MAP,
  seatNames?: string[],
  botDifficulty: BotDifficulty = 'easy',
): Promise<void> {
  showScreen(null);
  isMp = mp;
  myIdx = myIdxV;
  mpQueue = [];
  lastHashTick = 0;
  gameOverReported = false;
  resultShown = false;
  speed = 1;
  mpSpeed = 1;
  updateSpeedButtons();
  game = createGame({
    seed, players, mapId, botDifficulty,
    ...(campaignCaps ?? {}),
    ...(campaign && campaignHeroPerks ? { heroPerks: campaignHeroPerks } : {}),
  });
  acc = 0;
  selectUnit(null);
  buildShop(players[myIdx]!.race);
  // 참여자 이름: 멀티는 서버 좌석 이름, 연습 게임은 AI 표기
  playerNames = players.map((p, i) =>
    seatNames?.[i] ?? (i === myIdx ? '나' : p.isBot ? 'AI' : `플레이어 ${i + 1}`));

  if (!renderer) {
    renderer = await createRenderer($('#stage'));
    renderer.setAudio(audio);
    attachCameraInput(renderer.app.canvas);
    minimap = createMinimap($<HTMLCanvasElement>('#minimap'), renderer);
    renderer.app.ticker.add((t) => tick(t.deltaMS));
  }
  renderer.setMap(game.map);
  minimap?.setMap(game.map);
  renderer.draw(game, 1);
  renderer.centerOn(worldToPxX(game.map.spawnX[game.players[myIdx]!.team]));
}

// ── 상점 ─────────────────────────────────────────────────────────────────
const shopButtons: { defId: string; btn: HTMLButtonElement; cnt: HTMLElement; upg: HTMLElement }[] = [];

/**
 * 유닛 생산 단축키. 상점에 진열된 순서대로 배정된다.
 * 1~9 다음 0(10번째), 그 뒤는 Q·E·R — W/A/S/D 는 카메라 이동이라 피했다.
 * 종족 로스터가 최대 13종이라 여기까지면 전부 덮는다.
 */
const SHOP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'q', 'e', 'r'] as const;
/** 단축키 → 유닛 id (현재 종족 기준). buildShop 에서 다시 채운다. */
const shopKeyMap = new Map<string, string>();

function buildShop(race: RaceId): void {
  const shop = $('#shop');
  shop.innerHTML = '';
  shopButtons.length = 0;
  shopKeyMap.clear();
  let keyIdx = 0;
  for (const d of unitsOfRace(race)) {
    // 캠페인: 스토리 진행에 따라 열린 유닛만 진열
    if (campaign && !campaign.allowedUnits.includes(d.id)) continue;
    const btn = document.createElement('button');
    btn.className = 'unitbtn';
    const fallbackIcon = iconUrl(d.id, 0);
    const nUps = upgradesOfUnit(d.id).length;
    const key = SHOP_KEYS[keyIdx++];
    if (key) shopKeyMap.set(key, d.id);
    btn.innerHTML =
      (key ? `<span class="key">${key.toUpperCase()}</span>` : '') +
      `<img src="${assetIconUrl(d.id) ?? fallbackIcon}" onerror="this.onerror=null;this.src='${fallbackIcon}'" alt=""/>` +
      `<span class="nm">${d.name}</span>` +
      `<span class="tier">${TIER_LABEL[d.tier] ?? d.tier}${weaponHint(d.id)}</span>` +
      `<span class="cost">${d.cost}</span>` +
      `<span class="cnt"></span>` +
      `<span class="upg">${nUps > 0 ? `⚙ 0/${nUps}` : ''}</span>`;
    btn.onclick = () => doAction({ kind: 'unit', defId: d.id });

    const showTip = (): void => {
      if (openUpgradeUnit !== null) return;
      const tip = $('#tooltip');
      tip.innerHTML = unitInfoHtml(d);
      tip.classList.remove('hidden');
      const r = btn.getBoundingClientRect();
      tip.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
      tip.style.bottom = `${window.innerHeight - r.top + 6}px`;
      tip.style.top = 'auto';
    };
    const hideTip = (): void => $('#tooltip').classList.add('hidden');

    // 마우스: 호버로 정보, 우클릭으로 업그레이드.
    // 업그레이드가 없는 유닛도 브라우저 기본 메뉴는 막고 상세 정보를 띄운다.
    btn.addEventListener('mouseenter', showTip);
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (nUps > 0) toggleUpgradePanel(d.id, btn);
      else {
        closeUpgradePanel();
        showTip();
      }
    });

    // 터치: 호버도 우클릭도 없으므로 "누르는 동안 정보 → 길게 누르면 업그레이드"
    let holdTimer: number | undefined;
    let heldOpened = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      heldOpened = false;
      showTip();
      if (nUps > 0) {
        holdTimer = window.setTimeout(() => {
          heldOpened = true;
          hideTip();
          toggleUpgradePanel(d.id, btn);
        }, 450);
      }
    });
    const endHold = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return;
      clearTimeout(holdTimer);
      if (!heldOpened) hideTip();
    };
    btn.addEventListener('pointerup', endHold);
    btn.addEventListener('pointercancel', endHold);
    btn.addEventListener('pointerleave', endHold);
    // 길게 눌러 업그레이드를 연 경우엔 구매까지 되면 안 된다
    btn.addEventListener('click', (e) => {
      if (heldOpened) {
        e.preventDefault();
        e.stopImmediatePropagation();
        heldOpened = false;
      }
    }, true);
    shop.appendChild(btn);
    shopButtons.push({ defId: d.id, btn, cnt: btn.querySelector('.cnt')!, upg: btn.querySelector('.upg')! });
  }
}

// ── 유닛 정보 HTML (상점 툴팁 + 전장 정보창 공용) ─────────────────────────
const TAG_KO: Record<string, string> = {
  cloth: '천', leather: '가죽', plate: '판금',
  bio: '생체', undead: '망자', construct: '기물',
  massive: '거대', structure: '구조물', flying: '비행',
};

const ZONE_KO: Record<string, string> = {
  thorns: '가시밭', spores: '포자 구름', forest: '숲의 영역', grave: '사후의 경계', blaze: '블레이즈',
};

function unitInfoHtml(d: EntityDef, hp?: number): string {
  const tags = [...d.tags.map((t) => TAG_KO[t] ?? t)];
  if (d.flying) tags.push('비행');
  const rows: string[] = [];
  rows.push(`<div class="ui-name">${d.name}</div>`);
  rows.push(`<div class="ui-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>`);
  rows.push(`<div class="ui-row">체력 <b>${hp !== undefined ? `${Math.max(0, hp)} / ` : ''}${d.maxHp}</b> · 방어 <b>${d.armor}</b></div>`);
  if (d.weapon) {
    const w = d.weapon;
    const bonus = w.bonus
      ? Object.entries(w.bonus).map(([k, v]) => `<span class="ui-bonus">${TAG_KO[k] ?? k} +${v}</span>`).join(' ')
      : '';
    rows.push(`<div class="ui-row">공격 <b>${w.damage}</b> ${bonus}</div>`);
    const cdSec = (w.cooldown / TICK_HZ).toFixed(1);
    const rangeT = (w.range / FP).toFixed(1);
    const tgt = w.targets === 'both' ? '지상+공중' : w.targets === 'ground' ? '지상' : '공중';
    rows.push(`<div class="ui-row">공속 <b>${cdSec}초</b> · 사거리 <b>${rangeT}</b> · 대상 <b>${tgt}</b></div>`);
    const specials: string[] = [];
    if (w.splash) specials.push(`광역 ${(w.splash / FP).toFixed(1)}타일`);
    if (w.slowTicks) specials.push(`둔화 ${(w.slowTicks / TICK_HZ).toFixed(1)}초${w.slowChance ? ` (${w.slowChance}%)` : ''}`);
    if (w.dotDps && w.dotTicks) specials.push(`독 초당 ${w.dotDps} × ${(w.dotTicks / TICK_HZ).toFixed(1)}초${w.dotChance ? ` (${w.dotChance}%)` : ''}`);
    if (w.rootTicks) specials.push(`속박 ${(w.rootTicks / TICK_HZ).toFixed(1)}초${w.rootChance ? ` (${w.rootChance}%)` : ''}`);
    if (w.zone) specials.push(`${ZONE_KO[w.zone.kind]} 장판 ${(w.zone.ticks / TICK_HZ).toFixed(0)}초`);
    if (w.lifestealPct) specials.push(`흡혈 ${w.lifestealPct}%`);
    if (w.airMultiTargets) specials.push(`대공 ${w.airMultiTargets}기 동시 사격`);
    if (w.chillTicks) specials.push(`한기 ${(w.chillTicks / TICK_HZ).toFixed(0)}초 (공속·이속 -20%)`);
    if (specials.length > 0) rows.push(`<div class="ui-row ui-dim">특성: ${specials.join(' · ')}</div>`);
  }
  if (d.heal) {
    const excl = d.heal.excludeTags?.length
      ? ` (${d.heal.excludeTags.map((t) => TAG_KO[t] ?? t).join('·')} 제외)`
      : '';
    rows.push(`<div class="ui-row">회복 <b>${d.heal.amount}</b> / ${(d.heal.cooldown / TICK_HZ).toFixed(1)}초${excl}</div>`);
  }
  for (const a of d.actives ?? []) {
    rows.push(`<div class="ui-row"><span class="ui-bonus">액티브 「${a.name}」</span> ${a.desc} (쿨 ${(a.cooldown / TICK_HZ).toFixed(0)}초)</div>`);
  }
  const spdT = ((d.speed * TICK_HZ) / FP).toFixed(1);
  rows.push(`<div class="ui-row ui-dim">이속 ${spdT} 타일/초 · 비용 ${d.cost}</div>`);
  return rows.join('');
}

function weaponHint(defId: string): string {
  const d = DEFS[defId]!;
  if (d.heal && !d.weapon) return ' · 힐';
  if (!d.weapon) return '';
  const t = d.weapon.targets;
  const tgt = t === 'both' ? '지+공' : t === 'ground' ? '지상' : '공중';
  const kind = d.weapon.range < 2000 ? '근접' : '원거리';
  const extra = (d.weapon.splash ? '·광역' : '') + (d.heal ? '·힐' : '');
  return ` · ${kind}/${tgt}${extra}`;
}

/** 구매류 행동. 솔로 = 즉시 적용, 멀티 = 서버로 보내 전원 동일 틱에 적용. */
function doAction(cmd: { kind: string; defId?: string; id?: string }): void {
  if (!game) return;
  // 살 수 있는지 미리 보고 소리를 가른다 (멀티는 서버 왕복이 있어 즉시 피드백이 필요)
  const p = game.players[myIdx]!;
  const cost = cmd.kind === 'unit' && cmd.defId ? (DEFS[cmd.defId]?.cost ?? 0) : 0;
  audio.play(cost > 0 && p.money < cost ? 'ui_deny' : 'ui_buy', { volume: 0.7 });
  if (isMp) {
    net?.send({ t: 'cmd', cmd });
    return;
  }
  applyCmd(myIdx, cmd);
}

function applyCmd(playerIdx: number, cmd: { kind: string; defId?: string; id?: string }): void {
  if (!game) return;
  if (cmd.kind === 'unit' && cmd.defId) buyUnit(game, playerIdx, cmd.defId);
  else if (cmd.kind === 'income') buyIncomeUpgrade(game, playerIdx);
  else if (cmd.kind === 'tech') buyTechUp(game, playerIdx);
  else if (cmd.kind === 'upgrade' && cmd.id) buyUpgrade(game, playerIdx, cmd.id);
  // AI 인계/반환 (이탈·복귀 시 서버가 스탬프 찍어 중계 — 전 클라이언트 동일 틱 적용)
  else if (cmd.kind === 'aiOn') game.players[playerIdx]!.isBot = true;
  else if (cmd.kind === 'aiOff') game.players[playerIdx]!.isBot = false;
}

// ── 업그레이드 패널 ───────────────────────────────────────────────────────
let openUpgradeUnit: string | null = null;
let lastUpgSig = '';

function closeUpgradePanel(): void {
  if (openUpgradeUnit === null) return;
  openUpgradeUnit = null;
  $('#upg-panel').classList.add('hidden');
}

function toggleUpgradePanel(defId: string, anchor: HTMLElement): void {
  const panel = $('#upg-panel');
  if (openUpgradeUnit === defId) {
    openUpgradeUnit = null;
    panel.classList.add('hidden');
    return;
  }
  openUpgradeUnit = defId;
  lastUpgSig = '';
  $('#tooltip').classList.add('hidden'); // 열릴 때 호버 툴팁은 치운다
  panel.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.min(rect.left, window.innerWidth - 270)}px`;
  panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  panel.style.top = 'auto';
  renderUpgradePanel();
}

function renderUpgradePanel(): void {
  if (!game || !openUpgradeUnit) return;
  const panel = $('#upg-panel');
  const me = game.players[myIdx]!;
  const ups = upgradesOfUnit(openUpgradeUnit);
  const d = DEFS[openUpgradeUnit]!;
  panel.innerHTML = `<h3>${d.name} 업그레이드</h3>`;
  for (const u of ups) {
    const owned = !!me.upgrades[u.id];
    const conflict = !!u.choiceGroup && ups.some((o) => o.choiceGroup === u.choiceGroup && o.id !== u.id && me.upgrades[o.id]);
    const locked = me.techLevel < u.tech;
    const btn = document.createElement('button');
    btn.className = 'upgbtn';
    const state = owned ? '✓ 보유' : conflict ? '택1 마감' : locked ? `🔒 테크 ${u.tech}` : `${u.cost}원`;
    const choiceMark = u.choiceGroup ? ' <span class="choice">[택1]</span>' : '';
    btn.innerHTML = `<b>${u.name}</b>${choiceMark} — ${state}<small>${u.desc}</small>`;
    btn.disabled = owned || conflict || locked || me.money < u.cost;
    btn.onclick = () => doAction({ kind: 'upgrade', id: u.id });
    panel.appendChild(btn);
  }
}

document.addEventListener('pointerdown', (e) => {
  if (!openUpgradeUnit) return;
  const panel = $('#upg-panel');
  if (!panel.contains(e.target as Node)) {
    openUpgradeUnit = null;
    panel.classList.add('hidden');
  }
});

$('#btn-income').onclick = () => doAction({ kind: 'income' });
$('#btn-tech').onclick = () => doAction({ kind: 'tech' });

for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) {
  b.onclick = () => {
    const sp = Number(b.dataset.speed);
    if (isMp) {
      // 멀티에서는 방장만 배속 변경 가능 — 서버가 전원에게 동기화
      if (net && mpHostId === net.clientId) net.send({ t: 'setSpeed', speed: sp });
      return;
    }
    speed = sp;
    updateSpeedButtons();
  };
}

function updateSpeedButtons(): void {
  const current = isMp ? mpSpeed : speed;
  const amHost = !isMp || (net !== null && mpHostId === net.clientId);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) {
    b.classList.toggle('on', Number(b.dataset.speed) === current);
    b.disabled = !amHost;
    b.title = amHost ? '' : '방장만 배속을 바꿀 수 있습니다';
  }
}

// ── 게임 내 알림 토스트 ───────────────────────────────────────────────────
function showToast(text: string): void {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
  while (wrap.children.length > 4) wrap.firstElementChild?.remove();
}

/** 이번 스텝의 시뮬 이벤트를 알림으로. stepGame 직후 호출. */
function consumeEvents(g: Game): void {
  for (const ev of g.events) {
    if (ev.kind === 'wave') {
      audio.play('wave', { volume: 0.7 });
    } else if (ev.kind === 'towerDown') {
      const winners = ev.team === 0 ? 1 : 0;
      showToast(`💥 ${ev.team! + 1}팀 수호탑 파괴 — ${winners + 1}팀 전원 +${MAP.TOWER_BOUNTY}원!`);
      audio.play('tower_down', { volume: 0.9 });
    } else if (ev.kind === 'guardianSpawn') {
      showToast(`🛡 ${ev.team! + 1}팀 수호자 ${ev.team === 0 ? '드래곤' : '슬리피 할로우'} 등장! (대공 유닛만 공격 가능)`);
      audio.play('cast_skill', { volume: 1 });
    } else if (ev.kind === 'guardianDown') {
      showToast(`☠ ${ev.team! + 1}팀 수호자 처치!`);
    } else if (ev.kind === 'gameOver') {
      const me = game?.players[myIdx];
      audio.play(me && ev.winner === me.team ? 'victory' : 'defeat', { volume: 1 });
    }
  }
}

// ── 메인 루프 ─────────────────────────────────────────────────────────────
function mpTargetTick(): number {
  return mpTickBase + Math.floor(((performance.now() - mpTickBaseAtMs) * mpSpeed) / STEP_MS) + 1;
}

function applyDueCmds(): void {
  if (!game) return;
  while (mpQueue.length > 0 && mpQueue[0]!.executeTick <= game.tick) {
    const c = mpQueue.shift()!;
    if (c.executeTick < game.tick) console.warn('늦은 명령', c);
    applyCmd(c.playerIdx, c.cmd);
  }
}

function tick(deltaMS: number): void {
  if (!game || !renderer) return;
  cameraPanFromKeys(deltaMS);
  if (!game.over) {
    if (isMp) {
      const target = mpTargetTick();
      acc += Math.min(deltaMS, 250);
      // 크게 뒤처졌으면 (탭 비활성, 재접속 등) 빠르게 따라잡는다
      let burst = game.tick < target - 20 ? 60 : mpSpeed * 5;
      while (burst-- > 0 && game.tick < target && acc >= 0) {
        if (acc >= STEP_MS) acc -= STEP_MS;
        applyDueCmds();
        renderer.beforeStep(game);
        stepGame(game);
        consumeEvents(game);
        if (game.over) break;
      }
      // 결정론 감시 해시 (5초마다)
      if (game.tick - lastHashTick >= 100 && game.tick % 100 === 0) {
        lastHashTick = game.tick;
        net?.send({ t: 'hash', tick: game.tick, hash: hashGame(game) });
      }
    } else {
      acc += Math.min(deltaMS, 250) * speed;
      while (acc >= STEP_MS) {
        renderer.beforeStep(game);
        stepGame(game);
        consumeEvents(game);
        acc -= STEP_MS;
        if (game.over) break;
      }
    }
  }
  renderer.draw(game, Math.min(1, Math.max(0, acc / STEP_MS)));
  minimap?.draw(game);
  updateHud(game);
  if (selectedUnitId !== null) refreshUnitInfo();
  // 캠페인: 특수 유닛 스폰 스크립트 (적 스폰 지점에 등장 + 경고 배너)
  if (campaign && !campaignDone && !game.over && campaign.spawns) {
    const nowSec = game.tick / TICK_HZ;
    for (let i = 0; i < campaign.spawns.length; i++) {
      const rule = campaign.spawns[i]!;
      if (nowSec < campaignSpawnNext[i]!) continue;
      const n = rule.count ?? 1;
      const sx0 = game.map.spawnX[1];
      for (let k = 0; k < n; k++) {
        spawnUnit(game, rule.defId, 1, sx0, laneCenterY(game.map, sx0) + (k - (n - 1) / 2) * 600);
      }
      campaignSpawnNext[i] = rule.everySec !== undefined ? campaignSpawnNext[i]! + rule.everySec : Infinity;
      campaignAlertText = `⚠ ${rule.label} 출현!`;
      campaignAlertUntil = performance.now() + 4000;
      audio.play('cast_skill', { volume: 0.9 });
    }
  }
  // 캠페인: 협공 주둔지 — 살아 있는 동안 후방에서 적 부대가 쏟아진다
  if (campaign && !campaignDone && !game.over && campaign.warcamp && campaignWarcampId >= 0) {
    const camp = game.entities.find((e) => e.id === campaignWarcampId);
    if (!camp || !camp.alive) {
      campaignWarcampId = -1;
      campaignAlertText = '🏳 후방 주둔지 파괴! 배후 웨이브가 멈춘다!';
      campaignAlertUntil = performance.now() + 4000;
    } else if (game.tick / TICK_HZ >= campaignWarcampNext) {
      for (let k = 0; k < campaign.warcamp.units.length; k++) {
        spawnUnit(game, campaign.warcamp.units[k]!, 1, camp.x, camp.y + (k - 1) * 500);
      }
      campaignWarcampNext += campaign.warcamp.everySec;
      campaignAlertText = '⚠ 후방 주둔지에서 적 부대 출현!';
      campaignAlertUntil = performance.now() + 3000;
    }
  }
  // 캠페인: survive 미션은 제한시간을 버티면 승리 (넥서스를 먼저 부숴도 승리)
  if (campaign && !campaignDone) {
    // tower 미션: 적 수호탑이 무너지는 순간 클리어
    if (campaign.mission === 'tower' && !game.over
      && !game.entities.some((e) => e.alive && e.defId === 'tower' && e.team === 1)) {
      campaignFinish(true);
      return;
    }
    if (campaign.mission === 'survive' && campaign.surviveSec !== undefined) {
      const left = campaign.surviveSec - Math.floor(game.tick / TICK_HZ);
      if (!game.over && left <= 0) {
        campaignFinish(true);
        return;
      }
      if (left > 0 && performance.now() >= campaignAlertUntil) {
        $('#campaign-goal').textContent =
          `[${campaign.id}. ${campaign.title}] ${campaign.goal} — 남은 시간 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      }
    }
    if (performance.now() < campaignAlertUntil) {
      $('#campaign-goal').textContent = campaignAlertText;
    }
    if (game.over) {
      campaignFinish(game.over.winner === 0);
      return;
    }
  }
  if (game.over) {
    if (isMp && !gameOverReported) {
      gameOverReported = true;
      net?.send({ t: 'gameOver' });
    }
    if (!campaign) showResult(game);
  }
}

// ── HUD ───────────────────────────────────────────────────────────────────
function setBar(id: string, hp: number, max: number, label: string): void {
  const bar = $(`#${id}`);
  const fill = bar.querySelector('i') as HTMLElement;
  const span = bar.querySelector('span') as HTMLElement;
  const r = Math.max(0, hp / max);
  fill.style.transform = `scaleX(${r})`;
  span.textContent = `${label} ${Math.ceil(Math.max(0, hp))}`;
}

function updateHud(g: Game): void {
  const me = g.players[myIdx]!;
  $('#money').textContent = String(me.money);
  $('#income').textContent = `+${MAP.INCOME_BASE + MAP.INCOME_PER_LEVEL * me.incomeLevel} / 5초 (Lv${me.incomeLevel}/${g.incomeCap})`;
  const incBtn = $<HTMLButtonElement>('#btn-income');
  if (me.incomeLevel >= g.incomeCap) {
    incBtn.textContent = '인컴 최대';
    incBtn.disabled = true;
  } else if (g.tick < me.incomeCooldownUntil) {
    const cdSec = Math.ceil((me.incomeCooldownUntil - g.tick) / TICK_HZ);
    incBtn.textContent = `인컴 대기 ${cdSec}초`;
    incBtn.disabled = true;
  } else {
    const incCost = incomeUpgradeCost(me.incomeLevel);
    incBtn.textContent = `인컴 업그레이드 (${incCost})`;
    incBtn.disabled = me.money < incCost;
  }

  const techBtn = $<HTMLButtonElement>('#btn-tech');
  if (me.techLevel >= g.techCap) {
    techBtn.textContent = `테크 ${me.techLevel} (최대)`;
    techBtn.disabled = true;
  } else if (me.techPendingUntil >= 0) {
    const sec2 = Math.ceil((me.techPendingUntil - g.tick) / TICK_HZ);
    techBtn.textContent = `테크 ${me.techLevel + 1} 연구 중… ${sec2}초`;
    techBtn.disabled = true;
  } else {
    const tCost = techUpCost(me.techLevel)!;
    techBtn.textContent = `테크 ${me.techLevel + 1} 연구 (${tCost})`;
    techBtn.disabled = me.money < tCost;
  }

  for (const s of shopButtons) {
    const d = DEFS[s.defId]!;
    const locked = techOfUnit(d) > me.techLevel;
    s.btn.disabled = locked || me.money < d.cost;
    const n = me.comp[s.defId] ?? 0;
    // techOfUnit: 유닛별 techReq 오버라이드 반영 (와이번·유니콘·페어리 = 테크 3)
    s.cnt.textContent = locked ? `🔒 테크 ${techOfUnit(d)}` : n > 0 ? `보유 ${n}` : '';
    const upsAll = upgradesOfUnit(s.defId);
    if (upsAll.length > 0) {
      const ownedN = upsAll.filter((u) => me.upgrades[u.id]).length;
      s.upg.textContent = `⚙ ${ownedN}/${upsAll.length}`;
      s.upg.classList.toggle('owned', ownedN > 0);
    }
  }

  if (openUpgradeUnit) {
    const sig = upgradesOfUnit(openUpgradeUnit)
      .map((u) => (me.upgrades[u.id] ? 'o' : me.techLevel < u.tech ? 'l' : me.money >= u.cost ? 'a' : 'x'))
      .join('') + me.techLevel;
    if (sig !== lastUpgSig) {
      lastUpgSig = sig;
      renderUpgradePanel();
    }
  }

  for (const team of [0, 1] as const) {
    const nx = findStructure(g, 'nexus', team);
    const tw = findStructure(g, 'tower', team);
    const mine = team === me.team ? ' (나)' : '';
    setBar(`bar-n${team}`, nx?.alive ? nx.hp : 0, DEFS.nexus!.maxHp, `${team + 1}팀 넥서스${mine}`);
    setBar(`bar-t${team}`, tw?.alive ? tw.hp : 0, DEFS.tower!.maxHp, '');
  }

  const wave = nextWaveInfo(g);
  const sec = Math.max(0, Math.ceil(wave.ticksLeft / TICK_HZ));
  const isPrep = g.waveIndex === 0;
  // 팀마다 인원이 다르면 출정 순번도 다르므로 내 팀 기준으로 본다
  const nextSlot = wave.slots[me.team];
  const mySlot = nextSlot === me.slot;
  $('#wave-label').textContent = isPrep
    ? '첫 출정까지 (전원)'
    : `다음 출정: ${nextSlot + 1}번 유저${mySlot ? ' (나!)' : ''}`;
  $('#wave-timer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  renderRoster(g); // 열려 있을 때만 그린다 (출정 차례 표시가 웨이브마다 바뀐다)
}

// ── 종료 화면 ─────────────────────────────────────────────────────────────
let resultShown = false;
function showResult(g: Game): void {
  if (resultShown || !g.over) return;
  resultShown = true;
  const overlay = $('#overlay');
  const win = g.over.winner === g.players[myIdx]!.team;
  const back = isMp && roomStateCache ? '대기실로' : '메뉴로';
  overlay.innerHTML =
    `<h1>${win ? '승리!' : '패배…'}</h1>` +
    `<p>${g.over.winner + 1}팀이 넥서스를 파괴했습니다.</p>` +
    `<button id="result-restart">${back}</button>`;
  overlay.classList.remove('hidden');
  ($('#result-restart') as HTMLButtonElement).onclick = () => location.reload();
}

// ── 네트워크 초기화 ───────────────────────────────────────────────────────
async function initNet(): Promise<void> {
  const status = $('#net-status');
  // 서버 주소가 아예 없는 배포본(정적 호스팅)이면 접속을 시도하지 않는다.
  if (!serverUrl()) {
    status.textContent = '🔴 멀티플레이 서버 없음 — 연습 게임만 가능합니다';
    ($('#btn-create') as HTMLButtonElement).disabled = true;
    return;
  }
  try {
    net = await connect();
    status.textContent = '🟢 서버 연결됨';

    net.on('rooms', (m) => renderRoomList(m.list as never));
    net.on('joined', (m) => renderRoom(m.state as NetMsg));
    net.on('room', (m) => {
      // 게임 중이면 무시, 로비 화면이면 갱신
      if (!game || game.over) renderRoom(m.state as NetMsg);
    });
    net.on('error', (m) => {
      status.textContent = `⚠ ${m.msg}`;
    });
    net.on('started', (m) => {
      const seats = m.seats as { type: string; name: string; race: RaceId; team: TeamId; clientId: string | null }[];
      const players = simPlayers(seats, m.startBots as boolean[] | undefined);
      const idx = seats.findIndex((s) => s.clientId === net!.clientId);
      mpHostId = m.hostId as string;
      mpTickBase = 0;
      mpTickBaseAtMs = performance.now() + (m.startInMs as number);
      mpSpeed = 1;
      mpQueue = [];
      void startGame(m.seed as number, players, Math.max(0, idx), true,
        (m.mapId as string) ?? DEFAULT_MAP, seats.map((s) => s.name));
    });
    net.on('tick', (m) => {
      // 권위 틱으로 로컬 시계 보정
      mpTickBase = m.tick as number;
      mpTickBaseAtMs = performance.now();
      mpSpeed = (m.speed as number) ?? mpSpeed;
    });
    net.on('speed', (m) => {
      mpTickBase = m.tick as number;
      mpTickBaseAtMs = performance.now();
      mpSpeed = m.speed as number;
      updateSpeedButtons();
    });
    net.on('host', (m) => {
      mpHostId = m.hostId as string;
      updateSpeedButtons();
    });
    net.on('peerBack', (m) => {
      console.warn(`${m.name} 님이 복귀했습니다 (좌석 ${m.playerIdx})`);
      chatSystem(`${m.name} 님이 돌아왔습니다`);
    });
    net.on('rejoin', (m) => {
      void doRejoin(m);
    });
    net.on('cmd', (m) => {
      mpQueue.push(m as unknown as MpCmd);
      mpQueue.sort((a, b) => a.executeTick - b.executeTick || a.seq - b.seq);
    });
    net.on('chat', (m) => {
      const team = m.team as number | null;
      const cls = team === 0 ? 't0' : team === 1 ? 't1' : 'sys';
      pushChatLine(
        `<span class="who ${cls}">${escapeHtml(String(m.from))}</span> ${escapeHtml(String(m.text))}`,
      );
      if (!chatOpen()) $('#btn-chat').classList.add('unread');
    });
    net.on('peerLeft', (m) => {
      console.warn(`${m.name} 님이 나갔습니다 (좌석 ${m.playerIdx})`);
      chatSystem(`${m.name} 님이 나갔습니다 — AI 가 이어받습니다`);
    });
    net.on('desync', (m) => {
      console.error('디싱크 감지', m.tick);
    });

    // 메뉴에 있는 동안 방 목록 폴링
    setInterval(() => {
      if (!$('#menu-screen').classList.contains('hidden')) net?.send({ t: 'listRooms' });
    }, 3000);
    net.send({ t: 'listRooms' });
  } catch {
    status.textContent = '🔴 서버 오프라인 — 연습 게임만 가능합니다';
    ($('#btn-create') as HTMLButtonElement).disabled = true;
  }
}

/**
 * 서버 좌석 정보 → createGame 용 참가자 배열.
 *
 * isBot 은 반드시 "게임 시작 시점"의 값(startBots)을 써야 한다. 좌석의 현재
 * 상태를 쓰면, 중간에 이탈해 AI 로 바뀐 자리를 0틱부터 봇으로 만들어버려
 * 다른 클라이언트와 완전히 다른 게임이 된다. 중도 전환은 명령 로그의
 * aiOn/aiOff 가 같은 틱에 반영해 준다.
 */
function simPlayers(
  seats: { type: string; race: RaceId; team: TeamId }[],
  startBots: boolean[] | undefined,
): { race: RaceId; isBot: boolean; team: TeamId }[] {
  return seats.map((s, i) => ({
    race: s.race,
    isBot: startBots?.[i] ?? s.type === 'ai',
    team: s.team,
  }));
}

/** 재접속: 시드 + 전체 명령 로그를 리플레이해 현재 틱까지 복원한다. */
async function doRejoin(m: NetMsg): Promise<void> {
  const seats = m.seats as { type: string; name: string; race: RaceId; team: TeamId; clientId: string | null }[];
  const players = simPlayers(seats, m.startBots as boolean[] | undefined);
  mpHostId = m.hostId as string;
  await startGame(m.seed as number, players, m.myIdx as number, true,
    (m.mapId as string) ?? DEFAULT_MAP, seats.map((s) => s.name));
  if (!game) return;
  // 명령 로그 리플레이 (aiOn/aiOff 포함 — 서버 기록 그대로)
  mpQueue = (m.cmdLog as MpCmd[]).slice().sort((a, b) => a.executeTick - b.executeTick || a.seq - b.seq);
  const targetTick = m.tick as number;
  while (game.tick < targetTick && !game.over) {
    applyDueCmds();
    stepGame(game);
  }
  mpTickBase = targetTick;
  mpTickBaseAtMs = performance.now();
  mpSpeed = m.speed as number;
  acc = 0;
  updateSpeedButtons();
  console.warn(`재접속 완료 — 틱 ${game.tick} 까지 리플레이`);
}

$('#btn-start').onclick = () => net?.send({ t: 'start' });
$('#btn-leave').onclick = () => {
  net?.send({ t: 'leaveRoom' });
  roomStateCache = null;
  showScreen('menu-screen');
};

// ── 사운드 ────────────────────────────────────────────────────────────────
// 브라우저 자동재생 정책: 사용자 입력이 한 번 있어야 오디오가 열린다.
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('keydown', () => audio.unlock(), { once: true });

function initSoundUi(): void {
  const btn = $('#sfx-toggle') as HTMLButtonElement;
  const slider = $('#sfx-volume') as HTMLInputElement;
  const paint = (): void => {
    btn.textContent = audio.isMuted() || audio.getVolume() === 0 ? '🔇' : '🔊';
    slider.value = String(Math.round(audio.getVolume() * 100));
  };
  btn.onclick = () => {
    audio.setMuted(!audio.isMuted());
    paint();
  };
  slider.oninput = () => {
    audio.setVolume(Number(slider.value) / 100);
    if (audio.isMuted() && Number(slider.value) > 0) audio.setMuted(false);
    paint();
  };
  paint();
}

/**
 * 게임에서 나가기. 멀티면 좌석을 완전히 반납하고(그 자리는 AI 가 이어받는다)
 * 재접속 토큰도 지운다 — 이게 없으면 새로고침할 때마다 같은 방으로 되돌아간다.
 */
$('#btn-quit').onclick = () => {
  const inGame = !!game && !game.over;
  if (inGame && !confirm('게임에서 나가시겠습니까? 내 자리는 AI 가 이어받습니다.')) return;
  if (isMp) {
    net?.send({ t: 'leaveRoom' });
    sessionStorage.removeItem('dl_token');
  }
  // 깨끗한 상태로 메뉴부터 다시 시작
  setTimeout(() => location.reload(), 60);
};

// ── 참여자 목록 ───────────────────────────────────────────────────────────
/** 좌석 인덱스별 표시 이름. 멀티는 서버 좌석 이름, 연습 게임은 AI 표기. */
let playerNames: string[] = [];

function initRoster(): void {
  ($('#btn-roster') as HTMLButtonElement).onclick = () => {
    const panel = $('#roster');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden') && game) renderRoster(game);
  };
}

/** 누가 몇 번으로 언제 출정하는지 한눈에. 팀별로 나눠 보여준다. */
function renderRoster(g: Game): void {
  const panel = $('#roster');
  if (panel.classList.contains('hidden')) return;
  const wave = nextWaveInfo(g);
  const cols = [0, 1].map((team) => {
    const rows = g.players
      .filter((p) => p.team === team)
      .sort((a, b) => a.slot - b.slot)
      .map((p) => {
        const me = p.idx === myIdx ? ' <span class="me">(나)</span>' : '';
        const next = wave.slots[p.team] === p.slot ? ' <span class="next">▶출정</span>' : '';
        const name = playerNames[p.idx] ?? `${p.idx + 1}번`;
        const bot = p.isBot ? '🤖 ' : '';
        return `<div class="rrow"><b>${p.slot + 1}번</b> ${bot}${escapeHtml(name)}`
          + ` <span class="race">${RACE_NAMES[p.race]}</span>${me}${next}</div>`;
      })
      .join('');
    return `<div class="rcol t${team}"><h4>${team + 1}팀</h4>${rows}</div>`;
  });
  panel.innerHTML = cols.join('');
}

// ── 단축키 ────────────────────────────────────────────────────────────────
/**
 * 게임 중 키보드 단축키.
 *   Z = 인컴 업그레이드 · X = 테크 연구
 *   1~9,0,Q,E,R = 상점 진열 순서대로 유닛 생산
 * 채팅 입력 중이거나 메뉴/대기실 화면에서는 동작하지 않는다.
 */
function initHotkeys(): void {
  window.addEventListener('keydown', (e) => {
    if (!game || game.over) return;
    if (chatOpen()) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!$('#overlay').classList.contains('hidden')) return; // 결과/대기 화면

    const k = e.key.toLowerCase();
    if (k === 'z') {
      doAction({ kind: 'income' });
      e.preventDefault();
      return;
    }
    if (k === 'x') {
      doAction({ kind: 'tech' });
      e.preventDefault();
      return;
    }
    const defId = shopKeyMap.get(k);
    if (defId) {
      doAction({ kind: 'unit', defId });
      e.preventDefault();
    }
  });
}

// ── 인게임 채팅 ───────────────────────────────────────────────────────────
/**
 * 채팅은 시뮬레이션과 완전히 분리돼 있다 (명령 로그를 타지 않음).
 * 결정론에 영향을 주지 않고, 재접속 리플레이에도 섞이지 않는다.
 */
const CHAT_KEEP = 6;      // 화면에 남겨두는 줄 수
const CHAT_FADE_MS = 9000; // 이 시간이 지나면 흐려진다 (입력창을 열면 다시 보임)

function chatOpen(): boolean {
  return $('#chat').classList.contains('open');
}

function pushChatLine(html: string): void {
  const log = $('#chat-log');
  const line = document.createElement('div');
  line.className = 'line';
  line.innerHTML = html;
  log.appendChild(line);
  while (log.children.length > CHAT_KEEP) log.firstElementChild?.remove();
  setTimeout(() => {
    if (!chatOpen()) line.classList.add('fade');
  }, CHAT_FADE_MS);
}

/** 시스템 알림 (입장/이탈 등). */
function chatSystem(text: string): void {
  pushChatLine(`<span class="who sys">●</span> ${escapeHtml(text)}`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function setChatOpen(open: boolean): void {
  const box = $('#chat');
  const input = $('#chat-input') as HTMLInputElement;
  box.classList.toggle('open', open);
  if (open) {
    // 다시 보이도록 흐림 해제
    for (const el of box.querySelectorAll('.line')) el.classList.remove('fade');
    $('#btn-chat').classList.remove('unread');
    input.focus();
  } else {
    input.value = '';
    input.blur();
  }
}

function initChat(): void {
  const input = $('#chat-input') as HTMLInputElement;

  ($('#btn-chat') as HTMLButtonElement).onclick = () => setChatOpen(!chatOpen());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) net?.send({ t: 'chat', text });
      setChatOpen(false);
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      setChatOpen(false);
      e.stopPropagation();
    }
  });

  // Enter 로 채팅 열기 (게임 중, 입력창 밖에서만)
  window.addEventListener('keydown', (e) => {
    if (chatOpen()) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'Enter' && isMp && game && !game.over) {
      e.preventDefault();
      setChatOpen(true);
    }
  });
}

// ── 모바일 ────────────────────────────────────────────────────────────────
/** 상점 접기/펼치기. 좁은 화면에서 전장을 넓게 보려고 쓴다. */
function initShopToggle(): void {
  const btn = $('#btn-shop') as HTMLButtonElement;
  btn.onclick = () => {
    const bar = $('#bottombar');
    const collapsed = bar.classList.toggle('collapsed');
    btn.classList.toggle('on', !collapsed);
    // 캔버스 크기가 바뀌므로 렌더러에 알린다
    window.dispatchEvent(new Event('resize'));
  };
}

/**
 * 세로 모드 안내. 전장이 가로로 긴 복도라 가로가 훨씬 잘 보인다.
 * 한 번 닫으면 이 탭에서는 다시 뜨지 않는다.
 */
function initRotateHint(): void {
  const hint = $('#rotate-hint');
  const KEY = 'dl_rotate_dismissed';
  ($('#btn-rotate-close') as HTMLButtonElement).onclick = () => {
    sessionStorage.setItem(KEY, '1');
    hint.style.display = 'none';
  };
  const update = (): void => {
    const narrowPortrait = window.innerWidth < 700 && window.innerHeight > window.innerWidth;
    const inGame = !!game && !game.over;
    hint.style.display =
      narrowPortrait && inGame && sessionStorage.getItem(KEY) !== '1' ? 'block' : 'none';
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', () => setTimeout(update, 200));
  setInterval(update, 1000);
}

initMenu();
initSoundUi();
initShopToggle();
initRotateHint();
initChat();
initHotkeys();
initRoster();
void initNet();
