# 저장소 자동화 규칙

## Node.js 실행 환경

- 이 저장소의 모든 설치, 검사, 테스트, 빌드 명령은 `.nvmrc`의 Node.js 버전으로 실행한다.
- 자동화 셸은 첫 프로젝트 명령 전에 다음 절차로 NVM을 불러온다.

  ```bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm use --silent
  ```

- `node --version`이 `v24.18.0`인지 확인한 뒤 작업을 계속한다.
- 패키지 관리 명령은 저장소에 고정된 `corepack pnpm`을 사용한다.

## RTK 사용

- 명령 출력의 토큰 사용량을 줄이기 위해 지원되는 터미널 명령은 RTK를 통해 실행한다. 자동 훅이 이미 RTK로 변환하는 경우 중복으로 감싸지 않는다.
- 작업 시작 시 `rtk --version`과 `rtk gain`으로 설치 및 정상 동작을 확인한다.
- 패키지 명령은 RTK 사용 시에도 `corepack pnpm`을 유지한다. 원본 출력이 필요한 진단이나 전용 필터가 없는 명령은 `rtk proxy corepack pnpm <명령>`처럼 실행한다.
- 출력이 축약되어 실패 원인이 불분명하면 `rtk proxy <명령>`으로 원본 출력을 확인한다. 부작용이 있는 명령은 출력 확인만을 위해 재실행하지 않는다.
- RTK는 출력 최적화 도구이며, 전용 파일 읽기·검색 도구 사용 규칙이나 명령 실행 권한을 대체하지 않는다.

## CodeGraph 사용

- 코드 구조를 탐색하거나 변경 영향 범위를 조사할 때 CodeGraph를 사용한다. 먼저 `codegraph status`로 인덱스 상태를 확인한다.
- 인덱스가 없으면 `codegraph init`으로 생성하고, 소스가 변경되어 인덱스가 오래되었으면 `codegraph sync`로 갱신한 뒤 조회한다.
- 작업 관련 코드는 `codegraph context "<작업 설명>"` 또는 `codegraph explore "<기능이나 영역>"`로 탐색한다.
- 심볼을 변경하기 전에 `codegraph callers <심볼>`과 `codegraph impact <심볼>`로 호출 관계와 영향 범위를 확인한다. 변경 후에는 `codegraph affected <변경 파일...>`로 관련 테스트를 찾는다.
- CodeGraph 결과는 탐색 근거로 사용하고 실제 소스와 테스트로 확인한다. 언어 서버가 제공하는 참조 조회·이름 변경은 LSP로 수행하며, CodeGraph 결과만으로 모든 참조를 찾았다고 판단하지 않는다.
- 도구 실행이나 인덱싱이 실패하면 실패 원인을 알리고 사용 가능한 LSP·검색 도구로 조사를 이어간다. CodeGraph를 실행하지 못했는데 사용했다고 보고하지 않는다.
