import 'dotenv/config';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;
const UPSTREAM = 'https://api.anthropic.com';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';
const OAUTH_BETA = 'oauth-2025-04-20';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5분

// 토큰 상태
const state = {
  accessToken: process.env.ACCESS_TOKEN || '',
  refreshToken: process.env.REFRESH_TOKEN || '',
  expiresAt: 0, // unix ms
  refreshing: null, // Promise (중복 refresh 방지)
};

if (!state.refreshToken) {
  console.error('[ERROR] REFRESH_TOKEN이 .env에 없습니다.');
  process.exit(1);
}

// access token이 있으면 만료 시각 설정
if (state.accessToken && process.env.EXPIRES_AT) {
  state.expiresAt = parseInt(process.env.EXPIRES_AT, 10);
}

async function doRefresh() {
  console.log('[AUTH] 토큰 갱신 중...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`토큰 갱신 실패 (${res.status}): ${JSON.stringify(body)}`);
  }

  state.accessToken = body.access_token;
  if (body.refresh_token) state.refreshToken = body.refresh_token;
  state.expiresAt = Date.now() + body.expires_in * 1000;

  const expiresInMins = Math.floor(body.expires_in / 60);
  console.log(`[AUTH] 토큰 갱신 완료 (${expiresInMins}분 후 만료)`);
}

async function ensureToken() {
  const needsRefresh = !state.accessToken || Date.now() + REFRESH_MARGIN_MS >= state.expiresAt;
  if (!needsRefresh) return;

  // 중복 refresh 방지 — 첫 번째 호출만 실행, 나머지는 대기
  if (!state.refreshing) {
    state.refreshing = doRefresh().finally(() => { state.refreshing = null; });
  }
  await state.refreshing;
}

async function proxyRequest(req, res, retry = false) {
  await ensureToken();

  const url = `${UPSTREAM}${req.url}`;
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['connection'];
  delete headers['x-api-key'];
  delete headers['accept-encoding'];
  headers['authorization'] = `Bearer ${state.accessToken}`;
  headers['anthropic-beta'] = headers['anthropic-beta']
    ? `${headers['anthropic-beta']},${OAUTH_BETA}`
    : OAUTH_BETA;

  const isBodyless = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: isBodyless ? undefined : req.body,
    duplex: 'half',
  });

  // 401 → 토큰 무효화 후 1회 재시도
  if (upstream.status === 401 && !retry) {
    await upstream.body?.cancel();
    console.log('[AUTH] 401 수신 — 토큰 무효화 후 재시도');
    state.accessToken = '';
    state.expiresAt = 0;
    return proxyRequest(req, res, true);
  }

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== 'transfer-encoding' && lower !== 'content-encoding') {
      res.setHeader(key, value);
    }
  });
  res.status(upstream.status);

  if (!upstream.body) { res.end(); return; }

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) { res.end(); break; }
    res.write(Buffer.from(value));
  }
}

app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('/{*path}', async (req, res) => {
  console.log(`[${req.method}] ${req.url}`);
  try {
    await proxyRequest(req, res);
  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Claude Code Proxy: http://localhost:${PORT}`);
  console.log(`사용법: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude`);
});
