import 'dotenv/config';
import express from 'express';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const app = express();
const PORT = process.env.PORT || 8080;
const UPSTREAM = 'https://api.anthropic.com';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';
const OAUTH_BETA = 'oauth-2025-04-20';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// 모델별 가격 ($/1M tokens)
const PRICING = {
  'claude-opus-4':     { input: 15,   output: 75  },
  'claude-opus-4-5':   { input: 15,   output: 75  },
  'claude-opus-4-6':   { input: 15,   output: 75  },
  'claude-sonnet-4':   { input: 3,    output: 15  },
  'claude-sonnet-4-5': { input: 3,    output: 15  },
  'claude-sonnet-4-6': { input: 3,    output: 15  },
  'claude-haiku-4-5':  { input: 0.8,  output: 4   },
  'claude-3-opus':     { input: 15,   output: 75  },
  'claude-3-sonnet':   { input: 3,    output: 15  },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },
};

function getPrice(model) {
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return price;
  }
  return { input: 0, output: 0 };
}

function calcCost(model, input, output, cacheRead = 0, cacheWrite = 0) {
  const p = getPrice(model);
  return (input * p.input + output * p.output + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25) / 1_000_000;
}

// 사용량 통계 (메모리)
const stats = {
  startedAt: new Date().toISOString(),
  account: null, // { organization_name, organization_uuid, organization_role }
  requests: 0,
  errors: 0,
  models: {}, // { [model]: { requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } }
};

function recordUsage(model, usage) {
  if (!model || !usage) return;
  if (!stats.models[model]) {
    stats.models[model] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  }
  const m = stats.models[model];
  const inp  = usage.input_tokens || 0;
  const out  = usage.output_tokens || 0;
  const cr   = usage.cache_read_input_tokens || 0;
  const cw   = usage.cache_creation_input_tokens || 0;
  m.requests++;
  m.inputTokens      += inp;
  m.outputTokens     += out;
  m.cacheReadTokens  += cr;
  m.cacheWriteTokens += cw;
  m.costUsd          += calcCost(model, inp, out, cr, cw);
}

// SSE 스트림에서 usage 추출
function makeUsageInterceptor(onUsage) {
  let buf = '';
  let model = null;

  return (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // 마지막 미완성 줄 보존

    let lastEvent = null;
    for (const line of lines) {
      if (line.startsWith('event:')) lastEvent = line.slice(6).trim();
      if (line.startsWith('data:')) {
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.type === 'message_start' && d.message) {
            model = d.message.model || model;
            if (d.message.usage) onUsage(model, d.message.usage);
          }
          if (d.type === 'message_delta' && d.usage) {
            onUsage(model, d.usage);
          }
        } catch {}
      }
    }
  };
}

// 토큰 상태
const token = {
  access: process.env.ACCESS_TOKEN || '',
  refresh: process.env.REFRESH_TOKEN || '',
  expiresAt: 0,
  refreshing: null,
};

if (!token.refresh) {
  console.error('[ERROR] REFRESH_TOKEN이 .env에 없습니다.');
  process.exit(1);
}
if (token.access && process.env.EXPIRES_AT) {
  token.expiresAt = parseInt(process.env.EXPIRES_AT, 10);
}

