// Calibration: chars per token by kind of text, cache semantics of prompt_eval_count,
// and what /v1 reports. num_predict 1: we only care about the prompt side.
import { readFileSync } from 'node:fs';

const DIRECT = process.env.OLLAMA ?? 'http://192.168.1.144:11434';
const REPO = '/Users/juan/Developer/local-beacon';
const MODELS = ['qwen3.5:4b', 'bonsai-2:9b'];
const SIZE = 6000;

const read = (path) => readFileSync(`${REPO}/${path}`, 'utf8').slice(0, SIZE);
const TEXTS = {
  code_ts: read('src/core/proxy.ts'),
  prose_en: read('LICENSE'),
  prose_es: read('docs/spikes/2026-10-31-observar-ollama.md'),
  json: read('package-lock.json'),
  digits: Array.from({ length: 200 }, (_, i) => `Line ${i}: the warehouse stores item number ${i * 7}.`).join('\n').slice(0, SIZE),
};

const log = (value) => console.log(JSON.stringify(value));
const ps = async () => (await (await fetch(`${DIRECT}/api/ps`)).json()).models;

async function unload(model) {
  await fetch(`${DIRECT}/api/chat`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0, messages: [] }) });
  for (let i = 0; i < 40; i += 1) {
    if (!(await ps()).some((m) => m.name === model)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function chat(model, messages, options = {}) {
  const res = await fetch(`${DIRECT}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: false, think: false, keep_alive: '2m', options: { temperature: 0, seed: 42, num_predict: 1, ...options } }),
  });
  const json = await res.json();
  return { status: res.status, prompt: json.prompt_eval_count, cached: json.prompt_eval_cached_count, error: json.error };
}

for (const model of MODELS) {
  for (const [kind, text] of Object.entries(TEXTS)) {
    await unload(model);
    const messages = [{ role: 'user', content: text }];
    const first = await chat(model, messages);
    const repeat = await chat(model, messages);
    log({
      test: 'ratio_and_cache',
      model,
      kind,
      chars: text.length,
      first,
      repeat,
      chars_per_token: Number((text.length / first.prompt).toFixed(2)),
    });
  }

  await unload(model);
  const a = TEXTS.prose_en;
  const turn1 = [{ role: 'user', content: a }];
  const r1 = await chat(model, turn1);
  const turn2 = [...turn1, { role: 'assistant', content: 'Understood.' }, { role: 'user', content: 'Summarize the first section in one line.' }];
  const r2 = await chat(model, turn2);
  log({ test: 'second_turn', model, r1, r2 });

  await unload(model);
  const small = await chat(model, [{ role: 'user', content: TEXTS.prose_en }], { num_ctx: 1024 });
  log({ test: 'truncated', model, chars: TEXTS.prose_en.length, small });

  await unload(model);
  const body = (extra) => JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: TEXTS.prose_en }], ...extra });
  const v1plain = await (await fetch(`${DIRECT}/v1/chat/completions`, { method: 'POST', body: body({}) })).json();
  const usageOf = (text) => text.split('\n').filter((l) => l.startsWith('data:') && l.includes('"usage"')).map((l) => JSON.parse(l.slice(5)).usage);
  const v1stream = usageOf(await (await fetch(`${DIRECT}/v1/chat/completions`, { method: 'POST', body: body({ stream: true }) })).text());
  const v1usage = usageOf(await (await fetch(`${DIRECT}/v1/chat/completions`, { method: 'POST', body: body({ stream: true, stream_options: { include_usage: true } }) })).text());
  log({ test: 'v1_usage', model, plain: v1plain.usage, stream_default: v1stream.at(-1) ?? null, stream_include_usage: v1usage.at(-1) ?? null });
  await unload(model);
}
log({ loaded_at_end: (await ps()).map((m) => m.name) });
