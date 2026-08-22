/**
 * 클라이언트 엔트리.
 *
 * 흐름: 메뉴(로비) → 방 만들기/참가 → 게임  또는  연습 게임(오프라인).
 * 멀티플레이는 결정론 동기화: 서버는 시드·좌석·명령 스트림·틱 시계만 주고,
 * 모든 클라이언트가 같은 시뮬을 로컬에서 돌린다 (전투 렌더링 지연 0).
 */
import {
  DEFS, FP, MAP, MAPS, DEFAULT_MAP, RACE_NAMES, TICK_HZ, BOONS_BY_UNIT,
  effectiveDef, applyBoons,
  createGame, stepGame, buyUnit, buyIncomeUpgrade, buyTechUp, buyUpgrade,
  findStructure, nextWaveInfo, hashGame, incomeUpgradeCost, techOfUnit, techUpCost,
  unitsOfRace, upgradesOfUnit,
  laneCenterY, spawnUnit,
  type BotDifficulty, type EntityDef, type Game, type RaceId, type TeamId,
} from '@desertlike/sim';
import { assetIconUrl, createRenderer, worldToPxX, type Renderer } from './render.ts';
import {
  SYLVARIN_CAMPAIGN, PERKS, campaignCleared, markCampaignCleared, runDialogue,
  setProgressListener, localSave, applySave,
  perkAlloc, savePerkAlloc, perkPointsSpent, perksToHero,
  BOON_UNLOCKS, boonChoices, saveBoonChoice, unlockedBoonUnits, selectedBoonIds,
  type CampaignStage,
} from './campaign.ts';
import { createAudio } from './audio.ts';
import {
  initTitle, showTitle, titleSubtitle, setTitleAccount, type TitleAction,
} from './title.ts';
import { createMinimap, type Minimap } from './minimap.ts';
import { iconUrl } from './sprites.ts';
import { connect, serverUrl, type Net, type NetMsg } from './net.ts';
import {
  authAvailable, isLoggedIn, isTester, profile, logout, prepareLogin, startLogin,
  fetchSave, pushSave, markSynced, alreadySynced, type SaveData,
} from './auth.ts';

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
/** 배속은 판이 끝나도 유지된다 — 매번 ×1 로 되돌리면 다시 눌러야 해서. */
const LS_SPEED = 'dl_speed';
const SPEEDS = [1, 2, 4];
function loadSpeed(): number {
  const v = Number(localStorage.getItem(LS_SPEED));
  return SPEEDS.includes(v) ? v : 1;
}
let speed = loadSpeed();
/**
 * 일시정지 (솔로 전용 — 멀티는 서버 틱 시계라 멈출 수 없다).
 * 캠페인 컷신 연출도 이걸 재사용해 전투를 세운 채 대화를 띄운다.
 */
let paused = false;
/** 컷신 등으로 강제 정지된 상태 — 사용자가 P 로 풀 수 없다. */
let cutscenePause = false;
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
  // P / Space = 일시정지 토글. 대화 오버레이가 떠 있으면 그쪽이 스페이스를 쓴다.
  const dialogueOpen = !$('#dialogue').classList.contains('hidden');
  if (!dialogueOpen && game && !game.over && !isMp && (e.key === 'p' || e.key === 'P' || e.key === ' ')) {
    e.preventDefault();
    setPaused(!paused);
    return;
  }
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
  let d = e.defOv ?? DEFS[e.defId]!;
  // 둥지 방어전: 아군 넥서스는 이 판에서만 「둥지」다
  if (game.defendNexus && e.defId === 'nexus' && e.team === 0) d = { ...d, name: '둥지' };
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
  if (e.defId === 'nexus' && !game.guardianDown[e.team as 0 | 1]) status.push('보호막 (수호자 생존)');
  // 신규 상태 (판데모니엄 확장 로스터)
  if (game.tick < e.seducedUntil) status.push('매혹 (적진으로 홀린 듯 전진)');
  if (game.tick < e.stealthUntil) status.push('은신');
  if (game.tick < e.transformUntil) status.push('악마 변신');
  if (game.tick < e.purgeImmuneUntil) status.push('완전 해제 (상태이상 면역)');
  if (e.sacrificeStacks > 0) {
    status.push(`제물 흡수 ${e.sacrificeStacks}/10 (공격·공속 +${e.sacrificeStacks * 10}% · 방어 +${e.sacrificeStacks * 2})`);
  }
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
/** 'title' 은 오버레이가 아니라 전체 화면 타이틀 아트를 띄운다. */
function showScreen(id: 'title' | 'menu-screen' | 'race-screen' | 'room-screen' | null): void {
  const overlay = $('#overlay');
  for (const s of ['menu-screen', 'race-screen', 'room-screen']) {
    $(`#${s}`).classList.toggle('hidden', s !== id);
  }
  if (id === 'title') showTitle();
  else $('#title').classList.add('hidden');
  $('#farewell').classList.add('hidden');
  overlay.classList.toggle('hidden', id === null || id === 'title');
  // 나가기·상점 접기는 게임 중(오버레이가 없을 때)에만 의미가 있다
  const inGame = id === null;
  ($('#btn-quit') as HTMLElement).style.display = inGame ? '' : 'none';
  ($('#btn-pause') as HTMLElement).style.display = inGame && !isMp ? '' : 'none';
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
  $('#btn-create').onclick = () => {
    if (!net) return;
    sendName();
    net.send({ t: 'createRoom', name: `${nickname()}의 방` });
  };
  $('#btn-menu-title').onclick = () => showScreen('title');
  $('#need-login').onclick = (e) => {
    // 상자 바깥이나 확인 버튼 — 어느 쪽을 눌러도 닫힌다
    if (e.target === $('#need-login') || (e.target as HTMLElement).id === 'nl-ok') {
      $('#need-login').classList.add('hidden');
    }
  };
  $('#btn-fw-back').onclick = () => showScreen('title');

  initTitle(audio, onTitlePick);
  // 타이틀 아트의 종족명을 이어지는 화면 부제로 물려준다
  $('#overlay-sub').textContent = titleSubtitle();
  // 캠페인 자동 진입(스테이지 재시작 등)이 걸려 있으면 타이틀을 건너뛴다
  if (!campaignAutoResume()) showScreen('title');
}

/**
 * 3막(미공개)에 들어갈 수 있는가 — 서버 화이트리스트에 오른 테스터 계정만.
 * 로그인 기능이 꺼진 로컬 개발 빌드에서는 열어 둔다 (개발 편의).
 */
function act3Open(): boolean {
  return isTester() || !authAvailable();
}

/**
 * 캠페인에 들어갈 수 있는가 — 진행 상황을 계정에 저장하므로 로그인이 필요하다.
 * (로그인 기능이 꺼진 배포에서는 막지 않는다 — 게임 자체가 잠기면 안 되므로)
 */
function campaignGate(): boolean {
  if (!authAvailable() || isLoggedIn()) return true;
  showScreen('title');
  $('#need-login').classList.remove('hidden');
  return false;
}

/** 타이틀 메뉴 → 이어질 화면. */
function onTitlePick(action: TitleAction): void {
  if (action === 'campaign') { if (campaignGate()) showCampaignSelect(); }
  else if (action === 'solo') showSoloRaceSelect();
  else if (action === 'versus') {
    showScreen('menu-screen');
    net?.send({ t: 'listRooms' }); // 들어가자마자 방 목록이 비어 보이지 않게
  } else if (action === 'login') {
    if (isLoggedIn()) { logout(); refreshAuthUi(); return; }
    // 팝업 차단을 피하려면 클릭 직후 곧바로 열어야 한다 (await 금지)
    if (!startLogin()) alert('로그인 준비 중입니다. 잠시 후 다시 눌러 주세요.');
  } else {
    // 종료: 스크립트로 연 창이 아니면 브라우저가 close 를 막는다 — 작별 화면으로 대신한다
    $('#title').classList.add('hidden');
    $('#overlay').classList.add('hidden');
    $('#farewell').classList.remove('hidden');
    setTimeout(() => window.close(), 200);
  }
}

