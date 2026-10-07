# pi-codex-ish

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

[Pi Coding Agent](https://github.com/earendil-works/pi)용 확장 플러그인으로, OpenAI Codex / ChatGPT 구독 경험을 Pi에서 사용할 수 있게 해줍니다. 구독 기반 웹 검색, Codex 이미지 생성, 사용량 표시 상태줄, ChatGPT Remote Control, 스킬 언급, 사이드 대화, Codex 스타일 편집기 동작을 제공합니다.

## 설치

```bash
pi install git:github.com/yanun0323/codex-ish
```

설치 후 Pi를 재시작하세요. 요구 사항:

- Pi Coding Agent 0.87.1+ (Remote는 호스트의 Pi SDK를 사용합니다).
- Node.js 22.19+ (내장 `node:sqlite` 사용). Remote는 현재 macOS와 Linux를 지원합니다.
- 검색, 이미지 생성, Remote Control은 OpenAI Codex 로그인(`/login` → OpenAI Codex)이 필요합니다. DuckDuckGo 검색과 상태줄은 로그인 없이도 동작합니다.

## 기능

### 웹 검색 도구 (`web_search`)

- **OpenAI Codex Responses 모델**: 현재 대화의 모델이 네이티브 웹 검색을 직접 사용합니다. 별도의 GPT 요청을 보내지 않으며 확장 기능의 2분 제한도 없습니다. 메인 대화의 내용, 구독 로그인, thinking level, 빠른 모드 설정을 사용하고 취소, 사용량, 시간 제한, 연결 재시도는 Pi의 provider가 관리합니다.
- **그 외 모든 provider**: 무료 DuckDuckGo HTML 검색을 사용합니다. 로그인이나 API key가 필요 없습니다. 최대 10개의 제목, 발췌문, URL을 반환하며 페이지 자체는 읽지 않습니다. 시간 제한은 30초, 출력 한도는 24 KB입니다. 대화 기록은 DuckDuckGo에 전송하지 않으며 선택적인 `urls`는 호스트 이름의 `site:` 필터로 사용합니다. 자동 재시도는 없습니다.
- `web_search`가 활성화된 경우에만 검색을 제공합니다. 확장 기능은 모델을 바꾸거나 검색 백엔드 간에 전환하지 않습니다. 다른 API를 사용하는 Codex 모델은 Codex Responses 모델로 바꿔야 합니다.
- **현재 Pi의 제한**: 네이티브 검색 이벤트와 구조화된 인용 정보는 도구 결과로 보존되지 않습니다. 답변에 실제 출처 링크를 넣도록 모델에 지시하지만 인용 표시를 보장하지는 않습니다. 별도의 검색 진행 카드나 구조화된 출처 목록은 없습니다.
- 업데이트 후 `/reload`를 실행하거나 Pi를 재시작해 새 검색 방식을 불러오세요.

### Codex 이미지 생성 (`codex_generate_image`, `codex_image_job`, `view_image`)

- Codex 구독 로그인을 통해 이미지를 생성하거나 편집합니다 (API key 불필요). 독립 Codex Images 클라이언트와 동일한 방식으로 동작하며, 기본값은 `gpt-image-2.5-flare`, 정밀한 편집에는 `gpt-image-2.5-sunburst`를 선택할 수 있습니다.
- 백그라운드 작업은 한 번에 하나씩 실행되고 `.tmp/generated-images/`에 저장되며, 완료되면 세션에 결과를 알려줍니다.
- `codex_image_job`으로 작업 목록을 보거나 상태를 확인하거나 대기를 중지할 수 있고, `/codex-images` 명령으로도 동일하게 처리할 수 있습니다.
- `view_image`는 Pi의 내장 리더로 로컬 이미지를 현재 모델에게 보여줍니다. 이미지 생성 사용량을 소비하지 않습니다.

### 상태줄 푸터

모델, provider, Git 브랜치, 원격 제어 상태, 컨텍스트 사용량, 실시간 할당량, 응답 속도를 표시하는 커스텀 푸터입니다.

- **Codex**: 5시간 및 주간 남은 비율과 초기화 카운트다운 표시 (`gpt-5.3-codex-spark`는 별도 한도).
- **Antigravity (Google)**: 모델 가족별 할당량 그룹.
- **DeepSeek API**: 선택한 모델의 Pi 인증 정보로 USD 잔액을 표시합니다. 공식 `api.deepseek.com`만 지원하며 USD 잔액이 없으면 `n/a`로 표시합니다. 위안화를 임의로 환산하지 않습니다.
- **Claude Bridge (`pi-claude-bridge`)**: bridge에 설치된 Claude Agent SDK와 Claude Code 로그인을 사용해 5시간 및 주간 남은 비율과 초기화 카운트다운을 표시합니다. 대기 중인 보조 프로세스는 사용량만 조회하며 모델 프롬프트를 보내거나 대화 기록을 훑지 않습니다. SDK 사용량 API는 실험 기능이므로 지원하지 않는 버전이나 로그인 방식에서는 `-`를 표시합니다. 필요하면 bridge를 업데이트하고 `/reload`를 실행하세요.
- `/statusline`은 열 항목의 독립적인 체크박스를 열며 기본적으로 모두 켜져 있습니다: `model-with-thinking`, `provider`, `git-branch`, `remote`, `context-used-percentage`, `quota-reset`, `context-used-tokens`, `context-window-tokens`, `output-speed`, `output-speed-avg5`. ↑/↓로 선택하고 Enter/Space로 전환하며 Esc로 닫습니다. 변경 사항은 바로 저장됩니다. `/statusline <field> on|off`로도 전환할 수 있으며 `/statusline status`로 설정을 확인합니다. 이전 버전의 provider별 스위치는 더 이상 적용되지 않습니다.
- `git-branch`는 현재 Git 브랜치 이름(예: `main`)만 `provider` 바로 뒤에 표시하며 독립적으로 표시를 켜고 끌 수 있습니다. Pi의 브랜치 변경 알림으로 자동 갱신합니다. Detached HEAD에서는 `detached`, 브랜치를 확인할 수 없거나 Git 저장소 밖에 있으면 `—`를 표시합니다.
- `output-speed`(`last 42.6 tok/s`)와 `output-speed-avg5`(`avg5 39.8 tok/s`)는 이 순서로 `context-window-tokens` 뒤에 표시되며 각각 독립적으로 표시를 켜고 끌 수 있습니다. 메인 대화의 모델 응답이 끝났을 때만 갱신하며, 보고된 출력 토큰 수(사고 토큰 포함)를 비어 있지 않은 첫 텍스트·사고·도구 호출 조각을 받은 시점부터 메시지가 완료될 때까지의 초로 나눠 계산합니다. 최초 대기 시간, Pi 도구 실행 시간, 유휴 시간은 제외합니다. 수신 측 추정값이며 서버 내부의 정확한 생성 속도는 아닙니다. `avg5`는 최근 유효한 응답 5개의 속도를 더한 뒤 개수로 나눈 평균이며, 5개 미만이면 현재 개수를 사용합니다. 비어 있지 않은 첫 조각과 마지막 조각 사이가 최소 100밀리초여야 하며, 비스트리밍 응답·조각이 하나뿐인 응답·그보다 짧은 응답은 제외합니다. 사고 토큰 수가 보고되어도 사고 조각이 없는 응답은 해당 사고 시간을 측정할 수 없으므로 제외합니다. 실패·취소된 응답이나 양수 출력 토큰 수가 보고되지 않은 응답도 제외합니다. 제외한 응답은 이전 유효 값을 바꾸지 않으며, 유효한 표본이 없으면 `—`를 표시합니다. 어느 항목을 숨겨도 측정은 계속됩니다. 표본은 메모리에만 보관하며 모델·대화 브랜치·세션을 바꾸거나 다시 불러오면 초기화됩니다.
- `quota-reset`은 **현재 provider**의 잔액 또는 남은 비율과 초기화 카운트다운만 표시하며 60초마다 갱신합니다. 이 항목을 끄거나 모델을 바꾸거나 세션을 종료하면 조회를 취소하고 Claude 보조 프로세스를 종료합니다. 다른 체크박스는 해당 항목의 표시만 바꾸므로 `remote`를 숨겨도 Remote Control은 중지되지 않습니다. 간결한 표시에서도 초기화 카운트다운을 유지하며 색상은 truecolor 또는 ANSI-256 터미널에 자동으로 맞춰집니다.

### ChatGPT Remote Control (`/remote`)

**실험 기능:** 모바일과 Mac의 Codex 클라이언트가 Pi 대화를 공유하도록 하는 내장 Remote 호스트입니다. 모의 클라이언트와 Pi SDK로 테스트했으며, 실제 macOS 데스크톱 앱의 페어링과 연결도 확인했습니다. iOS 페어링과 기본 메시지 전송은 확인했습니다. 앱의 전체 흐름과 실제 기기에서의 백그라운드 인계는 추가 검증이 필요합니다. `process/spawn`은 지원하지 않으므로 일부 데스크톱 터미널 기능을 사용할 수 없을 수 있습니다.

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair`는 확인을 받은 뒤 QR 코드와 수동 코드를 표시합니다. 두 기기를 같은 호스트에 페어링하고 같은 대화를 여세요. OpenAI 중계 서비스와 Pi의 ChatGPT 구독 로그인은 여전히 필요합니다.
- 대화마다 실행을 담당하는 Pi는 하나입니다. Pi 창이 열려 있으면 원래 Pi가 처리하고, 닫힌 뒤 Codex에서 메시지를 보내면 같은 저장된 Pi 세션을 백그라운드에서 이어갑니다. 기록과 브랜치 내용을 유지하며 기록을 보기만 할 때는 모델을 호출하지 않습니다. Pi에서 다시 열 때는 백그라운드 작업이 대기 중인 경우에만 실행을 돌려줍니다. 실행 중이거나 Pi를 여는 동안 기록이 바뀌었다면 나중에 다시 여세요. 오래된 내용으로 쓰거나 중단된 작업을 자동으로 반복하지 않습니다.
- 업데이트 후 기존 Pi 창을 닫거나 모든 창에서 `/reload`를 한 번씩 실행하세요. Pi 프로세스가 살아 있으면 연결이 끊겼다는 이유만으로 인계하지 않습니다. 실행자 정보가 없는 이전 버전의 창도 안전을 위해 인계를 잠시 막습니다. Remote에 등록되었으며 저장 파일이 있는 대화에 적용됩니다. 삭제된 대화나 메모리에만 있는 대화는 제외됩니다. Mac과 활성화된 Remote 서비스는 계속 실행되어야 합니다. Pi 창은 닫아도 되지만 `/remote stop`, 절전 또는 종료 후에는 원격으로 사용할 수 없습니다.
- 홈 디렉터리 탐색, 폴더 생성, 공유 프로젝트 API를 제공합니다. 홈 밖의 프로젝트를 등록할 수 있는 것은 로컬 Pi뿐입니다. 파일 브라우저가 알려진 인증 정보 위치를 숨기지만 **샌드박스는 아닙니다**. 페어링된 기기는 호스트 사용자 권한으로 Pi 도구를 사용할 수 있습니다. 신뢰하는 기기만 페어링하세요.
- App에 표시되는 `~/.codex`는 가상 디렉터리입니다. 상위 경로는 Pi 호스트의 홈이며 실제 Codex 인증 정보를 공개하지 않습니다. 이미지 업로드 경로는 `~/.codex/attachments/<UUID>/...`이며 실제 파일은 비공개 Remote 디렉터리의 `client-files/attachments/`에 저장합니다. PNG, JPEG, WebP, GIF를 지원하며 이미지당 8 MiB, 전체 128 MiB, 파일과 폴더 각각 최대 256개로 제한합니다. 파일 쓰기와 삭제는 첨부 영역에서만 허용하며 다른 파일 업로드는 지원하지 않습니다. 탐색에는 `~`, `~/...`, 로컬 file URL도 사용할 수 있습니다.
- 내장 백그라운드 서비스와 인증된 비공개 Unix socket을 사용하며, `pi-codex-app-server`나 `codex` 실행 파일은 필요 없습니다. Pi 세션이 시작되면 로컬 서비스를 시작합니다 (`PI_CODEX_APP_SERVER_AUTOSTART=0`으로 해제). 처음 중계 서비스에 연결하려면 `/remote start` 또는 `/remote pair`를 실행해야 하며, 활성화한 호스트는 재시작 후 다시 연결됩니다. `/remote stop`은 서비스를 비활성화하고 종료하지만 터미널 Pi 작업은 멈추지 않습니다.
- 별도의 상태 디렉터리를 사용합니다. 이전 서비스가 실행 중이면 `/remote stop` 후 `/remote pair`를 실행하세요. 기존 데이터와 페어링은 옮기거나 삭제하지 않습니다. 호스트는 원래 ChatGPT 계정에 연결됩니다. 되돌리려면 새 서비스를 멈추고 이전 버전을 다시 설치하세요. 기존 상태는 보존됩니다.
- Codex App Server API 일부만 구현했습니다. Codex 데스크톱이 자동으로 보내는 전용 설정(기능 플래그, 추가 지침, 성격)은 적용하지 않고 안내를 표시합니다. Pi의 로컬 설정을 유지하며 알 수 없는 설정 덮어쓰기, 미지원 메서드, 샌드박스나 승인 정책 변경은 계속 오류를 반환합니다. 진행 중인 터미널 작업을 백그라운드로 넘기지 않습니다. 터미널 재연결이나 브랜치 변경 후 대화를 다시 읽고, 실행 결과가 불확실한 작업을 무조건 재전송하지 마세요. 마지막 미지원 앱 요청은 `/remote status`에서 확인할 수 있습니다.
- 이전 별칭: `/codex-server`. 프로토콜 테스트는 Codex commit `444da310e108da16aaeb18fd790b0ac464f08aca`를 기준으로 합니다.

### 빠른 모드 (`/fast`)

`/fast on|off|status`로 Codex 모델의 `service_tier: "priority"`를 전환합니다. 설정은 `~/.pi/agent/codex-ish.json`에 저장됩니다.

### 스킬 언급 (`$skill-name`)

편집기에서 `$`를 입력하면 설치된 스킬이 자동 완성됩니다. `$some-skill`을 언급한 메시지는 해당 스킬의 전체 `SKILL.md`를 컨텍스트에 주입하므로, 한 번의 요청에 스킬을 강제로 로드할 수 있습니다.

### 사이드 대화 (`/btw` 또는 `/side`)

메인 대화를 참조하는 메모리 내 읽기 전용 사이드 대화를 엽니다. Pi 내장 `read`, `grep`, `find`, `ls` 도구만 사용할 수 있습니다. Side는 조회를 실행하고 결과를 모델에 전달해 답변을 이어갑니다. 셸, 파일 변경 도구, 확장 도구는 제공하지 않습니다. 질문마다 모델 요청은 최대 8회, 도구 호출은 최대 24회입니다. TUI 모드가 필요합니다. Side는 창 전체를 덮는 오버레이로 열리며, 스크롤해도 메인 대화는 움직이지 않습니다. PgUp/PgDn으로 스크롤하고, 입력란이 비어 있으면 ↑/↓도 사용할 수 있습니다. 전체 화면 모드에서는 마우스 휠과 트랙패드도 지원하며, 일반 모드에서는 키보드를 사용하세요. Esc 또는 Ctrl+C로 닫으면 진행 중인 작업을 취소하며, 브랜치 변경이나 세션 종료 시에도 취소합니다.

### 편집기 동작

- 클립보드에서 이미지 붙여넣기: `.tmp/images/`에 저장되고 markdown 링크로 삽입됩니다.
- `Shift+Enter` / `Alt+Enter`는 줄 바꿈 삽입, `Super+Enter` (Cmd+Enter)는 제출.
- 에이전트가 실행 중일 때 `Enter` / `Tab`은 개입 대신 후속 메시지를 큐에 넣습니다.
- Command+Enter는 현재 실행에 개입(steer)합니다.

## 설정

| 설정 | 위치 | 비고 |
|---|---|---|
| 빠른 모드 | `~/.pi/agent/codex-ish.json` | `/fast`가 저장 |
| 상태줄 표시 항목 | `~/.pi/agent/codex-ish.json`의 `statusline` | `/statusline`이 저장하며 `/fast`와 독립적 |
| Remote 상태 디렉터리 | `~/.pi/agent/codex-ish-remote/` | `PI_CODEX_ISH_REMOTE_HOME`으로 재정의. 비공개로 유지하세요 |
| Remote 자동 시작 | 환경 변수 | `PI_CODEX_APP_SERVER_AUTOSTART=0` 비활성화 |
| Remote 로컬 연결 | Remote 디렉터리의 `host.sock` | 비공개 Unix socket. `PI_CODEX_APP_SERVER_LISTEN`은 더 이상 사용하지 않음 |
| Remote 호스트 이름 | 환경 변수 | `PI_CODEX_APP_SERVER_HOST_NAME` |
| Remote control 해제 | 환경 변수 | `PI_CODEX_REMOTE_CONTROL=0` |

## 의존성

- `ws` — 내장 Remote 호스트의 WebSocket 통신 (npm).
- `qrcode` — 페어링용 터미널 QR 코드 (npm).

Pi 패키지 (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`)는 peer dependencies로 선언되어 있으며 Pi 자체가 제공합니다.

