import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';

/**
 * HTTP transport adapter for request-response communication
 * Compatible with REST APIs and systems without persistent connections
 */
export class HTTPAdapter extends Transport {
  private nodeId: NodeId;
  private server: any; // http.Server (stub)
  private isStarted = false;
  private pendingRequests = new Map<string, any>();
  private endpoints = new Set<string>();
  private static adapterRegistry = new Map<string, HTTPAdapter>();

  constructor(nodeId: NodeId, private port: number = 3000) {
    super();
    this.nodeId = nodeId;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Stub: In real implementation, would use Node.js 'http' module
    // const http = require('http');
    // this.server = http.createServer((req, res) => {
    //   this.handleRequest(req, res);
    // });
    // this.server.listen(this.port);

    HTTPAdapter.adapterRegistry.set(this.nodeId.id, this);
    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Cancel pending requests
    for (const [id, request] of this.pendingRequests) {
      if (request.resolve) {
        setTimeout(() => {
          const error = new Error(`Request ${id} timed out`);
          // request.reject could be called here if it existed
        }, 0);
      }
    }
    this.pendingRequests.clear();

    // Close server
    if (this.server) {
      // this.server.close();
      this.server = null;
    }

    HTTPAdapter.adapterRegistry.delete(this.nodeId.id);
    this.isStarted = false;
    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('HTTP server not started');
    }

    // Add to endpoints we've contacted
    this.endpoints.add(target.id);

    // Simulate message delivery to target adapter
    const targetAdapter = HTTPAdapter.adapterRegistry.get(target.id);
    if (targetAdapter) {
      setTimeout(() => {
        targetAdapter.emit('message', message);
      }, 1);
    }

    // Stub: In real implementation would make HTTP POST request
    // const http = require('http');
    // const data = JSON.stringify(message);
    // const options = {
    //   hostname: target.address,
    //   port: target.port,
    //   path: '/message',
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Content-Length': data.length
    //   }
    // };

    const requestId = `${target.id}-${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      // Mock HTTP request
      const mockRequest = {
        id: requestId,
        target: target.id,
        message,
        timestamp: Date.now()
      };
      
      this.pendingRequests.set(requestId, mockRequest);
      
      // Simulate async HTTP request
      setTimeout(() => {
        this.pendingRequests.delete(requestId);
        // Simulate success (stub)
        resolve();
      }, 10);
    });
  }

  async sendWithResponse(message: Message, target: NodeId, timeoutMs: number = 5000): Promise<Message> {
    if (!this.isStarted) {
      throw new Error('HTTP server not started');
    }

    const requestId = message.id;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out`));
      }, timeoutMs);

      const mockRequest = {
        id: requestId,
        target: target.id,
        message,
        timestamp: Date.now(),
        resolve: (response: Message) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          resolve(response);
        }
      };
      
      this.pendingRequests.set(requestId, mockRequest);
      this.emit('request', message, target);
      
      // Simulate message delivery to target
      setTimeout(() => {
        this.emit('message', message);
      }, 1);
    });
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  getEndpoint(): string {
    return `http://${this.nodeId.address}:${this.port}`;
  }

  /**
   * Handle incoming HTTP request (stub)
   */
  private handleRequest(req: any, res: any): void {
    // Stub: In real implementation would parse request and emit message
    // if (req.method === 'POST' && req.url === '/message') {
    //   let body = '';
    //   req.on('data', (chunk) => body += chunk);
    //   req.on('end', () => {
    //     const message = JSON.parse(body);
    //     this.emit('message', message);
    //     res.writeHead(200, { 'Content-Type': 'application/json' });
    //     res.end(JSON.stringify({ status: 'received' }));
    //   });
    // }
  }

  onMessage(callback: (message: Message) => void): void {
    this.on('message', callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.removeListener('message', callback);
  }

  getConnectedNodes(): NodeId[] {
    // Return nodes we've made requests to
    return Array.from(this.endpoints).map(id => ({
      id,
      address: 'localhost', // Stub
      port: this.port
    }));
  }

  sendResponse(requestId: string, response: Message): void {
    // Find the pending request and resolve it
    const pendingRequest = this.pendingRequests.get(requestId);
    if (pendingRequest && pendingRequest.resolve) {
      pendingRequest.resolve(response);
    }
    this.emit('response', response);
  }
}
