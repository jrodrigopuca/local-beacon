/** What a request body reveals. Never the text itself: only its size and the model. */
export interface RequestFacts {
  model: string | null;
  /** Characters of prompt text. Null when the body has no recognizable prompt. */
  promptChars: number | null;
}

export interface Usage {
  /** Total prompt tokens, cached ones included (measured 2026-10-31). */
  promptTokens: number;
  cachedTokens: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
}

const UNKNOWN: RequestFacts = { model: null, promptChars: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `content` is a string in ollama's API, and may be a list of parts in the OpenAI one. */
function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce<number>((total, part) => {
    return total + (isRecord(part) && typeof part.text === 'string' ? part.text.length : 0);
  }, 0);
}

export function inspectRequest(body: Buffer): RequestFacts {
  if (body.length === 0) return UNKNOWN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return UNKNOWN;
  }
  if (!isRecord(parsed)) return UNKNOWN;

  const model = typeof parsed.model === 'string' ? parsed.model : null;
  const { messages, prompt, system } = parsed;

  if (Array.isArray(messages)) {
    const chars = messages.reduce<number>((total, message) => {
      return total + (isRecord(message) ? textLength(message.content) : 0);
    }, 0);
    return { model, promptChars: chars };
  }
  if (typeof prompt === 'string') {
    return { model, promptChars: prompt.length + textLength(system) };
  }
  return { model, promptChars: null };
}

function integerField(text: string, field: string): number | null {
  const value = new RegExp(`"${field}":\\s*(\\d+)`).exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

/**
 * Reads usage from the end of a response. Works on ollama's NDJSON, the OpenAI SSE
 * stream and both non-streaming bodies. Generated text cannot fake a match, because
 * JSON escapes its quotes.
 */
export function readUsage(tail: string): Usage | null {
  const ollamaTokens = integerField(tail, 'prompt_eval_count');
  const promptTokens = ollamaTokens ?? integerField(tail, 'prompt_tokens');
  if (promptTokens === null) return null;

  const evalCount = integerField(tail, 'eval_count');
  const evalDuration = integerField(tail, 'eval_duration');
  return {
    promptTokens,
    cachedTokens: integerField(tail, 'prompt_eval_cached_count') ?? integerField(tail, 'cached_tokens'),
    outputTokens: evalCount ?? integerField(tail, 'completion_tokens'),
    tokensPerSecond: evalCount && evalDuration ? evalCount / (evalDuration / 1e9) : null,
  };
}