Git 설치 시 `prepare`가 Remote 호스트를 컴파일합니다. 소스에서 개발하려면 `npm ci`, `npm run check`, `npm test`를 실행하세요. `npm pack --dry-run`으로 `dist/remote`가 포함되는지 확인할 수 있습니다. 테스트는 임시 디렉터리, 모의 인증 정보, 로컬 서버만 사용하며 실제 기기를 페어링하거나 유료 모델을 호출하지 않습니다.

## 주의 사항

- 검색, 이미지 생성, Remote Control은 구독 로그인으로 OpenAI의 **ChatGPT backend API**를 호출합니다 — 공식 Codex 클라이언트가 사용하는 것과 동일한 엔드포인트이지만, 공개 문서화된 API가 아니며 변경될 수 있습니다.
- 이미지 생성은 Codex 사용량 할당량을 소비합니다. 작업 취소는 로컬 대기만 중지하며, 요청은 서버 측에서 계속 완료되어 사용량에 포함될 수 있습니다. 실패한 작업은 자동 재시도되지 않습니다.
- 검색이 반환한 웹 콘텐츠는 신뢰할 수 없는 데이터이며 지시가 아닙니다.
- 백그라운드 이미지 작업에는 대화형(TUI) 또는 RPC 세션이 필요합니다. 사이드 대화에는 TUI 모드가 필요합니다.

## 라이선스

MIT. `tests/fixtures/codex/`의 업스트림 프로토콜 테스트 데이터는 원래 Apache-2.0 라이선스와 고지를 유지합니다.
