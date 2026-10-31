// Spike: five questions about observing a remote Ollama from outside.
const DIRECT = 'http://192.168.1.144:11434';
const PROXY = 'http://127.0.0.1:11500';
const MODEL = process.env.MODEL ?? 'qwen3.5:4b';
const OPTIONS = { temperature: 0, seed: 42, num_predict: 60, num_ctx: 4096 };
const PROMPT = 'List the first ten prime numbers, one per line, with no other text.';

const log = (name, value) => console.log(JSON.stringify({ test: name, ...value }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chatBody(extra = {}) {
  return {
    model: MODEL,
    think: false,
    keep_alive: '10m',
    messages: [{ role: 'user', content: PROMPT }],
    options: OPTIONS,
    ...extra,
  };
}

async function chatStream(base, body, { signal, onChunk } = {}) {
  const start = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let last = null;
  let firstMs = null;
  let lines = 0;
  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      firstMs ??= Date.now() - start;
      lines += 1;
      content += obj.message?.content ?? '';
      last = obj;
      onChunk?.(obj);
    }
  }
  return { status: res.status, content, last, firstMs, lines, totalMs: Date.now() - start };
}

async function chatPlain(base, body) {
  const start = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: false }),
  });
  const json = await res.json();
  return { status: res.status, content: json.message?.content, last: json, totalMs: Date.now() - start };
}

const stats = (r) => ({
  prompt_eval_count: r.last?.prompt_eval_count,
  eval_count: r.last?.eval_count,
  done_reason: r.last?.done_reason,
});

async function t0warm() {
  const r = await chatPlain(DIRECT, chatBody());
  log('warm', { status: r.status, totalMs: r.totalMs, ...stats(r) });
}

async function t1passthrough() {
  const direct = await chatStream(DIRECT, chatBody());
  const proxied = await chatStream(PROXY, chatBody());
  const recs = await (await fetch(`${PROXY}/__requests`)).json();
  log('1_proxy_streaming', {
    same_content: direct.content === proxied.content,
    direct: { lines: direct.lines, firstMs: direct.firstMs, totalMs: direct.totalMs, ...stats(direct) },
    proxied: { lines: proxied.lines, firstMs: proxied.firstMs, totalMs: proxied.totalMs, ...stats(proxied) },
    proxy_saw: recs.at(-1),
  });

  // OpenAI-compatible route, as opencode uses it.
  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: 20,
      reasoning_effort: 'none',
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data:'));
  log('1b_proxy_v1_sse', { status: res.status, events: events.length, ends_with_done: events.at(-1)?.trim() === 'data: [DONE]' });
}

async function t2streamVsPlain() {
  const plain = await chatPlain(DIRECT, chatBody());
  const stream = await chatStream(DIRECT, chatBody());
  log('2_stream_vs_plain', {
    same_content: plain.content === stream.content,
    plain: { totalMs: plain.totalMs, ...stats(plain) },
    stream: { totalMs: stream.totalMs, ...stats(stream) },
    plain_keys: Object.keys(plain.last).sort(),
    stream_final_keys: Object.keys(stream.last).sort(),
  });

  const schema = { type: 'object', properties: { primes: { type: 'array', items: { type: 'integer' } } }, required: ['primes'] };
  const fPlain = await chatPlain(DIRECT, chatBody({ format: schema }));
  const fStream = await chatStream(DIRECT, chatBody({ format: schema }));
  log('2b_with_format', { same_content: fPlain.content === fStream.content, plain: fPlain.content, stream: fStream.content });
}

async function t3cancel() {
  const long = chatBody({
    messages: [{ role: 'user', content: 'Write a very long essay about the history of Rome.' }],
    options: { ...OPTIONS, num_predict: 1500 },
  });

  // Control: how long the follow-up waits while a generation really is running.
  const bgCtl = new AbortController();
  const background = chatStream(DIRECT, long, { signal: bgCtl.signal }).catch(() => null);
  await sleep(3000);
  const busy = await chatStream(DIRECT, chatBody({ options: { ...OPTIONS, num_predict: 5 } }));
  bgCtl.abort();
  await background;
  await sleep(1000);

  // Cancel through the proxy, then measure the same follow-up.
  const ctl = new AbortController();
  let received = 0;
  const run = chatStream(PROXY, long, { signal: ctl.signal, onChunk: () => { received += 1; } }).catch((e) => ({ aborted: e.name }));
  await sleep(3000);
  ctl.abort();
  const abortedAt = Date.now();
  await run;
  const after = await chatStream(DIRECT, chatBody({ options: { ...OPTIONS, num_predict: 5 } }));
  await sleep(300);
  const recs = await (await fetch(`${PROXY}/__requests`)).json();
  log('3_cancel', {
    chunks_before_abort: received,
    followup_while_busy: { firstMs: busy.firstMs, totalMs: busy.totalMs },
    followup_after_cancel: { firstMs: after.firstMs, totalMs: after.totalMs, msSinceAbort: Date.now() - abortedAt },
    proxy_outcome: recs.findLast((r) => r.path === '/api/chat')?.outcome,
  });
}

async function t4ps() {
  const ps = async () => (await (await fetch(`${DIRECT}/api/ps`)).json()).models;
  const idle = await ps();
  const run = chatStream(DIRECT, chatBody({ options: { ...OPTIONS, num_predict: 200 } }));
  await sleep(1500);
  const during = await ps();
  await run;
  const after = await ps();
  const strip = (m) => m.map(({ expires_at, ...rest }) => rest);
  log('4_api_ps', {
    idle_equals_during_ignoring_expiry: JSON.stringify(strip(idle)) === JSON.stringify(strip(during)),
    keys: Object.keys(during[0] ?? {}).sort(),
    during,
    expires: { idle: idle[0]?.expires_at, during: during[0]?.expires_at, after: after[0]?.expires_at },
  });
}

async function t5truncate() {
  const filler = Array.from({ length: 900 }, (_, i) => `Line ${i}: the warehouse stores item number ${i * 7}.`).join('\n');
  const content = `SECRET_HEAD is PINEAPPLE.\n${filler}\nSECRET_TAIL is TOMATO.\nWhat are SECRET_HEAD and SECRET_TAIL? Answer briefly.`;
  const body = (num_ctx) => chatBody({ messages: [{ role: 'user', content }], options: { ...OPTIONS, num_ctx, num_predict: 40 } });
  const small = await chatStream(DIRECT, body(1024));
  const big = await chatStream(DIRECT, body(16384));
  log('5_truncation', {
    chars: content.length,
    small: { num_ctx: 1024, ...stats(small), reply: small.content, final_keys: Object.keys(small.last).sort() },
    big: { num_ctx: 16384, ...stats(big), reply: big.content },
  });
}

for (const [name, fn] of Object.entries({ t0warm, t1passthrough, t2streamVsPlain, t3cancel, t4ps, t5truncate })) {
  try {
    await fn();
  } catch (err) {
    log(name, { failed: String(err) });
  }
}
