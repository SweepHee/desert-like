/**
 * 클라이언트 엔트리.
 *
 * 흐름: 메뉴(로비) → 방 만들기/참가 → 게임  또는  연습 게임(오프라인).
 * 멀티플레이는 결정론 동기화: 서버는 시드·좌석·명령 스트림·틱 시계만 주고,
 * 모든 클라이언트가 같은 시뮬을 로컬에서 돌린다 (전투 렌더링 지연 0).
 */
import {
  DEFS, FP, MAP, MAPS, DEFAULT_MAP, RACE_NAMES, TICK_HZ, BOONS_BY_UNIT, UPGRADES,
  effectiveDef, applyBoons, applyMods,
  createGame, stepGame, buyUnit, buyIncomeUpgrade, buyTechUp, buyUpgrade, mergeComp,
  setDeployLane,
  setDeployHold,
  findStructure, nextWaveInfo, hashGame, incomeUpgradeCost, techOfUnit, techUpCost,
  unitsOfRace, upgradesOfUnit,
  laneCenterY, clampLaneY, spawnUnit, spawnGarrison,
  type BotDifficulty, type EntityDef, type Game, type RaceId, type TeamId,
} from '@desertlike/sim';
import { assetIconUrl, createRenderer, worldToPxX, type Renderer } from './render.ts';
import {
  SYLVARIN_CAMPAIGN, PERKS, campaignCleared, markCampaignCleared, runDialogue,
  setProgressListener, localSave, applySave,
  perkAlloc, savePerkAlloc, perkPointsSpent, perksToHero,
  treeLevel, treeProgress, treeStageImg, treeAutoBonus, addTreeXp, TREE_MILESTONES,
  BOON_UNLOCKS, boonChoices, toggleBoonChoice, boonSlots, BOON_SLOT2_STAGE,
  HEROES, HERO_STORIES, heroOwnPoints, HERO_UPGRADES, HERO_UPGRADES_BY_HERO, heroAlloc, saveHeroAlloc,
  heroPointsSpent, heroUpgradesOpen, HERO_UNLOCK_STAGE, heroGroupCap, heroGroupLeft,
  HERO_DEPLOY_MAX, HERO_PICK_COOLDOWN_SEC, heroGrowth, SHARED_GROUPS,
  sharedSkillSpentOn,
  applyHeroUpgrades, kaelRetinue, kaelReviveSec, kaelReviveCharges,
  evergreenRetinue, evergreenReviveSec, evergreenReviveCharges,
  elowynRetinue, elowynReviveSec, elowynReviveCharges,
  unlockedBoonUnits, selectedBoonIds,
  deniedUnitsOf,
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
  fetchSave, pushSave, markSynced, alreadySynced, accountUid, saveOwner, setSaveOwner,
  type SaveData,
} from './auth.ts';

const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];
/** 「이제 둘까지」 안내를 한 번만 띄우기 위한 표시. */
const SLOT2_SEEN = 'camp_boon_slot2_seen';
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
      const hit = renderer.pick(game, e.clientX - rect.left, e.clientY - rect.top);
      /*
       * 두 갈래 맵: 빈 땅을 누르면 그쪽 길로 출정 방향을 바꾼다 (유닛을 눌렀으면 선택).
       *
       * 단 집합지(x 를 가진 칸 — 마을 방어전)는 제외한다. 이 판정은 y 만 보고
       * 가장 가까운 칸을 고르는데, 「1시 입구」와 「11시 입구」는 y 가 0.5타일밖에
       * 차이 나지 않아 땅을 아무 데나 눌러도 둘 사이를 오갔다. 집합지는 위쪽
       * 칸을 눌러서만 바꾼다.
       */
      // 집합지 표식(노란 원)을 직접 눌렀으면 그 자리로 모은다 — 빈 땅은 무시
      const markIdx = hit === null && campaignLanes && campaignLanes[0]?.x !== undefined
        ? renderer.pickLaneMark(e.clientX - rect.left, e.clientY - rect.top)
        : null;
      if (markIdx !== null) {
        if (markIdx !== currentLaneIdx()) chooseLaneAt(markIdx);
      } else if (hit === null && campaignLanes && campaignLanes[0]?.x === undefined) {
        // 세로 맵은 레인이 화면 가로 방향이라 x 를 넘긴다
        const vertical = !!game.map.vertical;
        const wy = renderer.pickLaneY(vertical ? e.clientX - rect.left : e.clientY - rect.top);
        let bestIdx = 0;
        for (let i = 0; i < campaignLanes.length; i++) {
          if (Math.abs(campaignLanes[i]!.y - wy) < Math.abs(campaignLanes[bestIdx]!.y - wy)) bestIdx = i;
        }
        if (bestIdx !== currentLaneIdx()) chooseLaneAt(bestIdx);
      } else {
        selectUnit(hit);
      }
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
  // 디멘터 오라 — 적 편성을 읽고 고른 네 유형 중 하나
  if (e.auraKind === 1) status.push('오라 「검푸른 장막」 — 방어력 +4 (적 1티어 원거리가 최다)');
  if (e.auraKind === 2) status.push('오라 「뻗은 손톱」 — 사거리 +1 (적 2티어 이하 판금이 최다)');
  if (e.auraKind === 3) status.push('오라 「재의 장막」 — 보호막 100, 평생 한 번뿐 (적 비행이 최다)');
  if (e.auraKind === 4) status.push('오라 「종말」 — 공속·이속 +10%, 초당 회복 1 (적 고급 이상이 최다)');
  if (e.shieldHp > 0) status.push(`보호막 ${e.shieldHp}`);
  // 마리오네타 확장 상태
  if (game.tick < e.buriedUntil) status.push('토끼굴 (땅속 — 조준·피해 불가)');
  if (game.tick < e.vanishUntil) status.push('커튼콜 (무대 밖 — 잠시 사라졌다)');
  if (e.puppetized) status.push('인형의 실 (앵리스에게 전향됨)');
  if (e.timeLocked) status.push('멈춘 시계 (영구 상태이상 면역)');
  if (game.tick < e.critUntil && e.critPct > 0) status.push(`정각의 일격 (치명타 ${e.critPct}% · 1.5배)`);
  if (game.tick < e.levitateUntil) status.push('부양 (공중 취급 — 지상 공격이 안 닿는다)');
  if (game.tick < e.hatUntil && e.hatKind > 0) {
    const HAT = ['', '빨강 모자 (태엽 병정 소환)', '파랑 모자 (공중 사거리 +1)', '거대화 모자 (평타 광역)', '황금 모자 (전부 적용!)'];
    status.push(HAT[e.hatKind] ?? '');
  }
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
  // 영웅 상세를 떠나면 모션 타이머를 끈다 (화면이 바뀌어도 계속 돌면 낭비다)
  if (heroAnimTimer) { clearTimeout(heroAnimTimer); heroAnimTimer = 0; }
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
  setRetryVisible(inGame && !!campaign);
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
  // 카드 넉 장: 종족 셋(RACES 순서 그대로) + 랜덤
  const cards = RACES.length + 1;
  RACES.forEach((race, i) => {
    const spot = document.createElement('div');
    spot.className = 'hotspot';
    spot.style.left = `${(i * 100) / cards}%`;
    spot.style.width = `${100 / cards}%`;
    spot.title = `${RACE_NAMES[race]} — ${RACE_DESC[race]}`;
    spot.onclick = () => onPick(race);
    box.appendChild(spot);
  });
  const rnd = document.createElement('div');
  rnd.className = 'hotspot';
  rnd.style.left = `${(RACES.length * 100) / cards}%`;
  rnd.style.width = `${100 / cards}%`;
  rnd.title = '랜덤 — 세 종족 중 하나가 무작위로 정해집니다';
  rnd.onclick = () => onPick(RACES[Math.floor(Math.random() * RACES.length)]!);
  box.appendChild(rnd);
  return box;
}

// ── 캠페인 ────────────────────────────────────────────────────────────────
let campaign: CampaignStage | null = null;
/** startGame 이 createGame 을 부를 때 주입되는 인컴·테크 상한. */
let campaignCaps: { incomeCap?: number; techCap?: number } | null = null;
/** 특수 유닛 스폰 규칙별 다음 발동 시각(초). Infinity = 소진. */
let campaignSpawnNext: number[] = [];
/** 이번 스테이지에서 막힌 유닛 (전역 잠금 − 스테이지별 해제). */
let campaignDenied: readonly string[] = [];
/** 두 갈래 맵의 출정 레인 후보 (없으면 레인 선택 UI 를 안 띄운다). */
/*
 * 상단 칸에 뜨는 선택지.
 *  · x 없음 = 출정 레인 (14 두 갈래 숲길) — 어디서 나올지를 고른다
 *  · x 있음 = 집합지 (6 자정의 마을) — 나온 부대가 어디로 모일지를 고른다
 * 둘 다 같은 칸·같은 조작을 쓴다.
 */
let campaignLanes: { y: number; label: string; hold?: boolean; x?: number; r?: number }[] | null = null;
/** true = 판이 열릴 때 「가운데 대기」로 시작한다 (14라운드). */
let campaignStartHold = false;
/**
 * 「가운데 대기」를 고른 상태인가.
 *
 * 예전엔 sim 의 deployHold(= 그 턴 출정 자체를 건너뛰고 모아 둔다)로 구현했는데,
 * 「대기」를 고른 판에서 내 턴에 아무도 안 나와 판이 멈춘 것처럼 보였다.
 * 지금은 출정은 매 턴 그대로 하고 야영지에 집합시킨다 — 나와서 거점을 지킨다.
 */
let campaignHold = false;
// ── 영웅 출정 (14라운드~) ──
/** 이번 판에 불러낸 영웅 defId (부른 순서). */
let heroPicked: string[] = [];
/** 다음 영웅을 부를 수 있는 시각(초). 첫 영웅은 0 = 바로. */
let heroNextPickSec = 0;
/** 이번 판에서 고를 수 있는 영웅 (스테이지의 heroPick 스폰 규칙에서 뽑는다). */
let heroPickable: string[] = [];
/** 상점 아래 칸에 지금 무엇을 띄우는가. */
let shopTab: 'unit' | 'hero' = 'unit';
let campaignSpawnedTotal: number[] = [];
/** 규칙별 「몇 번째 등장인가」 (countAdd 로 물량이 불어나는 기습용). */
let campaignSpawnFires: number[] = [];
/** 영웅 상세 화면의 모션 타이머 (화면을 떠나면 끈다). */
let heroAnimTimer = 0;
/** 카엘 「숲은 기다린다」 — 쟁여 둔 부활 횟수와 다음 충전 시각(초). */
let kaelCharges = 0;
let kaelChargeNext = -1;
/** 영웅별 부활 충전 상태 (n = 남은 충전, next = 다음 충전 시각). */
const heroCharge: Record<string, { n: number; next: number }> = {};
/** 이미 무너진 거점 슬롯 — 파괴 순간 보스를 한 번 부르고, 그쪽 증원을 끊는다. */
let campaignCampDown = new Set<number>();
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
/** 확보 거점의 「매 턴 부대」를 이미 내보낸 웨이브 (같은 턴에 두 번 나가지 않게). */
let escortSquadWave = -1;
/** 이미 배치한 거점 주둔군 (거점 index). */
const escortGarrisonDone = new Set<number>();
/** 「이미 확보한 거점」을 적이 되찾는 중인 시간 (틱). */
let escortRearLoseTicks = 0;

/**
 * 거점 주둔군 배치 — 「지금 미는 거점」과 「그 다음 거점」만 세운다.
 *
 * 예전엔 판이 시작될 때 다섯 거점 몫을 통째로 깔았다. 뒤쪽 거점을 두껍게
 * 만들자(4거점 63기·5거점 78기) 시작부터 170기가 화면에 서 있게 되어,
 * 겹침 해소가 O(n^2) 인 탓에 첫 턴부터 렉이 걸렸다.
 * 난이도는 그대로 두고 「닿기 전엔 존재하지 않게」 미룬다.
 */
function placeGarrisons(): void {
  const st = campaign;
  if (!st?.escort || !game) return;
  const gr = Math.floor((st.escort.garrisonRadiusTiles ?? 6) * FP);
  st.escort.garrisons?.forEach((list, gi) => {
    if (escortGarrisonDone.has(gi)) return;
    if (gi > escortFrontier) return;         // 아직 닿지 않았다 — 앞 거점을 확보해야 나타난다
    escortGarrisonDone.add(gi);
    const gxT = st.escort!.pointsXTile[gi];
    if (gxT === undefined) return;
    const gx = Math.floor(gxT * FP);
    const gy = laneCenterY(game!.map, gx);
    let k = 0;
    for (const item of list) {
      for (let n = 0; n < item.count; n++, k++) {
        // 거점 주위에 고르게 흩어 세운다 (같은 자리에 겹쳐 나오면 밀려난다)
        const ang = (k * 137) % 360;
        const rad = (ang * Math.PI) / 180;
        const dist = 1.2 + (k % 5) * 1.3;
        spawnGarrison(game!, item.defId, 1,
          gx + Math.floor(Math.cos(rad) * dist * FP),
          gy + Math.floor(Math.sin(rad) * dist * FP), gr);
      }
    }
  });
}

/**
 * 확보한 거점 수만큼 사람 플레이어의 인컴을 올려 준다.
 * 뺏기면 그만큼 도로 내려간다 — 확보 수만 보고 매번 다시 계산하므로
 * 「+5 했다가 빼는 걸 잊는」 실수가 생길 수 없다.
 */
function syncCaptureIncome(): void {
  if (!game) return;
  const per = campaign?.escort?.pointIncomeAdd ?? 0;
  game.captureIncomeAdd = per * escortFrontier;
}
/**
 * 아직 세우지 않은 망루 (afterCamp 가 붙은 것).
 * 「거점을 되찾아야 그 근처 망루가 되살아난다」 — 확보할 때마다 조건이 찬 것을 꺼내 세운다.
 */
interface PendingGuard { readonly defId: string; readonly xTile: number; readonly yOffTile: number; readonly afterCamp?: number }
const pendingGuards: PendingGuard[] = [];

/** 망루 하나를 세운다 (무적·제자리). */
function spawnNestGuard(ng: PendingGuard): void {
  if (!game) return;
  const gx = Math.floor(ng.xTile * FP);
  const gy = laneCenterY(game.map, gx) + Math.floor(ng.yOffTile * FP);
  const e = spawnUnit(game, ng.defId, 0, gx, gy);
  e.invulnUntil = Number.MAX_SAFE_INTEGER;
}

/** 확보한 거점 수에 맞춰 아직 안 선 망루를 세운다. 세운 개수를 돌려준다. */
function raiseGuardsFor(camps: number): number {
  let n = 0;
  for (let i = pendingGuards.length - 1; i >= 0; i--) {
    const ng = pendingGuards[i]!;
    if ((ng.afterCamp ?? 0) > camps) continue;
    spawnNestGuard(ng);
    pendingGuards.splice(i, 1);
    n++;
  }
  return n;
}
let campaignCutsceneDone: boolean[] = [];
let campaignGrowthWave: number[] = []; // 규칙별 마지막으로 편입한 웨이브 번호
let campaignGrowthAnnounced: boolean[] = [];
/** 특수 유닛 경고 배너 만료 시각 (performance.now 기준). */
let campaignAlertUntil = 0;
let campaignAlertText = '';
/** 협공 주둔지 엔티티 id (-1 = 없음) + 다음 후방 웨이브 시각(초). */
/*
 * 마을 방어전(6) 집계.
 *
 * villageSeen 은 「이미 센 주민」의 엔티티 id — 탈출로 지웠든 죽었든 두 번 세지
 * 않기 위해 남긴다. 죽은 주민은 다음 틱이면 배열에서 사라지므로, 살아 있는 동안
 * 본 적 있는 id 를 들고 있다가 사라진 시점에 사인(死因)을 판정한다.
 */
let villageDeaths = 0;
let villageEscaped = 0;
const villageSeen = new Map<number, string>();
/** 마지막으로 숲길을 정한 턴 (-1 = 아직). */
let villageWave = -1;
/** 두 번째 숲길 경고 대사를 이미 띄웠는가. */
let villageWarned = false;
/** 등장한 쿠르가의 엔티티 id (-1 = 아직). */
let villageBossId = -1;
/** 직전 프레임의 남은 집 수 — 하나 무너질 때마다 적 목표를 다시 겨눈다. */
let villageHousesSeen = -1;

/**
 * 「turn 턴에」 어느 숲길이 열리는가.
 *
 * 두 번째 길(11시)이 열리기 전에는 첫 길만 쓴다. 열리는 턴(secondLaneWave)에는
 * 곧바로 양쪽에서 들이치고, 그 뒤로는 턴을 번갈아 한쪽씩 오다가 6의 배수 턴마다
 * 다시 양쪽이 열린다. bothLanesWave 부터는 번갈아가 없다 — 매 턴 양쪽이다.
 * 「어느 쪽을 비워 둘 것인가」가 매 턴의 선택이 되게 하는 장치다.
 */
function villageLanesFor(vg: NonNullable<CampaignStage['village']>, turn: number): number[] {
  if (vg.lanes.length < 2 || turn < vg.secondLaneWave) return [0];
  if (turn >= vg.bothLanesWave) return [0, 1];
  if (turn % 6 === 0) return [0, 1];
  return [turn % 2 === 0 ? 1 : 0];
}

/**
 * 적 출정 자리를 「다음에 나올 부대」의 숲길로 옮긴다.
 *
 * 적 플레이어는 둘(slot 0·1)이고 각자 enemyCamps 자리에서 출정한다. 양쪽이
 * 열리는 턴에는 슬롯마다 다른 입구를 줘서 병력이 절반씩 갈라지고, 한쪽만
 * 열리는 턴에는 두 슬롯이 같은 길로 쏟아진다 — 그때는 길을 따라 조금 물려
 * 세운다 (같은 점에 겹쳐 두면 좁은 숲길에서 서로 밀며 통째로 막혔다).
 *
 * turn 은 「이 자리에서 나올 부대가 화면에 몇 턴으로 뜨는가」다. 출정은 턴이
 * 넘어가는 그 틱에 일어나므로, 지금 waveIndex 가 N 이면 다음 출정은 N+1 턴이다.
 */
/**
 * 「다음 턴에 어느 숲길로 오는가」를 화면에 예고한다.
 *
 * 집합지를 고르는 게 이 판의 유일한 선택인데, 어느 쪽이 열리는지 모르면
 * 매 턴이 도박이었다. 열릴 입구에서 마을 쪽으로 붉은 화살표를 흘려 준다.
 */
function applyVillageWarnings(vg: NonNullable<CampaignStage['village']>, turn: number): void {
  if (!game || !renderer) return;
  const cx = Math.floor(vg.centerXTile * FP);
  const cy = laneCenterY(game.map, cx) + Math.floor(vg.centerYOffTile * FP);
  renderer.setLaneWarnings(villageLanesFor(vg, turn).map((li) => {
    const lane = vg.lanes[li]!;
    const lx = Math.floor(lane.xTile * FP);
    return {
      x: lx,
      y: laneCenterY(game!.map, lx) + Math.floor(lane.yOffTile * FP),
      toX: cx,
      toY: cy,
      label: `⚠ ${lane.label}`,
    };
  }));
}

/** 이 숲길에 설정된 목표 (없으면 null). */
function villageLaneGoal(vg: NonNullable<CampaignStage['village']>, i: number): { x: number; y: number } | null {
  const lane = vg.lanes[i];
  if (!game || !lane || lane.goalXTile === undefined || lane.goalYOffTile === undefined) return null;
  const x = Math.floor(lane.goalXTile * FP);
  return { x, y: laneCenterY(game.map, x) + Math.floor(lane.goalYOffTile * FP) };
}

/**
 * 이 숲길이 노리는 집이 아직 남아 있는가.
 *
 * 집은 「목표가 가장 가까운 숲길」에 딸린다 — 지금 배치로는 서(11시)가 집A·집C,
 * 동(1시)이 집B·집D 다. 집을 옮기면 자동으로 다시 갈린다.
 */
function villageLaneHasPrey(vg: NonNullable<CampaignStage['village']>, i: number): boolean {
  if (!game) return false;
  const goals = vg.lanes.map((_, k) => villageLaneGoal(vg, k));
  if (!goals[i]) return false;
  for (const h of vg.houses) {
    const ent = game.entities.find((e) => e.alive && e.defId === h.defId);
    if (!ent) continue;
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < goals.length; k++) {
      const q = goals[k];
      if (!q) continue;
      const dx = ent.x - q.x;
      const dy = ent.y - q.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best === i) return true;
  }
  return false;
}

/**
 * 숲길이 「지금」 노려야 할 곳.
 *
 * 6시 길이 두 갈래라 숲길마다 다른 쪽을 물려 놨는데, 그쪽 집이 다 무너지면
 * 원래 목표는 부술 것 없는 막다른 길이 된다 — 적이 거기 쌓이기만 하고,
 * 플레이어는 그 숲길을 통째로 무시해도 아무 손해가 없는 꼼수가 생겼다.
 * 자기 쪽에 남은 집이 없으면 아직 집이 서 있는 길목으로 넘어가고,
 * 집이 하나도 없으면 주민이 빠지는 6시 길로 간다.
 */
