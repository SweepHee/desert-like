/**
 * 결정론적 고정소수점 산술.
 *
 * 이 시뮬레이션의 상태에는 부동소수점이 절대 들어가지 않는다. 모든 위치·속도·
 * 거리는 정수이고, 1 타일 = FP(1000) 단위다. JS의 number 는 double 이지만
 * 2^53 이하의 정수 연산은 정확하므로, 정수만 유지하는 한 플랫폼 간 결과가
 * 완전히 동일하다. 이게 나중에 서버-클라 재현(그리고 리플레이)의 근거가 된다.
 *
 * 규칙:
 *  - 나눗셈은 반드시 idiv() 를 쓴다. (`a / b` 는 소수를 만든다)
 *  - 거리 비교는 제곱값끼리 비교한다. (sqrt 를 피한다)
 *  - 길이가 꼭 필요하면 isqrt() 를 쓴다.
 */

/** 고정소수점 스케일. FP 단위 1000 = 1 타일. */
export const FP = 1000;

/** 시뮬레이션 틱 레이트. 렌더 프레임레이트와 무관하게 고정. */
export const TICK_HZ = 20;

/** 타일 단위 실수를 FP 정수로. 상수 정의용이며 시뮬 런타임에서는 쓰지 않는다. */
export function tiles(n: number): number {
  return Math.round(n * FP);
}

/** 초 단위를 틱 수로. 상수 정의용. */
export function seconds(n: number): number {
  return Math.max(1, Math.round(n * TICK_HZ));
}

/** 타일/초 속도를 FP/틱 으로. 상수 정의용. */
export function tilesPerSecond(n: number): number {
  return Math.round((n * FP) / TICK_HZ);
}

/** FP 정수를 타일 실수로. 렌더링·로그 출력 전용 — 시뮬 내부에서 쓰지 말 것. */
export function toTiles(v: number): number {
  return v / FP;
}

/**
 * floor 나눗셈. 음수에서도 방향이 일정해야 결정론이 유지되므로
 * 절단(truncation)이 아니라 항상 floor 로 고정한다.
 */
export function idiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/**
 * 정수 제곱근 (floor).
 *
 * Math.sqrt 는 IEEE-754 상 정확히 반올림되지만, floor 를 씌우면 완전제곱수
 * 근처에서 1 만큼 어긋날 수 있다. 뉴턴식 보정으로 값을 확정한다.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x > 0 && x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 제곱 거리. 좌표가 FP 단위이므로 결과는 FP^2 단위다. */
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
