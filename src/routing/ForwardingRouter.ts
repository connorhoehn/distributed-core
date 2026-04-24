import { ResourceRouter } from './ResourceRouter';
import { RouteTarget } from './types';

export interface ForwardingTransport {
  call(
    target: RouteTarget,
    path: string,
    payload: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>;
}

export class LocalResourceError extends Error {
  constructor(public readonly resourceId: string) {
    super(`Resource "${resourceId}" is owned by the local node — caller should handle it directly`);
    this.name = 'LocalResourceError';
  }
}

export class UnroutableResourceError extends Error {
  constructor(public readonly resourceId: string) {
    super(`No route found for resource "${resourceId}"`);
    this.name = 'UnroutableResourceError';
  }
}

export interface ForwardingRouterConfig {
  timeoutMs?: number;
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 1;

export class ForwardingRouter {
  private readonly router: ResourceRouter;
  private readonly transport: ForwardingTransport;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(
    router: ResourceRouter,
    transport: ForwardingTransport,
    config?: ForwardingRouterConfig
  ) {
    this.router = router;
    this.transport = transport;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = config?.retries ?? DEFAULT_RETRIES;
  }

  async call(resourceId: string, path: string, payload: unknown): Promise<unknown> {
    let attemptsLeft = this.retries + 1;

    while (attemptsLeft > 0) {
      attemptsLeft--;

      const target = await this.router.route(resourceId);

      if (target === null) {
        throw new UnroutableResourceError(resourceId);
      }

      if (target.isLocal) {
        throw new LocalResourceError(resourceId);
      }

      try {
        return await this.transport.call(target, path, payload, { timeoutMs: this.timeoutMs });
      } catch (err) {
        if (isMisdirectedError(err) && attemptsLeft > 0) {
          continue;
        }
        throw err;
      }
    }

    throw new UnroutableResourceError(resourceId);
  }
}

function isMisdirectedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'MisdirectedError' ||
      err.constructor?.name === 'MisdirectedError')
  );
}
