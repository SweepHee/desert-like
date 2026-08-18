/**
 * Desertlike 멀티플레이 서버 — 대기실 + 명령 중계 + 재접속.
 *
 * 시뮬레이션은 돌리지 않는다 (결정론 동기화):
 *  - 시드·좌석 확정 배포, 명령에 실행 틱 스탬프 후 전원 중계
 *  - 권위 틱 시계 방송 (방장 배속 반영)
 *  - 게임 전체 명령 로그 보관 → 재접속자는 시드+로그 리플레이로 상태 복원
 *  - 이탈자는 지연 틱에 AI 전환 명령(aiOn), 복귀 시 aiOff — 전 클라이언트 동일 틱 적용
 */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { handleApi } from './auth.ts';

const PORT = Number(process.env.PORT ?? 8787);
const TICK_MS = 50; // 20Hz
const CMD_DELAY_TICKS = 6; // 실배속 1x 기준 300ms
/** 연결이 끊긴 좌석/방을 정리하기까지의 유예 (ms). */
const GRACE_MS = 60_000;

type RaceId = 'sylvarin' | 'pandemonium' | 'marionetta';
const RACES: RaceId[] = ['sylvarin', 'pandemonium', 'marionetta'];
const MAP_IDS = ['plains', 'toybox', 'valley'];

interface Seat {
  type: 'empty' | 'human' | 'ai';
  name: string;
  race: RaceId;
  clientId?: string;
  /** 재접속용 세션 토큰 (human 전용, 연결이 끊겨도 유지). */
  token?: string;
  disconnectedAt?: number;
}

interface RelayCmd {
  playerIdx: number;
  executeTick: number;
  seq: number;
  cmd: unknown;
}

interface Room {
  id: string;
  name: string;
  hostId: string;
  /**
   * 좌석은 [1팀 좌석들..., 2팀 좌석들...] 순서로 이어 붙인 하나의 배열이다.
   * 어디까지가 1팀인지는 teamSize[0] 이 정한다 (1:1, 1:3, 2:3 … 전부 가능).
   */
  seats: Seat[];
  teamSize: [number, number];
  inGame: boolean;
  /**
   * 게임 시작 시점의 "봇이었나" 목록. 시뮬레이션 재구성은 반드시 이걸 써야 한다.
   * 좌석의 현재 상태(중도 이탈로 AI 전환 등)로 게임을 만들면 0틱부터 봇 판단이
   * 끼어들어 다른 클라이언트와 다른 게임이 되어버린다. 중도 전환은 aiOn/aiOff
   * 명령이 명령 로그에 남아 같은 틱에 반영된다.
   */
  startBots: boolean[];
  mapId: string;
  seed: number;
  speed: number;
  /** 틱 시계: tickBase + (now - tickBaseAt) * speed / TICK_MS */
  tickBase: number;
  tickBaseAt: number;
  seq: number;
  cmdLog: RelayCmd[];
  tickTimer?: ReturnType<typeof setInterval>;
  hashes: Map<number, Map<string, number>>;
  emptySince: number | null;
}

interface Client {
  id: string;
  name: string;
  token: string | null;
  roomId: string | null;
  ws: WebSocket;
  /** 마지막 채팅 시각 (도배 방지). */
  lastChatAt?: number;
}

const clients = new Map<WebSocket, Client>();
const rooms = new Map<string, Room>();
let nextId = 1;

/**
 * WS 는 HTTP 서버에 얹는다. 호스팅(Railway 등)의 헬스체크와 "서버 살아있나"
 * 확인이 브라우저/curl 로 가능해야 하기 때문. 순수 WS 서버는 평범한 GET 에
 * 400 만 돌려줘서 배포 문제를 진단하기 어렵다.
 */
const server = createServer((req, res) => {
  // 구글 로그인·클라우드 세이브 API (/api/*) 는 별도 모듈이 처리한다
  void handleApi(req, res).then((handled) => {
    if (handled) return;
    healthResponse(req, res);
  });
});

/** 상태 확인용 응답 (Railway 헬스체크). */
function healthResponse(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    service: 'desertlike-server',
    rooms: rooms.size,
    clients: clients.size,
    path: req.url,
  }));
}
const wss = new WebSocketServer({ server });
server.listen(PORT, () => {
  console.log(`desertlike server listening on :${PORT} (http + ws)`);
});

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastRoom(room: Room, msg: unknown): void {
  for (const c of clients.values()) {
    if (c.roomId === room.id) send(c.ws, msg);
  }
}

