import * as crypto from 'crypto';
import * as tls from 'tls';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { MessageType } from '../../../src/types';

/**
 * Generate a self-signed certificate for testing.
 * Returns PEM-encoded key, cert, and CA cert (self-signed, so ca === cert).
 */
function generateSelfSignedCert(): { key: string; cert: string; ca: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // Use Node's built-in X509Certificate support to create a self-signed cert
  // We build a minimal CSR-like structure via createSign
  const name = 'CN=localhost';
  const cert = createSelfSignedCert(privateKey, publicKey, name);

  return { key: keyPem, cert, ca: cert };
}

/**
 * Create a minimal self-signed X.509 certificate using pure Node.js crypto.
 * This builds DER-encoded TBSCertificate, signs it, and wraps in PEM.
 */
function createSelfSignedCert(
  privateKey: crypto.KeyObject,
  publicKey: crypto.KeyObject,
  cn: string
): string {
  // Export the public key in DER (SubjectPublicKeyInfo) form
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // Build TBSCertificate
  const version = derExplicit(0, derInteger(Buffer.from([0x02]))); // v3
  const serialNumber = derInteger(Buffer.from([0x01]));
  // SHA-256 with RSA Encryption OID: 1.2.840.113549.1.1.11
  const signatureAlgorithm = derSequence([
    derOid(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
    derNull(),
  ]);
  const issuer = derSequence([
    derSet([
      derSequence([
        derOid(Buffer.from([0x55, 0x04, 0x03])), // OID for CN
        derUtf8String(cn.replace('CN=', '')),
      ]),
    ]),
  ]);
  // Valid for 1 day
  const now = new Date();
  const later = new Date(now.getTime() + 86400000);
  const validity = derSequence([derUtcTime(now), derUtcTime(later)]);
  const subject = issuer; // Self-signed: subject === issuer

  // SubjectAltName extension with DNS:localhost and IP:127.0.0.1
  const sanExtension = buildSanExtension();

  const extensions = derExplicit(3, derSequence([sanExtension]));

  const tbsCertificate = derSequence([
    version,
    serialNumber,
    signatureAlgorithm,
    issuer,
    validity,
    subject,
    spkiDer, // already a valid DER SEQUENCE
    extensions,
  ]);

  // Sign TBSCertificate
  const signer = crypto.createSign('SHA256');
  signer.update(tbsCertificate);
  const signature = signer.sign(privateKey);

  // Wrap signature in BIT STRING (prepend 0x00 for unused bits)
  const signatureBitString = Buffer.alloc(signature.length + 1);
  signatureBitString[0] = 0x00;
  signature.copy(signatureBitString, 1);

  const certificate = derSequence([
    tbsCertificate,
    signatureAlgorithm,
    derBitString(signatureBitString),
  ]);

  // PEM encode
  const b64 = certificate.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function buildSanExtension(): Buffer {
  // SubjectAltName OID: 2.5.29.17
  const sanOid = derOid(Buffer.from([0x55, 0x1d, 0x11]));
  // DNS:localhost = context-specific tag [2] (implicit)
  const dnsName = Buffer.from('localhost', 'ascii');
  const dnsEntry = Buffer.alloc(2 + dnsName.length);
  dnsEntry[0] = 0x82; // context [2]
  dnsEntry[1] = dnsName.length;
  dnsName.copy(dnsEntry, 2);

  // IP:127.0.0.1 = context-specific tag [7] (implicit)
  const ipBytes = Buffer.from([127, 0, 0, 1]);
  const ipEntry = Buffer.alloc(2 + ipBytes.length);
  ipEntry[0] = 0x87; // context [7]
  ipEntry[1] = ipBytes.length;
  ipBytes.copy(ipEntry, 2);

  const sanValue = derSequence([dnsEntry, ipEntry]);
  return derSequence([sanOid, derOctetString(sanValue)]);
}

// --- Minimal DER encoding helpers ---

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function derWrap(tag: number, content: Buffer): Buffer {
  const len = derLength(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function derSequence(items: Buffer[]): Buffer {
  return derWrap(0x30, Buffer.concat(items));
}

function derSet(items: Buffer[]): Buffer {
  return derWrap(0x31, Buffer.concat(items));
}

function derInteger(value: Buffer): Buffer {
  // Ensure positive by prepending 0x00 if high bit is set
  if (value[0] & 0x80) {
    value = Buffer.concat([Buffer.from([0x00]), value]);
  }
  return derWrap(0x02, value);
}

function derBitString(content: Buffer): Buffer {
  return derWrap(0x03, content);
}

function derOctetString(content: Buffer): Buffer {
  return derWrap(0x04, content);
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derOid(content: Buffer): Buffer {
  return derWrap(0x06, content);
}

function derUtf8String(str: string): Buffer {
  return derWrap(0x0c, Buffer.from(str, 'utf8'));
}

function derUtcTime(date: Date): Buffer {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const str =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return derWrap(0x17, Buffer.from(str, 'ascii'));
}

function derExplicit(tag: number, content: Buffer): Buffer {
  return derWrap(0xa0 | tag, content);
}

// --- Tests ---

describe('TCPAdapter TLS', () => {
  let certs: { key: string; cert: string; ca: string };
  let serverAdapter: TCPAdapter;
  let clientAdapter: TCPAdapter;

  beforeAll(() => {
    certs = generateSelfSignedCert();
  });

  afterEach(async () => {
    // Clean up both adapters
    if (clientAdapter?.getStats().isStarted) {
      await clientAdapter.stop();
    }
    if (serverAdapter?.getStats().isStarted) {
      await serverAdapter.stop();
    }
  });

  it('should create a TLS-enabled adapter instance', () => {
    const adapter = new TCPAdapter(
      { id: 'node-tls', address: '127.0.0.1', port: 9100 },
      {
        port: 9100,
        enableLogging: false,
        tls: {
          enabled: true,
          key: certs.key,
          cert: certs.cert,
          ca: certs.ca,
        },
      }
    );
    expect(adapter).toBeDefined();
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.send).toBe('function');
  });

  it('should start and stop a TLS-enabled server', async () => {
    serverAdapter = new TCPAdapter(
      { id: 'node-tls-server', address: '127.0.0.1', port: 9101 },
      {
        port: 9101,
        enableLogging: false,
        maxRetries: 1,
        baseRetryDelay: 100,
        tls: {
          enabled: true,
          key: certs.key,
          cert: certs.cert,
          ca: certs.ca,
          rejectUnauthorized: false,
        },
      }
    );

    await serverAdapter.start();
    expect(serverAdapter.getStats().isStarted).toBe(true);

    await serverAdapter.stop();
    expect(serverAdapter.getStats().isStarted).toBe(false);
  }, 10000);

  it('should send and receive a message over TLS', async () => {
    const serverPort = 9102;

    serverAdapter = new TCPAdapter(
      { id: 'tls-server', address: '127.0.0.1', port: serverPort },
      {
        port: serverPort,
        enableLogging: false,
        maxRetries: 1,
        baseRetryDelay: 100,
        tls: {
          enabled: true,
          key: certs.key,
          cert: certs.cert,
          ca: certs.ca,
          rejectUnauthorized: false,
        },
      }
    );

    await serverAdapter.start();

    const receivedMessages: any[] = [];
    serverAdapter.onMessage((msg) => {
      receivedMessages.push(msg);
    });

    clientAdapter = new TCPAdapter(
      { id: 'tls-client', address: '127.0.0.1', port: 9103 },
      {
        port: 9103,
        enableLogging: false,
        maxRetries: 1,
        baseRetryDelay: 100,
        tls: {
          enabled: true,
          key: certs.key,
          cert: certs.cert,
          ca: certs.ca,
          rejectUnauthorized: false,
        },
      }
    );

    await clientAdapter.start();

    const testMessage = {
      id: 'msg-tls-1',
      type: MessageType.PING,
      data: { hello: 'secure world' },
      sender: { id: 'tls-client', address: '127.0.0.1', port: 9103 },
      timestamp: Date.now(),
    };

    await clientAdapter.send(testMessage, {
      id: 'tls-server',
      address: '127.0.0.1',
      port: serverPort,
    });

    // Wait for the message to arrive
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedMessages.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Timeout safety
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 5000);
    });

    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].id).toBe('msg-tls-1');
    expect(receivedMessages[0].data).toEqual({ hello: 'secure world' });
  }, 15000);

  it('should still work without TLS (default behavior unchanged)', () => {
    const adapter = new TCPAdapter(
      { id: 'node-plain', address: '127.0.0.1', port: 9104 },
      {
        port: 9104,
        enableLogging: false,
      }
    );
    expect(adapter).toBeDefined();
    // No TLS options = plain TCP, this should not throw
  });

  it('should accept a raw TLS client connection on the server', async () => {
    const serverPort = 9105;

    serverAdapter = new TCPAdapter(
      { id: 'tls-raw-server', address: '127.0.0.1', port: serverPort },
      {
        port: serverPort,
        enableLogging: false,
        maxRetries: 1,
        baseRetryDelay: 100,
        tls: {
          enabled: true,
          key: certs.key,
          cert: certs.cert,
          ca: certs.ca,
          rejectUnauthorized: false,
        },
      }
    );

    await serverAdapter.start();

    // Connect with a raw TLS client to verify the server is indeed TLS
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const sock = tls.connect(
        {
          host: '127.0.0.1',
          port: serverPort,
          ca: [certs.ca],
          rejectUnauthorized: false,
        },
        () => {
          resolve(sock);
        }
      );
      sock.on('error', reject);
    });

    expect(socket.encrypted).toBe(true);
    socket.destroy();
  }, 10000);
});
