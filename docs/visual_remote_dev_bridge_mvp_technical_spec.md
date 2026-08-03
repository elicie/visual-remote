# Visual Remote Dev Bridge MVP 기술 구현 문서

> 문서 상태: 구현 기준안 v0.1  
> 대상: 개인용 원격 웹 개발 도구 MVP  
> 핵심 구조: 독립 Git 저장소 또는 Git worktree마다 Agent Bridge 1개  
> 작성일: 2026-07-31

---

## 1. 문서 목적

이 문서는 원격 Linux 서버에서 실행 중인 웹 프로젝트를 Mac 또는 Windows의 브라우저로 보면서, 화면 요소를 직접 선택하고 자연어로 수정 요청하면 원격 저장소의 코딩 에이전트가 실제 소스를 수정하도록 연결하는 개인용 도구의 MVP 구현 기준을 정의한다.

이 문서의 구현안은 다음 사용 흐름을 완성하는 데 초점을 둔다.

1. 원격 프로젝트의 개발 서버와 Agent Bridge를 실행한다.
2. Portr를 통해 Mac 또는 Windows 브라우저에서 개발 화면을 연다.
3. 화면 요소, 여러 요소 또는 영역을 선택한다.
4. 자연어 수정 요청을 전송한다.
5. 저장소 전용 Agent Bridge가 Codex, Claude Code 또는 호환 CLI 에이전트를 실행한다.
6. 에이전트가 실제 파일을 수정한다.
7. 기존 개발 서버의 HMR 또는 reload를 통해 같은 브라우저에 결과가 나타난다.
8. 사용자는 진행 상태, 변경 파일, Git diff, 검증 결과를 확인한다.
9. 결과를 유지하거나 마지막 작업만 되돌리거나 후속 요청을 이어간다.

이 도구는 새로운 IDE, 새로운 코딩 에이전트 또는 SaaS를 만드는 것이 아니다. 실행 중인 브라우저 화면과 기존 CLI 코딩 에이전트 사이를 연결하는 **저장소 단위 시각적 개발 브리지**다.

---

## 2. 최종 아키텍처 결정 요약

MVP에서 채택할 핵심 결정은 다음과 같다.

| 항목 | MVP 결정 |
|---|---|
| 실행 단위 | 독립 Git 저장소 또는 Git worktree마다 Agent Bridge 1개 |
| 실행 형태 | 프로젝트 개발 세션 동안 떠 있는 저장소 전용 sidecar 프로세스 |
| 중앙 데몬 | 사용하지 않음 |
| 프로젝트 동시 작업 | 서로 다른 저장소의 Bridge를 동시에 실행 |
| 동일 저장소 동시 쓰기 | 허용하지 않고 작업 큐로 순차 실행 |
| 브라우저 연결 | Bridge의 reverse proxy/gateway를 통해 동일 출처로 연결 |
| Portr 연결 | Portr는 Bridge gateway 포트를 노출 |
| 화면 통합 | HTML 응답에 자체 Overlay client를 개발 모드에서 주입 |
| 요소 선택 | 자체 Overlay UI + React Grab primitives 또는 동등한 hit-test 계층 |
| 소스 위치 해석 | `element-source` 기반 resolver + 경로 정규화 + fallback context |
| 코딩 에이전트 | Adapter 방식으로 Codex, Claude Code, OpenCode 계열 연결 |
| 작업 실행 | 요청마다 별도 child process/PTY worker 실행 |
| Git 안전성 | 작업 전후 숨은 Git snapshot을 생성해 task 전용 diff 계산 |
| 되돌리기 | 최신 task가 변경한 경로만 pre-task snapshot으로 복원 |
| 상태 저장 | 사용자 홈의 저장소별 SQLite |
| 브라우저 확장 | MVP에서 사용하지 않음 |
| 로그인/팀 권한 | 구현하지 않음. 제어 연결은 별도 인증 없이 허용 |
| 자동 클릭/입력 | MVP에서 제외. 현재 탭은 조회와 검증만 수행 |

### 2.1 핵심 원칙

> 동일한 Bridge 프로그램을 여러 저장소에서 실행하되, 각 Bridge 인스턴스는 자기 저장소, 자기 작업 큐, 자기 에이전트 프로세스, 자기 Git transaction만 관리한다.

예시:

```text
원격 Linux 서버
├─ /srv/projects/admin-web
│  └─ visual bridge A + admin dev server
├─ /srv/projects/shop-web
│  └─ visual bridge B + shop dev server
└─ /srv/projects/landing
   └─ visual bridge C + landing dev server
```

세 Bridge는 동시에 실행할 수 있다. `admin-web`의 작업이 길어져도 `shop-web`과 `landing` 작업은 독립적으로 진행된다.

---

## 3. MVP 범위

### 3.1 반드시 구현할 기능

#### 프로젝트 실행 및 연결

- 저장소 루트 자동 탐지
- 저장소별 Bridge 시작/종료
- Bridge가 개발 서버를 함께 실행하는 managed mode
- 이미 실행 중인 개발 서버 앞에 붙는 attach mode
- HTTP 및 WebSocket reverse proxy
- HTML 응답에 Overlay client 주입
- Portr를 통해 같은 주소에서 앱, HMR, Bridge API 사용
- 여러 저장소의 Bridge 동시 실행
- 중복 Bridge 실행 방지

#### 화면 선택 및 요청

- 단일 DOM 요소 선택
- 여러 요소 선택
- 사각형 영역 선택
- 선택 없는 현재 페이지 요청
- 선택 요소 강조 표시
- 요소 옆 요청 입력창
- 한국어 IME 입력 보호
- 적용 범위 선택
  - 이 요소/인스턴스
  - 현재 화면
  - 해당 컴포넌트
  - 프로젝트 전체

#### 컨텍스트 수집

- 현재 URL, route, viewport, DPR, scroll 위치
- 선택 요소의 tag, id, class, text, role, accessible name
- bounding box와 주요 computed style
- 부모/형제/선택 요소 간 관계
- 컴포넌트 이름, 파일, 라인, 컬럼, 컴포넌트 스택
- 안정적인 locator 후보
- 작업 시작 이후 새로 발생한 console error와 unhandled error
- 선택 영역에 포함된 주요 요소와 공통 부모

#### 에이전트 작업

- 사용자 요청과 구조화된 context bundle 전달
- 저장소 cwd에서 CLI 에이전트 실행
- 작업별 stdout/stderr 또는 구조화 이벤트 스트리밍
- 취소
- 작업 제한 시간
- 하나의 저장소에서 writer 1개만 실행
- 대기 작업 큐
- 후속 요청 시 이전 task와 선택 context 연결

#### 결과 확인

- 변경 파일 목록
- unified Git diff
- 작업 상태 표시
- dev server/HMR 반영 관찰
- 선택 대상 재탐색
- 작업 후 console error 비교
- 설정된 검증 명령 실행
- 유지
- 최신 작업 되돌리기
- 후속 수정 요청

### 3.2 MVP에서 제외할 기능

- 중앙 대형 대시보드
- 팀 협업, 댓글, 역할/권한 관리
- SaaS 계정 및 결제
- 자체 LLM 또는 자체 코딩 모델
- 동일 working tree에서 writer 여러 명 병렬 실행
- 자동 worktree 생성 및 병합
- 프로덕션 사이트 연결
- 브라우저 확장
- Chrome DevTools Protocol 직접 연결
- 네트워크 request body 수집
- 에이전트의 현재 탭 자동 클릭/입력/새로고침
- 정교한 픽셀 단위 visual regression
- 모바일 기기 원격 제어
- Git commit/push 자동 수행

### 3.3 MVP 성공 기준

MVP는 다음 시나리오가 반복해서 안정적으로 동작하면 완료로 본다.

1. 서버의 서로 다른 두 저장소에서 Bridge를 각각 실행한다.
2. 각 프로젝트를 Portr URL로 연다.
3. 두 브라우저 탭에서 서로 다른 작업을 동시에 요청한다.
4. 각 Agent Bridge가 올바른 저장소만 수정한다.
5. 같은 저장소의 두 번째 요청은 queue에 들어간다.
6. HMR 결과가 현재 탭에 반영된다.
7. task별 diff가 pre-existing dirty change와 분리되어 보인다.
8. 최신 task를 되돌렸을 때 task 시작 직전 상태로 복구된다.
9. Bridge 또는 브라우저가 재연결되어도 task 상태와 로그가 복구된다.

---

## 4. 전체 시스템 구조

### 4.1 런타임 구성

