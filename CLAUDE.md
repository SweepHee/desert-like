# Desertlike — 프로젝트 컨텍스트

Desert Strike 스타일 3v3 웹 전략 게임. 유닛 구매 → 60초마다 자동 출정 → 수호탑 → 수호자(중간보스) → 넥서스 파괴.

## 아키텍처 (모노레포)

- `packages/sim` — **결정론 시뮬 코어**. 20Hz 고정 틱, 정수 고정소수점(FP=1000/타일), mulberry32 시드 RNG.
  - **결정론 규칙 (절대 위반 금지)**: entities 배열 순서 그대로 순회, 정렬 금지, 거리 동률은 배열 앞쪽 승리(strict <), 모든 좌표 연산은 정수(`math.ts`의 idiv/isqrt), 부동소수점·Date.now()·Math.random() 금지 (봇은 `botRng`, 전투는 `g.rng`).
  - 멀티플레이 = 명령 릴레이: 서버는 시드·좌석·명령 스트림·틱 시계만 중계, 모든 클라이언트가 같은 심을 로컬 실행.
- `packages/client` — PixiJS v8 렌더러 + UI. Wang 16타일 오토타일링, 캠페인은 클라 레이어(sim 위 스크립트).
- `packages/server` — WebSocket 릴레이 (sim 미사용).

## 배포

- 클라이언트: **Vercel** (`vercel.json`이 client만 빌드) → https://desertlike.vercel.app — `npx vercel --prod --yes`
- 서버: **Railway** (`railway.json`, `npm run server`) → wss://desertlike-server-production.up.railway.app (Vercel env `VITE_SERVER_URL`)
- 주의: 한국어 사용자명 경로에서 vite 빌드가 죽는 Windows 이슈 있었음 (Vercel 빌드는 무관).

## 검증 (수정 후 반드시 실행)

```
npx tsx packages/sim/src/cli/determinism.ts   # 결정론 해시 (필수)
npx tsx packages/sim/src/cli/skill-check.ts   # 스킬/규칙 110+ assertion
npx tsx packages/sim/src/cli/bot-check.ts     # 봇 AI 8 assertion
npx tsx packages/sim/src/cli/duel.ts "a:n" "b:m" [seed]  # 동가치 밸런스 듀얼
npx tsx packages/sim/src/cli/battle.ts [seed] # 풀 게임 헤드리스
```
밸런스 비교는 반드시 여러 시드(5+)로 — 단일 시드는 RNG 재배열 노이즈.

## 핵심 시스템 요약

- **종족 3**: 실바린(숲/회복) · 판데모니엄(망자/흡혈/소환) · 마리오네타(인형/태엽).
- **상태이상**: 둔화·독·속박·기절·혼란(자기 편 공격)·수면(3피격 해제)·빙결·약화·한기·공포(도주)·지상화(리버스그라비티)·반사. 수호자(guardian 티어)는 전면 면역.
- **해금 스킬**: `ActiveSkill.requiresUpgrade` — 업그레이드 구매 시 사용 가능 (세이지 마법 3종, 앨리스 인형의 실, 태엽 감기).
- **넥서스**: 방어 28(기본 유닛 평타=1), 수호자 생존 중 무적.
- **봇 AI**: 난이도 3단계(easy/normal=인컴 이점/hard=미러링+카운터픽) + 성격 4유형 시드 배정. `incomeCap`/`techCap`/`enemyPreferredUnits`는 GameConfig 옵션.
- **캠페인** (`packages/client/src/campaign.ts`): 실바린 「자정의 세계수」 18스테이지. 대화(포트레이트 11종 `/assets/portraits/`), localStorage 진행/특성 저장, 미션 3종(destroy/survive≥15분/tower), noTowers·warcamp(협공)·스폰 스크립트(c_* 특수유닛 7종)·mapId(toybox=2막 장난감 나라) 옵션. 시나리오 원본: `docs/campaign-sylvarin.md`.

## 에셋 파이프라인 (픽셀랩 MCP)

- 인간형 = standard 모드 / 비인간형(용·유령·기계·나무) = **v3 모드 필수** (standard는 사람으로 만듦).
- low top-down, 8방향. east = 전장 스프라이트, south = 상점 아이콘(`<id>_icon.png`).
- 무기 유닛은 공격 4프레임(`<id>_atk0-3`), 비행 유닛은 부유 4프레임(`<id>_fly0-3`) 세트로 생성 — 9프레임 생성물에서 0,2,4,6 추출.
- **애니메이션 URL의 폴더는 그룹 id가 아니라 별도 id — 반드시 get_character로 실제 URL 확인.**
- 신유닛 등록 체크리스트: render.ts(ASSET_UNITS/ICONS/ATTACK_ANIMS/FLAP/PROJECTILE) + **sprites.ts LOOK 폴백** (누락 시 예전엔 게임 시작 크래시였음 — 지금은 폴백 있지만 등록 권장).

## 열린 이슈

1. **캠페인 8스테이지 「태엽 공방」 클리어 불가**: 적 봇이 시계탑 톱니바퀴를 뽑으면 「자정의 종소리」 광역 공포가 유저 부대를 계속 도주시킴. 이 시점(가시마녀까지 해금)엔 해제 수단(유니콘 큐어) 없음. 후보안: 공포 너프 / 8스테이지 톱니바퀴 금지(적 유닛 금지 목록 기능 신설) / 유니콘 해금 앞당기기.
2. 밴시가 저가 망령보다 약함 (버프 미결).
3. 멀티 새로고침 재접속 디싱크 잔여 가능성.

## 작업 규칙

- 유저와 한국어로 대화. 수정 후 회귀 돌리고 요청 시 즉시 Vercel 배포.
- 봇전은 무조건 3:3. 멀티만 1:1~3:3 가변.
- 커밋은 유저가 요청할 때만.