function roomSummary(r: Room) {
  return {
    id: r.id,
    name: r.name,
    players: r.seats.filter((s) => s.type === 'human').length,
    ais: r.seats.filter((s) => s.type === 'ai').length,
    inGame: r.inGame,
  };
}

/** 좌석 인덱스 → 팀. 앞쪽 teamSize[0] 개가 1팀. */
function teamOfSeat(r: Room, idx: number): 0 | 1 {
  return idx < r.teamSize[0] ? 0 : 1;
}

/** 빈 자리를 채울 AI 좌석. 이름은 팀 내 번호로 (1팀 2번 AI 처럼). */
function aiSeat(r: Room, idx: number): Seat {
  const team = teamOfSeat(r, idx);
  const inTeam = team === 0 ? idx : idx - r.teamSize[0];
  return { type: 'ai', name: `AI ${team + 1}-${inTeam + 1}`, race: RACES[(idx * 7 + 1) % 3]! };
}

function seatsPublic(r: Room) {
  return r.seats.map((s, i) => ({
    type: s.type,
    name: s.name,
    race: s.race,
    team: teamOfSeat(r, i),
    clientId: s.clientId ?? null,
    connected: s.type !== 'human' || !!s.clientId,
  }));
}

function roomState(r: Room) {
  return {
    id: r.id, name: r.name, hostId: r.hostId, inGame: r.inGame,
    mapId: r.mapId, teamSize: r.teamSize, seats: seatsPublic(r),
  };
}

function pushRoomUpdate(r: Room): void {
  broadcastRoom(r, { t: 'room', state: roomState(r) });
}

function emptySeat(): Seat {
  return { type: 'empty', name: '', race: 'sylvarin' };
}

function currentTick(r: Room): number {
  return Math.max(0, r.tickBase + Math.floor(((Date.now() - r.tickBaseAt) * r.speed) / TICK_MS));
}

function seatIdxOfClient(r: Room, clientId: string): number {
  return r.seats.findIndex((s) => s.type === 'human' && s.clientId === clientId);
}

/** 서버가 만들어 넣는 게임 명령 (AI 인계 등). 일반 명령과 같은 경로로 중계된다. */
function relayCmd(room: Room, playerIdx: number, cmd: unknown): void {
  const rc: RelayCmd = {
    playerIdx,
    executeTick: currentTick(room) + CMD_DELAY_TICKS * room.speed,
    seq: ++room.seq,
    cmd,
  };
  room.cmdLog.push(rc);
  broadcastRoom(room, { t: 'cmd', ...rc });
}

/**
 * "언제부터 아무도 없었나"를 갱신한다.
 *
 * 비어 있는 동안 이 함수가 다시 불려도 시각을 덮어쓰면 안 된다. 예전엔 매번
 * Date.now() 로 다시 찍어서, 누가 하나 더 끊기거나 재접속을 시도할 때마다
 * 정리 시계가 처음부터 다시 돌아 빈 방이 영영 목록에 남았다.
 */
function updateEmptySince(r: Room): void {
  const anyConnected = r.seats.some((s) => s.type === 'human' && s.clientId);
  if (anyConnected) r.emptySince = null;
  else if (r.emptySince === null) r.emptySince = Date.now();
}

function disconnectFromRoom(c: Client): void {
  if (!c.roomId) return;
  const r = rooms.get(c.roomId);
  c.roomId = null;
  if (!r) return;
  const idx = seatIdxOfClient(r, c.id);
  if (idx >= 0) {
    const s = r.seats[idx]!;
    // 좌석은 토큰으로 예약 유지 — 재접속하면 되찾는다
    const { clientId: _drop, ...rest } = s;
    r.seats[idx] = { ...rest, disconnectedAt: Date.now() };
    if (r.inGame) {
      broadcastRoom(r, { t: 'peerLeft', playerIdx: idx, name: s.name });
      relayCmd(r, idx, { kind: 'aiOn' }); // 지연 틱에 AI 가 이어받는다
    }
  }
  if (r.hostId === c.id) {
    const next = r.seats.find((s) => s.type === 'human' && s.clientId);
    if (next?.clientId) {
      r.hostId = next.clientId;
      broadcastRoom(r, { t: 'host', hostId: r.hostId });
    }
  }
  updateEmptySince(r);
  if (!r.inGame) pushRoomUpdate(r);
}

