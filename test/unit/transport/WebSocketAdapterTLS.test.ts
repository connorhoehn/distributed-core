import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the CircuitBreaker and RetryManager
jest.mock('../../../src/transport/CircuitBreaker', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn) => fn()),
    destroy: jest.fn(),
    on: jest.fn()
  }))
}));

jest.mock('../../../src/transport/RetryManager', () => ({
  RetryManager: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn) => fn()),
    destroy: jest.fn()
  }))
}));

describe('WebSocketAdapter TLS', () => {
  let certDir: string;
  let key: Buffer;
  let cert: Buffer;

  beforeAll(() => {
    // Generate self-signed certs in a temp directory
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tls-test-'));
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');

    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" 2>/dev/null`
    );

    key = fs.readFileSync(keyPath);
    cert = fs.readFileSync(certPath);
  });

  afterAll(() => {
    // Clean up temp certs
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  describe('Constructor with TLS', () => {
    test('should create adapter with TLS options', () => {
      const adapter = new WebSocketAdapter(
        { id: 'node-tls', address: '127.0.0.1', port: 9100 },
        { port: 0, enableLogging: false, tls: { enabled: true, key, cert } }
      );
      expect(adapter).toBeInstanceOf(WebSocketAdapter);
    });

    test('should create adapter with TLS disabled by default', () => {
      const adapter = new WebSocketAdapter(
        { id: 'node-no-tls', address: '127.0.0.1', port: 9101 },
        { port: 0, enableLogging: false }
      );
      expect(adapter).toBeInstanceOf(WebSocketAdapter);
    });
  });

  describe('TLS Server Lifecycle', () => {
    let server: WebSocketAdapter;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    test('should start and stop with TLS enabled', async () => {
      server = new WebSocketAdapter(
        { id: 'tls-server', address: '127.0.0.1', port: 0 },
        { port: 0, enableLogging: false, tls: { enabled: true, key, cert } }
      );

      await server.start();
      const stats = server.getStats();
      expect(stats.isStarted).toBe(true);
      expect(stats.port).toBeGreaterThan(0);

      await server.stop();
      expect(server.getStats().isStarted).toBe(false);
    });
  });

  describe('TLS Client-Server Communication', () => {
    let serverAdapter: WebSocketAdapter;
    let clientAdapter: WebSocketAdapter;

    afterEach(async () => {
      if (clientAdapter) await clientAdapter.stop().catch(() => {});
      if (serverAdapter) await serverAdapter.stop().catch(() => {});
    });

    test('should connect client to TLS server', async () => {
      // Start a TLS server
      serverAdapter = new WebSocketAdapter(
        { id: 'tls-srv', address: '127.0.0.1', port: 0 },
        { port: 0, enableLogging: false, tls: { enabled: true, key, cert } }
      );
      await serverAdapter.start();
      const serverPort = serverAdapter.getStats().port;

      // Create a TLS client that trusts the self-signed cert
      clientAdapter = new WebSocketAdapter(
        { id: 'tls-client', address: '127.0.0.1', port: 0 },
        { port: 0, enableLogging: false, tls: { enabled: true, key, cert, ca: cert } }
      );
      await clientAdapter.start();

      // Connect client to server
      const serverNodeId = { id: 'tls-srv', address: '127.0.0.1', port: serverPort };

      // Wait for connection-received event on server
      const connectionPromise = new Promise<void>((resolve) => {
        serverAdapter.on('connection-received', () => resolve());
      });

      await clientAdapter.connect(serverNodeId);
      await connectionPromise;

      // Verify the client has an active connection
      const connectedNodes = clientAdapter.getConnectedNodes();
      expect(connectedNodes.length).toBe(1);
      expect(connectedNodes[0].id).toBe('tls-srv');
    });

    test('should reject connection when CA does not match', async () => {
      // Start a TLS server
      serverAdapter = new WebSocketAdapter(
        { id: 'tls-srv2', address: '127.0.0.1', port: 0 },
        { port: 0, enableLogging: false, tls: { enabled: true, key, cert } }
      );
      await serverAdapter.start();
      const serverPort = serverAdapter.getStats().port;

      // Generate a different self-signed cert to use as CA (will not match)
      const wrongCaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tls-wrong-'));
      const wrongKeyPath = path.join(wrongCaDir, 'key.pem');
      const wrongCertPath = path.join(wrongCaDir, 'cert.pem');
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${wrongKeyPath}" -out "${wrongCertPath}" ` +
        `-days 1 -nodes -subj "/CN=wrong" 2>/dev/null`
      );
      const wrongCa = fs.readFileSync(wrongCertPath);
      fs.rmSync(wrongCaDir, { recursive: true, force: true });

      // Client with wrong CA should fail to connect
      clientAdapter = new WebSocketAdapter(
        { id: 'tls-client2', address: '127.0.0.1', port: 0 },
        { port: 0, enableLogging: false, tls: { enabled: true, ca: wrongCa } }
      );
      await clientAdapter.start();

      const serverNodeId = { id: 'tls-srv2', address: '127.0.0.1', port: serverPort };
      await expect(clientAdapter.connect(serverNodeId)).rejects.toThrow();
    });
  });
});
