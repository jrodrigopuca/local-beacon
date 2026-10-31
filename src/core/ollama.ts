export interface LoadedModel {
  name: string;
  /** Inference backend: decides how an oversized prompt behaves (spike, test 5). */
  runner: string | null;
  contextLength: number | null;
  sizeVram: number | null;
  expiresAt: string | null;
}

export type ProbeFailure = 'refused' | 'timeout' | 'unreachable' | 'bad_response';

export type ProbeResult =
  | { reachable: true; version: string; models: LoadedModel[] }
  | { reachable: false; reason: ProbeFailure; detail: string };

export interface ProbeOptions {
  timeoutMs?: number;
}

// Provisional, my own judgment: a LAN read that takes longer than this is not healthy.
// Not measured under load yet.
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

class BadResponse extends Error {}

async function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new BadResponse(`${url.pathname} answered ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new BadResponse(`${url.pathname} did not answer JSON`);
  }
}

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function parseModels(body: unknown): LoadedModel[] {
  const { models } = asObject(body);
  if (!Array.isArray(models)) throw new BadResponse('/api/ps has no model list');
  return models.map((value) => {
    const model = asObject(value);
    const name = stringOrNull(model.name);
    if (name === null) throw new BadResponse('/api/ps has a model without a name');
    return {
      name,
      runner: stringOrNull(model.runner),
      contextLength: numberOrNull(model.context_length),
      sizeVram: numberOrNull(model.size_vram),
      expiresAt: stringOrNull(model.expires_at),
    };
  });
}

function parseVersion(body: unknown): string {
  const version = stringOrNull(asObject(body).version);
  if (version === null) throw new BadResponse('/api/version has no version');
  return version;
}

function classify(error: unknown): { reason: ProbeFailure; detail: string } {
  const failure = error as Error & { cause?: { code?: string } };
  if (error instanceof BadResponse) return { reason: 'bad_response', detail: failure.message };
  if (failure.name === 'TimeoutError') return { reason: 'timeout', detail: failure.message };
  const code = failure.cause?.code;
  if (code === 'ECONNREFUSED') return { reason: 'refused', detail: code };
  return { reason: 'unreachable', detail: code ?? failure.message };
}

/** Asks the server directly, not through the proxy: it answers "is it up", not "is it busy". */
export async function probe(upstream: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const [version, models] = await Promise.all([
      getJson(new URL('/api/version', upstream), signal),
      getJson(new URL('/api/ps', upstream), signal),
    ]);
    return { reachable: true, version: parseVersion(version), models: parseModels(models) };
  } catch (error) {
    return { reachable: false, ...classify(error) };
  }
}
