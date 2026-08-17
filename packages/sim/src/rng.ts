/**
 * 결정론적 난수 생성기 (mulberry32).
 *
 * Math.random() 은 시뮬레이션 안에서 절대 쓰지 않는다. 상태가 32비트 정수
 * 하나뿐이라 월드 스냅샷에 그대로 직렬화되고, 같은 시드 + 같은 명령이면
 * 언제 어디서 돌려도 같은 전투가 재생된다.
 *
 * 모든 연산이 Math.imul / 비트연산 기반이라 플랫폼 간 동일하다.
 */
export interface Rng {
  /** 32비트 부호없는 내부 상태. 스냅샷에 포함되어야 한다. */
  s: number;
}

export function createRng(seed: number): Rng {
  // 시드 0 은 초반 출력이 편향되므로 밀어준다.
  return { s: (seed | 0) === 0 ? 0x9e3779b9 : seed | 0 };
}

export function cloneRng(rng: Rng): Rng {
  return { s: rng.s };
}

/** 0 이상 2^32 미만의 정수. */
export function nextU32(rng: Rng): number {
  rng.s = (rng.s + 0x6d2b79f5) | 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** [0, maxExclusive) 범위의 정수. maxExclusive 는 양의 정수여야 한다. */
export function nextInt(rng: Rng, maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  return nextU32(rng) % maxExclusive;
}

/** [lo, hi] 범위의 정수 (양끝 포함). */
export function nextRange(rng: Rng, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + nextInt(rng, hi - lo + 1);
}

/** 백분율 확률 판정. chancePercent 가 0 이면 항상 false, 100 이면 항상 true. */
export function nextChance(rng: Rng, chancePercent: number): boolean {
  if (chancePercent <= 0) return false;
  if (chancePercent >= 100) return true;
  return nextInt(rng, 100) < chancePercent;
}
