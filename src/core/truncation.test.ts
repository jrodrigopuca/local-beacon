import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectTruncation } from './truncation.ts';

describe('detectTruncation', () => {
  it('is unknown without chars or tokens', () => {
    assert.equal(detectTruncation({ promptChars: null, promptTokens: 100 }).verdict, 'unknown');
    assert.equal(detectTruncation({ promptChars: 100, promptTokens: null }).verdict, 'unknown');
  });

  // Every normal case measured on 2026-10-31.
  for (const [kind, promptChars, promptTokens] of [
    ['code', 6000, 1614],
    ['english prose', 6000, 1300],
    ['english prose, gemma', 6000, 1289],
    ['spanish prose', 3467, 1190],
    ['json', 6000, 2595],
    ['digits', 6000, 2053],
    ['large complete prompt', 43_932, 15_970],
  ] as const) {
    it(`accepts a complete prompt: ${kind}`, () => {
      assert.deepEqual(detectTruncation({ promptChars, promptTokens }), { verdict: 'ok', reason: null });
    });
  }

  it('flags the truncation measured on llamacpp', () => {
    const result = detectTruncation({ promptChars: 43_932, promptTokens: 1026 });
    assert.deepEqual(result, { verdict: 'likely', reason: 'ratio' });
  });

  it('flags a ratio just above the limit and not one at it', () => {
    assert.equal(detectTruncation({ promptChars: 6001, promptTokens: 1000 }).verdict, 'likely');
    assert.equal(detectTruncation({ promptChars: 6000, promptTokens: 1000 }).verdict, 'ok');
  });

  it('catches a cut just past the limit through the signature', () => {
    // Measured: 11826 chars left 2050 tokens at C=4096, a ratio of only 5.77.
    const input = { promptChars: 11_826, promptTokens: 2050 };
    assert.equal(detectTruncation(input).verdict, 'ok');
    assert.deepEqual(detectTruncation({ ...input, contextLength: 4096, runner: 'llamacpp' }), {
      verdict: 'likely',
      reason: 'signature',
    });
  });

  it('applies the signature for an unknown runner', () => {
    assert.equal(detectTruncation({ promptChars: 4000, promptTokens: 1026, contextLength: 2048 }).verdict, 'likely');
  });

  it('never applies the signature on mlx', () => {
    const input = { promptChars: 4000, promptTokens: 1026, contextLength: 2048, runner: 'mlx' };
    assert.equal(detectTruncation(input).verdict, 'ok');
  });

  it('leaves the signature tolerance at two tokens', () => {
    const input = { promptChars: 3000, contextLength: 2048, runner: 'llamacpp' };
    assert.equal(detectTruncation({ ...input, promptTokens: 1024 }).verdict, 'likely');
    assert.equal(detectTruncation({ ...input, promptTokens: 1028 }).verdict, 'likely');
    assert.equal(detectTruncation({ ...input, promptTokens: 1023 }).verdict, 'ok');
    assert.equal(detectTruncation({ ...input, promptTokens: 1029 }).verdict, 'ok');
  });

  it('is fine with an empty prompt', () => {
    assert.equal(detectTruncation({ promptChars: 0, promptTokens: 12 }).verdict, 'ok');
  });
});
