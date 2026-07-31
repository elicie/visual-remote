# Product

<!-- impeccable:product-schema 1 -->

> 이 기록은 사용자가 제공한 기술 명세와 “고품질로 최대한 빠르게 구현” 지시에서 추출했다. 별도 제품 인터뷰에서 확인되지 않은 브랜드·배포 정책은 열린 결정으로 남긴다.

## Platform

web

## Users

원격 Linux 서버에서 웹 프로젝트를 개발하고, Mac 또는 Windows 브라우저로 결과를 확인하는 개인 개발자다. 사용자는 실행 중인 화면을 기준으로 기존 CLI 코딩 에이전트에 짧고 구체적인 수정 요청을 전달한다.

## Product Purpose

Visual Remote Dev Bridge는 브라우저에서 선택한 실제 UI와 저장소 전용 CLI 코딩 에이전트를 연결한다. 성공은 선택, 요청, 소스 수정, HMR 확인, task 단위 diff와 안전한 되돌리기가 한 브라우저 흐름 안에서 반복 가능하게 동작하는 것이다.

## Positioning

새 IDE나 에이전트를 만드는 대신, 독립 Git 저장소 또는 worktree마다 가벼운 Bridge를 두어 실행 중인 화면과 사용자가 이미 쓰는 코딩 에이전트 사이의 마지막 연결 구간만 해결한다.

## Operating Context

- 원격 Linux 저장소와 Next.js, Vite 등 기존 개발 서버
- Mac 또는 Windows의 브라우저
- Portr를 통한 HTTP/WebSocket 터널
- Codex를 우선으로 하는 기존 CLI 코딩 에이전트
- dirty working tree를 포함할 수 있는 실제 Git 작업 환경

## Capabilities and Constraints

- Bridge 하나는 Git working tree 하나만 소유한다.
- 서로 다른 저장소는 동시에 작업할 수 있지만, 같은 저장소의 writer task는 순차 실행한다.
- Bridge gateway가 앱, HMR, Overlay, 제어 API를 같은 origin으로 제공한다.
- 사용자는 요소, 여러 요소, 영역 또는 페이지를 선택해 요청할 수 있다.
- task 전후 hidden Git snapshot으로 기존 변경을 보존하면서 diff와 최신 task revert를 제공한다.
- 로그인·팀 권한·중앙 데몬·자동 commit/push·현재 탭 자동 조작은 MVP 범위가 아니다.
- 브라우저 context에서 cookie, storage 값, 인증 header, form value와 전체 HTML을 수집하지 않는다.
- 추가 에이전트 adapter, screenshot, 고급 자동화는 핵심 루프가 안정된 뒤에만 검토한다.

## Evidence on Hand

- 구현 기준 문서: `docs/visual_remote_dev_bridge_mvp_technical_spec.md`
- 기존 제품 UI, 로고, 브랜드 자산, 사용자 데이터는 아직 없다. 향후 작업은 이를 임의로 꾸며내지 않는다.

## Product Principles

- 가장 짧은 화면 선택 → 코드 수정 → 검토 루프를 우선한다.
- 저장소 경계와 사용자의 기존 Git 변경을 절대 희생하지 않는다.
- 상태, 변경 범위, 검증 수준과 불확실성을 브라우저에서 분명하게 보여준다.
- 프레임워크별 결합보다 작은 공통 gateway와 교체 가능한 경계를 선호한다.
- 중앙 플랫폼을 만들지 않고 저장소별 Bridge를 독립적으로 유지한다.

## Accessibility & Inclusion

키보드로 Overlay를 열고 주요 동작을 완료할 수 있어야 한다. 한국어 IME 조합 중 Enter가 요청 전송으로 오인되지 않아야 하며, 선택 및 task 상태는 색상만으로 전달하지 않는다.
