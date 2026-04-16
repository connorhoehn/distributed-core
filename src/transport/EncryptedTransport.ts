import { Transport } from './Transport';
import { Encryption, EncryptionOptions, EncryptedData } from './Encryption';
import { NodeId, Message, EncryptionConfig } from '../types';

/**
 * Wraps any Transport to provide transparent encrypt-on-send and decrypt-on-receive.
 * The underlying Encryption class handles AES-256-GCM / ChaCha20-Poly1305 with key rotation.
 */
export class EncryptedTransport extends Transport {
  private readonly inner: Transport;
  private readonly encryption: Encryption;
  private readonly messageListenerMap = new Map<
    (message: Message) => void,
    (message: Message) => void
  >();

  constructor(inner: Transport, encryption: Encryption) {
    super();
    this.inner = inner;
    this.encryption = encryption;
  }

  /**
   * Create an EncryptedTransport from a plain transport and encryption config.
   * The returned transport is ready to use after the promise resolves.
   */
  static async wrapTransport(
    transport: Transport,
    encryptionConfig: EncryptionConfig
  ): Promise<EncryptedTransport> {
    const encryption = new Encryption({
      algorithm: (encryptionConfig.algorithm as EncryptionOptions['algorithm']) || 'aes-256-gcm',
      keySize: encryptionConfig.keySize || 32,
      enableKeyRotation: false, // caller can opt in later
    });
    await encryption.initialize();
    return new EncryptedTransport(transport, encryption);
  }

  async start(): Promise<void> {
    return this.inner.start();
  }

  async stop(): Promise<void> {
    this.encryption.destroy();
    return this.inner.stop();
  }

  async send(message: Message, target: NodeId): Promise<void> {
    const encrypted = this.encryption.encrypt(
      JSON.stringify(message.data)
    );
    const wrappedMessage: Message = {
      ...message,
      data: {
        __encrypted: true,
        payload: {
          data: encrypted.data.toString('base64'),
          iv: encrypted.iv.toString('base64'),
          tag: encrypted.tag.toString('base64'),
          keyVersion: encrypted.keyVersion,
          algorithm: encrypted.algorithm,
        },
      },
    };
    return this.inner.send(wrappedMessage, target);
  }

  onMessage(callback: (message: Message) => void): void {
    const decryptingCallback = (message: Message) => {
      if (message.data && message.data.__encrypted) {
        const payload = message.data.payload;
        const encryptedData: EncryptedData = {
          data: Buffer.from(payload.data, 'base64'),
          iv: Buffer.from(payload.iv, 'base64'),
          tag: Buffer.from(payload.tag, 'base64'),
          keyVersion: payload.keyVersion,
          algorithm: payload.algorithm,
        };
        const decrypted = this.encryption.decrypt(encryptedData);
        callback({
          ...message,
          data: JSON.parse(decrypted.toString('utf8')),
        });
      } else {
        // Pass through unencrypted messages
        callback(message);
      }
    };
    this.messageListenerMap.set(callback, decryptingCallback);
    this.inner.onMessage(decryptingCallback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    const mapped = this.messageListenerMap.get(callback);
    if (mapped) {
      this.inner.removeMessageListener(mapped);
      this.messageListenerMap.delete(callback);
    }
  }

  getConnectedNodes(): NodeId[] {
    return this.inner.getConnectedNodes();
  }

  getLocalNodeInfo(): NodeId {
    return this.inner.getLocalNodeInfo();
  }

  /** Access the underlying Encryption instance (e.g. for key rotation) */
  getEncryption(): Encryption {
    return this.encryption;
  }
}
