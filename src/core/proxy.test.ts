import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { type BeaconProxy, createProxy, type RequestRecord } from './proxy.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startUpstream(handler: http.RequestListener): Promise<{ url: string; port: number }> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port };
}

async function startProxy(upstream: string, maxRecords?: number): Promise<{ proxy: BeaconProxy; port: number }> {
  const proxy = createProxy({ upstream, port: 0, ...(maxRecords === undefined ? {} : { maxRecords }) });
  const { port } = await proxy.listen();
  cleanups.push(() => proxy.close());
  return { proxy, port };
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function send(port: number, path: string, body?: Buffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: body ? 'POST' : 'GET' }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settled = (proxy: BeaconProxy): Promise<RequestRecord> =>
  waitFor(() => proxy.requests().find((record) => record.outcome !== 'in_flight'), 'a settled record');

describe('createProxy', () => {
  it('passes method, path, query, headers and bytes through unchanged', async () => {
    const requestBody = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0xc3, 0x28]);
    const responseBody = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
    let seen: { method?: string; url?: string; custom?: string; host?: string; body?: Buffer } = {};
    const upstream = await startUpstream(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part as Buffer);
      seen = {
        ...(req.method === undefined ? {} : { method: req.method }),
        ...(req.url === undefined ? {} : { url: req.url }),
        custom: String(req.headers['x-custom']),
        host: String(req.headers.host),
        body: Buffer.concat(parts),
      };
      res.writeHead(201, { 'x-upstream': 'yes', 'content-length': responseBody.length });
      res.end(responseBody);
    });
    const { proxy, port } = await startProxy(upstream.url);

    const response = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        { port, path: '/api/chat?a=1&b=2', method: 'POST', headers: { 'x-custom': 'kept' } },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => parts.push(part));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }),
          );
        },
      );
      req.on('error', reject);
      req.end(requestBody);
    });

    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/chat?a=1&b=2');
    assert.equal(seen.custom, 'kept');
    assert.equal(seen.host, `127.0.0.1:${upstream.port}`);
    assert.deepEqual(seen.body, requestBody);
    assert.equal(response.status, 201);
    assert.equal(response.headers['x-upstream'], 'yes');
    assert.deepEqual(response.body, responseBody);

    const record = await settled(proxy);
    assert.equal(record.outcome, 'done');
    assert.equal(record.status, 201);
    assert.equal(record.bytes, responseBody.length);
    assert.equal(record.path, '/api/chat?a=1&b=2');
  });

  it('delivers each chunk as it arrives instead of buffering the response', async () => {
    let writeNext: (text: string) => void = () => {};
    let finish: () => void = () => {};
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      writeNext = (text) => res.write(text);
      finish = () => res.end();
      res.write('one\n');
    });
    const { proxy, port } = await startProxy(upstream.url);

    const received: string[] = [];
    const response = new Promise<void>((resolve, reject) => {
      http
        .get({ port, path: '/api/chat' }, (res) => {
          res.setEncoding('utf8');
          res.on('data', (part: string) => received.push(part));
          res.on('end', resolve);
        })
        .on('error', reject);
    });

    // The upstream only continues after the client got the previous chunk,
    // so a buffering proxy times out here.
    await waitFor(() => (received.length === 1 ? true : undefined), 'the first chunk');
    const running = proxy.requests()[0];
    assert.equal(running?.outcome, 'in_flight');
    assert.equal(running?.chunks, 1);
    assert.notEqual(running?.firstByteAt, null);
    assert.equal(running?.endedAt, null);

    writeNext('two\n');
    await waitFor(() => (received.length === 2 ? true : undefined), 'the second chunk');
    finish();
    await response;

    assert.deepEqual(received, ['one\n', 'two\n']);
    assert.equal((await settled(proxy)).chunks, 2);
  });

  it('propagates a client disconnect to the upstream', async () => {
    let upstreamClosed = false;
    const upstream = await startUpstream((_req, res) => {
      res.on('close', () => {
        upstreamClosed = true;
      });
      res.writeHead(200);
      res.write('partial');
    });
    const { proxy, port } = await startProxy(upstream.url);

    const req = http.get({ port, path: '/api/chat' });
    req.on('error', () => {});
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    await once(res, 'data');
    req.destroy();

    await waitFor(() => (upstreamClosed ? true : undefined), 'the upstream to close');
    const record = await settled(proxy);
    assert.equal(record.outcome, 'client_disconnected');
    assert.notEqual(record.endedAt, null);
  });

  it('answers 502 in ollama error shape when the upstream is unreachable', async () => {
    const closed = await startUpstream(() => {});
    await cleanups.pop()?.();
    const { proxy, port } = await startProxy(closed.url);

    const response = await send(port, '/api/ps');

    assert.equal(response.status, 502);
    const parsed = JSON.parse(response.body.toString()) as { error: string };
    assert.match(parsed.error, /upstream unreachable \(ECONNREFUSED\)/);
    const record = await settled(proxy);
    assert.equal(record.outcome, 'upstream_error');
    assert.equal(record.errorCode, 'ECONNREFUSED');
    assert.equal(record.status, null);
  });

  it('breaks the client connection when the upstream dies mid-response', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200);
      res.write('partial', () => req.socket.destroy());
    });
    const { proxy, port } = await startProxy(upstream.url);

    const failure = await new Promise<string>((resolve) => {
      http
        .get({ port, path: '/api/chat' }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve('clean end'));
          res.on('error', () => resolve('broken'));
        })
        .on('error', () => resolve('broken'));
    });

    assert.equal(failure, 'broken');
    const record = await settled(proxy);
    assert.equal(record.outcome, 'upstream_error');
    assert.equal(record.errorCode, 'ECONNRESET');
    assert.equal(record.bytes, 'partial'.length);
  });

  it('records upstream error statuses as completed responses', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"server busy"}');
    });
    const { proxy, port } = await startProxy(upstream.url);

    const response = await send(port, '/api/chat', Buffer.from('{}'));

    assert.equal(response.status, 503);
    assert.equal(response.body.toString(), '{"error":"server busy"}');
    const record = await settled(proxy);
    assert.equal(record.outcome, 'done');
    assert.equal(record.status, 503);
  });

  it('never stores request or response content', async () => {
    const upstream = await startUpstream(async (req, res) => {
      for await (const _ of req);
      res.end('response-secret');
    });
    const { proxy, port } = await startProxy(upstream.url);

    await send(port, '/api/chat', Buffer.from('prompt-secret'));
    await settled(proxy);

    const stored = JSON.stringify(proxy.requests());
    assert.doesNotMatch(stored, /prompt-secret/);
    assert.doesNotMatch(stored, /response-secret/);
  });

  it('evicts the oldest finished records and keeps in-flight ones', async () => {
    let release: () => void = () => {};
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/hang') {
        res.writeHead(200);
        res.write('x');
        release = () => res.end();
        return;
      }
      res.end('ok');
    });
    const { proxy, port } = await startProxy(upstream.url, 2);

    const hanging = http.get({ port, path: '/hang' });
    hanging.on('error', () => {});
    const [res] = (await once(hanging, 'response')) as [http.IncomingMessage];
    res.resume();

    for (const path of ['/first', '/second', '/third']) await send(port, path);

    const paths = proxy.requests().map((record) => record.path);
    assert.deepEqual(paths, ['/hang', '/third']);
    release();
  });

  it('binds to loopback unless told otherwise', async () => {
    const upstream = await startUpstream((_req, res) => res.end());
    const proxy = createProxy({ upstream: upstream.url, port: 0 });
    const { host } = await proxy.listen();
    cleanups.push(() => proxy.close());

    assert.equal(host, '127.0.0.1');
  });

  it('rejects an upstream that is not plain http', () => {
    assert.throws(() => createProxy({ upstream: 'https://example.com', port: 0 }), /must use http/);
  });
});
