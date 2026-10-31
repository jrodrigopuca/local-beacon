import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { inspectRequest, readUsage, type Usage } from './inspect.ts';

export type RequestOutcome = 'in_flight' | 'done' | 'client_disconnected' | 'cancelled' | 'upstream_error';

/** What the proxy remembers about a request. Metadata only: never the body. */
export interface RequestRecord {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  firstByteAt: number | null;
  lastByteAt: number | null;
  chunks: number;
  bytes: number;
  status: number | null;
  endedAt: number | null;
  outcome: RequestOutcome;
  errorCode: string | null;
  model: string | null;
  promptChars: number | null;
  usage: Usage | null;
}

export interface ProxyOptions {
  /** Base URL of the ollama server. Only plain http. */
  upstream: string;
  port: number;
  /** Defaults to loopback: ollama has no auth, so the proxy must not widen its exposure. */
  host?: string;
  /** Finished records kept in memory. In-flight ones are never evicted. */
  maxRecords?: number;
}

export interface BeaconProxy {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  requests(): RequestRecord[];
  /** Cuts a request in flight on both sides. False when it is not in flight. */
  cancel(id: string): boolean;
}

const DEFAULT_HOST = '127.0.0.1';
// Provisional, my own judgment: enough for a long session, small enough to ignore.
const DEFAULT_MAX_RECORDS = 1000;
// Bodies and response tails are read in passing and dropped; nothing below is stored.
// Provisional, my own judgment: base64 images can get large, and past this limit the
// request just loses its prompt facts.
const MAX_INSPECTED_BODY_BYTES = 64 * 1024 * 1024;
// Usage sits in the last line or at the end of the body, a few hundred bytes.
const RESPONSE_TAIL_CHARS = 8192;

// Per-connection headers: each side of the proxy negotiates its own connection.
// Everything else, and every body byte, passes through untouched.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function requestHeaders(headers: http.IncomingHttpHeaders, upstreamHost: string): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) forwarded[name] = value;
  }
  forwarded.host = upstreamHost;
  return forwarded;
}

function responseHeaders(rawHeaders: string[]): string[] {
  const forwarded: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
      forwarded.push(name, value);
    }
  }
  return forwarded;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
}

export function createProxy(options: ProxyOptions): BeaconProxy {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:') {
    throw new Error(`upstream must use http, got ${upstream.protocol}`);
  }
  const host = options.host ?? DEFAULT_HOST;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const records = new Map<string, RequestRecord>();
  const cancellers = new Map<string, () => void>();

  function remember(record: RequestRecord): void {
    records.set(record.id, record);
    for (const [id, candidate] of records) {
      if (records.size <= maxRecords) return;
      if (candidate.outcome !== 'in_flight') records.delete(id);
    }
  }

  function handle(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const record: RequestRecord = {
      id: randomUUID().slice(0, 8),
      method: clientReq.method ?? 'GET',
      path: clientReq.url ?? '/',
      startedAt: Date.now(),
      firstByteAt: null,
      lastByteAt: null,
      chunks: 0,
      bytes: 0,
      status: null,
      endedAt: null,
      outcome: 'in_flight',
      errorCode: null,
      model: null,
      promptChars: null,
      usage: null,
    };
    remember(record);

    let body: Buffer[] | null = [];
    let bodyBytes = 0;
    clientReq.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_INSPECTED_BODY_BYTES) body = null;
      body?.push(chunk);
    });
    clientReq.on('end', () => {
      if (body === null) return;
      const { model, promptChars } = inspectRequest(Buffer.concat(body));
      record.model = model;
      record.promptChars = promptChars;
      body = null;
    });

    // First cause wins: tearing one side down makes the other report an error too.
    const settle = (outcome: RequestOutcome, code: string | null = null): void => {
      if (record.outcome !== 'in_flight') return;
      record.outcome = outcome;
      record.errorCode = code;
      record.endedAt = Date.now();
      cancellers.delete(record.id);
    };

    const upstreamReq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: record.path,
        method: record.method,
        headers: requestHeaders(clientReq.headers, upstream.host),
        // A reused socket can be closed by the server at the moment we write to it,
        // and that would look like a server failure. One connection per request.
        agent: false,
      },
      (upstreamRes) => {
        record.status = upstreamRes.statusCode ?? null;
        clientRes.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes.rawHeaders));

        // latin1 maps bytes one to one, so a multi-byte character split across chunks
        // cannot corrupt the ASCII numbers this tail is kept for.
        let tail = '';
        upstreamRes.on('data', (chunk: Buffer) => {
          const now = Date.now();
          record.firstByteAt ??= now;
          record.lastByteAt = now;
          record.chunks += 1;
          record.bytes += chunk.length;
          tail = (tail + chunk.toString('latin1')).slice(-RESPONSE_TAIL_CHARS);
        });
        upstreamRes.on('end', () => {
          record.usage = readUsage(tail);
          tail = '';
        });

        upstreamRes.on('error', (error) => {
          settle('upstream_error', errorCode(error));
          // Destroy, not end: the client must see a broken response, not a short valid one.
          clientRes.destroy();
        });

        upstreamRes.pipe(clientRes);
      },
    );

    cancellers.set(record.id, () => {
      settle('cancelled');
      // Its 'close' handler below tears down the upstream side.
      clientRes.destroy();
    });

    upstreamReq.on('error', (error) => {
      if (record.outcome !== 'in_flight') return;
      const code = errorCode(error);
      settle('upstream_error', code);
      if (clientRes.headersSent) {
        clientRes.destroy();
        return;
      }
      // Same body shape as ollama's own errors, so clients already know how to read it.
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: `local-beacon: upstream unreachable (${code})` }));
    });

    clientRes.on('finish', () => settle('done'));
    clientRes.on('close', () => {
      if (clientRes.writableFinished) return;
      settle('client_disconnected');
      // Closing the connection is what makes ollama stop generating (spike, test 3).
      upstreamReq.destroy();
    });

    clientReq.pipe(upstreamReq);
  }

  const server = http.createServer(handle);

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, host, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo;
          resolve({ host: address.address, port: address.port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
    requests: () => [...records.values()].map((record) => ({ ...record })),
    cancel: (id) => {
      const cancelRequest = cancellers.get(id);
      cancelRequest?.();
      return cancelRequest !== undefined;
    },
  };
}
