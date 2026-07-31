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
