---
target: 현재 PR의 Overlay/최소화 작업 UI 개선사항
total_score: 28
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-08-03T15-36-55Z
slug: packages-overlay-src-index-tsx
---
Method: dual-agent (A: impeccable_design_review_final · B: impeccable_detector)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | 연결, 단계, 진행선, 로그, 파일, 검증 상태가 이어져 비동기 작업을 잘 설명한다. |
| 2 | Match System / Real World | 3 | Flight Strip 비유는 적합하지만 TASK/DISPATCH/QUEUE 등 내부 용어가 그대로 노출된다. |
| 3 | User Control and Freedom | 3 | 최소화·펼치기·취소·유지·후속 수정·되돌리기를 제공하지만 고위험 동작의 결과가 충분히 설명되지 않는다. |
| 4 | Consistency and Standards | 3 | 시각 체계는 일관되지만 한국어와 영어 용어 및 링크/버튼 의미가 섞인다. |
| 5 | Error Prevention | 2 | 취소와 되돌리기가 즉시 실행되며, 어떤 변경이 영향을 받는지 사전 확인이 없다. |
| 6 | Recognition Rather Than Recall | 3 | 요청과 상태를 계속 보여주지만 축약된 요청·Task ID만으로 비슷한 작업을 구별하기 어렵다. |
| 7 | Flexibility and Efficiency | 2 | 네 가지 선택 방식과 최소화는 효율적이지만 단축키나 빠른 모드 전환은 드러나지 않는다. |
| 8 | Aesthetic and Minimalist Design | 3 | 점진적 공개는 좋지만 최소화 카드의 10px 메타데이터와 검토 단계의 선택지가 조밀하다. |
| 9 | Error Recovery | 3 | 오류, 로그, diff, 후속 수정, 되돌리기가 있으나 복구 결과와 다음 단계 설명이 부족하다. |
| 10 | Help and Documentation | 2 | 각 버튼의 로컬 라벨은 있으나 선택 모드와 작업 수명주기의 차이를 화면 안에서 설명하지 않는다. |
| **Total** | | **28/40** | **Good — 기반은 견고하지만 고위험 동작과 최소화 위계를 다듬어야 한다.** |

## Design Specificity Verdict

**LLM assessment:** 제품에 맞게 작성된 UI다. graphite 장비판, warm strip, phase mark, route line, task identity가 “화면 위에서 코딩 작업을 관제한다”는 목적과 직접 연결돼 있어 일반적인 토스트나 개발자 대시보드와 구별된다. 다만 최소화 카드에서는 사람의 작업 의도보다 project/task 식별자가 시각적으로 경쟁해, 제품 고유의 flight-strip 정보 위계가 약해진다.

**Deterministic scan:** `detect.mjs --json`은 `[]`, 총 0건으로 종료했다. 규칙 위반·파일 위치·오탐은 없었다. 이번 핵심 문제는 정적 안티패턴보다 상태 의미, 정보 위계, 고위험 동작의 명확성에 있다.

**Visual overlays:** 새 headless 브라우저에서 실제 `ai-canvas`의 idle toolbar와 `Bridge 연결됨` 상태까지 확인했다. 다만 HTTPS 페이지에서 `http://localhost:10011/detect.js`를 주입하는 과정이 브라우저의 loopback Private Network Access/CORS 정책에 막혀 detector overlay는 실행되지 않았다. 따라서 사용자 브라우저에 신뢰할 수 있는 `[Human]` overlay는 표시되지 않았다. 실제 active/review task는 새 작업을 만들지 않기 위해 생성하지 않았고, 해당 상태 평가는 구현 소스를 근거로 했다.

## Overall Impression

최소화해도 “지금 작업 중”이라는 사실과 요청 내용이 남는 방향은 맞다. 가장 큰 기회는 compact strip을 기계 식별자 모음이 아니라 **작업 의도 → 현재 단계 → 필요한 다음 행동** 순서로 다시 정리하는 것이다.

## What's Working

