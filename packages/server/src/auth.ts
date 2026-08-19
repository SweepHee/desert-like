/**
 * 구글 로그인 + 클라우드 세이브 (캠페인 진행 상황).
 *
 * 설계 원칙:
 *  - 외부 의존성 없음: 구글 ID 토큰은 google 의 tokeninfo 엔드포인트로 검증한다
 *    (로그인은 드문 이벤트라 왕복 1회 비용이 문제되지 않는다).
 *  - 저장은 파일 하나(JSON). DATA_DIR 이 있으면 그 아래(Railway 볼륨),
 *    없으면 프로세스 옆 data/ 에 쓴다. 쓰기는 임시파일 → rename 으로 원자적.
 *  - 세션 토큰은 서버 메모리 + 파일에 함께 보관해 재시작해도 로그인이 유지된다.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 캠페인 진행 상황 — 클라이언트 localStorage 와 같은 모양. */
export interface SaveData {
  /** 클리어한 최고 스테이지 번호. */
  cleared: number;
  /** 세계수의 축복 배분 { perkId: 포인트 }. */
  perks: Record<string, number>;
  /** 유닛 강화 선택 { unitId: boonId }. */
  boons: Record<string, string>;
  /** 마지막 갱신 시각 (ms) — 동기화 방향 판단용. */
  updatedAt: number;
}

interface Account {
  sub: string;          // 구글 계정 고유 id
  name: string;
  picture: string;
  email?: string | undefined;
  save: SaveData;
}

/**
 * 테스터 이메일 화이트리스트 — 미공개 콘텐츠(3막)를 이 계정들에게만 연다.
 * TESTER_EMAILS 환경변수(콤마 구분)로 늘릴 수 있다.
 */
const TESTERS = new Set(
  (process.env.TESTER_EMAILS ?? 'jeonsh1991@gmail.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const isTester = (email?: string): boolean => !!email && TESTERS.has(email.toLowerCase());

interface Store {
  accounts: Record<string, Account>;
  /** 세션 토큰 → 구글 sub. */
  sessions: Record<string, string>;
}

// 저장 위치: DATA_DIR > Railway 볼륨 마운트 경로 > 프로세스 옆 data/
// (볼륨만 붙여두고 DATA_DIR 설정을 잊어도 데이터가 날아가지 않도록)
const DATA_DIR = process.env.DATA_DIR?.trim() || process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || join(process.cwd(), 'data');
const DATA_FILE = join(DATA_DIR, 'accounts.json');

function emptySave(): SaveData {
  return { cleared: 0, perks: {}, boons: {}, updatedAt: 0 };
}

function load(): Store {
  try {
    if (existsSync(DATA_FILE)) {
      return JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Store;
    }
  } catch (e) {
    console.error('[auth] 저장 파일 로드 실패 — 새로 시작합니다', e);
  }
  return { accounts: {}, sessions: {} };
}

const store: Store = load();
let saveTimer: NodeJS.Timeout | null = null;

/** 디스크 기록 — 잦은 호출을 모아 1초에 한 번만 실제로 쓴다. */
function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(store), 'utf8');
      renameSync(tmp, DATA_FILE); // 원자적 교체 — 중간에 죽어도 파일이 깨지지 않는다
    } catch (e) {
      console.error('[auth] 저장 실패', e);
    }
  }, 1000);
}

interface GoogleProfile { sub: string; name: string; picture: string; email?: string | undefined }
/**
 * 구글 ID 토큰 검증 → 계정 정보.
 * 실패하면 왜 실패했는지 reason 을 함께 돌려준다 — 조용히 401 만 내려보내면
 * 클라이언트에서는 원인을 알 길이 없어 디버깅이 불가능하다.
 */
async function verifyGoogleAccess(accessToken: string): Promise<{ profile?: GoogleProfile; reason?: string }> {
  try {
    // 1) 이 토큰이 정말 우리 클라이언트에게 발급된 것인지 (aud 대조)
    const ti = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!ti.ok) {
      console.error(`[auth] access tokeninfo 거부 status=${ti.status}`);
      return { reason: `tokeninfo_${ti.status}` };
    }
    const info = (await ti.json()) as Record<string, string>;
    const wantAud = process.env.GOOGLE_CLIENT_ID?.trim();
    if (wantAud && info.aud !== wantAud) {
      console.error(`[auth] aud 불일치 got=${info.aud} want=${wantAud}`);
      return { reason: 'aud_mismatch' };
    }
    if (!info.sub) return { reason: 'no_sub' };
    // 2) 이름·사진은 userinfo 에서
    const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!ui.ok) {
      console.error(`[auth] userinfo 거부 status=${ui.status}`);
      return { reason: `userinfo_${ui.status}` };
    }
    const u = (await ui.json()) as Record<string, string>;
    return { profile: { sub: info.sub, name: u.name ?? u.email ?? '이름없는 자', picture: u.picture ?? '' } };
  } catch (e) {
    console.error('[auth] 구글 액세스 토큰 검증 중 오류', e);
    return { reason: 'verify_error' };
  }
}

