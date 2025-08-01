import * as crypto from 'crypto';
import { EventEmitter } from 'events';

export interface MessageAuthOptions {
  algorithm?: 'hmac-sha256' | 'hmac-sha512';
  keySize?: number;
  enableReplayProtection?: boolean;
  nonceSize?: number;
  timestampWindow?: number; // seconds
  maxNonceAge?: number; // seconds
}

export interface AuthenticatedMessage {
  data: Buffer;
  signature: Buffer;
  timestamp: number;
  nonce: Buffer;
  algorithm: string;
  keyVersion: number;
}

export interface NonceInfo {
  nonce: Buffer;
  timestamp: number;
  used: boolean;
}

/**
 * Message authentication module with HMAC signatures, replay protection,
 * and timestamp-based message expiry
 */
export class MessageAuth extends EventEmitter {
  private keys = new Map<number, Buffer>();
  private currentKeyVersion: number = 1;
  private usedNonces = new Map<string, NonceInfo>();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly options: Required<MessageAuthOptions>;

  constructor(options: MessageAuthOptions = {}) {
    super();
    
    this.options = {
      algorithm: options.algorithm || 'hmac-sha256',
      keySize: options.keySize || 32, // 256 bits
      enableReplayProtection: options.enableReplayProtection !== false,
      nonceSize: options.nonceSize || 16,
      timestampWindow: options.timestampWindow || 300, // 5 minutes
      maxNonceAge: options.maxNonceAge || 3600, // 1 hour
    };

    if (this.options.enableReplayProtection) {
      this.startNonceCleanup();
    }
  }

  /**
   * Initialize with a master key
   */
  initialize(masterKey?: Buffer): void {
    if (masterKey) {
      if (masterKey.length !== this.options.keySize) {
        throw new Error(`Master key must be ${this.options.keySize} bytes`);
      }
      this.keys.set(this.currentKeyVersion, Buffer.from(masterKey));
    } else {
      // Generate a random key
      const randomKey = crypto.randomBytes(this.options.keySize);
      this.keys.set(this.currentKeyVersion, randomKey);
    }

    this.emit('initialized', { keyVersion: this.currentKeyVersion });
  }

  /**
   * Generate new authentication key
   */
  generateNewKey(): number {
    this.currentKeyVersion++;
    const newKey = crypto.randomBytes(this.options.keySize);
    this.keys.set(this.currentKeyVersion, newKey);
    
    this.emit('key-generated', { keyVersion: this.currentKeyVersion });
    return this.currentKeyVersion;
  }

  /**
   * Add specific key version
   */
  addKey(keyVersion: number, key: Buffer): void {
    if (key.length !== this.options.keySize) {
      throw new Error(`Key must be ${this.options.keySize} bytes`);
    }

    this.keys.set(keyVersion, Buffer.from(key));
    this.emit('key-added', { keyVersion });
  }

  /**
   * Sign message with authentication data
   */
  signMessage(data: Buffer | string): AuthenticatedMessage {
    if (this.keys.size === 0) {
      throw new Error('MessageAuth not initialized');
    }

    const dataBuffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const timestamp = Date.now();
    const nonce = this.options.enableReplayProtection 
      ? crypto.randomBytes(this.options.nonceSize)
      : Buffer.alloc(0);

    const key = this.keys.get(this.currentKeyVersion);
    if (!key) {
      throw new Error(`Current key version ${this.currentKeyVersion} not found`);
    }

    // Create signature over: data + timestamp + nonce
    const signatureData = Buffer.concat([
      dataBuffer,
      Buffer.from(timestamp.toString()),
      nonce
    ]);

    const signature = this.generateSignature(signatureData, key);

    if (this.options.enableReplayProtection) {
      // Store nonce to prevent replay
      this.usedNonces.set(nonce.toString('hex'), {
        nonce,
        timestamp,
        used: true
      });
    }

    return {
      data: dataBuffer,
      signature,
      timestamp,
      nonce,
      algorithm: this.options.algorithm,
      keyVersion: this.currentKeyVersion
    };
  }

  /**
   * Verify message authentication
   */
  verifyMessage(authenticatedMessage: AuthenticatedMessage): boolean {
    try {
      const key = this.keys.get(authenticatedMessage.keyVersion);
      if (!key) {
        this.emit('verification-failed', { 
          reason: 'key-not-found', 
          keyVersion: authenticatedMessage.keyVersion 
        });
        return false;
      }

      // Check timestamp window
      const now = Date.now();
      const messageAge = (now - authenticatedMessage.timestamp) / 1000; // seconds
      
      if (messageAge > this.options.timestampWindow) {
        this.emit('verification-failed', { 
          reason: 'timestamp-expired', 
          messageAge,
          timestampWindow: this.options.timestampWindow
        });
        return false;
      }

      if (messageAge < -this.options.timestampWindow) {
        this.emit('verification-failed', { 
          reason: 'timestamp-future', 
          messageAge 
        });
        return false;
      }

      // Check for replay attack (nonce reuse)
      if (this.options.enableReplayProtection && authenticatedMessage.nonce.length > 0) {
        const nonceKey = authenticatedMessage.nonce.toString('hex');
        if (this.usedNonces.has(nonceKey)) {
          this.emit('verification-failed', { 
            reason: 'nonce-replay', 
            nonce: nonceKey 
          });
          return false;
        }

        // Mark nonce as used
        this.usedNonces.set(nonceKey, {
          nonce: authenticatedMessage.nonce,
          timestamp: authenticatedMessage.timestamp,
          used: true
        });
      }

      // Verify signature
      const signatureData = Buffer.concat([
        authenticatedMessage.data,
        Buffer.from(authenticatedMessage.timestamp.toString()),
        authenticatedMessage.nonce
      ]);

      const isValid = this.verifySignature(
        signatureData, 
        authenticatedMessage.signature, 
        key
      );

      if (isValid) {
        this.emit('verification-success', { 
          keyVersion: authenticatedMessage.keyVersion,
          timestamp: authenticatedMessage.timestamp
        });
      } else {
        this.emit('verification-failed', { 
          reason: 'invalid-signature',
          keyVersion: authenticatedMessage.keyVersion
        });
      }

      return isValid;

    } catch (error) {
      this.emit('verification-error', error);
      return false;
    }
  }

