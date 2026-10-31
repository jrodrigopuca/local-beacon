// Spike: passive proxy. Forwards bytes unchanged and only observes them.
import http from 'node:http';
import crypto from 'node:crypto';

const UPSTREAM = new URL(process.env.UPSTREAM ?? 'http://192.168.1.144:11434');
const PORT = Number(process.env.PORT ?? 11500);
const requests = new Map();

const server = http.createServer((clientReq, clientRes) => {
  if (clientReq.url === '/__requests') {
    clientRes.setHeader('content-type', 'application/json');
    clientRes.end(JSON.stringify([...requests.values()]));
    return;
  }

  const rec = {
    id: crypto.randomUUID().slice(0, 8),
    method: clientReq.method,
    path: clientReq.url,
    start: Date.now(),
    firstByteMs: null,
    lastChunkMs: null,
    chunks: 0,
    bytes: 0,
    status: null,
    end: null,
    outcome: 'in_flight',
  };
  requests.set(rec.id, rec);

  const upstreamReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: UPSTREAM.host },
    },
    (upstreamRes) => {
      rec.status = upstreamRes.statusCode;
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.on('data', (chunk) => {
        const now = Date.now() - rec.start;
        rec.firstByteMs ??= now;
        rec.lastChunkMs = now;
        rec.chunks += 1;
        rec.bytes += chunk.length;
        clientRes.write(chunk);
      });
      upstreamRes.on('end', () => {
        if (rec.outcome === 'in_flight') rec.outcome = 'done';
        rec.end = Date.now();
        clientRes.end();
      });
    },
  );

  upstreamReq.on('error', (err) => {
    if (rec.outcome === 'in_flight') rec.outcome = `upstream_error:${err.code}`;
    rec.end = Date.now();
    clientRes.destroy();
  });

  // Client gone before the response finished: propagate the disconnect upstream.
  clientRes.on('close', () => {
    if (!clientRes.writableFinished && rec.outcome === 'in_flight') {
      rec.outcome = 'client_disconnected';
      rec.end = Date.now();
      upstreamReq.destroy();
    }
  });

  clientReq.pipe(upstreamReq);
});

server.listen(PORT, '127.0.0.1', () => console.log(`proxy on 127.0.0.1:${PORT} -> ${UPSTREAM.href}`));
