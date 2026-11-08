import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestRecord } from './proxy.ts';
import { DEFAULT_STALL_AFTER_MS, health, isWork, serverState, viewRequests } from './state.ts';

const NOW = 1_000_000;

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'r',
    method: 'POST',
    path: '/api/chat',
    startedAt: NOW - 1000,
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
    ...overrides,
  };
}

const view = (overrides: Partial<RequestRecord> = {}, stallAfterMs?: number) =>
  viewRequests([record(overrides)], NOW, stallAfterMs === undefined ? {} : { stallAfterMs })[0];

describe('viewRequests', () => {
  it('is waiting until the first byte arrives, however long that takes', () => {
    const v = view({ startedAt: NOW - 10 * DEFAULT_STALL_AFTER_MS, status: 200 });
    assert.equal(v?.state, 'waiting');
    assert.equal(v?.silentForMs, null);
  });

  it('is generating while bytes keep arriving', () => {
    const v = view({ firstByteAt: NOW - 500, lastByteAt: NOW - 100, chunks: 3 });
    assert.equal(v?.state, 'generating');
    assert.equal(v?.silentForMs, 100);
  });

  it('stalls only after the silence exceeds the threshold', () => {
    assert.equal(view({ firstByteAt: NOW - 5000, lastByteAt: NOW - 1000 }, 1000)?.state, 'generating');
    assert.equal(view({ firstByteAt: NOW - 5000, lastByteAt: NOW - 1001 }, 1000)?.state, 'stalled');
  });

  it('applies the default threshold when none is given', () => {
    const lastByteAt = NOW - DEFAULT_STALL_AFTER_MS - 1;
    assert.equal(view({ firstByteAt: lastByteAt, lastByteAt })?.state, 'stalled');
  });

  it('recovers from stalled when a new byte arrives', () => {
    const stalled = record({ firstByteAt: NOW - 9000, lastByteAt: NOW - 9000 });
    assert.equal(viewRequests([stalled], NOW, { stallAfterMs: 1000 })[0]?.state, 'stalled');
    const resumed = { ...stalled, lastByteAt: NOW - 10 };
    assert.equal(viewRequests([resumed], NOW, { stallAfterMs: 1000 })[0]?.state, 'generating');
  });

  it('maps finished outcomes', () => {
    const ended = { endedAt: NOW, firstByteAt: NOW - 9000, lastByteAt: NOW - 9000 };
    assert.equal(view({ ...ended, outcome: 'done', status: 200 })?.state, 'done');
    assert.equal(view({ ...ended, outcome: 'client_disconnected' })?.state, 'cancelled');
    assert.equal(view({ ...ended, outcome: 'upstream_error' })?.state, 'failed');
  });

  it('treats a completed HTTP error as failed', () => {
    assert.equal(view({ outcome: 'done', status: 503, endedAt: NOW })?.state, 'failed');
    assert.equal(view({ outcome: 'done', status: 399, endedAt: NOW })?.state, 'done');
  });

  it('reports no silence once the response has ended', () => {
    const v = view({ outcome: 'done', status: 200, endedAt: NOW, firstByteAt: NOW - 9000, lastByteAt: NOW - 9000 });
    assert.equal(v?.silentForMs, null);
  });

  it('counts earlier in-flight work for a waiting request', () => {
    const views = viewRequests(
      [
        record({ firstByteAt: NOW - 100, lastByteAt: NOW - 50 }),
        record({ outcome: 'done', status: 200, endedAt: NOW - 10 }),
        record({ path: '/api/ps' }),
        record(),
        record({ path: '/v1/chat/completions' }),
      ],
      NOW,
    );
    assert.deepEqual(
      views.map((v) => v.ahead),
      [0, 0, 0, 1, 2],
    );
  });

  it('does not report requests ahead of one that is generating', () => {
    const views = viewRequests([record(), record({ firstByteAt: NOW - 100, lastByteAt: NOW - 50 })], NOW);
    assert.equal(views[1]?.ahead, 0);
  });

  it('reports truncation as unknown without usage', () => {
    assert.equal(view({ promptChars: 40_000 })?.truncation.verdict, 'unknown');
  });

  it('detects truncation from the ratio without any model data', () => {
    const usage = { promptTokens: 1026, cachedTokens: 0, outputTokens: 1, tokensPerSecond: null };
    assert.deepEqual(view({ promptChars: 43_932, usage })?.truncation, { verdict: 'likely', reason: 'ratio' });
  });

  it('uses the loaded model of the request to read the signature', () => {
    const usage = { promptTokens: 1026, cachedTokens: 0, outputTokens: 1, tokensPerSecond: null };
    const models = [
      { name: 'other', runner: 'llamacpp', contextLength: 8192, sizeVram: null, expiresAt: null },
      { name: 'bonsai-2:9b', runner: 'llamacpp', contextLength: 2048, sizeVram: null, expiresAt: null },
    ];
    const near = record({ model: 'bonsai-2:9b', promptChars: 4000, usage });

    assert.equal(viewRequests([near], NOW)[0]?.truncation.verdict, 'ok');
    assert.deepEqual(viewRequests([near], NOW, { models })[0]?.truncation, { verdict: 'likely', reason: 'signature' });
    const mlx = [{ ...models[1]!, runner: 'mlx' }];
    assert.equal(viewRequests([near], NOW, { models: mlx })[0]?.truncation.verdict, 'ok');
  });

  it('keeps the record fields in the view', () => {
    assert.equal(view({ id: 'abc', chunks: 7 })?.id, 'abc');
    assert.equal(view({ id: 'abc', chunks: 7 })?.chunks, 7);
  });
});