function nickname(): string {
  // 로그인했으면 구글 계정 이름을 그대로 쓴다 (닉네임 입력칸은 숨겨진다)
  const p = profile();
  if (p?.name) return p.name;
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
    ? '방장: 자리를 채우고 시작하세요. 빈 자리는 빠진 채 시작됩니다 (1:1~3:3). 「AI 추가」로 봇을 넣을 수 있어요.'
    : '방장이 시작하기를 기다리는 중… 내 종족 버튼으로 종족을 바꿀 수 있습니다.';
  ($('#btn-start') as HTMLButtonElement).style.display = isHost ? '' : 'none';
  // 방장 전용 맵 변경 버튼
  const mapBtn = $<HTMLButtonElement>('#btn-map');
  mapBtn.style.display = isHost ? '' : 'none';
  mapBtn.textContent = `맵 변경 (${mapName})`;
  mapBtn.onclick = () => {
    const next = PVP_MAPS[(PVP_MAPS.indexOf(s.mapId) + 1) % PVP_MAPS.length]!;
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
let campaignSpawnedTotal: number[] = [];
/** 마몬의 상점 채널링 시작 틱 (-1 = 채널링 없음). */
let campaignCaptureStartTick = -1;
/** boss 미션: 처치 대상 보스 엔티티 id (-1 = 없음). */
let campaignBossId = -1;
// ── 호위전 (13. 페이로드) 상태 ──
/** 확보한 거점 수 (0..points.length). */
let escortFrontier = 0;
/** 현재 거점 점령 진행 (틱). */
let escortProgressTicks = 0;
/** 적 단독 점유 누적 (틱) — loseSec 채우면 거점 상실. */
let escortLoseTicks = 0;
/** 보급 마차 엔티티 id. */
let escortCartId = -1;
/** 후퇴 목표 x (FP, -1 = 후퇴 아님). */
let escortRetreatX = -1;
/** 진행량 계산용 직전 게임 틱 (프레임당 dt 를 구한다). */
let escortPrevTick = 0;
/** 최전방(캠프 1)까지 뚫렸는가 — true 면 적 진군 하한이 풀린다 (넥서스 러시). */
let escortEnemyBreak = false;
let campaignCutsceneDone: boolean[] = [];
let campaignGrowthWave: number[] = []; // 규칙별 마지막으로 편입한 웨이브 번호
let campaignGrowthAnnounced: boolean[] = [];
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
  // 로그인 상태인데 아직 이 계정과 맞춰보지 않았다면 먼저 동기화를 묻는다
  if (isLoggedIn() && !alreadySynced() && !syncDeferred) {
    void fetchSave().then((remote) => {
      void maybeSync(remote).then(() => showCampaignSelect());
    });
    return;
  }
  const wrap = $('#races');
  wrap.innerHTML = '';
  $('#race-note').classList.add('hidden');
  const cleared = campaignCleared();

  // 제목 + 진행도
  const title = document.createElement('h2');
  title.textContent = '🌲 실바린 캠페인 — 자정의 세계수';
  wrap.appendChild(title);
  const prog = document.createElement('div');
  prog.className = 'camp-progress';
  prog.textContent = `진행 ${Math.min(cleared, SYLVARIN_CAMPAIGN.length)} / ${SYLVARIN_CAMPAIGN.length} 스테이지 클리어`;
  wrap.appendChild(prog);

  // 막(Act)별 컬럼 — 전체 여정이 한 화면에 들어온다 (스토리가 주인공)
  const ACT_TITLE: Record<number, string> = {
    1: '1막 — 재의 새벽', 2: '2막 — 태엽과 가시', 3: '3막 — 자정의 세계수',
  };
  const acts = document.createElement('div');
  acts.id = 'camp-acts';
  const cols = new Map<number, HTMLElement>();
  for (const act of [1, 2, 3]) {
    const col = document.createElement('div');
    col.className = 'camp-act-col';
    const done = SYLVARIN_CAMPAIGN.filter((st) => st.act === act && st.id <= cleared).length;
    const total = SYLVARIN_CAMPAIGN.filter((st) => st.act === act).length;
    col.innerHTML = `<h3>${ACT_TITLE[act]} <small style="color:var(--dim);float:right">${done}/${total}</small></h3>`;
    cols.set(act, col);
    acts.appendChild(col);
  }
  for (const st of SYLVARIN_CAMPAIGN) {
    const btn = document.createElement('button');
    btn.className = 'camp-stage';
    const unreleased = st.act === 3 && st.id > 13 && !act3Open(); // 13은 전체 공개, 14+ 는 테스터만
    const locked = unreleased || st.id > cleared + 1;
    const done = st.id <= cleared;
    const isNext = !unreleased && st.id === cleared + 1;
    btn.disabled = locked;
    if (isNext) btn.style.borderColor = 'var(--gold)';
    btn.innerHTML =
      `<span class="num">${st.id}</span>` +
      `<span style="flex:1">${unreleased ? '??? (준비 중)' : locked ? '???' : st.title}</span>` +
      (done ? '<span class="done">✔</span>' : isNext ? '<span style="color:var(--gold)">▶</span>' : unreleased ? '<span>🚧</span>' : '<span>🔒</span>');
    if (!locked) btn.onclick = () => void startCampaignStage(st);
    cols.get(st.act)!.appendChild(btn);
  }
  wrap.appendChild(acts);

  // 성장·이동 도구는 목록 아래 보조 바로 — 스토리보다 낮은 톤
  const tools = document.createElement('div');
  tools.className = 'camp-tools';
  const perkBtn = document.createElement('button');
  perkBtn.className = 'menubtn alt';
  const alloc0 = perkAlloc();
  perkBtn.textContent = `🌿 세계수의 축복 — ${cleared - perkPointsSpent(alloc0)}P 남음`;
  perkBtn.onclick = () => showPerkScreen();
  tools.appendChild(perkBtn);
  if (unlockedBoonUnits().length > 0) {
    const boonBtn = document.createElement('button');
    boonBtn.className = 'menubtn alt';
    const chosen = Object.keys(boonChoices()).filter((u) => unlockedBoonUnits().includes(u)).length;
    boonBtn.textContent = `⚔ 유닛 강화 — ${chosen}/${unlockedBoonUnits().length} 선택`;
    boonBtn.onclick = () => showBoonScreen();
    tools.appendChild(boonBtn);
  }
  const back = document.createElement('button');
  back.className = 'menubtn alt';
  back.textContent = '← 타이틀로';
  back.onclick = () => showScreen('title');
  tools.appendChild(back);
  wrap.appendChild(tools);
  showScreen('race-screen');
}

/** 영웅 특성 화면 — 포인트 = 클리어 수, 언제든 무료 재분배. */
function showPerkScreen(): void {
  const wrap = $('#races');
  wrap.innerHTML = '';
  $('#race-note').classList.add('hidden');
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

/** 유닛 강화 화면 — 스테이지 클리어로 개방, 유닛당 3택 1. 언제든 무료 재선택. */
function showBoonScreen(): void {
  const wrap = $('#races');
  wrap.innerHTML = '';
  $('#race-note').classList.add('hidden');
  const title = document.createElement('h2');
  title.textContent = '⚔ 유닛 강화';
  wrap.appendChild(title);
  const info = document.createElement('p');
  info.style.cssText = 'color:var(--dim);font-size:13px;max-width:520px;text-align:center';
  info.textContent = '스테이지를 클리어하면 유닛의 강화가 열린다. 유닛마다 하나만 — 언제든 무료로 바꿀 수 있다.';
  wrap.appendChild(info);

  const list = document.createElement('div');
  list.id = 'campaign-list';
  list.style.maxWidth = '640px';
  const KIND_BADGE: Record<string, string> = { stat: '📊 능력치', passive: '✨ 패시브', active: '⚡ 액티브' };
  const rerender = (): void => {
    list.innerHTML = '';
    const chosen = boonChoices();
    for (const unit of unlockedBoonUnits()) {
      const d = DEFS[unit]!;
      const head = document.createElement('div');
      head.className = 'camp-act';
      const cur = chosen[unit];
      head.innerHTML = `${d.name} <small style="color:var(--dim)">${cur ? '' : '— 미선택'}</small>`;
      list.appendChild(head);
      for (const b of BOONS_BY_UNIT.get(unit) ?? []) {
        const on = cur === b.id;
        const btn = document.createElement('button');
        btn.className = 'camp-stage';
        btn.style.cssText = on ? 'border-color:var(--gold)' : '';
        btn.innerHTML =
          `<span class="num">${on ? '✔' : ''}</span>` +
          `<span style="flex:1"><b${on ? ' style="color:var(--gold)"' : ''}>${b.name}</b>` +
          ` <small style="color:var(--dim)">${KIND_BADGE[b.kind]}</small><br/>` +
          `<small style="color:var(--dim)">${b.desc}</small></span>`;
        btn.onclick = () => {
          saveBoonChoice(unit, on ? null : b.id); // 다시 누르면 해제
          audio.play('ui_buy', { volume: 0.6 });
          rerender();
        };
        list.appendChild(btn);
      }
    }
  };
  rerender();
  wrap.appendChild(list);
  const row = document.createElement('div');
  row.className = 'menurow';
  const back = document.createElement('button');
  back.className = 'menubtn';
  back.textContent = '← 캠페인으로';
  back.onclick = () => showCampaignSelect();
  row.appendChild(back);
  wrap.appendChild(row);
  showScreen('race-screen');
}

async function startCampaignStage(st: CampaignStage): Promise<void> {
  if (st.act === 3 && st.id > 13 && !act3Open()) { showCampaignSelect(); return; } // 14+ 는 테스터 전용
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
    ...(st.enemyUnitCaps ? { enemyUnitCaps: st.enemyUnitCaps } : {}),
    ...(st.allyUnitCaps ? { allyUnitCaps: st.allyUnitCaps } : {}),
    ...(st.enemyAllowedUnits ? { enemyAllowedUnits: st.enemyAllowedUnits } : {}),
    ...(st.enemyStartMoney !== undefined ? { enemyStartMoney: st.enemyStartMoney } : {}),
    ...(st.enemyStartTech !== undefined ? { enemyStartTech: st.enemyStartTech } : {}),
    ...(st.enemyIncomePct !== undefined ? { enemyIncomePct: st.enemyIncomePct } : {}),
    ...(st.enemyUnitMinWave ? { enemyUnitMinWave: st.enemyUnitMinWave } : {}),
    ...(st.enemyCapsUntilWave !== undefined ? { enemyCapsUntilWave: st.enemyCapsUntilWave } : {}),
    ...(st.enemyBotStyle ? { enemyBotStyle: st.enemyBotStyle } : {}),
    ...(st.allyBotStyle ? { allyBotStyle: st.allyBotStyle } : {}),
    ...(st.jointDeploy ? { jointDeploy: true } : {}),
    ...(st.enemyGuardian ? { enemyGuardian: st.enemyGuardian } : {}),
    ...(st.allowedUnits ? { allowedUnits: st.allowedUnits } : {}),
    ...(selectedBoonIds().length > 0 ? { unitBoons: selectedBoonIds() } : {}),
    ...(st.mercUnits ? { mercUnits: st.mercUnits } : {}),
    ...(st.mercCostPct !== undefined ? { mercCostPct: st.mercCostPct } : {}),
    ...(st.mercCaptureRequired ? { mercCaptureRequired: true } : {}),
    ...(st.holdLineXTile !== undefined ? { holdLineX: Math.floor(st.holdLineXTile * FP) } : {}),
    ...(st.defendNexus ? { defendNexus: true } : {}),
    ...(st.allyDeployTile
      ? { allyDeploy: { x: Math.floor(st.allyDeployTile.x * FP), y: Math.floor(st.allyDeployTile.y * FP) } }
      : {}),
  } as { incomeCap?: number; techCap?: number };
  campaignSpawnNext = (st.spawns ?? []).map((r) => r.atSec ?? r.everySec ?? Infinity);
  campaignSpawnedTotal = (st.spawns ?? []).map(() => 0);
  campaignCaptureStartTick = -1;
  campaignBossId = -1;
  escortFrontier = 0;
  escortProgressTicks = 0;
  escortLoseTicks = 0;
  escortCartId = -1;
  escortRetreatX = -1;
  escortPrevTick = 0;
  escortEnemyBreak = false;
  renderer?.setEscort(null);
  campaignCutsceneDone = (st.cutscenes ?? []).map(() => false);
  campaignGrowthWave = (st.growth ?? []).map(() => 0);
  campaignGrowthAnnounced = (st.growth ?? []).map(() => false);
  campaignAlertUntil = 0;
  campaignWarcampId = -1;
  campaignWarcampNext = st.warcamp ? st.warcamp.everySec : Infinity;
  campaignHeroPerks = perksToHero(perkAlloc());
  const rosterNames = players.map((pl, i) => {
    if (i === 0) return '카엘 (나)';
    return pl.team === 0 ? `아군 ${RACE_NAMES[pl.race]} 부대` : `${RACE_NAMES[pl.race]} 군세`;
  });
  await startGame(st.seed, players, 0, false, st.mapId ?? DEFAULT_MAP, rosterNames, st.botDifficulty);
  campaignCaps = null;
  if (st.startMoney !== undefined && game) game.players[0]!.money = st.startMoney;
  if (st.noEnemyNexus && game) {
    // 보스전: 적 넥서스가 없다 — 파괴 목표는 보스뿐 (적 봇 생산은 계속된다)
    game.entities = game.entities.filter((e) => !(e.defId === 'nexus' && e.team === 1));
  }
  if (st.bossDefId && game) {
    // 보스 젠: 적 진영 앞 — leashed 라 요새를 지키다 접근하면 교전한다
    const bx = game.map.spawnX[1];
    const boss = spawnUnit(game, st.bossDefId, 1, bx, laneCenterY(game.map, bx));
    campaignBossId = boss.id;
    campaignAlertText = '⚔ 사령장군 카르가스가 요새 앞을 지키고 있다!';
    campaignAlertUntil = performance.now() + 5000;
  }
  if (st.obstacles && game) {
    // 불타는 숲 장애물: 무적·부동 — 아무도 조준하지 않지만 지상 유닛의 길을 막는다
    for (const ob of st.obstacles) {
      const ox = Math.floor(ob.xTile * FP);
      const oy = laneCenterY(game.map, ox) + Math.floor(ob.yOffTile * FP);
      const e = spawnUnit(game, ob.defId, 2, ox, oy);
      e.invulnUntil = Number.MAX_SAFE_INTEGER;
    }
  }
  if (st.escort && game) {
    // 보급 마차: 아군 진영에서 출발. 무적 — 호위 실패는 「거점 상실」로만 표현된다
    const cx0 = game.map.spawnX[0];
    const cart = spawnUnit(game, st.escort.cartDefId, 0, cx0, laneCenterY(game.map, cx0));
    cart.invulnUntil = Number.MAX_SAFE_INTEGER;
    escortCartId = cart.id;
    // 아군 부대는 첫 거점 언저리까지만 진군해 대기
    game.holdLineX = Math.floor(st.escort.pointsXTile[0]! * FP) + 3 * FP;
  }
  if (st.nestGuards && game) {
    // 둥지 수호탑: 아군 고정 수호수 — 무적 + 제자리 (speed 0)
    for (const ng of st.nestGuards) {
      const gx = Math.floor(ng.xTile * FP);
      const gy = laneCenterY(game.map, gx) + Math.floor(ng.yOffTile * FP);
      const e = spawnUnit(game, ng.defId, 0, gx, gy);
      e.invulnUntil = Number.MAX_SAFE_INTEGER;
    }
  }
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
function campaignFinish(win: boolean, reason?: string): void {
  if (!campaign || campaignDone) return;
  campaignDone = true;
  const st = campaign;
  const turnAt = game ? game.waveIndex : 0; // 패배 시점 턴 수 표시용
  if (win) markCampaignCleared(st.id);
  const showEnd = (): void => {
    const overlay = $('#overlay');
    const isLast = st.id === SYLVARIN_CAMPAIGN.length;
    const newBoonUnit = win ? BOON_UNLOCKS[st.id] : undefined;
    const nextSt = SYLVARIN_CAMPAIGN.find((x) => x.id === st.id + 1);
    const nextUnreleased = nextSt !== undefined && nextSt.act === 3 && nextSt.id > 13 && !act3Open(); // 14+ 테스터 전용
    overlay.innerHTML =
      `<h1>${win ? '스테이지 클리어!' : `패배… (${turnAt}턴)`}</h1>` +
      `<p>${st.id}. ${st.title}${reason ? ` — ${reason}` : ''}</p>` +
      (newBoonUnit ? `<p style="color:var(--gold)">⚔ 새 유닛 강화 개방 — ${DEFS[newBoonUnit]!.name}! 캠페인 화면에서 골라 보자.</p>` : '') +
      (win && nextUnreleased ? `<p style="color:var(--dim)">🚧 3막은 준비 중입니다 — 곧 공개!</p>` : '') +
      (win && !isLast && !nextUnreleased ? `<button id="camp-next">다음 스테이지 ▶</button>` : '') +
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

/**
 * 새로고침 직후 캠페인 자동 진입 (다음 스테이지 / 재도전 / 목록).
 * 진입했으면 true — 이때는 타이틀을 띄우지 않는다.
 */
function campaignAutoResume(): boolean {
  const auto = sessionStorage.getItem('camp_auto');
  if (!auto) return false;
  sessionStorage.removeItem('camp_auto');
  if (!campaignGate()) return true; // 로그아웃 상태 — 안내를 띄우고 타이틀에 머문다
  if (auto === 'list') {
    showCampaignSelect();
    return true;
  }
  const id = Number(auto);
  const st = SYLVARIN_CAMPAIGN.find((x) => x.id === id);
  if (st && id <= campaignCleared() + 1) void startCampaignStage(st);
  else showCampaignSelect();
  return true;
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
  // 안내문은 제목 아래에 와야 자연스러워서 정적 노트 대신 여기서 만든다
  $('#race-note').classList.add('hidden');
  const head = document.createElement('h2');
  head.textContent = '🎮 연습 모드';
  wrap.appendChild(head);
  const note = document.createElement('p');
  note.textContent = '3:3 오프라인 대전 — 종족을 고르면 바로 시작합니다. 나머지 자리는 AI 가 맡아요.';
  wrap.appendChild(note);
  // 맵 선택 토글
  const mapRow = document.createElement('div');
  mapRow.className = 'menurow';
  for (const m of Object.values(MAPS).filter((mm) => PVP_MAPS.includes(mm.id))) {
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
    const names = players.map((pl, i) =>
      i === idx ? '나' : `${RACE_NAMES[pl.race]} AI`);
    void startGame(seed, players, idx, false, soloMapId, names, soloDifficulty);
  }));
  const backRow = document.createElement('div');
  backRow.className = 'menurow';
  const back = document.createElement('button');
  back.className = 'menubtn alt';
  back.textContent = '← 타이틀로';
  back.onclick = () => showScreen('title');
  backRow.appendChild(back);
  wrap.appendChild(backRow);
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
  // 로딩 표시 — 첫 판은 렌더러·타일셋·스프라이트 로드가 수 초 걸릴 수 있다
  $('#loading').classList.remove('hidden');
  try {
  isMp = mp;
  myIdx = myIdxV;
  mpQueue = [];
  lastHashTick = 0;
  gameOverReported = false;
  resultShown = false;
  speed = loadSpeed();
  mpSpeed = 1;
  paused = false;
  cutscenePause = false;
  $('#paused').classList.add('hidden');
  $('#btn-pause').classList.remove('on');
  $('#btn-pause').textContent = '⏸ 일시정지';
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
  renderer.setEnemySkin(campaign?.enemySkin ?? null);
  renderer.setMap(game.map);
  minimap?.setMap(game.map);
  renderer.draw(game, 1);
  renderer.centerOn(worldToPxX(game.map.spawnX[game.players[myIdx]!.team]));
  } finally {
    $('#loading').classList.add('hidden');
  }
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

/**
 * 대전(연습·멀티)에서 고를 수 있는 맵. 나머지(탐욕의 계곡·바람의 둥지·합류점)는
 * 캠페인 전용 — 상점 점령·둥지·보스 같은 캠페인 장치를 전제로 설계된 맵이다.
 */
const PVP_MAPS = ['plains', 'toybox', 'valley'];

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
    const nUps = visibleUpgradesOf(d.id).length;
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
      const eff = myEffectiveDef(d.id);
      tip.innerHTML =
        (eff.boosted ? '<div class="ui-dim"><span class="ui-bonus">업그레이드·강화 반영된 수치</span></div>' : '') +
        unitInfoHtml(eff.d);
      tip.classList.remove('hidden');
      const r = btn.getBoundingClientRect();
      tip.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
      tip.style.bottom = `${window.innerHeight - r.top + 6}px`;
      tip.style.top = 'auto';
    };
    const hideTip = (): void => $('#tooltip').classList.add('hidden');

    // 마우스: 호버로 정보, 우클릭으로 업그레이드.
    // 업그레이드가 없는 유닛도 브라우저 기본 메뉴는 막고 상세 정보를 띄운다.
    btn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(); });
    btn.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTip(); });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (nUps > 0) toggleUpgradePanel(d.id, btn);
      else {
        closeUpgradePanel();
        showTip();
      }
    });

    // 터치: 짧은 탭 = 구매만 (정보창 없음 — 매번 떠서 거슬린다는 피드백).
    // 꾹 1초 = 설명창, 꾹 2초 = 업그레이드창.
    let holdTip: number | undefined;
    let holdUpg: number | undefined;
    let heldOpened = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      heldOpened = false;
      holdTip = window.setTimeout(() => {
        heldOpened = true; // 설명창을 연 순간부터 손을 떼도 구매되지 않는다
        showTip();
      }, 1000);
      if (nUps > 0) {
        holdUpg = window.setTimeout(() => {
          hideTip();
          toggleUpgradePanel(d.id, btn);
        }, 2000);
      }
    });
    const endHold = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return;
      clearTimeout(holdTip);
      clearTimeout(holdUpg);
      hideTip();
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

  // ── 용병 (캠페인): 종족 무관 구매 — 마몬의 장사 ──
  for (const mercId of campaign?.mercUnits ?? []) {
    const d = DEFS[mercId];
    if (!d) continue;
    const cost = Math.floor((d.cost * (campaign?.mercCostPct ?? 100)) / 100);
    const btn = document.createElement('button');
    btn.className = 'unitbtn merc';
    const fallbackIcon = iconUrl(d.id, 0);
    btn.innerHTML =
      `<img src="${assetIconUrl(d.id) ?? fallbackIcon}" onerror="this.onerror=null;this.src='${fallbackIcon}'" alt=""/>` +
      `<span class="nm">${d.name}</span>` +
      `<span class="tier">${d.id.startsWith('c_alice') ? '🎀 지원' : '💰 용병'}</span>` +
      `<span class="cost">${cost}</span>` +
      `<span class="cnt"></span>` +
      `<span class="upg"></span>`;
    btn.onclick = () => doAction({ kind: 'unit', defId: d.id });
    const showTip = (): void => {
      if (openUpgradeUnit !== null) return;
      const tip = $('#tooltip');
      tip.innerHTML =
        `<div class="ui-dim"><span class="ui-bonus">${d.id.startsWith('c_alice')
          ? '🎀 앨리스의 지원 병력 — 여왕이 빌려준 왕실 인형'
          : '💰 마몬의 용병 — 언데드는 드루이드 치유를 받지 못한다'}</span></div>` +
        unitInfoHtml(d);
      tip.classList.remove('hidden');
      const r = btn.getBoundingClientRect();
      tip.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
      tip.style.bottom = `${window.innerHeight - r.top + 6}px`;
      tip.style.top = 'auto';
    };
    btn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(); });
    btn.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') $('#tooltip').classList.add('hidden');
    });
    {
      // 터치: 꾹 1초 = 설명창 (놓으면 닫힘), 짧은 탭 = 구매만
      let mercHold: number | undefined;
      let mercHeld = false;
      btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        mercHeld = false;
        mercHold = window.setTimeout(() => { mercHeld = true; showTip(); }, 1000);
      });
      const mercEnd = (e: PointerEvent): void => {
        if (e.pointerType === 'mouse') return;
        clearTimeout(mercHold);
        $('#tooltip').classList.add('hidden');
      };
      btn.addEventListener('pointerup', mercEnd);
      btn.addEventListener('pointercancel', mercEnd);
      btn.addEventListener('pointerleave', mercEnd);
      btn.addEventListener('click', (e) => {
        if (mercHeld) {
          e.preventDefault();
          e.stopImmediatePropagation();
          mercHeld = false;
        }
      }, true);
    }
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
/** 화면에 띄우지 않는 태그 — 성별은 연출용 메타데이터일 뿐이다. */
const HIDDEN_TAGS = new Set(['male', 'female']);

