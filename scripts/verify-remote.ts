// Manual check of the core against a real ollama. Not part of `npm test`.
// Usage: OLLAMA_URL=http://<host>:11434 node scripts/verify-remote.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createControlClient } from '../src/core/control-client.ts';
import { createControlServer } from '../src/core/control.ts';
import { type LoadedModel, probe } from '../src/core/ollama.ts';
import { createProxy, type RequestRecord } from '../src/core/proxy.ts';
import { health, serverState, type RequestView, viewRequests } from '../src/core/state.ts';

const UPSTREAM = process.env.OLLAMA_URL;
if (!UPSTREAM) {
  console.error('Set OLLAMA_URL, for example http://192.168.1.10:11434');
  process.exit(2);
}

const MLX = process.env.MLX_MODEL ?? 'qwen3.5:4b';
const LLAMACPP = process.env.LLAMACPP_MODEL ?? 'bonsai-2:9b';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name: string, passed: boolean, detail: unknown = ''): void {
  if (!passed) failures += 1;
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name} ${detail === '' ? '' : JSON.stringify(detail)}`);
}

const proxy = createProxy({ upstream: UPSTREAM, port: 0 });
const { port } = await proxy.listen();
const BASE = `http://127.0.0.1:${port}`;

async function unload(model: string): Promise<void> {
  await fetch(`${UPSTREAM}/api/chat`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0, messages: [] }) });
  for (let i = 0; i < 60; i += 1) {
    const result = await probe(UPSTREAM as string);
    if (result.reachable && !result.models.some((loaded) => loaded.name === model)) return;
    await sleep(250);
  }
}

async function models(): Promise<LoadedModel[]> {
  const result = await probe(UPSTREAM as string);
  return result.reachable ? result.models : [];
}

function chatBody(model: string, content: string, options: object, extra: object = {}) {
  return JSON.stringify({
    model,
    think: false,
    keep_alive: '2m',
    messages: [{ role: 'user', content }],
    options: { temperature: 0, seed: 42, num_predict: 1, ...options },
    ...extra,
  });
}

const post = (path: string, body: string, signal?: AbortSignal) =>
  fetch(`${BASE}${path}`, { method: 'POST', body, ...(signal ? { signal } : {}) });
const drain = (response: Response) => response.text();
const lastRecord = (): RequestRecord => proxy.requests().at(-1) as RequestRecord;
const lastView = (loaded: LoadedModel[] = []): RequestView =>
  viewRequests(proxy.requests(), Date.now(), { models: loaded }).at(-1) as RequestView;

function linesFiller(chars: number): string {
  let out = '';
  for (let i = 0; out.length < chars; i += 1) out += `Line ${i}: the warehouse stores item number ${i * 7}.\n`;
  return out.slice(0, chars);
}

function jsonFiller(chars: number): string {
  const rows = [];
  for (let i = 0; JSON.stringify(rows).length < chars; i += 1) {
    rows.push({ id: i, sku: `A${(i * 7919) % 104729}`, qty: (i * 31) % 97, tags: ['x', 'y'], ok: i % 2 === 0 });
  }
  return JSON.stringify(rows).slice(0, chars);
}

// --- Idle
await unload(MLX);
await unload(LLAMACPP);
const idle = await probe(UPSTREAM);
check('probe sees a healthy server', idle.reachable, idle.reachable ? idle.version : idle);
check('server is idle', serverState(health(idle), viewRequests(proxy.requests(), Date.now())) === 'idle');

// --- Streaming, queue hint, probe under load
{
  await drain(await post('/api/chat', chatBody(MLX, 'hi', {}, { stream: false })));
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const essay = chatBody(MLX, 'Write a very long essay about the history of Rome.', { num_predict: 600 }, { stream: true });
  const first = post('/api/chat', essay, firstAbort.signal).then(drain).catch(() => null);
  await sleep(1500);

  const started = Date.now();
  const during = await probe(UPSTREAM);
  const probeMs = Date.now() - started;
  const generating = lastView();
  check('stream is generating', generating.state === 'generating', { chunks: generating.chunks });
  check('probe answers during generation', during.reachable, { probeMs });
  check('server is busy', serverState(health(during), viewRequests(proxy.requests(), Date.now())) === 'busy');

  const second = post('/api/chat', essay, secondAbort.signal).then(drain).catch(() => null);
  await sleep(500);
  const queued = lastView();
  check('second request waits with one ahead', queued.state === 'waiting' && queued.ahead === 1, {
    state: queued.state,
    ahead: queued.ahead,
  });

  secondAbort.abort();
  firstAbort.abort();
  await Promise.all([first, second]);
  await sleep(300);
  const states = viewRequests(proxy.requests(), Date.now()).slice(-2).map((view) => view.state);
  check('disconnected clients show as cancelled', states.every((state) => state === 'cancelled'), states);
}

