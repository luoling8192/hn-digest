import { RemoteHttpError } from './errors.js';

export interface JsonHttpClient {
  request(url: string, service: string, init?: RequestInit, timeoutMs?: number): Promise<unknown>;
}

export class FetchJsonHttpClient implements JsonHttpClient {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async request(
    url: string,
    service: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`${service}: connection failed or timed out`, { cause: error });
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      throw new RemoteHttpError(
        service,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`${service}: invalid JSON response`, { cause: error });
    }
  }
}