/** 토큰으로 방/좌석을 되찾는다. 성공 시 true. */
function tryResume(c: Client): boolean {
  if (!c.token) return false;
  for (const r of rooms.values()) {
    const idx = r.seats.findIndex((s) => s.type === 'human' && s.token === c.token);
    if (idx < 0) continue;
    const s = r.seats[idx]!;
    if (s.clientId) return false; // 이미 다른 연결이 점유
    r.seats[idx] = { ...s, clientId: c.id };
    delete r.seats[idx]!.disconnectedAt;
    c.roomId = r.id;
    c.name = s.name;
    updateEmptySince(r);
    if (!r.seats.some((x) => x.type === 'human' && x.clientId && x.clientId === r.hostId)) {
      r.hostId = c.id; // 방장이 나 하나뿐이면 회수
    }
    if (r.inGame) {
      send(c.ws, {
        t: 'rejoin',
        seed: r.seed,
        mapId: r.mapId,
        teamSize: r.teamSize,
        startBots: r.startBots,
        speed: r.speed,
        tick: currentTick(r),
        hostId: r.hostId,
        myIdx: idx,
        seats: seatsPublic(r),
        cmdLog: r.cmdLog,
      });
      relayCmd(r, idx, { kind: 'aiOff' }); // AI 가 잡고 있었다면 반환
      broadcastRoom(r, { t: 'peerBack', playerIdx: idx, name: s.name });
    } else {
      send(c.ws, { t: 'joined', state: roomState(r) });
      pushRoomUpdate(r);
    }
    return true;
  }
  return false;
}

// 유예 지난 좌석/방 정리
setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (!r.inGame) {
      let changed = false;
      r.seats = r.seats.map((s) => {
        if (s.type === 'human' && !s.clientId && s.disconnectedAt && now - s.disconnectedAt > GRACE_MS) {
          changed = true;
          return emptySeat();
        }
        return s;
      });
      if (changed) pushRoomUpdate(r);
      // 대기실인데 앉은 사람이 아무도 없으면(=구경만 하다 다 나감) 바로 접는다.
      // 60초 유예는 게임 중 재접속을 위한 것이라 로비에는 필요 없다.
      if (!r.seats.some((s) => s.type !== 'empty')) {
        rooms.delete(r.id);
        continue;
      }
    }
    // 좌석 정리로 비게 된 방도 여기서 시계가 시작되도록 한 번 더 확인
    updateEmptySince(r);
    if (r.emptySince !== null && now - r.emptySince > GRACE_MS) {
      if (r.tickTimer) clearInterval(r.tickTimer);
      rooms.delete(r.id);
    }
  }
}, 10_000);

wss.on('connection', (ws) => {
  const client: Client = { id: `c${nextId++}`, name: `플레이어${nextId}`, token: null, roomId: null, ws };
  clients.set(ws, client);
  send(ws, { t: 'welcome', clientId: client.id });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    handle(client, msg);
  });

  ws.on('close', () => {
    disconnectFromRoom(client);
    clients.delete(ws);
  });
});

