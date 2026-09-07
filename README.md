# Visual Remote Dev Bridge

실행 중인 개발 화면에서 요소나 영역을 선택하고 자연어 요청을 보내면, 해당 Git
작업 트리에서 선택한 코딩 에이전트가 소스를 수정하도록 연결하는 저장소 전용 개발
브리지입니다.
브라우저에서 진행 상태, 변경 파일, 차이, 검증 결과를 확인하고 변경을 유지하거나
되돌릴 수 있습니다.

## 필수 환경

- Node.js 24.18.0
- Git
- 인증을 마친 `codex` 또는 `claude` 명령줄 도구
- Corepack으로 실행하는 pnpm 10.34.5
- 외부 접속이 필요하면 Portr와 같은 HTTP/WebSocket 터널

Node.js와 pnpm 버전은 각각 `.nvmrc`와 `package.json`에 고정되어 있습니다.
다른 Node.js 버전에서는 `engine-strict` 설정으로 설치가 중단됩니다.

## 가장 빠른 사용

Vite 또는 Next.js 앱의 `package.json`이 있는 폴더에서 한 번만 초기화합니다.
Next.js 자동 통합은 `instrumentation-client`를 지원하는 Next.js 15.3 이상이
필요합니다.

```bash
npx --yes visual-remote@latest init
```

`init`은 프로젝트 종류를 감지하고 다음 작업을 수행합니다.

- 현재 프로젝트에 `visual-remote`를 개발 의존성으로 설치합니다.
- Vite에서는 `vite.config`에 `visualRemote()` 플러그인을 추가합니다.
- Next.js에서는 `next.config`에 `withVisualRemote()`를 적용하고
  `instrumentation-client`에 개발 전용 클라이언트 로더를 추가합니다.
- 현재 폴더에 `.visualdev/config.yaml`을 생성합니다.

이후에는 앱을 평소처럼 실행합니다.

```bash
npm run dev
```

브라우저에서는 앱의 원래 주소를 그대로 엽니다. 앱이 `localhost:9011`에서
실행된다면 Visual Remote도 `http://localhost:9011`에서 표시됩니다. 내부 Bridge는
`10001`부터 빈 포트를 사용하지만 사용자가 그 포트로 접속할 필요는 없습니다.

```text
http://localhost:9011/api/*       → 기존 앱이 그대로 처리
http://localhost:9011/@vite/*     → 기존 Vite HMR이 그대로 처리
http://localhost:9011/_next/*     → 기존 Next.js 자산/HMR이 그대로 처리
http://localhost:9011/_visual/*   → 내부 Visual Remote Bridge로만 전달
```

이미 실행 중이던 개발 서버가 있다면 `init` 후 한 번 재시작해야 변경된 설정이
적용됩니다. Portr를 사용할 때도 내부 Bridge 포트가 아니라 기존 앱 포트만 노출합니다.

Next.js 기본 로컬 통합은 같은 프로토콜·앱 포트의 `localhost`와 `127.0.0.1`을
모두 허용합니다. `gateway.publicUrl`이나 비어 있지 않은 `security.allowedOrigins`를
직접 설정하면 이 별칭 자동 허용은 적용하지 않습니다. LAN·터널 주소는 해당 설정에
명시해야 하며, 무관한 주소나 다른 포트는 자동으로 허용하지 않습니다.

자동 통합은 Vite와 Next.js 프로젝트를 지원합니다. 다른 프레임워크나 설정 파일을
자동으로 수정하고 싶지 않은 프로젝트에서는 아래의 `attach` 방식을 사용할 수 있습니다.

## 저장소에서 개발