function villageGoalNow(vg: NonNullable<CampaignStage['village']>, i: number): { x: number; y: number } | null {
  const own = villageLaneGoal(vg, i);
  if (!own || !game) return own;
  if (villageLaneHasPrey(vg, i)) return own;
  for (let k = 0; k < vg.lanes.length; k++) {
    if (k === i || !villageLaneHasPrey(vg, k)) continue;
    const alt = villageLaneGoal(vg, k);
    if (alt) return alt;
  }
  const fx = Math.floor(vg.fleeXTile * FP);
  return { x: fx, y: laneCenterY(game.map, fx) + Math.floor(vg.fleeYOffTile * FP) };
}

/**
 * 이미 나와 있는 적도 목표를 바꾼다.
 *
 * 출정할 때 찍힌 목표를 그대로 두면, 집이 무너진 뒤에도 이미 나온 부대는
 * 막다른 길에 그대로 쌓여 있다 — 집이 하나 무너질 때마다 다시 겨눈다.
 */
function retargetVillageEnemies(vg: NonNullable<CampaignStage['village']>): void {
  if (!game) return;
  const own = vg.lanes.map((_, i) => villageLaneGoal(vg, i));
  const now = vg.lanes.map((_, i) => villageGoalNow(vg, i));
  for (const e of game.entities) {
    if (!e.alive || e.team !== 1 || e.goalX < 0) continue;
    for (let i = 0; i < own.length; i++) {
      const o = own[i];
      const f = now[i];
      if (!o || !f || e.goalX !== o.x || e.goalY !== o.y) continue;
      e.goalX = f.x;
      e.goalY = f.y;
      break;
    }
  }
}

function applyVillageLanes(vg: NonNullable<CampaignStage['village']>, turn: number): void {
  if (!game) return;
  const open = villageLanesFor(vg, turn);
  for (const camp of game.enemyCamps) {
    const lane = vg.lanes[open[camp.slot % open.length]!]!;
    const lx = Math.floor(lane.xTile * FP);
    const stack = open.length === 1 ? camp.slot * 3.2 : 0;
    const c = camp as { x: number; y: number; goalX?: number | undefined; goalY?: number | undefined };
    c.x = lx;
    c.y = laneCenterY(game.map, lx) + Math.floor((lane.yOffTile + stack) * FP);
    // 이 길로 나오는 부대가 노릴 곳 (출정하는 순간 유닛에 찍힌다).
    // 자기 쪽 집이 다 무너졌으면 아직 집이 선 길목으로 넘어간다 — villageGoalNow.
    const goal = villageGoalNow(vg, open[camp.slot % open.length]!);
    if (goal) {
      c.goalX = goal.x;
      c.goalY = goal.y;
    } else {
      c.goalX = undefined;
      c.goalY = undefined;
    }
  }
}
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
    const unreleased = st.act === 3 && st.id > 14 && !act3Open(); // 14까지 전체 공개, 15+ 는 테스터만
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
  // 세계수의 축복(전역)과 유닛 강화(개별)는 한 패널로 통합됐다 — 「강화」
  const enhBtn = document.createElement('button');
  enhBtn.className = 'menubtn alt';
  const alloc0 = perkAlloc();
  const chosen0 = Object.keys(boonChoices()).filter((u) => unlockedBoonUnits().includes(u)).length;
  enhBtn.textContent = `⚔ 강화 — 🌳 Lv ${treeLevel()} · 🌿 ${Math.max(0, treeLevel() - perkPointsSpent(alloc0))}P · 유닛 ${chosen0}/${unlockedBoonUnits().length}`;
  enhBtn.onclick = () => showEnhanceScreen();
  tools.appendChild(enhBtn);
  const back = document.createElement('button');
  back.className = 'menubtn alt';
  back.textContent = '← 타이틀로';
  back.onclick = () => showScreen('title');
  tools.appendChild(back);
  wrap.appendChild(tools);
  showScreen('race-screen');
}

/** 영웅 특성 화면 — 포인트 = 클리어 수, 언제든 무료 재분배. */

/**
 * 강화 패널 — 우측 세로 탭(영웅/강화/축복)으로 나뉜다 (유닛강화패널.png 목업).
 *
 *  강화  유닛 카드 캐러셀 + [초상(모션)] [기본 능력치] [✦ 유닛 강화] 3열
 *  축복  세계수의 축복 4종 (전역) — 개편 예정
 *  영웅  준비 중 (기존 영웅 강화 화면으로 이어 준다)
 */
