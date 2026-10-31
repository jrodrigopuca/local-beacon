// Calibration round 2: where exactly llamacpp truncates, how much survives,
// and whether the chars-per-token range holds on a different tokenizer.
import { readFileSync } from 'node:fs';

const DIRECT = process.env.OLLAMA ?? 'http://192.168.1.144:11434';
const REPO = '/Users/juan/Developer/local-beacon';
const log = (value) => console.log(JSON.stringify(value));
const ps = async () => (await (await fetch(`${DIRECT}/api/ps`)).json()).models;

async function unload(model) {
  await fetch(`${DIRECT}/api/chat`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0, messages: [] }) });
  for (let i = 0; i < 60; i += 1) {
    if (!(await ps()).some((m) => m.name === model)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function chat(model, content, options = {}) {
  const res = await fetch(`${DIRECT}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false, think: false, keep_alive: '1m', options: { temperature: 0, seed: 42, num_predict: 1, ...options } }),
  });
  const json = await res.json();
  return { status: res.status, prompt: json.prompt_eval_count, cached: json.prompt_eval_cached_count, done_reason: json.done_reason, error: json.error };
}

// Roughly 2.92 chars per token for this filler, from round 1.
const filler = (tokens) => {
  const chars = Math.round(tokens * 2.92);
  let out = '';
  for (let i = 0; out.length < chars; i += 1) out += `Line ${i}: the warehouse stores item number ${i * 7}.\n`;
  return out.slice(0, chars);
};

const MODEL = 'bonsai-2:9b';
for (const [numCtx, targets] of [
  [1024, [1800, 2000, 2100, 3000, 6000]],
  [4096, [3800, 4050, 4200, 8000]],
]) {
  for (const target of targets) {
    await unload(MODEL);
    const text = filler(target);
    const result = await chat(MODEL, text, { num_ctx: numCtx });
    const loaded = (await ps()).find((m) => m.name === MODEL);
    log({ test: 'cutoff', num_ctx: numCtx, chars: text.length, context_length: loaded?.context_length, runner: loaded?.runner, ...result });
  }
}
await unload(MODEL);

const GEMMA = 'gemma4:12b';
const read = (path) => readFileSync(`${REPO}/${path}`, 'utf8').slice(0, 6000);
const TEXTS = {
  code_ts: read('src/core/proxy.ts'),
  prose_en: read('LICENSE'),
  prose_es: read('docs/spikes/2026-10-31-observar-ollama.md'),
  json: read('package-lock.json'),
  digits: filler(2000),
};
for (const [kind, text] of Object.entries(TEXTS)) {
  const r = await chat(GEMMA, text, { num_ctx: 8192 });
  const loaded = (await ps()).find((m) => m.name === GEMMA);
  log({ test: 'other_tokenizer', model: GEMMA, runner: loaded?.runner, kind, chars: text.length, ...r, chars_per_token: Number((text.length / r.prompt).toFixed(2)) });
}
await unload(GEMMA);
log({ loaded_at_end: (await ps()).map((m) => m.name) });
