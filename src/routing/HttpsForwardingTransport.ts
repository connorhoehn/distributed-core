import { Agent as HttpsAgent, type AgentOptions } from 'https';
import type { ForwardingTransport } from './ForwardingRouter';
import { MisdirectedError, TimeoutError } from './HttpForwardingTransport';
import type { RouteTarget } from './types';

export type { MisdirectedError, TimeoutError };

export interface HttpsForwardingTransportConfig {
  /** Client TLS options — cert, key, ca, rejectUnauthorized, etc. */
  tlsOptions?: AgentOptions;
  /** Optional request headers applied to every outbound call. */
  headers?: Record<string, string>;
  /** Override fetch for tests. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Wire protocol: POST https://{address}:{port}{path}
 *
 * Same semantics as HttpForwardingTransport but over TLS.
 * Uses a shared HttpsAgent for connection pooling and mutual-TLS / CA-pinning
 * configured via tlsOptions.
 */
export class HttpsForwardingTransport implements ForwardingTransport {
  private readonly agent: HttpsAgent;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config?: HttpsForwardingTransportConfig) {
    this.agent = new HttpsAgent(config?.tlsOptions ?? {});
    this.headers = config?.headers ?? {};
    this.fetchImpl = config?.fetchImpl ?? fetch;
  }

  async call(
    target: RouteTarget,
    path: string,
    payload: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const url = `https://${target.address}:${target.port}${path}`;
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
        // Node's built-in fetch supports an agent option for https connections
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(({ agent: this.agent } as unknown) as Record<string, unknown>),
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

  /** Expose the underlying agent so callers / tests can inspect TLS options. */
  getAgent(): HttpsAgent {
    return this.agent;
  }
}