const ZONE_KO: Record<string, string> = {
  thorns: '가시밭', spores: '포자 구름', forest: '숲의 영역', grave: '사후의 경계', blaze: '블레이즈',
};

/**
 * 상점·툴팁용 "내 유닛의 실제 스펙": 구매한 업그레이드 → 캠페인 유닛 강화 →
 * 영웅 특성(세계수의 축복) 순으로 반영한다 — 출정하는 유닛과 같은 수치.
 */
function myEffectiveDef(defId: string): { d: EntityDef; boosted: boolean } {
  const base = DEFS[defId]!;
  if (!game) return { d: base, boosted: false };
  const p = game.players[myIdx];
  let d = (p ? effectiveDef(defId, p.upgrades) : undefined) ?? base;
  if (game.unitBoons.length > 0) d = applyBoons(d, game.unitBoons);
  if (game.heroPerks) {
    const hk = game.heroPerks;
    const maxHp = hk.hpPct ? Math.floor((d.maxHp * (100 + hk.hpPct)) / 100) : d.maxHp;
    const weapon = d.weapon && hk.dmgPct
      ? { ...d.weapon, damage: Math.floor((d.weapon.damage * (100 + hk.dmgPct)) / 100) }
      : d.weapon;
    d = { ...d, maxHp, ...(weapon ? { weapon } : {}) };
  }
  return { d, boosted: d !== base };
}

