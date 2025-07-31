import crypto from 'crypto';

export interface KeyManagerConfig {
  privateKeyPem?: string;
  publicKeyPem?: string;
  keySize?: number;
  algorithm?: 'rsa' | 'ec';
  curve?: string; // For EC keys
  enableLogging?: boolean;
}

export interface SignatureResult {
  signature: string;
  algorithm: string;
  timestamp: number;
}

export interface VerificationResult {
  isValid: boolean;
  publicKey?: string;
  error?: string;
}

/**
 * KeyManager - Responsible for cryptographic operations in the cluster
 * 
 * Features:
 * - Loading signing keys (RSA/EC)
 * - Signing messages with HMAC and digital signatures  
 * - Verifying peer signatures
 * - Support for cluster-wide shared secrets
 * - Certificate pinning support
 */
export class KeyManager {
  private privateKey: Buffer;
  private publicKey: Buffer;
  private config: Required<KeyManagerConfig>;
  
  constructor(config: KeyManagerConfig = {}) {
    this.config = {
      privateKeyPem: config.privateKeyPem || '',
      publicKeyPem: config.publicKeyPem || '',
      keySize: config.keySize || 2048,
      algorithm: config.algorithm || 'rsa',
      curve: config.curve || 'secp256k1',
      enableLogging: config.enableLogging || false
    };

    // Generate or load keys
    if (this.config.privateKeyPem && this.config.publicKeyPem) {
      this.privateKey = Buffer.from(this.config.privateKeyPem);
      this.publicKey = Buffer.from(this.config.publicKeyPem);
    } else {
      const keyPair = this.generateKeyPair();
      this.privateKey = Buffer.from(keyPair.privateKey);
      this.publicKey = Buffer.from(keyPair.publicKey);
    }

    if (this.config.enableLogging) {
      console.log(`[KeyManager] Initialized with ${this.config.algorithm.toUpperCase()} keys`);
    }
  }

  /**
   * Generate a new key pair
   */
  private generateKeyPair(): { privateKey: string; publicKey: string } {
    if (this.config.algorithm === 'rsa') {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: this.config.keySize,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs8', 
          format: 'pem'
        }
      });

      return { privateKey, publicKey };
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: this.config.curve,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem'
        }
      });

      return { privateKey, publicKey };
    }
  }

  /**
   * Sign a message using the private key
   */
  sign(message: string): SignatureResult {
    try {
      const sign = crypto.createSign('SHA256');
      sign.update(message);
      const signature = sign.sign(this.privateKey, 'hex');

      if (this.config.enableLogging) {
        console.log(`[KeyManager] Signed message of length ${message.length}`);
      }

      return {
        signature,
        algorithm: 'SHA256',
        timestamp: Date.now()
      };
    } catch (error) {
      if (this.config.enableLogging) {
        console.error('[KeyManager] Signing failed:', error);
      }
      throw new Error(`Failed to sign message: ${error}`);
    }
  }

  /**
   * Verify a signature using a public key
   */
  static verify(message: string, signature: string, publicKey: string): VerificationResult {
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(message);
      const isValid = verify.verify(publicKey, signature, 'hex');

      if (!isValid) {
        return {
          isValid: false,
          error: 'Invalid signature'
        };
      }

      return {
        isValid: true,
        publicKey
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Verification failed: ${error}`
      };
    }
  }

  /**
   * Get the public key in PEM format
   */
  getPublicKey(): string {
    return this.publicKey.toString('utf-8');
  }

  /**
   * Get the private key in PEM format (use with caution)
   */
  getPrivateKey(): string {
    return this.privateKey.toString('utf-8');
  }

  /**
   * Sign outgoing JOIN, LEAVE, and gossip payloads
   */
  signClusterPayload(payload: any): any {
    const message = JSON.stringify(payload);
    const signatureResult = this.sign(message);
    
    return {
      ...payload,
      signature: signatureResult.signature,
      signedBy: this.getPublicKey(),
      signedAt: signatureResult.timestamp
    };
  }

  /**
   * Verify signatures before accepting messages
   */
  verifyClusterPayload(payload: any): boolean {
    if (!payload.signature || !payload.signedBy) {
      if (this.config.enableLogging) {
        console.warn('[KeyManager] Payload missing signature or signedBy field');
      }
      return false;
    }

    // Extract signature and reconstruct original payload
    const { signature, signedBy, signedAt, ...originalPayload } = payload;
    const message = JSON.stringify(originalPayload);
    
    const result = KeyManager.verify(message, signature, signedBy);
    
    if (this.config.enableLogging && !result.isValid) {
      console.warn('[KeyManager] Payload signature verification failed:', result.error);
    }
    
    return result.isValid;
  }

  /**
   * Generate HMAC for cluster-wide shared secrets
   */
  generateHMAC(message: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  }

  /**
   * Verify HMAC for cluster-wide shared secrets
   */
  verifyHMAC(message: string, hmac: string, secret: string): boolean {
    const expectedHmac = this.generateHMAC(message, secret);
    return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expectedHmac, 'hex'));
  }

  /**
   * Pin a certificate for a specific node (for certificate pinning)
   */
  private pinnedCertificates = new Map<string, string>();
  
  pinCertificate(nodeId: string, publicKey: string): void {
    this.pinnedCertificates.set(nodeId, publicKey);
    
    if (this.config.enableLogging) {
      console.log(`[KeyManager] Pinned certificate for node ${nodeId}`);
    }
  }

  /**
   * Check if a node's public key matches the pinned certificate
   */
  verifyPinnedCertificate(nodeId: string, publicKey: string): boolean {
    const pinnedKey = this.pinnedCertificates.get(nodeId);
    if (!pinnedKey) {
      return true; // No pinning requirement
    }
    
    const isValid = pinnedKey === publicKey;
    
    if (this.config.enableLogging && !isValid) {
      console.warn(`[KeyManager] Certificate pinning failed for node ${nodeId}`);
    }
    
    return isValid;
  }

  /**
   * Get all pinned certificates
   */
  getPinnedCertificates(): Map<string, string> {
    return new Map(this.pinnedCertificates);
  }

  /**
   * Remove a pinned certificate
   */
  unpinCertificate(nodeId: string): boolean {
    const removed = this.pinnedCertificates.delete(nodeId);
    
    if (this.config.enableLogging && removed) {
      console.log(`[KeyManager] Unpinned certificate for node ${nodeId}`);
    }
    
    return removed;
  }

  /**
   * Generate a secure random secret for cluster operations
   */
  static generateSecret(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Derive a key from a password using PBKDF2
   */
  static deriveKey(password: string, salt: string, iterations: number = 100000): string {
    return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  }

  /**
   * Encrypt data using AES-256-GCM
   */
  encrypt(data: string, key: string): { encrypted: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const keyBuffer = crypto.scryptSync(key, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  decrypt(encryptedData: { encrypted: string; iv: string; tag: string }, key: string): string {
    const keyBuffer = crypto.scryptSync(key, 'salt', 32);
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));
    
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}
