// 디버그 캡처 프록시 — Claude Code가 실제로 보내는 헤더/바디를 파일에 저장
import express from 'express';
import fs from 'fs';

const app = express();
const PORT = 8081;
const UPSTREAM = 'https://api.anthropic.com';
const LOG = '/tmp/cc-capture.json';

app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('/{*path}', async (req, res) => {
  const entry = {
    time: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body?.length ? req.body.toString() : null,
  };

  // 로그 파일에 추가
  fs.appendFileSync(LOG, JSON.stringify(entry, null, 2) + '\n---\n');
  console.log(`[CAPTURED] ${req.method} ${req.url}`);
  console.log('  auth:', req.headers['authorization']?.slice(0, 40) + '...');
  console.log('  beta:', req.headers['anthropic-beta']);
  console.log('  body:', entry.body?.slice(0, 200));

  // 그대로 upstream으로 포워딩
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['connection'];
  delete headers['accept-encoding']; // fetch가 자동 해제하므로 제거

  try {
    const upstream = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method,
      headers,
      body: ['GET','HEAD','OPTIONS'].includes(req.method) ? undefined : req.body,
      duplex: 'half',
    });

    console.log(`  -> upstream status: ${upstream.status}`);
    // 실패 원인도 캡처
    if (!upstream.ok) {
      const errBody = await upstream.text();
      console.log('  -> error body:', errBody);
      res.status(upstream.status).send(errBody);
      return;
    }

    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower !== 'transfer-encoding' && lower !== 'content-encoding') res.setHeader(k, v);
    });
    res.status(upstream.status);
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error('[ERR]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`캡처 프록시: http://localhost:${PORT}`);
  console.log(`로그: ${LOG}`);
  console.log(`실행: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude`);
});
