export class RemoteError extends Error {
  constructor(public service: string, public status: number, public retryAfter?: number) {
    super(`${service}: HTTP ${status}`);
  }
}
export async function requestJson(url: string, service: string, init: RequestInit = {}, timeout = 30_000): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error(`${service}: connection failed or timed out`); }
  if (!response.ok) throw new RemoteError(service, response.status, Number(response.headers.get('retry-after')) || undefined);
  try { return await response.json(); }
  catch { throw new Error(`${service}: invalid JSON response`); }
}
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
export function errorCode(error: unknown): string {
  if (error instanceof RemoteError) return `${error.service}_http_${error.status}`;
  return error instanceof Error ? error.name : 'UnknownError';
}