function handle(c: Client, m: Record<string, unknown>): void {
  const t = m.t as string;

  if (t === 'hello') {
    c.token = String(m.token ?? '') || null;
    const name = String(m.name ?? '').trim().slice(0, 16);
    if (name) c.name = name;
    const resumed = tryResume(c);
    if (!resumed) send(c.ws, { t: 'helloAck' });
    return;
  }

  if (t === 'setName') {
    const name = String(m.name ?? '').trim().slice(0, 16);
    if (name) c.name = name;
    return;
  }

  if (t === 'listRooms') {
    send(c.ws, { t: 'rooms', list: [...rooms.values()].filter((r) => !r.inGame).map(roomSummary) });
    return;
  }

  if (t === 'createRoom') {
    if (c.roomId) disconnectFromRoom(c);
    const id = `r${nextId++}`;
    const room: Room = {
      id,
      name: String(m.name ?? '').trim().slice(0, 24) || `${c.name}의 방`,
      hostId: c.id,
      seats: Array.from({ length: 6 }, emptySeat),
      teamSize: [3, 3],
      inGame: false,
      startBots: [],
      mapId: MAP_IDS[0]!,
      seed: 0,
      speed: 1,
      tickBase: 0,
      tickBaseAt: 0,
      seq: 0,
      cmdLog: [],
      hashes: new Map(),
      emptySince: null,
    };
    room.seats[0] = { type: 'human', name: c.name, race: 'sylvarin', clientId: c.id, ...(c.token ? { token: c.token } : {}) };
    rooms.set(id, room);
    c.roomId = id;
    send(c.ws, { t: 'joined', state: roomState(room) });
    return;
  }

  if (t === 'joinRoom') {
    const r = rooms.get(String(m.roomId));
    if (!r || r.inGame) {
      send(c.ws, { t: 'error', msg: '방이 없거나 이미 시작됨' });
      return;
    }
    const free = r.seats.findIndex((s) => s.type === 'empty');
    if (free < 0) {
      send(c.ws, { t: 'error', msg: '방이 가득 참' });
      return;
    }
    if (c.roomId) disconnectFromRoom(c);
    r.seats[free] = { type: 'human', name: c.name, race: 'sylvarin', clientId: c.id, ...(c.token ? { token: c.token } : {}) };
    c.roomId = r.id;
    updateEmptySince(r);
    send(c.ws, { t: 'joined', state: roomState(r) });
    pushRoomUpdate(r);
    return;
  }

  const room = c.roomId ? rooms.get(c.roomId) : undefined;
  if (!room) return;
  const isHost = room.hostId === c.id;

  if (t === 'leaveRoom') {
    // 자발적 퇴장: 토큰 예약을 남기지 않는다 (새로고침해도 돌아오지 않도록).
    // 게임 중이면 남은 사람들을 위해 그 자리는 AI 가 계속 맡는다.
    const idx = seatIdxOfClient(room, c.id);
    if (idx >= 0) {
      const s = room.seats[idx]!;
      if (room.inGame) {
        broadcastRoom(room, { t: 'peerLeft', playerIdx: idx, name: s.name });
        relayCmd(room, idx, { kind: 'aiOn' });
        room.seats[idx] = { type: 'ai', name: `${s.name} (이탈)`, race: s.race };
      } else {
        room.seats[idx] = emptySeat();
      }
    }
    c.roomId = null;
    c.token = null; // 이 클라이언트의 재접속 예약 해제
    if (room.hostId === c.id) {
      const next = room.seats.find((s) => s.type === 'human' && s.clientId);
      if (next?.clientId) {
        room.hostId = next.clientId;
        broadcastRoom(room, { t: 'host', hostId: room.hostId });
      }
    }
    updateEmptySince(room);
    pushRoomUpdate(room);
    return;
  }

  if (t === 'setRace' && !room.inGame) {
    const idx = Number(m.seat);
    const race = m.race as RaceId;
    if (!RACES.includes(race)) return;
    const s = room.seats[idx];
    if (!s) return;
    const isMine = s.type === 'human' && s.clientId === c.id;
    const isMyAI = s.type === 'ai' && isHost;
    if (isMine || isMyAI) {
      room.seats[idx] = { ...s, race };
      pushRoomUpdate(room);
    }
    return;
  }

  if (t === 'addAI' && isHost && !room.inGame) {
    const idx = Number(m.seat);
    if (room.seats[idx]?.type !== 'empty') return;
    room.seats[idx] = aiSeat(room, idx);
    pushRoomUpdate(room);
    return;
  }

  if (t === 'removeAI' && isHost && !room.inGame) {
    const idx = Number(m.seat);
    if (room.seats[idx]?.type !== 'ai') return;
    room.seats[idx] = emptySeat();
    pushRoomUpdate(room);
    return;
  }

  if (t === 'moveSeat' && isHost && !room.inGame) {
    // 방장의 자리 이동: 두 좌석을 맞바꾼다 (빈 자리로의 이동 포함)
    const from = Number(m.from);
    const to = Number(m.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from < 0 || from > 5 || to < 0 || to > 5 || from === to) return;
    const a = room.seats[from]!;
    room.seats[from] = room.seats[to]!;
    room.seats[to] = a;
    pushRoomUpdate(room);
    return;
  }

  if (t === 'start' && isHost && !room.inGame) {
    // 빈 자리는 AI 로 메우지 않고 아예 뺀다. 3:3 방에 사람이 팀당 하나씩만
    // 있으면 그대로 1:1 이 된다 (AI 를 원하면 방장이 직접 넣어둔다).
    // 한쪽이 통째로 비면 게임이 성립하지 않으므로 그때만 AI 하나를 세운다.
    {
      const keep = (list: Seat[], team: 0 | 1): Seat[] => {
        const occupied = list.filter((s) => s.type !== 'empty');
        if (occupied.length > 0) return occupied;
        return [{ type: 'ai', name: `AI ${team + 1}-1`, race: RACES[team % 3]! }];
      };
      const t0 = keep(room.seats.slice(0, room.teamSize[0]), 0);
      const t1 = keep(room.seats.slice(room.teamSize[0]), 1);
      room.teamSize = [t0.length, t1.length];
      room.seats = [...t0, ...t1];
    }
    room.inGame = true;
    room.startBots = room.seats.map((s) => s.type === 'ai');
    room.seed = (Math.random() * 0x7fffffff) | 0;
    room.speed = 1;
    room.seq = 0;
    room.cmdLog = [];
    room.tickBase = 0;
    room.tickBaseAt = Date.now() + 1500;
    broadcastRoom(room, {
      t: 'started',
      seed: room.seed,
      mapId: room.mapId,
      teamSize: room.teamSize,
      startBots: room.startBots,
      startInMs: room.tickBaseAt - Date.now(),
      hostId: room.hostId,
      seats: seatsPublic(room),
    });
    room.tickTimer = setInterval(() => {
      broadcastRoom(room, { t: 'tick', tick: currentTick(room), speed: room.speed });
    }, 1000);
    return;
  }

  if (t === 'chat') {
    // 채팅은 시뮬레이션과 무관하므로 명령 로그(cmdLog)를 타지 않는다.
    // 결정론에 영향이 없어야 하고, 재접속 리플레이에 섞여서도 안 된다.
    const text = String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    if (now - (c.lastChatAt ?? 0) < 500) return; // 도배 방지
    c.lastChatAt = now;
    const idx = seatIdxOfClient(room, c.id);
    broadcastRoom(room, {
      t: 'chat',
      from: c.name,
      team: idx >= 0 ? teamOfSeat(room, idx) : null,
      text,
    });
    return;
  }

  if (t === 'setMap' && isHost && !room.inGame) {
    const id = String(m.mapId);
    if (!MAP_IDS.includes(id)) return;
    room.mapId = id;
    pushRoomUpdate(room);
    return;
  }

  if (t === 'setTeamSize' && isHost && !room.inGame) {
    const a = Number(m.a);
    const b = Number(m.b);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return;
    if (a < 1 || a > 3 || b < 1 || b > 3) return;

    const [oldA] = room.teamSize;
    const t0 = room.seats.slice(0, oldA);
    const t1 = room.seats.slice(oldA);
    // 사람이 앉은 자리를 잘라내는 축소는 거부한다 (말없이 튕기지 않도록).
    const dropsHuman = t0.slice(a).some((s) => s.type === 'human')
      || t1.slice(b).some((s) => s.type === 'human');
    if (dropsHuman) {
      send(c.ws, { t: 'error', msg: '사람이 앉은 자리는 줄일 수 없습니다. 먼저 자리를 비워주세요.' });
      return;
    }
    const fit = (list: Seat[], n: number): Seat[] =>
      Array.from({ length: n }, (_, i) => list[i] ?? emptySeat());
    room.teamSize = [a, b];
    room.seats = [...fit(t0, a), ...fit(t1, b)];
    pushRoomUpdate(room);
    return;
  }

  if (t === 'setSpeed' && isHost && room.inGame) {
    const sp = Number(m.speed);
    if (![1, 2, 4].includes(sp)) return;
    room.tickBase = currentTick(room);
    room.tickBaseAt = Date.now();
    room.speed = sp;
    broadcastRoom(room, { t: 'speed', speed: sp, tick: room.tickBase });
    return;
  }

  if (t === 'cmd' && room.inGame) {
    const idx = seatIdxOfClient(room, c.id);
    if (idx < 0) return;
    relayCmd(room, idx, m.cmd);
    return;
  }

  if (t === 'hash' && room.inGame) {
    const tick = Number(m.tick);
    const hash = Number(m.hash);
    let byClient = room.hashes.get(tick);
    if (!byClient) {
      byClient = new Map();
      room.hashes.set(tick, byClient);
    }
    byClient.set(c.id, hash);
    const values = [...byClient.values()];
    if (values.length >= 2 && values.some((v) => v !== values[0])) {
      console.warn(`[desync] room=${room.id} tick=${tick}`);
      broadcastRoom(room, { t: 'desync', tick });
    }
    if (room.hashes.size > 20) {
      const oldest = Math.min(...room.hashes.keys());
      room.hashes.delete(oldest);
    }
    return;
  }

  if (t === 'gameOver' && room.inGame) {
    if (room.tickTimer) clearInterval(room.tickTimer);
    room.inGame = false;
    room.speed = 1;
    room.cmdLog = [];
    room.hashes.clear();
    room.seats = room.seats.map((s) => (s.type === 'human' && !s.clientId ? emptySeat() : s));
    pushRoomUpdate(room);
    return;
  }
}