async function doRefresh() {
  console.log('[AUTH] 토큰 갱신 중...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token.refresh, client_id: CLIENT_ID, scope: SCOPES }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`토큰 갱신 실패 (${res.status}): ${JSON.stringify(body)}`);
  token.access = body.access_token;
  if (body.refresh_token) token.refresh = body.refresh_token;
  token.expiresAt = Date.now() + body.expires_in * 1000;
  console.log(`[AUTH] 갱신 완료 (${Math.floor(body.expires_in / 60)}분 후 만료)`);

  // RTR: 갱신된 토큰만 .env에서 교체 (다른 설정 보존)
  try {
    const envPath = resolve(process.cwd(), '.env');
    const updates = {
      ACCESS_TOKEN: token.access,
      REFRESH_TOKEN: token.refresh,
      EXPIRES_AT: String(token.expiresAt),
    };
    let existing = '';
    try { existing = readFileSync(envPath, 'utf8'); } catch {}
    const lines = existing.split('\n').filter(Boolean);
    for (const [k, v] of Object.entries(updates)) {
      const idx = lines.findIndex(l => l.startsWith(`${k}=`));
      if (idx >= 0) lines[idx] = `${k}=${v}`;
      else lines.push(`${k}=${v}`);
    }
    writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
    console.log('[AUTH] .env 토큰 업데이트 완료');
  } catch (e) {
    console.warn('[AUTH] .env 저장 실패:', e.message);
  }
  fetchAccount().catch(() => {});
}

async function fetchAccount() {
  if (!token.access) return;
  const res = await fetch('https://api.anthropic.com/api/oauth/claude_cli/roles', {
    headers: { authorization: `Bearer ${token.access}`, 'anthropic-beta': OAUTH_BETA },
  });
  if (!res.ok) return;
  const d = await res.json();
  stats.account = {
    organization_name: d.organization_name,
    organization_uuid: d.organization_uuid,
    organization_role: d.organization_role,
  };
  console.log(`[ACCOUNT] ${d.organization_name} (${d.organization_role})`);
}

async function ensureToken() {
  if (token.access && Date.now() + REFRESH_MARGIN_MS < token.expiresAt) return;
  if (!token.refreshing) token.refreshing = doRefresh().finally(() => { token.refreshing = null; });
  await token.refreshing;
}

async function proxyRequest(req, res, retry = false) {
  await ensureToken();

  const url = `${UPSTREAM}${req.url}`;
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['connection'];
  delete headers['x-api-key'];
  delete headers['accept-encoding'];
  headers['authorization'] = `Bearer ${token.access}`;
  headers['anthropic-beta'] = headers['anthropic-beta']
    ? `${headers['anthropic-beta']},${OAUTH_BETA}`
    : OAUTH_BETA;

  const isBodyless = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // 요청 모델 파싱 (usage 기록용)
  let reqModel = null;
  try { reqModel = JSON.parse(req.body?.toString())?.model; } catch {}

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: isBodyless ? undefined : req.body,
    duplex: 'half',
  });

  if (upstream.status === 401 && !retry) {
    await upstream.body?.cancel();
    console.log('[AUTH] 401 — 토큰 무효화 후 재시도');
    token.access = '';
    token.expiresAt = 0;
    return proxyRequest(req, res, true);
  }

  if (!upstream.ok) stats.errors++;

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== 'transfer-encoding' && lower !== 'content-encoding') res.setHeader(key, value);
  });
  res.status(upstream.status);

  if (!upstream.body) { res.end(); return; }

  const isStream = (upstream.headers.get('content-type') || '').includes('event-stream');
  const intercept = isStream ? makeUsageInterceptor(recordUsage) : null;

  // 비스트리밍: 버퍼 모아서 usage 파싱 후 전송
  if (!isStream) {
    const chunks = [];
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const full = Buffer.concat(chunks);
    try {
      const d = JSON.parse(full.toString());
      if (d.usage) recordUsage(reqModel || d.model, d.usage);
    } catch {}
    res.end(full);
    return;
  }

  // 스트리밍
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) { res.end(); break; }
    const chunk = Buffer.from(value);
    intercept?.(chunk.toString());
    res.write(chunk);
  }
}

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ─── 대시보드 ─────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'dashboard.html'));
});

// ─── /usage 엔드포인트 ────────────────────────────────────────────────────────
app.get('/usage', (req, res) => {
  const totalInput  = Object.values(stats.models).reduce((s, m) => s + m.inputTokens, 0);
  const totalOutput = Object.values(stats.models).reduce((s, m) => s + m.outputTokens, 0);
  const totalCost   = Object.values(stats.models).reduce((s, m) => s + m.costUsd, 0);
  const totalReqs   = Object.values(stats.models).reduce((s, m) => s + m.requests, 0);

  const modelRows = Object.entries(stats.models)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([model, m]) => ({
      model,
      requests: m.requests,
      input_tokens: m.inputTokens,
      output_tokens: m.outputTokens,
      cache_read_tokens: m.cacheReadTokens,
      cache_write_tokens: m.cacheWriteTokens,
      cost_usd: +m.costUsd.toFixed(6),
    }));

  res.json({
    started_at: stats.startedAt,
    account: stats.account,
    total: {
      requests: totalReqs,
      errors: stats.errors,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: +totalCost.toFixed(6),
    },
    models: modelRows,
  });
});

// ─── 프록시 ───────────────────────────────────────────────────────────────────
app.all('/{*path}', async (req, res) => {
  stats.requests++;
  console.log(`[${req.method}] ${req.url}`);
  try {
    await proxyRequest(req, res);
  } catch (err) {
    stats.errors++;
    console.error('[PROXY ERROR]', err.message);
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

app.listen(PORT, async () => {
  console.log(`Claude Code Proxy: http://localhost:${PORT}`);
  console.log(`사용량:            http://localhost:${PORT}/usage`);
  await ensureToken();
  fetchAccount().catch(() => {});
});
