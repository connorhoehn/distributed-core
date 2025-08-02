import * as http from 'http';
import * as https from 'https';
import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';
import { CircuitBreaker } from '../CircuitBreaker';
import { RetryManager } from '../RetryManager';

export interface HTTPAdapterConfig {
  port?: number;
  host?: string;
  useHttps?: boolean;
  cors?: boolean;
  timeout?: number;
  maxConnections?: number;
  keepAliveTimeout?: number;
  headersTimeout?: number;
  requestTimeout?: number;
  enableLogging?: boolean;
}

export class HTTPAdapter extends Transport {
  private readonly config: Required<HTTPAdapterConfig>;
  private server: http.Server | https.Server | null = null;
  private agents = new Map<string, http.Agent | https.Agent>();
  private isRunning = false;
  private messageHandler?: (message: Message) => void;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private stats = {
    messagesReceived: 0,
    messagesSent: 0,
    requestsHandled: 0,
    errors: 0
  };

  constructor(
    private readonly nodeId: NodeId,
    config: HTTPAdapterConfig = {}
  ) {
    super();
    
    this.config = {
      port: config.port ?? nodeId.port,
      host: config.host ?? nodeId.address,
      useHttps: config.useHttps ?? false,
      cors: config.cors ?? true,
      timeout: config.timeout ?? 5000,
      maxConnections: config.maxConnections ?? 100,
      keepAliveTimeout: config.keepAliveTimeout ?? 5000,
      headersTimeout: config.headersTimeout ?? 10000,
      requestTimeout: config.requestTimeout ?? 30000,
      enableLogging: config.enableLogging ?? true
    };

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
      timeout: this.config.timeout,
      enableLogging: this.config.enableLogging
    });

    this.retryManager = new RetryManager({
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
      enableLogging: this.config.enableLogging
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('HTTP adapter is already running');
    }

    try {
      if (this.config.useHttps) {
        this.server = https.createServer(this.handleRequest.bind(this));
      } else {
        this.server = http.createServer(this.handleRequest.bind(this));
      }

      this.server.keepAliveTimeout = this.config.keepAliveTimeout;
      this.server.headersTimeout = this.config.headersTimeout;
      this.server.requestTimeout = this.config.requestTimeout;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('HTTP server start timeout'));
        }, 5000);

        this.server!.listen(this.config.port, this.config.host, () => {
          clearTimeout(timeout);
          this.isRunning = true;
          resolve();
        });

        this.server!.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.emit('started', { port: this.config.port, host: this.config.host });

    } catch (error) {
      this.isRunning = false;
      this.stats.errors++;
      throw new Error(`Failed to start HTTP adapter: ${error}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Close all agents
    this.agents.forEach(agent => {
      agent.destroy();
    });
    this.agents.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
      this.server = null;
    }

    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isRunning) {
      throw new Error('HTTP adapter is not running');
    }

    const agent = this.getAgent(target);
    const protocol = this.config.useHttps ? https : http;
    
    const postData = JSON.stringify(message);
    
    const options = {
      hostname: target.address,
      port: target.port,
      path: '/gossip/message',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-Node-Id': this.nodeId.id
      },
      agent,
      timeout: this.config.timeout
    };

    return new Promise((resolve, reject) => {
      const req = protocol.request(options, (res) => {
        let responseBody = '';
        
        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            this.stats.messagesSent++;
            resolve();
          } else {
            this.stats.errors++;
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', (error) => {
        this.stats.errors++;
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        this.stats.errors++;
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  onMessage(handler: (message: Message) => void): void {
    this.messageHandler = handler;
  }

  removeMessageListener(callback: (message: Message) => void): void {
    if (this.messageHandler === callback) {
      this.messageHandler = undefined;
    }
  }

  getConnectedNodes(): NodeId[] {
    // HTTP is stateless, so we return the nodes we have agents for
    return Array.from(this.agents.keys()).map(key => {
      const parts = key.split(':');
      return {
        id: parts[0],
        address: parts[1],
        port: parseInt(parts[2])
      };
    });
  }

  getStats() {
    return {
      isStarted: this.isRunning,
      host: this.config.host,
      port: this.config.port,
      secure: this.config.useHttps,
      cors: this.config.cors,
      activeAgents: this.agents.size,
      requestsHandled: this.stats.requestsHandled,
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      errors: this.stats.errors,
      circuitBreakerState: this.circuitBreaker.getState(),
      timeout: this.config.timeout
    };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.stats.requestsHandled++;

    // CORS headers
    if (this.config.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Node-Id');
    }

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);

    try {
      switch (url.pathname) {
        case '/gossip/message':
          this.handleGossipMessage(req, res);
          break;
        case '/gossip/health':
          this.handleHealthCheck(req, res);
          break;
        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      this.stats.errors++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private handleGossipMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const message: Message = JSON.parse(body);
        
        if (this.messageHandler) {
          this.stats.messagesReceived++;
          this.messageHandler(message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          nodeId: this.nodeId.id,
          timestamp: Date.now()
        }));

      } catch (error) {
        this.stats.errors++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    req.on('error', (error) => {
      this.stats.errors++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request error' }));
    });
  }

  private handleHealthCheck(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      nodeId: this.nodeId.id,
      timestamp: Date.now(),
      uptime: process.uptime(),
      stats: this.getStats()
    }));
  }

  private getAgent(target: NodeId): http.Agent | https.Agent {
    const key = `${target.id}:${target.address}:${target.port}`;
    
    if (!this.agents.has(key)) {
      const AgentClass = this.config.useHttps ? https.Agent : http.Agent;
      const agent = new AgentClass({
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: this.config.timeout,
        keepAliveMsecs: this.config.keepAliveTimeout
      });
      
      this.agents.set(key, agent);
    }

    return this.agents.get(key)!;
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[HTTPAdapter:${this.nodeId.id}] ${message}`);
    }
  }
}
