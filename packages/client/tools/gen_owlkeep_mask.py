"""
「올빼미 성채」(캠페인 5) 통행 마스크 생성기.

지상은 뱀처럼 굽이치는 회랑을 끝까지 걸어야 하지만, 비행은 마스크를 통째로
무시하고(battle.ts moveToward — 마스크 맵에선 비행에 isWalkable 을 걸지 않는다)
곧장 날아간다. 그 차이를 「5배 이상」으로 맞추는 것이 이 맵의 전부라, 마스크를
손으로 그리지 않고 여기서 만들고 같은 BFS 로 실제 배수를 재서 확인한다.

격자 규약은 data.ts MapDef.mask 와 같다:
  행(row) = 진행축 x, 열(col) = 폭 y, '.' 통행 가능 / '#' 막힘.

실행: python packages/client/tools/gen_owlkeep_mask.py
"""
from collections import deque

CPT = 2                 # 타일당 격자 칸
LEN_T = 68              # 진행축 길이 (타일)
WID_T = 36              # 폭 (타일) = halfW 18 * 2
ROWS, COLS = LEN_T * CPT, WID_T * CPT

# 회랑 폭. 굽이 간격이 6타일이라 이 값이 곧 「벽 두께 = 6 - 폭」이다.
# 3.0 이면 벽이 3타일뿐이라 엘프 궁수(사거리 4.5)가 옆 회랑을 관통 사격했다.
# 2.5 로 좁혀 벽을 3.5타일 확보 — 회랑 중앙에서 옆 회랑 가장자리까지 4.75타일.
CORRIDOR_T = 2.5
PAD_T = 2.0             # 좌우 끝 여백 (타일)
CAMP_LO_T = 10.0        # 아래(아군) 개활지 끝 — 넥서스·스폰이 여기 든다
CAMP_HI_T = 58.0        # 위(적) 개활지 시작
NEXUS_HI_T = 64.0       # 적 넥서스 x (MapDef.nexusX[1])
SPAWN_LO_T = 7.0        # 아군 스폰 x (MapDef.spawnX[0])
BANDS = 8               # 굽이 개수 (7 은 4.7배로 모자랐다 — 5배 기준을 넘기려면 8)

t = lambda v: int(round(v * CPT))


def build() -> list[list[str]]:
    g = [['#'] * COLS for _ in range(ROWS)]

    def box(r0, r1, c0, c1):
        for r in range(max(0, r0), min(ROWS, r1)):
            for c in range(max(0, c0), min(COLS, c1)):
                g[r][c] = '.'

    pad = t(PAD_T)
    half = t(CORRIDOR_T / 2)

    # 양 끝 개활지 — 넥서스가 서고 부대가 모이는 자리
    box(0, t(CAMP_LO_T), pad, COLS - pad)
    box(t(CAMP_HI_T), ROWS, pad, COLS - pad)

    # 굽이 회랑: 폭을 가로지르는 띠 + 양끝을 번갈아 잇는 세로 연결로
    span = t(CAMP_HI_T) - t(CAMP_LO_T)
    step = span / BANDS
    centers = [t(CAMP_LO_T) + int(step * (i + 0.5)) for i in range(BANDS)]
    for i, rc in enumerate(centers):
        box(rc - half, rc + half, pad, COLS - pad)

    # 연결로: 짝수 굽이는 왼쪽 끝, 홀수는 오른쪽 끝에서 위 굽이로 오른다.
    # 개활지 <-> 첫/마지막 굽이도 같은 방식으로 잇는다.
    knots = [t(CAMP_LO_T) - 1] + centers + [t(CAMP_HI_T) + 1]
    for i in range(len(knots) - 1):
        c0 = pad if i % 2 == 0 else COLS - pad - t(CORRIDOR_T)
        box(knots[i], knots[i + 1] + 1, c0, c0 + t(CORRIDOR_T))

    # 굽이 띠는 연결로 쪽 끝만 열려야 한다 — 반대쪽 끝을 막아 지름길을 없앤다.
    for i, rc in enumerate(centers):
        # i 번 띠는 아래(i)·위(i+1) 연결로와 만난다. 두 연결로가 같은 쪽이면
        # 그 띠는 왕복이 없으니 반대쪽을 잘라 준다.
        lo_left = (i % 2 == 0)
        hi_left = ((i + 1) % 2 == 0)
        if lo_left == hi_left:
            cut = COLS - pad - t(CORRIDOR_T) if lo_left else pad
            for r in range(rc - half, rc + half):
                for c in (range(cut, COLS) if lo_left else range(0, cut + t(CORRIDOR_T))):
                    g[r][c] = '#'
    return g


def measure(g):
    """팀 0 기준 지상 BFS 거리 vs 직선 비행 거리 (타일)."""
    # data.ts flowFieldOf 와 같은 방식: 목표 넥서스 줄에서 씨앗을 뿌린다
    goal_row = min(ROWS - 1, t(NEXUS_HI_T))
    dist = [[-1] * COLS for _ in range(ROWS)]
    q = deque()
    for dr in range(4):
        for r in ({goal_row} if dr == 0 else {goal_row - dr, goal_row + dr}):
            if 0 <= r < ROWS:
                for c in range(COLS):
                    if g[r][c] == '.' and dist[r][c] == -1:
                        dist[r][c] = 0
                        q.append((r, c))
        if q:
            break
    while q:
        r, c = q.popleft()
        for nr, nc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if 0 <= nr < ROWS and 0 <= nc < COLS and g[nr][nc] == '.' and dist[nr][nc] == -1:
                dist[nr][nc] = dist[r][c] + 1
                q.append((nr, nc))
    # 아군 스폰 자리 (x 9 타일, 폭 중앙)
    sr, sc = t(SPAWN_LO_T), COLS // 2
    if g[sr][sc] != '.':
        sc = next(c for c in range(COLS) if g[sr][c] == '.')
    ground = dist[sr][sc] / CPT
    air = (goal_row - sr) / CPT
    return ground, air, dist[sr][sc] >= 0


def main():
    g = build()
    ground, air, ok = measure(g)
    print(f"격자 {ROWS}x{COLS} (타일당 {CPT}칸), 굽이 {BANDS}개")
    print(f"지상 경로 {ground:.1f}타일 / 비행 직선 {air:.1f}타일 -> {ground / air:.2f}배")
    if not ok:
        raise SystemExit("경로가 끊겼다 — 연결로를 확인할 것")
    if ground / air < 5:
        raise SystemExit(f"5배 미달 ({ground / air:.2f}) — BANDS 를 올려라")
    data = ''.join(''.join(row) for row in g)
    assert len(data) == ROWS * COLS
    open_frac = data.count('.') / len(data)
    print(f"통행 칸 {open_frac * 100:.1f}%")
    with open('packages/client/tools/owlkeep_mask.txt', 'w') as f:
        f.write(data)
    print("-> packages/client/tools/owlkeep_mask.txt")
    # 눈으로 보는 축약도 (4칸을 1글자로)
    for r in range(0, ROWS, 4):
        print(''.join('.' if any(g[r][c + k] == '.' for k in range(min(4, COLS - c)))
                      else '#' for c in range(0, COLS, 4)))


if __name__ == '__main__':
    main()
