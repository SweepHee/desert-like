/**
 * 효과음 재생기 (Web Audio).
 *
 * 이 게임은 20Hz 틱에 유닛 100기 이상이 동시에 교전한다. 이벤트마다 그대로
 * 소리를 내면 초당 수백 개가 겹쳐 굉음이 되므로, 재생 자체보다 "덜어내기"가
 * 이 모듈의 본체다:
 *
 *  - 중복 억제: 같은 소리가 짧은 창 안에 몰리면 한 번만 내고 살짝 키운다
 *  - 동시발음 제한: 전체 / 키별 상한을 두고 넘치면 버린다
 *  - 화면 밖 차단 + 거리 감쇠 + 좌우 팬
 *  - 음높이 미세 랜덤화 (같은 파일 반복 재생이 기계음처럼 들리는 것 방지)
 *
 * 결정론과 무관하다. 시뮬레이션은 이 모듈을 전혀 참조하지 않는다.
 * 음원 파일이 없으면 조용히 무시하므로, 소리를 아직 안 넣은 키를 불러도 안전하다.
 */

/** 효과음 키 → 후보 파일. 여러 개면 재생할 때마다 무작위로 고른다. */
const SFX: Record<string, readonly string[]> = {
  // 공격
  atk_melee: ['/assets/sfx/atk_melee1.mp3', '/assets/sfx/atk_melee2.mp3'],
  atk_ranged: ['/assets/sfx/atk_ranged1.mp3', '/assets/sfx/atk_ranged2.mp3'],
  atk_magic: ['/assets/sfx/atk_magic1.mp3', '/assets/sfx/atk_magic2.mp3'],
  // 피격 — 대상의 장갑·존재 태그에 따라 갈린다 (특성 시스템 재활용)
  hit_cloth: ['/assets/sfx/hit_cloth1.mp3', '/assets/sfx/hit_cloth2.mp3'],
  hit_leather: ['/assets/sfx/hit_leather1.mp3', '/assets/sfx/hit_leather2.mp3'],
  hit_plate: ['/assets/sfx/hit_plate1.mp3', '/assets/sfx/hit_plate2.mp3'],
  hit_construct: ['/assets/sfx/hit_construct1.mp3', '/assets/sfx/hit_construct2.mp3'],
  // 사망
  death_bio: ['/assets/sfx/death_bio1.mp3', '/assets/sfx/death_bio2.mp3'],
  death_undead: ['/assets/sfx/death_undead1.mp3'],
  death_construct: ['/assets/sfx/death_construct1.mp3'],
  // 시전·폭발
  cast_heal: ['/assets/sfx/cast_heal1.mp3'],
  cast_skill: ['/assets/sfx/cast_skill1.mp3'],
  explosion: ['/assets/sfx/explosion1.mp3', '/assets/sfx/explosion2.mp3'],
  // 게임 흐름
  wave: ['/assets/sfx/wave.mp3'],
  tower_down: ['/assets/sfx/tower_down.mp3'],
  victory: ['/assets/sfx/victory.mp3'],
  defeat: ['/assets/sfx/defeat.mp3'],
  // UI
  ui_buy: ['/assets/sfx/ui_buy.mp3'],
  ui_deny: ['/assets/sfx/ui_deny.mp3'],
  ui_click: ['/assets/sfx/ui_click.mp3'],
};

export type SfxKey = keyof typeof SFX;

/** 전체 동시발음 상한. 넘으면 새 소리를 버린다. */
const MAX_VOICES = 24;
/** 같은 키의 동시발음 상한. */
const MAX_PER_KEY = 4;
/** 같은 키가 이 시간(ms) 안에 다시 오면 합친다. */
const DEDUPE_MS = 45;

export interface PlayOpts {
  /** 월드 화면 x (px). 주면 좌우 팬과 거리 감쇠가 적용된다. */
  screenX?: number;
  /** 0~1 추가 배율. */
  volume?: number;
  /** 음높이 배율 (1 = 원음). 미지정 시 ±8% 랜덤. */
  pitch?: number;
}

export interface Audio {
  play(key: SfxKey, opts?: PlayOpts): void;
  /** 카메라 가시 범위를 알려준다 (화면 밖 소리 차단·팬 계산용). */
  setViewport(x0: number, x1: number): void;
  setVolume(v: number): void;
  getVolume(): number;
  setMuted(m: boolean): void;
  isMuted(): boolean;
  /** 브라우저 자동재생 정책상 첫 사용자 입력에서 한 번 불러야 소리가 난다. */
  unlock(): void;
}

const LS_VOLUME = 'dl_sfx_volume';
const LS_MUTED = 'dl_sfx_muted';