```text
Mac / Windows Chrome
┌──────────────────────────────────────────────┐
│ 원격 개발 화면                               │
│                                              │
│ Visual Overlay                              │
│ ├─ 요소/다중/영역 선택                      │
│ ├─ 자연어 요청                              │
│ ├─ 작업 상태                                │
│ ├─ Diff drawer                              │
│ └─ 유지/되돌리기/후속 요청                  │
└───────────────────────┬──────────────────────┘
                        │ HTTPS + WebSocket
                        │
                      Portr
                        │
┌───────────────────────▼──────────────────────┐
│ 저장소 전용 Agent Bridge                     │
│                                              │
│ Gateway / Reverse Proxy                     │
│ ├─ /_visual/* → Bridge Control API          │
│ ├─ HTML → Overlay script 주입               │
│ └─ 나머지 HTTP/WS → 실제 dev server         │
│                                              │
│ Bridge Core                                 │
│ ├─ Browser Session Manager                  │
│ ├─ Context Resolver                         │
│ ├─ Task Queue / Write Lock                  │
│ ├─ Agent Adapter / Worker                   │
│ ├─ Git Transaction Manager                  │
│ ├─ Verification Manager                     │
│ └─ SQLite / Logs                            │
└───────────────────────┬──────────────────────┘
                        │ localhost
┌───────────────────────▼──────────────────────┐
│ 실제 프로젝트 dev server                    │
│ Next.js / Vite / Webpack 등                  │
│ HMR WebSocket 포함                           │
└──────────────────────────────────────────────┘
```

### 4.2 왜 Bridge가 dev server 앞의 gateway를 맡는가

프로젝트별 플러그인으로 dev server 내부에 제어 API를 넣는 방법보다, Bridge가 reverse proxy를 맡는 방식이 MVP에 더 적합하다.

- Next.js와 Vite의 내부 플러그인 구현을 각각 만들 필요가 없다.
- 프로젝트 소스에 별도 컴포넌트를 넣지 않아도 된다.
- Overlay, Bridge API, HMR을 같은 origin으로 제공할 수 있다.
- Portr는 gateway 포트 하나만 노출하면 된다.
- 실제 dev server가 재시작돼도 Bridge task 상태는 유지된다.
- 프레임워크를 바꿔도 proxy 계층은 그대로 재사용할 수 있다.

Gateway의 라우팅 우선순위는 다음과 같다.

```text
/_visual/client.js          → Overlay bundle
/_visual/api/*              → Bridge REST API
/_visual/ws                 → Bridge WebSocket
/_visual/assets/*           → task artifact
나머지 HTTP 요청            → upstream dev server
나머지 WebSocket upgrade    → upstream HMR/WebSocket
```

### 4.3 HTML 주입 방식

Gateway는 upstream 응답 중 `Content-Type: text/html`인 개발 페이지에만 다음 스크립트를 삽입한다.

```html
<script type="module" src="/_visual/client.js"></script>
```

구현 규칙:

- `HEAD` 요청에는 주입하지 않는다.
- HTML이 아닌 asset, RSC payload, API 응답에는 손대지 않는다.
- upstream에 `Accept-Encoding: identity`를 사용해 HTML 변환을 단순화한다.
- `Content-Length`는 제거하고 chunked response로 전달한다.
- `<head>`가 확인되는 시점에 주입하며, 없으면 `</body>` 직전에 넣는다.
- streaming HTML은 처음 일부 chunk만 buffer한 뒤 주입하고 나머지는 stream한다.
- app의 CSP 때문에 same-origin script가 거부되면 수동 integration fallback을 사용한다.
- production mode에서는 Overlay를 절대 주입하지 않는다.

---

## 5. 프로세스 모델

### 5.1 Bridge는 중앙 데몬이 아니다

MVP의 Bridge는 프로젝트 개발 세션에 종속된 foreground supervisor다.

```bash
cd /srv/projects/admin-web
visual dev
```

`visual dev`는 다음 프로세스를 관리한다.

```text
visual bridge parent process
├─ gateway/control server
├─ project dev server child process
├─ agent worker process      # task 실행 중에만
└─ verification process     # 필요할 때만
```

터미널을 종료하면 Bridge와 자식 dev server가 함께 종료된다. 장기 상주 systemd 서비스, 서버 전체 통합 데몬, 중앙 coordinator는 MVP에서 만들지 않는다.

### 5.2 Managed mode

Bridge가 개발 서버를 직접 실행한다.

```bash
visual dev
```

동작:

1. Git worktree root를 찾는다.
2. `.visualdev/config.yaml`을 읽는다.
3. worktree 전용 lock을 획득한다.
4. 내부 upstream port를 할당한다.
5. 설정된 dev command를 upstream port로 실행한다.
6. 안정적인 gateway port를 연다.
7. HTML/HTTP/WebSocket proxy를 시작한다.
8. 브라우저 공개 URL과 Portr 대상 port를 표시한다.

예:

```text
Gateway:  http://dev:10001
Upstream: http://127.0.0.1:43121
Public:   https://admin.bridge.example/
Open:     https://admin.bridge.example/
```

### 5.3 Attach mode

이미 tmux 등에서 dev server를 실행 중일 때 사용한다.

```bash
visual attach \
  --upstream http://127.0.0.1:10002 \
  --listen 10001 \
  --public-url https://admin.bridge.example
```

Portr는 원래 dev server port가 아니라 Bridge gateway port인 `10001`을 노출한다.

```text
Portr → 10001 Bridge gateway → 10002 existing dev server
```

### 5.4 여러 저장소 동시 실행

```bash
# terminal/tmux session A
cd /srv/projects/admin-web
visual dev

# terminal/tmux session B
cd /srv/projects/shop-web
visual dev

# terminal/tmux session C
cd /srv/projects/landing
visual dev
```

각 Bridge는 다음을 독립적으로 가진다.

- process ID
- gateway/upstream port
- runtime token
- browser sessions
- task queue
- agent process
- Git refs
- SQLite database
- logs

### 5.5 동일 저장소 중복 실행 방지

Bridge는 `git rev-parse --show-toplevel` 결과의 realpath를 SHA-256으로 해시해 runtime key를 만든다.

```text
repoKey = sha256(realpath(worktreeRoot))
```

다음 위치에 lock을 둔다.

```text
$XDG_RUNTIME_DIR/visual-bridge/<repoKey>/bridge.lock
```

동일 worktree에서 두 번째 Bridge가 실행되면 기존 instance 정보를 보여주고 종료한다.

### 5.6 worktree와 monorepo 기준

Bridge 실행 단위는 일반 폴더가 아니라 **Git working tree**다.

- 독립 Git 저장소: Bridge 1개
- 독립 Git worktree: worktree마다 Bridge 1개
- 모노레포의 `apps/admin`, `apps/shop`: 기본적으로 같은 Bridge 1개

모노레포에서 두 앱을 동시에 별도 preview로 실행하는 기능은 MVP 범위 밖이다. MVP에서는 하나의 Bridge가 하나의 active web preview를 관리한다. 같은 모노레포 앱을 완전히 병렬 작업해야 한다면 Git worktree를 별도로 만든다.

---

## 6. 권장 기술 스택

| 영역 | 기술 |
|---|---|
| Runtime | Node.js 24+ |
| Language | TypeScript strict mode |
| Package manager | pnpm workspace |
| CLI | Commander 또는 자체 경량 parser |
| HTTP server | Fastify |
| WebSocket | `ws` 또는 Fastify WebSocket adapter |
| Reverse proxy | `http-proxy` 기반 HTTP/WS proxy |
| Overlay UI | Preact + Shadow DOM |
| Schema validation | Zod |
| Storage | SQLite + `better-sqlite3` |
| File watch | Chokidar |
| Git | `git` CLI를 argument array로 실행 |
| Process | `child_process.spawn`, 필요 시 `node-pty` |
| Build | tsup/esbuild + Vite library build |
| Test | Vitest + Playwright |
| Logging | Pino |

### 6.1 구현 저장소 구조

