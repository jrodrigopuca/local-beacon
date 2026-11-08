import { CommandError, defineCLI, defineCommand } from '@runa-cmd/core';
import { z } from '@runa-cmd/core/zod';
import { helpPlugin } from '@runa-cmd/help';
import { mcpPlugin } from '@runa-cmd/mcp';

import { createControlClient, ProxyNotRunning } from '../core/control-client.ts';
import { createControlServer, defaultSocketPath } from '../core/control.ts';
import { createProxy } from '../core/proxy.ts';
import { isWork } from '../core/state.ts';
import { formatRequests, formatStatus, type RequestRow, toRow } from './format.ts';

const EXIT_NOT_RUNNING = 3;
const EXIT_NOT_IN_FLIGHT = 4;
// Provisional, my own judgment: long enough to scan, short enough to fit an agent's context.
const DEFAULT_LIMIT = 20;

const socketOption = {
  socket: z.string().default(defaultSocketPath()).describe('Control socket of the proxy'),
};
const socketMeta = { socket: { env: 'LBEACON_SOCKET', defaultDescription: '~/.local-beacon/control.sock' } };

const statusOutput = z.object({
  server: z.enum(['down', 'idle', 'busy', 'unknown']),
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
      // Said for models too: without the last sentence, they read this as "ollama is broken".
      throw new CommandError(`${error.message}. Start it with: lbeacon proxy. This says nothing about the ollama server, which may be fine.`, {
        code: 'NOT_RUNNING',
        exitCode: EXIT_NOT_RUNNING,
      });
    }
    throw error;
  }
}

async function readRows(socket: string, limit: number, all: boolean): Promise<RequestRow[]> {
  const now = Date.now();
  const views = await createControlClient(socket).requests();
  // Clients poll /api/version or /api/tags around every run: noise when asking what is slow.
  return views.filter((view) => all || isWork(view)).slice(-limit).map((view) => toRow(view, now));
}

const allOption = {
  all: z.boolean().default(false).describe('Include cheap reads such as /api/version and /api/tags'),
};

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
      // No variable name here: OLLAMA_URL is this command's upstream, so suggesting it
      // for clients invites a shell where the next proxy forwards to itself.
      console.log(`point clients to http://${host}:${port}`);
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
  options: socketOption,
  output: statusOutput,
  run: ({ options }) => fromProxy(() => createControlClient(options.socket).status()),
  format: formatStatus,
});

const requests = defineCommand({
  meta: { name: 'requests', description: 'List recent requests and their state', options: socketMeta },
  options: {
    ...socketOption,
    limit: z.number().default(DEFAULT_LIMIT).describe('Most recent requests to show'),
    ...allOption,
  },
  output: requestsOutput,
  async run({ options }) {
    return { requests: await fromProxy(() => readRows(options.socket, options.limit, options.all)) };
  },
  format: (result) => formatRequests(result.requests),
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
    return { cancelled: args.id };
  },
  format: (result) => `cancelled ${result.cancelled}`,
});

const CLEAR_SCREEN = '\x1b[H\x1b[2J';

const watch = defineCommand({
  meta: { name: 'watch', description: 'Follow the server and its requests live', options: socketMeta },
  options: {
    ...socketOption,
    interval: z.number().default(1000).describe('Milliseconds between updates'),
    limit: z.number().default(DEFAULT_LIMIT).describe('Most recent requests to show'),
    ...allOption,
  },
  async run({ options, signal }) {
    const client = createControlClient(options.socket);
    const live = process.stdout.isTTY === true;
    let lastChange: string | null = null;
    while (!signal.aborted) {
      let screen: string;
      // What counts as a change for a log: ages and token counts move every tick.
      let change: string;
      try {
        const [snapshot, rows] = await Promise.all([client.status(), readRows(options.socket, options.limit, options.all)]);
        screen = `${formatStatus(snapshot)}\n\n${formatRequests(rows)}`;
        const models = snapshot.probe.reachable ? snapshot.probe.models.map((model) => model.name) : [];
        change = JSON.stringify([snapshot.server, models, rows.map((row) => [row.id, row.state])]);
      } catch (error) {
        if (!(error instanceof ProxyNotRunning)) throw error;
        screen = `${error.message}\nwaiting for it to start...`;
        change = screen;
      }
      if (live) {
        process.stdout.write(`${CLEAR_SCREEN}${screen}\n`);
      } else if (change !== lastChange) {
        // Piped or redirected: one frame per change, stamped, instead of one per tick.
        process.stdout.write(`\n--- ${new Date().toISOString()}\n${screen}\n`);
      }
      lastChange = change;
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

export const cli = defineCLI({
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
