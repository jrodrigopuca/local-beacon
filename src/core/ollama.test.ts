import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { probe } from './ollama.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  cleanups.push(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}

const json = (res: http.ServerResponse, body: unknown): void => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

// Shape taken from the real server in the 2026-10-31 spike.
const REAL_PS = {
  models: [
    {
      name: 'qwen3.5:4b',
      model: 'qwen3.5:4b',
      size: 4575712800,
      digest: '7f3251fa',
      details: { format: 'safetensors', quantization_level: 'nvfp4' },
      expires_at: '2026-10-31T12:59:19.057853-03:00',
      size_vram: 4575712800,
      context_length: 4096,
      runner: 'mlx',
    },
  ],
};

describe('probe', () => {
  it('returns version and loaded models from a healthy server', async () => {
    const url = await server((req, res) =>
      json(res, req.url === '/api/version' ? { version: '0.40.13' } : REAL_PS),
    );

    assert.deepEqual(await probe(url), {
      reachable: true,
      version: '0.40.13',
      models: [
        {
          name: 'qwen3.5:4b',
          runner: 'mlx',
          contextLength: 4096,
          sizeVram: 4575712800,
          expiresAt: '2026-10-31T12:59:19.057853-03:00',
        },
      ],
    });
  });

  it('accepts an idle server with no models', async () => {
    const url = await server((req, res) => json(res, req.url === '/api/version' ? { version: '1' } : { models: [] }));
    const result = await probe(url);
    assert.equal(result.reachable, true);
    assert.deepEqual(result.reachable && result.models, []);
  });

  it('tolerates fields a server version does not send', async () => {
    const url = await server((req, res) =>
      json(res, req.url === '/api/version' ? { version: '1' } : { models: [{ name: 'old' }] }),
    );
    const result = await probe(url);
    assert.deepEqual(result.reachable && result.models, [
      { name: 'old', runner: null, contextLength: null, sizeVram: null, expiresAt: null },
    ]);
  });

  it('reports a refused connection', async () => {
    const url = await server(() => {});
    await cleanups.pop()?.();
    const result = await probe(url);
    assert.equal(result.reachable, false);
    assert.equal(!result.reachable && result.reason, 'refused');
  });

  it('reports a timeout when the server hangs', async () => {
    const url = await server(() => {});
    const started = Date.now();
    const result = await probe(url, { timeoutMs: 50 });
    assert.equal(!result.reachable && result.reason, 'timeout');
    assert.ok(Date.now() - started < 1000);
  });

  it('reports a non-200 answer as a bad response', async () => {
    const url = await server((_req, res) => {
      res.statusCode = 500;
      res.end('nope');
    });
    const result = await probe(url);
    assert.equal(!result.reachable && result.reason, 'bad_response');
    assert.match(!result.reachable ? result.detail : '', /answered 500/);
  });

  it('reports something that is not ollama as a bad response', async () => {
    const url = await server((_req, res) => res.end('<html>a router</html>'));
    const result = await probe(url);
    assert.equal(!result.reachable && result.reason, 'bad_response');
    assert.match(!result.reachable ? result.detail : '', /did not answer JSON/);
  });

  it('reports JSON of the wrong shape as a bad response', async () => {
    const url = await server((req, res) => json(res, req.url === '/api/version' ? {} : { models: [] }));
    assert.equal((await probe(url)).reachable, false);

    const noList = await server((req, res) => json(res, req.url === '/api/version' ? { version: '1' } : {}));
    const result = await probe(noList);
    assert.equal(!result.reachable && result.reason, 'bad_response');

    const noName = await server((req, res) =>
      json(res, req.url === '/api/version' ? { version: '1' } : { models: [{}] }),
    );
    assert.equal((await probe(noName)).reachable, false);
  });
});
