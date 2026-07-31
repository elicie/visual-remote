# Visual Remote Dev Bridge

실행 중인 개발 화면에서 요소나 영역을 선택하고 자연어 요청을 보내면, 해당 Git
작업 트리에서 Codex가 소스를 수정하도록 연결하는 저장소 전용 개발 브리지입니다.
브라우저에서 진행 상태, 변경 파일, 차이, 검증 결과를 확인하고 변경을 유지하거나
되돌릴 수 있습니다.

## 필수 환경

- Node.js 24.18.0
- Git
- 인증을 마친 `codex` 명령줄 도구
- Corepack으로 실행하는 pnpm 10.34.5
- 외부 접속이 필요하면 Portr와 같은 HTTP/WebSocket 터널

Node.js와 pnpm 버전은 각각 `.nvmrc`와 `package.json`에 고정되어 있습니다.
다른 Node.js 버전에서는 `engine-strict` 설정으로 설치가 중단됩니다.

## 빠른 시작

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

`doctor`에서 Git 작업 트리는 통과하고, 아직 `.visualdev/config.yaml`을 만들지
않았다면 attach 기본값을 사용할 수 있다는 경고가 표시됩니다.

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

## 기존 개발 서버에 연결

먼저 대상 애플리케이션의 개발 서버를 `10001` 이상의 포트에서 실행합니다. 다음
예시는 애플리케이션이 `0.0.0.0:10002`에서 실행 중인 경우입니다.

```bash
node apps/cli/dist/index.js attach \
  --upstream http://127.0.0.1:10002 \
  --listen 10001
```

브리지는 `0.0.0.0:10001`에 바인딩하고 다음과 같은 주소를 출력합니다.

```text
Gateway:  http://dev:10001
Pair URL: http://dev:10001/#visual-pair=...
```

브라우저에서는 일반 Gateway 주소가 아니라 처음 한 번 Pair URL을 엽니다. Pair
토큰은 주소 조각에서 즉시 제거되고 해당 브라우저 세션에만 저장됩니다.

Portr를 사용한다면 원래 개발 서버 포트가 아니라 브리지 Gateway 포트 `10001`을
노출해야 합니다. 앱 화면, 개발 서버의 HMR, 브리지 제어 채널이 한 출처를
사용합니다.

## 개발 서버와 브리지를 함께 실행

저장소 루트에 `.visualdev/config.yaml`을 만듭니다. 명령은 셸 문자열이 아니라
인자 배열로 작성합니다.

```yaml
version: 1

project:
  id: my-web
  workspace: .

gateway:
  host: 0.0.0.0
  port: 10001

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
  maxRunMs: 900000

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

설정 후 다음 명령을 실행합니다.

```bash
node apps/cli/dist/index.js dev
```

브리지가 개발 서버 프로세스를 시작하고 종료까지 관리합니다. Next.js 프로젝트는
`next.config.*`의 `allowedDevOrigins`에 `dev`를 반드시 포함해야 합니다.

## 브라우저에서 변경 요청

1. 출력된 Pair URL을 엽니다.
2. `Command+Shift+G` 또는 `Ctrl+Shift+G`를 눌러 오버레이를 엽니다.
3. 요소 하나, 여러 요소, 영역 또는 페이지 전체를 선택합니다.
4. 원하는 변경 내용과 적용 범위를 입력합니다.
5. 진행 단계, 로그, 변경 파일, 차이와 검증 결과를 확인합니다.
6. 변경을 유지하거나, 최신 작업을 되돌리거나, 후속 요청을 보냅니다.

`변경 유지`는 현재 작업 트리의 변경을 그대로 두는 동작입니다. Git 커밋이나
푸시는 자동으로 수행하지 않습니다.

같은 Git 작업 트리에서는 쓰기 작업을 한 번에 하나만 실행합니다. HMR, 브라우저
오류와 설정된 검증 명령의 결과가 확정된 뒤 다음 요청을 처리합니다.

## 명령줄 명령

현재 제공하는 명령은 다음과 같습니다.

```bash
node apps/cli/dist/index.js attach --help
node apps/cli/dist/index.js dev --help
node apps/cli/dist/index.js status
node apps/cli/dist/index.js doctor
```

- `attach`: 이미 실행 중인 개발 서버 앞에 브리지를 연결합니다.
- `dev`: 설정된 개발 서버와 브리지를 함께 실행합니다.
- `status`: 현재 Git 작업 트리의 브리지 실행 상태를 확인합니다.
- `doctor`: Git, 설정 파일, 개발 명령과 Codex 사용 가능 여부를 점검합니다.

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

빌드 결과는 다음 위치에 생성됩니다.

```text
packages/overlay/dist/client.js
apps/cli/dist/index.js
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

기존 서버에 연결하는 `attach`는 설정 파일 없이도 기본값으로 실행할 수 있습니다.
브리지가 개발 서버를 직접 관리해야 한다면 `.visualdev/config.yaml`을 작성한 뒤
`doctor`를 다시 실행합니다.