```text
visual-remote-dev-bridge/
├─ apps/
│  └─ cli/
│     ├─ src/commands/init.ts
│     ├─ src/commands/dev.ts
│     ├─ src/commands/attach.ts
│     ├─ src/commands/status.ts
│     └─ src/index.ts
│
├─ packages/
│  ├─ protocol/
│  │  ├─ src/messages.ts
│  │  ├─ src/context.ts
│  │  └─ src/task.ts
│  │
│  ├─ bridge-core/
│  │  ├─ src/bridge.ts
│  │  ├─ src/project-runtime.ts
│  │  ├─ src/browser-sessions.ts
│  │  ├─ src/task-manager.ts
│  │  └─ src/storage.ts
│  │
│  ├─ gateway/
│  │  ├─ src/http-proxy.ts
│  │  ├─ src/ws-proxy.ts
│  │  ├─ src/html-injector.ts
│  │  └─ src/control-routes.ts
│  │
│  ├─ overlay/
│  │  ├─ src/bootstrap.ts
│  │  ├─ src/picker/
│  │  ├─ src/context/
│  │  ├─ src/session/
│  │  ├─ src/components/
│  │  └─ src/styles/
│  │
│  ├─ source-resolver/
│  │  ├─ src/element-source-adapter.ts
│  │  ├─ src/path-normalizer.ts
│  │  └─ src/fallback-context.ts
│  │
│  ├─ agent-adapters/
│  │  ├─ src/types.ts
│  │  ├─ src/codex.ts
│  │  ├─ src/claude.ts
│  │  ├─ src/opencode.ts
│  │  └─ src/generic-shell.ts
│  │
│  ├─ git-transaction/
│  │  ├─ src/snapshot.ts
│  │  ├─ src/diff.ts
│  │  ├─ src/revert.ts
│  │  └─ src/guards.ts
│  │
│  └─ test-fixtures/
│     ├─ vite-react/
│     └─ next-app/
│
├─ .visualdev.example.yaml
├─ package.json
└─ pnpm-workspace.yaml
```

초기에는 Turborepo나 마이크로서비스를 도입하지 않는다. pnpm workspace와 package 간 명확한 의존 관계만 유지한다.

---

## 7. 프로젝트 설정 파일

각 저장소 루트에 다음 파일을 둔다.

```text
.visualdev/config.yaml
```

예시:

```yaml
version: 1

project:
  id: admin-web
  workspace: .

gateway:
  host: 0.0.0.0
  port: 10001
  publicUrl: https://admin.bridge.example

upstream:
  port: auto
  command:
    - pnpm
    - dev
    - --
    - --port
    - "{upstreamPort}"
  ready:
    path: /
    timeoutMs: 60000

agent:
  adapter: codex
  maxRunMs: 900000
  resumeMode: auto

queue:
  maxPending: 20

context:
  maxElements: 8
  maxRegionElements: 20
  maxTextLength: 500
  includeComputedStyles: true
  includeScreenshot: best-effort

verification:
  hmrWaitMs: 12000
  commands:
    - name: typecheck
      command: [pnpm, typecheck]
      timeoutMs: 120000

paths:
  allowed:
    - app/**
    - pages/**
    - src/**
    - components/**
    - styles/**
    - public/**
    - tests/**
    - package.json
    - pnpm-lock.yaml
  denied:
    - .git/**
    - .env
    - .env.*
    - "**/*.pem"
    - "**/*.key"
    - node_modules/**
    - .next/**
    - dist/**

security:
  allowedOrigins:
    - https://admin.bridge.example
  rotatePairingTokenOnStart: true
```

### 7.1 설정 규칙

- 저장소 루트는 config에서 임의 지정하지 않고 Git으로 탐지한다.
- `workspace`는 모노레포 내부 앱의 기준 디렉터리다.
- `command`는 shell 문자열이 아니라 executable/argv 배열로 저장한다.
- `{upstreamPort}` 같은 placeholder만 허용한다.
- denied path가 allowed path보다 항상 우선한다.
- `.visualdev/config.local.yaml`은 개인 override용으로 사용하고 Git ignore한다.
- 에이전트 CLI의 버전별 세부 argument는 adapter 내부에서 관리한다.

---

## 8. CLI 명령 설계

### 8.1 `visual init`

```bash
visual init
```

동작:

- Git root 확인
- package manager와 dev script 탐지
- `.visualdev/config.yaml` 초안 생성
- 사용 가능한 agent CLI 탐지
- 사용 가능한 gateway port 제안
- production build에 Overlay가 들어가지 않는 구조인지 확인

### 8.2 `visual dev`

```bash
visual dev
```

- Bridge와 upstream dev server를 foreground로 실행
- Ctrl+C 시 자식 process group까지 종료
- gateway, upstream, public, browser open URL 출력
- task 로그는 구조화 JSONL과 사람이 읽는 콘솔 형식을 함께 지원

### 8.3 `visual attach`

```bash
visual attach --upstream http://127.0.0.1:10002 --listen 10001
```

- 기존 dev server에 proxy 방식으로 연결
- attach mode에서는 upstream process 종료 책임을 가지지 않음

### 8.4 상태 명령

```bash
visual status
visual list
visual tasks
visual logs --task <taskId>
visual pair
visual stop
visual doctor
```

중앙 데몬 없이 `visual list`를 지원하기 위해 각 Bridge가 다음 runtime registry를 작성한다.

```text
$XDG_RUNTIME_DIR/visual-bridge/<repoKey>/instance.json
```

예시:

```json
{
  "projectId": "admin-web",
  "repoRoot": "/srv/projects/admin-web",
  "pid": 21841,
  "gatewayUrl": "http://dev:10001",
  "publicUrl": "https://admin.bridge.example",
  "status": "working",
  "activeTaskId": "tsk_01J..."
}
```

`visual list`는 registry와 PID 생존 여부를 확인해 오래된 항목을 정리한다.

---

## 9. Overlay 구현

### 9.1 주입 및 격리

Overlay는 app DOM의 `document.body`에 host element 하나를 만들고 내부에 Shadow Root를 생성한다.

```html
<div id="__visual_bridge_root"></div>
```

```ts
const host = document.createElement("div");
host.id = "__visual_bridge_root";
host.dataset.visualBridgeIgnore = "true";
const shadow = host.attachShadow({ mode: "open" });
document.body.append(host);
```

규칙:

- app의 Tailwind/CSS reset 영향을 받지 않는다.
- Overlay 이벤트가 app에 전파되지 않도록 필요한 이벤트만 stopPropagation한다.
- 선택 모드가 아닐 때 `pointer-events: none`으로 app 조작을 방해하지 않는다.
- 선택용 outline은 별도 fixed layer에서 그린다.
- Overlay subtree는 hit testing에서 제외한다.

### 9.2 활성화 방식

기본 단축키:

```text
Mac:     Command + Shift + G
Windows: Ctrl + Shift + G
```

`Ctrl/Cmd + C`는 일반 복사 및 다른 개발 도구와 충돌할 수 있으므로 기본값으로 사용하지 않는다.

Overlay가 활성화되면 다음 모드가 표시된다.

```text
[요소] [여러 요소] [영역] [페이지]
```

### 9.3 한국어 IME 처리

요청 입력창에서 Enter를 전송 키로 사용할 때 반드시 다음을 확인한다.

```ts
if (event.isComposing || compositionState.current) {
  return;
}
```

IME 조합 확정 중 Enter가 task submit으로 처리되면 안 된다. Shift+Enter는 줄바꿈으로 사용한다.

### 9.4 단일 요소 선택

동작:

1. pointermove에서 `elementFromPoint` 또는 selection primitive로 target을 찾는다.
2. Overlay 자체, script/style/meta, invisible element는 제외한다.
3. target bounding rect에 highlight를 표시한다.
4. click 시 target을 고정하고 request popover를 연다.
5. source/context 수집은 click 이후 비동기로 실행한다.

### 9.5 여러 요소 선택

- Shift+Click 또는 multi mode에서 요소를 누적한다.
- MVP 최대 8개로 제한한다.
- 선택 순서를 유지한다.
- 각 요소에 1, 2, 3 번호를 표시한다.
- 요소 간 비교 요청을 위해 크기, computed style 차이, 공통 부모를 계산한다.

예:

> 1번과 2번 버튼의 높이, padding, radius를 같게 맞춰줘.

### 9.6 영역 선택

사각형 drag가 끝나면 다음 알고리즘으로 context를 만든다.

1. viewport에서 selection rectangle과 교차하는 visible element를 찾는다.
2. 교차 비율이 낮은 container는 제외하고 의미 있는 leaf/interactive element를 우선한다.
3. 같은 source/component가 반복되면 deduplicate한다.
4. 최대 20개 element로 제한한다.
5. lowest common ancestor와 대표 source stack을 계산한다.
6. 영역 screenshot은 best-effort로 시도하되 실패해도 task를 생성한다.

영역 선택은 정확한 단일 파일 매핑을 보장하지 않는다. 에이전트에는 `region`, `elements`, `commonAncestor`, `sourceCandidates`를 함께 전달한다.

### 9.7 페이지 요청

선택하지 않고 현재 페이지 전체에 요청할 수 있다.

수집 정보:

