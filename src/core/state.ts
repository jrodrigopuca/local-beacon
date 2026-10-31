import type { LoadedModel } from './ollama.ts';
import type { RequestRecord } from './proxy.ts';
import { detectTruncation, type TruncationResult } from './truncation.ts';

export type RequestState = 'waiting' | 'generating' | 'stalled' | 'done' | 'cancelled' | 'failed';
export type ServerState = 'down' | 'idle' | 'busy';

export interface RequestView extends RequestRecord {
  state: RequestState;
  /**
   * Earlier in-flight requests when this one is waiting, otherwise 0. A hint, not a
   * queue position: ollama does not expose its queue, and requests for different
   * models, or within OLLAMA_NUM_PARALLEL, do not wait for each other.
   */
  ahead: number;
  /** Time since the last byte while the response is open, otherwise null. */
  silentForMs: number | null;
  truncation: TruncationResult;
}

export interface StateOptions {
  stallAfterMs?: number;
  /** Latest probe result. Sharpens truncation detection while the model stays loaded. */
  models?: LoadedModel[];
}

// Provisional, my own judgment, not measured: the slowest model so far generated
// 10.7 tok/s, so a gap this long is far from normal pacing. Tool-call streaming may
// pause longer, which is why it stays a parameter.
export const DEFAULT_STALL_AFTER_MS = 30_000;

// Cheap reads. Anything else counts as work, so an unknown route can only make the
// server look busier than it is, never idle while it is working.
const READ_ONLY_ROUTES = new Set(['/', '/api/version', '/api/ps', '/api/tags', '/api/show', '/v1/models']);

function isWork(record: RequestRecord): boolean {
  return !READ_ONLY_ROUTES.has(record.path.split('?')[0] ?? record.path);
}

function requestState(record: RequestRecord, now: number, stallAfterMs: number): RequestState {
  switch (record.outcome) {
    case 'client_disconnected':
      return 'cancelled';
    case 'upstream_error':
      return 'failed';
    case 'done':
      return record.status !== null && record.status >= 400 ? 'failed' : 'done';
    case 'in_flight':
      if (record.lastByteAt === null) return 'waiting';
      return now - record.lastByteAt > stallAfterMs ? 'stalled' : 'generating';
  }
}

/** Derives each request's state. `records` must be in arrival order, as `requests()` returns them. */
export function viewRequests(records: RequestRecord[], now: number, options: StateOptions = {}): RequestView[] {
  const stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  let inFlightWork = 0;
  return records.map((record) => {
    const state = requestState(record, now, stallAfterMs);
    const work = record.outcome === 'in_flight' && isWork(record);
    const loaded = options.models?.find((model) => model.name === record.model);
    const view: RequestView = {
      ...record,
      state,
      ahead: state === 'waiting' && work ? inFlightWork : 0,
      silentForMs: record.outcome === 'in_flight' && record.lastByteAt !== null ? now - record.lastByteAt : null,
      truncation: detectTruncation({
        promptChars: record.promptChars,
        promptTokens: record.usage?.promptTokens ?? null,
        contextLength: loaded?.contextLength ?? null,
        runner: loaded?.runner ?? null,
      }),
    };
    if (work) inFlightWork += 1;
    return view;
  });
}

/** Tokens arriving prove the server is alive, so they outrank a failed probe. */
export function serverState(reachable: boolean, views: RequestView[]): ServerState {
  const work = views.filter((view) => view.outcome === 'in_flight' && isWork(view));
  if (work.some((view) => view.state === 'generating')) return 'busy';
  if (!reachable) return 'down';
  return work.length > 0 ? 'busy' : 'idle';
}