/**
 * 이 판에서 상점에 보여줄 업그레이드 목록.
 * campaignOnly(강화 연계 해금)는 캠페인에서 그 강화를 실제로 골랐을 때만 노출 —
 * 대전이나 강화 미선택 상태에선 사도 의미 없는 버튼이라 숨긴다.
 */
function visibleUpgradesOf(defId: string): ReturnType<typeof upgradesOfUnit> {
  const all = upgradesOfUnit(defId);
  return all.filter((u) => {
    if (!u.campaignOnly) return true;
    if (!campaign || !game) return false;
    // 연계된 캠페인 강화를 실제로 골랐을 때만 노출
    return u.boonId !== undefined && game.unitBoons.includes(u.boonId);
  });
}

function unitInfoHtml(d: EntityDef, hp?: number): string {
  const tags = d.tags.filter((t) => !HIDDEN_TAGS.has(t)).map((t) => TAG_KO[t] ?? t);
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
    if (w.splash) {
      specials.push(w.splashAirOnly
        ? `대공 광역 ${(w.splash / FP).toFixed(1)}타일 (지상은 단일)`
        : `광역 ${(w.splash / FP).toFixed(1)}타일`);
    }
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
  const extra = (d.weapon.splash ? (d.weapon.splashAirOnly ? '·대공광역' : '·광역') : '') + (d.heal ? '·힐' : '');
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
  const ups = visibleUpgradesOf(openUpgradeUnit);
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

$('#btn-pause').onclick = () => setPaused(!paused);
$('#paused').onclick = () => setPaused(false);

for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) {
  b.onclick = () => {
    const sp = Number(b.dataset.speed);
    if (isMp) {
      // 멀티에서는 방장만 배속 변경 가능 — 서버가 전원에게 동기화
      if (net && mpHostId === net.clientId) net.send({ t: 'setSpeed', speed: sp });
      return;
    }
    speed = sp;
    localStorage.setItem(LS_SPEED, String(sp));
    updateSpeedButtons();
  };
}