// --- Control channel: the same view another process would get, and a real cancel
{
  const directory = mkdtempSync('/tmp/lbeacon-verify-');
  const socketPath = join(directory, 'control.sock');
  const control = createControlServer({ proxy, upstream: UPSTREAM, socketPath });
  await control.listen();
  const client = createControlClient(socketPath);

  const essay = chatBody(MLX, 'Write a very long essay about the history of Rome.', { num_predict: 1500 }, { stream: true });
  const running = post('/api/chat', essay).then(drain).then(() => 'finished', () => 'broken');
  await sleep(1500);
  const status = await client.status();
  const view = (await client.requests()).at(-1) as RequestView;
  check('socket reports the server as busy', status.server === 'busy', { server: status.server });
  check('socket reports the request as generating', view.state === 'generating', { model: view.model });

  check('socket cancels the request', await client.cancel(view.id));
  check('the client sees a broken response', (await running) === 'broken');
  const started = Date.now();
  await drain(await post('/api/chat', chatBody(MLX, 'hi', {}, { stream: false })));
  const followUpMs = Date.now() - started;
  check('the model is free right after cancelling', followUpMs < 5000, { followUpMs });
  const cancelled = (await client.requests()).find((request) => request.id === view.id);
  check('the request shows as cancelled', cancelled?.state === 'cancelled', { outcome: cancelled?.outcome });

  await control.close();
  rmSync(directory, { recursive: true, force: true });
}

// --- Long prompt processing: no first byte yet, and is the probe still fine?
{
  const abort = new AbortController();
  const huge = chatBody(LLAMACPP, linesFiller(43_000), { num_ctx: 32_768 }, { stream: true });
  const running = post('/api/chat', huge, abort.signal).then(drain).catch(() => null);
  await sleep(12_000);
  const started = Date.now();
  const during = await probe(UPSTREAM);
  const probeMs = Date.now() - started;
  const view = lastView();
  check('long prompt shows as waiting', view.state === 'waiting', { state: view.state });
  check('probe answers during prompt processing', during.reachable, { probeMs, result: during.reachable || during });
  abort.abort();
  await running;
  await unload(LLAMACPP);
}

// --- Non-streaming: nothing to see until the end, usage afterwards
{
  const pending = post('/api/chat', chatBody(MLX, 'Count from one to thirty.', { num_predict: 200 }, { stream: false }));
  await sleep(100);
  const during = lastView();
  await drain(await pending);
  await sleep(50);
  const after = lastRecord();
  check('non-streaming request waits until the end', during.state === 'waiting', { state: during.state });
  check('non-streaming response gives usage and speed', (after.usage?.tokensPerSecond ?? 0) > 0, after.usage);
}

// --- Truncation
async function truncation(name: string, expected: { verdict: string; reason: string | null }, body: string, path = '/api/chat') {
  await drain(await post(path, body));
  await sleep(50);
  const view = lastView(await models());
  check(
    name,
    view.truncation.verdict === expected.verdict && view.truncation.reason === expected.reason,
    { ...view.truncation, chars: view.promptChars, tokens: view.usage?.promptTokens, cached: view.usage?.cachedTokens },
  );
}

const noStream = { stream: false };
await unload(LLAMACPP);
await truncation('llamacpp: prompt within context is ok', { verdict: 'ok', reason: null },
  chatBody(LLAMACPP, linesFiller(8_000), { num_ctx: 4096 }, noStream));
await truncation('llamacpp: repeated prompt stays ok with cache', { verdict: 'ok', reason: null },
  chatBody(LLAMACPP, linesFiller(8_000), { num_ctx: 4096 }, noStream));
await unload(LLAMACPP);
await truncation('llamacpp: far past the limit is caught', { verdict: 'likely', reason: 'ratio' },
  chatBody(LLAMACPP, linesFiller(40_000), { num_ctx: 4096 }, noStream));
await unload(LLAMACPP);
await truncation('llamacpp: JSON just past the limit is caught by the signature', { verdict: 'likely', reason: 'signature' },
  chatBody(LLAMACPP, jsonFiller(10_500), { num_ctx: 4096 }, noStream));
await unload(LLAMACPP);
await truncation('llamacpp: a system message does not break the signature', { verdict: 'likely', reason: 'signature' },
  JSON.stringify({
    model: LLAMACPP,
    think: false,
    keep_alive: '2m',
    stream: false,
    options: { temperature: 0, seed: 42, num_predict: 1, num_ctx: 4096 },
    messages: [
      { role: 'system', content: 'You are a careful assistant. Follow the rules of the warehouse at all times.' },
      { role: 'user', content: jsonFiller(10_500) },
    ],
  }));
await unload(LLAMACPP);
await truncation('mlx: oversized prompt is not truncated', { verdict: 'ok', reason: null },
  chatBody(MLX, linesFiller(20_000), { num_ctx: 1024 }, noStream));

const v1 = (extra: object) => JSON.stringify({
  model: MLX,
  max_tokens: 1,
  messages: [{ role: 'user', content: linesFiller(4000) }],
  ...extra,
});
await truncation('/v1 without stream reports usage', { verdict: 'ok', reason: null }, v1({}), '/v1/chat/completions');
await truncation('/v1 stream without usage is unknown', { verdict: 'unknown', reason: null }, v1({ stream: true }), '/v1/chat/completions');
await truncation('/v1 stream with usage is ok', { verdict: 'ok', reason: null },
  v1({ stream: true, stream_options: { include_usage: true } }), '/v1/chat/completions');

await unload(MLX);
await unload(LLAMACPP);
await proxy.close();
const final = await probe(UPSTREAM);
check('nothing left loaded', final.reachable && final.models.length === 0);
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