- URL/route/title
- viewport
- body의 주요 landmark
- 현재 화면에서 보이는 상위 interactive element
- 최근 console errors
- 사용자 요청

페이지 전체 DOM을 그대로 전송하지 않는다.

### 9.8 요청 UI

요청 popover:

```text
┌───────────────────────────────────────┐
│ Header / HeaderActions.tsx:42         │
│                                       │
│ 헤더 높이를 줄이고 로고와 메뉴 사이   │
│ 간격도 좁혀줘.                        │
│                                       │
│ 범위: [현재 화면 ▼]                   │
│                         [요청 보내기] │
└───────────────────────────────────────┘
```

작업 후:

```text
● 수정 완료
2개 파일 변경 · HMR 감지 · typecheck 통과

[Diff] [유지] [되돌리기] [후속 수정]
```

`유지`는 Git commit을 의미하지 않는다. 현재 working tree 변경을 유지하고 task를 accepted 상태로 닫는 동작이다.

---

## 10. 요소와 소스 연결

### 10.1 기본 전략

MVP는 React Grab 자체 UI를 포크하거나 확장하지 않는다. 자체 Overlay를 만들되 다음 계층을 교체 가능한 dependency adapter로 사용한다.

- hit testing: `react-grab/primitives` 또는 자체 equivalent
- source resolution: `element-source`
- fallback: DOM/context 기반으로 에이전트가 저장소를 직접 검색

`element-source`는 DOM element를 입력으로 받아 component name, source file 위치, line/column, component stack을 반환하는 API를 제공한다. Bridge는 이 반환값을 그대로 신뢰하지 않고 서버에서 path를 검증한다.

### 10.2 Browser-side source resolution

개념 코드:

```ts
import { resolveElementInfo } from "element-source";

const info = await resolveElementInfo(element);
```

수집 결과 예:

```json
{
  "tagName": "button",
  "componentName": "HeaderActions",
  "source": {
    "filePath": "src/components/header/HeaderActions.tsx",
    "lineNumber": 42,
    "columnNumber": 7,
    "componentName": "HeaderActions"
  },
  "stack": [
    {
      "filePath": "src/components/header/HeaderActions.tsx",
      "lineNumber": 42,
      "columnNumber": 7,
      "componentName": "HeaderActions"
    },
    {
      "filePath": "src/components/header/Header.tsx",
      "lineNumber": 18,
      "columnNumber": 3,
      "componentName": "Header"
    }
  ]
}
```

### 10.3 서버 측 경로 정규화

브라우저가 보내는 파일 경로는 다음 형태일 수 있다.

```text
src/components/Button.tsx
/srv/projects/admin/src/components/Button.tsx
file:///srv/projects/admin/src/components/Button.tsx
webpack://_N_E/./src/components/Button.tsx
vite://src/components/Button.tsx
```

Path Normalizer는 다음 순서로 처리한다.

1. URL scheme 및 bundler prefix 제거
2. query/hash 제거
3. path separator 정규화
4. absolute path이면 realpath 확인
5. relative path이면 repo root와 결합
6. repo root 밖이면 거부
7. 파일이 없으면 suffix/basename 후보 검색
8. line 범위가 실제 파일 줄 수 안에 있는지 확인

신뢰도:

```text
exact       실제 파일과 line이 정확히 확인됨
probable    suffix 또는 basename 후보 1개로 해석됨
ambiguous   후보가 여러 개임
unknown     파일 매핑 실패
```

### 10.4 매핑 실패 시 fallback

소스 위치가 없어도 요청을 막지 않는다. 다음 정보를 에이전트에 제공한다.

- tag/id/class
- text와 accessible name
- stable locator 후보
- DOM 부모 경로
- 주변 sibling 텍스트
- computed style
- current route
- 영역 또는 비교 관계

에이전트는 `rg` 또는 자체 repository search 도구로 후보를 찾는다.

### 10.5 렌더링 소유자와 스타일 소유자 구분

선택된 DOM의 source 위치가 실제 스타일 수정 위치와 같다고 가정하지 않는다.

Context Bundle은 최소한 다음 후보를 구분한다.

- render source: JSX를 렌더링한 위치
- component stack: 상위 사용자 컴포넌트
- style hints: class, inline style, CSS variable, computed style
- usage hints: props/variant를 결정할 가능성이 있는 부모

에이전트 프롬프트는 공용 컴포넌트를 무조건 수정하지 말고, 사용자가 선택한 적용 범위를 우선하도록 지시한다.

---

## 11. Context Bundle 데이터 모델

### 11.1 최상위 구조

```ts
interface ContextBundle {
  version: 1;
  projectId: string;
  browserSessionId: string;
  page: PageContext;
  selection: SelectionContext;
  runtime: RuntimeContext;
  request: UserRequest;
  limits: ContextLimits;
}
```

### 11.2 PageContext

```ts
interface PageContext {
  url: string;
  pathname: string;
  title: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  userAgentSummary: string;
  renderRevision: number;
}
```

쿠키, localStorage, sessionStorage 값, Authorization header는 포함하지 않는다.

### 11.3 SelectionContext

```ts
type SelectionContext =
  | { mode: "element"; targets: TargetContext[] }
  | { mode: "multi"; targets: TargetContext[]; relation: RelationContext }
  | { mode: "region"; region: Rect; targets: TargetContext[]; commonAncestor?: DomNodeHint }
  | { mode: "page"; landmarks: LandmarkContext[] };
```

### 11.4 TargetContext

```ts
interface TargetContext {
  targetId: string;
  order: number;
  dom: {
    tagName: string;
    id?: string;
    classNames: string[];
    text?: string;
    role?: string;
    accessibleName?: string;
    attributes: Record<string, string>;
    rect: Rect;
    locatorCandidates: LocatorCandidate[];
    parentPath: DomNodeHint[];
  };
  styles: {
    display?: string;
    position?: string;
    width?: string;
    height?: string;
    margin?: string;
    padding?: string;
    gap?: string;
    borderRadius?: string;
    fontSize?: string;
    fontWeight?: string;
    color?: string;
    backgroundColor?: string;
    flexDirection?: string;
    alignItems?: string;
    justifyContent?: string;
    gridTemplateColumns?: string;
    zIndex?: string;
  };
  source: {
    primary?: SourceLocation;
    stack: SourceLocation[];
    confidence: "exact" | "probable" | "ambiguous" | "unknown";
  };
  screenshotArtifactId?: string;
}
```

### 11.5 Context 크기 제한

- target text: 요소당 최대 500자
- class list: 최대 100개 또는 2KB
- attributes: allowlist 기반
- component stack: 최대 8 frame
- computed style: 요청 의도에 맞는 key 중심, 최대 40개
- 전체 JSON: 기본 64KB
- screenshot: optional, target당 최대 1MB
- region target: 최대 20개

기본 수집 금지 attribute:

```text
value
password
authorization
cookie
srcdoc
민감한 data-* 값
```

---

## 12. Browser Session 및 실시간 프로토콜

### 12.1 Browser Session

브라우저 탭마다 UUID를 생성한다.

```text
browserSessionId = random UUID
```

Bridge는 heartbeat를 기준으로 session 상태를 관리한다.

```ts
interface BrowserSession {
  id: string;
  connectedAt: string;
  lastSeenAt: string;
  url: string;
  viewport: { width: number; height: number };
  renderRevision: number;
  controller: boolean;
}
```

여러 탭이 같은 프로젝트에 연결될 수 있다. task를 생성한 탭이 `originBrowserSessionId`가 되며 HMR/대상 재탐색 검증은 우선 해당 탭에서 수행한다.

### 12.2 브라우저 연결

Bridge가 시작될 때 터미널에 출력한 pairing 주소를 열면 Overlay가 제어 채널에
연결된다. 공개 주소만 직접 연 브라우저에는 제어 권한을 부여하지 않는다.

```text
https://admin.bridge.example/#visual-pair=<token>
```

브라우저 동작:

1. 개발 서버가 출력한 pairing 주소를 연다.
2. Overlay가 URL fragment의 token을 현재 탭의 sessionStorage에 보관하고 fragment를
   제거한다.
3. Overlay가 token으로 control WebSocket을 인증한다.
4. REST 제어 요청은 같은 token을 Bearer Authorization header로 전송한다.

독립 작업 보드는 Overlay가
`GET /_visual/api/viewer-session`으로 호출마다 분리된 단기 viewer token과
`/_visual/viewer#visual-view=<token>` 주소를 발급받는다. 기본 유효 시간은 30분이며
Gateway 설정으로 조정할 수 있다. viewer token은 작업 목록,
상세, 파일, 로그, diff와 읽기 전용 WebSocket 이벤트만 허용하며 task 생성·취소·유지·
되돌리기 요청은 `403 read_only_token`으로 거부한다.

