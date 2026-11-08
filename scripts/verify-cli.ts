// Manual check of the real CLI and MCP server against a real ollama. Not part of `npm test`.
// Usage: OLLAMA_URL=http://<host>:11434 node scripts/verify-cli.ts
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const UPSTREAM = process.env.OLLAMA_URL;
if (!UPSTREAM) {
  console.error('Set OLLAMA_URL, for example http://192.168.1.10:11434');
  process.exit(2);
}

const MAIN = new URL('../src/cli/main.ts', import.meta.url).pathname;
const MODEL = process.env.MLX_MODEL ?? 'qwen3.5:4b';
const directory = mkdtempSync('/tmp/lbeacon-verify-');
const env = { ...process.env, LBEACON_SOCKET: join(directory, 'control.sock'), OLLAMA_URL: UPSTREAM };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name: string, passed: boolean, detail: unknown = ''): void {
  if (!passed) failures += 1;
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name} ${detail === '' ? '' : JSON.stringify(detail)}`);
}

// --- Real proxy process
const proxy = spawn('node', [MAIN, 'proxy', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const [banner] = (await once(proxy.stdout, 'data')) as [Buffer];
const port = /127\.0\.0\.1:(\d+)/.exec(banner.toString())?.[1];
check('proxy starts and prints where to connect', port !== undefined, banner.toString().split('\n')[0]);
const BASE = `http://127.0.0.1:${port}`;

// --- Real watch process
const watch = spawn('node', [MAIN, 'watch', '--interval', '200'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let screens = '';
watch.stdout.on('data', (part) => {
  screens += String(part);
});

// --- Real MCP server over stdio
const mcp = spawn('node', [MAIN, '--mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map<number, (message: Record<string, any>) => void>();
createInterface({ input: mcp.stdout }).on('line', (line) => {
  const message = JSON.parse(line) as Record<string, any>;
  pending.get(message.id as number)?.(message);
});
let nextId = 1;
function rpc(method: string, params: object): Promise<Record<string, any>> {
  const id = nextId++;
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}
async function tool(name: string, args: object = {}): Promise<{ result: Record<string, any>; ms: number }> {
  const started = Date.now();
  const { result } = await rpc('tools/call', { name, arguments: args });
  return { result, ms: Date.now() - started };
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const { result: listed } = await rpc('tools/list', {});
const names = (listed.tools as Array<{ name: string }>).map((entry) => entry.name).sort();
check('tools exclude the long-running commands', names.join() === 'cancel,requests,status', names);
const byName = new Map((listed.tools as Array<Record<string, any>>).map((entry) => [entry.name, entry]));
check('status is read-only for the client', byName.get('status')?.annotations?.readOnlyHint === true);
check('cancel is destructive for the client', byName.get('cancel')?.annotations?.destructiveHint === true);
const statusParams = Object.keys(byName.get('status')?.inputSchema?.properties ?? {});
check('the socket stays out of the model\'s hands', !statusParams.includes('socket'), statusParams);

const idle = await tool('status');
check('status tool answers structured data', idle.result.structuredContent?.server === 'idle', { ms: idle.ms });

// --- A real generation
const abort = new AbortController();
const body = {
  model: MODEL,
  think: false,
  stream: true,
  keep_alive: '1m',
  messages: [{ role: 'user', content: 'Write a very long essay about the history of Rome.' }],
  options: { temperature: 0, seed: 42, num_predict: 1500 },
};
const generation = fetch(`${BASE}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: abort.signal })
  .then((response) => response.text())
  .then(() => 'finished', () => 'broken');
await sleep(2500);

const busy = await tool('status');
check('status tool sees it busy', busy.result.structuredContent?.server === 'busy', { ms: busy.ms });
const listing = await tool('requests', { limit: 1 });
const row = listing.result.structuredContent?.requests?.[0];
check('requests tool sees it generating', row?.state === 'generating' && row?.model === MODEL, { ms: listing.ms });
check('watch shows it live', /generating/.test(screens) && screens.includes(MODEL));

const cancelled = await tool('cancel', { id: row?.id });
check('cancel tool cuts it', cancelled.result.structuredContent?.cancelled === row?.id, { ms: cancelled.ms });
check('the client sees a broken response', (await generation) === 'broken');
await sleep(300);
const after = await tool('requests', { limit: 1 });
check('it shows as cancelled', after.result.structuredContent?.requests?.[0]?.state === 'cancelled');

const unknown = await tool('cancel', { id: 'nope' });
check('cancelling something unknown is a tool error', unknown.result.isError === true, unknown.result.content?.[0]?.text);

const started = Date.now();
await fetch(`${UPSTREAM}/api/chat`, { method: 'POST', body: JSON.stringify({ model: MODEL, keep_alive: 0, messages: [] }) });
console.log(`     (unloaded in ${Date.now() - started} ms)`);

// --- Proxy gone
proxy.kill('SIGINT');
// Since Runa 0.2.0-beta.6 a clean stop dies by the signal instead of exiting 130.
const [proxyCode, proxySignal] = (await once(proxy, 'exit')) as [number | null, NodeJS.Signals | null];
check('proxy stops on SIGINT', proxyCode === null && proxySignal === 'SIGINT', { proxyCode, proxySignal });
const gone = await tool('status');
check('status tool explains the proxy is not running', gone.result.isError === true && /not running/.test(gone.result.content?.[0]?.text), {
  text: gone.result.content?.[0]?.text,
  meta: gone.result._meta,
});
await sleep(400);
check('watch waits for the proxy to come back', /waiting for it to start/.test(screens));

watch.kill('SIGINT');
await once(watch, 'exit');
mcp.kill('SIGTERM');
await once(mcp, 'exit');
rmSync(directory, { recursive: true, force: true });

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
