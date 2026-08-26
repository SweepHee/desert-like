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
- **장판**: `ZONE_DEFS` — dps/slow/healBio/pull/hitsAir 에 더해 `poison`(역병 늪). poison 은 장판이 직접 깎지 않고 **밟은 적에게 독 상태이상을 옮긴다** — 장판을 벗어나도 남으므로 「물러서기」가 답이 아니게 된다.
- **해금 스킬**: `ActiveSkill.requiresUpgrade` — 업그레이드 구매 시 사용 가능 (세이지 마법 3종, 앨리스 인형의 실, 태엽 감기).
- **넥서스**: 방어 28(기본 유닛 평타=1), 수호자 생존 중 무적.
- **봇 AI**: 난이도 3단계(easy/normal=인컴 이점/hard=미러링+카운터픽) + 성격 4유형 시드 배정. `incomeCap`/`techCap`/`enemyPreferredUnits`는 GameConfig 옵션.
- **타이틀 화면** (`packages/client/src/title.ts`): 종족 아트 4종(실바린·판데모니엄·마리오네타·카르자, `/assets/ui/title_*.jpg`) 중 하나가 접속마다 랜덤(직전 것 제외). **메뉴 버튼이 그림에 그려져 있어** 그 위에 투명 핫스팟을 얹어 클릭을 받는다 — 좌표는 원본 아트 767×511 기준 픽셀(변종별 `menu: {x, w, tops[5], hs[5]}`, 아트마다 위치·크기가 다름)이므로 아트를 새로 뽑으면 반드시 다시 재야 한다. 메뉴 5칸 = 캠페인 / 연습 / 대전 / **로그인** / 종료. 로그인 칸은 구글 공식 버튼(GIS)을 그 위에 투명하게 덮어 클릭을 받고(커스텀 버튼으로는 팝업 불가), 칸보다 크게 덮은 뒤 `overflow:hidden` 으로 잘라 구석까지 눌리게 한다. 로그인하면 그 칸이 계정 이름 패널(`#tl-me`)로 바뀐다. 고른 아트는 이후 메뉴 화면의 흐린 배경(`--title-art`)과 강조색(`--tt-rgb` → `#overlay`의 `--gold`)으로 이어진다. 메뉴 4개 → 캠페인 목록 / 연습 종족선택 / 대전 로비 / 작별 화면.
- **맵** (`data.ts MAPS`): 기본 `plains`(잿불 숲) 외 valley/greedvalley/nest/confluence/toybox/greatroot/ashroad + **`mire`**(4 독 늪 — 그림만 늪, 형태는 기본형) · **`owlkeep`**(5 굽이치는 세로 맵 — 마스크). 마스크 맵은 지상만 `isWalkable`/흐름장에 걸리고 **비행은 마스크를 통째로 무시**한다(`battle.ts` moveToward) — owlkeep 의 「지상 121타일 vs 비행 45타일(2.69배)」이 이 성질 위에 서 있다 (거기에 진흙·덩굴이 지상만 붙잡아 체감은 더 벌어진다). 마스크는 손그림이 아니라 작가 지형에서 `packages/client/tools/gen_owlkeep2.py`(owlkeep) · `gen_village.py`+`gen_village2.py`(village) 가 굽고, 배수는 skill-check 가 잠근다.
- **흐름장**: 마스크 맵의 지상 경로는 벽까지의 거리로 통행 비용을 매긴 다익스트라다(`data.ts dialField`) — 순수 BFS 면 최단거리라 부대가 절벽에 딱 붙어 걷는다(실측 벽까지 0.69타일 → 1.40타일). 그래서 **흐름장 값은 거리가 아니다**. 「지상 몇 타일」을 재려면 `maskStepsOf`(비용 없는 BFS)를 써야 한다.
- **캠페인** (`packages/client/src/campaign.ts`): 실바린 「자정의 세계수」 18스테이지(14까지 공개). 대화(포트레이트 11종 `/assets/portraits/`) + 컷신 그림(`DialogueLine.img` — `/assets/cutscenes/`, '' 로 해제), localStorage 진행/특성 저장, 미션 destroy/survive/tower/boss + **호위전**(13: `escort` = 거점 5개 순차 점령·마차 후퇴·holdLineX 전선, `obstacles` = 무적 소품 길막(speed 0 은 충돌 분리에서 안 밀림, 비행은 통과)). noTowers·warcamp·스폰 스크립트·mapId(toybox/ashroad 등) 옵션. 시나리오 원본: `docs/campaign-sylvarin.md`.

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