저장소를 받은 뒤 NVM을 불러오고 고정된 Node.js 버전을 선택합니다.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm install
nvm use
node --version
```

정상 출력은 다음과 같습니다.

```text
v24.18.0
```

의존성을 설치하고 브리지를 빌드합니다.

```bash
corepack pnpm install
corepack pnpm build
node apps/cli/dist/index.js doctor
```

`doctor`에서 Git 작업 트리, 현재 프로젝트 설정과 선택한 에이전트 실행 환경을 확인합니다.

에이전트 작업 중 `pwd`, 버전 확인, 파일 읽기·검색과 read-only Git 명령은 Bridge가
등록한 구조화 도구로 실행합니다. 이 경로는 명령을 `argv` 배열과 등록된 workspace
`cwd`로 전달하고 `shell: false`로 실행하며, 지원되는 명령은 RTK로 자동 압축합니다.
직접 실행기는 명령별 읽기 전용 문법만 허용하고 경로·symlink를 Git worktree 안으로
제한하며, 타임아웃 시 하위 프로세스까지 종료합니다. 명령 소요 시간, RTK 사용,
출력 축약 여부와 에이전트가 제공하는 토큰 사용량은 작업 로그에 함께 기록됩니다.
파일 수정, 테스트·빌드 또는 파이프처럼 셸 문법이 필요한 작업만 에이전트의 sandbox
명령 실행기로 보냅니다.

## 자동화 셸에서 Node.js 24 사용

비대화형 셸은 `.zshrc`를 읽지 않을 수 있으므로 NVM을 명시적으로 불러와야 합니다.
자동화 명령은 다음 형태로 실행합니다.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use --silent
node --version
corepack pnpm test
```

이 저장소의 `AGENTS.md`에도 같은 절차가 기록되어 있습니다. 자동화는 설치나
검증 전에 반드시 `node --version`이 `v24.18.0`인지 확인해야 합니다.

## 설정

`init`은 명령을 실행한 현재 프로젝트 폴더에 설정을 생성합니다. 모노레포의 하위
Vite 또는 Next.js 앱에서 실행하면 Git 루트가 아니라 해당 앱 폴더에 생성됩니다. 기존 설정은
덮어쓰지 않습니다.

```yaml
version: 1

project:
  id: my-web
  workspace: .

gateway:
  host: 0.0.0.0
  port: auto
  # publicUrl: https://visual.example.com

upstream:
  port: auto
  command:
    - corepack
    - pnpm
    - dev
    - --
    - --host
    - 0.0.0.0
    - --port
    - "{upstreamPort}"

agent:
  adapter: codex
  # profile: proxy
  # model: gpt-5.6-sol
  # reasoningEffort: medium
  # inheritEnv: [CUSTOM_PROVIDER_KEY]
  maxRunMs: 900000
  resumeMode: auto

verification:
  hmrWaitMs: 12000
  commands:
    - name: 타입 검사
      command: [corepack, pnpm, typecheck]
      timeoutMs: 120000

paths:
  allowed:
    - src/**
    - app/**
    - pages/**
    - components/**
    - styles/**
    - public/**
    - tests/**
    - package.json
  denied:
    - .git/**
    - .env
    - .env.*
    - "**/*.pem"
    - "**/*.key"
    - node_modules/**
    - dist/**
```

`agent.model`과 `agent.reasoningEffort`를 지정하면 새 작업과 재개 작업에 동일하게
적용됩니다. Codex effort는 `minimal`, `low`, `medium`, `high`, `xhigh`를, Claude
effort는 `low`, `medium`, `high`, `xhigh`, `max`를 지원합니다. 값을 생략하면 선택한
CLI의 현재 기본 설정을 사용합니다.

Claude를 사용하려면 `adapter: claude`로 변경합니다. Visual Remote는 Claude를
`acceptEdits` 권한으로 실행하고 사용자 MCP를 로드하지 않습니다. Linux에서 Bash
sandbox까지 사용하려면 `bwrap`과 `socat`이 모두 필요하며 `visual doctor`가 설치
상태를 표시합니다.

Codex의 OpenAI-compatible provider는 사용자 Codex profile에 정의하고
`agent.profile`로 선택합니다. provider는 Responses API streaming을 지원해야 합니다.
예를 들어 `$CODEX_HOME/proxy.config.toml`은 다음처럼 작성합니다.

```toml
model_provider = "proxy"

[model_providers.proxy]
name = "OpenAI-compatible proxy"
base_url = "https://proxy.example.com/v1"
wire_api = "responses"
env_key = "CUSTOM_PROVIDER_KEY"
```

