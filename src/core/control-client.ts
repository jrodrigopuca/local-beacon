import http from 'node:http';

import { defaultSocketPath, type StatusSnapshot } from './control.ts';
import type { RequestView } from './state.ts';

export interface ControlClient {
  status(): Promise<StatusSnapshot>;
  requests(): Promise<RequestView[]>;
  /** True when it was cut. False when it already finished or does not exist. */
  cancel(id: string): Promise<boolean>;
}

/** The proxy is not running, as opposed to the proxy answering with an error. */
export class ProxyNotRunning extends Error {
  constructor(socketPath: string) {
    super(`local-beacon is not running (no proxy on ${socketPath})`);
  }
}

interface Answer {
  status: number;
  body: unknown;
}

export function createControlClient(socketPath: string = defaultSocketPath()): ControlClient {
  function call(method: string, path: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        const absent = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
        reject(absent ? new ProxyNotRunning(socketPath) : error);
      });
      req.end();
    });
  }

  function expectOk(answer: Answer): unknown {
    if (answer.status !== 200) throw new Error(`control channel answered ${answer.status}`);
    return answer.body;
  }

  return {
    status: async () => expectOk(await call('GET', '/status')) as StatusSnapshot,
    requests: async () => (expectOk(await call('GET', '/requests')) as { requests: RequestView[] }).requests,
    cancel: async (id) => {
      const answer = await call('POST', `/requests/${encodeURIComponent(id)}/cancel`);
      if (answer.status === 404 || answer.status === 409) return false;
      expectOk(answer);
      return true;
    },
  };
}
