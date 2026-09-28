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

- Pi Coding Agent (플러그인이 Pi의 패키지를 가져오지만, Pi가 직접 제공합니다).
- Node.js 22.5+ (내장 `node:sqlite` 사용).
- 검색, 이미지 생성, Remote Control은 OpenAI Codex 로그인(`/login` → OpenAI Codex)이 필요합니다. DuckDuckGo 검색과 상태줄은 로그인 없이도 동작합니다.

## 기능

### 웹 검색 도구 (`web_search`)

- **OpenAI Codex 모델**: Codex 구독의 네이티브 웹 검색을 사용합니다. 답변과 인용한 출처 URL을 반환하며, 현재 thinking level을 따릅니다.
- **그 외 모든 모델**: 무료 DuckDuckGo HTML 검색으로 대체됩니다 — 로그인이나 API key가 필요 없습니다. 최대 10개의 제목, 발췌문, URL을 반환합니다 (연결된 페이지 자체는 읽지 않습니다).
- 대화 기록은 전송하지 않습니다. 자동 재시도나 두 백엔드 간 대체도 없습니다. 선택적인 `urls`는 Codex가 확인하고, DuckDuckGo에서는 `site:` 필터로 사용합니다.

### Codex 이미지 생성 (`codex_generate_image`, `codex_image_job`, `view_image`)

- Codex 구독 로그인을 통해 이미지를 생성하거나 편집합니다 (API key 불필요). 독립 Codex Images 클라이언트와 동일한 방식으로 동작하며, 기본값은 `gpt-image-2.5-flare`, 정밀한 편집에는 `gpt-image-2.5-sunburst`를 선택할 수 있습니다.
- 백그라운드 작업은 한 번에 하나씩 실행되고 `.tmp/generated-images/`에 저장되며, 완료되면 세션에 결과를 알려줍니다.
- `codex_image_job`으로 작업 목록을 보거나 상태를 확인하거나 대기를 중지할 수 있고, `/codex-images` 명령으로도 동일하게 처리할 수 있습니다.
- `view_image`는 Pi의 내장 리더로 로컬 이미지를 현재 모델에게 보여줍니다. 이미지 생성 사용량을 소비하지 않습니다.

### 상태줄 푸터

모델, provider, 원격 제어 상태, 컨텍스트 사용량, 실시간 할당량을 표시하는 커스텀 푸터입니다.

- **Codex**: 5시간 및 주간 남은 비율과 초기화 카운트다운 표시 (`gpt-5.3-codex-spark`는 별도 한도).
- **Antigravity (Google)**: 모델 가족별 할당량 그룹.
- 60초마다 갱신되며, 색상은 truecolor 또는 ANSI-256 터미널에 자동으로 맞춰집니다.

### ChatGPT Remote Control (`/remote`)

ChatGPT 모바일 앱에서 이 Pi 호스트를 제어합니다.

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair`는 ChatGPT로 스캔할 QR 코드와 수동 페어링 코드를 보여줍니다.
- 로컬 `pi-codex-app-server` 데몬을 실행합니다 (세션 시작 시 자동 시작, `PI_CODEX_APP_SERVER_AUTOSTART=0`으로 비활성화 가능).
- 이전 별칭: `/codex-server`.

### 빠른 모드 (`/fast`)

`/fast on|off|status`로 Codex 모델의 `service_tier: "priority"`를 전환합니다. 설정은 `~/.pi/agent/codex-ish.json`에 저장됩니다.

### 스킬 언급 (`$skill-name`)

편집기에서 `$`를 입력하면 설치된 스킬이 자동 완성됩니다. `$some-skill`을 언급한 메시지는 해당 스킬의 전체 `SKILL.md`를 컨텍스트에 주입하므로, 한 번의 요청에 스킬을 강제로 로드할 수 있습니다.

### 사이드 대화 (`/btw` 또는 `/side`)

메인 대화를 읽기 전용 참조로 이어받는 임시 사이드 대화를 엽니다. 메인 스레드를 방해하거나 이어가지 않고 질문할 수 있으며, 사이드 에이전트는 어떤 것도 수정하지 않도록 지시됩니다. Ctrl+C로 닫고, PgUp/PgDn으로 스크롤합니다.

### 편집기 동작

- 클립보드에서 이미지 붙여넣기: `.tmp/images/`에 저장되고 markdown 링크로 삽입됩니다.
- `Shift+Enter` / `Alt+Enter`는 줄 바꿈 삽입, `Super+Enter` (Cmd+Enter)는 제출.
- 에이전트가 실행 중일 때 `Enter` / `Tab`은 개입 대신 후속 메시지를 큐에 넣습니다.
- Command+Enter는 현재 실행에 개입(steer)합니다.

## 설정

| 설정 | 위치 | 비고 |
|---|---|---|
| 빠른 모드 | `~/.pi/agent/codex-ish.json` | `/fast`가 저장 |
| Remote 데몬 홈 디렉터리 | `~/.pi/agent/codex-app-server/` | `PI_CODEX_APP_SERVER_HOME`으로 재정의 |
| Remote 자동 시작 | 환경 변수 | `PI_CODEX_APP_SERVER_AUTOSTART=0` 비활성화 |
| Remote 수신 주소 | 환경 변수 | `PI_CODEX_APP_SERVER_LISTEN` (기본값 `ws://127.0.0.1:0`) |
| Remote control 해제 | 환경 변수 | `PI_CODEX_REMOTE_CONTROL=0` |

## 의존성

- `pi-codex-app-server` — Remote Control 데몬 (npm).
- `qrcode` — 페어링용 터미널 QR 코드 (npm).

Pi 패키지 (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`)는 peer dependencies로 선언되어 있으며 Pi 자체가 제공합니다.

## 주의 사항

- 검색, 이미지 생성, Remote Control은 구독 로그인으로 OpenAI의 **ChatGPT backend API**를 호출합니다 — 공식 Codex 클라이언트가 사용하는 것과 동일한 엔드포인트이지만, 공개 문서화된 API가 아니며 변경될 수 있습니다.
- 이미지 생성은 Codex 사용량 할당량을 소비합니다. 작업 취소는 로컬 대기만 중지하며, 요청은 서버 측에서 계속 완료되어 사용량에 포함될 수 있습니다. 실패한 작업은 자동 재시도되지 않습니다.
- 검색이 반환한 웹 콘텐츠는 신뢰할 수 없는 데이터이며 지시가 아닙니다.
- 백그라운드 이미지 작업과 사이드 대화 오버레이는 대화형(TUI) 또는 RPC 세션이 필요합니다.

## 라이선스

MIT
