# claude-code-relay-proxy

Claude Code OAuth 토큰을 사용해 다른 계정으로 Claude Code를 사용할 수 있게 해주는 Node.js 프록시 서버입니다.

## 동작 방식

```
Claude Code → [Proxy :8080] → api.anthropic.com
```

Claude Code의 API 요청을 가로채어 `.env`에 설정된 OAuth 토큰으로 인증을 교체한 뒤 Anthropic API로 포워딩합니다.

- **스트리밍(SSE)** 완전 지원
- **토큰 자동 갱신** — 만료 5분 전 자동으로 refresh
- **중복 refresh 방지** — 동시 요청 시 하나의 refresh만 실행

## 인증 방식

Claude Code OAuth는 다음 두 헤더를 요구합니다:
- `Authorization: Bearer <access_token>`
- `anthropic-beta: oauth-2025-04-20` (+ Claude Code 추가 베타 헤더)

## 설치

```bash
npm install
cp .env.example .env
# .env에 토큰 입력
```

## 토큰 가져오기 (macOS)

```bash
security find-generic-password -s "Claude Code-credentials" -w | python3 -c "
import json, sys
d = json.load(sys.stdin)['claudeAiOauth']
print('ACCESS_TOKEN=' + d['accessToken'])
print('REFRESH_TOKEN=' + d['refreshToken'])
print('EXPIRES_AT=' + str(d['expiresAt']))
"
```

## 실행

```bash
npm start
```

## Claude Code 연결

```bash
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

또는 영구 설정:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
```

## 환경 변수

| 변수 | 설명 |
|------|------|
| `ACCESS_TOKEN` | OAuth access token (`sk-ant-oat01-...`) |
| `REFRESH_TOKEN` | OAuth refresh token (`sk-ant-ort01-...`) |
| `EXPIRES_AT` | access token 만료 시각 (unix ms, 선택) |
| `PORT` | 프록시 포트 (기본: 8080) |

## 참고

- CLIENT_ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- TOKEN_URL: `https://platform.claude.com/v1/oauth/token`
- Claude Code 바이너리 역분석으로 발견된 인증 방식
