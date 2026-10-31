import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspectRequest, readUsage } from './inspect.ts';

const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

describe('inspectRequest', () => {
  it('sums the text of every chat message', () => {
    const facts = inspectRequest(
      body({
        model: 'qwen3.5:4b',
        messages: [
          { role: 'system', content: 'abc' },
          { role: 'user', content: 'de' },
          { role: 'tool', content: 'f' },
        ],
      }),
    );
    assert.deepEqual(facts, { model: 'qwen3.5:4b', promptChars: 6 });
  });

  it('reads OpenAI content parts and ignores images', () => {
    const facts = inspectRequest(
      body({
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'abcd' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      }),
    );
    assert.equal(facts.promptChars, 4);
  });

  it('adds the system field on /api/generate', () => {
    assert.equal(inspectRequest(body({ model: 'm', prompt: 'abc', system: 'de' })).promptChars, 5);
    assert.equal(inspectRequest(body({ model: 'm', prompt: 'abc' })).promptChars, 3);
  });

  it('counts a conversation with no text as zero characters', () => {
    assert.equal(inspectRequest(body({ model: 'm', messages: [] })).promptChars, 0);
    assert.equal(inspectRequest(body({ model: 'm', messages: ['odd', { role: 'user' }] })).promptChars, 0);
  });

  it('keeps the model when there is no recognizable prompt', () => {
    assert.deepEqual(inspectRequest(body({ model: 'm', input: 'embed me' })), { model: 'm', promptChars: null });
  });

  it('survives bodies that are not a JSON object', () => {
    const unknown = { model: null, promptChars: null };
    assert.deepEqual(inspectRequest(Buffer.alloc(0)), unknown);
    assert.deepEqual(inspectRequest(Buffer.from('{broken')), unknown);
    assert.deepEqual(inspectRequest(Buffer.from('[1,2]')), unknown);
    assert.deepEqual(inspectRequest(Buffer.from('null')), unknown);
  });

  it('ignores a model that is not a string', () => {
    assert.equal(inspectRequest(body({ model: 7, prompt: 'a' })).model, null);
  });
});

describe('readUsage', () => {
  it('reads the final line of an ollama stream', () => {
    const tail =
      '{"message":{"content":"x"},"done":false}\n' +
      '{"done":true,"total_duration":9,"prompt_eval_count":1300,"prompt_eval_cached_count":1296,' +
      '"eval_count":25,"eval_duration":500000000}\n';
    assert.deepEqual(readUsage(tail), {
      promptTokens: 1300,
      cachedTokens: 1296,
      outputTokens: 25,
      tokensPerSecond: 50,
    });
  });

  it('reads OpenAI usage', () => {
    const tail =
      'data: {"choices":[],"usage":{"prompt_tokens":1298,"prompt_tokens_details":{"cached_tokens":7},' +
      '"completion_tokens":3,"total_tokens":1301}}\n\ndata: [DONE]\n\n';
    assert.deepEqual(readUsage(tail), { promptTokens: 1298, cachedTokens: 7, outputTokens: 3, tokensPerSecond: null });
  });

  it('is null for an OpenAI stream without usage', () => {
    assert.equal(readUsage('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'), null);
  });

  it('does not take the prompt count for the output count', () => {
    const usage = readUsage('{"prompt_eval_count":10}');
    assert.equal(usage?.outputTokens, null);
    assert.equal(usage?.promptTokens, 10);
  });

  it('is not fooled by generated text that quotes the field', () => {
    const tail = `${JSON.stringify({ message: { content: '{"prompt_eval_count":999}' } })}\n`;
    assert.equal(readUsage(tail), null);
  });

  it('takes the real count when generated text quotes the field too', () => {
    const line = JSON.stringify({ message: { content: '"prompt_eval_count":999' }, prompt_eval_count: 10 });
    assert.equal(readUsage(line)?.promptTokens, 10);
  });

  it('leaves the speed empty when the duration is missing or zero', () => {
    assert.equal(readUsage('{"prompt_eval_count":1,"eval_count":5}')?.tokensPerSecond, null);
    assert.equal(readUsage('{"prompt_eval_count":1,"eval_count":5,"eval_duration":0}')?.tokensPerSecond, null);
  });
});