export function createAudio(): Audio {
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  let volume = clamp01(Number(localStorage.getItem(LS_VOLUME) ?? '0.6'));
  let muted = localStorage.getItem(LS_MUTED) === '1';
  let view0 = -Infinity;
  let view1 = Infinity;

  // AudioContext 는 첫 사용자 입력 전까지 만들지 않는다 (자동재생 정책 경고 방지)
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  const buffers = new Map<string, AudioBuffer | null>(); // null = 로드 실패(=무음)
  const loading = new Set<string>();

  /** 재생 중인 소리 수. 키별 + 전체. */
  let voices = 0;
  const perKey = new Map<string, number>();
  const lastPlayed = new Map<string, number>();

  function ensureCtx(): AudioContext | null {
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
    }
    return ctx;
  }

  async function loadOne(url: string): Promise<void> {
    if (buffers.has(url) || loading.has(url)) return;
    const c = ensureCtx();
    if (!c) return;
    loading.add(url);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      buffers.set(url, await c.decodeAudioData(await res.arrayBuffer()));
    } catch {
      buffers.set(url, null); // 파일 없음 → 이 키는 조용히 무음 처리
    } finally {
      loading.delete(url);
    }
  }

  /** 첫 입력 시점에 전체 음원을 미리 받아둔다 (교전 중 첫 재생이 늦지 않도록). */
  function preloadAll(): void {
    for (const urls of Object.values(SFX)) {
      for (const u of urls) void loadOne(u);
    }
  }

  return {
    unlock() {
      const c = ensureCtx();
      if (!c) return;
      if (c.state === 'suspended') void c.resume();
      preloadAll();
    },

    setViewport(x0, x1) {
      view0 = x0;
      view1 = x1;
    },

    play(key, opts = {}) {
      if (muted || volume <= 0) return;
      const c = ctx;
      const m = master;
      if (!c || !m || c.state !== 'running') return; // 아직 unlock 전

      const now = performance.now();

      // 중복 억제: 짧은 창 안의 같은 소리는 한 번만 (대신 약간 크게)
      const last = lastPlayed.get(key) ?? -1e9;
      const merged = now - last < DEDUPE_MS;
      if (merged) return;

      // 동시발음 상한
      const kc = perKey.get(key) ?? 0;
      if (voices >= MAX_VOICES || kc >= MAX_PER_KEY) return;

      // 화면 밖이면 버린다. 화면 안이면 중심에서 멀수록 조금 작게 + 좌우 팬.
      let pan = 0;
      let dist = 1;
      if (opts.screenX !== undefined && view0 > -Infinity) {
        const x = opts.screenX;
        const margin = (view1 - view0) * 0.15;
        if (x < view0 - margin || x > view1 + margin) return;
        const t = (x - view0) / Math.max(1, view1 - view0); // 0..1
        pan = clamp(t * 2 - 1, -1, 1);
        dist = 1 - Math.min(1, Math.abs(pan)) * 0.35;
      }

      // 변형 중 실제로 준비된 것만 고른다. 아직 안 만든 변형이 섞여 있어도
      // 무음이 되지 않고, 있는 소리로 계속 재생된다.
      const urls = SFX[key];
      if (!urls || urls.length === 0) return;
      const ready = urls.filter((u) => buffers.get(u));
      if (ready.length === 0) {
        for (const u of urls) if (!buffers.has(u)) void loadOne(u);
        return;
      }
      const url = ready[(Math.random() * ready.length) | 0]!;
      const buf = buffers.get(url)!;

      lastPlayed.set(key, now);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = opts.pitch ?? 1 + (Math.random() - 0.5) * 0.16;

      const g = c.createGain();
      g.gain.value = clamp01((opts.volume ?? 1) * dist);

      // StereoPanner 미지원 브라우저는 팬 없이 재생
      const panner = typeof c.createStereoPanner === 'function' ? c.createStereoPanner() : null;
      if (panner) {
        panner.pan.value = pan;
        src.connect(g).connect(panner).connect(m);
      } else {
        src.connect(g).connect(m);
      }

      voices++;
      perKey.set(key, kc + 1);
      src.onended = () => {
        voices--;
        perKey.set(key, Math.max(0, (perKey.get(key) ?? 1) - 1));
      };
      src.start();
    },

    setVolume(v) {
      volume = clamp01(v);
      localStorage.setItem(LS_VOLUME, String(volume));
      if (master) master.gain.value = muted ? 0 : volume;
    },
    getVolume: () => volume,
    setMuted(mm) {
      muted = mm;
      localStorage.setItem(LS_MUTED, mm ? '1' : '0');
      if (master) master.gain.value = mm ? 0 : volume;
    },
    isMuted: () => muted,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}