- 최소화 상태에서도 phase, 요청, 진행선이 유지돼 이전의 “아예 사라지는” 문제를 정확히 해소한다.
- compact → expanded → work board의 점진적 공개가 감시와 상세 검토를 자연스럽게 분리한다.
- 상태를 색만으로 전달하지 않고 텍스트, `role=status`, 명시적 버튼 라벨, reduced-motion 대응을 함께 둔 접근성 기반이 좋다.

## Priority Issues

### [P1] 최소화 카드의 작업 정체성이 시각 사용자와 스크린리더 사용자에게 다르게 전달된다

**Why it matters:** 화면에는 축약 요청이 보이지만 main button의 `aria-label`은 “현재 단계 + 작업 상세 펼치기”만 포함해 요청 내용이 accessible name에서 사라진다. 시각적으로도 10px project ID·요청·Task ID가 동시에 경쟁하며, 비슷한 요청은 96자 축약만으로 구별하기 어렵다.

**Fix:** phase를 1순위, 사람이 쓴 요청을 2순위로 두고 project/task ID는 상세로 내린다. 버튼 이름은 `aria-labelledby`/`aria-describedby`로 보이는 phase와 전체 요청을 재사용하고, 축약되지 않은 요청을 보조 설명으로 제공한다. compact에는 필요하면 경과 시간이나 대기 상태처럼 의사결정에 유용한 값 하나만 남긴다.

**Suggested command:** `$impeccable clarify`

### [P1] 활성 카드의 `취소`와 검토 단계의 `되돌리기`가 결과 확인 없이 즉시 실행된다

**Why it matters:** compact card 가장자리에 분리된 52px `취소`가 항상 노출되고, `되돌리기`도 영향 파일·복구 범위를 확인하기 전에 실행된다. 실수로 누르면 사용자가 기다린 작업이나 변경을 잃을 수 있다.

**Fix:** “실행 중단”과 “파일 변경 되돌리기”를 명확히 구분한다. 확인 단계에서 작업 요청과 영향 파일 수를 다시 보여주고, 요청 중에는 중복 실행을 막으며, 가능한 경우 복구 경로를 안내한다. compact 카드에는 직접 실행 대신 `작업 중단…`처럼 결과를 예고하는 라벨을 쓴다.

**Suggested command:** `$impeccable harden`

### [P1] 검토 완료 시점의 `변경 유지`와 `닫기` 의미가 겹친다

**Why it matters:** review 상태에서 `변경 유지`, `후속 수정`, `되돌리기`, `닫기`가 한 행에 나타난다. 특히 `닫기`는 task를 끝내는지 패널만 감추는지 버튼 텍스트만으로 알 수 없고, hover title은 터치·키보드 사용자에게 안정적인 설명이 아니다. 검토를 끝냈다고 오해한 채 미결 상태를 남길 수 있다.

**Fix:** `닫기`를 `나중에 검토` 또는 `패널만 닫기`처럼 결과 중심으로 바꾼다. 한 개의 권장 다음 행동만 primary로 유지하고, 후속 수정은 별도 흐름, 되돌리기는 위험 영역, diff는 증거 영역으로 그룹화한다.

**Suggested command:** `$impeccable distill`

### [P2] 모바일 툴바가 가로 스크롤에 의존해 상태와 작업 컨트롤을 숨길 수 있다

**Why it matters:** 600px 이하에서 네 모드, 작업 펼치기, 작업 보드, 연결 상태가 한 줄에 남는다. 기본 스크롤 위치에서는 오른쪽의 연결 상태나 작업 컨트롤이 보이지 않을 수 있고, 스크롤 가능하다는 시각 단서도 없다.

**Fix:** 좁은 화면에서는 선택 모드 그룹만 스크롤시키고 연결 상태와 현재 task 진입점은 고정한다. 또는 모드를 2행/축약 메뉴로 재배치하되 44px target과 현재 모드 표시는 유지한다. 320px, 390px, 200% zoom에서 확인한다.

**Suggested command:** `$impeccable adapt`

