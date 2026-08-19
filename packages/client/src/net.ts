/**
 * 서버 연결 (WebSocket). 대기실 + 명령 중계 프로토콜.
 *
 * 서버 주소 우선순위:
 *  1. `?server=host:port` 쿼리 — 임시로 다른 서버를 가리킬 때
 *  2. 빌드 시 주입한 `VITE_SERVER_URL` (예: wss://desertlike-server.example.com)
 *  3. 개발 기본값 — 페이지 호스트의 8787 포트
 *
 * 배포본(https)에서 2번이 없으면 null 을 돌려준다. https 페이지에서 ws:// 는
 * 브라우저가 어차피 차단하므로, 헛되이 5초를 기다리지 말고 바로 오프라인으로 간다.
 */
export function serverUrl(): string | null {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return /^wss?:\/\//.test(override) ? override : `ws://${override}`;

  const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim();
  if (configured) return configured;

  if (location.protocol === 'https:') return null;
  return `ws://${location.hostname || 'localhost'}:8787`;
}

export type NetMsg = Record<string, unknown> & { t: string };

export interface Net {
  clientId: string;
  send(msg: NetMsg): void;
  on(type: string, cb: (msg: NetMsg) => void): void;
  close(): void;
}

export async function connect(): Promise<Net> {
  const url = serverUrl();
  if (!url) throw new Error('서버 주소가 설정되지 않았습니다');

  const ws = new WebSocket(url);
  const handlers = new Map<string, ((msg: NetMsg) => void)[]>();

  ws.addEventListener('message', (ev) => {
    let msg: NetMsg;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    for (const cb of handlers.get(msg.t) ?? []) cb(msg);
  });

  const clientId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('서버 응답 없음')), 5000);
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('서버 연결 실패'));
    });
    handlers.set('welcome', [(m) => {
      clearTimeout(timeout);
      // 재접속 토큰: 탭 단위 유지 (새로고침해도 같은 좌석을 되찾는다)
      let token = sessionStorage.getItem('dl_token');
      if (!token) {
        token = crypto.randomUUID();
        sessionStorage.setItem('dl_token', token);
      }
      ws.send(JSON.stringify({ t: 'hello', token }));
      resolve(m.clientId as string);
    }]);
  });

  return {
    clientId,
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    on(type, cb) {
      const list = handlers.get(type) ?? [];
      list.push(cb);
      handlers.set(type, list);
    },
    close() {
      ws.close();
    },
  };
}