describe('serverState', () => {
  const views = (...records: RequestRecord[]) => viewRequests(records, NOW);
  const generating = record({ firstByteAt: NOW - 100, lastByteAt: NOW - 10 });
  const stalled = record({ firstByteAt: NOW - 90_000, lastByteAt: NOW - 90_000 });

  it('is idle when reachable with nothing in flight', () => {
    assert.equal(serverState('up', views()), 'idle');
    assert.equal(serverState('up', views(record({ outcome: 'done', status: 200, endedAt: NOW }))), 'idle');
  });

  it('is down when unreachable with nothing in flight', () => {
    assert.equal(serverState('down', views()), 'down');
  });

  it('is busy when reachable with work in flight, even if no byte arrived yet', () => {
    assert.equal(serverState('up', views(record())), 'busy');
    assert.equal(serverState('up', views(stalled)), 'busy');
  });

  it('stays busy when the probe fails but bytes are still arriving', () => {
    assert.equal(serverState('down', views(generating)), 'busy');
  });

  it('is down when the probe fails and the work in flight went silent', () => {
    assert.equal(serverState('down', views(stalled)), 'down');
    assert.equal(serverState('down', views(record())), 'down');
  });

  it('is unknown, not down, when something answers but not like ollama', () => {
    assert.equal(serverState('foreign', views()), 'unknown');
    assert.equal(serverState('foreign', views(record())), 'busy');
    assert.equal(serverState('foreign', views(generating)), 'busy');
  });

  it('ignores read-only routes, with or without a query string', () => {
    assert.equal(serverState('up', views(record({ path: '/api/ps' }))), 'idle');
    assert.equal(serverState('up', views(record({ path: '/api/tags?x=1' }))), 'idle');
  });

  it('counts unknown routes as work', () => {
    assert.equal(serverState('up', views(record({ path: '/api/some-future-route' }))), 'busy');
  });
});

describe('health', () => {
  it('tells a server that answers wrong apart from one that does not answer', () => {
    assert.equal(health({ reachable: true, version: '1', models: [] }), 'up');
    assert.equal(health({ reachable: false, reason: 'bad_response', detail: '/api/version answered 404' }), 'foreign');
    assert.equal(health({ reachable: false, reason: 'refused', detail: 'ECONNREFUSED' }), 'down');
    assert.equal(health({ reachable: false, reason: 'timeout', detail: 'x' }), 'down');
  });
});

describe('isWork', () => {
  it('leaves cheap reads out and counts everything else', () => {
    assert.equal(isWork({ path: '/api/chat' }), true);
    assert.equal(isWork({ path: '/v1/chat/completions' }), true);
    assert.equal(isWork({ path: '/api/show' }), false);
    assert.equal(isWork({ path: '/api/version?x=1' }), false);
  });
});