### [P2] 최소화 카드가 host 앱의 우측 상단을 고정 점유한다

**Why it matters:** 임의의 앱 위에서 동작하므로 카드가 저장·프로필·내비게이션 같은 host 컨트롤을 가릴 수 있다. 이는 “계속 보여야 한다”는 요구와 “원래 화면을 계속 조작해야 한다”는 요구의 충돌이다.

**Fix:** compact strip에 좌우 dock 전환 또는 drag 위치를 제공하고 마지막 위치를 유지한다. 펼칠 때 viewport 충돌을 감지하고, 카드 자체를 없애는 완전 숨김이 아니라 더 작은 상태 chip까지 축소하는 한 단계만 허용한다.

**Suggested command:** `$impeccable layout`

## Persona Red Flags

**Alex (Power User):** 요소 선택 → 요청 → 최소화 → 검토를 반복할 때 네 모드와 주요 동작의 단축키가 드러나지 않는다. compact 상태에서 모드 4개, 펼치기, 작업 보드, 취소까지 최대 7개 제어가 동시에 보여 반복 작업의 속도를 떨어뜨린다.

**Sam (Accessibility-Dependent):** compact main button의 `aria-label`이 요청 내용을 덮어써 스크린리더에서는 “무슨 작업인지” 들리지 않는다. 10px 메타데이터, 영어 내부 용어, hover `title`에 의존한 `닫기` 설명도 200% zoom·키보드·저시력 사용자의 판단을 어렵게 한다.

**Riley (Stress Tester):** 긴 요청은 96자로 잘리고, 비슷한 두 요청은 8자리 ID를 기억해야 구별할 수 있다. 취소·되돌리기 직전 영향 범위 확인이 없고, 우측 상단 host control과 겹치는 경우의 회피 동작도 드러나지 않는다.

## Cognitive Load

8개 항목 중 **3개 실패로 moderate**다.

- 통과: single focus, chunking, grouping, visual hierarchy, progressive disclosure.
- 실패 — one thing at a time: review에서 증거 확인과 4개 후속 행동 판단을 동시에 요구한다.
- 실패 — minimal choices: review는 diff 포함 5개 선택지, compact active 화면은 툴바까지 최대 7개 제어가 보인다.
- 실패 — working memory: 축약 요청, Task ID, `변경 유지`와 `닫기` 차이를 사용자가 기억해 해석해야 한다.

## Emotional Journey

선택과 dispatch 구간은 관제 콘솔의 명확한 신호 덕분에 자신감을 준다. 최소화 후에도 상태가 남아 실행 중의 불안을 크게 줄인다. 가장 큰 감정적 저점은 취소·되돌리기 직전이다. 사용자는 결과를 잃을 수 있다는 긴장을 느끼지만 영향 범위와 복구 가능성을 미리 확인할 수 없다. 완료 시점도 `변경 유지`와 `닫기`의 차이가 흐려 완결감이 약하다.

## Minor Observations

- 상태 행의 최신 로그와 바로 아래 최근 로그 목록 마지막 항목이 중복된다.
- `N files`, `Unified diff`, `TASK`, `QUEUE`, `DISPATCH`가 한국어 행동 라벨과 섞여 스캔 속도를 낮춘다.
- animated 2px route line은 활동 여부는 보여주지만 진행률처럼 오해될 수 있다. `진행 중`인 indeterminate 표시임을 텍스트가 책임져야 한다.
- `작업 보드 ↗`는 복잡한 검토를 별도 공간으로 넘기는 좋은 escape hatch다.

## Questions to Consider

- compact strip에서 project ID와 Task ID가 둘 다 즉시 보여야 할 결정적 이유가 있는가?
- `닫기`는 정말 사용자가 내려야 하는 task 결정인가, 단순한 화면 정리 동작인가?
- monitoring이 주목적이라면 파괴적 동작을 compact 상태에 항상 노출해야 하는가?
- host 앱과 overlay가 같은 우측 상단 공간을 원할 때 어느 쪽이 이동해야 하는가?
