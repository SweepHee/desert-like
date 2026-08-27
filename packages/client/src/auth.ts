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
  /** 유닛별 강화 — 슬롯이 둘로 늘면서 배열이 됐다. 예전 저장본은 문자열 하나. */
  boons: Record<string, string | string[]>;
  updatedAt: number;
}

export interface Profile {
  /** 구글 계정 고유 id (서버가 준다). 예전 서버는 안 줄 수 있어 선택. */
  uid?: string;
  name: string;
  picture: string;
  /** 미공개 콘텐츠(3막) 테스터인가 — 서버의 이메일 화이트리스트가 정한다. */
  tester?: boolean;
}

const LS_TOKEN = 'dl_auth_token';
const LS_PROFILE = 'dl_auth_profile';
/** 이 계정과 이미 동기화를 끝냈는지 (스테이지 진입 때마다 묻지 않도록). */
const LS_SYNCED = 'dl_auth_synced';
/**
 * 이 기기에 저장된 진행 상황이 「어느 계정 것인가」.
 *
 * localStorage 는 기기 단위라 계정을 바꿔 로그인해도 앞 계정의 진행이 그대로
 * 남아 있다. 표식이 없던 시절에는 새 계정이 비어 있으면 묻지도 않고 그걸
 * 그대로 올려 버려서, 남의 기록이 새 계정에 통째로 복사됐다.
 */
const LS_SAVE_OWNER = 'dl_save_owner';

// trim 필수 — 환경변수를 붙여넣을 때 끝에 개행이 딸려 오면 그대로 구워져서
// 구글이 client_id 를 '...com%0A' 로 받고 400(invalid_request)을 돌려준다
const CLIENT_ID = ((import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim();

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

/** 미공개 콘텐츠(3막) 접근 가능 계정인가. */
export function isTester(): boolean {
  return profile()?.tester === true;
}

/** 지금 로그인한 계정의 고유 id (모르면 null). */
export function accountUid(): string | null {
  return profile()?.uid ?? null;
}

/** 이 기기 진행 상황의 주인 계정 id (로그인 전 기록이면 null). */
export function saveOwner(): string | null {
  try { return localStorage.getItem(LS_SAVE_OWNER); } catch { return null; }
}

export function setSaveOwner(uid: string | null): void {
  try {
    if (uid) localStorage.setItem(LS_SAVE_OWNER, uid);
    else localStorage.removeItem(LS_SAVE_OWNER);
  } catch { /* 무시 */ }
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

interface TokenResponse { access_token?: string; error?: string }
interface TokenClient { requestAccessToken(): void }
interface GisApi {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: unknown) => void;
      }): TokenClient;
    };
  };
}

/**
 * 로그인 팝업을 여는 준비물.
 *
 * 공식 「Google 로그인」 버튼(renderButton)은 크로스 오리진 iframe 이라
 * 우리 UI 와 섞이지 않는다 — 마우스 이벤트도 안 넘어오고, 밖에서 눌러 줄 수도
 * 없다. 그래서 커스텀 버튼을 공식적으로 허용하는 OAuth2 토큰 플로우를 쓴다.
 *
 * 팝업 차단을 피하려면 클릭 핸들러 안에서 곧바로 requestAccessToken() 이
 * 불려야 하므로(비동기 대기 금지), 클라이언트는 화면이 뜰 때 미리 만들어 둔다.
 */
let tokenClient: TokenClient | null = null;
let loginDone: ((s: SaveData) => void) | null = null;

/** 페이지가 뜰 때 미리 불러 둔다 — 클릭 시점에는 기다릴 시간이 없다. */
export async function prepareLogin(onDone: (serverSave: SaveData) => void): Promise<void> {
  loginDone = onDone;
  if (!authAvailable() || tokenClient) return;
  await loadGis();
  const g = (window as unknown as { google: GisApi }).google;
  tokenClient = g.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: 'openid email profile',
    callback: (r) => {
      if (!r.access_token) { console.error('[auth] 토큰 없음', r.error); return; }
      void exchange(r.access_token, (save) => loginDone?.(save));
    },
    error_callback: (e) => { console.error('[auth] 로그인 취소/실패', e); },
  });
}

/** 로그인 팝업을 연다. 반드시 클릭 핸들러에서 곧바로 부를 것. */
export function startLogin(): boolean {
  if (!tokenClient) return false; // 아직 준비 전 — 호출부가 안내를 띄운다
  tokenClient.requestAccessToken();
  return true;
}

async function exchange(accessToken: string, onDone: (s: SaveData) => void): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    if (!res.ok) {
      // 서버가 알려준 실패 사유를 그대로 붙여 둔다 (aud_mismatch / tokeninfo_400 …)
      const why = await res.json().then((d: { reason?: string }) => d.reason).catch(() => undefined);
      throw new Error(`auth ${res.status}${why ? ` (${why})` : ''}`);
    }
    const data = (await res.json()) as {
      token: string; uid?: string; name: string; picture: string; tester?: boolean; save: SaveData;
    };
    localStorage.setItem(LS_TOKEN, data.token);
    localStorage.setItem(LS_PROFILE, JSON.stringify({
      uid: data.uid, name: data.name, picture: data.picture, tester: data.tester === true,
    }));
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
    const data = (await res.json()) as { save: SaveData; uid?: string; tester?: boolean };
    const pr = profile();
    if (pr && (pr.tester !== (data.tester === true) || (data.uid && pr.uid !== data.uid))) {
      // 화이트리스트 변경·uid 를 다음 접속에 반영하도록 프로필을 최신화
      localStorage.setItem(LS_PROFILE, JSON.stringify({
        ...pr, uid: data.uid ?? pr.uid, tester: data.tester === true,
      }));
    }
    return data.save;
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