### 12.3 WebSocket envelope

```ts
interface ClientMessage<T = unknown> {
  id: string;
  type: string;
  browserSessionId: string;
  payload: T;
}

interface ServerEvent<T = unknown> {
  seq: number;
  type: string;
  projectId: string;
  taskId?: string;
  payload: T;
  createdAt: string;
}
```

### 12.4 주요 client message

```text
auth
browser.hello
browser.heartbeat
browser.page_state
browser.selection_created
task.create
task.cancel
task.accept
task.revert
task.follow_up
verification.target_state
verification.console_events
```

### 12.5 주요 server event

```text
project.state
task.queued
task.started
task.phase_changed
task.agent_output
task.file_changed
task.diff_ready
task.waiting_hmr
task.verification_result
task.completed
task.failed
task.canceled
task.reverted
browser.request_target_state
browser.request_console_events
```

### 12.6 재연결

- 모든 event는 project-local 증가 `seq`를 가진다.
- 브라우저는 마지막 수신 seq를 저장한다.
- 재연결 시 `lastSeq`를 전송한다.
- Bridge는 SQLite event log에서 누락 event를 replay한다.
- replay 보존 범위는 최근 1,000 event 또는 최근 task 50개로 제한한다.

---

## 13. Control API

WebSocket은 실시간 event와 command에 사용하고, 큰 artifact는 HTTP로 전달한다.

| Method | Path | 용도 |
|---|---|---|
| GET | `/_visual/api/health` | Bridge/upstream 상태 |
| GET | `/_visual/api/project` | 현재 프로젝트 정보 |
| POST | `/_visual/api/tasks` | task 생성 fallback |
| GET | `/_visual/api/tasks/:id` | task 상세 |
| GET | `/_visual/api/tasks/:id/diff` | unified diff |
| GET | `/_visual/api/tasks/:id/files` | 변경 파일 목록 |
| GET | `/_visual/api/tasks/:id/logs` | agent/check 로그 |
| POST | `/_visual/api/tasks/:id/cancel` | 취소 |
| POST | `/_visual/api/tasks/:id/accept` | 유지/닫기 |
| POST | `/_visual/api/tasks/:id/revert` | 최신 task 되돌리기 |
| GET | `/_visual/api/artifacts/:id` | screenshot 등 artifact |
| WS | `/_visual/ws` | 실시간 protocol |

모든 API와 WebSocket 연결은 Origin allowlist와 project ID 확인을 통과해야 한다.
control 요청은 pairing token, 읽기 전용 요청은 유효한 viewer token을 요구한다.

---

## 14. Task 상태 머신

```text
queued
  ↓
preparing
  ↓
snapshotting_before
  ↓
resolving_context
  ↓
running_agent
  ↓
snapshotting_after
  ↓
diffing
  ↓
waiting_hmr
  ↓
verifying
  ↓
review
  ├─ accepted
  ├─ reverted
  └─ follow_up → 새 task queued

어느 단계에서든:
failed / canceled / unsafe
```

### 14.1 상태 의미

| 상태 | 의미 |
|---|---|
| queued | 동일 저장소 writer가 사용 중이라 대기 |
| preparing | path, HEAD, index, browser session 검증 |
| snapshotting_before | task 직전 working tree snapshot 생성 |
| resolving_context | source path와 context 정규화 |
| running_agent | agent worker 실행 중 |
| snapshotting_after | 완료 후 working tree snapshot 생성 |
| diffing | before/after task diff 생성 |
| waiting_hmr | origin browser에서 화면 반영 관찰 |
| verifying | console, target, configured commands 검증 |
| review | 사용자 유지/되돌리기/후속 요청 대기 |
| unsafe | HEAD 변경, root 외 변경 등 안전 조건 위반 |

### 14.2 쓰기 잠금

Bridge마다 writer semaphore를 1로 고정한다.

```ts
writerConcurrency = 1;
```

- running agent와 post-verification이 종료될 때까지 lock 유지
- diff 조회, 로그 조회, browser heartbeat는 동시에 처리
- 다음 task는 queue 순서대로 실행
- queue 우선순위 변경은 MVP에서 제외

---

## 15. Agent Adapter

### 15.1 공통 인터페이스

```ts
interface AgentAdapter {
  id: string;

  probe(): Promise<AgentCapabilities>;

  run(
    input: AgentRunInput,
    signal: AbortSignal
  ): AsyncIterable<NormalizedAgentEvent>;

  resume?(
    input: AgentResumeInput,
    signal: AbortSignal
  ): AsyncIterable<NormalizedAgentEvent>;
}
```

```ts
interface AgentRunInput {
  taskId: string;
  repoRoot: string;
  workspaceRoot: string;
  prompt: string;
  contextBundlePath: string;
  environment: Record<string, string>;
  maxRunMs: number;
}
```

### 15.2 Adapter 종류

MVP 구현 순서:

1. generic shell adapter
2. Codex adapter
3. Claude Code adapter
4. OpenCode adapter

CLI별 option이나 JSON output 형식은 빠르게 바뀔 수 있으므로 Bridge core에 hard-code하지 않는다. adapter가 다음을 책임진다.

- 설치 여부와 버전 탐지
- 실행 argument 생성
- non-interactive 또는 PTY 선택
- stdout/stderr 파싱
- session ID 추출
- cancel 시 process group 종료
- 종료 code와 실패 원인 정규화
- 등록 worktree 안의 읽기 전용 탐색은 임시 MCP 도구의 `argv` 배치로 직접 실행
- 지원 명령은 RTK로 자동 변환하고, 셸 문법·변경 명령은 agent sandbox로 fallback

### 15.3 NormalizedAgentEvent

```ts
type NormalizedAgentEvent =
  | { type: "message"; text: string }
  | { type: "phase"; name: string }
  | { type: "tool_start"; name: string; summary?: string }
  | { type: "tool_end"; name: string; ok: boolean }
  | { type: "command"; command: string; cwd: string }
  | { type: "file_hint"; path: string }
  | { type: "session"; sessionId: string }
  | { type: "warning"; text: string }
  | { type: "error"; text: string }
  | { type: "complete"; summary?: string };
```

구조화 출력이 없는 CLI는 모든 출력을 `message` 또는 `error`로 전달하고 실제 변경 파일은 Git snapshot diff에서 판정한다.

### 15.4 Agent prompt template

```text
You are editing the repository at: <repoRoot>
Workspace: <workspaceRoot>

User request:
<request>

Selected UI context:
<context summary>

Source candidates:
<files / components / lines>

Scope requested by user:
<instance | page | component | project>

Rules:
- Inspect the relevant source before editing.
- Preserve unrelated existing changes.
- Do not edit outside the repository root.
- Do not access or modify denied paths.
- Do not run git commit, push, reset, clean, checkout, stash, or rebase.
- Keep the change focused on the request.
- Do not start another long-running dev server.
- Run only useful checks for the files changed.
- When finished, summarize changed files and any unresolved uncertainty.
```

Context JSON 전체는 임시 파일로 저장하고 prompt에는 경로와 압축 요약을 넣어 token 낭비를 줄인다.

### 15.5 Process 실행과 취소

- shell interpolation을 사용하지 않고 `spawn(executable, argv)`를 사용한다.
- task마다 새 process group을 만든다.
- cancel 시 SIGTERM을 보내고 grace period 후 SIGKILL한다.
- PTY가 필요한 adapter만 `node-pty`를 사용한다.
- maxRunMs 초과 시 동일한 cancel 절차를 수행한다.
- child stdout/stderr는 task log와 WebSocket으로 동시에 전달한다.

---

## 16. Git Transaction 설계

### 16.1 목표

다음 조건을 모두 만족해야 한다.

- task 시작 전에 이미 dirty change가 있어도 동작
- accepted task가 commit되지 않은 상태에서 후속 task 실행 가능
- task별 diff를 정확히 분리
- 최신 task만 안전하게 되돌리기
- 사용자의 기존 변경을 `git reset --hard`로 삭제하지 않기
- binary file과 file mode 변경 지원

### 16.2 숨은 snapshot 방식

실제 branch나 working tree를 변경하지 않고 temporary index와 Git object를 사용해 task 시작 시점의 파일 상태를 commit object로 만든다.

개념 절차:

