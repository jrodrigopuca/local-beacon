import { lstat, mkdir, chmod, unlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { probe, type ProbeResult } from './ollama.ts';
import type { BeaconProxy } from './proxy.ts';
import { health, type RequestView, type ServerState, serverState, viewRequests } from './state.ts';

export interface StatusSnapshot {
  server: ServerState;
  probe: ProbeResult;
}

export interface ControlOptions {
  proxy: BeaconProxy;
  upstream: string;
  socketPath?: string;
  stallAfterMs?: number;
  probeTimeoutMs?: number;
}

export interface ControlServer {
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function defaultSocketPath(): string {
  return join(homedir(), '.local-beacon', 'control.sock');
}

// Provisional, my own judgment: `watch` asks about once a second and reads two routes,
// which should not become two probes each time.
const PROBE_TTL_MS = 1_000;

class Refused extends Error {}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The directory is what keeps other users out, including before the socket gets its mode. */
async function prepareDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Refused(`${path} is not a directory`);
  if (info.uid !== process.getuid?.()) throw new Refused(`${path} belongs to another user`);
  if ((info.mode & 0o077) !== 0) throw new Refused(`${path} is open to other users; use chmod 700`);
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!(await exists(socketPath))) return;
  if (!(await lstat(socketPath)).isSocket()) {
    throw new Refused(`${socketPath} exists and is not a socket`);
  }
  if (await answers(socketPath)) throw new Refused(`local-beacon is already running on ${socketPath}`);
  await unlink(socketPath);
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createControlServer(options: ControlOptions): ControlServer {
  const { proxy, upstream } = options;
  const socketPath = options.socketPath ?? defaultSocketPath();
  let recentProbe: { at: number; result: Promise<ProbeResult> } | null = null;

  function currentProbe(): Promise<ProbeResult> {
    const now = Date.now();
    if (recentProbe && now - recentProbe.at < PROBE_TTL_MS) return recentProbe.result;
    const probeOptions = options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs };
    recentProbe = { at: now, result: probe(upstream, probeOptions) };
    return recentProbe.result;
  }

  async function views(): Promise<{ requests: RequestView[]; result: ProbeResult }> {
    const result = await currentProbe();
    const requests = viewRequests(proxy.requests(), Date.now(), {
      ...(options.stallAfterMs === undefined ? {} : { stallAfterMs: options.stallAfterMs }),
      ...(result.reachable ? { models: result.models } : {}),
    });
    return { requests, result };
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url ?? '/';

    if (path === '/status' || path === '/requests') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'use GET' });
      const { requests, result } = await views();
      if (path === '/requests') return reply(res, 200, { requests });
      const snapshot: StatusSnapshot = { server: serverState(health(result), requests), probe: result };
      return reply(res, 200, snapshot);
    }

    const id = /^\/requests\/([^/]+)\/cancel$/.exec(path)?.[1];
    if (id === undefined) return reply(res, 404, { error: 'unknown route' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'use POST' });
    if (proxy.cancel(id)) return reply(res, 200, { cancelled: true });
    const known = proxy.requests().some((record) => record.id === id);
    return reply(res, known ? 409 : 404, { error: known ? 'request already finished' : 'unknown request' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error: unknown) => reply(res, 500, { error: String(error) }));
  });

  return {
    async listen() {
      await prepareDirectory(dirname(socketPath));
      await clearStaleSocket(socketPath);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
      return socketPath;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
