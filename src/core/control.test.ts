import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createControlClient, ProxyNotRunning } from './control-client.ts';
import { createControlServer, defaultSocketPath } from './control.ts';
import { type BeaconProxy, createProxy } from './proxy.ts';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDirectory(): string {
  // /tmp, not os.tmpdir(): macOS' is long enough to exceed the socket path limit.
  const directory = mkdtempSync('/tmp/lbeacon-');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function fakeOllama(
  onChat?: http.RequestListener,
  psBody = '{"models":[]}',
): Promise<{ url: string; stop: () => Promise<void>; probes: () => number }> {
  let probes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') {
      probes += 1;
      return void res.end('{"version":"0.40.13"}');
    }
    if (req.url === '/api/ps') return void res.end(psBody);
    return onChat?.(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  cleanups.push(stop);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stop, probes: () => probes };
}

async function stack(
  onChat?: http.RequestListener,
  socketPath = join(tempDirectory(), 'control.sock'),
  extra: { psBody?: string; stallAfterMs?: number } = {},
) {
  const ollama = await fakeOllama(onChat, extra.psBody);
  const proxy = createProxy({ upstream: ollama.url, port: 0 });
  const { port } = await proxy.listen();
  cleanups.push(() => proxy.close());
  const control = createControlServer({
    proxy,
    upstream: ollama.url,
    socketPath,
    probeTimeoutMs: 500,
    ...(extra.stallAfterMs === undefined ? {} : { stallAfterMs: extra.stallAfterMs }),
  });
  await control.listen();
  cleanups.push(() => control.close());
  return { ollama, proxy, port, socketPath, client: createControlClient(socketPath) };
}

const hang: http.RequestListener = (_req, res) => {
  res.writeHead(200);
  res.write('partial');
};

async function startHangingRequest(port: number): Promise<http.ClientRequest> {
  const req = http.get({ port, path: '/api/chat' });
  req.on('error', () => {});
  const [res] = (await once(req, 'response')) as [http.IncomingMessage];
  res.on('error', () => {});
  await once(res, 'data');
  return req;
}

/** A socket file nobody listens on, the way a crash leaves it. */
async function orphanSocket(socketPath: string): Promise<void> {
  const orphan = net.createServer();
  orphan.listen(socketPath);
  await once(orphan, 'listening');
  // Closing a listener removes its file, so a hard link keeps it in place.
  const copy = `${socketPath}.keep`;
  execFileSync('ln', [socketPath, copy]);
  orphan.close();
  await once(orphan, 'close');
  execFileSync('mv', [copy, socketPath]);
}

async function brokenControl(): Promise<string> {
  const socketPath = join(tempDirectory(), 'control.sock');
  const proxy = {
    requests: () => {
      throw new Error('boom');
    },
  } as unknown as BeaconProxy;
  const ollama = await fakeOllama();
  const control = createControlServer({ proxy, upstream: ollama.url, socketPath });
  await control.listen();
  cleanups.push(() => control.close());
  return socketPath;
}