API key 값은 YAML에 기록하지 않습니다. `agent.inheritEnv`에는 부모 프로세스에서
Codex 또는 Claude로 전달할 환경변수 이름만 작성하며, 누락된 변수는 `visual doctor`가
실패로 보고합니다. 개인별 선택은 Git에서 제외되는
`.visualdev/config.local.yaml`에 둘 수 있습니다.

`project.workspace`, `paths.allowed`, `paths.denied`는 설정 파일이 가리키는 앱 workspace
기준입니다. 모노레포의 `apps/web`에서 `init`했다면 `src/**`는
`apps/web/src/**`로 안전하게 정규화되고 에이전트의 기본 cwd도 `apps/web`이 됩니다.

Vite 플러그인 또는 Next.js 설정 래퍼가 개발 서버와 함께 내부 Bridge를 시작합니다.
`visual dev`가 Bridge를 먼저 소유한 경우 자식 Vite 플러그인은 runtime registry의
gateway를 재사용하며, 개발 서버가 닫혀도 비소유 Bridge를 종료하지 않습니다.
`agent`, `verification`, `paths` 같은 상세 설정만 YAML에서 조정하면 됩니다.

## 기존 attach 방식

다음 명령은 이전 버전과의 호환을 위해 남아 있습니다.

```bash
npx --yes visual-remote@latest http://localhost:9011
```

이 방식은 별도 Gateway 주소를 열어 앱 전체를 프록시합니다. 자동 통합을 사용할 수
있는 Vite와 Next.js 프로젝트에서는 `init`을 사용하고 원래 앱 주소로 접속합니다.
설정 파일을 변경하지 않거나 다른 프레임워크에 붙일 때는 `attach`를 사용합니다.
업스트림에 연결된 뒤 연결 실패가 5초간 계속되면 `attach` Bridge도 자동 종료됩니다.

## 브라우저에서 변경 요청

1. 개발 서버가 출력한 `Pair:` 주소를 엽니다. 토큰은 URL fragment에서 즉시 제거되고
   현재 탭의 sessionStorage에만 보관됩니다.
2. `Command+Shift+G` 또는 `Ctrl+Shift+G`로 오버레이를 열고 닫습니다.
3. 전체 작업 내역을 보려면 `작업 보드 ↗`를 눌러 별도 탭을 엽니다.
4. 변경을 요청하려면 요소 하나, 여러 요소, 영역 또는 페이지 전체를 선택합니다.
5. 원하는 변경 내용과 적용 범위를 입력합니다.
6. 진행 단계, 로그, 변경 파일, 차이와 검증 결과를 확인합니다.
7. 변경을 유지하거나, 최신 작업을 되돌리거나, 후속 요청을 보냅니다.

진행 패널의 `작업 최소화`를 누르면 작업은 백그라운드에서 계속되고, 현재 단계와
원래 요청 내용은 작은 진행 바로 남습니다. 다른 요소를 선택해 다음 요청을 추가할 수
있으며 `작업 펼치기`로 전체 패널을 복원합니다. 작업이 끝난 뒤에는 `닫기`로
패널만 치울 수 있고 작업 내역은 작업 보드에 남습니다.

작업 보드는 새 작업과 상태·로그·diff를 WebSocket으로 자동 갱신합니다. 보드에는
별도의 읽기 전용 세션 토큰만 전달되므로 작업 생성, 취소, 유지 또는 되돌리기 API를
호출할 수 없습니다. 읽기 세션은 기본 30분 동안 유효하며, 만료되면
Overlay에서 `작업 보드 ↗`를 다시 눌러 새 세션을 엽니다. 연결이 끊겼을 때는 헤더의 STREAM 상태를 확인하고 수동
`새로고침`을 복구 수단으로 사용할 수 있습니다. 요청 문구, Task ID와 변경 파일을
검색할 수 있고, `이전 작업 더 보기`로 100개씩 과거 기록을 불러옵니다.

`변경 유지`는 현재 작업 트리의 변경을 그대로 두는 동작입니다. Git 커밋이나
푸시는 자동으로 수행하지 않습니다.