```bash
PRE_HEAD=$(git rev-parse HEAD)
PRE_INDEX_TREE=$(git write-tree)

TMP_INDEX=$(mktemp)
GIT_INDEX_FILE="$TMP_INDEX" git read-tree "$PRE_HEAD"
GIT_INDEX_FILE="$TMP_INDEX" git add -A -- <allowed-pathspecs>
PRE_TREE=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)
PRE_COMMIT=$(printf 'visual task before\n' | git commit-tree "$PRE_TREE" -p "$PRE_HEAD")

git update-ref "refs/visual/tasks/<taskId>/before" "$PRE_COMMIT"
```

에이전트 종료 후 같은 방식으로 after snapshot을 만든다.

```bash
git update-ref "refs/visual/tasks/<taskId>/after" "$POST_COMMIT"
```

task diff:

```bash
git diff --binary --find-renames \
  refs/visual/tasks/<taskId>/before \
  refs/visual/tasks/<taskId>/after \
  -- <allowed-pathspecs>
```

이 방식은 현재 branch를 checkout하거나 stash하지 않으며, task 시작 전 dirty working tree를 before snapshot에 포함한다.

### 16.3 Snapshot 주의사항

- denied path는 temporary index에 추가하지 않는다.
- ignored build output은 snapshot 대상에서 제외한다.
- snapshot ref는 task retention 기간 동안 유지한다.
- Bridge가 정상 종료되어도 refs는 남겨 recovery에 사용한다.
- 오래된 accepted/reverted task refs는 `visual gc`로 제거한다.
- Git LFS, submodule, sparse checkout은 MVP에서 제한적으로만 지원하며 `visual doctor`에서 경고한다.

### 16.4 HEAD와 index 보호

task 시작 시 다음을 기록한다.

```text
preHead
preIndexTree
preStatusPorcelainV2
```

agent 종료 후:

- HEAD가 바뀌면 task를 `unsafe`로 처리한다.
- agent prompt는 commit/reset/stash를 금지한다.
- index tree가 바뀌면 경고하고 자동 accept하지 않는다.
- task 진행 중 사용자가 직접 stage/commit하는 동작은 지원하지 않는다.

MVP UI에는 다음 경고를 표시한다.

```text
이 저장소에서 AI 작업이 진행 중입니다.
작업 종료 전에는 직접 git stage/commit/reset을 수행하지 마세요.
```

### 16.5 변경 파일 감지

실시간 UI용으로 Chokidar를 사용하지만, 진실의 원천은 before/after Git snapshot이다.

```text
Chokidar → 빠른 “파일 수정 중” 표시
Git diff → 최종 변경 파일과 내용 확정
```

### 16.6 최신 task 되돌리기

MVP는 해당 저장소에서 **가장 최근에 완료된 미-revert task**만 되돌린다.

절차:

1. task의 before/after snapshot 존재 확인
2. task 이후 다른 task가 실행되지 않았는지 확인
3. 현재 파일이 after snapshot과 일치하는지 path별 비교
4. 충돌이 없으면 변경 path만 before snapshot으로 복원
5. after에만 존재하는 새 파일은 현재 hash가 after와 같을 때만 삭제
6. before에 존재했으나 task가 삭제한 파일은 before에서 복원
7. revert 결과 snapshot과 event 기록
8. HMR 및 browser verification 수행

개념 코드:

```bash
git restore \
  --source=refs/visual/tasks/<taskId>/before \
  --worktree \
  -- <modified-or-deleted-paths>
```

추가 파일은 별도 검증 후 안전하게 삭제한다.

현재 파일이 after snapshot과 다르면 자동 revert를 중단한다.

```text
되돌리기 충돌:
Task 완료 후 Header.tsx가 추가로 변경되었습니다.
자동으로 덮어쓰지 않았습니다.
```

### 16.7 Accept 의미

`accept`는 다음만 수행한다.

- task 상태를 accepted로 변경
- snapshot refs와 로그를 retention 대상으로 유지
- queue의 다음 task 실행 허용

다음을 수행하지 않는다.

- Git commit
- branch 생성
- push
- stash

---

## 17. HMR 및 브라우저 검증

### 17.1 기본 방향

Bridge는 별도 headless browser를 MVP 필수 요소로 두지 않는다. 사용자가 실제로 보고 있는 origin browser tab을 검증 대상으로 사용한다.

### 17.2 Browser render revision

Overlay는 다음 사건마다 `renderRevision`을 증가시킨다.

- page load/reload
- dev client reconnect
- HMR hook을 사용할 수 있을 때 update event
- 주요 DOM mutation debounce 완료

Bridge는 task 시작 revision과 task 완료 후 revision을 비교한다.

### 17.3 Target 재탐색

선택 당시 다음 locator 후보를 저장한다.

우선순위:

1. 고유 `data-testid` 또는 명시적 stable data attribute
2. id
3. role + accessible name
4. source location + component name
5. stable CSS selector
6. DOM parent path + sibling index
7. text hash + 주변 element 관계

HMR 후 동일 target을 찾으면 computed style, rect, text, source를 다시 수집한다.

결과:

```text
found-and-changed
found-no-visible-change
not-found
page-reloaded
unverified
```

### 17.4 Console 오류 수집

Overlay는 개발 모드에서 다음을 가볍게 감싼다.

- `console.error`
- `console.warn`
- `window.error`
- `unhandledrejection`

원본 console 동작은 유지한다. task 시작 시 timestamp를 기록하고 task 이후 새 오류만 검증 결과에 포함한다.

수집하지 않는 것:

- cookie
- Authorization header
- request body
- localStorage 값
- 전체 네트워크 trace

### 17.5 검증 명령

Bridge는 agent가 실행한 검사와 별개로 설정된 명령을 실행할 수 있다.

```yaml
verification:
  commands:
    - name: typecheck
      command: [pnpm, typecheck]
      timeoutMs: 120000
```

규칙:

- 기본값은 비어 있음
- 작은 CSS 변경마다 전체 test suite를 강제하지 않음
- command는 저장소 root 또는 workspace root에서 실행
- dev server와 충돌하는 long-running command 금지
- 결과는 pass/fail/timeout과 요약 로그로 저장

### 17.6 최종 검증 상태

```ts
type VerificationStatus =
  | "passed"
  | "partial"
  | "unverified"
  | "failed";
```

예:

```text
passed
- HMR/render revision 변경 감지
- 대상 재탐색 성공
- 새 console error 없음
- typecheck 성공
```

```text
partial
- 코드 diff 생성됨
- 대상 재탐색 성공
- HMR event는 명시적으로 확인하지 못함
```

HMR 감지 실패만으로 source 변경을 자동 revert하지 않는다. 사용자가 현재 화면을 직접 보고 판단할 수 있어야 한다.

---

## 18. SQLite 데이터 모델

DB 위치:

```text
$XDG_DATA_HOME/visual-bridge/<repoKey>/state.sqlite
```

로그:

```text
$XDG_STATE_HOME/visual-bridge/<repoKey>/logs/
```

### 18.1 `tasks`

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_text TEXT NOT NULL,
  scope TEXT NOT NULL,
  origin_browser_session_id TEXT,
  parent_task_id TEXT,
  agent_adapter TEXT NOT NULL,
  agent_session_id TEXT,
  pre_head TEXT,
  pre_index_tree TEXT,
  before_ref TEXT,
  after_ref TEXT,
  changed_files_count INTEGER DEFAULT 0,
  verification_status TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  accepted_at TEXT,
  reverted_at TEXT
);
```

### 18.2 `task_messages`

```sql
CREATE TABLE task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 18.3 `task_events`

```sql
CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 18.4 `task_artifacts`

```sql
CREATE TABLE task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);
```

### 18.5 `browser_sessions`

```sql
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  last_url TEXT,
  viewport_json TEXT,
  render_revision INTEGER DEFAULT 0,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disconnected_at TEXT
);
```

browser session은 장기 보관 가치가 낮으므로 주기적으로 정리한다.

---

## 19. Diff UI

### 19.1 기본 구성

대형 코드 편집기를 넣지 않는다. MVP diff drawer는 다음만 제공한다.

- 변경 파일 목록
- 파일별 added/modified/deleted/renamed 상태
- unified diff
- 추가/삭제 줄 수
- binary 변경 표시
- 검증 결과

```text
변경 파일 2개

