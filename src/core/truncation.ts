export type TruncationVerdict =
  /** The numbers fit a complete prompt. */
  | 'ok'
  /** The prompt was probably cut. Ollama gives no explicit signal, so this stays an inference. */
  | 'likely'
  /** Not enough data: request in flight, no usage reported, or no prompt text found. */
  | 'unknown';

export interface TruncationResult {
  verdict: TruncationVerdict;
  reason: 'ratio' | 'signature' | null;
}

export interface TruncationInput {
  promptChars: number | null;
  promptTokens: number | null;
  /** From /api/ps. Without it only the ratio applies. */
  contextLength?: number | null;
  runner?: string | null;
}

// Measured 2026-10-31: 2.31 to 4.65 chars per token across code, prose, JSON and digits,
// on the qwen family and gemma. The value itself is my judgment: above the normal range,
// but below it a prompt cut right at the limit goes unnoticed, hence the signature.
export const MAX_CHARS_PER_TOKEN = 6;

// llamacpp left exactly floor(C / 2) + 2 tokens at C = 2048 and C = 4096. The tolerance is
// provisional: it covers template tokens, and a system message may shift the count.
const SIGNATURE_TOLERANCE = 2;

function matchesSignature(tokens: number, contextLength: number): boolean {
  return Math.abs(tokens - (Math.floor(contextLength / 2) + 2)) <= SIGNATURE_TOLERANCE;
}

export function detectTruncation(input: TruncationInput): TruncationResult {
  const { promptChars, promptTokens, contextLength, runner } = input;
  if (promptChars === null || promptTokens === null) return { verdict: 'unknown', reason: null };

  if (promptChars / promptTokens > MAX_CHARS_PER_TOKEN) return { verdict: 'likely', reason: 'ratio' };

  // mlx did not truncate in any measurement, so the signature means nothing there.
  if (runner !== 'mlx' && contextLength && matchesSignature(promptTokens, contextLength)) {
    return { verdict: 'likely', reason: 'signature' };
  }
  return { verdict: 'ok', reason: null };
}