function setPaused(v: boolean): void {
  if (isMp) return; // 멀티는 서버 권위 시계라 개인이 멈출 수 없다
  paused = v;
  $('#paused').classList.toggle('hidden', !paused && !cutscenePause);
  $('#btn-pause').classList.toggle('on', paused);
  $('#btn-pause').textContent = paused ? '▶ 계속하기' : '⏸ 일시정지';
}

/** 컷신용 정지 — 사용자 조작과 무관하게 전투만 세운다. */
function setCutscenePause(v: boolean): void {
  cutscenePause = v;
  // 컷신 중엔 대화창이 화면을 덮으므로 "일시정지" 안내는 띄우지 않는다
  $('#paused').classList.toggle('hidden', cutscenePause || !paused);
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
  if (!game.over && !paused && !cutscenePause) {
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
  // 캠페인: 마몬의 상점 점령 판정.
  // 규칙: 한쪽 팀 유닛만 반경 안에 있으면 10초(200틱) 채널링 → 완료 시 그 팀 소유.
  //  - 양쪽이 섞이거나 아무도 없으면 채널링은 리셋된다.
  //  - 소유 팀이 자리를 비운 사이 상대가 단독 점유를 시작하면 소유가 즉시 풀린다(중립)
  //    — 풀린 순간부터 용병 구매 불가. 재점령도 다시 10초.
  if (campaign && !campaignDone && !game.over && game.mercCaptureRequired) {
    const cx = Math.floor(game.map.length / 2);
    const r = Math.floor(3.5 * FP); // 3.5타일 (FP 정수)
    let mine = 0;
    let theirs = 0;
    for (const e of game.entities) {
      if (!e.alive || e.owner < 0) continue; // 구조물·수호자 제외
      const dx = e.x - cx;
      if (dx * dx > r * r) continue;
      if (e.team === 0) mine++;
      else theirs++;
    }
    const sole = mine > 0 && theirs === 0 ? 0 : theirs > 0 && mine === 0 ? 1 : -1;
    if (sole === -1 || sole === game.mercOwner) {
      // 경합·비움·이미 내 소유 — 채널링 없음
      game.mercCapturingTeam = -1;
      game.mercCaptureTicks = 0;
      campaignCaptureStartTick = -1;
    } else {
      // 상대(또는 중립 도전자)의 단독 점유 — 기존 소유는 즉시 풀린다
      if (game.mercOwner !== -1) {
        const lostMine = game.mercOwner === 0;
        game.mercOwner = -1;
        campaignAlertText = lostMine
          ? '⚠ 마몬의 상점 점령이 풀렸다! 용병 구매 불가'
          : '🚩 적의 상점 점령을 끊었다!';
        campaignAlertUntil = performance.now() + 3500;
        audio.play('cast_skill', { volume: 0.8 });
      }
      if (campaignCaptureStartTick < 0 || game.mercCapturingTeam !== sole) {
        game.mercCapturingTeam = sole;
        campaignCaptureStartTick = game.tick;
      }
      game.mercCaptureTicks = game.tick - campaignCaptureStartTick;
      if (game.mercCaptureTicks >= 200) { // 10초
        game.mercOwner = sole;
        game.mercCapturingTeam = -1;
        game.mercCaptureTicks = 0;
        campaignCaptureStartTick = -1;
        campaignAlertText = sole === 0
          ? '🚩 마몬의 상점 점령 완료! 이제 용병을 살 수 있다 (💰 상점)'
          : '⚠ 적이 마몬의 상점을 점령했다 — 적이 용병을 사들인다!';
        campaignAlertUntil = performance.now() + 4000;
        audio.play(sole === 0 ? 'ui_buy' : 'cast_skill', { volume: 0.9 });
      }
    }
  }
  // 캠페인: 호위전(페이로드) — 마차가 거점에 서 있는 동안 점령이 진행된다.
  // 규칙: 마차 도착 + 적 없음 → 게이지 진행 / 경합 → 일시정지 /
  //       적 단독 점유 loseSec 초 → 거점 상실, 마차는 직전 거점으로 후퇴.
  if (campaign?.escort && game && !campaignDone && !game.over) {
    const es = campaign.escort;
    const pts = es.pointsXTile;
    const dt = Math.max(0, game.tick - escortPrevTick); // 배속·프레임 드랍과 무관하게 심 틱 기준
    escortPrevTick = game.tick;
    const cart = game.entities.find((e) => e.id === escortCartId);
    let contested = false;
    let escortHudNoAllies = false; // 마차는 거점에 닿았는데 아군 부대가 없다 (HUD 안내용)
    if (escortFrontier < pts.length && cart) {
      const px = Math.floor(pts[escortFrontier]! * FP);
      const py = laneCenterY(game.map, px);
      const r = Math.floor(es.radiusTiles * FP);
      // 거점 반경 안의 양 팀 전투 유닛 (구조물·수호자·야생 제외)
      let mine = 0;
      let theirs = 0;
      for (const e of game.entities) {
        if (!e.alive || e.owner < 0) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        if (dx * dx + dy * dy > r * r) continue;
        if (e.team === 0) mine++;
        else if (e.team === 1) theirs++;
      }
      contested = theirs > 0;
      // 상실 판정: 적만 반경 안에 loseSec 초 → 마차 후퇴
      if (theirs > 0 && mine === 0) escortLoseTicks += dt;
      else escortLoseTicks = 0;
      if (escortLoseTicks >= es.loseSec * TICK_HZ) {
        escortLoseTicks = 0;
        escortProgressTicks = 0;
        // 밀고 밀리는 전선: 적이 거점을 점거하면 확보 수가 하나 줄고,
        // 적은 그 다음(우리 쪽) 거점으로 계속 밀고 내려온다.
        // 최후방(캠프 1)까지 뚫리면 적 진군 하한이 풀려 넥서스로 쏟아진다.
        if (escortFrontier > 0) {
          escortFrontier--;
          campaignAlertText = `⚠ 캠프 ${escortFrontier + 2}호를 적에게 빼앗겼다 — 전선이 밀려난다!`;
        } else {
          escortEnemyBreak = true;
          campaignAlertText = '🚨 최전방 캠프가 무너졌다 — 적이 넥서스로 쏟아진다! 캠프 1을 되찾아라!';
        }
        escortRetreatX = escortFrontier > 0
          ? Math.floor(pts[escortFrontier - 1]! * FP)
          : game.map.spawnX[0];
        game.holdLineX = Math.floor(pts[escortFrontier]! * FP) + 3 * FP;
        campaignAlertUntil = performance.now() + 4000;
        audio.play('cast_skill', { volume: 0.9 });
      }
      // 점령 진행: 마차가 거점에 서 있고 + 아군 부대가 곁에 있고 + 적이 없을 때만
      // 오른다 (마차 혼자서는 의식을 지킬 수 없다 / 경합 중엔 멈춤)
      const cdx = cart.x - px;
      const cartAt = escortRetreatX < 0 && cdx * cdx <= (2 * FP) * (2 * FP);
      escortHudNoAllies = cartAt && theirs === 0 && mine === 0;
      if (cartAt && theirs === 0 && mine > 0) {
        escortProgressTicks += dt;
        if (escortProgressTicks >= es.captureSec * TICK_HZ) {
          escortProgressTicks = 0;
          escortFrontier++;
          escortEnemyBreak = false; // 캠프를 되찾았다 — 적은 다시 전선에서 멈춘다
          if (escortFrontier >= pts.length) {
            game.holdLineX = 0; // 전선 해제 — 총공격
            campaignAlertText = '🎺 다섯 캠프를 모두 확보했다! 전군, 넥서스로 총공격!';
            // 전 거점 확보 이벤트: 네임드 등장 + 컷신 (13: 슬리피 할로우의 정체)
            if (es.onCompleteSpawn) {
              const hxRaw = game.map.nexusX[1] - 5 * FP;
              const hx = Math.max(0, hxRaw);
              const named = spawnUnit(game, es.onCompleteSpawn.defId, 1, hx, laneCenterY(game.map, hx));
              named.hp = DEFS[es.onCompleteSpawn.defId]!.maxHp;
              campaignAlertText = `${es.onCompleteSpawn.label} — 길 끝을 막아섰다! 넥서스를 파괴하라!`;
            }
            if (es.onCompleteDialogue) {
              setCutscenePause(true);
              void runDialogue(es.onCompleteDialogue).then(() => setCutscenePause(false));
            }
          } else {
            game.holdLineX = Math.floor(pts[escortFrontier]! * FP) + 3 * FP;
            campaignAlertText = `🚩 캠프 ${escortFrontier}/${pts.length} 확보! 마차가 다음 마디로 나아간다`;
          }
          campaignAlertUntil = performance.now() + 4500;
          audio.play('ui_buy', { volume: 0.9 });
        }
      }
      // 마차 이동: 후퇴 중이면 뒤로, 아니면 목표 거점으로.
      // 적이 거점을 점거 중이면(아군 없음) 반경 밖에서 멈춰 기다린다.
      const cartSpeed = Math.max(1, Math.floor((1.6 * FP * dt) / TICK_HZ)); // 1.6타일/초
      let targetX = escortRetreatX >= 0 ? escortRetreatX : px;
      if (escortRetreatX < 0 && theirs > 0 && mine === 0) targetX = Math.min(cart.x, px - r - FP);
      if (dt > 0) {
        if (cart.x < targetX) cart.x = Math.min(cart.x + cartSpeed, targetX);
        else if (cart.x > targetX) cart.x = Math.max(cart.x - cartSpeed, targetX);
        cart.y = laneCenterY(game.map, cart.x);
        if (escortRetreatX >= 0 && cart.x === escortRetreatX) escortRetreatX = -1;
      }
    }
    // 적 진군 하한: 적 부대는 현재 다툼 중인 거점에 멈춰 서서 점거를 시도한다
    // (그냥 지나쳐 우리 기지로 달려가지 않도록). 전 거점 확보 후엔 해제 — 총공세.
    game.enemyHoldLineX = escortFrontier < pts.length && !escortEnemyBreak
      ? Math.floor(pts[escortFrontier]! * FP) - 2 * FP
      : 0;
    // 거점 표시 (렌더러) + HUD
    renderer.setEscort({
      pointsX: pts.map((t) => Math.floor(t * FP)),
      radius: Math.floor(es.radiusTiles * FP),
      frontier: escortFrontier,
      progress01: Math.min(1, escortProgressTicks / (es.captureSec * TICK_HZ)),
      contested,
    });
    if (performance.now() >= campaignAlertUntil) {
      const total = pts.length;
      if (escortFrontier >= total) {
        $('#campaign-goal').textContent = `[${campaign.id}. ${campaign.title}] 🎺 전 캠프 확보 — 적 넥서스를 파괴하라!`;
      } else {
        const secLeft = Math.ceil((es.captureSec * TICK_HZ - escortProgressTicks) / TICK_HZ);
        const state = escortRetreatX >= 0 ? '↩ 마차 후퇴 중'
          : contested ? '⚔ 캠프 교전 중 — 적을 몰아내라'
          : escortProgressTicks > 0 ? `⏳ 점령 진행 — ${secLeft}초`
          : escortHudNoAllies ? '🛡 캠프에 아군 부대가 필요하다!'
          : '🛞 마차 이동 중';
        $('#campaign-goal').textContent =
          `[${campaign.id}. ${campaign.title}] 🚩 캠프 ${escortFrontier}/${total} — ${state}`;
      }
    }
  }
  // 캠페인: 전투 중 컷신 — 전투를 세우고 대사를 띄운다 (네임드 등장 연출)
  if (campaign && !campaignDone && !game.over && campaign.cutscenes && !cutscenePause) {
    const nowSec = game.tick / TICK_HZ;
    for (let i = 0; i < campaign.cutscenes.length; i++) {
      const cs = campaign.cutscenes[i]!;
      if (campaignCutsceneDone[i] || nowSec < cs.atSec) continue;
      campaignCutsceneDone[i] = true;
      setCutscenePause(true);
      void runDialogue(cs.lines).then(() => setCutscenePause(false));
      break;
    }
  }
  // 캠페인: 특수 유닛 스폰 스크립트 (적 스폰 지점에 등장 + 경고 배너)
  if (campaign && !campaignDone && !game.over && campaign.spawns) {
    const nowSec = game.tick / TICK_HZ;
    for (let i = 0; i < campaign.spawns.length; i++) {
      const rule = campaign.spawns[i]!;
      if (nowSec < campaignSpawnNext[i]!) continue;
      // 총량 상한 도달 시 이 규칙은 종료 (무한 누적 방지)
      if (rule.maxTotal !== undefined && campaignSpawnedTotal[i]! >= rule.maxTotal) {
        campaignSpawnNext[i] = Infinity;
        continue;
      }
      // 동시 생존 상한: 이미 그만큼 살아 있으면 이번 차례는 거른다 (타이머는 계속 돈다)
      if (rule.concurrentCap !== undefined) {
        let aliveNow = 0;
        for (const e of game.entities) if (e.alive && e.defId === rule.defId) aliveNow++;
        if (aliveNow >= rule.concurrentCap) {
          campaignSpawnNext[i] = rule.everySec !== undefined
            ? campaignSpawnNext[i]! + rule.everySec : Infinity;
          continue;
        }
      }
      const n = rule.count ?? 1;
      campaignSpawnedTotal[i] = campaignSpawnedTotal[i]! + n;
      const sx0 = rule.atXTile !== undefined ? Math.floor(rule.atXTile * FP) : game.map.spawnX[1];
      const yBase = laneCenterY(game.map, sx0) + Math.floor((rule.yOffTile ?? 0) * FP);
      for (let k = 0; k < n; k++) {
        // 야생 무리(neutral)는 제3팀(2) — 자기들끼리는 한 편, 플레이어·적 모두와 적대
        spawnUnit(game, rule.defId, rule.friendly ? 0 : rule.neutral ? 2 : 1, sx0, yBase + (k - (n - 1) / 2) * 600);
      }
      campaignSpawnNext[i] = rule.everySec !== undefined ? campaignSpawnNext[i]! + rule.everySec : Infinity;
      campaignAlertText = `⚠ ${rule.label} 출현!`;
      campaignAlertUntil = performance.now() + 4000;
      audio.play('cast_skill', { volume: 0.9 });
    }
  }
  // 캠페인: 확정 성장 — fromWave 턴부터 매 턴 적 봇 comp 에 +1 (캡 도달 시 멈춤).
  // 출정 직전 턴에 미리 편입해 fromWave 웨이브부터 실제로 필드에 나오게 한다.
  if (campaign && !campaignDone && !game.over && campaign.growth) {
    for (let i = 0; i < campaign.growth.length; i++) {
      const rule = campaign.growth[i]!;
      const nextWave = game.waveIndex + 1; // 지금 편입하면 이 웨이브 출정분
      if (nextWave < rule.fromWave || nextWave <= campaignGrowthWave[i]!) continue;
      campaignGrowthWave[i] = nextWave;
      // 총 편입 상한 (네임드는 1기) — 팀 합산 보유량으로 판정
      if (rule.maxCount !== undefined) {
        let have = 0;
        for (const q of game.players) if (q.team === 1) have += q.comp[rule.defId] ?? 0;
        if (have >= rule.maxCount) continue;
      }
      // 팀 합산 캡 — 가득이면 더 늘리지 않는다.
      // 캡 0 은 "봇 구매만 금지" 의미라 growth 확정 증가는 통과한다.
      // enemyCapsUntilWave 이후엔 봇 구매와 마찬가지로 상한이 사라진다.
      const capsActive = game.waveIndex < game.enemyCapsUntilWave;
      const cap = capsActive ? game.enemyUnitCaps[rule.defId] : undefined;
      if (cap !== undefined && cap > 0) {
        let owned = 0;
        for (const q of game.players) if (q.team === 1) owned += q.comp[rule.defId] ?? 0;
        if (owned >= cap) continue;
      }
      // 팀1 봇 중 편성이 가장 얇은 봇에게 — 진형이 한 봇에 몰리지 않게
      const bots = game.players.filter((q) => q.team === 1);
      let best = bots[0];
      for (const q of bots) {
        const size = (id: typeof q) =>
          Object.values(id.comp).reduce((a, b) => a + (b ?? 0), 0);
        if (best && size(q) < size(best)) best = q;
      }
      if (best) {
        best.comp[rule.defId] = (best.comp[rule.defId] ?? 0) + 1;
        if (!campaignGrowthAnnounced[i]) {
          campaignGrowthAnnounced[i] = true;
          campaignAlertText = `⚠ 적군에 ${rule.label} 합류!`;
          campaignAlertUntil = performance.now() + 4000;
          audio.play('cast_skill', { volume: 0.9 });
        }
      }
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
    if (campaign.mission === 'boss' && !game.over && campaignBossId >= 0
      && !game.entities.some((e) => e.alive && e.id === campaignBossId)) {
      campaignFinish(true);
      return;
    }
    if (campaign.mission === 'tower' && !game.over
      && !game.entities.some((e) => e.alive && e.defId === 'tower' && e.team === 1)) {
      campaignFinish(true);
      return;
    }
    // 제한 턴 초과 = 패배. 남은 턴은 목표줄에 계속 보여 준다.
    if (campaign.deadlineWave !== undefined && !game.over) {
      const leftWaves = campaign.deadlineWave - game.waveIndex;
      if (leftWaves <= 0) {
        campaignFinish(false, `제한 ${campaign.deadlineWave}턴 초과`);
        return;
      }
      if (performance.now() >= campaignAlertUntil) {
        $('#campaign-goal').textContent =
          `[${campaign.id}. ${campaign.title}] ${campaign.goal} — 남은 턴 ${leftWaves}`;
      }
    }
    if (campaign.mission === 'survive' && campaign.surviveSec !== undefined) {
      const left = campaign.surviveSec - Math.floor(game.tick / TICK_HZ);
      if (!game.over && left <= 0) {
        campaignFinish(true);
        return;
      }
      if (left > 0 && performance.now() >= campaignAlertUntil) {
        // 1턴 = 60초 — 턴 수와 시계를 함께 보여준다
        const leftTurns = Math.ceil(left / 60);
        $('#campaign-goal').textContent =
          `[${campaign.id}. ${campaign.title}] ${campaign.goal} — 남은 ${leftTurns}턴 (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`;
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

/** 캠페인 배너(#campaign-goal)가 topbar 를 가리지 않게 — 실제 높이 아래로. */
let lastGoalTop = -1;
function positionCampaignGoal(): void {
  // 세로폰에서는 topbar 가 두세 줄로 접혀 높이가 유동적이다 — 고정 px 로는
  // 배속·나가기·일시정지 버튼을 가리게 된다. 실측해서 그 아래에 붙인다.
  const bar = document.querySelector('#topbar');
  if (!bar) return;
  const top = Math.ceil(bar.getBoundingClientRect().bottom) + 6;
  if (top !== lastGoalTop) {
    lastGoalTop = top;
    ($('#campaign-goal') as HTMLElement).style.top = `${top}px`;
  }
}

function updateHud(g: Game): void {
  positionCampaignGoal();
  const me = g.players[myIdx]!;
  $('#money').textContent = String(me.money);
  $('#income').textContent = `+${MAP.INCOME_BASE + MAP.INCOME_PER_LEVEL * me.incomeLevel} / 5초 (Lv${me.incomeLevel}/${g.incomeCap})`;
  // 좁은 화면(모바일 세로)에서는 버튼 글귀를 짧게 — 길쭉한 버튼이 상점을 밀어낸다
  const narrow = window.innerWidth <= 700;
  const incBtn = $<HTMLButtonElement>('#btn-income');
  if (me.incomeLevel >= g.incomeCap) {
    incBtn.textContent = narrow ? '💰 최대' : '인컴 최대';
    incBtn.disabled = true;
  } else if (g.tick < me.incomeCooldownUntil) {
    const cdSec = Math.ceil((me.incomeCooldownUntil - g.tick) / TICK_HZ);
    incBtn.textContent = narrow ? `💰 ${cdSec}초` : `인컴 대기 ${cdSec}초`;
    incBtn.disabled = true;
  } else {
    const incCost = incomeUpgradeCost(me.incomeLevel);
    incBtn.textContent = narrow ? `💰 인컴↑ ${incCost}` : `인컴 업그레이드 (${incCost})`;
    incBtn.disabled = me.money < incCost;
  }

  const techBtn = $<HTMLButtonElement>('#btn-tech');
  if (me.techLevel >= g.techCap) {
    techBtn.textContent = narrow ? `🔬 T${me.techLevel} 최대` : `테크 ${me.techLevel} (최대)`;
    techBtn.disabled = true;
  } else if (me.techPendingUntil >= 0) {
    const sec2 = Math.ceil((me.techPendingUntil - g.tick) / TICK_HZ);
    techBtn.textContent = narrow ? `🔬 연구 ${sec2}초` : `테크 ${me.techLevel + 1} 연구 중… ${sec2}초`;
    techBtn.disabled = true;
  } else {
    const tCost = techUpCost(me.techLevel)!;
    techBtn.textContent = narrow ? `🔬 테크${me.techLevel + 1} ${tCost}` : `테크 ${me.techLevel + 1} 연구 (${tCost})`;
    techBtn.disabled = me.money < tCost;
  }

  for (const s of shopButtons) {
    const d = DEFS[s.defId]!;
    const isMerc = g.mercUnits.includes(s.defId);
    const price = isMerc ? Math.floor((d.cost * g.mercCostPct) / 100) : d.cost;
    // 타종족 용병은 테크 무관, 전속 지원군(race: null — 앨리스 병력)은 테크 필요
    const mercTechFree = isMerc && d.race !== null;
    const locked = !mercTechFree && techOfUnit(d) > me.techLevel;
    const mercLocked = isMerc && g.mercCaptureRequired && g.mercOwner !== 0;
    s.btn.disabled = locked || mercLocked || me.money < price;
    const n = me.comp[s.defId] ?? 0;
    // techOfUnit: 유닛별 techReq 오버라이드 반영 (와이번·유니콘·페어리 = 테크 3)
    s.cnt.textContent = mercLocked ? '🚩 점령 필요'
      : locked ? `🔒 테크 ${techOfUnit(d)}` : n > 0 ? `보유 ${n}` : '';
    const upsAll = visibleUpgradesOf(s.defId);
    if (upsAll.length > 0) {
      const ownedN = upsAll.filter((u) => me.upgrades[u.id]).length;
      s.upg.textContent = `⚙ ${ownedN}/${upsAll.length}`;
      s.upg.classList.toggle('owned', ownedN > 0);
    }
  }

  if (openUpgradeUnit) {
    const sig = visibleUpgradesOf(openUpgradeUnit)
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
  const elapsed = Math.floor(g.tick / TICK_HZ);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  $('#wave-label').textContent = isPrep
    ? `첫 출정까지 (전원) · ⏱${clock}`
    : `${g.waveIndex}턴 · ⏱${clock} · 다음 출정: ${nextSlot + 1}번${mySlot ? ' (나!)' : ''}`;
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
  const msg = isMp
    ? '게임에서 나가시겠습니까? 내 자리는 AI 가 이어받습니다.'
    : campaign
      ? '스테이지를 포기하고 나가시겠습니까? 진행 상황은 저장되지 않습니다.'
      : '게임을 끝내고 메뉴로 나가시겠습니까?';
  if (inGame && !confirm(msg)) return;
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


// ── 구글 로그인 · 클라우드 세이브 ─────────────────────────────────────────
/**
 * 로그인 상태에 맞춰 메뉴 상단 바를 갱신한다.
 * 로그인하면 닉네임 입력칸을 감추고 구글 계정 이름을 쓴다.
 */
function refreshAuthUi(): void {
  if (isLoggedIn()) $('#need-login').classList.add('hidden');
  const nick = $('#nickname') as HTMLInputElement;
  const p = authAvailable() ? profile() : null;
  // 오버레이의 계정 줄은 "로그인했다"는 표시 전용 — 로그인 자체는 타이틀 명패에서.
  // (로그인 기능이 꺼진 배포에서는 계속 닉네임 입력을 쓴다)
  $('#authbar').classList.toggle('hidden', !p);
  nick.style.display = p ? 'none' : '';
  if (p) {
    ($('#auth-pic') as HTMLImageElement).src = p.picture || '';
    $('#auth-name').textContent = p.name;
  }
  if (!authAvailable()) return;
  setTitleAccount(p);
}

/**
 * 로컬(이 기기)과 계정(클라우드) 진행 상황을 비교해 동기화를 묻는다.
 * 양쪽이 같거나 이미 이 세션에서 정리했으면 조용히 넘어간다.
 */
/** 이번 세션에서 "나중에"를 눌렀는가 — 눌렀으면 다시 묻지 않는다 (무한 반복 방지). */
let syncDeferred = false;

function maybeSync(serverSave: SaveData | null): Promise<void> {
  return new Promise((resolve) => {
    if (!isLoggedIn() || syncDeferred) { resolve(); return; }
    const local = localSave();
    const remote = serverSave;
    const sameProgress = remote !== null
      && remote.cleared === local.cleared
      && JSON.stringify(remote.perks) === JSON.stringify(local.perks)
      && JSON.stringify(remote.boons) === JSON.stringify(local.boons);
    if (sameProgress) { markSynced(); resolve(); return; }
    // 계정이 비어 있고 로컬만 있으면 묻지 않고 그대로 올린다 (첫 로그인)
    if (!remote || (remote.cleared === 0 && Object.keys(remote.perks).length === 0)) {
      pushSave(local);
      markSynced();
      resolve();
      return;
    }
    const modal = $('#sync-modal');
    const boonCount = (b: Record<string, string>): number => Object.keys(b).length;
    $('#sync-desc').textContent =
      `이 기기와 계정의 진행 상황이 다릅니다.

`
      + `💻 이 기기 — ${local.cleared}스테이지 클리어 · 강화 ${boonCount(local.boons)}종
`
      + `☁ 계정 — ${remote.cleared}스테이지 클리어 · 강화 ${boonCount(remote.boons)}종

`
      + `어느 쪽을 기준으로 맞출까요? (선택한 쪽으로 덮어씁니다)`;
    modal.classList.remove('hidden');
    const done = (): void => {
      modal.classList.add('hidden');
      markSynced();
      resolve();
    };
    ($('#sync-pull') as HTMLButtonElement).onclick = () => {
      applySave(remote);
      done();
    };
    ($('#sync-push') as HTMLButtonElement).onclick = () => {
      pushSave(local);
      done();
    };
    ($('#sync-skip') as HTMLButtonElement).onclick = () => {
      modal.classList.add('hidden');
      syncDeferred = true; // 이번 세션엔 다시 묻지 않는다 (새로고침하면 다시 물어봄)
      resolve();
    };
  });
}

function initAuth(): void {
  refreshAuthUi();
  // 클릭 시점에는 기다릴 틈이 없다 — 구글 스크립트와 토큰 클라이언트를 미리 만든다
  void prepareLogin((serverSave) => {
    refreshAuthUi();
    void maybeSync(serverSave);
  });
  // 이미 로그인된 채 접속: 서버에서 테스터 표식을 최신화한다
  // (화이트리스트 등록 전에 로그인했던 계정도 새로고침만으로 3막이 열리게)
  if (isLoggedIn()) void fetchSave().then(() => refreshAuthUi());
  ($('#btn-logout') as HTMLButtonElement).onclick = () => {
    logout();
    refreshAuthUi();
  };
  // 진행 상황이 바뀔 때마다 계정에 올린다 (로그인 상태일 때만)
  setProgressListener(() => {
    if (isLoggedIn()) pushSave(localSave());
  });
}

initMenu();
initAuth();
initSoundUi();
initShopToggle();
initRotateHint();
initChat();
initHotkeys();
initRoster();
void initNet();
