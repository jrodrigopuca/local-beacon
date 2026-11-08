import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestView } from '../core/state.ts';
import { formatRequests, formatStatus, type RequestRow, toRow } from './format.ts';

function view(overrides: Partial<RequestView> = {}): RequestView {
  return {
    id: 'abc12345',
    method: 'POST',
    path: '/api/chat',
    startedAt: 1000,
    firstByteAt: null,
    lastByteAt: null,
    chunks: 0,
    bytes: 0,
    status: null,
    endedAt: null,
    outcome: 'in_flight',
    errorCode: null,
    model: 'qwen3.5:4b',
    promptChars: 100,
    usage: null,
    state: 'waiting',
    ahead: 0,
    silentForMs: null,
    truncation: { verdict: 'unknown', reason: null },
    ...overrides,
  };
}

const row = (overrides: Partial<RequestView> = {}): RequestRow => toRow(view(overrides), 3500);

describe('toRow', () => {
  it('measures age up to now while in flight', () => {
    assert.equal(row().ageMs, 2500);
  });

  it('measures age up to the end once finished', () => {
    assert.equal(row({ endedAt: 2000 }).ageMs, 1000);
  });

  it('flattens usage', () => {
    const usage = { promptTokens: 10, cachedTokens: 4, outputTokens: 5, tokensPerSecond: 44.5 };
    const result = row({ usage });
    assert.equal(result.promptTokens, 10);
    assert.equal(result.cachedTokens, 4);
    assert.equal(result.outputTokens, 5);
    assert.equal(result.tokensPerSecond, 44.5);
  });

  it('carries the truncation reason', () => {
    const result = row({ truncation: { verdict: 'likely', reason: 'signature' } });
    assert.equal(result.truncation, 'likely');
    assert.equal(result.truncationReason, 'signature');
  });
});

describe('formatRequests', () => {
  it('says so when there is nothing yet', () => {
    assert.equal(formatRequests([]), 'no requests yet');
  });

  it('shows one aligned line per request', () => {
    const usage = { promptTokens: 18, cachedTokens: 0, outputTokens: 110, tokensPerSecond: 44.85 };
    const lines = formatRequests([row({ state: 'done', usage, endedAt: 3000 }), row({ id: 'second00' })]).split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^ID\s+STATE\s+MODEL\s+AGE\s+IN\/OUT\s+TOK\/S/);
    assert.match(lines[1] ?? '', /^abc12345\s+done\s+qwen3\.5:4b\s+2\.0s\s+18\/110\s+44\.9/);
    assert.equal(lines[1]?.indexOf('qwen3.5:4b'), lines[2]?.indexOf('qwen3.5:4b'));
  });

  it('explains why a request is waiting, stalled or failed', () => {
    assert.match(formatRequests([row({ ahead: 2 })]), /2 ahead/);
    assert.match(formatRequests([row({ state: 'stalled', silentForMs: 31_000 })]), /silent 31\.0s/);
    assert.match(formatRequests([row({ state: 'failed', errorCode: 'ECONNRESET' })]), /ECONNRESET/);
  });

  it('warns about probable truncation', () => {
    const usage = { promptTokens: 1026, cachedTokens: 0, outputTokens: 1, tokensPerSecond: null };
    const output = formatRequests([row({ usage, truncation: { verdict: 'likely', reason: 'ratio' } })]);
    assert.match(output, /warning: abc12345 was probably truncated \(1026 tokens/);
  });

  it('does not warn when the verdict is ok or unknown', () => {
    assert.doesNotMatch(formatRequests([row()]), /warning/);
    assert.doesNotMatch(formatRequests([row({ truncation: { verdict: 'ok', reason: null } })]), /warning/);
  });
});

describe('formatStatus', () => {
  it('shows why the server cannot be reached', () => {
    const output = formatStatus({ server: 'down', probe: { reachable: false, reason: 'refused', detail: 'ECONNREFUSED' } });
    assert.match(output, /server\s+down/);
    assert.match(output, /refused \(ECONNREFUSED\)/);
    assert.doesNotMatch(output, /not like ollama/);
  });

  it('says a server that answers wrong is not ollama, instead of down', () => {
    const probe = { reachable: false, reason: 'bad_response', detail: '/api/version answered 404' } as const;
    const output = formatStatus({ server: 'unknown', probe });
    assert.match(output, /server\s+unknown/);
    assert.match(output, /not like ollama/);
  });

  it('says when no model is loaded', () => {
    const output = formatStatus({ server: 'idle', probe: { reachable: true, version: '0.40.13', models: [] } });
    assert.match(output, /ollama\s+0\.40\.13/);
    assert.match(output, /none loaded/);
  });

  it('lists loaded models with what matters for truncation', () => {
    const model = { name: 'bonsai-2:9b', runner: 'llamacpp', contextLength: 4096, sizeVram: 3_200_000_000, expiresAt: null };
    const output = formatStatus({ server: 'busy', probe: { reachable: true, version: '1', models: [model] } });
    assert.match(output, /bonsai-2:9b\s+llamacpp\s+4096\s+3\.2 GB/);
  });

  it('tolerates a model with missing fields', () => {
    const model = { name: 'old', runner: null, contextLength: null, sizeVram: null, expiresAt: null };
    const output = formatStatus({ server: 'idle', probe: { reachable: true, version: '1', models: [model] } });
    assert.match(output, /old\s+-\s+-\s+-/);
  });
});
