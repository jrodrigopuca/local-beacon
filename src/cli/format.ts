import type { StatusSnapshot } from '../core/control.ts';
import type { RequestView } from '../core/state.ts';

/** What people and agents get for a request: the facts, without the proxy's bookkeeping. */
export interface RequestRow {
  id: string;
  state: string;
  model: string | null;
  path: string;
  ageMs: number;
  silentForMs: number | null;
  ahead: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  truncation: string;
  truncationReason: string | null;
  errorCode: string | null;
}

export function toRow(view: RequestView, now: number): RequestRow {
  return {
    id: view.id,
    state: view.state,
    model: view.model,
    path: view.path,
    ageMs: (view.endedAt ?? now) - view.startedAt,
    silentForMs: view.silentForMs,
    ahead: view.ahead,
    promptTokens: view.usage?.promptTokens ?? null,
    cachedTokens: view.usage?.cachedTokens ?? null,
    outputTokens: view.usage?.outputTokens ?? null,
    tokensPerSecond: view.usage?.tokensPerSecond ?? null,
    truncation: view.truncation.verdict,
    truncationReason: view.truncation.reason,
    errorCode: view.errorCode,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function gigabytes(bytes: number | null): string {
  return bytes === null ? '-' : `${(bytes / 1e9).toFixed(1)} GB`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function formatStatus(snapshot: StatusSnapshot): string {
  const { server, probe } = snapshot;
  if (!probe.reachable) {
    const lines = [`server  ${server}`, `probe   ${probe.reason} (${probe.detail})`];
    if (probe.reason === 'bad_response') lines.push('note    something answers there, but not like ollama: loaded models are unknown');
    return lines.join('\n');
  }

  const lines = [`server  ${server}`, `ollama  ${probe.version}`];
  if (probe.models.length === 0) return [...lines, 'models  none loaded'].join('\n');
  const rows = probe.models.map((model) => [
    model.name,
    model.runner ?? '-',
    model.contextLength === null ? '-' : String(model.contextLength),
    gigabytes(model.sizeVram),
  ]);
  return [...lines, '', table(['MODEL', 'RUNNER', 'CONTEXT', 'MEMORY'], rows)].join('\n');
}

function detail(row: RequestRow): string {
  if (row.state === 'waiting' && row.ahead > 0) return `${row.ahead} ahead`;
  if (row.state === 'stalled' && row.silentForMs !== null) return `silent ${seconds(row.silentForMs)}`;
  if (row.errorCode !== null) return row.errorCode;
  return '';
}

function tokens(row: RequestRow): string {
  if (row.promptTokens === null) return '-';
  return `${row.promptTokens}/${row.outputTokens ?? '-'}`;
}

export function formatRequests(rows: RequestRow[], total = rows.length): string {
  if (rows.length === 0) return 'no requests yet';
  const shown = total > rows.length ? `\n\nshowing the last ${rows.length} of ${total}; --limit shows more` : '';
  const body = rows.map((row) => [
    row.id,
    row.state,
    row.model ?? '-',
    seconds(row.ageMs),
    tokens(row),
    row.tokensPerSecond === null ? '-' : row.tokensPerSecond.toFixed(1),
    detail(row),
  ]);
  const output = table(['ID', 'STATE', 'MODEL', 'AGE', 'IN/OUT', 'TOK/S', ''], body);
  const truncated = rows.filter((row) => row.truncation === 'likely');
  if (truncated.length === 0) return `${output}${shown}`;
  const warnings = truncated.map(
    (row) => `warning: ${row.id} was probably truncated (${row.promptTokens} tokens reached the model)`,
  );
  return `${output}${shown}\n\n${warnings.join('\n')}`;
}