function rawCall(socketPath: string, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path }, (res) => {
      let body = '';
      res.on('data', (part) => {
        body += String(part);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('control channel', () => {
  it('reports an idle server', async () => {
    const { client } = await stack();
    const status = await client.status();
    assert.equal(status.server, 'idle');
    assert.equal(status.probe.reachable, true);
  });

  it('reports a server that went down', async () => {
    const { client, ollama } = await stack();
    await ollama.stop();
    const status = await client.status();
    assert.equal(status.server, 'down');
    assert.equal(status.probe.reachable, false);
  });

  it('shows requests with their derived state', async () => {
    const { client, port } = await stack(hang);
    await startHangingRequest(port);

    const [view] = await client.requests();

    assert.equal(view?.state, 'generating');
    assert.equal((await client.status()).server, 'busy');
  });

  it('cancels a request on both sides', async () => {
    let upstreamClosed = false;
    const { client, port } = await stack((req, res) => {
      res.on('close', () => {
        upstreamClosed = true;
      });
      hang(req, res);
    });
    const running = await startHangingRequest(port);
    const closedForClient = once(running, 'close');
    const [view] = await client.requests();

    assert.equal(await client.cancel(view?.id ?? ''), true);

    await closedForClient;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(upstreamClosed, true);
    const [after] = await client.requests();
    assert.equal(after?.state, 'cancelled');
    assert.equal(after?.outcome, 'cancelled');
  });

  it('cancels a request still waiting for its first byte', async () => {
    let upstreamClosed = false;
    const { client, port } = await stack((_req, res) => {
      res.on('close', () => {
        upstreamClosed = true;
      });
    });
    const running = http.get({ port, path: '/api/chat' });
    const clientError = new Promise<string>((resolve) => {
      running.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'UNKNOWN'));
    });
    let view = (await client.requests())[0];
    for (let i = 0; view === undefined && i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      view = (await client.requests())[0];
    }
    assert.equal(view?.state, 'waiting');

    assert.equal(await client.cancel(view?.id ?? ''), true);

    assert.equal(await clientError, 'ECONNRESET');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(upstreamClosed, true);
  });

  it('uses the probe timeout it was given', async () => {
    const socketPath = join(tempDirectory(), 'control.sock');
    const hanging = http.createServer(() => {});
    hanging.listen(0, '127.0.0.1');
    await once(hanging, 'listening');
    cleanups.push(async () => {
      hanging.closeAllConnections();
      await new Promise((resolve) => hanging.close(resolve));
    });
    const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    const proxy = createProxy({ upstream: url, port: 0 });
    const control = createControlServer({ proxy, upstream: url, socketPath, probeTimeoutMs: 50 });
    await control.listen();
    cleanups.push(() => control.close());

    const started = Date.now();
    const status = await createControlClient(socketPath).status();

    assert.equal(status.server, 'down');
    assert.ok(Date.now() - started < 1000);
  });

  it('uses the stall threshold it was given', async () => {
    const { client, port } = await stack(hang, undefined, { stallAfterMs: 5 });
    await startHangingRequest(port);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await client.requests())[0]?.state, 'stalled');
  });

  it('reads truncation with the data of the loaded model', async () => {
    const psBody = JSON.stringify({ models: [{ name: 'm', runner: 'llamacpp', context_length: 2048 }] });
    const { client, port } = await stack(
      async (req, res) => {
        for await (const _ of req);
        res.end('{"done":true,"prompt_eval_count":1026}\n');
      },
      undefined,
      { psBody },
    );
    await new Promise<void>((resolve) => {
      const req = http.request({ port, path: '/api/chat', method: 'POST' }, (res) => res.resume().on('end', resolve));
      req.end(JSON.stringify({ model: 'm', prompt: 'x'.repeat(4000) }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual((await client.requests())[0]?.truncation, { verdict: 'likely', reason: 'signature' });
  });

  it('asks the server again once the cached probe expires', async () => {
    const { client, ollama } = await stack();
    await client.status();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await client.status();
    assert.equal(ollama.probes(), 2);
  });

  it('answers 500 instead of hanging when a route fails', async () => {
    const socketPath = await brokenControl();
    const { status, body } = await rawCall(socketPath, 'GET', '/requests');
    assert.equal(status, 500);
    assert.match(body, /boom/);
  });

  it('surfaces a failing control channel in the client', async () => {
    const client = createControlClient(await brokenControl());
    await assert.rejects(client.requests(), /answered 500/);
  });

  it('treats an orphan socket as a proxy that is not running', async () => {
    const socketPath = join(tempDirectory(), 'control.sock');
    await orphanSocket(socketPath);
    await assert.rejects(createControlClient(socketPath).status(), ProxyNotRunning);
  });

  it('treats a proxy that goes away while answering as not running', async () => {
    const socketPath = join(tempDirectory(), 'control.sock');
    const dying = net.createServer((connection) => connection.destroy());
    dying.listen(socketPath);
    await once(dying, 'listening');
    cleanups.push(() => new Promise((resolve) => dying.close(() => resolve())));
    await assert.rejects(createControlClient(socketPath).status(), ProxyNotRunning);
  });

  it('accepts any id without breaking the request', async () => {
    const { client } = await stack();
    assert.equal(await client.cancel('a b/c?'), false);
  });

  it('refuses to cancel what is finished or unknown', async () => {
    const { client, port, socketPath } = await stack((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      http.get({ port, path: '/api/chat' }, (res) => res.resume().on('end', resolve));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [view] = await client.requests();

    assert.equal(await client.cancel(view?.id ?? ''), false);
    assert.equal(await client.cancel('nope'), false);
    assert.equal((await rawCall(socketPath, 'POST', `/requests/${view?.id}/cancel`)).status, 409);
    assert.equal((await rawCall(socketPath, 'POST', '/requests/nope/cancel')).status, 404);
  });

  it('answers the right errors for wrong routes and methods', async () => {
    const { socketPath } = await stack();
    assert.equal((await rawCall(socketPath, 'GET', '/nope')).status, 404);
    assert.equal((await rawCall(socketPath, 'POST', '/status')).status, 405);
    assert.equal((await rawCall(socketPath, 'POST', '/requests')).status, 405);
    assert.equal((await rawCall(socketPath, 'GET', '/requests/abc/cancel')).status, 405);
  });

  it('never exposes prompt content', async () => {
    const { client, port } = await stack(async (req, res) => {
      for await (const _ of req);
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      const req = http.request({ port, path: '/api/chat', method: 'POST' }, (res) => res.resume().on('end', resolve));
      req.end(JSON.stringify({ model: 'm', prompt: 'prompt-secret' }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.doesNotMatch(JSON.stringify(await client.requests()), /prompt-secret/);
  });

  it('shares one probe between calls made close together', async () => {
    const { client, ollama } = await stack();
    await Promise.all([client.status(), client.requests(), client.status()]);
    await client.requests();
    assert.equal(ollama.probes(), 1);
  });

  it('can be read with curl', async () => {
    const { socketPath } = await stack();
    // Asynchronous: a blocking call would freeze the server under test, which runs in this process.
    const output = await new Promise<string>((resolve, reject) => {
      execFile('curl', ['-s', '--unix-socket', socketPath, 'http://beacon/status'], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
    assert.equal((JSON.parse(output) as { server: string }).server, 'idle');
  });

  it('keeps the socket private to the user', async () => {
    const { socketPath } = await stack();
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  });

  it('removes the socket on close', async () => {
    const directory = tempDirectory();
    const socketPath = join(directory, 'control.sock');
    const ollama = await fakeOllama();
    const proxy = createProxy({ upstream: ollama.url, port: 0 });
    const control = createControlServer({ proxy, upstream: ollama.url, socketPath });
    await control.listen();
    await control.close();
    assert.equal(existsSync(socketPath), false);
  });

  it('refuses to start when another instance is running', async () => {
    const { socketPath, ollama, proxy } = await stack();
    const second = createControlServer({ proxy, upstream: ollama.url, socketPath });
    await assert.rejects(second.listen(), /already running/);
    assert.equal((await rawCall(socketPath, 'GET', '/status')).status, 200);
  });

  it('replaces a stale socket left by a crash', async () => {
    const socketPath = join(tempDirectory(), 'control.sock');
    await orphanSocket(socketPath);

    const { client } = await stack(undefined, socketPath);
    assert.equal((await client.status()).server, 'idle');
  });

  it('never deletes a file that is not a socket', async () => {
    const socketPath = join(tempDirectory(), 'control.sock');
    writeFileSync(socketPath, 'precious');
    const ollama = await fakeOllama();
    const proxy = createProxy({ upstream: ollama.url, port: 0 });
    const control = createControlServer({ proxy, upstream: ollama.url, socketPath });

    await assert.rejects(control.listen(), /not a socket/);
    assert.equal(readFileSync(socketPath, 'utf8'), 'precious');
  });

  it('refuses a directory open to other users', async () => {
    const directory = tempDirectory();
    chmodSync(directory, 0o755);
    const ollama = await fakeOllama();
    const proxy = createProxy({ upstream: ollama.url, port: 0 });
    const control = createControlServer({ proxy, upstream: ollama.url, socketPath: join(directory, 'control.sock') });

    await assert.rejects(control.listen(), /open to other users/);
  });

  it('creates a missing directory for the owner only', async () => {
    const directory = join(tempDirectory(), 'nested');
    const socketPath = join(directory, 'control.sock');
    const { client } = await stack(undefined, socketPath);
    await client.status();
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  });

  it('tells apart a proxy that is not running', async () => {
    const absent = createControlClient(join(tempDirectory(), 'control.sock'));
    await assert.rejects(absent.status(), ProxyNotRunning);
  });

  it('defaults to a socket in the home directory', () => {
    assert.match(defaultSocketPath(), /\.local-beacon\/control\.sock$/);
  });
});
