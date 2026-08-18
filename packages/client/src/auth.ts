/**
 * 구글 로그인 + 클라우드 세이브 클라이언트.
 *
 * - 로그인은 Google Identity Services(GIS) 팝업. 클라이언트 ID 는 빌드 환경변수.
 * - 세션 토큰과 프로필은 localStorage 에 두어 새로고침해도 유지된다.
 * - 세이브는 캠페인 진행(클리어 단계·축복·유닛 강화) 세 가지뿐이다.
 * - 서버가 없거나 로그인을 안 해도 게임은 그대로 동작한다 (전부 로컬 저장).
 */
import { serverUrl } from './net.ts';

export interface SaveData {
  cleared: number;
  perks: Record<string, number>;
  boons: Record<string, string>;
  updatedAt: number;
}

export interface Profile {
  name: string;
  picture: string;
}

const LS_TOKEN = 'dl_auth_token';
const LS_PROFILE = 'dl_auth_profile';
/** 이 계정과 이미 동기화를 끝냈는지 (스테이지 진입 때마다 묻지 않도록). */
const LS_SYNCED = 'dl_auth_synced';

const CLIENT_ID = (import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

/** 로그인 기능을 쓸 수 있는가 (클라이언트 ID 가 설정돼 있는가). */
export function authAvailable(): boolean {
  return CLIENT_ID.length > 0 && !!serverUrl();
}

function apiBase(): string {
  // 멀티플레이 서버와 같은 호스트 — ws(s):// 를 http(s):// 로 바꾼다
  const u = serverUrl();
  return u ? u.replace(/^ws/, 'http').replace(/\/$/, '') : '';
}

export function authToken(): string | null {
  try { return localStorage.getItem(LS_TOKEN); } catch { return null; }
}

export function profile(): Profile | null {
  try {
    const raw = localStorage.getItem(LS_PROFILE);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch { return null; }
}

export function isLoggedIn(): boolean {
  return !!authToken() && !!profile();
}

export function markSynced(): void {
  try { localStorage.setItem(LS_SYNCED, authToken() ?? ''); } catch { /* 무시 */ }
}

export function alreadySynced(): boolean {
  try { return !!authToken() && localStorage.getItem(LS_SYNCED) === authToken(); } catch { return false; }
}

export function logout(): void {
  const t = authToken();
  if (t) {
    void fetch(`${apiBase()}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}` },
    }).catch(() => { /* 서버가 없어도 로컬 로그아웃은 진행 */ });
  }
  try {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_PROFILE);
    localStorage.removeItem(LS_SYNCED);
  } catch { /* 무시 */ }
}

/** GIS 스크립트를 한 번만 로드한다. */
let gisPromise: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if ((window as { google?: unknown }).google) { resolve(); return; }
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true;
    sc.onload = () => resolve();
    sc.onerror = () => reject(new Error('GIS 로드 실패'));
    document.head.appendChild(sc);
  });
  return gisPromise;
}

interface GisCredentialResponse { credential: string }
interface GisApi {
  accounts: {
    id: {
      initialize(cfg: { client_id: string; callback: (r: GisCredentialResponse) => void }): void;
      renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
      prompt(): void;
    };
  };
}

/**
 * 로그인 버튼을 el 안에 그린다. 로그인에 성공하면 onDone(서버 세이브) 호출.
 * GIS 는 커스텀 버튼에서 팝업을 띄우는 걸 막고 있어서 공식 버튼을 렌더한다.
 */
export async function renderLoginButton(el: HTMLElement, onDone: (serverSave: SaveData) => void): Promise<void> {
  if (!authAvailable()) return;
  await loadGis();
  const g = (window as unknown as { google: GisApi }).google;
  g.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: (r) => { void exchange(r.credential, onDone); },
  });
  el.innerHTML = '';
  // 눈에 보이지 않는 버튼이다 (그림 속 「로그인」 칸 위에 투명하게 덮인다).
  // 알약형(pill)은 모서리가 둥글어 칸 구석이 안 눌리므로 반드시 사각형으로.
  g.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'rectangular', width: 260, locale: 'ko' });
}

async function exchange(idToken: string, onDone: (s: SaveData) => void): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw new Error(`auth ${res.status}`);
    const data = (await res.json()) as { token: string; name: string; picture: string; save: SaveData };
    localStorage.setItem(LS_TOKEN, data.token);
    localStorage.setItem(LS_PROFILE, JSON.stringify({ name: data.name, picture: data.picture }));
    localStorage.removeItem(LS_SYNCED); // 새 로그인 → 동기화 다시 묻는다
    onDone(data.save);
  } catch (e) {
    console.error('[auth] 로그인 실패', e);
    alert('로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

/** 서버 세이브 가져오기 (실패하면 null — 게임은 로컬로 계속). */
export async function fetchSave(): Promise<SaveData | null> {
  const t = authToken();
  if (!t) return null;
  try {
    const res = await fetch(`${apiBase()}/api/save`, { headers: { authorization: `Bearer ${t}` } });
    if (res.status === 401) { logout(); return null; } // 세션 만료
    if (!res.ok) return null;
    return ((await res.json()) as { save: SaveData }).save;
  } catch { return null; }
}

/** 서버에 세이브 올리기. 연달아 부르면 마지막 것만 나간다. */
let pushTimer: number | undefined;
export function pushSave(save: SaveData): void {
  const t = authToken();
  if (!t) return;
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    void fetch(`${apiBase()}/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ save }),
    }).catch(() => { /* 오프라인이어도 로컬은 이미 저장됨 */ });
  }, 400);
}