function showEnhanceScreen(): void {
  const wrap = $('#races');
  wrap.innerHTML = '';
  $('#race-note').classList.add('hidden');
  const total = campaignCleared();
  const alloc = perkAlloc();
  const slots = boonSlots();

  const TIER_STARS: Record<string, number> = { novice: 1, basic: 1, mid: 2, air: 2, high: 3, supreme: 4, final: 5 };
  /*
   * 별점 예외 — tier 는 전투 규칙(매혹 등급·수호자 면역)에 쓰는 값이라
   * 함부로 못 바꾼다. 상점에서 체감하는 무게만 여기서 손본다.
   *  · 나무지기: 테크 2 로 내려왔다 (high 지만 별 2개)
   *  · 와이번·유니콘·페어리: air 지만 테크 3 상급이다 (별 3개)
   */
  const STAR_FIX: Record<string, number> = {
    s_treekeeper: 2, s_wyvern: 3, s_unicorn: 3, s_fairy: 3,
  };
  const starsOf = (id: string, tier: string): number => STAR_FIX[id] ?? TIER_STARS[tier] ?? 2;
  const TIER_KO: Record<string, string> = { novice: '견습', basic: '기본', mid: '중급', air: '공중', high: '상급', supreme: '최상급', final: '최종' };
  const KIND_TILE: Record<string, string> = {
    stat: 'linear-gradient(180deg,#3e6e96,#1d3a55)',
    passive: 'linear-gradient(180deg,#5f8a3a,#2c451c)',
    active: 'linear-gradient(180deg,#a4703c,#5a381a)',
  };
  const KIND_ICO: Record<string, string> = { stat: '📊', passive: '✨', active: '⚡' };
  const KIND_BADGE: Record<string, string> = { stat: '능력치', passive: '패시브', active: '액티브' };
  const PERK_TILE: Record<string, string> = {
    sap: 'linear-gradient(180deg,#a44a3c,#5a201a)',
    thorn: 'linear-gradient(180deg,#5f8a3a,#2c451c)',
    fruit: 'linear-gradient(180deg,#b98f2e,#6a4c12)',
    season: 'linear-gradient(180deg,#3e6e96,#1d3a55)',
  };

  // 카드 목록: 해금 스테이지 순 — 아직 안 열린 유닛은 자물쇠로 미리 보여 준다
  const cardUnits: { id: string; openAt: number; open: boolean }[] = [];
  for (const [stage, ids] of Object.entries(BOON_UNLOCKS)) {
    for (const id of ids) cardUnits.push({ id, openAt: Number(stage), open: Number(stage) <= total });
  }
  cardUnits.sort((a, b) => a.openAt - b.openAt || a.id.localeCompare(b.id));
  let selected: string | null = cardUnits.find((c) => c.open)?.id ?? null;
  let filter: 'all' | 'base' | 'air' | 'elite' = 'all';
  let mode: 'hero' | 'unit' | 'perk' = 'unit';
  const openHeroes = HEROES.filter((h) => (HERO_UPGRADES_BY_HERO.get(h.id) ?? []).length > 0);
  let selectedHero: string | null = openHeroes[0]?.id ?? null;
  let heroCardsScroll = 0;
  let unitTab: 'boon' | 'trait' = 'boon';
  let heroTab: 'stat' | 'special' | 'hero' | 'skill' | 'story' = 'stat';
  // 스토리를 닫으면 보고 있던 강화 갈래로 돌아간다
  let heroTabBack: 'stat' | 'special' | 'hero' | 'skill' = 'stat';
  // 펼쳐 둔 상세 줄 (스킬·패시브·동반) — 다시 그려도 펼침이 유지된다
  const specOpen = new Set<string>();
/** 이름 뒤에 붙일 주격 조사 — 끝 글자 받침을 보고 「이 / 가」를 고른다. */
function josaIGa(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return '이';    // 한글이 아니면 무난한 쪽
  return (c - 0xac00) % 28 === 0 ? '가' : '이';
}

/** 갈래 이름 (탭·포인트 표시 공용). */
const GROUP_LABEL: Record<'stat' | 'special' | 'hero' | 'skill', string> = {
  stat: '기본', special: '특수', hero: '영웅', skill: '스킬',
};
/**
 * 영웅이 자기 몫으로 쥐는 포인트를 쓴 만큼 (특수 + 영웅 능력).
 * 스킬은 전 영웅 공용이라 여기 끼면 「이 영웅에 몇 개 남았나」가 뒤틀린다.
 */
function heroOwnSpent(hero: string, alloc: Record<string, number>): number {
  return heroPointsSpent(hero, alloc, 'special') + heroPointsSpent(hero, alloc, 'hero');
}
  // 카드 줄의 가로 스크롤 위치 — 다시 그릴 때 복원한다 (유닛을 누를 때마다
  // 맨 왼쪽으로 튕겨 돌아가던 문제)
  let cardsScroll = 0;
  // 강화·축복 목록의 스크롤 — rerender 로 DOM 을 갈아끼워도 위치를 지킨다
  let heroListScroll = 0;
  let treeScroll = 0;
  const tierGroup = (t: string): 'base' | 'air' | 'elite' =>
    t === 'air' ? 'air' : (t === 'high' || t === 'supreme' || t === 'final') ? 'elite' : 'base';

  /**
   * 초상 프레임 애니메이션 — 방향 스프라이트(동·남·서·북)를 천천히 돌고,
   * 공격(또는 부유) 프레임이 있으면 이어서 휘두른다. 없는 프레임은 미리
   * 로드해 보고 조용히 빼서 404 깜빡임이 없다.
   */
  let animTimer: number | null = null;
  /*
   * 모션 재생 세대 번호.
   *
   * startPortraitAnim 은 그림이 있는지 확인하느라 비동기로 도는데, 확인이 끝나기
   * 전에 다른 유닛을 누르면 이전 요청이 뒤늦게 깨어나 자기 setInterval 을 걸어
   * 버렸다. animTimer 는 마지막 것만 가리키므로 앞선 타이머들은 영영 안 멈추고,
   * 여럿이 같은 <img> 를 서로 다른 유닛 프레임으로 덮어썼다 (마멋·올빼미·가시마녀가
   * 섞여 보이던 증상). 영웅 탭으로 넘어가도 그 유령 타이머들이 계속 돌았다.
   *
   * 그래서 「지금 몇 번째 요청인가」를 들고 다니며, 세대가 바뀌었으면 늦게 온
   * 작업은 화면에 손대지 않고 스스로 물러난다.
   */
  let animGen = 0;
  /** 재생 중인 모션을 멈추고, 아직 안 끝난 비동기 요청까지 전부 무효화한다. */
  const stopPortraitAnim = (): void => {
    animGen++;
    if (animTimer !== null) { clearInterval(animTimer); animTimer = null; }
  };
  /**
   * 영웅 아트 파일 접두사 — 자기 그림이 없어 다른 유닛 그림을 빌려 쓰는 영웅이 있다.
   * 엘로윈은 「세이지 사본」이라 전장에서도 세이지 스프라이트로 그려진다
   * (render.ts 의 ASSET_UNITS 와 같은 매핑 — 한쪽만 고치면 카드와 전장이 어긋난다).
   */
  const ART_ALIAS: Record<string, string> = { c_elowyn: 's_sage' };
  const artId = (id: string): string => ART_ALIAS[id] ?? id;
  /**
   * 유닛 아트 캐시 버전 — 같은 파일 이름으로 그림을 갈아 끼울 때 올린다.
   * (세이지·레쉬 공격 프레임이 옛 캐릭터 것이라 다시 뽑았다 — 2026-08-23)
   * 짝이 어긋난 세트는 `node packages/client/tools/check-sprite-sets.mjs` 로 찾는다.
   */
  const ART_V = '?v=3';

  const startPortraitAnim = (id: string): void => {
    id = artId(id);
    stopPortraitAnim();
    const gen = animGen;
    const probe = (u: string): Promise<string | null> => new Promise((res) => {
      const t = new Image();
      t.onload = () => res(u);
      t.onerror = () => res(null);
      t.src = u;
    });
    void (async () => {
    // 기본 그림 없이 변형 세트만 있는 유닛(엘프 궁수 _f/_m)은 그 접두사로 찾는다.
    // 안 그러면 없는 기본 경로를 띄워 엑박이 난다.
    let prefix: string | null = null;
    for (const cand of [id, `${id}_f`, `${id}_m`]) {
      if (await probe(`/assets/units/${cand}.png`)) { prefix = cand; break; }
    }
    if (!prefix) return; // 기본 그림조차 없으면 아이콘 폴백을 그대로 둔다
    if (gen !== animGen) return; // 그 사이 다른 유닛·탭으로 옮겨 갔다
    const base = `/assets/units/${prefix}.png${ART_V}`;
    { const el = document.getElementById('eh-art') as HTMLImageElement | null; if (el) el.src = base; }
    // 정면부터 — 앞을 봤다가, 뒤를 봤다가, 옆으로 돌고, 휘두른다
    const dirs = ['s', 'n', 'e', 'w'].map((k) => `/assets/units/${prefix}_${k}.png${ART_V}`);
    const atks = [0, 1, 2, 3].map((k) => `/assets/units/${prefix}_atk${k}.png${ART_V}`);
    const flys = [0, 1, 2, 3].map((k) => `/assets/units/${prefix}_fly${k}.png${ART_V}`);
    await Promise.all([...dirs, ...atks, ...flys].map(probe)).then((got) => {
      const dir = got.slice(0, 4).filter((u): u is string => !!u);
      const atk = got.slice(4, 8).filter((u): u is string => !!u);
      const fly = got.slice(8, 12).filter((u): u is string => !!u);
      const seq: string[] = [];
      for (const u of dir.length ? dir : [base]) seq.push(u, u);   // 방향은 두 박자씩 (느긋하게)
      for (const u of atk.length ? atk : fly) seq.push(u);          // 공격·부유는 한 박자씩 (경쾌하게)
      if (gen !== animGen) return; // 프레임을 다 확인하는 사이에 바뀌었다
      const el0 = document.getElementById('eh-art') as HTMLImageElement | null;
      if (!el0) return;
      if (seq.length <= 2) { el0.src = base; return; }
      let i = 0;
      const mine = window.setInterval(() => {
        const el = document.getElementById('eh-art') as HTMLImageElement | null;
        // 세대가 바뀌었으면 내 타이머만 스스로 걷는다 (animTimer 는 이미 남의 것)
        if (!el || gen !== animGen) { clearInterval(mine); return; }
        el.src = seq[i % seq.length]!;
        i++;
      }, 250);
      animTimer = mine;
    });
    })();
  };

  /**
   * 영웅 대기 자세 — 정면(_s)을 보고 가만히 서 있는다.
   * 아트를 누르면 모션(앞·뒤·옆·공격)이 돌고, 다시 누르면 정면으로 돌아온다.
   */
  const setHeroIdle = (id0: string): void => {
    const id = artId(id0);
    stopPortraitAnim();
    const gen = animGen;
    const el = document.getElementById('eh-art') as HTMLImageElement | null;
    if (!el) return;
    const front = new Image();
    // 정면 그림 로드도 비동기다 — 늦게 끝나면 이미 다른 걸 보고 있을 수 있다
    front.onload = () => {
      if (gen !== animGen) return;
      const a = document.getElementById('eh-art') as HTMLImageElement | null;
      if (a) a.src = front.src;
    };
    front.src = `/assets/units/${id}_s.png${ART_V}`; // 없으면 기본 그림 그대로 둔다
    el.style.cursor = 'pointer';
    el.title = '눌러서 움직여 보기';
    el.onclick = () => {
      if (animTimer !== null) setHeroIdle(id0);   // 다시 누르면 정면 정지로
      else startPortraitAnim(id0);
    };
  };

  const outer = document.createElement('div');
  outer.id = 'eh-wrap';
  const panel = document.createElement('div');
  panel.id = 'eh-panel';
  const nav = document.createElement('div');
  nav.id = 'eh-nav';

  // ── 우측 세로 탭 ──
  // 「불」(선택 표시)은 각 버튼이 켜고 끄는 게 아니라 칸 뒤를 떠다니는 조각
  // 하나다 — 탭을 바꾸면 이 조각이 새 칸으로 미끄러진다.
  const navPill = document.createElement('div');
  navPill.id = 'eh-nav-pill';
  const NAV_TABS = [
    ['hero', '🛡', '영웅'],
    ['unit', '⚔', '강화'],
    ['perk', '🌿', '축복'],
  ] as const;
  const navBtns = new Map<string, HTMLButtonElement>();
  nav.appendChild(navPill);
  for (const [key, ico, name] of NAV_TABS) {
    const b = document.createElement('button');
    b.innerHTML = `<span>${ico}</span><span>${name}</span>`;
    // 영웅 탭은 13 클리어 전까지 잠겨 있다 — 눌러 보기 전에도 알아보게 자물쇠를 붙인다
    if (key === 'hero' && !heroUpgradesOpen()) {
      const lk = document.createElement('i');
      lk.className = 'eh-lock';
      lk.textContent = '🔒';
      b.appendChild(lk);
    }
    b.onclick = () => {
      if (mode === key) return;
      mode = key;
      syncNavPill(true);   // 불이 먼저 움직이고, 그 사이 내용이 바뀐다
      rerender();
    };
    navBtns.set(key, b);
    nav.appendChild(b);
  }

  /**
   * 선택 표시를 현재 탭 칸으로 옮긴다.
   * animate=false 는 화면을 처음 열 때 — 미끄러지지 않고 그 자리에 놓는다.
   */
  const syncNavPill = (animate: boolean): void => {
    for (const [k, b] of navBtns) b.classList.toggle('on', k === mode);
    const b = navBtns.get(mode);
    if (!b || b.offsetHeight === 0) return;   // 아직 화면에 붙기 전이면 나중에
    const first = !navPill.classList.contains('lit');
    if (!animate || first) navPill.style.transition = 'none';
    navPill.style.left = `${b.offsetLeft}px`;
    navPill.style.width = `${b.offsetWidth}px`;
    navPill.style.height = `${b.offsetHeight}px`;
    navPill.style.transform = `translateY(${b.offsetTop}px)`;
    navPill.classList.add('lit');
    if (!animate || first) { void navPill.offsetHeight; navPill.style.transition = ''; }
  };

  /**
   * 내용을 갈아끼우면 패널 높이가 순간 이동한다 (탭·유닛 전환 때 터덜거림).
   * 이전 높이를 재 두었다가 새 높이까지 0.28초로 미끄러뜨린다.
   */
  const rerender = (): void => {
    const h0 = panel.offsetHeight;
    renderInto();
    const h1 = panel.offsetHeight;
    if (h0 > 0 && Math.abs(h1 - h0) > 2) {
      panel.style.height = `${h0}px`;
      panel.style.overflowY = 'hidden';
      void panel.offsetHeight; // 리플로 — 시작 높이를 확정한다
      panel.style.transition = 'height .28s ease';
      panel.style.height = `${h1}px`;
      const done = (): void => {
        panel.style.transition = '';
        panel.style.height = '';
        panel.style.overflowY = '';
        panel.removeEventListener('transitionend', done);
      };
      panel.addEventListener('transitionend', done);
      window.setTimeout(done, 360);
    }
  };

  const renderInto = (): void => {
    const spent = perkPointsSpent(alloc);
    const chosenAll = boonChoices();
    panel.innerHTML = '';
    // 탭 자체는 한 번만 만들어 두고(위) 여기선 불의 위치만 맞춘다 — 매번 다시
    // 만들면 미끄러지는 도중에 조각이 사라져 애니메이션이 끊긴다.
    syncNavPill(true);

    // ── 공통 헤더 ──
    const head = document.createElement('div');
    head.id = 'eh-head';
    const TITLE: Record<string, string> = { hero: '🛡 영웅 강화', unit: '⚔ 유닛 강화', perk: '🌿 세계수의 축복' };
    head.innerHTML = `<h2>${TITLE[mode]}</h2>`;
    // 축복 포인트 칩은 축복 탭에서만 보인다 — 포인트 = 세계수 레벨
    if (mode === 'perk') {
      const pts = document.createElement('span');
      pts.id = 'perk-pts';
      pts.style.marginLeft = 'auto';
      pts.textContent = `🌿 ${Math.max(0, treeLevel() - spent)} / ${treeLevel()} P`;
      head.appendChild(pts);
    }

    panel.appendChild(head);

    if (mode === 'hero') {
      // 한 번이라도 들어와 봤으면 「열렸다」 코치마크는 더 띄우지 않는다
      try { localStorage.setItem(HERO_TAB_SEEN_KEY, '1'); } catch { /* 무시 */ }
      // ── 영웅 탭: [영웅 레일] [중앙 쇼케이스] [강화 목록] (영웅패널개편_1_1) ──
      if (!heroUpgradesOpen() || openHeroes.length === 0) {
        const box = document.createElement('div');
        box.className = 'eh-col';
        box.style.cssText = 'margin-top:10px;text-align:center;padding:34px 20px';
        box.innerHTML = '<div style="font-size:34px">🛡</div>'
          + `<div style="font-weight:bold;margin:8px 0 4px">아직 잠겨 있다</div>`
          + `<div style="color:var(--dim);font-size:12px">${HERO_UNLOCK_STAGE}스테이지를 클리어하면 영웅 강화가 열린다.</div>`;
        panel.appendChild(box);
      } else {
        const hAlloc = heroAlloc();
        const hero = openHeroes.find((h) => h.id === selectedHero) ?? openHeroes[0]!;
        const heroId = hero.id;
        const ptsLeft = heroOwnPoints() - heroOwnSpent(heroId, hAlloc);
        const base = DEFS[heroId]!;
        const curD = applyHeroUpgrades(base, heroId);
        const layout = document.createElement('div');
        layout.id = 'eh3';

        // 좌: 영웅 레일 (잠금 자리 포함)
        const rail = document.createElement('div');
        rail.id = 'eh3-rail';
        for (const h of openHeroes) {
          const leftP = heroOwnPoints() - heroOwnSpent(h.id, hAlloc);
          const el = document.createElement('div');
          el.className = 'eh3-card' + (h.id === heroId ? ' sel' : '');
          el.innerHTML =
            `<img src="/assets/units/${artId(h.id)}.png" onerror="this.onerror=null;this.src='${assetIconUrl(h.id) ?? ''}'" alt=""/>`
            + `<div class="nm">${h.name.split(' ').pop()}</div>`
            + `<div class="lv">${leftP > 0 ? `✦ ${leftP}P`
              : sharedSkillSpentOn(h.id, hAlloc) > 0 ? `⚡ ${sharedSkillSpentOn(h.id, hAlloc)}` : '완료'}</div>`;
          el.onclick = () => { selectedHero = h.id; rerender(); };
          rail.appendChild(el);
        }
        for (let k = 0; k < 2; k++) {
          const el = document.createElement('div');
          el.className = 'eh3-card lock';
          el.innerHTML = '<div style="font-size:26px;line-height:56px">🔒</div><div class="nm">잠김</div>';
          rail.appendChild(el);
        }
        layout.appendChild(rail);

        // 중앙: 쇼케이스 — 큰 이름·별·역할, 연출 아트(모션), 스탯, 포인트 게이지, 소개
        const ROLE: Record<string, string> = {
          c_kael: '전열의 방패 · 엘프 영웅',
          c_elowyn: '숲의 현자 · 엘프 영웅',
          c_evergreen: '숲의 명궁 · 엘프 영웅',
        };
        const center = document.createElement('div');
        center.id = 'eh3-center';
        // 이름을 누르면 스토리가 열린다 (안쪽 span 이 눌리는 범위 — 글자 폭만큼)
        center.innerHTML =
          `<div class="big-nm"><span class="nm-txt${HERO_STORIES[heroId] ? ' can-story' : ''}">`
          + `${hero.name.split(' ').pop()}</span></div>`
          + '<div class="stars">★★★★★★</div>'
          + `<div class="role">${ROLE[heroId] ?? '엘프 영웅'}</div>`
          + `<div class="stage-art"><img id="eh-art" src="/assets/units/${artId(heroId)}.png" onerror="this.onerror=null;this.src='${assetIconUrl(heroId) ?? ''}'" alt=""/></div>`;
        // 이름 클릭 — 우측 패널을 이 영웅의 스토리로 바꾼다
        const nmTxt = center.querySelector('.nm-txt.can-story') as HTMLElement | null;
        if (nmTxt) nmTxt.onclick = () => { heroTab = 'story'; rerender(); };

        const strip = document.createElement('div');
        strip.id = 'eh2-stats';
        // 기본치(+강화 증가분) — 유닛 강화 탭과 같은 형식
        const stat = (ic: string, lb: string, vl: string, delta?: string): void => {
          const el = document.createElement('div');
          el.className = 'st';
          el.innerHTML = `<div class="ic">${ic}</div><div class="lb">${lb}</div>`
            + `<div class="vl">${vl}${delta ? `<small class="up">(${delta})</small>` : ''}</div>`;
          strip.appendChild(el);
        };
        const dN2 = (now: number, was: number): string | undefined =>
          now !== was ? `${now > was ? '+' : ''}${now - was}` : undefined;
        stat('⚔', '공격력', `${base.weapon?.damage ?? 0}`, dN2(curD.weapon?.damage ?? 0, base.weapon?.damage ?? 0));
        stat('🛡', '방어력', `${base.armor ?? 0}`, dN2(curD.armor ?? 0, base.armor ?? 0));
        stat('❤', '체력', `${base.maxHp}`, dN2(curD.maxHp, base.maxHp));
        stat('💚', '재생/초', `${base.regenPerSec ?? 0}`, dN2(curD.regenPerSec ?? 0, base.regenPerSec ?? 0));
        stat('👣', '이동 속도', (base.speed * TICK_HZ / FP).toFixed(1),
          curD.speed !== base.speed ? `+${((curD.speed - base.speed) * TICK_HZ / FP).toFixed(1)}` : undefined);
        stat('🎯', '사거리', base.weapon ? (base.weapon.range / FP).toFixed(1) : '—',
          curD.weapon && base.weapon && curD.weapon.range !== base.weapon.range
            ? `+${((curD.weapon.range - base.weapon.range) / FP).toFixed(1)}` : undefined);
        center.appendChild(strip);

        // 포인트 게이지 (목업의 레벨 바 자리)
        const ownCap = heroOwnPoints();
        const used = ownCap - ptsLeft;
        const bar = document.createElement('div');
        bar.className = 'pts-bar';
        bar.innerHTML = '<span class="lb">✦ 강화 포인트</span>'
          + `<div class="track"><i style="width:${Math.round(used / Math.max(1, ownCap) * 100)}%"></i>`
          + `<span>${used} / ${ownCap} 사용</span></div>`;
        center.appendChild(bar);

        // 스킬·스펙 상세 — 강화 포인트 바로 아래 (강화로 바뀐 줄은 초록)
        const specBox = document.createElement('div');
        specBox.id = 'eh2-list';
        specBox.style.cssText = 'max-height:150px;text-align:left;gap:0;flex:none';
        {
          const secOf = (t: number): string => `${Math.round(t / TICK_HZ)}초`;
          /*
           * 설명이 딸린 줄은 눌러서 펼친다 (예전엔 title 툴팁이라 브라우저 기본
           * 말풍선이 떠서 볼품없었다). detail 은 HTML — 동반 목록처럼 꾸민 것도 받는다.
           */
          const spec = (label: string, now: string, changed: boolean, detail?: string): void => {
            const r = document.createElement('div');
            r.className = 'eh-stat' + (detail ? ' has-tip' : '');
            const key = `${heroId}:${label}`;
            const open = detail !== undefined && specOpen.has(key);
            r.innerHTML = `<span>${label}${detail ? `<i class="caret${open ? ' on' : ''}">▾</i>` : ''}</span>`
              + `<b${changed ? ' style="color:#9fe07a"' : ''}>${now}</b>`;
            specBox.appendChild(r);
            if (detail === undefined) return;
            const d = document.createElement('div');
            d.className = 'eh-stat-detail' + (open ? '' : ' hidden');
            d.innerHTML = detail;
            specBox.appendChild(d);
            r.onclick = () => {
              const nowOpen = d.classList.toggle('hidden');
              if (nowOpen) specOpen.delete(key); else specOpen.add(key);
              r.querySelector('.caret')?.classList.toggle('on', !nowOpen);
            };
          };
          /** 동반 유닛 목록 — 이름·수를 줄줄이 세운다. */
          const retinueDetail = (ret: readonly { defId: string; count: number }[]): string =>
            ret.map((r2) => {
              const nm = DEFS[r2.defId]?.name ?? r2.defId;
              const ic = assetIconUrl(r2.defId) ?? `/assets/units/${r2.defId}.png`;
              return `<span class="ret"><img src="${ic}" alt=""/>${nm} <b>×${r2.count}</b></span>`;
            }).join('')
            + '<div class="note">출정할 때마다 이 부대가 영웅과 함께 나간다.</div>';
          const w = curD.weapon;
          const bw = base.weapon;
          if (w && bw) {
            // 상성 추가 피해 — 비행 +25 · 언데드 +10 같은 태그 보너스 (강화로 오르면 초록)
            const TAG_KO3: Record<string, string> = {
              cloth: '천', leather: '가죽', plate: '판금', bio: '생체', undead: '언데드',
              construct: '기계', massive: '대형', structure: '건물', flying: '비행',
            };
            const bonusNow = Object.entries(w.bonus ?? {});
            if (bonusNow.length > 0) {
              const txt = bonusNow.map(([k2, v]) => `${TAG_KO3[k2] ?? k2} +${v}`).join(' · ');
              spec('💥 추가 피해', txt, JSON.stringify(w.bonus) !== JSON.stringify(bw.bonus));
            }
            if (curD.bonusVsHero) spec('👑 거물 사냥', `영웅·네임드 +${curD.bonusVsHero}`, true);
            spec('🎯 대상', w.targets === 'both' ? '지상+공중' : w.targets === 'air' ? '공중만' : '지상만', w.targets !== bw.targets);
            spec('⚡ 공격 주기', `${(w.cooldown / TICK_HZ).toFixed(2)}초`, w.cooldown !== bw.cooldown);
            const sp1 = (w as { splash?: number }).splash ?? 0;
            if (sp1 > 0) spec('💥 평타 광역', `${(sp1 / FP).toFixed(1)}타일`, sp1 !== ((bw as { splash?: number }).splash ?? 0));
            const mt1 = (w as { multiTargets?: number }).multiTargets ?? 0;
            if (mt1 > 1) spec('🏹 동시 타격', `${mt1}기`, mt1 !== ((bw as { multiTargets?: number }).multiTargets ?? 0));
          }
          if (curD.demolition) spec('🧨 데몰리션', `${(curD.demolition.radius / FP).toFixed(1)}칸 · 초${curD.demolition.dps}`, true);
          if (curD.guardShare) spec('🛡 수호', `${(curD.guardShare.radius / FP).toFixed(0)}칸 · ${curD.guardShare.pct}%`, true);
          if (curD.healTakenPct) spec('✚ 받는 회복', `+${curD.healTakenPct}%`, true);
          for (const a of curD.actives ?? []) {
            const b0 = (base.actives ?? []).find((x) => x.name === a.name);
            const bits: string[] = [];
            const du = (a as { durTicks?: number }).durTicks;
            const rf = (a as { reflectPct?: number }).reflectPct;
            if (rf !== undefined) bits.push(`${rf}%`);
            if (du !== undefined) bits.push(secOf(du));
            bits.push(`쿨${secOf(a.cooldown)}`);
            spec(`⚡ ${a.name}`, bits.join(' · '),
              b0 === undefined || JSON.stringify(a) !== JSON.stringify(b0), a.desc);
          }
          /*
           * 패시브도 액티브와 같은 꼴로 세운다 — 왼쪽에 이름, 오른쪽에 수치.
           * 예전엔 왼쪽이 ✨ 하나뿐이고 오른쪽에 「숲의 맥박 — 초당 8 회복」이
           * 통째로 들어가, 바로 위 액티브 줄들과 모양이 어긋났다.
           */
          for (const t of base.passiveDesc ?? []) {
            const cut = t.indexOf(' — ');
            if (cut > 0) spec(`✨ ${t.slice(0, cut)}`, t.slice(cut + 3), false, t);
            else spec('✨', t, false);
          }
          if (heroId === 'c_kael') {
            spec('🔁 부활', `${kaelReviveSec()}초`, kaelReviveSec() !== 100);
            const ch = kaelReviveCharges();
            if (ch > 0) spec('🔁 부활 충전', `${ch}회`, true);
            const ret = kaelRetinue();
            if (ret.length > 0) spec('🐾 동반', `${ret.reduce((n, r) => n + r.count, 0)}기`, true, retinueDetail(ret));
          }
          if (heroId === 'c_evergreen') {
            const ret = evergreenRetinue();
            if (ret.length > 0) spec('🐾 동반', `${ret.reduce((n, r) => n + r.count, 0)}기`, true, retinueDetail(ret));
            if (evergreenReviveSec() !== 170) spec('🔁 재출전', `${evergreenReviveSec()}초`, true);
            const ch = evergreenReviveCharges();
            if (ch > 0) spec('🔁 부활 충전', `${ch}회`, true);
          }
          if (heroId === 'c_elowyn') {
            spec('🔁 부활', `${elowynReviveSec()}초`, elowynReviveSec() !== 240);
            const ch = elowynReviveCharges();
            if (ch > 0) spec('🔁 부활 충전', `${ch}회`, true);
            const ret = elowynRetinue();
            if (ret.length > 0) spec('🐾 동반', `${ret.reduce((n, r) => n + r.count, 0)}기`, true, retinueDetail(ret));
          }
        }
        center.appendChild(specBox);

        // 소개 + 물리기
        const intro = document.createElement('div');
        intro.className = 'intro';
        const introTxt = document.createElement('div');
        introTxt.innerHTML = `<b>${hero.icon} ${hero.name}</b><br/>${hero.blurb}`;
        intro.appendChild(introTxt);
        const undo = document.createElement('button');
        undo.className = 'menubtn alt';
        undo.style.cssText = 'flex:none;font-size:12px;padding:8px 12px';
        undo.textContent = '↺ 물리기';
        undo.title = '이 영웅의 강화를 전부 되돌린다 (포인트 반환)';
        undo.onclick = () => {
          const a2 = heroAlloc();
          for (const u of HERO_UPGRADES_BY_HERO.get(heroId) ?? []) delete a2[u.id];
          saveHeroAlloc(a2);
          audio.play('ui_herodown', { volume: 0.8 });
          rerender();
        };
        intro.appendChild(undo);
        center.appendChild(intro);
        layout.appendChild(center);

        // 우: 탭 + 강화 목록 (행 오른쪽에 Lv 표시 + 강화 버튼 — 목업 스타일)
        const right = document.createElement('div');
        right.id = 'eh3-right';
        const tabs = document.createElement('div');
        tabs.id = 'eh2-tabs';
        for (const key of ['stat', 'special', 'hero', 'skill'] as const) {
          const name = GROUP_LABEL[key];
          const b = document.createElement('button');
          // 기본 갈래는 포인트를 안 쓴다 — 세계수의 축복이 정한 레벨을 그대로 띄운다
          const leftT = key === 'stat' ? heroGrowth() : heroGroupLeft(heroId, hAlloc, key);
          b.innerHTML = name + (leftT > 0 ? `<i class="tabpts">${leftT}</i>` : '');
          if (heroTab === key) b.classList.add('on');
          b.onclick = () => { heroTab = key; heroTabBack = key; rerender(); };
          tabs.appendChild(b);
        }
        // 스토리를 보는 동안엔 강화 갈래 탭을 감춘다 (스토리 머리의 「닫기」로 돌아온다)
        if (heroTab !== 'story') right.appendChild(tabs);

        const list = document.createElement('div');
        list.id = 'eh2-list';
        // 높이는 CSS(#eh3-right #eh2-list)가 좌측 쇼케이스와 같게 늘린다 — 인라인 고정 금지
        list.onscroll = () => { heroListScroll = list.scrollTop; };
        if (heroTab === 'story') {
          // ── 스토리 탭: 포트레이트 + 칭호·대표 대사 + 절별 서사 ──
          const st = HERO_STORIES[heroId]!;
          const box = document.createElement('div');
          box.id = 'hero-story';
          box.innerHTML =
            `<div class="top"><img src="/assets/portraits/${st.portrait}.png" alt=""/>`
            + `<div class="who"><div class="nm">${hero.name}</div>`
            + `<div class="ttl">${st.title}</div></div>`
            + '<button class="close" aria-label="닫기">✕ 닫기</button></div>'
            + `<div class="quote">「${st.quote}」</div>`
            + st.sections.map((s) => `<div class="sec"><h5>${s.h}</h5><p>${s.p}</p></div>`).join('');
          (box.querySelector('.close') as HTMLButtonElement).onclick = () => {
            heroTab = heroTabBack;
            rerender();
          };
          list.appendChild(box);
        } else {
          // 유저 제공 아이콘 시트(강화스킬아이콘 = hu_*, 세계수의축복 = bless_*)
          // 공통 스탯은 id 접두사를 뗀 뒤(c_atk 등)로도 찾는다.
          const HERO_ICON: Record<string, string> = {
            c_atk: 'bless_atk', c_arm: 'bless_def', c_hp: 'hu_hp',
            c_mv: 'bless_spd', c_as: 'hu_arrows', c_rg: 'bless_hp',
            k_splash: 'bless_star', k_air: 'hu_bow', k_regen: 'hu_wreath', k_revive: 'hu_hourglass',
            k_retinue: 'hu_retinue', k_charge: 'bless_mana', k_taunt: 'hu_taunt', k_shield: 'bless_medal',
            k_thorns: 'hu_thorns', k_demo: 'hu_target', k_guard: 'bless_crest', k_vessel: 'bless_leaf',
            k_shout: 'hu_shout',
            e_range: 'hu_longshot', e_multi: 'hu_multibow', e_type: 'hu_wingboot', e_vshero: 'hu_skull',
            e_crit: 'hu_target', e_critdmg: 'hu_pierce', e_revive: 'hu_hourglass', e_retinue: 'hu_retinue',
            e_charge: 'bless_mana', e_ward: 'bless_tree', e_flee: 'hu_flee', e_gale: 'hu_harp',
            e_frenzy: 'hu_drum', e_dance: 'hu_dance', e_veil: 'hu_veil', e_rain: 'hu_rain',
            w_revive: 'hu_hourglass', w_retinue: 'hu_retinue', w_charge: 'bless_mana',
            w_cross: 'hu_twinhand', w_cadence: 'hu_tempo', w_cycle: 'hu_mana', w_stance: 'hu_stance',
            w_blaze: 'hu_blaze', w_arcane: 'hu_charge', w_quake: 'hu_quake',
            w_bliz: 'hu_blizzard', w_meteor: 'hu_meteor',
          };
          const ups = (HERO_UPGRADES_BY_HERO.get(heroId) ?? []).filter((u) => u.group === heroTab);
          const capG = heroGroupCap(heroTab);
          const leftG = heroGroupLeft(heroId, hAlloc, heroTab);
          const shared = SHARED_GROUPS.includes(heroTab);
          const growth = heroGrowth();
          /*
           * 「기본」은 포인트로 찍지 않는다 — 세계수의 축복 「영웅의 성장」 한 번에
           * 6종이 함께 오른다 (레벨업). 그래서 여기서는 읽기만 한다.
           * 나머지 갈래는 단계 강화다 — 같은 줄에 포인트를 더 부으면 1 → 2 → 3 단계로
           * 깊어진다. 스킬 갈래의 주머니는 전 영웅 공용이고 판을 깰수록 늘어난다.
           */
          {
            const head = document.createElement('div');
            head.className = 'eh-grouppts' + (heroTab !== 'stat' && leftG > 0 ? ' has' : '');
            head.innerHTML = heroTab === 'stat'
              ? '<span>기본 능력 — 세계수의 축복이 올린다</span><b>Lv ' + growth + ' / 3</b>'
              : `<span>${GROUP_LABEL[heroTab] ?? heroTab} 포인트${shared ? ' · 전 영웅 공용' : ''}</span>`
                + `<b>${leftG} / ${capG}</b>`;
            list.appendChild(head);
            // 설명은 「기본」 갈래에만 둔다 — 이 값이 축복 탭에서 오른다는 건
            // 화면만 봐서는 알 수 없다. 특수·영웅·스킬은 줄만 봐도 읽히므로 안 붙인다.
            if (heroTab === 'stat') {
              const note = document.createElement('div');
              note.className = 'eh-groupnote';
              note.textContent = '축복 탭의 「⭐ 영웅의 성장」을 하나 사면 공격·방어·체력·이동·공속·회복이 함께 한 단계씩 오른다. 모든 영웅에게 같이 적용된다.';
              list.appendChild(note);
            }
          }
          if (ups.length === 0) {
            const none = document.createElement('div');
            none.style.cssText = 'color:var(--dim);font-size:12px;padding:14px 4px';
            none.textContent = '이 갈래의 강화는 아직 준비 중이다.';
            list.appendChild(none);
          }
          for (const u of ups) {
            const readOnly = heroTab === 'stat';
            const lv = Math.min(u.max, readOnly ? growth : (hAlloc[u.id] ?? 0));
            const canUp = !readOnly && lv < u.max && leftG > 0;
            const row = document.createElement('div');
            row.className = 'perk-row eh-boon' + (lv > 0 ? ' sel' : '') + (readOnly ? ' ro' : '');
            row.innerHTML =
              `<span class="perk-ico art">${(() => { const a = HERO_ICON[u.id] ?? HERO_ICON[u.id.slice(2)]; return a ? `<img src="/assets/ui/${a}.png" alt=""/>` : u.icon; })()}</span>`
              + `<span class="perk-body"><span class="perk-name"${lv > 0 ? ' style="color:var(--gold)"' : ''}>${u.name}`
              + `<small>${lv}/${u.max}단계</small></span>`
              + (u.desc ? `<div class="hu-what">${u.desc}</div>` : '')
              + `<div class="perk-desc">${u.steps[lv] ?? ''}</div>`
              + (canUp && u.steps[lv + 1] ? `<div class="perk-desc" style="color:#7fe08a">▲ ${u.steps[lv + 1]}</div>` : '')
              + '</span>';
            const side = document.createElement('div');
            side.className = 'perk-btns';
            side.style.flexDirection = 'column';
            side.style.alignItems = 'stretch';
            const lvEl = document.createElement('small');
            lvEl.style.cssText = `color:${lv > 0 ? 'var(--gold)' : 'var(--dim)'};font-weight:bold;text-align:center;font-size:11px;letter-spacing:1px`;
            lvEl.textContent = '●'.repeat(lv) + '○'.repeat(Math.max(0, u.max - lv));
            side.appendChild(lvEl);
            /** 단계를 올리거나 내린다. 되돌리기는 언제나 무료 — 다른 줄로 옮겨 낄 수 있다. */
            const setLv = (next: number): void => {
              const a2 = heroAlloc();
              if (next <= 0) delete a2[u.id]; else a2[u.id] = next;
              saveHeroAlloc(a2);
              audio.play(next > lv ? 'ui_heroup' : 'ui_herodown',
                { volume: next > lv ? (next >= u.max ? 0.95 : 0.7) : 0.6 });
              rerender();
            };
            if (!readOnly) {
              const plus = document.createElement('button');
              const maxed = lv >= u.max;
              plus.className = 'up' + (maxed ? ' maxed' : '');
              plus.textContent = maxed ? '최대' : '강화';
              plus.disabled = !canUp;
              plus.onclick = (e) => { e.stopPropagation(); setLv(lv + 1); };
              side.appendChild(plus);
              const minus = document.createElement('button');
              minus.textContent = '−';
              minus.title = '한 단계 되돌린다 (포인트 반환 — 무료)';
              minus.disabled = lv <= 0;
              minus.onclick = (e) => { e.stopPropagation(); setLv(lv - 1); };
              side.appendChild(minus);
            }
            row.appendChild(side);
            if (!readOnly) {
              row.onclick = () => {
                if (!canUp) { audio.play('ui_deny', { volume: 0.5 }); return; }
                setLv(lv + 1);
              };
              row.oncontextmenu = (e) => {
                e.preventDefault();
                if (lv > 0) setLv(lv - 1);
              };
            }
            list.appendChild(row);
          }
        }
        // 목록을 절대배치 래퍼에 넣는다 — 우측 목록이 행 높이에 관여하지 않아서
        // 좌측 쇼케이스가 높이를 결정하고, 넘치는 만큼은 목록 안에서 스크롤된다.
        const listWrap = document.createElement('div');
        listWrap.id = 'eh3-listwrap';
        listWrap.appendChild(list);
        right.appendChild(listWrap);
        layout.appendChild(right);
        panel.appendChild(layout);
        list.scrollTop = heroListScroll;   // 강화를 눌러도 목록이 제자리에
      }
    } else if (mode === 'perk') {
      // ── 축복 탭: [세계수 쇼케이스 + 총 효과] [강화 목록] (세계수의축복 목업) ──
      const tp = treeProgress();
      const treePts = tp.level;                    // 레벨 1 = 축복 포인트 1
      const spentT = perkPointsSpent(alloc);
      const leftT = Math.max(0, treePts - spentT);

      const sub = document.createElement('p');
      sub.id = 'eh-sub';
      sub.textContent = '세계수의 힘이 전장 전체에 축복을 내린다 — 스테이지를 클리어해 경험치를 모으고, 레벨마다 축복 포인트 1을 받는다.';
      panel.appendChild(sub);

      const wrap2 = document.createElement('div');
      wrap2.id = 'tree-wrap';

      // 좌: 세계수
      const left = document.createElement('div');
      left.id = 'tree-left';
      const stage = document.createElement('div');
      stage.id = 'tree-stage';
      stage.innerHTML = `<img src="/assets/ui/worldtree${treeStageImg()}.png" alt=""/>`
        + `<img class="medal" src="/assets/ui/bless_medal.png" alt=""/>`
        + `<div class="lvbadge">Lv. ${tp.level}${tp.cap > 0 ? ` / ${tp.cap}` : ''}</div>`;
      left.appendChild(stage);

      // 경험치 바
      const xpBox = document.createElement('div');
      xpBox.id = 'tree-xp';
      const capped = tp.level >= tp.cap;
      const pct = capped ? 100 : Math.min(100, Math.round(tp.into / tp.need * 100));
      // 다음 고비 안내
      const nextMile = TREE_MILESTONES.find(([lv]) => lv > tp.level);
      // 반복 클리어 안내는 늘 띄우지 않고 EXP 에 걸어 둔다 (마우스를 올리면 보인다)
      const xpTip = capped
        ? '상한에 닿았다 — 다음 스테이지를 클리어하면 상한이 오른다.'
        : `상한 Lv ${tp.cap}까지는 반복 클리어로 레벨업할 수 있다.`;
      xpBox.innerHTML =
        `<div class="row"><span>세계수 레벨</span><b class="xphint" title="${xpTip}">`
        + `${capped ? '최대 (다음 스테이지를 깨면 상한이 오른다)' : `EXP ${tp.into} / ${tp.need}`} ⓘ</b></div>`
        + `<div class="track"><i style="width:${pct}%"></i><span>${capped ? '' : `다음 레벨까지 EXP ${tp.need - tp.into}`}</span></div>`
        + `<div class="next">레벨마다: 시작 자금 +5 · 축복 포인트 +1${tp.level >= 10 ? ' · 수급량 +0.5%' : ''}`
        + (nextMile ? `<br/>Lv ${nextMile[0]} 고비: ${nextMile[1]}` : '') + '</div>';
      left.appendChild(xpBox);

      // 총 효과 (자동 + 포인트 합산)
      const auto = treeAutoBonus();
      const fx2 = document.createElement('div');
      fx2.id = 'tree-fx';
      const rows2: [string, string][] = [];
      const fxIco = (a: string): string => `<img class="fx-ico" src="/assets/ui/bless_${a}.png" alt=""/>`;
      const push2 = (k: string, v: number | string, suffix = ''): void => {
        if (typeof v === 'number' ? v > 0 : v !== '') rows2.push([k, `+${v}${suffix}`]);
      };
      push2(`${fxIco('gold')}시작 자금`, (alloc['fruit'] ?? 0) * 50 + auto.startMoney);
      push2(`${fxIco('gold')}5초 수입`, (alloc['season'] ?? 0) * 2);
      if (auto.incomePermille > 0) rows2.push([`${fxIco('leaf')}수급량`, `+${(auto.incomePermille / 10).toFixed(1)}%`]);
      push2(`${fxIco('hp')}유닛 체력`, (alloc['sap'] ?? 0) * 3 + auto.hpPct, '%');
      push2(`${fxIco('atk')}유닛 공격력`, (alloc['thorn'] ?? 0) * 2 + auto.dmgPct, '%');
      push2(`${fxIco('def')}유닛 방어력`, (alloc['bark'] ?? 0) + auto.armorAdd);
      push2(`${fxIco('star')}공격 속도`, (alloc['haste'] ?? 0) + auto.atkSpeedPct, '%');
      push2(`${fxIco('spd')}이동 속도`, alloc['stride'] ?? 0, '%');
      push2(`${fxIco('mana')}스킬 쿨타임`, alloc['mana'] ?? 0, '% 감소');
      push2(`${fxIco('crest')}기본 보호막`, (alloc['aegis'] ?? 0) * 10);
      if ((alloc['roots'] ?? 0) > 0 && total >= 8) push2(`${fxIco('tree')}인컴 상한`, alloc['roots'] ?? 0, '단계');
      fx2.innerHTML = '<h4>✦ 축복 총 효과</h4>'
        + (rows2.length
          ? `<div class="grid">${rows2.map(([k, v]) => `<div class="r"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`
          : '<div style="color:var(--dim);font-size:12px">아직 없다 — 오른쪽에서 포인트를 나눠 주세요.</div>');
      left.appendChild(fx2);
      wrap2.appendChild(left);

      // 우: 강화 목록
      const right = document.createElement('div');
      right.id = 'tree-right';
      const head2 = document.createElement('h3');
      head2.innerHTML = `✦ 축복 강화 목록<span class="pts">보유 축복의 잎 <img class="leaf-ico" src="/assets/ui/bless_leaf.png" alt=""/> <b>${leftT}</b> / ${treePts}P</span>`;
      right.appendChild(head2);
      const list = document.createElement('div');
      list.id = 'tree-list';
      list.onscroll = () => { treeScroll = list.scrollTop; };
      // 유저 제공 아이콘 시트(세계수의축복 목업)에서 잘라 낸 에셋 — bless_*.png
      const PERK_ICON2: Record<string, string> = {
        sap: 'bless_hp', thorn: 'bless_atk', fruit: 'bless_gold', season: 'bless_leaf',
        bark: 'bless_def', haste: 'bless_star', stride: 'bless_spd', mana: 'bless_mana',
        aegis: 'bless_crest', roots: 'bless_tree', heroLv: 'bless_herolv',
      };
      for (const pk of PERKS) {
        const n = alloc[pk.id] ?? 0;
        const lock = pk.requiresStage !== undefined && total < pk.requiresStage;
        const row = document.createElement('div');
        row.className = 'perk-row' + (lock ? ' locked' : n > 0 ? ' eh-boon sel' : '');
        const pips = Array.from({ length: pk.max }, (_, i2) => `<i class="${i2 < n ? 'on' : ''}"></i>`).join('');
        row.innerHTML =
          `<span class="perk-ico art"><img src="/assets/ui/${lock ? 'bless_lock' : PERK_ICON2[pk.id] ?? 'bless_leaf'}.png" alt=""/></span>`
          + `<span class="perk-body"><span class="perk-name"${n > 0 ? ' style="color:var(--gold)"' : ''}>${pk.name}`
          + `<small>Lv ${n}/${pk.max}</small></span>`
          + `<div class="perk-desc">${lock ? `${pk.requiresStage}스테이지를 클리어하면 해금된다` : `${pk.desc} / 포인트`}</div>`
          + `<div class="perk-pips">${pips}</div></span>`;
        const btns = document.createElement('div');
        btns.className = 'perk-btns';
        btns.style.flexDirection = 'column';
        if (!lock) {
          const plus = document.createElement('button');
          plus.className = 'up';
          plus.textContent = n >= pk.max ? '최대' : '강화';
          plus.style.minWidth = '48px';
          plus.disabled = !(n < pk.max && leftT > 0);
          plus.onclick = () => { alloc[pk.id] = n + 1; savePerkAlloc(alloc); audio.play('ui_buy', { volume: 0.6 }); rerender(); };
          const minus = document.createElement('button');
          minus.textContent = '−';
          minus.style.minWidth = '48px';
          minus.disabled = n <= 0;
          minus.onclick = () => { alloc[pk.id] = n - 1; savePerkAlloc(alloc); audio.play('ui_deny', { volume: 0.5 }); rerender(); };
          btns.appendChild(plus);
          btns.appendChild(minus);
        }
        row.appendChild(btns);
        list.appendChild(row);
      }
      right.appendChild(list);
      const reset = document.createElement('button');
      reset.className = 'menubtn alt';
      reset.style.cssText = 'font-size:12px';
      reset.textContent = '↺ 축복 초기화 (무료)';
      reset.onclick = () => { for (const pk of PERKS) alloc[pk.id] = 0; savePerkAlloc(alloc); rerender(); };
      right.appendChild(reset);
      wrap2.appendChild(right);
      panel.appendChild(wrap2);
      list.scrollTop = treeScroll;   // 강화를 눌러도 목록이 제자리에
    } else {
      // ── 강화 탭: [필터 레일 + 카드 그리드] [상세] [자원 열] (유닛패널개편_1 목업) ──
      const sub = document.createElement('p');
      sub.id = 'eh-sub';
      sub.textContent = '강화할 유닛을 선택하세요 — 스테이지를 클리어하면 유닛이 열린다. 언제든 무료로 바꿀 수 있다.';
      panel.appendChild(sub);

      const layout = document.createElement('div');
      layout.id = 'eh2';

      // 좌: 필터 레일 + 카드 그리드
      const left = document.createElement('div');
      left.id = 'eh2-left';
      const rail = document.createElement('div');
      rail.id = 'eh2-rail';
      for (const [key, name] of [['all', '전체'], ['base', '기본'], ['air', '공중'], ['elite', '정예']] as const) {
        const b = document.createElement('button');
        b.textContent = name;
        if (filter === key) b.classList.add('on');
        b.onclick = () => { filter = key; rerender(); };
        rail.appendChild(b);
      }
      left.appendChild(rail);
      const grid = document.createElement('div');
      grid.id = 'eh2-grid';
      grid.onscroll = () => { cardsScroll = grid.scrollTop; };
      for (const c of cardUnits) {
        const d0 = DEFS[c.id];
        if (!d0) continue;
        if (filter !== 'all' && tierGroup(d0.tier) !== filter) continue;
        const el = document.createElement('div');
        el.className = 'eh-card' + (c.id === selected ? ' sel' : '') + (c.open ? '' : ' lock');
        const stars = starsOf(c.id, d0.tier);
        const icon = assetIconUrl(c.id) ?? `/assets/units/${c.id}.png`;
        const nBoons = (chosenAll[c.id] ?? []).slice(0, slots).length;
        el.innerHTML =
          `<img src="${icon}" alt=""/>`
          + `<div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>`
          + `<div class="nm">${c.open ? d0.name : '???'}</div>`
          + `<div class="st">${c.open ? (nBoons > 0 ? `강화 ${nBoons}/${slots}` : '미강화') : `🔒 ${c.openAt}스테이지`}</div>`;
        if (c.open) el.onclick = () => { selected = c.id; rerender(); };
        grid.appendChild(el);
      }
      left.appendChild(grid);
      layout.appendChild(left);
      grid.scrollTop = cardsScroll;
      requestAnimationFrame(() => { grid.scrollTop = cardsScroll; });

      // 우: 상세
      const right = document.createElement('div');
      right.id = 'eh2-right';
      const d = selected ? DEFS[selected] : undefined;
      const cur = selected ? (chosenAll[selected] ?? []).slice(0, slots) : [];
      if (d && selected) {
        const stars = starsOf(selected, d.tier);
        const hd = document.createElement('div');
        hd.id = 'eh2-hero';
        hd.innerHTML =
          `<img id="eh-art" src="/assets/units/${selected}.png" onerror="this.onerror=null;this.src='${assetIconUrl(selected) ?? ''}'" alt=""/>`
          + `<div class="hd"><div class="nm">${d.name}</div>`
          + `<div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>`
          + `<div class="blurb">실바린 / ${TIER_KO[d.tier] ?? d.tier}${d.flying ? ' / 공중' : ''}${d.heal ? ' / 지원가' : ''}</div></div>`;
        right.appendChild(hd);

        // 스탯 스트립 — 고른 강화를 적용한 증가분을 (+n)으로 함께 보여준다.
        // 해금형 강화(mods 가 빈 것)는 효과를 연계 테크 업그레이드가 들고 있으므로 그것까지 합친다.
        const linkedMods = UPGRADES
          .filter((u2) => u2.unit === selected && u2.boonId && cur.includes(u2.boonId))
          .map((u2) => u2.mods);
        const dd = applyMods(applyBoons(d, cur), linkedMods);
        const atk = d.weapon?.damage ?? 0;
        const strip = document.createElement('div');
        strip.id = 'eh2-stats';
        const stat = (ic: string, lb: string, vl: string, delta?: string): void => {
          const el = document.createElement('div');
          el.className = 'st';
          el.innerHTML = `<div class="ic">${ic}</div><div class="lb">${lb}</div>`
            + `<div class="vl">${vl}${delta ? `<small class="up">(${delta})</small>` : ''}</div>`;
          strip.appendChild(el);
        };
        const dN = (now: number, was: number): string | undefined =>
          now !== was ? `${now > was ? '+' : ''}${now - was}` : undefined;
        stat('⚔', '공격력', atk > 0 ? `${atk}` : '—', dN(dd.weapon?.damage ?? 0, atk));
        stat('🛡', '방어력', `${d.armor}`, dN(dd.armor ?? 0, d.armor ?? 0));
        stat('❤', '체력', `${d.maxHp}`, dN(dd.maxHp, d.maxHp));
        stat('👣', '이동 속도', `${(d.speed * TICK_HZ / FP).toFixed(1)}`,
          dd.speed !== d.speed ? `+${((dd.speed - d.speed) * TICK_HZ / FP).toFixed(1)}` : undefined);
        stat('🎯', '사거리', d.weapon ? `${(d.weapon.range / FP).toFixed(1)}` : '—',
          dd.weapon && d.weapon && dd.weapon.range !== d.weapon.range
            ? `+${((dd.weapon.range - d.weapon.range) / FP).toFixed(1)}` : undefined);
        right.appendChild(strip);
        // 상성 추가 피해 — 언데드 +10 같은 태그 보너스. 강화로 오르거나 새로 생긴 것은 초록.
        const TAG_KO2: Record<string, string> = {
          cloth: '천', leather: '가죽', plate: '판금', bio: '생체', undead: '언데드',
          construct: '기계', massive: '대형', structure: '건물', flying: '비행',
        };
        const bBase: Record<string, number> = { ...(d.weapon?.bonus ?? {}) };
        const bNow: Record<string, number> = { ...(dd.weapon?.bonus ?? {}) };
        const bonusTxt2 = [...new Set([...Object.keys(bBase), ...Object.keys(bNow)])].map((k) => {
          const b0 = bBase[k] ?? 0;
          const n0 = bNow[k] ?? 0;
          const nm = TAG_KO2[k] ?? k;
          if (n0 === b0) return `${nm} <b style="color:#ffb163">+${b0}</b>`;
          if (b0 === 0) return `${nm} <b style="color:#7fe08a">+${n0}</b>`;
          return `${nm} <b style="color:#ffb163">+${b0}</b><b style="color:#7fe08a">(+${n0 - b0})</b>`;
        }).join(' · ');
        if (bonusTxt2) {
          const bb = document.createElement('div');
          bb.style.cssText = 'background:rgba(0,0,0,.2);border:1px solid rgba(255,246,225,.10);'
            + 'border-radius:8px;padding:6px 12px;font-size:12px;color:var(--dim)';
          bb.innerHTML = `💥 추가 피해 — ${bonusTxt2}`;
          right.appendChild(bb);
        }

        // 탭: [강화] [특성]
        const tabs = document.createElement('div');
        tabs.id = 'eh2-tabs';
        for (const [key, name] of [['boon', '강화'], ['trait', '특성']] as const) {
          const b = document.createElement('button');
          b.textContent = name;
          if (unitTab === key) b.classList.add('on');
          b.onclick = () => { unitTab = key; rerender(); };
          tabs.appendChild(b);
        }
        right.appendChild(tabs);

        const list = document.createElement('div');
        list.id = 'eh2-list';
        if (unitTab === 'boon') {
          const boons = BOONS_BY_UNIT.get(selected) ?? [];
          if (boons.length === 0) {
            const none = document.createElement('div');
            none.style.cssText = 'color:var(--dim);font-size:12px';
            none.textContent = '이 유닛의 강화는 아직 없다.';
            list.appendChild(none);
          }
          let num = 0;
          for (const b of boons) {
            num++;
            const on = cur.includes(b.id);
            const row = document.createElement('div');
            row.className = 'perk-row eh-boon eh-pick' + (on ? ' sel' : '');
            row.innerHTML =
              `<span class="eh2-num">${on ? '✔' : num}</span>`
              + `<span class="perk-ico boon-ico" style="background:${KIND_TILE[b.kind] ?? 'var(--gl-btn)'}">`
              + `<img src="/assets/boons/${b.id}.png" alt="" loading="lazy"`
              + ` onerror="this.remove();this.parentNode.textContent='${KIND_ICO[b.kind] ?? '✦'}'"/></span>`
              + `<span class="perk-body"><span class="perk-name"${on ? ' style="color:var(--gold)"' : ''}>${b.name}`
              + `<small>${KIND_BADGE[b.kind] ?? ''}</small></span>`
              + `<div class="perk-desc">${b.desc}</div></span>`;
            const btns = document.createElement('div');
            btns.className = 'perk-btns';
            const pick = document.createElement('button');
            pick.className = 'pick' + (on ? '' : ' up');
            pick.textContent = on ? '해제' : '선택';
            btns.appendChild(pick);
            row.appendChild(btns);
            row.onclick = () => {
              if (!selected) return;
              toggleBoonChoice(selected, b.id);
              audio.play('ui_buy', { volume: 0.6 });
              rerender();
            };
            list.appendChild(row);
          }
        } else {
          // 특성 탭 — 패시브·액티브 설명
          const lines: [string, string][] = [];
          for (const t of d.passiveDesc ?? []) lines.push(['✨ 패시브', t]);
          for (const a of d.actives ?? []) lines.push([`⚡ ${a.name}`, a.desc]);
          if (d.heal) lines.push(['✚ 치유', '아군을 지속 회복한다']);
          if (lines.length === 0) lines.push(['—', '특성이 없는 유닛이다.']);
          for (const [k, v] of lines) {
            const r = document.createElement('div');
            r.className = 'eh-stat';
            r.style.cssText = 'align-items:flex-start;gap:10px';
            r.innerHTML = `<span style="flex:none">${k}</span><b style="font-weight:normal;text-align:right;word-break:keep-all">${v}</b>`;
            list.appendChild(r);
          }
        }
        right.appendChild(list);
      } else {
        const none = document.createElement('div');
        none.className = 'eh-col';
        none.style.cssText = 'text-align:center;padding:40px 0;color:var(--dim)';
        none.textContent = '유닛을 선택하세요';
        right.appendChild(none);
      }
      layout.appendChild(right);

      // 자원 열
      const res = document.createElement('div');
      res.id = 'eh2-res';
      // 이 유닛의 이력: 어느 스테이지에서 손에 넣었고, 강화는 언제 열렸나
      const acquiredAt = selected
        ? (SYLVARIN_CAMPAIGN.find((st) => (st.allowedUnits as readonly string[]).includes(selected!))?.id ?? null)
        : null;
      const boonAt = selected ? (cardUnits.find((c) => c.id === selected)?.openAt ?? null) : null;
      const box1 = document.createElement('div');
      box1.className = 'box';
      box1.innerHTML = '<h4>보유</h4>'
        + `<div class="r"><span>강화 슬롯</span><b>유닛당 ${slots}</b></div>`
        + (acquiredAt !== null ? `<div class="r"><span>획득</span><b>${acquiredAt}스테이지</b></div>` : '')
        + (boonAt !== null ? `<div class="r"><span>강화 해금</span><b>${boonAt}스테이지</b></div>` : '');
      res.appendChild(box1);
      layout.appendChild(res);
      panel.appendChild(layout);
    }

    // ── 푸터 ──
    const foot = document.createElement('div');
    foot.id = 'perk-foot';
    const back = document.createElement('button');
    back.className = 'menubtn';
    back.innerHTML = '<span class="arw">←</span><span>캠페인으로</span>';
    back.onclick = () => { stopPortraitAnim(); showCampaignSelect(); };
    foot.appendChild(back);
    panel.appendChild(foot);

    // 유닛 탭은 자동으로 돌고, 영웅 탭은 정면으로 서 있다가 누르면 움직인다
    if (mode === 'unit' && selected) startPortraitAnim(selected);
    else if (mode === 'hero' && selectedHero) setHeroIdle(selectedHero);
    else stopPortraitAnim();
  };
  rerender();
  outer.appendChild(panel);
  outer.appendChild(nav);
  wrap.appendChild(outer);
  showScreen('race-screen');
  // 화면에 붙기 전에는 칸 크기를 잴 수 없다 — 붙은 다음 불을 제자리에 놓는다
  syncNavPill(false);
  requestAnimationFrame(() => {
    syncNavPill(false);
    showHeroCoach(navBtns.get('hero'));
  });
}

/**
 * 코치마크 — 「영웅」 탭 옆에 한 번 떠서 알려 준다. 두 갈래다:
 *  · 아직 잠겨 있으면 → 해금 조건 (13스테이지 클리어)
 *  · 열렸는데 한 번도 안 들어가 봤으면 → 「열렸다, 여기서 찍는다」
 * 어느 쪽이든 한 번 닫으면 다시 뜨지 않는다. 탭에 들어가 보면 그것으로도 꺼진다.
 */
const HERO_COACH_KEY = 'dl_coach_hero';
const HERO_TAB_SEEN_KEY = 'dl_hero_tab_seen';
function showHeroCoach(btn: HTMLButtonElement | undefined): void {
  if (!btn) return;
  const open = heroUpgradesOpen();
  // 열린 뒤엔 「한 번도 안 들어가 본 사람」에게만
  const key = open ? HERO_TAB_SEEN_KEY : HERO_COACH_KEY;
  try { if (localStorage.getItem(key) === '1') return; } catch { return; }
  const r = btn.getBoundingClientRect();
  if (r.width === 0) return;   // 아직 화면에 안 붙었다
  const tip = document.createElement('div');
  tip.className = 'coachmark';
  tip.innerHTML = (open
    ? '<b>🛡 영웅 강화 해금!</b><br/>확인해 보자.'
    : `<b>🛡 영웅 강화</b><br/>${HERO_UNLOCK_STAGE}스테이지를 클리어하면 열린다.`)
    + '<div class="cm-ok">알겠다</div>';
  document.body.appendChild(tip);
  const w = 250;
  tip.style.width = `${w}px`;
  // 탭은 패널 오른쪽 세로줄이다 — 왼쪽에 붙이고, 자리가 없으면 아래로 내린다
  const left = r.left - w - 14;
  tip.style.left = `${left > 8 ? left : Math.max(8, r.left - w / 2)}px`;
  tip.style.top = `${Math.max(8, r.top - 18)}px`;
  const close = (): void => {
    tip.remove();
    try { localStorage.setItem(key, '1'); } catch { /* 무시 */ }
  };
  (tip.querySelector('.cm-ok') as HTMLElement).onclick = close;
  // 탭을 바로 눌러 들어가도 코치마크는 제 할 일을 다한 것이다
  btn.addEventListener('click', close, { once: true });
}

/** 유닛 강화 화면 — 스테이지 클리어로 개방, 유닛당 3택 1. 언제든 무료 재선택. */


/** 캠페인은 같은 판을 몇 번이고 다시 두는 게 정상이라 재도전을 꺼내둔다. */
function setRetryVisible(on: boolean): void {
  ($('#btn-retry') as HTMLElement).style.display = on ? '' : 'none';
}

async function startCampaignStage(st: CampaignStage): Promise<void> {
  if (st.act === 3 && st.id > 14 && !act3Open()) { showCampaignSelect(); return; } // 15+ 는 테스터 전용
  showScreen(null);
  await runDialogue(st.briefing);
  campaign = st;
  campaignDone = false;
  setRetryVisible(true);
  // 팀 0 = 나(실바린) + 아군 봇, 팀 1 = 적 봇. 시드 고정 — 같은 판은 같은 전개.
  const players = [
    { race: 'sylvarin' as RaceId, isBot: false, team: 0 as TeamId },
    ...st.allies.map((race) => ({ race, isBot: true, team: 0 as TeamId })),
    ...st.enemies.map((race) => ({ race, isBot: true, team: 1 as TeamId })),
  ];
  // 14스테이지까지는 4티어 유닛도, 4티어 업그레이드도 로스터에 없다 —
  // 테크 3 을 상한으로 못 박아 쓸모없는 연구에 돈이 새지 않게 한다.
  // (스테이지가 더 낮은 상한을 정해 뒀으면 그쪽을 따른다)
  const stageTechCap = st.id <= 14 ? Math.min(st.techCap ?? 3, 3) : st.techCap;
  campaignCaps = {
    ...(st.noTowers ? { noTowers: true } : {}),
    ...(st.nexusArmor !== undefined ? { nexusArmor: st.nexusArmor } : {}),
    ...(st.incomeCap !== undefined ? { incomeCap: st.incomeCap } : {}),
    ...(stageTechCap !== undefined ? { techCap: stageTechCap } : {}),
    ...(st.enemyPreferredUnits ? { enemyPreferredUnits: st.enemyPreferredUnits } : {}),
    ...(st.enemyUnitCaps ? { enemyUnitCaps: st.enemyUnitCaps } : {}),
    ...(st.allyUnitCaps ? { allyUnitCaps: st.allyUnitCaps } : {}),
    ...(st.enemyAllowedUnits ? { enemyAllowedUnits: st.enemyAllowedUnits } : {}),
    ...(st.enemyStartMoney !== undefined ? { enemyStartMoney: st.enemyStartMoney } : {}),
    ...(st.enemyStartTech !== undefined ? { enemyStartTech: st.enemyStartTech } : {}),
    ...(st.enemyBasicCutoffWave !== undefined ? { enemyBasicCutoffWave: st.enemyBasicCutoffWave } : {}),
    enemyDeniedUnits: deniedUnitsOf(st),
    campaignMode: true, // 캠페인에서 봉인된 스킬·해금을 가린다
    ...(st.enemyCamps ? { enemyCamps: st.enemyCamps } : {}),
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
  campaignDenied = deniedUnitsOf(st);
  // 맵에서도 고를 수 있게 「가운데 대기」를 가운데 선택지로 끼워 넣는다
  campaignLanes = st.deployLanes
    ? [
      ...st.deployLanes.filter((l) => l.yTile < 0).map((l) => ({ y: Math.round(l.yTile * FP), label: l.label })),
      { y: 0, label: '가운데 대기', hold: true },
      ...st.deployLanes.filter((l) => l.yTile >= 0).map((l) => ({ y: Math.round(l.yTile * FP), label: l.label })),
    ]
    : st.village
      ? st.village.rallyPoints.map((r) => ({
        x: Math.round(r.xTile * FP), y: Math.round(r.yOffTile * FP), label: r.label,
        r: Math.round((st.village!.rallyRadiusTiles ?? 1.2) * FP),
      }))
      : null;
  campaignStartHold = !!st.deployStartHold;
  campaignHold = false;
  // 두 갈래 맵·마을 방어전에서만 상단 선택 칸을 띄운다
  const laneBtn = document.getElementById('btn-lane');
  if (laneBtn) laneBtn.style.display = campaignLanes ? 'flex' : 'none';
  campaignSpawnNext = (st.spawns ?? []).map((r) => (
    // 영웅 출정: 플레이어가 상점 영웅 탭에서 부르기 전엔 잠들어 있다
    r.heroPick ? Infinity
      : r.onCampDown !== undefined ? Infinity
        : r.atSec ?? (r.fromSec !== undefined ? r.fromSec : r.everySec) ?? Infinity
  ));
  // 이번 판에 부를 수 있는 영웅 (스폰 스크립트가 정한다) — 없으면 영웅 탭도 안 뜬다
  heroPickable = (st.spawns ?? []).filter((r) => r.heroPick).map((r) => r.defId);
  heroPicked = [];
  heroNextPickSec = 0;
  shopTab = 'unit';
  campaignCampDown = new Set<number>();
  campaignSpawnedTotal = (st.spawns ?? []).map(() => 0);
  campaignSpawnFires = (st.spawns ?? []).map(() => 0);
  campaignCaptureStartTick = -1;
  campaignBossId = -1;
  escortFrontier = 0;
  escortProgressTicks = 0;
  escortLoseTicks = 0;
  escortCartId = -1;
  escortRetreatX = -1;
  escortPrevTick = 0;
  escortEnemyBreak = false;
  escortSquadWave = -1;
  escortGarrisonDone.clear();
  for (const k of Object.keys(heroCharge)) delete heroCharge[k];
  escortRearLoseTicks = 0;
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
  /*
   * 두 갈래 맵의 시작 상태.
   * deployStartHold 를 단 판(14라운드)은 「가운데 대기」로 연다 — 길을 고르기 전엔
   * 첫 턴부터 무작정 나가지 않는다. 아니면 첫 갈래를 골라 둔다 (고른 칸이 없는
   * 어정쩡한 상태를 만들지 않는다 — 그러면 어느 칸에도 불이 안 들어온다).
   */
  if (game && campaignLanes) {
    if (campaignStartHold) { campaignHold = true; setHoldRally(true); }
    else {
      const first = campaignLanes.find((l) => !l.hold);
      if (first) setDeployLane(game, first.y);
    }
  }
  syncLaneBtn();
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
  if (st.noNexus && game) {
    // 마을 방어전: 지킬 넥서스가 없다. 양 팀 넥서스를 걷어내고 보호막도 푼다.
    game.entities = game.entities.filter((e) => e.defId !== 'nexus');
    game.guardianDown = [true, true];
  }
  villageDeaths = 0;
  villageEscaped = 0;
  villageSeen.clear();
  villageWave = -1;
  villageWarned = false;
  villageBossId = -1;
  villageHousesSeen = -1;
  // 마을 방어전이 아니면 적 진입 예고는 지운다 (판을 옮겨도 남아 있으면 안 된다)
  renderer?.setLaneWarnings(null);
  if (st.village && game) {
    const vg = st.village;
    const at = (xTile: number, yOff: number): { x: number; y: number } => {
      const x = Math.floor(xTile * FP);
      return { x, y: laneCenterY(game!.map, x) + Math.floor(yOff * FP) };
    };
    // 마을 집 네 채 — 우리 편 건물이지만 무장이 없다. 순수 목표물.
    for (const h of vg.houses) {
      const q = at(h.xTile, h.yOffTile);
      spawnUnit(game, h.defId, 0, q.x, q.y);
    }
    /*
     * 마을 수비대 — 두 입구를 지킨다.
     *
     * homeX/homeY 가 박히면 진군하지 않고, 싸우다 밀려나도 제자리로 돌아오며,
     * 플레이어의 집합지 지정에도 따라가지 않는다 (내 부대가 아니다).
     */
    for (const gr of vg.garrisons) {
      for (let i = 0; i < gr.count; i++) {
        const q = at(gr.xTile + (i % 3) * 0.6, gr.yOffTile + Math.floor(i / 3) * 0.6);
        const e = spawnUnit(game, gr.defId, 0, q.x, q.y);
        e.homeX = q.x;
        e.homeY = q.y;
      }
    }
    // 적은 넥서스가 아니라 마을 한복판을 치러 온다
    const c = at(vg.centerXTile, vg.centerYOffTile);
    game.foeGoalX = c.x;
    game.foeGoalY = c.y;
    // 주민은 6시 길로 빠진다
    const f = at(vg.fleeXTile, vg.fleeYOffTile);
    game.fleeX = f.x;
    game.fleeY = f.y;
    // 내 부대 기본 집합지 = 1시 입구 (rallyPoints[0])
    const r0 = vg.rallyPoints[0];
    if (r0) {
      const q = at(r0.xTile, r0.yOffTile);
      game.rallyX = q.x;
      game.rallyY = q.y;
    }
    applyVillageLanes(vg, 1); // 첫 출정은 1턴
    applyVillageWarnings(vg, 1);
    /*
     * 상단 집합지 칸을 다시 그린다.
     *
     * 판을 세울 때 syncLaneBtn 은 이 블록보다 먼저 한 번 돈다. 그때는 아직
     * rallyX 가 0 이라 「어느 칸이 켜져 있는가」가 -1 이 되어, 기본 집합지인
     * 1시 입구에 불이 안 들어온 채로 시작했다 (부대는 그리로 가는데도).
     */
    syncLaneBtn();
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
  // 호위전: 거점을 확보해야 세워지는 망루 (afterCamp). 확보 때마다 여기서 꺼내 쓴다.
  pendingGuards.length = 0;
  // 거점 인컴 가산을 지금 확보 수에 맞춘다 (뺏기면 자동으로 줄어든다)
  syncCaptureIncome();
  if (st.escort && game) {
    // 보급 마차: 아군 진영에서 출발. 무적 — 호위 실패는 「거점 상실」로만 표현된다
    const cx0 = game.map.spawnX[0];
    const cart = spawnUnit(game, st.escort.cartDefId, 0, cx0, laneCenterY(game.map, cx0));
    cart.invulnUntil = Number.MAX_SAFE_INTEGER;
    escortCartId = cart.id;
    // 아군 부대는 첫 거점 언저리까지만 진군해 대기
    game.holdLineX = Math.floor(st.escort.pointsXTile[0]! * FP) + 2 * FP;
    // 부대 집결 지점 = 지금 점령할 거점. 마차와 같은 길로 거점을 들르게 한다.
    game.rallyX = Math.floor(st.escort.pointsXTile[0]! * FP);
    game.rallyY = laneCenterY(game.map, game.rallyX);
    // 거점 주둔군: 처음부터 눌러앉아 있다. 진군하지 않고 그 자리를 지킨다 —
    // 밀어내지 않으면 점령 게이지가 오르지 않는다.
    placeGarrisons();
  }
  if (st.nestGuards && game) {
    // 둥지 수호탑: 아군 고정 수호수 — 무적 + 제자리 (speed 0).
    // afterCamp 가 붙은 망루는 그 거점을 확보해야 세워진다 (아래 호위전 로직에서).
    for (const ng of st.nestGuards) {
      if (ng.afterCamp !== undefined) { pendingGuards.push(ng); continue; }
      spawnNestGuard(ng);
    }
  }
  if (st.enemyCamps && game) {
    // 거점 주둔지: 부수면 그 거점의 증원이 끊기는 건물.
    // 소유자는 그 슬롯을 맡은 적 플레이어라 sim 이 「누구 거점인지」 알 수 있다.
    for (const camp of st.enemyCamps) {
      if (!camp.nexusDefId || camp.x === undefined || camp.y === undefined) continue;
      const owner = game.players.findIndex((pl) => pl.team === 1 && pl.slot === camp.slot);
      if (owner < 0) continue;
      const st2 = spawnUnit(game, camp.nexusDefId, 1, camp.x, camp.y);
      st2.owner = owner; // 이 주둔지가 어느 거점 것인지 (부서지면 그 거점 증원이 끊긴다)
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
  if (win) {
    markCampaignCleared(st.id);
    // 세계수 경험치 — 클리어했을 때만 자란다 (패배는 0)
    const grow = addTreeXp(st.id);
    if (grow.levelAfter > grow.levelBefore) {
      showToast(`🌳 세계수가 자랐다 — Lv ${grow.levelAfter}! 축복 포인트 +${grow.levelAfter - grow.levelBefore}`);
    } else {
      showToast(`🌳 세계수 경험치 +${grow.gained}`);
    }
  }
  const showEnd = (): void => {
    const overlay = $('#overlay');
    const isLast = st.id === SYLVARIN_CAMPAIGN.length;
    const newBoonUnits = win ? (BOON_UNLOCKS[st.id] ?? []) : [];
    // 2막을 끝내면 유닛마다 강화를 둘까지 고를 수 있게 된다
    const slotOpened = win && st.id === BOON_SLOT2_STAGE;
    const nextSt = SYLVARIN_CAMPAIGN.find((x) => x.id === st.id + 1);
    const nextUnreleased = nextSt !== undefined && nextSt.act === 3 && nextSt.id > 14 && !act3Open(); // 15+ 테스터 전용
    // 남은 축복 포인트 — 방금 세계수가 자랐으면 여기서 바로 보인다
    const perkLeft = Math.max(0, treeLevel() - perkPointsSpent(perkAlloc()));
    overlay.innerHTML =
      `<h1>${win ? '스테이지 클리어!' : `패배… (${turnAt}턴)`}</h1>` +
      `<p>${st.id}. ${st.title}${reason ? ` — ${reason}` : ''}</p>` +
      (newBoonUnits.length > 0
        ? `<p style="color:var(--gold)">⚔ 새 유닛 강화 개방 — ${newBoonUnits.map((u) => DEFS[u]!.name).join(' · ')}! 캠페인 화면에서 골라 보자.</p>` : '') +
      (slotOpened
        ? `<p style="color:var(--gold)">🌿 세계수가 깊어졌다 — 이제 유닛마다 <b>강화를 둘까지</b> 고를 수 있다!</p>` : '') +
      (win && nextUnreleased ? `<p style="color:var(--dim)">🚧 3막은 준비 중입니다 — 곧 공개!</p>` : '') +
      `<div class="menurow">` +
      (win && !isLast && !nextUnreleased
        ? `<button id="camp-next" class="menubtn">다음 스테이지 ▶</button>` : '') +
      (!win ? `<button id="camp-retry" class="menubtn">다시 도전</button>` : '') +
      // 클리어·패배 직후가 강화를 손볼 가장 좋은 순간이다 — 목록까지 안 나가도 여기서 바로 연다
      `<button id="camp-enh" class="menubtn alt">⚔ 강화${perkLeft > 0 ? ` — 🌿 ${perkLeft}P` : ''}</button>` +
      `<button id="camp-menu" class="menubtn alt">캠페인 목록으로</button>` +
      `</div>`;
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
    const enh = document.querySelector('#camp-enh') as HTMLButtonElement | null;
    if (enh) enh.onclick = () => {
      sessionStorage.setItem('camp_auto', 'enhance');
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
  // 결과 화면에서 「강화」로 나왔다 — 강화 패널을 바로 연다 (뒤로가기는 캠페인 목록)
  if (auto === 'enhance') {
    showEnhanceScreen();
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
/** 연습 게임의 팀 인원 (1:1 ~ 3:3). 심은 teamSize 로 이미 가변을 지원한다. */
let soloTeamSize: 1 | 2 | 3 = 3;
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
  note.textContent = `${soloTeamSize}:${soloTeamSize} 오프라인 대전 — 종족을 고르면 바로 시작합니다. 나머지 자리는 AI 가 맡아요.`;
  wrap.appendChild(note);
  // 팀 인원 토글 — 인원이 적을수록 출정 주기가 빨리 돌아온다
  const sizeRow = document.createElement('div');
  sizeRow.className = 'menurow';
  for (const n of [1, 2, 3] as const) {
    const b = document.createElement('button');
    b.className = 'menubtn' + (n === soloTeamSize ? '' : ' alt');
    b.textContent = `${n} : ${n}`;
    b.title = n === 1 ? '1대1 — 매 턴 내 부대가 나간다'
      : n === 2 ? '2대2 — 두 턴에 한 번 내 차례'
      : '3대3 — 세 턴에 한 번 내 차례 (기본)';
    b.onclick = () => {
      soloTeamSize = n;
      showSoloRaceSelect();
    };
    sizeRow.appendChild(b);
  }
  wrap.appendChild(sizeRow);
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
    // 고른 인원으로 양 팀을 채운다. 내 자리는 어느 팀이 될지 무작위.
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) | 0;
    const size = soloTeamSize;
    const idx = Math.random() < 0.5 ? 0 : size;
    const players = Array.from({ length: size * 2 }, (_, i) => ({
      race: i === idx ? race : RACES[Math.floor(Math.random() * 3)]!,
      isBot: i !== idx,
      team: (i < size ? 0 : 1) as TeamId,
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
  syncShopTabs();
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

// ── 영웅 출정 칸 (14라운드~) ───────────────────────────────────────────────
/*
 * 영웅은 이제 스크립트로 저절로 나오지 않는다 — 여기서 직접 부른다.
 * 부르는 순간 야영지에서 나서고, 그 뒤론 쓰러져도 알아서 다시 온다 (부활).
 * 다음 영웅까지는 5분 — 그래서 「누구를 먼저 부를까」가 판의 첫 결정이 된다.
 */
/** 지금 게임 시각(초). 스폰 스크립트가 쓰는 시계와 같은 것. */
function campNowSec(): number {
  return game ? game.tick / TICK_HZ : 0;
}

/** 이 영웅의 부활 주기(초) — 강화가 줄여 준 값. */
function heroReviveSec(defId: string): number {
  return defId === 'c_kael' ? kaelReviveSec()
    : defId === 'c_evergreen' ? evergreenReviveSec()
      : defId === 'c_elowyn' ? elowynReviveSec() : 0;
}

/** 영웅 출정 — 스폰 규칙을 깨워 지금 즉시 야영지에서 나서게 한다. */
function callHero(defId: string): void {
  if (!game || !campaign) return;
  if (heroPicked.includes(defId)) return;
  if (heroPicked.length >= HERO_DEPLOY_MAX) return;
  const now = campNowSec();
  if (now < heroNextPickSec) { audio.play('ui_deny', { volume: 0.5 }); return; }
  const idx = (campaign.spawns ?? []).findIndex((r) => r.heroPick && r.defId === defId);
  if (idx < 0) return;
  heroPicked.push(defId);
  campaignSpawnNext[idx] = now;           // 다음 프레임에 스폰 드라이버가 세운다
  heroNextPickSec = now + HERO_PICK_COOLDOWN_SEC;
  audio.play('ui_heroup', { volume: 0.95 });
  const name = HEROES.find((h) => h.id === defId)?.name ?? DEFS[defId]?.name ?? defId;
  showToast(heroPicked.length >= HERO_DEPLOY_MAX
    ? `⚔ ${name} 참전! — 영웅 ${HERO_DEPLOY_MAX}명을 모두 불렀다`
    : `⚔ ${name} 참전! — 다음 영웅까지 ${HERO_PICK_COOLDOWN_SEC}초`);
  buildHeroShop();
}

/** 영웅 칸을 처음부터 다시 짓는다 (판이 열릴 때·영웅을 부른 뒤). */
function buildHeroShop(): void {
  const box = document.getElementById('hero-shop');
  if (!box) return;
  box.innerHTML = '';
  if (heroPickable.length === 0) return;

  const note = document.createElement('div');
  note.className = 'hs-note';
  box.appendChild(note);

  for (const defId of heroPickable) {
    const meta = HEROES.find((h) => h.id === defId);
    const d = DEFS[defId];
    const btn = document.createElement('button');
    btn.className = 'herobtn';
    btn.dataset.hero = defId;
    const fallback = iconUrl(defId, 0);
    btn.innerHTML =
      `<img src="${assetIconUrl(defId) ?? fallback}" onerror="this.onerror=null;this.src='${fallback}'" alt=""/>`
      + `<span class="nm">${meta?.name ?? d?.name ?? defId}</span>`
      + `<span class="role">${meta?.blurb ?? ''}</span>`
      + '<span class="act"></span>';
    btn.onclick = () => callHero(defId);
    box.appendChild(btn);
  }
  syncHeroShop();
}

/** 영웅 칸의 남은 쿨·상태를 지금 값으로 맞춘다 (매 프레임). */
function syncHeroShop(): void {
  const box = document.getElementById('hero-shop');
  if (!box || heroPickable.length === 0) return;
  const now = campNowSec();
  const waitLeft = Math.max(0, Math.ceil(heroNextPickSec - now));
  const full = heroPicked.length >= HERO_DEPLOY_MAX;
  const hasUnpicked = heroPickable.some((id) => !heroPicked.includes(id));
  // 첫 영웅 뒤 쿨이 끝났고, 3명 제한 안에서 실제로 더 고를 수 있을 때만 알린다.
  const nextReady = heroPicked.length > 0 && !full && hasUnpicked && waitLeft === 0;
  const heroTab = document.querySelector<HTMLButtonElement>('#shop-tabs button[data-tab="hero"]');
  heroTab?.classList.toggle('hero-ready', nextReady && shopTab !== 'hero');
  if (heroTab) heroTab.title = nextReady ? '다음 영웅이 준비됐어요' : '';
  if (box.classList.contains('hidden')) return;

  const note = box.querySelector('.hs-note');
  if (note) {
    note.innerHTML = `<b>🛡 영웅 출정 ${heroPicked.length} / ${HERO_DEPLOY_MAX}</b>`
      + '<div>한 번 부르면 쓰러져도 스스로 다시 온다 — 다시 부를 필요 없다.</div>'
      + (full ? '<div>더 부를 수 없다.</div>'
        : waitLeft > 0
          ? `<div class="cd">다음 영웅까지 ${Math.floor(waitLeft / 60)}:${String(waitLeft % 60).padStart(2, '0')}</div>`
          : '<div class="cd">지금 부를 수 있다</div>');
  }
  for (const el of Array.from(box.querySelectorAll('.herobtn'))) {
    const btn = el as HTMLButtonElement;
    const defId = btn.dataset.hero ?? '';
    const called = heroPicked.includes(defId);
    const act = btn.querySelector('.act') as HTMLElement | null;
    btn.classList.toggle('on', called);
    btn.disabled = called || full || waitLeft > 0;
    if (!act) continue;
    act.classList.toggle('wait', !called && waitLeft > 0);
    const rev = heroReviveSec(defId);
    act.textContent = called ? (rev > 0 ? `출정 중 · 부활 ${rev}초` : '출정 중')
      : full ? '자리 없음'
        : waitLeft > 0 ? `${waitLeft}초 뒤` : '⚔ 부르기';
  }
}

// ── 코치마크 ──────────────────────────────────────────────────────────────
const COACH_KEY = 'camp_coach_herotab';

/** 영웅 탭이 새로 생겼다고 한 번만 짚어 준다. */
function showCoachHeroTab(): void {
  const el = document.getElementById('coach');
  if (!el) return;
  let seen = false;
  try { seen = localStorage.getItem(COACH_KEY) === '1'; } catch { /* 무시 */ }
  const tabBtn = document.querySelector('#shop-tabs button[data-tab="hero"]');
  tabBtn?.classList.toggle('fresh', !seen);
  el.classList.toggle('hidden', seen);
}

function dismissCoach(): void {
  document.getElementById('coach')?.classList.add('hidden');
  document.querySelector('#shop-tabs button[data-tab="hero"]')?.classList.remove('fresh');
  try { localStorage.setItem(COACH_KEY, '1'); } catch { /* 무시 */ }
}

/**
 * 「유닛 / 영웅」 탭 줄을 지금 판에 맞춘다.
 * 영웅을 부를 수 있는 판(14라운드~)에서만 탭이 뜨고, 아니면 유닛 칸 하나뿐이다.
 */
function syncShopTabs(): void {
  const tabs = document.getElementById('shop-tabs');
  const on = !!campaign && heroPickable.length > 0;
  if (tabs) tabs.style.display = on ? 'flex' : 'none';
  if (!on) {
    document.getElementById('hero-shop')?.classList.add('hidden');
    document.getElementById('shop')?.classList.remove('hidden');
    document.getElementById('coach')?.classList.add('hidden');
    document.querySelector('#shop-tabs button[data-tab="hero"]')?.classList.remove('hero-ready');
    shopTab = 'unit';
    return;
  }
  buildHeroShop();
  setShopTab('unit');
  showCoachHeroTab();
}

/** 상점 아래 칸을 유닛/영웅 중 하나로 바꾼다. */
function setShopTab(tab: 'unit' | 'hero'): void {
  shopTab = tab;
  document.getElementById('shop')?.classList.toggle('hidden', tab !== 'unit');
  document.getElementById('hero-shop')?.classList.toggle('hidden', tab !== 'hero');
  for (const b of Array.from(document.querySelectorAll('#shop-tabs button'))) {
    const el = b as HTMLElement;
    el.classList.toggle('on', el.dataset.tab === tab);
    if (el.dataset.tab === tab) el.classList.remove('fresh');
  }
  if (tab === 'hero') { syncHeroShop(); dismissCoach(); }
}

function buildShop(race: RaceId): void {
  const shop = $('#shop');
  shop.innerHTML = '';
  shopButtons.length = 0;
  shopKeyMap.clear();
  let keyIdx = 0;
  /*
   * 진열 순서: 해금 테크가 먼저, 그 안에서는 원래 순서(티어 → 가격)를 지킨다.
   *
   * unitsOfRace 는 티어 순(basic→…→air→supreme→final)으로 주는데, 공중 유닛은
   * 티어가 'air' 라 뒤로 밀린다. 그래서 테크 2 짜리 거대 나비가 테크 3 인
   * 가시 마녀보다 뒤에 놓이는 역전이 생겼다.
   * (정렬 함수 자체는 봇도 쓰므로 건드리지 않는다 — 순서가 바뀌면 결정론이 깨진다.)
   */
  const listed = unitsOfRace(race)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => techOfUnit(a.d) - techOfUnit(b.d) || a.i - b.i)
    .map((x) => x.d);
  for (const d of listed) {
    // 캠페인: 스토리 진행에 따라 열린 유닛만 진열
    /*
     * 캠페인: 스토리 진행에 따라 열린 유닛만 진열.
     *
     * 기준은 스테이지 정의가 아니라 「지금 판」의 목록(game.allowedUnits)이다 —
     * 판 도중 해금(에버그린이 데려오는 숲의 명궁)이 여기 반영되어야 한다.
     * 스테이지 정의를 보면 시작 시점 목록에 영원히 갇힌다.
     */
    const allowNow = game ? game.allowedUnits : campaign?.allowedUnits;
    if (campaign && allowNow && !allowNow.includes(d.id)) continue;
    const btn = document.createElement('button');
    // 최종 유닛(테크 4)은 금색 테두리로 눈에 띄게
    btn.className = techOfUnit(d) >= 4 ? 'unitbtn rare' : 'unitbtn';
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
    // 롱프레스 중 브라우저 기본 동작(텍스트 선택·복사 말풍선·드래그) 차단.
    // 이게 없으면 「공중 원거리 / 지·공 300」 같은 글자가 통째로 잡혀서
    // 손을 뗄 때마다 선택을 풀어줘야 했다.
    btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
    btn.addEventListener('selectstart', (ev) => ev.preventDefault());
    btn.addEventListener('dragstart', (ev) => ev.preventDefault());
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault(); // 터치 롱프레스의 선택 제스처를 시작 단계에서 막는다
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
      btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
      btn.addEventListener('selectstart', (ev) => ev.preventDefault());
      btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        e.preventDefault();
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
  support: '지원가',
};
/** 화면에 띄우지 않는 태그 — 성별은 연출용 메타데이터일 뿐이다. */
const HIDDEN_TAGS = new Set(['male', 'female', 'fairy']);

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
  // 코드로만 도는 능력(오라·스택 등)은 actives 에 없어서 설명이 비어 보인다
  for (const line of d.passiveDesc ?? []) {
    const indent = line.startsWith('  ') ? ' style="padding-left:14px;opacity:.85"' : '';
    rows.push(`<div class="ui-row"${indent}><span class="ui-bonus">패시브</span> ${line.trim()}</div>`);
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



/**
 * 인컴·테크 「예약 구매」 — 버튼을 우클릭(모바일은 길게 눌러) 걸어 두면,
 * 돈이 모이고 쿨타임이 풀리는 순간 자동으로 눌린다.
 *
 * 돈을 모으는 동안 버튼만 쳐다보는 일이 없어진다. 살 수 있게 되면 바로
 * 나가므로 한 틱도 안 흘린다. 최대치에 닿으면 저절로 풀린다.
 */
const autoBuy = { income: false, tech: false };
/** 같은 틱에 두 번 나가는 걸 막는다 (멀티는 서버 왕복 동안 상태가 그대로다). */
const autoBuyTick = { income: -1, tech: -1 };

function toggleAutoBuy(kind: 'income' | 'tech'): void {
  autoBuy[kind] = !autoBuy[kind];
  audio.play(autoBuy[kind] ? 'ui_buy' : 'ui_deny', { volume: 0.5 });
  showToast(autoBuy[kind]
    ? `${kind === 'income' ? '인컴' : '테크'} 예약 — 가능해지면 자동 구매`
    : `${kind === 'income' ? '인컴' : '테크'} 예약 해제`);
}

for (const [sel, kind] of [['#btn-income', 'income'], ['#btn-tech', 'tech']] as const) {
  const el = $<HTMLButtonElement>(sel);
  // 길게 눌러 예약을 걸면, 손을 뗄 때 나오는 click 은 삼킨다 (예약하려다 사 버리지 않게)
  let heldToToggle = false;
  let holdTimer = 0;
  el.onclick = () => {
    if (heldToToggle) { heldToToggle = false; return; }
    doAction({ kind });
  };
  el.oncontextmenu = (e) => { e.preventDefault(); toggleAutoBuy(kind); };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;              // 우클릭은 contextmenu 가 맡는다
    clearTimeout(holdTimer);
    heldToToggle = false;
    holdTimer = window.setTimeout(() => { heldToToggle = true; toggleAutoBuy(kind); }, 500);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    el.addEventListener(ev, () => clearTimeout(holdTimer));
  }
}

$('#btn-pause').onclick = () => setPaused(!paused);
$('#paused').onclick = () => setPaused(false);

/**
 * 테스트용 치트 (연습 게임 전용).
 * ×1 을 눌러 시퀀스를 열고, 이어서 ×4 를 일곱 번 연속 누르면
 * 인컴·테크가 최대치가 되고 소지금이 10000 이 된다.
 * 멀티는 서버 권위 시계라 손대지 않고, 캠페인은 진행이 저장되므로 제외한다.
 */
let cheatArmed = false;
let cheatCount = 0;
/** ×1 뒤에 ×4 를 몇 번 눌러야 발동하는가. 우연히 걸리지 않게 넉넉히 잡는다. */
const CHEAT_STEPS = 7;

function tryCheat(sp: number): void {
  if (isMp || campaign) { cheatArmed = false; cheatCount = 0; return; }
  if (sp === 1) { cheatArmed = true; cheatCount = 0; return; }
  if (!cheatArmed) return;
  if (sp !== 4) { cheatArmed = false; cheatCount = 0; return; } // ×4 외의 배속은 시퀀스를 끊는다
  cheatCount++;
  if (cheatCount < CHEAT_STEPS) return;
  cheatArmed = false;
  cheatCount = 0;
  const g = game;
  const me = g?.players[myIdx];
  if (!g || !me) return;
  me.incomeLevel = Math.min(MAP.INCOME_MAX_LEVEL, g.incomeCap);
  me.techLevel = g.techCap;
  me.techPendingUntil = -1;
  me.money = 10000;
  audio.play('ui_buy', { volume: 1 });
  showToast(`🧪 치트 — 인컴 ${me.incomeLevel} · 테크 ${me.techLevel} · 소지금 ${me.money}`);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) {
  b.onclick = () => {
    const sp = Number(b.dataset.speed);
    if (isMp) {
      // 멀티에서는 방장만 배속 변경 가능 — 서버가 전원에게 동기화
      if (net && mpHostId === net.clientId) net.send({ t: 'setSpeed', speed: sp });
      return;
    }
    tryCheat(sp);
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
/*
 * 지금 고른 출정 칸의 번호. y 로 찾으면 안 된다 — 「가운데 대기」 칸의 y 는 0 이고,
 * 아직 아무 길도 고르지 않은 상태(deployLaneY 0)와 값이 같기 때문이다.
 * 그래서 예전엔 판이 열리자마자 가운데 칸에 불이 들어와 있는데도 부대는 그냥
 * 나가 버렸고, 가운데를 「고를 수」가 없어 보였다.
 */
function currentLaneIdx(): number {
  if (!game || !campaignLanes) return -1;
  if (campaignLanes[0]?.x !== undefined) {
    return campaignLanes.findIndex((l) => l.x === game!.rallyX);
  }
  if (campaignHold) return campaignLanes.findIndex((l) => l.hold);
  return campaignLanes.findIndex((l) => !l.hold && l.y === game!.deployLaneY);
}

/** 출정 길을 고른다 (버튼·전장 탭 공용). 표시와 효과음까지 여기서 챙긴다. */
function chooseLaneAt(idx: number): void {
  if (!game || !campaignLanes) return;
  const lane = campaignLanes[idx];
  if (!lane) return;
  if (lane.hold) { chooseHold(); return; }
  if (lane.x !== undefined) {
    // 집합지: 부대가 모일 자리를 옮긴다 (이미 나와 있는 부대도 그리로 향한다)
    game.rallyX = lane.x;
    game.rallyY = laneCenterY(game.map, lane.x) + lane.y;
    audio.play('ui_click');
    showToast(`🚩 ${lane.label} 로 집합한다`);
    syncLaneBtn();
    return;
  }
  campaignHold = false;
  setHoldRally(false);   // 길을 골랐으면 야영지 집합은 푼다
  setDeployLane(game, lane.y);
  audio.play('ui_click');
  // 이미 나와 있는 부대도 이 길로 향한다 (집합이 풀리면 진군으로 돌아간다)
  showToast(`⚔ ${lane.label} 쪽으로 진군한다`);
  syncLaneBtn();
}

/** 「가운데 대기」 — 이번 턴 출정을 미루고 병력을 모은다. */
/**
 * 「가운데 대기」 동안은 야영지가 집합지가 된다.
 *
 * 대기는 「출정만 안 한다」였던 탓에, 영웅과 그 동반 부대(카엘의 출정 유닛 강화 등)는
 * 대기와 무관하게 그대로 적진으로 걸어 나가 전방기지 C·D 를 두들겼다. 집합지를 걸면
 * 그 부대들이 야영지 둘레를 지키다가, 표식 둘레에 든 적만 물러 나간다.
 * 길을 고르는 순간 집합지는 풀린다.
 */
function setHoldRally(on: boolean): void {
  if (!game || !campaignLanes) return;
  if (campaignLanes[0]?.x !== undefined) return; // 집합지형 판(마을 방어전)은 제 갈래가 따로 있다
  if (on) {
    const hx = game.map.spawnX[0] + 2 * FP;
    game.rallyX = hx;
    game.rallyY = laneCenterY(game.map, hx);
  } else {
    game.rallyX = 0;
    game.rallyY = 0;
  }
}

function chooseHold(): void {
  if (!game) return;
  campaignHold = true;
  setDeployHold(game, false);   // 출정은 그대로 — 나와서 야영지를 지킨다
  setHoldRally(true);
  audio.play('ui_click');
  showToast('🛡 야영지를 지킨다 — 부대는 매 턴 나오되 진군하지 않는다 (둘레의 적은 문다)');
  syncLaneBtn();
}

/** 상단 「출정 경로」 칸을 지금 상태에 맞춘다 (칸이 없으면 만든다). */
function syncLaneBtn(): void {
  const wrap = document.getElementById('lane-pick');
  if (!wrap) return;
  const lanes = campaignLanes;
  if (!game || !lanes) { wrap.innerHTML = ''; return; }
  // 칸 수가 달라졌을 때만 새로 만든다 — 매번 다시 그리면 누르는 순간 사라져 씹힌다
  if (wrap.children.length !== lanes.length) {
    wrap.innerHTML = '';
    lanes.forEach((lane, i) => {
      const b = document.createElement('button');
      b.className = 'lanebtn' + (lane.hold ? ' hold' : '');
      // 「서쪽 숲길 (C → A)」에서 괄호 앞까지만 — 상단바는 좁다 (전체는 툴팁으로)
      b.innerHTML = `<b>${lane.hold ? '⏸ ' : ''}${lane.label.split(' (')[0]}</b><small></small>`;
      b.title = lane.label;
      b.onclick = () => chooseLaneAt(i);
      wrap.appendChild(b);
    });
  }
  // 머리말도 성격에 맞춘다 — 출정 레인과 집합지는 다른 조작이다
  const head = document.getElementById('lane-head');
  if (head) head.textContent = lanes[0]?.x !== undefined ? '집합지' : '출정 경로';
  const cur = currentLaneIdx();
  lanes.forEach((lane, i) => {
    const b = wrap.children[i] as HTMLElement | undefined;
    if (!b) return;
    b.classList.toggle('on', i === cur);
    const sub = b.querySelector('small');
    if (!sub) return;
    sub.textContent = lane.x !== undefined
      ? (i === cur ? '여기로 집합 중' : '여기로 모으기')
      : lane.hold
        ? (i === cur ? '야영지 수비 중' : '야영지 지키기')
        : (i === cur ? '이 길로 출정' : '이 길로 바꾸기');
  });
}

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
      syncLaneBtn();   // 「가운데 대기」에 쌓인 턴 수가 이때 늘어난다
    } else if (ev.kind === 'towerDown') {
      const winners = ev.team === 0 ? 1 : 0;
      showToast(`💥 ${ev.team! + 1}팀 수호탑 파괴 — ${winners + 1}팀 전원 +${MAP.TOWER_BOUNTY}원!`);
      audio.play('tower_down', { volume: 0.9 });
    } else if (ev.kind === 'guardianSpawn') {
      // 이름·경고문은 실제로 나온 수호자에서 읽는다 — 캠페인은 스테이지마다
      // 다른 수호자가 나오고(2막 = 특제 대형 곰인형), 그 곰인형은 지상이다.
      const gd = ev.defId !== undefined ? DEFS[ev.defId] : undefined;
      const gName = gd?.name ?? (ev.team === 0 ? '드래곤' : '슬리피 할로우');
      const gNote = (gd?.flying ?? true) ? ' (대공 유닛만 공격 가능)' : '';
      showToast(`🛡 ${ev.team! + 1}팀 수호자 ${gName} 등장!${gNote}`);
      audio.play('cast_skill', { volume: 1 });
    } else if (ev.kind === 'lastStand') {
      // 「최후의 함성」으로 버텨낸 순간 — 그 자리에서 축복 소리가 터진다
      audio.play('cast_bless', { volume: 0.9, ...(ev.x !== undefined ? { screenX: worldToPxX(ev.x) } : {}) });
    } else if (ev.kind === 'boneRevive') {
      // 뼈 무덤이 부화하는 순간 — 굉음이 울려퍼진다
      audio.play('bone_revive', { volume: 1, ...(ev.x !== undefined ? { screenX: worldToPxX(ev.x) } : {}) });
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
    /*
     * 확보한 거점이 매 턴 내보내는 부대.
     *
     * 확보 순간의 보상(captureReinforcements)은 한 번뿐이라 뒤 거점을 밀 때쯤이면
     * 이미 다 녹아 있었다. 확보한 거점이 계속 값을 하도록 턴마다 소규모로 보낸다.
     */
    if (game.waveIndex > 0 && game.waveIndex !== escortSquadWave && escortFrontier > 0) {
      escortSquadWave = game.waveIndex;
      let sent = 0;
      for (let i = 0; i < escortFrontier; i++) {
        const squad = es.pointWaveSquads?.[i];
        if (!squad) continue;
        const sx = Math.floor(pts[i]! * FP);
        const sy = laneCenterY(game.map, sx);
        let k = 0;
        for (const item of squad) {
          for (let n = 0; n < item.count; n++, k++) {
            const ang = ((k * 137) % 360) * Math.PI / 180;
            const dist = 1.2 + (k % 3) * 0.8;
            spawnUnit(game, item.defId, 0,
              sx + Math.floor(Math.cos(ang) * dist * FP),
              sy + Math.floor(Math.sin(ang) * dist * FP));
            sent++;
          }
        }
      }
      if (sent > 0) {
        campaignAlertText = `🌿 확보한 캠프 ${escortFrontier}곳에서 ${sent}기가 합류했다`;
        campaignAlertUntil = performance.now() + 2500;
      }
    }
    const cart = game.entities.find((e) => e.id === escortCartId);
    let contested = false;
    let escortHudNoAllies = false; // 마차는 거점에 닿았는데 아군 부대가 없다 (HUD 안내용)
    if (escortFrontier < pts.length && cart) {
      const px = Math.floor(pts[escortFrontier]! * FP);
      const py = laneCenterY(game.map, px);
      const r = Math.floor(es.radiusTiles * FP);
      // 거점 구역 안의 양 팀 전투 유닛 (구조물·수호자·야생 제외).
      // 원이 아니라 「길을 가로지르는 띠」로 잡는다 — 잿길처럼 공터가 세로로
      // 넓은 지형에선, 부대가 길 반대편 끝에 서면 원 안에 하나도 안 들어와
      // 점령이 시작되지 않았다.
      const ry = r * 4; // 굽은 길 전체 폭을 덮는다 (x 는 ±4.5타일 그대로)
      let mine = 0;
      let theirs = 0;
      for (const e of game.entities) {
        if (!e.alive || e.owner < 0) continue;
        const dx = e.x - px;
        if (dx > r || dx < -r) continue;
        const dy = e.y - py;
        if (dy > ry || dy < -ry) continue;
        if (e.team === 0) mine++;
        else if (e.team === 1) theirs++;
      }
      contested = theirs > 0;
      /*
       * 마차가 그 거점에 붙어 있는가. 상실·점령 판정 모두 이걸 먼저 본다.
       *
       * 거점마다 적 주둔군이 처음부터 눌러앉아 있으므로, 「적만 있고 우리 부대가
       * 없다」는 상태는 아직 도착하지 않은 거점의 평범한 모습이다. 마차가 붙기
       * 전까지 상실 타이머를 돌리면 시작 12초 만에 「캠프를 빼앗겼다」가 떴다.
       */
      const cdx0 = cart.x - px;
      const cartAt = escortRetreatX < 0 && cdx0 * cdx0 <= (2 * FP) * (2 * FP);
      // 상실 판정: 마차가 붙어 있는데 적만 반경 안에 loseSec 초 → 마차 후퇴
      if (cartAt && theirs > 0 && mine === 0) escortLoseTicks += dt;
      else escortLoseTicks = 0;
      if (escortLoseTicks >= es.loseSec * TICK_HZ) {
        escortLoseTicks = 0;
        escortProgressTicks = 0;
        // 밀고 밀리는 전선: 적이 거점을 점거하면 확보 수가 하나 줄고,
        // 적은 그 다음(우리 쪽) 거점으로 계속 밀고 내려온다.
        // 최후방(캠프 1)까지 뚫리면 적 진군 하한이 풀려 넥서스로 쏟아진다.
        if (escortFrontier > 0) {
          escortFrontier--;
          syncCaptureIncome();
          const per = es.pointIncomeAdd ?? 0;
          campaignAlertText = `⚠ 캠프 ${escortFrontier + 2}호를 적에게 빼앗겼다 — 전선이 밀려난다!`
            + (per > 0 ? ` (인컴 −${per})` : '');
        } else {
          escortEnemyBreak = true;
          campaignAlertText = '🚨 최전방 캠프가 무너졌다 — 적이 넥서스로 쏟아진다! 캠프 1을 되찾아라!';
        }
        escortRetreatX = escortFrontier > 0
          ? Math.floor(pts[escortFrontier - 1]! * FP)
          : game.map.spawnX[0];
        game.holdLineX = Math.floor(pts[escortFrontier]! * FP) + 2 * FP;
        game.rallyX = Math.floor(pts[escortFrontier]! * FP);
        game.rallyY = laneCenterY(game.map, game.rallyX);
        campaignAlertUntil = performance.now() + 4000;
        audio.play('cast_skill', { volume: 0.9 });
      }
      // 점령 진행: 마차가 거점에 서 있고 + 아군 부대가 곁에 있고 + 적이 없을 때만
      // 오른다 (마차 혼자서는 의식을 지킬 수 없다 / 경합 중엔 멈춤)
      escortHudNoAllies = cartAt && theirs === 0 && mine === 0;
      if (cartAt && theirs === 0 && mine > 0) {
        escortProgressTicks += dt;
        if (escortProgressTicks >= es.captureSec * TICK_HZ) {
          escortProgressTicks = 0;
          escortFrontier++;
          escortEnemyBreak = false; // 캠프를 되찾았다 — 적은 다시 전선에서 멈춘다
          syncCaptureIncome();
          placeGarrisons();   // 다음 거점 주둔군을 이제 세운다
          /*
           * 확보 보상: 아군 지원군이 그 거점 자리에 바로 도착한다.
           * 「거점을 미는 것」 자체에 값이 붙어야 「버티며 인컴만 올리기」와
           * 경쟁이 된다 — 안 그러면 그리디가 언제나 정답이다.
           */
          let rewardNote = '';
          const rein = es.captureReinforcements?.[escortFrontier - 1];
          if (rein && rein.length > 0) {
            const rx = Math.floor(pts[escortFrontier - 1]! * FP);
            const ry = laneCenterY(game.map, rx);
            let k = 0;
            let total = 0;
            for (const item of rein) {
              for (let n = 0; n < item.count; n++, k++) {
                // 거점 주위에 고르게 흩어 세운다 (한 점에 겹쳐 나오면 서로 밀린다)
                const ang = ((k * 137) % 360) * Math.PI / 180;
                const dist = 1.4 + (k % 4) * 0.9;
                spawnUnit(game, item.defId, 0,
                  rx + Math.floor(Math.cos(ang) * dist * FP),
                  ry + Math.floor(Math.sin(ang) * dist * FP));
                total++;
              }
            }
            rewardNote = ` — 숲의 잔존 병력 ${total}기 합류!`;
          }
          if (escortFrontier >= pts.length) {
            game.holdLineX = 0; // 전선 해제 — 총공격
            game.rallyX = 0;
            game.rallyY = 0;
            campaignAlertText = `🎺 다섯 캠프를 모두 확보했다!${rewardNote} 전군, 넥서스로 총공격!`;
            // 전 거점 확보 이벤트: 네임드 등장 + 컷신 (13: 슬리피 할로우의 정체)
            if (es.onCompleteSpawn) {
              const hxRaw = game.map.nexusX[1] - 5 * FP;
              const hx = Math.max(0, hxRaw);
              const named = spawnUnit(game, es.onCompleteSpawn.defId, 1, hx, laneCenterY(game.map, hx));
              named.hp = DEFS[es.onCompleteSpawn.defId]!.maxHp;
              // 보스 호위 — 넥서스 앞에 반원으로 벌려 세운다
              let rk = 0;
              let retinueN = 0;
              for (const r of es.onCompleteRetinue ?? []) {
                for (let n = 0; n < r.count; n++, rk++) {
                  const ang = (-90 + ((rk * 37) % 180)) * Math.PI / 180;
                  const dist = 2.0 + (rk % 5) * 1.1;
                  const u = spawnUnit(game, r.defId, 1,
                    hx + Math.floor(Math.cos(ang) * dist * FP),
                    laneCenterY(game.map, hx) + Math.floor(Math.sin(ang) * dist * FP));
                  u.hp = DEFS[r.defId]!.maxHp;
                  retinueN++;
                }
              }
              campaignAlertText = retinueN > 0
                ? `${es.onCompleteSpawn.label} — 군단을 이끌고 길 끝을 막아섰다! (호위 ${retinueN}기)`
                : `${es.onCompleteSpawn.label} — 길 끝을 막아섰다! 넥서스를 파괴하라!`;
            }
            if (es.onCompleteDialogue) {
              setCutscenePause(true);
              void runDialogue(es.onCompleteDialogue).then(() => setCutscenePause(false));
            }
          } else {
            game.holdLineX = Math.floor(pts[escortFrontier]! * FP) + 2 * FP;
            game.rallyX = Math.floor(pts[escortFrontier]! * FP);
            game.rallyY = laneCenterY(game.map, game.rallyX);
            const incNote = (es.pointIncomeAdd ?? 0) > 0
              ? ` (인컴 +${es.pointIncomeAdd} → 총 +${(es.pointIncomeAdd ?? 0) * escortFrontier})` : '';
            campaignAlertText = `🚩 캠프 ${escortFrontier}/${pts.length} 확보!${rewardNote}${incNote} 마차가 다음 마디로 나아간다`;
          }
          // 확보한 만큼 옛 망루가 되살아난다
          const raised = raiseGuardsFor(escortFrontier);
          if (raised > 0) {
            campaignAlertText += `
🗼 숲의 망루 ${raised}기가 다시 불을 밝혔다!`;
          }
          campaignAlertUntil = performance.now() + 4500;
          audio.play('ui_buy', { volume: 0.9 });
        }
      }
      /*
       * 적의 거점 재탈환 — 이미 확보한 맨 앞 거점(frontier-1)을 되찾는다.
       *
       * 여기까지는 상실 판정이 「지금 미는 거점」에서만 돌았고, 그나마 마차가
       * 붙어 있어야만 했다. 그래서 뒤에 두고 온 캠프는 적이 아무리 밟고 지나가도
       * 영영 안 넘어갔다 — 플레이어가 앞만 보고 밀면 그만이었다.
       * 뒤가 뚫리면 실제로 잃도록, 마차와 무관하게 후방 거점도 검사한다.
       */
      if (escortFrontier > 0 && escortRetreatX < 0) {
        const rx = Math.floor(pts[escortFrontier - 1]! * FP);
        const ry2 = laneCenterY(game.map, rx);
        const rr = Math.floor(es.radiusTiles * FP);
        const rry = rr * 4;
        let rMine = 0;
        let rTheirs = 0;
        for (const e of game.entities) {
          if (!e.alive || e.owner < 0) continue;
          const dx = e.x - rx;
          if (dx > rr || dx < -rr) continue;
          const dy = e.y - ry2;
          if (dy > rry || dy < -rry) continue;
          if (e.team === 0) rMine++;
          else if (e.team === 1) rTheirs++;
        }
        if (rTheirs > 0 && rMine === 0) escortRearLoseTicks += dt;
        else escortRearLoseTicks = 0;
        if (escortRearLoseTicks >= es.loseSec * TICK_HZ) {
          escortRearLoseTicks = 0;
          escortProgressTicks = 0;
          escortLoseTicks = 0;
          escortFrontier--;
          syncCaptureIncome();
          const per = es.pointIncomeAdd ?? 0;
          if (escortFrontier === 0) escortEnemyBreak = true;
          escortRetreatX = escortFrontier > 0
            ? Math.floor(pts[escortFrontier - 1]! * FP)
            : game.map.spawnX[0];
          game.holdLineX = Math.floor(pts[escortFrontier]! * FP) + 2 * FP;
          game.rallyX = Math.floor(pts[escortFrontier]! * FP);
          game.rallyY = laneCenterY(game.map, game.rallyX);
          campaignAlertText = `⚠ 뒤가 뚫렸다 — 캠프 ${escortFrontier + 1}호를 다시 빼앗겼다!`
            + (per > 0 ? ` (인컴 −${per})` : '');
          campaignAlertUntil = performance.now() + 4000;
          audio.play('cast_skill', { volume: 0.9 });
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
    /*
     * 적 진군 하한: 적 부대가 현재 다툼 중인 거점에 멈춰 서서 점거를 시도한다
     * (그냥 지나쳐 우리 기지로 달려가지 않도록). 전 거점 확보 후엔 해제 — 총공세.
     *
     * 단, 거점마다 주둔군을 세워 둔 판에서는 이 전선을 걸지 않는다.
     * 「거점을 지킨다」는 역할은 주둔군이 맡고, 진군 부대는 우리 기지로 밀고
     * 와야 한다. 둘 다 걸면 진군 부대가 점령 반경(±4.5타일) 안에 영원히
     * 눌러앉아 theirs > 0 이 풀리지 않고 — 게이지가 중간에 멈춰 버렸다.
     */
    game.enemyHoldLineX = (es.garrisons?.length ?? 0) > 0 ? 0
      : escortFrontier < pts.length && !escortEnemyBreak
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
    /** 이 거점(slot)의 주둔지 건물이 아직 서 있는가. */
    const campAlive = (slot: number): boolean => {
      const camp = (campaign!.enemyCamps ?? []).find((c) => c.slot === slot);
      if (!camp?.nexusDefId) return false;
      const owner = game!.players.findIndex((pl) => pl.team === 1 && pl.slot === slot);
      if (owner < 0) return false;
      return game!.entities.some((e) => e.alive && e.defId === camp.nexusDefId && e.owner === owner);
    };
    // 이번 프레임에 무너진 거점을 먼저 훑는다 (보스 트리거는 그 순간 딱 한 번)
    for (const c of campaign.enemyCamps ?? []) {
      if (!c.nexusDefId || campaignCampDown.has(c.slot)) continue;
      if (!campAlive(c.slot)) campaignCampDown.add(c.slot);
    }
    for (let i = 0; i < campaign.spawns.length; i++) {
      const rule = campaign.spawns[i]!;
      /*
       * 거점 보스: 그 거점이 무너지는 순간 딱 한 번 예약된다.
       *
       * 「이미 나왔나」(campaignSpawnedTotal)를 함께 봐야 한다. 거점은 한 번 무너지면
       * 계속 무너져 있고, everySec 이 없는 규칙은 스폰 직후 시계가 Infinity 로 돌아간다 —
       * 그러면 다음 프레임에 이 조건이 그대로 다시 참이 되어 매 프레임 보스가 하나씩
       * 튀어나온다 (구울 군주가 무한히 불어나던 버그).
       */
      if (rule.onCampDown !== undefined) {
        if (campaignSpawnNext[i] === Infinity && campaignSpawnedTotal[i] === 0
          && campaignCampDown.has(rule.onCampDown)) {
          campaignSpawnNext[i] = nowSec;   // 지금 바로
        }
      }
      // 영웅 출정: 아직 부르지 않았으면 이 규칙은 잠들어 있다
      if (rule.heroPick && !heroPicked.includes(rule.defId)) continue;
      // 거점이 무너졌으면 그쪽 증원은 영구히 끊긴다
      if (rule.whileCampSlot !== undefined && campaignCampDown.has(rule.whileCampSlot)) {
        campaignSpawnNext[i] = Infinity;
        continue;
      }
      // 전역 잠금 유닛은 출현 이벤트로도 나오지 않는다 (unlockEnemyUnits 로 푸는 판만 예외)
      if (campaignDenied.includes(rule.defId)) {
        campaignSpawnNext[i] = Infinity;
        continue;
      }
      /*
       * 「죽고 나서 N초 뒤 부활」.
       *
       * 살아 있는 동안 매 프레임 시계를 지금 + N 으로 미뤄 둔다. 그래야 쓰러진
       * 순간부터 정확히 N 초를 센다. 차례가 됐을 때만 미루면, 살아 있는 사이
       * 시계가 그대로 흘러 죽자마자 다시 나오는 일이 생긴다 (카엘 즉시 부활).
       */
      if (rule.respawnAfterDeathSec !== undefined && rule.concurrentCap !== undefined) {
        let aliveNow2 = 0;
        for (const e of game.entities) if (e.alive && e.defId === rule.defId) aliveNow2++;
        // 강화로 줄어든 부활 시간 (영웅별)
        const waitSec = rule.defId === 'c_kael' ? kaelReviveSec()
          : rule.defId === 'c_evergreen' ? evergreenReviveSec()
          : rule.defId === 'c_elowyn' ? elowynReviveSec()
          : rule.respawnAfterDeathSec;
        const maxCharge = rule.defId === 'c_kael' ? kaelReviveCharges()
          : rule.defId === 'c_evergreen' ? evergreenReviveCharges()
          : rule.defId === 'c_elowyn' ? elowynReviveCharges() : 0;
        if (aliveNow2 >= rule.concurrentCap) {
          /*
           * 「숲은 기다린다」: 살아 있는 동안 부활이 충전된다.
           * 충전이 차 있으면 쓰러진 즉시 다시 서므로, 여기서 미리 시계를 당겨 둔다.
           */
          if (maxCharge > 0) {
            const st = heroCharge[rule.defId] ?? { n: 0, next: -1 };
            if (st.next < 0) st.next = nowSec + waitSec;
            if (nowSec >= st.next && st.n < maxCharge) {
              st.n++;
              st.next = nowSec + waitSec;
            }
            heroCharge[rule.defId] = st;
          }
          campaignSpawnNext[i] = nowSec + waitSec;
          continue;
        }
        // 쓰러져 있다 — 충전이 남아 있으면 기다리지 않고 바로 세운다
        {
          const st = heroCharge[rule.defId];
          if (st && st.n > 0) {
            st.n--;
            campaignSpawnNext[i] = nowSec;
          }
        }
      }
      if (nowSec < campaignSpawnNext[i]!) continue;
      // 만료: 이 시각을 넘으면 규칙을 끈다 (뼈 거상 → 라다만토스 교체 등)
      if (rule.untilSec !== undefined && nowSec >= rule.untilSec) {
        campaignSpawnNext[i] = Infinity;
        continue;
      }
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
      // countAdd: 등장할 때마다 물량이 불어난다 (버틸수록 거세지는 기습).
      // countMax 가 있으면 거기서 멈춘다 — 끝없이 불어나면 후반이 감당이 안 된다.
      const grown = (rule.count ?? 1) + (rule.countAdd ?? 0) * campaignSpawnFires[i]!;
      const n = rule.countMax !== undefined ? Math.min(rule.countMax, grown) : grown;
      campaignSpawnFires[i] = campaignSpawnFires[i]! + 1;
      campaignSpawnedTotal[i] = campaignSpawnedTotal[i]! + n;
      const sx0 = rule.atXTile !== undefined ? Math.floor(rule.atXTile * FP) : game.map.spawnX[1];
      const yBase = laneCenterY(game.map, sx0) + Math.floor((rule.yOffTile ?? 0) * FP);
      // 영웅이면 「영웅 강화」를 반영한 정의로 세운다
      const heroOv = rule.friendly ? applyHeroUpgrades(DEFS[rule.defId]!, rule.defId) : undefined;
      /*
       * 한 줄로만 세우면 물량이 많을 때 줄이 길 밖으로 삐져나간다 (기습 5회차면
       * 25기 = 위아래 14타일). 다섯 기마다 열을 바꾸고, 열은 좌우로 번갈아 벌린다.
       * n <= 5 면 예전과 완전히 같은 자리다.
       */
      const perCol = 5;
      const rowsN = n < perCol ? n : perCol;
      for (let k = 0; k < n; k++) {
        const colN = Math.floor(k / perCol);
        const side = colN % 2 === 0 ? 1 : -1;
        const px = Math.max(0, Math.min(game.map.length,
          sx0 + side * Math.ceil(colN / 2) * 700));
        const py0 = yBase + Math.round((k % perCol - (rowsN - 1) / 2) * 600);
        // 마스크 맵은 길 밖에 세우면 벽 속에서 시작한다 — 가장 가까운 길로 붙인다
        const py = game.map.mask ? clampLaneY(game.map, px, py0) : py0;
        // 야생 무리(neutral)는 제3팀(2) — 자기들끼리는 한 편, 플레이어·적 모두와 적대
        spawnUnit(game, rule.defId, rule.friendly ? 0 : rule.neutral ? 2 : 1, px, py,
          heroOv !== DEFS[rule.defId] ? heroOv : undefined);
      }
      // 영웅이 이끌고 오는 호위 부대 — 같은 자리에 흩어 세운다.
      // 카엘은 「숲지기의 부대」 강화로 데려오는 병력이 늘어난다.
      const retinue = rule.defId === 'c_kael'
        ? [...(rule.withUnits ?? []), ...kaelRetinue()]
        : rule.defId === 'c_evergreen'
          ? evergreenRetinue()
          : rule.defId === 'c_elowyn'
            ? [...(rule.withUnits ?? []), ...elowynRetinue()]
            : (rule.withUnits ?? []);
      for (const w of retinue) {
        for (let k = 0; k < w.count; k++) {
          const ang = ((k * 137) % 360) * Math.PI / 180;
          const dist = 1.4 + (k % 4) * 0.8;
          spawnUnit(game, w.defId, rule.friendly ? 0 : rule.neutral ? 2 : 1,
            sx0 + Math.floor(Math.cos(ang) * dist * FP),
            yBase + Math.floor(Math.sin(ang) * dist * FP));
        }
      }
      campaignSpawnNext[i] = rule.everySec !== undefined ? campaignSpawnNext[i]! + rule.everySec : Infinity;
      const firstTime = campaignSpawnedTotal[i]! === n;
      // 첫 등장에만: 상점 해금 + 컷신 대화
      if (firstTime) {
        for (const id of rule.unlockUnits ?? []) {
          if (!game.allowedUnits.includes(id)) game.allowedUnits.push(id);
        }
        if ((rule.unlockUnits ?? []).length > 0) buildShop(game.players[myIdx]!.race);
        if (rule.onFirstDialogue) {
          setCutscenePause(true);
          void runDialogue(rule.onFirstDialogue).then(() => setCutscenePause(false));
        }
      }
      // 주민 행렬처럼 매 턴 여러 번 나오는 스폰은 배너를 띄우지 않는다 (화면을 계속 가린다)
      if (!rule.quiet) {
        // 이름표가 이미 「… 참전!」 처럼 끝나면 「출현!」 을 덧붙이지 않는다
        campaignAlertText = /[!?]$/.test(rule.label) ? `⚠ ${rule.label}` : `⚠ ${rule.label} 출현!`;
        campaignAlertUntil = performance.now() + 4000;
        audio.play('cast_skill', { volume: 0.9 });
      }
    }
  }
  // 두 갈래 맵: 지금 고른 출정 레인에 불이 들어온다
  if (renderer) {
    renderer.setDeployLanes(campaignLanes, currentLaneIdx());
  }
  // 영웅 출정 칸: 다음 영웅까지 남은 시간이 여기서 줄어든다
  if (shopTab === 'hero') syncHeroShop();
  // 캠페인: 확정 성장 — fromWave 턴부터 매 턴 적 봇 comp 에 +1 (캡 도달 시 멈춤).
  // 출정 직전 턴에 미리 편입해 fromWave 웨이브부터 실제로 필드에 나오게 한다.
  if (campaign && !campaignDone && !game.over && campaign.growth) {
    for (let i = 0; i < campaign.growth.length; i++) {
      const rule = campaign.growth[i]!;
      if (campaignDenied.includes(rule.defId)) continue; // 전역 잠금 유닛은 확정 편입도 막는다
      const nextWave = game.waveIndex + 1; // 지금 편입하면 이 웨이브 출정분
      if (nextWave < rule.fromWave || nextWave <= campaignGrowthWave[i]!) continue;
      // once: fromWave 에 딱 한 번만 (편성은 누적이라 이후 매 턴 그만큼 계속 나온다)
      if (rule.once && campaignGrowthWave[i]! > 0) continue;
      campaignGrowthWave[i] = nextWave;
      const add = rule.amount ?? 1;
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
        best.comp[rule.defId] = (best.comp[rule.defId] ?? 0) + add;
        mergeComp(game, best);   // 확정 편입분도 합치기 대상이다
        if (!campaignGrowthAnnounced[i]) {
          campaignGrowthAnnounced[i] = true;
          campaignAlertText = add > 1
            ? `⚠ 적군에 ${rule.label} ${add}기 합류!`
            : `⚠ 적군에 ${rule.label} 합류!`;
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
    /*
     * 마을 방어전 (6 「자정의 마을」).
     *
     * 시간을 버티는 것만으로는 이기지 못한다 — bossWave 턴에 나오는 쿠르가를
     * 잡아야 끝난다. 매 턴 하는 일:
     *   · 어느 숲길이 열리는가를 정해 적 출정 자리를 옮긴다 (한쪽 / 6의 배수면 양쪽)
     *   · 두 번째 길이 열리기 직전 턴에 경고 대사를 띄운다
     *   · finalWave 부터 양 진영 생산을 멈춘다 (남은 병력으로 보스를 끝낸다)
     * 매 프레임 하는 일:
     *   · 6시 탈출구에 닿은 주민을 「죽지 않고」 지운다 (시체 연출 없음)
     *   · 죽은 주민을 세고, 집이 다 무너졌는지 본다
     */
    if (campaign.village && game && !game.over) {
      const vg = campaign.village;
      const wave = game.waveIndex;

      // ── 턴이 바뀌는 순간에만 하는 것들 ──
      if (wave !== villageWave) {
        villageWave = wave;
        // 지금 정해 두는 자리는 「다음 출정」이 쓴다 = 화면에 wave + 1 턴으로 뜬다
        applyVillageLanes(vg, wave + 1);
        applyVillageWarnings(vg, wave + 1);
        // 두 번째 길이 열리는 그 턴에 경고. 한 번만 띄운다.
        if (wave === vg.secondLaneWave && vg.secondLaneDialogue && !villageWarned) {
          villageWarned = true;
          setCutscenePause(true);
          void runDialogue(vg.secondLaneDialogue).then(() => setCutscenePause(false));
        }
        // 보스 등장
        if (wave >= vg.bossWave && villageBossId < 0) {
          const bx = Math.floor(vg.lanes[0]!.xTile * FP);
          const by = laneCenterY(game.map, bx) + Math.floor(vg.lanes[0]!.yOffTile * FP);
          const kurga = spawnUnit(game, vg.bossDefId, 1, bx, by);
          // 쿠르가도 그 숲길이 「지금」 노리는 곳으로 내려간다 (한복판에 눌러앉지 않는다)
          const bg = villageGoalNow(vg, 0);
          if (bg) {
            kurga.goalX = bg.x;
            kurga.goalY = bg.y;
          }
          villageBossId = kurga.id;
          campaignAlertText = '⚔ 리치 쿠르가가 마을로 내려온다!';
          campaignAlertUntil = performance.now() + 5000;
          audio.play('cast_skill', { volume: 1 });
        }
        /*
         * 마지막 턴부터는 양쪽 다 새 병력이 없다 — 남은 것으로 결판을 낸다.
         * 인컴을 끊고 지갑을 비워 봇이 더 못 사게 한다 (사람도 마찬가지).
         */
        if (wave >= vg.finalWave) {
          for (const p2 of game.players) {
            p2.money = 0;
            p2.incomeLevel = 0;
          }
        }
      }

      // ── 주민: 6시 탈출구에 닿으면 「대피 성공」 (죽는 게 아니다) ──
      const fx = Math.floor(vg.fleeXTile * FP);
      const fy = laneCenterY(game.map, fx) + Math.floor(vg.fleeYOffTile * FP);
      const fr = vg.fleeRadiusTiles * FP;
      for (const e of game.entities) {
        if (!e.alive || !e.defId.startsWith('c_villager_')) continue;
        villageSeen.set(e.id, e.defId);
        const dx = e.x - fx;
        const dy = e.y - fy;
        if (dx * dx + dy * dy <= fr * fr) {
          renderer?.quietRemove(e.id);   // 시체 연출 없이 사라진다
          e.alive = false;
          e.hp = 0;
          villageSeen.delete(e.id);
          villageEscaped++;
        }
      }
      // 살아 있는 목록에서 사라진 id = 적에게 죽은 주민 (대피는 위에서 이미 뺐다)
      const aliveIds = new Set(game.entities.filter((e) => e.alive).map((e) => e.id));
      for (const id of [...villageSeen.keys()]) {
        if (!aliveIds.has(id)) {
          villageSeen.delete(id);
          villageDeaths++;
        }
      }
      if (villageDeaths >= vg.loseDeaths) {
        campaignFinish(false, `주민 ${villageDeaths}명 사망`);
        return;
      }
      const housesLeft = game.entities.filter(
        (e) => e.alive && e.defId.startsWith('c_village_')).length;
      // 집이 하나 무너지면 그 길목은 값어치를 잃는다 — 적을 즉시 다시 겨눈다
      if (housesLeft !== villageHousesSeen) {
        villageHousesSeen = housesLeft;
        retargetVillageEnemies(vg);
      }
      if (housesLeft === 0) {
        campaignFinish(false, '마을이 전부 불탔다');
        return;
      }
      // ── 승리: 보스가 나왔고, 그 보스를 쓰러뜨렸다 ──
      if (villageBossId >= 0 && !game.entities.some((e) => e.alive && e.id === villageBossId)) {
        campaignDone = true;   // 대사 도중 다른 판정이 끼어들지 않게 먼저 잠근다
        setCutscenePause(true);
        void runDialogue(vg.winDialogue ?? []).then(() => {
          setCutscenePause(false);
          campaignDone = false;
          campaignFinish(true);
        });
        return;
      }
      if (performance.now() >= campaignAlertUntil) {
        const boss = villageBossId >= 0 ? ' · ⚔ 쿠르가' : '';
        const left = Math.max(0, vg.bossWave - wave);
        $('#campaign-goal').textContent =
          `[6. ${campaign.title}] ${left > 0 ? `쿠르가까지 ${left}턴` : '쿠르가를 쓰러뜨려라'}`
          + ` · 🏠 ${housesLeft}/4 · 🏃 대피 ${villageEscaped} · ☠ ${villageDeaths}/${vg.loseDeaths}${boss}`;
      }
    }
    if (campaign.mission === 'survive' && campaign.surviveSec !== undefined) {
      const left = campaign.surviveSec - Math.floor(game.tick / TICK_HZ);
      /*
       * 마을 방어전은 시간이 다 돼도 이기지 않는다 — bossWave 는 「쿠르가가 나오는 때」일
       * 뿐이고, 그를 쓰러뜨려야 끝난다. 이 판정을 막지 않으면 보스가 나오는 순간
       * 승리 처리가 먼저 나가 버린다.
       */
      if (!game.over && left <= 0 && !campaign.village) {
        campaignFinish(true);
        return;
      }
      // 마을 방어전은 위에서 집·주민까지 함께 찍었다 — 덮어쓰지 않는다
      if (left > 0 && !campaign.village && performance.now() >= campaignAlertUntil) {
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
function setBar(id: string, hp: number, max: number): void {
  const bar = $(`#${id}`);
  const fill = bar.querySelector('i') as HTMLElement;
  const r = Math.max(0, Math.min(1, hp / max));
  fill.style.transform = `scaleX(${r})`;
  // 위태로울 때만 맥박치게 — 켜지는 건 많아야 바 네 개다
  bar.classList.toggle('low', r > 0 && r <= 0.3);
}

/** 넥서스 판: 팀 이름 + 남은 체력 숫자. */
function setNexusHead(team: 0 | 1, name: string, hp: number, max: number): void {
  const plate = $(`#nx-${team}`);
  // 넥서스가 아예 없는 판(마을 방어전)에서는 판 자체를 감춘다 —
  // 그냥 두면 시작하자마자 양쪽 다 「파괴됨」이라 지고 있는 것처럼 보인다.
  if (campaign?.noNexus) {
    plate.style.display = 'none';
    return;
  }
  plate.style.display = '';
  const nameEl = plate.querySelector('.nx-name') as HTMLElement;
  const hpEl = plate.querySelector('.nx-hp') as HTMLElement;
  if (nameEl.textContent !== name) nameEl.textContent = name;
  const shown = Math.ceil(Math.max(0, hp));
  const txt = shown > 0 ? `${shown} / ${max}` : '파괴됨';
  if (hpEl.textContent !== txt) hpEl.textContent = txt;
  hpEl.style.color = shown > 0 ? '' : '#ff7a6c';
}

/**
 * 상단바의 실제 높이를 CSS 로 흘려보낸다 — 명단·토스트·정보창·캠페인 배너가
 * 상단바에 가리지 않게.
 *
 * 고정값으로 둘 수 없다: 세로폰에서는 상단바가 두세 줄로 접히고,
 * 조작 메뉴(#tb-tools)를 접으면 한 줄이 통째로 사라진다.
 */
let lastHudTop = -1;
function syncHudInsets(): void {
  const top = Math.ceil($('#topbar').getBoundingClientRect().height);
  if (top === lastHudTop) return;
  lastHudTop = top;
  document.documentElement.style.setProperty('--hud-top', `${top}px`);
  ($('#campaign-goal') as HTMLElement).style.top = `${top + 6}px`;
}

function updateHud(g: Game): void {
  syncHudInsets();
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
  // 최대치에 닿으면 예약은 의미가 없다
  if (me.incomeLevel >= g.incomeCap) autoBuy.income = false;
  incBtn.classList.toggle('queued', autoBuy.income);
  if (autoBuy.income && !incBtn.disabled && autoBuyTick.income !== g.tick) {
    autoBuyTick.income = g.tick;
    doAction({ kind: 'income' });
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
  if (me.techLevel >= g.techCap) autoBuy.tech = false;
  techBtn.classList.toggle('queued', autoBuy.tech);
  if (autoBuy.tech && !techBtn.disabled && autoBuyTick.tech !== g.tick) {
    autoBuyTick.tech = g.tick;
    doAction({ kind: 'tech' });
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
    const nxHp = nx?.alive ? nx.hp : 0;
    setBar(`bar-n${team}`, nxHp, DEFS.nexus!.maxHp);
    setBar(`bar-t${team}`, tw?.alive ? tw.hp : 0, DEFS.tower!.maxHp);
    setNexusHead(team, `${team + 1}팀 넥서스${mine}`, nxHp, DEFS.nexus!.maxHp);
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
    `<div class="menurow"><button id="result-restart" class="menubtn">${back}</button></div>`;
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
// 상점 탭 (유닛 / 영웅 출정) — 14라운드부터 뜬다
for (const b of Array.from(document.querySelectorAll('#shop-tabs button'))) {
  const el = b as HTMLElement;
  el.onclick = () => setShopTab(el.dataset.tab === 'hero' ? 'hero' : 'unit');
}
{
  const ok = document.getElementById('coach-ok');
  if (ok) ok.onclick = () => { dismissCoach(); setShopTab('hero'); };
}

$('#btn-quit').onclick = () => {
  const inGame = !!game && !game.over;
  const msg = isMp
    ? '게임에서 나가시겠습니까? 내 자리는 AI 가 이어받습니다.'
    : campaign
      ? '스테이지를 포기하고 캠페인 목록으로 나가시겠습니까? 진행 상황은 저장되지 않습니다.'
      : '게임을 끝내고 메뉴로 나가시겠습니까?';
  if (inGame && !confirm(msg)) return;
  if (isMp) {
    net?.send({ t: 'leaveRoom' });
    sessionStorage.removeItem('dl_token');
  }
  // 캠페인은 왔던 곳 — 스테이지 목록으로 곧장 돌려보낸다.
  // (타이틀·대전 메뉴를 거치지 않는다. 재도전·다음 스테이지와 같은 길)
  if (campaign) sessionStorage.setItem('camp_auto', 'list');
  // 깨끗한 상태로 다시 시작
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

/** 상단 조작 메뉴(명단·상점·나가기·일시정지·배속) 접기/펼치기. */
function initToolsToggle(): void {
  const btn = $('#btn-tools') as HTMLButtonElement;
  btn.onclick = () => {
    const collapsed = $('#tb-tools').classList.toggle('collapsed');
    btn.textContent = collapsed ? '▾' : '▴';
    syncHudInsets();
    window.dispatchEvent(new Event('resize'));
  };
}

/** 캠페인 재도전. 이미 있는 「패배 후 재도전」과 같은 길을 탄다. */
function initRetry(): void {
  ($('#btn-retry') as HTMLButtonElement).onclick = () => {
    if (!campaign) return;
    if (!confirm(`${campaign.id}스테이지를 처음부터 다시 시작할까요? 지금 판은 사라집니다.`)) return;
    sessionStorage.setItem('camp_auto', String(campaign.id));
    setTimeout(() => location.reload(), 60);
  };
}

// ── 모바일 ────────────────────────────────────────────────────────────────
/** 상점 접기/펼치기. 좁은 화면에서 전장을 넓게 보려고 쓴다. */
function initShopToggle(): void {
  const btn = $('#btn-shop') as HTMLButtonElement;
  btn.onclick = () => {
    const bar = $('#bottombar');
    const collapsed = bar.classList.toggle('collapsed');
    btn.classList.toggle('on', !collapsed);
    syncHudInsets();
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

const EMPTY_SAVE: SaveData = { cleared: 0, perks: {}, boons: {}, updatedAt: 0 };

function maybeSync(serverSave: SaveData | null): Promise<void> {
  return new Promise((resolve) => {
    if (!isLoggedIn() || syncDeferred) { resolve(); return; }
    const local = localSave();
    const remote = serverSave;
    const me = accountUid();
    const owner = saveOwner();
    /*
     * 이 기기 기록이 「다른 계정 것」이면 묻지 않고 계정 기록으로 갈아 끼운다.
     *
     * 예전엔 주인이 누구든 상관없이, 새로 로그인한 계정이 비어 있으면 그대로
     * 올려 버렸다 — 계정을 바꿔 로그인한 순간 앞 계정의 진행이 새 계정에
     * 통째로 복사됐다. 물어보는 것도 답이 아니다: 「이 기기 기록」이 애초에
     * 내 것이 아니므로 올릴 선택지 자체가 있으면 안 된다.
     */
    if (me && owner && owner !== me) {
      applySave(remote ?? EMPTY_SAVE);
      setSaveOwner(me);
      markSynced();
      campaignAlertText = `☁ ${profile()?.name ?? '계정'} 의 진행 상황을 불러왔습니다`;
      campaignAlertUntil = performance.now() + 5000;
      resolve();
      return;
    }
    const sameProgress = remote !== null
      && remote.cleared === local.cleared
      && JSON.stringify(remote.perks) === JSON.stringify(local.perks)
      && JSON.stringify(remote.boons) === JSON.stringify(local.boons);
    if (sameProgress) { setSaveOwner(me); markSynced(); resolve(); return; }
    /*
     * 묻지 않고 올려도 되는 경우는 둘뿐이다.
     *   · 이 기기 기록이 내 것이라고 표식이 말해 준다
     *   · 올릴 게 아예 없다 (빈 기록이라 덮어써도 잃을 게 없다)
     * 표식이 없는 기기(이 기능이 생기기 전부터 쓰던 기기)에서 남의 기록을
     * 들고 새 계정에 로그인하는 경우를 이 둘로는 가려낼 수 없으므로, 나머지는
     * 전부 물어본다. 예전엔 「계정이 비었으면 무조건 올린다」였고 그게 남의
     * 진행을 새 계정에 통째로 복사한 원인이다.
     */
    const remoteEmpty = !remote || (remote.cleared === 0 && Object.keys(remote.perks).length === 0);
    const mine = !!me && owner === me;
    const trivial = local.cleared === 0 && Object.keys(local.boons).length === 0;
    if (remoteEmpty && (mine || trivial)) {
      pushSave(local);
      setSaveOwner(me);
      markSynced();
      resolve();
      return;
    }
    const modal = $('#sync-modal');
    const boonCount = (b: Record<string, string | string[]>): number => Object.keys(b).length;
    const whose = owner && owner === me ? '이 기기' : '이 기기(로그인 전 기록)';
    $('#sync-desc').textContent =
      `${profile()?.name ?? '계정'} 님 — 이 기기와 계정의 진행 상황이 다릅니다.

`
      + `💻 ${whose} — ${local.cleared}스테이지 클리어 · 강화 ${boonCount(local.boons)}종
`
      + `☁ 계정 — ${remote?.cleared ?? 0}스테이지 클리어 · 강화 ${boonCount(remote?.boons ?? {})}종

`
      + `어느 쪽을 기준으로 맞출까요? (선택한 쪽으로 덮어씁니다)`;
    modal.classList.remove('hidden');
    const done = (): void => {
      modal.classList.add('hidden');
      setSaveOwner(me);
      markSynced();
      resolve();
    };
    ($('#sync-pull') as HTMLButtonElement).onclick = () => {
      applySave(remote ?? EMPTY_SAVE);
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
  // 이미 로그인된 채 접속: 서버에서 테스터 표식·uid 를 최신화한다
  // (화이트리스트 등록 전에 로그인했던 계정도 새로고침만으로 3막이 열리게)
  if (isLoggedIn()) {
    void fetchSave().then(() => {
      refreshAuthUi();
      // 주인 표식이 생기기 전부터 쓰던 기기: 지금 로그인한 계정 것으로 본다.
      // (예전엔 「이 기기 기록 = 지금 로그인한 사람 것」이 암묵 전제였다)
      const me = accountUid();
      if (me && !saveOwner()) setSaveOwner(me);
    });
  }
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
initToolsToggle();
initRetry();
initRotateHint();
initChat();
initHotkeys();
initRoster();
void initNet();
