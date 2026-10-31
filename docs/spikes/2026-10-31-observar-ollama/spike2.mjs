// Spike round 2: redo the /api/ps check with a generation that is really running,
// and find out why num_ctx did not truncate.
const DIRECT = 'http://192.168.1.144:11434';
const log = (name, value) => console.log(JSON.stringify({ test: name, ...value }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = async () => (await (await fetch(`${DIRECT}/api/ps`)).json()).models;

async function unload(model) {
  await fetch(`${DIRECT}/api/chat`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0, messages: [] }) });
  for (let i = 0; i < 40; i += 1) {
    if (!(await ps()).some((m) => m.name === model)) return;
    await sleep(250);
  }
}

async function stream(body, onLine) {
  const res = await fetch(`${DIRECT}/api/chat`, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) });
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let last = null;
  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      content += obj.message?.content ?? '';
      last = obj;
      onLine?.(obj);
    }
  }
  return { status: res.status, content, last };
}

async function psDuringGeneration() {
  const model = 'qwen3.5:4b';
  const body = {
    model,
    think: false,
    keep_alive: '10m',
    messages: [{ role: 'user', content: 'Write a very long essay about the history of Rome.' }],
    options: { temperature: 0, seed: 42, num_predict: 300, num_ctx: 4096 },
  };
  await stream({ ...body, options: { ...body.options, num_predict: 1 } });
  const idle = (await ps())[0];
  let lines = 0;
  const run = stream(body, () => { lines += 1; });
  await sleep(1500);
  const linesAtSnapshot = lines;
  const during = (await ps())[0];
  await run;
  const after = (await ps())[0];
  const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
  log('4_redo', {
    was_generating_at_snapshot: linesAtSnapshot > 0 && lines > linesAtSnapshot,
    linesAtSnapshot,
    totalLines: lines,
    fields_changed_idle_to_during: diff(idle, during),
    fields_changed_during_to_after: diff(during, after),
    expires: [idle?.expires_at, during?.expires_at, after?.expires_at],
  });
  await unload(model);
}

async function truncation(model, numCtx) {
  await unload(model);
  const filler = Array.from({ length: 900 }, (_, i) => `Line ${i}: the warehouse stores item number ${i * 7}.`).join('\n');
  const content = `SECRET_HEAD is PINEAPPLE.\n${filler}\nSECRET_TAIL is TOMATO.\nWhat are SECRET_HEAD and SECRET_TAIL? Answer briefly.`;
  const options = { temperature: 0, seed: 42, num_predict: 40 };
  if (numCtx) options.num_ctx = numCtx;

  let snapshot = null;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const found = (await ps()).find((m) => m.name === model);
      if (found) snapshot = found;
      await sleep(300);
    }
  })();
  const started = Date.now();
  const r = await stream({ model, think: false, keep_alive: '1m', messages: [{ role: 'user', content }], options });
  polling = false;
  await poller;
  log('5_redo', {
    model,
    requested_num_ctx: numCtx ?? 'default',
    runner: snapshot?.runner,
    context_length: snapshot?.context_length,
    prompt_eval_count: r.last?.prompt_eval_count,
    prompt_eval_cached_count: r.last?.prompt_eval_cached_count,
    done_reason: r.last?.done_reason,
    seconds: Math.round((Date.now() - started) / 1000),
    reply: r.content,
  });
  await unload(model);
}

try { await psDuringGeneration(); } catch (e) { log('4_redo', { failed: String(e) }); }
for (const model of ['qwen3.5:4b', 'bonsai-2:9b']) {
  for (const numCtx of [1024, null]) {
    try { await truncation(model, numCtx); } catch (e) { log('5_redo', { model, numCtx, failed: String(e) }); }
  }
}
console.log('loaded at end:', JSON.stringify((await ps()).map((m) => m.name)));
