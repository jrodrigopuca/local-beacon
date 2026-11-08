import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

// The CLI is exercised as the real process people run.
const MAIN = new URL('./main.ts', import.meta.url).pathname;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function lbeacon(args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile('node', [MAIN, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? null) : 0;
      resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

function socketPath(): string {
  const directory = mkdtempSync('/tmp/lbeacon-cli-');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'control.sock');
}

async function fakeOllama(): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') return void res.end('{"version":"0.40.13"}');
    if (req.url === '/api/ps') return void res.end('{"models":[]}');
    res.writeHead(200);
    res.write('partial');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startProxy(socket: string): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const upstream = await fakeOllama();
  const port = await freePort();
  const child = spawn('node', [MAIN, 'proxy', '--port', String(port)], {
    env: { ...process.env, OLLAMA_URL: upstream, LBEACON_SOCKET: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr?.on('data', (part) => {
    stderr += String(part);
  });
  const [started] = (await once(child.stdout as NodeJS.ReadableStream, 'data')) as [Buffer];
  assert.match(started.toString(), /proxy on http:\/\/127\.0\.0\.1/);
  return { child, port, stderr: () => stderr };
}

describe('lbeacon', () => {
  it('shows help and version', async () => {
    const help = await lbeacon(['--help']);
    assert.equal(help.code, 0);
    for (const command of ['proxy', 'status', 'requests', 'watch', 'cancel']) {
      assert.match(help.stdout, new RegExp(command));
    }
    assert.equal((await lbeacon(['--version'])).stdout.trim(), '0.0.0');
  });

  it('explains that the proxy is not running, with exit code 3', async () => {
    const socket = socketPath();
    for (const command of [['status'], ['requests'], ['cancel', 'abc']]) {
      const result = await lbeacon(command, { LBEACON_SOCKET: socket });
      assert.equal(result.code, 3, command.join(' '));
      assert.match(result.stderr, /not running.*lbeacon proxy/);
    }
  });

  it('requires an upstream to run the proxy', async () => {
    const result = await lbeacon(['proxy', '--socket', socketPath()], { OLLAMA_URL: '' });
    assert.equal(result.code, 2);
  });

  it('rejects an invalid upstream as a usage error', async () => {
    const result = await lbeacon(['proxy', '-u', 'not a url', '--socket', socketPath()]);
    assert.equal(result.code, 2);
  });

  it('explains that the upstream must be plain http', async () => {
    const result = await lbeacon(['proxy', '-u', 'https://example.com', '--socket', socketPath()]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must use http/);
    assert.doesNotMatch(result.stderr, /Unexpected error/);
  });

  it('runs a whole session: status, a request, its listing and a cancel', async () => {
    const socket = socketPath();
    const { port } = await startProxy(socket);
    const env = { LBEACON_SOCKET: socket };

    const idle = await lbeacon(['status'], env);
    assert.equal(idle.code, 0);
    assert.match(idle.stdout, /server\s+idle/);
    assert.match(idle.stdout, /ollama\s+0\.40\.13/);
    assert.match((await lbeacon(['requests'], env)).stdout, /no requests yet/);

    const running = http.request({ port, path: '/api/chat', method: 'POST' });
    running.on('error', () => {});
    const closed = new Promise((resolve) => running.on('close', resolve));
    running.end(JSON.stringify({ model: 'qwen3.5:4b', prompt: 'prompt-secret' }));
    await once(running, 'response');

    const listed = await lbeacon(['requests', '--json'], env);
    const { requests: [row] } = JSON.parse(listed.stdout) as {
      requests: Array<{ id: string; state: string; model: string }>;
    };
    assert.equal(row?.state, 'generating');
    assert.equal(row?.model, 'qwen3.5:4b');
    assert.doesNotMatch(listed.stdout, /prompt-secret/);
    assert.match((await lbeacon(['requests'], env)).stdout, /generating/);
    assert.equal(JSON.parse((await lbeacon(['status', '--json'], env)).stdout).server, 'busy');

    const cancelled = await lbeacon(['cancel', row?.id ?? ''], env);
    assert.equal(cancelled.code, 0);
    assert.match(cancelled.stdout, /cancelled/);
    await closed;

    const again = await lbeacon(['cancel', row?.id ?? ''], env);
    assert.equal(again.code, 4);
    assert.match(again.stderr, /not in flight/);
  });

  it('limits how many requests it lists', async () => {
    const socket = socketPath();
    const { port } = await startProxy(socket);
    for (const path of ['/a', '/b', '/c']) {
      await new Promise<void>((resolve) => {
        const req = http.get({ port, path }, () => resolve());
        req.on('error', () => {});
      });
    }
    const result = await lbeacon(['requests', '--json', '--limit', '2'], { LBEACON_SOCKET: socket });
    const { requests } = JSON.parse(result.stdout) as { requests: Array<{ path: string }> };
    assert.deepEqual(requests.map((row) => row.path), ['/b', '/c']);
  });

  it('stops the proxy cleanly on SIGINT and removes its socket', async () => {
    const socket = socketPath();
    const { child, stderr } = await startProxy(socket);
    assert.equal(existsSync(socket), true);

    child.kill('SIGINT');
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

    // Since Runa 0.2.0-beta.6 a clean stop dies by the signal (a shell still sees 130),
    // so supervisors such as systemd count it as clean.
    assert.equal(code, null);
    assert.equal(signal, 'SIGINT');
    assert.doesNotMatch(stderr(), /Interrupted/);
    assert.equal(existsSync(socket), false);
  });

  it('refuses a second proxy on the same socket', async () => {
    const socket = socketPath();
    await startProxy(socket);
    const result = await lbeacon(['proxy', '-u', 'http://127.0.0.1:1', '--port', '0', '--socket', socket]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already running/);
  });

  it('reports a port already in use and leaves no socket behind', async () => {
    const socket = socketPath();
    const busy = http.createServer();
    busy.listen(0, '127.0.0.1');
    await once(busy, 'listening');
    cleanups.push(() => new Promise((resolve) => busy.close(() => resolve())));
    const { port } = busy.address() as AddressInfo;

    const result = await lbeacon(['proxy', '-u', 'http://127.0.0.1:1', '--port', String(port), '--socket', socket]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /EADDRINUSE/);
    assert.equal(existsSync(socket), false);
  });

  it('watch keeps following until interrupted, and survives a missing proxy', async () => {
    const socket = socketPath();
    const child = spawn('node', [MAIN, 'watch', '--interval', '50'], {
      env: { ...process.env, LBEACON_SOCKET: socket },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cleanups.push(() => {
      child.kill('SIGKILL');
    });
    let output = '';
    child.stdout.on('data', (part) => {
      output += String(part);
    });
    for (let i = 0; i < 200 && !output.includes('waiting for it to start'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(output, /waiting for it to start/);

    await startProxy(socket);
    for (let i = 0; i < 300 && !/server\s+idle/.test(output); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(output, /server\s+idle/);

    const interrupted = Date.now();
    child.kill('SIGINT');
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    assert.equal(code, null);
    assert.equal(signal, 'SIGINT');
    // Runa stops waiting after 2 s; a watch that follows the signal leaves well before that.
    assert.ok(Date.now() - interrupted < 1500);
  });
});