같은 Git 작업 트리에서는 쓰기 작업을 한 번에 하나만 실행합니다. HMR, 브라우저
오류와 설정된 검증 명령의 결과가 확정된 뒤 큐의 다음 요청을 처리합니다.
되돌리기 역시 같은 쓰기 잠금을 사용합니다. 되돌리기 중 들어온 새 요청은 큐에서
대기하고, Bridge 종료도 진행 중인 되돌리기가 끝날 때까지 기다립니다.

중단된 작업을 복구할 때 이미 저장된 작업 후 스냅샷은 덮어쓰지 않습니다.
그 스냅샷 이후 사용자가 수정한 작업 대상 파일은 되돌리기 시 충돌로 처리해 보존합니다.
저장된 스냅샷 참조가 유효하지 않으면 현재 파일로 대체하지 않고 안전하지 않은 작업으로
표시해 되돌리기를 차단합니다.

## 명령줄 명령

현재 제공하는 명령은 다음과 같습니다.

```bash
npx --yes visual-remote@latest init
visual attach --help
visual dev --help
visual status
visual doctor
```

- `init`: 현재 Vite 또는 Next.js 앱에 개발 전용 통합을 설치합니다.
- `attach`: 기본 명령의 명시적 이름이며 기존 사용법과 호환됩니다.
- `dev`: `init` 설정을 사용해 앱과 브리지를 함께 실행하는 선택 명령입니다.
- `status`: 현재 Git 작업 트리의 브리지 실행 상태를 확인합니다.
- `doctor`: Git, 설정 파일, 개발 명령과 선택한 에이전트 사용 가능 여부를 점검합니다.

## 개발 및 검증

모든 명령은 Node.js 24.18.0에서 실행합니다.

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --prod
```

- 타입 검사는 브라우저, Node.js, 공유 프로토콜의 환경 경계를 각각 검사합니다.
- 단위 및 통합 테스트는 작업 큐, Git 스냅샷, Gateway, 에이전트와 검증 흐름을
  확인합니다.
- 빌드는 브라우저 오버레이와 Node.js 명령줄 프로그램을 각각 생성합니다.
- Pull request와 `main` push에서는 같은 테스트, 타입 검사와 빌드를 CI가 실행합니다.

빌드 결과는 다음 위치에 생성됩니다.

```text
packages/overlay/dist/client.js
packages/overlay/dist/viewer.js
apps/cli/dist/index.js
apps/cli/dist/vite.js
apps/cli/dist/next.js
apps/cli/dist/next-client.js
apps/cli/dist/direct-exec-mcp.js
```

## 저장소 구조

```text
apps/
└─ cli/                 명령줄 진입점과 실행 조립

packages/
├─ bridge-core/         설정, 작업, 에이전트, Git, 저장소와 검증
├─ gateway/             HTTP/WebSocket 역방향 프록시와 제어 경로
├─ overlay/             Shadow DOM 기반 브라우저 오버레이
└─ protocol/            브라우저와 Node.js가 공유하는 계약
```

의존 방향은 `CLI → Gateway → Bridge Core → Protocol`이며, Overlay는
Protocol만 의존합니다. Agent, Git, Storage는 불필요한 패키지 분할을 피하기 위해
Bridge Core 내부 모듈로 유지합니다.

## 문제 해결

### Node.js 22가 표시되는 경우

비대화형 셸이 NVM을 읽지 않은 상태입니다. 다음 명령을 실행하고 다시 확인합니다.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use --silent
node --version
```

### 포트를 사용할 수 없는 경우

브리지는 `10001`부터 사용 가능한 포트를 찾습니다. 직접 포트를 지정할 때도
`10001` 이상을 사용하고, 관련 개발 서버는 다음 빈 포트를 사용합니다.

### 설정 파일 경고가 표시되는 경우

Vite 또는 Next.js 앱의 `package.json`이 있는 폴더에서 `visual init`을 실행한 뒤
`doctor`를 다시 실행합니다. Vite는 `vite.config`, Next.js는 `next.config`와
`instrumentation-client`가 구성되어야 합니다. 모노레포에서는 Git 루트가 아니라
실제 앱 폴더에서 실행합니다.