  /**
   * Generate HMAC signature
   */
  private generateSignature(data: Buffer, key: Buffer): Buffer {
    const algorithm = this.options.algorithm === 'hmac-sha512' ? 'sha512' : 'sha256';
    return crypto.createHmac(algorithm, key).update(data).digest();
  }

  /**
   * Verify HMAC signature
   */
  private verifySignature(data: Buffer, signature: Buffer, key: Buffer): boolean {
    const algorithm = this.options.algorithm === 'hmac-sha512' ? 'sha512' : 'sha256';
    const computedSignature = crypto.createHmac(algorithm, key).update(data).digest();
    return crypto.timingSafeEqual(signature, computedSignature);
  }

  /**
   * Generate standalone HMAC for arbitrary data
   */
  generateHMAC(data: Buffer, keyVersion?: number): Buffer {
    const version = keyVersion || this.currentKeyVersion;
    const key = this.keys.get(version);
    
    if (!key) {
      throw new Error(`Key version ${version} not found`);
    }

    return this.generateSignature(data, key);
  }

  /**
   * Verify standalone HMAC
   */
  verifyHMAC(data: Buffer, signature: Buffer, keyVersion?: number): boolean {
    const version = keyVersion || this.currentKeyVersion;
    const key = this.keys.get(version);
    
    if (!key) {
      return false;
    }

    return this.verifySignature(data, signature, key);
  }

  /**
   * Generate nonce for external use
   */
  generateNonce(): Buffer {
    return crypto.randomBytes(this.options.nonceSize);
  }

  /**
   * Check if nonce has been used
   */
  isNonceUsed(nonce: Buffer): boolean {
    if (!this.options.enableReplayProtection) {
      return false;
    }
    return this.usedNonces.has(nonce.toString('hex'));
  }

  /**
   * Manually mark nonce as used
   */
  markNonceUsed(nonce: Buffer, timestamp?: number): void {
    if (!this.options.enableReplayProtection) {
      return;
    }

    this.usedNonces.set(nonce.toString('hex'), {
      nonce,
      timestamp: timestamp || Date.now(),
      used: true
    });
  }

  /**
   * Get current key version
   */
  getCurrentKeyVersion(): number {
    return this.currentKeyVersion;
  }

  /**
   * Get all available key versions
   */
  getAvailableKeyVersions(): number[] {
    return Array.from(this.keys.keys()).sort((a, b) => b - a);
  }

  /**
   * Remove old keys
   */
  removeOldKeys(keepRecentVersions: number = 3): void {
    const versions = this.getAvailableKeyVersions();
    const versionsToRemove = versions.slice(keepRecentVersions);
    
    for (const version of versionsToRemove) {
      this.keys.delete(version);
      this.emit('key-removed', { keyVersion: version });
    }
  }

  /**
   * Start periodic nonce cleanup
   */
  private startNonceCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldNonces();
    }, 60000); // Cleanup every minute

    this.cleanupTimer.unref();
  }

  /**
   * Remove old nonces beyond max age
   */
  private cleanupOldNonces(): void {
    const now = Date.now();
    const maxAge = this.options.maxNonceAge * 1000; // Convert to milliseconds
    
    let removedCount = 0;
    for (const [nonceKey, nonceInfo] of this.usedNonces) {
      if (now - nonceInfo.timestamp > maxAge) {
        this.usedNonces.delete(nonceKey);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.emit('nonces-cleaned', { removedCount, totalNonces: this.usedNonces.size });
    }
  }

  /**
   * Get statistics about nonce usage
   */
  getNonceStats(): { totalNonces: number; oldestNonce: number; newestNonce: number } {
    if (this.usedNonces.size === 0) {
      return { totalNonces: 0, oldestNonce: 0, newestNonce: 0 };
    }

    const timestamps = Array.from(this.usedNonces.values()).map(n => n.timestamp);
    return {
      totalNonces: this.usedNonces.size,
      oldestNonce: Math.min(...timestamps),
      newestNonce: Math.max(...timestamps)
    };
  }

  /**
   * Export key for secure transfer
   */
  exportKey(keyVersion: number): Buffer {
    const key = this.keys.get(keyVersion);
    if (!key) {
      throw new Error(`Key version ${keyVersion} not found`);
    }
    return Buffer.from(key);
  }

  /**
   * Stop nonce cleanup and clear resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Clear all keys securely
    for (const [version, key] of this.keys) {
      key.fill(0);
      this.emit('key-destroyed', { keyVersion: version });
    }
    
    this.keys.clear();
    this.usedNonces.clear();
    this.emit('destroyed');
  }
}
