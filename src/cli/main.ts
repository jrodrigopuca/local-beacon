#!/usr/bin/env node
import { CommandError, defineCLI, defineCommand } from '@runa-cmd/core';
import { z } from '@runa-cmd/core/zod';
import { helpPlugin } from '@runa-cmd/help';
import { mcpPlugin } from '@runa-cmd/mcp';

import { createControlClient, ProxyNotRunning } from '../core/control-client.ts';
import { createControlServer, defaultSocketPath } from '../core/control.ts';
import { createProxy } from '../core/proxy.ts';
import { formatRequests, formatStatus, type RequestRow, toRow } from './format.ts';

const EXIT_NOT_RUNNING = 3;
const EXIT_NOT_IN_FLIGHT = 4;
// Provisional, my own judgment: long enough to scan, short enough to fit an agent's context.
const DEFAULT_LIMIT = 20;

const socketOption = {
  socket: z.string().default(defaultSocketPath()).describe('Control socket of the proxy'),
};
const socketMeta = { socket: { env: 'LBEACON_SOCKET' } };
const jsonOption = { json: z.boolean().default(false).describe('Print JSON instead of text') };

const statusOutput = z.object({
  server: z.enum(['down', 'idle', 'busy']),
  probe: z.discriminatedUnion('reachable', [
    z.object({
      reachable: z.literal(true),
      version: z.string(),
      models: z.array(
        z.object({
          name: z.string(),
          runner: z.string().nullable(),
          contextLength: z.number().nullable(),
          sizeVram: z.number().nullable(),
          expiresAt: z.string().nullable(),
        }),
      ),
    }),
    z.object({
      reachable: z.literal(false),
      reason: z.enum(['refused', 'timeout', 'unreachable', 'bad_response']),
      detail: z.string(),
    }),
  ]),
});

const requestsOutput = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      model: z.string().nullable(),
      path: z.string(),
      ageMs: z.number(),
      silentForMs: z.number().nullable(),
      ahead: z.number(),
      promptTokens: z.number().nullable(),
      cachedTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      tokensPerSecond: z.number().nullable(),
      truncation: z.string(),
      truncationReason: z.string().nullable(),
      errorCode: z.string().nullable(),
    }),
  ),
});

/** A proxy that is not running is an expected answer, not a crash. */
async function fromProxy<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProxyNotRunning) {
      throw new CommandError(`${error.message}. Start it with: lbeacon proxy`, {
        code: 'NOT_RUNNING',
        exitCode: EXIT_NOT_RUNNING,
      });
    }
    throw error;
  }
}

async function readRows(socket: string, limit: number): Promise<RequestRow[]> {
  const now = Date.now();
  const views = await createControlClient(socket).requests();
  return views.slice(-limit).map((view) => toRow(view, now));
}

function print(value: unknown, json: boolean, text: () => string): void {
  console.log(json ? JSON.stringify(value) : text());
}

const proxy = defineCommand({
  meta: {
    name: 'proxy',
    description: 'Run the proxy in front of an ollama server',
    options: { ...socketMeta, upstream: { env: 'OLLAMA_URL', alias: ['-u'] } },
  },
  options: {
    ...socketOption,
    upstream: z.url().describe('URL of the ollama server'),
    port: z.number().default(11500).describe('Port for clients to connect to'),
  },
  async run({ options, signal }) {
    const closers: Array<() => Promise<void>> = [];
    try {
      const beacon = createProxy({ upstream: options.upstream, port: options.port });
      const control = createControlServer({ proxy: beacon, upstream: options.upstream, socketPath: options.socket });
      closers.push(() => control.close(), () => beacon.close());
      await control.listen();
      const { host, port } = await beacon.listen();
      console.log(`proxy on http://${host}:${port} -> ${options.upstream}`);
      console.log(`point clients to it: OLLAMA_URL=http://${host}:${port}`);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error), { code: 'PROXY_FAILED' });
    } finally {
      await Promise.allSettled(closers.map((close) => close()));
    }
  },
});

const status = defineCommand({
  meta: { name: 'status', description: 'Show whether the server is up, and what is loaded', options: socketMeta },
  options: { ...socketOption, ...jsonOption },
  output: statusOutput,
  async run({ options }) {
    const snapshot = await fromProxy(() => createControlClient(options.socket).status());
    print(snapshot, options.json, () => formatStatus(snapshot));
    return snapshot;
  },
});

const requests = defineCommand({
  meta: { name: 'requests', description: 'List recent requests and their state', options: socketMeta },
  options: {
    ...socketOption,
    ...jsonOption,
    limit: z.number().default(DEFAULT_LIMIT).describe('Most recent requests to show'),
  },
  output: requestsOutput,
  async run({ options }) {
    const rows = await fromProxy(() => readRows(options.socket, options.limit));
    print(rows, options.json, () => formatRequests(rows));
    return { requests: rows };
  },
});

const cancel = defineCommand({
  meta: { name: 'cancel', description: 'Cut a request in flight', options: socketMeta },
  args: { id: z.string().describe('Request id, from `requests`') },
  options: socketOption,
  output: z.object({ cancelled: z.string() }),
  async run({ args, options }) {
    const cancelled = await fromProxy(() => createControlClient(options.socket).cancel(args.id));
    if (!cancelled) {
      throw new CommandError(`request ${args.id} is not in flight`, {
        code: 'NOT_IN_FLIGHT',
        exitCode: EXIT_NOT_IN_FLIGHT,
      });
    }
    console.log(`cancelled ${args.id}`);
    return { cancelled: args.id };
  },
});

const CLEAR_SCREEN = '\x1b[H\x1b[2J';

const watch = defineCommand({
  meta: { name: 'watch', description: 'Follow the server and its requests live', options: socketMeta },
  options: {
    ...socketOption,
    interval: z.number().default(1000).describe('Milliseconds between updates'),
    limit: z.number().default(DEFAULT_LIMIT).describe('Most recent requests to show'),
  },
  async run({ options, signal }) {
    const client = createControlClient(options.socket);
    const separator = process.stdout.isTTY ? CLEAR_SCREEN : '\n';
    while (!signal.aborted) {
      let screen: string;
      try {
        const [snapshot, rows] = await Promise.all([client.status(), readRows(options.socket, options.limit)]);
        screen = `${formatStatus(snapshot)}\n\n${formatRequests(rows)}`;
      } catch (error) {
        if (!(error instanceof ProxyNotRunning)) throw error;
        screen = `${error.message}\nwaiting for it to start...`;
      }
      process.stdout.write(`${separator}${screen}\n`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.interval);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  },
});

const cli = defineCLI({
  meta: {
    name: 'local-beacon',
    version: '0.0.0',
    description: 'See what a remote ollama is doing, and talk to it from outside',
  },
  commands: { proxy, status, requests, watch, cancel },
  plugins: [
    helpPlugin(),
    mcpPlugin({
      // A tool call is a short-lived child process: these two never return.
      exclude: ['proxy', 'watch'],
      instructions: 'These tools need the proxy running. Call `status` first; prefer it over guessing why a model is slow.',
      tools: {
        status: { annotations: { readOnlyHint: true } },
        requests: { annotations: { readOnlyHint: true } },
        cancel: {
          description: 'Cut a request in flight. What it generated so far is lost.',
          annotations: { destructiveHint: true },
        },
      },
    }),
  ],
});

cli.run();