M src/components/Header.tsx      +8 -5
M src/styles/header.css          +3 -3
```

### 19.2 Diff 생성 규칙

- before/after snapshot 사이에서 생성
- `--binary`와 rename detection 사용
- 최대 응답 크기 제한
- 큰 diff는 파일별 lazy load
- 민감 경로는 UI에 내용 노출 금지
- line ending 변경만 발생한 경우 경고

### 19.3 후속 요청

후속 요청은 이전 task의 전체 로그를 다시 넣지 않는다.

전달 정보:

- parent task ID
- 이전 사용자 요청
- agent summary
- 이전 task diff 요약
- 기존 target bundle
- 현재 target 재탐색 결과
- 새로운 사용자 요청

CLI가 resume session을 지원하면 adapter가 resume한다. 지원하지 않으면 새 worker를 실행하되 위 context를 prompt에 포함한다.

---

## 20. 보안 및 안전 경계

### 20.1 권한 모델

Bridge와 agent worker는 root가 아닌 현재 개발 사용자 권한으로 실행한다.

```text
금지: sudo visual dev
권장: 일반 개발 사용자로 visual dev
```

Bridge가 repository-specific process라고 해도 OS 수준에서 같은 사용자 권한의 다른 폴더 접근이 자동 차단되는 것은 아니다. MVP는 다음 방어를 적용한다.

- cwd를 repo root/workspace로 고정
- 모든 Bridge 파일 API에서 realpath 검사
- repo root 외 경로 거부
- symlink escape 검사
- allowed/denied path 적용
- agent prompt의 destructive Git 명령 금지
- HEAD/index 변화 감지
- child process environment 최소화 및 로그 redaction
- 직접 실행 도구는 `shell: false`, read-only allowlist, 최대 8개 명령, bounded output,
  worktree 내부 realpath `cwd`만 허용
- control API token 인증
- Origin allowlist
- Bridge는 `127.0.0.1`에만 bind

### 20.2 Agent sandbox

MVP 기본은 설치된 CLI 에이전트가 제공하는 workspace/sandbox 설정을 사용한다. Bridge 자체 OS sandbox는 필수 범위에서 제외한다.

향후 선택 옵션:

- bubblewrap
- systemd sandbox
- container
- worktree별 isolated runner

단, 에이전트 인증 파일과 package cache가 필요한 경우가 있어 초기부터 강제 sandbox를 넣으면 사용성이 크게 복잡해질 수 있다.

### 20.3 Pairing token 보호

- Bridge 시작마다 token rotation
- URL fragment 전달
- browser sessionStorage 보관
- access log에 token 기록 금지
- WebSocket 첫 auth 이후 미인증 message 폐기
- Origin mismatch 거부
- token 비교는 timing-safe 방식 사용

### 20.4 Browser context 개인정보 보호

기본적으로 전송하지 않는다.

- form input value
- password
- cookie
- storage values
- Authorization headers
- network bodies
- 전체 페이지 HTML

사용자가 선택한 요소의 표시 text는 context에 포함될 수 있으므로 개발 데이터에 민감 정보가 존재할 경우 프로젝트별 redaction rule을 추가할 수 있게 한다.

---

## 21. 장애 처리와 복구

### 21.1 Dev server crash

- Bridge는 유지
- upstream 상태를 `offline`으로 전환
- Overlay는 연결된 상태에서 오류 표시
- managed mode에서는 설정된 restart policy에 따라 dev server만 재시작
- active agent task는 source 수정이 가능하더라도 verification을 partial로 처리

### 21.2 Bridge crash

- agent child process는 parent-death 처리 또는 startup recovery에서 정리
- SQLite WAL 사용
- snapshot refs는 Git에 남으므로 복구 가능
- 다음 실행에서 `running_agent` 상태로 남은 task를 `interrupted`로 변경
- before ref와 현재 상태를 비교해 diff/revert 가능 여부 표시

### 21.3 Browser disconnect

- agent 작업은 계속 진행
- event는 SQLite에 저장
- 재연결 시 replay
- verification은 browser reconnect까지 잠시 기다린 뒤 partial 처리

### 21.4 Agent failure

- non-zero exit code 저장
- after snapshot은 반드시 생성해 partial changes 확인
- 변경이 있으면 사용자에게 diff와 다음 선택 제공

```text
에이전트는 실패했지만 2개 파일이 변경되었습니다.
[Diff] [변경 유지] [작업 전으로 복원]
```

### 21.5 Source mapping failure

- task 생성 자체는 허용
- confidence를 unknown으로 표시
- DOM/context를 agent에게 제공
- UI에 “소스 위치 추정 실패, 저장소 검색으로 진행” 표시

### 21.6 HEAD 변경 감지

task 중 branch HEAD가 변경되면 자동 accept/revert를 금지하고 `unsafe` 상태로 전환한다.

사용자에게 다음을 보여준다.

- pre HEAD
- current HEAD
- task diff snapshot
- 수동 복구 안내

Bridge가 임의로 reset하지 않는다.

---

## 22. 로깅과 관찰성

### 22.1 로그 종류

```text
bridge.log         lifecycle, request, error
agent-<task>.log   normalized agent output
raw-<task>.log     원본 stdout/stderr, 선택적
verify-<task>.log  검증 명령
```

### 22.2 로그 redaction

다음 pattern은 저장 전에 마스킹한다.

- `Authorization: Bearer ...`
- API key 형태
- viewer session token
- cookie header
- 환경변수 secret allowlist/denylist

### 22.3 기본 지표

대형 metrics stack은 도입하지 않는다. SQLite와 로그에 다음만 기록한다.

- task queue 대기 시간
- agent 실행 시간
- changed file 수
- task 성공/실패/취소
- HMR 확인 여부
- verification command 결과
- source mapping confidence

---

## 23. 테스트 전략

### 23.1 Unit test

- path normalization 및 repo escape 차단
- config merge/validation
- HTML streaming injection
- HTTP route 분기
- WebSocket envelope validation
- context truncation/redaction
- task state transition
- agent event parser
- temporary index snapshot
- diff/revert path 계산

### 23.2 Integration test

fixture repo를 실제 Git 저장소로 생성해 테스트한다.

시나리오:

- clean repo에서 task snapshot/diff/revert
- pre-existing dirty tracked file
- pre-existing untracked file
- task가 새 파일 생성
- task가 파일 삭제/rename
- binary file 변경
- denied path 변경 시 unsafe
- agent가 HEAD 변경 시 unsafe
- 최신 task 이외 revert 거부
- Bridge crash 후 interrupted task recovery

### 23.3 Browser E2E

Playwright fixture:

- Vite React app
- Next.js App Router app
- 단일 요소 선택
- multi-select
- region selection
- Shadow DOM Overlay가 app CSS와 격리되는지
- Korean IME composition 중 Enter 미전송
- task event 스트리밍
- HMR 후 target 재탐색
- browser reconnect/replay
- 두 브라우저 tab 연결

### 23.4 Multi-repository test

동일 서버에서 fixture repo 두 개를 실행한다.

```text
repo A gateway 4100 / upstream 44100
repo B gateway 4200 / upstream 44200
```

검증:

- 두 task 동시 실행
- 각 agent cwd가 올바름
- A의 파일 event가 B로 전송되지 않음
- B crash가 A에 영향 없음
- 각 Portr-like reverse proxy WebSocket 경로 독립

### 23.5 Portr 호환 test

실제 Portr 또는 동일한 HTTP tunnel 환경에서 다음을 확인한다.

- HTML 로드
- HMR WebSocket upgrade
- `/_visual/ws` upgrade
- 긴 agent event stream
- browser reconnect
- stable subdomain 재사용

---

## 24. 구현 단계

시간 추정이 아니라 의존 관계 기준 순서다.

### 단계 0. 저장소와 protocol skeleton

구현:

- pnpm workspace
- shared Zod schemas
- CLI skeleton
- config loader
- repo/worktree detection
- runtime registry와 lock

완료 조건:

- `visual init`, `visual status` 실행
- 동일 worktree 중복 실행 차단

### 단계 1. Gateway와 Overlay bootstrap

구현:

- HTTP/WS reverse proxy
- streaming HTML script injection
- Overlay bundle serving
- Shadow DOM toolbar
- pairing token으로 인증한 control WebSocket 연결
- browser session WebSocket

완료 조건:

- Vite/Next 화면과 HMR이 gateway를 통해 정상 동작
- Portr URL에서 Overlay 활성화

### 단계 2. Selection과 Context Bundle

구현:

- element/multi/region/page mode
- React Grab primitive adapter
- element-source resolver
- DOM/style/a11y context
- path normalization
- context size limit/redaction

완료 조건:

- 선택 요소의 실제 source 후보를 UI와 server에서 확인
- source mapping 실패 시에도 task context 생성

### 단계 3. Agent Task Runner

구현:

- task queue/state machine
- generic adapter
- Codex adapter
- Claude adapter
- event streaming
- cancel/timeout
- follow-up task

완료 조건:

- 브라우저 요청으로 실제 저장소 파일 수정
- 동일 저장소 요청은 순차 실행

### 단계 4. Git Transaction과 Diff/Revert

구현:

- before/after hidden snapshot
- task diff
- HEAD/index guard
- 최신 task revert
- recovery refs

완료 조건:

- 기존 dirty change가 있는 저장소에서 task diff 분리
- 최신 task만 안전하게 복원

### 단계 5. HMR/검증 및 UX 완성

구현:

- render revision
- target re-location
- console error capture
- verification commands
- progress pin
- diff drawer
- accept/revert/follow-up UI

완료 조건:

- 요청부터 결과 검토까지 브라우저에서 완료

### 단계 6. 다중 저장소 안정화

구현:

- runtime list
- 여러 Bridge 동시 부하 test
- crash recovery
- log retention/GC
- `visual doctor`

완료 조건:

- 원격 서버의 여러 저장소를 독립적으로 반복 사용

---

## 25. Definition of Done

MVP release 전에 아래 항목을 모두 확인한다.

### 실행

- [ ] `visual dev`가 Git root를 정확히 찾는다.
- [ ] dev server와 gateway를 함께 시작하고 종료한다.
- [ ] attach mode가 동작한다.
- [ ] HTTP와 HMR WebSocket이 proxy된다.
- [ ] Portr HTTP tunnel 뒤에서 Bridge WebSocket이 동작한다.

### Overlay

- [ ] Shadow DOM으로 app CSS와 격리된다.
- [ ] 단일/다중/영역/페이지 요청이 된다.
- [ ] 한국어 IME 입력이 안전하다.
- [ ] 선택 요소와 source 후보를 표시한다.
- [ ] 브라우저 새로고침 후 task 상태가 복원된다.

### Agent

- [ ] Codex 또는 1개 주력 agent adapter가 안정적으로 파일을 수정한다.
- [ ] 진행 로그가 브라우저에 나타난다.
- [ ] cancel과 timeout이 child process 전체를 종료한다.
- [ ] 동일 저장소 writer concurrency가 1이다.

### Git

- [ ] dirty tree에서 before/after snapshot을 생성한다.
- [ ] task 전용 diff가 정확하다.
- [ ] HEAD 변경을 감지한다.
- [ ] 최신 task revert가 기존 변경을 보존한다.
- [ ] 새 파일/삭제/rename/binary를 처리한다.

### 검증

- [ ] HMR 또는 page render 변화 상태를 표시한다.
- [ ] target을 다시 찾는다.
- [ ] 새 console error를 구분한다.
- [ ] 설정된 verification command 결과를 보여준다.

### 다중 프로젝트

- [ ] 서로 다른 두 저장소에서 Bridge가 동시에 실행된다.
- [ ] task/session/diff/log가 서로 섞이지 않는다.
- [ ] 한 Bridge 장애가 다른 Bridge에 영향을 주지 않는다.

---

## 26. 주요 위험과 대응

| 위험 | 대응 |
|---|---|
| React source 위치를 항상 얻지 못함 | `element-source`는 best-effort로 사용하고 DOM/context fallback 유지 |
| Next streaming HTML 주입 문제 | streaming transform, HTML content-type 엄격 판정, 수동 injection fallback |
| HMR event를 프레임워크마다 동일하게 잡기 어려움 | render revision + DOM mutation + target 재탐색으로 일반화 |
| dirty tree task diff 분리 어려움 | temporary Git index + hidden before/after commit snapshot |
| agent가 Git 명령을 수행함 | prompt 금지, HEAD/index guard, unsafe 상태 처리 |
| agent가 repo 밖을 접근함 | path guard + CLI sandbox 설정, 향후 OS sandbox |
| Portr URL이 외부에 노출됨 | 시작마다 회전하는 pairing token, Origin 검사, 공개 주소 관리 |
| 여러 task가 같은 파일을 충돌 수정 | 저장소당 writer 1개와 queue |
| Overlay가 app 조작을 방해함 | 비활성 시 pointer-events none, Shadow DOM, ignore subtree |
| screenshot 실패 | best-effort artifact로 취급하고 DOM/source context를 기본으로 사용 |

---

## 27. MVP 이후 확장 방향

우선순위 후보:

1. console error를 직접 선택해 수정 요청
2. 실패한 network request metadata 기반 디버깅 요청
3. 수정 전/후 screenshot 비교
4. 별도 verification browser를 통한 자동 클릭/입력
5. 동일 저장소 worktree 자동 생성과 병렬 preview
6. 여러 원격 호스트를 보는 얇은 coordinator
7. 브라우저 확장/CDP를 통한 정확한 screenshot과 network panel 통합
8. Vue/Svelte/Solid source resolver 확대
9. Canvas/WebGL 영역 context
10. 선택한 diff hunk만 부분 revert

중앙 supervisor가 필요해지는 시점은 다음 요구가 생겼을 때다.

- 서버 전체 agent worker 수 제한
- 여러 Bridge 일괄 시작/종료
- 여러 호스트 통합 목록
- 자동 worktree와 port 자원 할당

그 전까지는 저장소별 Bridge가 직접 작업을 담당하고 `visual list`가 runtime registry를 읽는 구조를 유지한다.

---

## 28. Architecture Decision Records

### ADR-001: 저장소/worktree마다 Bridge 1개

**결정:** 서버당 중앙 Agent daemon 대신 독립 Git working tree마다 동일한 Bridge 인스턴스를 실행한다.

**이유:** 경로/작업 큐/Git state 격리가 단순하고 한 프로젝트 장애가 다른 프로젝트에 전파되지 않는다.

### ADR-002: Bridge gateway가 dev server 앞에 위치

**결정:** dev server가 Bridge를 proxy하게 하지 않고 Bridge가 upstream dev server를 reverse proxy한다.

**이유:** 프레임워크별 project plugin을 최소화하고 HTTP/HMR/Control API를 하나의 Portr URL로 묶을 수 있다.

### ADR-003: 중앙 데몬 없음

**결정:** MVP에서는 systemd 상주 daemon과 coordinator를 만들지 않는다.

**이유:** 개인용 도구의 설치와 장애 범위를 줄이고, 실제로 필요한 기능을 foreground `visual dev`에 집중한다.

### ADR-004: 동일 저장소 writer 1개

**결정:** 동일 worktree의 source write task는 순차 처리한다.

**이유:** 파일 충돌과 HMR preview 혼선을 피하고 task별 revert를 단순하게 유지한다.

### ADR-005: Git hidden snapshot 기반 transaction

**결정:** `git reset --hard`나 stash 대신 temporary index와 hidden commit refs로 task 전후 상태를 저장한다.

**이유:** pre-existing dirty change를 보존하면서 task 전용 diff와 최신 task revert를 구현할 수 있다.

### ADR-006: 현재 browser tab은 읽기/검증 중심

**결정:** MVP에서 agent가 사용자 탭을 자동 클릭하거나 입력하지 않는다.

**이유:** 사용자 조작 충돌과 로그인/세션 손상을 피하고 핵심 수정 루프를 먼저 안정화한다.

---

## 29. 참고 구현 자료

아래 프로젝트를 제품으로 확장하는 것이 아니라, 선택 및 source context 계층을 구현할 때 API와 아이디어를 참고한다.

1. React Grab 공식 저장소  
   https://github.com/aidenybai/react-grab  
   화면 element 선택, component/source context, `react-grab/primitives` 기반 custom interface 가능 여부 참고.

2. element-source 공식 저장소  
   https://github.com/aidenybai/element-source  
   DOM element에서 source location, component name, component stack을 해석하는 resolver API 참고.

3. Portr 공식 문서  
   https://portr.dev/docs  
   HTTP tunnel과 self-hosted 공개 URL 구성 참고.

4. Portr WebSocket tunnel 문서  
   https://portr.dev/docs/client/websocket-tunnel  
   HTTP tunnel을 통한 WebSocket upgrade 전달 방식 참고.

---

## 30. 최종 구현 정의

> 각 독립 Git 저장소 또는 worktree에서 `visual dev`로 동일한 Agent Bridge를 실행한다. Bridge는 실제 dev server 앞의 reverse proxy로 동작하면서 개발 HTML에 자체 Overlay를 주입하고, Portr를 통해 앱·HMR·제어 채널을 한 URL로 제공한다. 사용자가 화면 요소나 영역을 선택해 요청하면 Bridge가 해당 저장소에서 한 명의 writer agent를 실행하고, hidden Git snapshot으로 task 전용 diff와 최신 작업 되돌리기를 보장한다. 서로 다른 저장소의 Bridge는 동시에 작업하되 같은 저장소의 쓰기 요청은 queue로 순차 처리한다.
