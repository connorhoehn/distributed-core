import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { ResourceRouter } from './ResourceRouter';
import { LifecycleAware } from '../common/LifecycleAware';

export interface ForwardingServerConfig {
  port: number;
  host?: string;
  pathPrefix?: string;
}

export type ForwardingHandler = (
  resourceId: string,
  path: string,
  payload: unknown
) => Promise<unknown>;

export class ForwardingServer implements LifecycleAware {
  private readonly router: ResourceRouter;
  private readonly handler: ForwardingHandler;
  private readonly port: number;
  private readonly host: string;
  private readonly pathPrefix: string;
  private server: Server | null = null;

  constructor(
    router: ResourceRouter,
    handler: ForwardingHandler,
    config: ForwardingServerConfig
  ) {
    this.router = router;
    this.handler = handler;
    this.port = config.port;
    this.host = config.host ?? '0.0.0.0';
    this.pathPrefix = config.pathPrefix ?? '/forward';
  }

  async start(): Promise<void> {
    if (this.server !== null) return;

    this.server = createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        this._send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => resolve());
      this.server!.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  isStarted(): boolean {
    return this.server !== null;
  }

  getAddress(): { address: string; port: number } | null {
    if (this.server === null) return null;
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') return null;
    return { address: addr.address, port: addr.port };
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this._send(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    const url = req.url ?? '';
    if (!url.startsWith(this.pathPrefix)) {
      this._send(res, 404, { error: 'Not Found' });
      return;
    }

    const afterPrefix = url.slice(this.pathPrefix.length);
    const withoutLeadingSlash = afterPrefix.startsWith('/') ? afterPrefix.slice(1) : afterPrefix;

    const slashIndex = withoutLeadingSlash.indexOf('/');
    let resourceId: string;
    let remainder: string;
    if (slashIndex === -1) {
      resourceId = withoutLeadingSlash;
      remainder = '';
    } else {
      resourceId = withoutLeadingSlash.slice(0, slashIndex);
      remainder = withoutLeadingSlash.slice(slashIndex);
    }

    if (resourceId === '') {
      this._send(res, 404, { error: 'Not Found' });
      return;
    }

    let payload: unknown;
    try {
      payload = await this._readBody(req);
    } catch {
      this._send(res, 400, { error: 'Malformed JSON body' });
      return;
    }

    const isLocal = this.router.isLocal(resourceId);

    if (!isLocal) {
      const target = await this.router.route(resourceId);
      if (target === null) {
        this._send(res, 404, { error: `No route for resource "${resourceId}"` });
        return;
      }
      this._send(res, 421, { owner: { address: target.address, port: target.port } });
      return;
    }

    let result: unknown;
    try {
      result = await this.handler(resourceId, remainder, payload);
    } catch (err) {
      this._send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    this._send(res, 200, result);
  }

  private _readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Malformed JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private _send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}