async function verifyGoogle(idToken: string): Promise<{ profile?: GoogleProfile; reason?: string }> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) {
      console.error(`[auth] tokeninfo 거부 status=${res.status}`);
      return { reason: `tokeninfo_${res.status}` };
    }
    const p = (await res.json()) as Record<string, string>;
    if (!p.sub) {
      console.error('[auth] tokeninfo 응답에 sub 없음');
      return { reason: 'no_sub' };
    }
    // aud 검증: 우리 클라이언트에서 발급된 토큰인지 (설정이 없으면 검사 생략).
    // 클라이언트 ID 는 공개값이라 로그에 남겨도 안전하다.
    const wantAud = process.env.GOOGLE_CLIENT_ID?.trim();
    if (wantAud && p.aud !== wantAud) {
      console.error(`[auth] aud 불일치 got=${p.aud} want=${wantAud}`);
      return { reason: 'aud_mismatch' };
    }
    return { profile: { sub: p.sub, name: p.name ?? p.email ?? '이름없는 자', picture: p.picture ?? '', email: p.email } };
  } catch (e) {
    console.error('[auth] 구글 토큰 검증 중 오류', e);
    return { reason: 'verify_error' };
  }
}

function sessionOf(req: IncomingMessage): Account | null {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const sub = token ? store.sessions[token] : undefined;
  return sub ? store.accounts[sub] ?? null : null;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

/**
 * /api/* 요청 처리. 처리했으면 true.
 * 엔드포인트:
 *   POST /api/auth/google  { idToken }        → { token, name, picture, save }
 *   GET  /api/save         (Bearer)           → { save }
 *   POST /api/save         (Bearer) { save }  → { ok }
 *   POST /api/auth/logout  (Bearer)           → { ok }
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  if (!url.startsWith('/api/')) return false;

  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return true;
  }

  if (url === '/api/auth/google' && req.method === 'POST') {
    const body = await readBody(req);
    let idToken = '';
    let accessToken = '';
    try {
      const b = JSON.parse(body) as { idToken?: string; accessToken?: string };
      idToken = b.idToken ?? '';
      accessToken = b.accessToken ?? '';
    } catch { /* 무시 */ }
    if (!idToken && !accessToken) {
      json(res, 401, { error: 'invalid_token', reason: 'no_token' });
      return true;
    }
    // 커스텀 버튼(OAuth2 토큰 플로우)은 access_token, 공식 버튼은 id_token 을 준다
    const { profile, reason } = accessToken
      ? await verifyGoogleAccess(accessToken)
      : await verifyGoogle(idToken);
    if (!profile) {
      json(res, 401, { error: 'invalid_token', reason });
      return true;
    }
    const acc = store.accounts[profile.sub] ?? { ...profile, save: emptySave() };
    acc.name = profile.name;
    acc.picture = profile.picture;
    acc.email = profile.email;
    store.accounts[profile.sub] = acc;
    const token = randomBytes(24).toString('hex');
    store.sessions[token] = profile.sub;
    persist();
    json(res, 200, { token, name: acc.name, picture: acc.picture, tester: isTester(acc.email), save: acc.save });
    return true;
  }

  if (url === '/api/save' && req.method === 'GET') {
    const acc = sessionOf(req);
    if (!acc) { json(res, 401, { error: 'unauthorized' }); return true; }
    json(res, 200, { save: acc.save, name: acc.name, picture: acc.picture, tester: isTester(acc.email) });
    return true;
  }

  if (url === '/api/save' && req.method === 'POST') {
    const acc = sessionOf(req);
    if (!acc) { json(res, 401, { error: 'unauthorized' }); return true; }
    const body = await readBody(req);
    try {
      const incoming = (JSON.parse(body) as { save?: Partial<SaveData> }).save ?? {};
      acc.save = {
        cleared: Math.max(0, Math.floor(Number(incoming.cleared ?? 0))),
        perks: incoming.perks && typeof incoming.perks === 'object' ? incoming.perks : {},
        boons: incoming.boons && typeof incoming.boons === 'object' ? incoming.boons : {},
        updatedAt: Date.now(),
      };
      persist();
      json(res, 200, { ok: true, save: acc.save });
    } catch {
      json(res, 400, { error: 'bad_body' });
    }
    return true;
  }

  if (url === '/api/auth/logout' && req.method === 'POST') {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token) delete store.sessions[token];
    persist();
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'not_found' });
  return true;
}
