/**
 * HealthServer.ts
 *
 * A lightweight HTTP server that exposes health, status, and metrics
 * endpoints for a distributed Node. Intended to run alongside the node
 * so that load balancers, orchestrators, and operators can probe
 * liveness and readiness without touching the cluster transport layer.
 */

import * as http from 'http';

export interface HealthInfo {
  status: string;
  nodeId: string;
  uptime: number;
  memberCount: number;
}

export interface StatusInfo {
  nodeId: string;
  members: Array<{ id: string; status: string }>;
  clusterHealth: any;
}

export interface MetricsInfo {
  nodeId: string;
  [key: string]: any;
}

export type HealthProvider = () => HealthInfo;
export type StatusProvider = () => StatusInfo;
export type MetricsProvider = () => MetricsInfo;

export class HealthServer {
  private server: http.Server | null = null;

  constructor(
    private port: number,
    private getHealth: HealthProvider,
    private getStatus: StatusProvider,
    private getMetrics: MetricsProvider,
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.url === '/health') {
        const health = this.getHealth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      } else if (req.url === '/status') {
        const status = this.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      } else if (req.url === '/metrics') {
        const metrics = this.getMetrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => this.server!.listen(this.port, resolve));
    // Update port to reflect actual bound port (useful when port 0 is passed)
    const addr = this.server!.address();
    if (addr && typeof addr !== 'string') {
      this.port = addr.port;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  getPort(): number {
    return this.port;
  }
}
