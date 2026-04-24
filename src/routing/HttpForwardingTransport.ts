import { ForwardingTransport } from './ForwardingRouter';
import { RouteTarget } from './types';

export class MisdirectedError extends Error {
  constructor(public readonly owner?: { address: string; port: number }) {
    super(`Target node returned 421 MISDIRECTED — it no longer owns the resource`);
    this.name = 'MisdirectedError';
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Forwarded call timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export interface HttpForwardingTransportConfig {
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * Wire protocol: POST http://{address}:{port}{path}
 * The path is passed through as-is; callers include the resourceId in the path
 * by convention (e.g. /forward/room-42/join).
 *
 * Non-JSON 2xx bodies: response.json() will throw a SyntaxError — callers
 * should catch this if they may receive non-JSON payloads.
 */
export class HttpForwardingTransport implements ForwardingTransport {
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config?: HttpForwardingTransportConfig) {
    this.headers = config?.headers ?? {};
    this.fetchImpl = config?.fetchImpl ?? fetch;
  }

  async call(
    target: RouteTarget,
    path: string,
    payload: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const url = `http://${target.address}:${target.port}${path}`;
    const timeoutMs = options?.timeoutMs;
    const controller = new AbortController();

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError(timeoutMs!);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (response.status === 421) {
      let owner: { address: string; port: number } | undefined;
      try {
        const body = await response.json() as { owner?: { address: string; port: number } };
        owner = body.owner;
      } catch {
        // body is not JSON — owner stays undefined
      }
      throw new MisdirectedError(owner);
    }

    if (response.status >= 200 && response.status < 300) {
      return response.json();
    }

    const body = await response.text();
    throw new Error(`Forwarded call failed: HTTP ${response.status} — ${body}`);
  }
}
