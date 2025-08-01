import * as crypto from 'crypto';
import { EventEmitter } from 'events';

export interface EncryptionOptions {
  algorithm?: 'aes-256-gcm' | 'chacha20-poly1305';
  keyDerivation?: 'pbkdf2' | 'scrypt';
  keySize?: number;
  ivSize?: number;
  tagSize?: number;
  enableKeyRotation?: boolean;
  keyRotationInterval?: number;
}

export interface EncryptedData {
  data: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  algorithm: string;
}

export interface KeyInfo {
  id: string;
  key: Buffer;
  version: number;
  createdAt: number;
  algorithm: string;
}

/**
 * Enterprise-grade encryption module supporting AES-256-GCM and ChaCha20-Poly1305
 * with key rotation, versioning, and authenticated encryption
 */
export class Encryption extends EventEmitter {
  private keys = new Map<string, KeyInfo>();
  private currentKeyId: string | null = null;
  private keyRotationTimer?: NodeJS.Timeout;
  private readonly options: Required<EncryptionOptions>;

  constructor(options: EncryptionOptions = {}) {
    super();
    
    this.options = {
      algorithm: options.algorithm || 'aes-256-gcm',
      keyDerivation: options.keyDerivation || 'scrypt',
      keySize: options.keySize || 32, // 256 bits
      ivSize: options.ivSize || 12, // 96 bits for GCM
      tagSize: options.tagSize || 16, // 128 bits
      enableKeyRotation: options.enableKeyRotation !== false,
      keyRotationInterval: options.keyRotationInterval || 24 * 60 * 60 * 1000, // 24 hours
    };
  }

  /**
   * Initialize encryption with a master key
   */
  async initialize(masterKey?: Buffer | string): Promise<void> {
    if (masterKey) {
      const keyBuffer = typeof masterKey === 'string' 
        ? Buffer.from(masterKey, 'hex')
        : masterKey;
      
      await this.addKey('master', keyBuffer);
      this.currentKeyId = 'master';
    } else {
      // Generate a new random key
      await this.generateNewKey('auto-generated');
    }

    if (this.options.enableKeyRotation) {
      this.startKeyRotation();
    }

    this.emit('initialized');
  }

  /**
   * Generate a new encryption key
   */
  async generateNewKey(keyId?: string): Promise<string> {
    const id = keyId || `key-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const key = crypto.randomBytes(this.options.keySize);
    
    await this.addKey(id, key);
    this.currentKeyId = id;
    
    this.emit('key-generated', { keyId: id });
    return id;
  }

  /**
   * Add a key to the keystore
   */
  async addKey(keyId: string, key: Buffer): Promise<void> {
    if (key.length !== this.options.keySize) {
      throw new Error(`Key size must be ${this.options.keySize} bytes`);
    }

    const keyInfo: KeyInfo = {
      id: keyId,
      key: Buffer.from(key), // Copy to prevent external modification
      version: this.keys.size + 1,
      createdAt: Date.now(),
      algorithm: this.options.algorithm,
    };

    this.keys.set(keyId, keyInfo);
    this.emit('key-added', { keyId, version: keyInfo.version });
  }

  /**
   * Derive key from password using scrypt or pbkdf2
   */
  async deriveKey(password: string, salt?: Buffer): Promise<Buffer> {
    const saltBuffer = salt || crypto.randomBytes(16);
    
    if (this.options.keyDerivation === 'scrypt') {
      return new Promise((resolve, reject) => {
        crypto.scrypt(password, saltBuffer, this.options.keySize, (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        });
      });
    } else {
      return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, saltBuffer, 100000, this.options.keySize, 'sha512', (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        });
      });
    }
  }

  /**
   * Encrypt data using current key
   */
  encrypt(data: Buffer | string): EncryptedData {
    if (!this.currentKeyId) {
      throw new Error('Encryption not initialized');
    }

    const keyInfo = this.keys.get(this.currentKeyId);
    if (!keyInfo) {
      throw new Error(`Key not found: ${this.currentKeyId}`);
    }

    const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const iv = crypto.randomBytes(this.options.ivSize);
    
    if (this.options.algorithm === 'aes-256-gcm') {
      return this.encryptAESGCM(plaintext, keyInfo.key, iv, keyInfo.version);
    } else if (this.options.algorithm === 'chacha20-poly1305') {
      return this.encryptChaCha20(plaintext, keyInfo.key, iv, keyInfo.version);
    } else {
      throw new Error(`Unsupported algorithm: ${this.options.algorithm}`);
    }
  }

  /**
   * Decrypt data using the appropriate key version
   */
  decrypt(encryptedData: EncryptedData): Buffer {
    // Find key by version
    const keyInfo = Array.from(this.keys.values())
      .find(k => k.version === encryptedData.keyVersion);
    
    if (!keyInfo) {
      throw new Error(`Key version ${encryptedData.keyVersion} not found`);
    }

    if (encryptedData.algorithm === 'aes-256-gcm') {
      return this.decryptAESGCM(encryptedData, keyInfo.key);
    } else if (encryptedData.algorithm === 'chacha20-poly1305') {
      return this.decryptChaCha20(encryptedData, keyInfo.key);
    } else {
      throw new Error(`Unsupported algorithm: ${encryptedData.algorithm}`);
    }
  }

  /**
   * AES-256-GCM encryption
   */
  private encryptAESGCM(plaintext: Buffer, key: Buffer, iv: Buffer, keyVersion: number): EncryptedData {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();

    return {
      data: encrypted,
      iv,
      tag,
      keyVersion,
      algorithm: 'aes-256-gcm'
    };
  }

  /**
   * AES-256-GCM decryption
   */
  private decryptAESGCM(encryptedData: EncryptedData, key: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encryptedData.iv);
    decipher.setAuthTag(encryptedData.tag);
    
    return Buffer.concat([
      decipher.update(encryptedData.data),
      decipher.final()
    ]);
  }

  /**
   * ChaCha20-Poly1305 encryption
   */
  private encryptChaCha20(plaintext: Buffer, key: Buffer, iv: Buffer, keyVersion: number): EncryptedData {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();

    return {
      data: encrypted,
      iv,
      tag,
      keyVersion,
      algorithm: 'chacha20-poly1305'
    };
  }

  /**
   * ChaCha20-Poly1305 decryption
   */
  private decryptChaCha20(encryptedData: EncryptedData, key: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, encryptedData.iv);
    decipher.setAuthTag(encryptedData.tag);
    
    return Buffer.concat([
      decipher.update(encryptedData.data),
      decipher.final()
    ]);
  }

  /**
   * Generate HMAC signature for message authentication
   */
  generateHMAC(data: Buffer, key?: Buffer): Buffer {
    const hmacKey = key || this.getCurrentKey()?.key;
    if (!hmacKey) {
      throw new Error('No HMAC key available');
    }
    
    return crypto.createHmac('sha256', hmacKey).update(data).digest();
  }

  /**
   * Verify HMAC signature
   */
  verifyHMAC(data: Buffer, signature: Buffer, key?: Buffer): boolean {
    const hmacKey = key || this.getCurrentKey()?.key;
    if (!hmacKey) {
      throw new Error('No HMAC key available');
    }
    
    const computedSignature = crypto.createHmac('sha256', hmacKey).update(data).digest();
    return crypto.timingSafeEqual(signature, computedSignature);
  }

  /**
   * Get current key info
   */
  getCurrentKey(): KeyInfo | null {
    return this.currentKeyId ? this.keys.get(this.currentKeyId) || null : null;
  }

  /**
   * Get all key versions
   */
  getKeyVersions(): number[] {
    return Array.from(this.keys.values()).map(k => k.version).sort((a, b) => b - a);
  }

  /**
   * Remove old keys (keep only recent versions)
   */
  cleanupOldKeys(keepRecentVersions: number = 3): void {
    const versions = this.getKeyVersions();
    const versionsToRemove = versions.slice(keepRecentVersions);
    
    for (const [keyId, keyInfo] of this.keys) {
      if (versionsToRemove.includes(keyInfo.version)) {
        this.keys.delete(keyId);
        this.emit('key-removed', { keyId, version: keyInfo.version });
      }
    }
  }

  /**
   * Start automatic key rotation
   */
  private startKeyRotation(): void {
    if (this.keyRotationTimer) {
      clearInterval(this.keyRotationTimer);
    }

    this.keyRotationTimer = setInterval(async () => {
      try {
        const newKeyId = await this.generateNewKey();
        this.emit('key-rotated', { newKeyId, oldKeyId: this.currentKeyId });
        
        // Cleanup old keys (keep last 3 versions)
        this.cleanupOldKeys(3);
      } catch (error) {
        this.emit('key-rotation-error', error);
      }
    }, this.options.keyRotationInterval);

    // Don't keep the process alive for key rotation
    this.keyRotationTimer.unref();
  }

  /**
   * Stop key rotation
   */
  stopKeyRotation(): void {
    if (this.keyRotationTimer) {
      clearInterval(this.keyRotationTimer);
      this.keyRotationTimer = undefined;
    }
  }

  /**
   * Export key for secure transport (encrypted with another key)
   */
  exportKey(keyId: string, transportKey: Buffer): Buffer {
    const keyInfo = this.keys.get(keyId);
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', transportKey, iv);
    
    const keyData = JSON.stringify({
      id: keyInfo.id,
      key: keyInfo.key.toString('hex'),
      version: keyInfo.version,
      createdAt: keyInfo.createdAt,
      algorithm: keyInfo.algorithm
    });
    
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(keyData, 'utf8')),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();
    
    // Return: iv + tag + encrypted data
    return Buffer.concat([iv, tag, encrypted]);
  }

  /**
   * Import key from secure transport
   */
  importKey(encryptedKeyData: Buffer, transportKey: Buffer): string {
    const iv = encryptedKeyData.subarray(0, 12);
    const tag = encryptedKeyData.subarray(12, 28);
    const encrypted = encryptedKeyData.subarray(28);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', transportKey, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    const keyData = JSON.parse(decrypted.toString('utf8'));
    const keyInfo: KeyInfo = {
      id: keyData.id,
      key: Buffer.from(keyData.key, 'hex'),
      version: keyData.version,
      createdAt: keyData.createdAt,
      algorithm: keyData.algorithm
    };
    
    this.keys.set(keyInfo.id, keyInfo);
    this.emit('key-imported', { keyId: keyInfo.id });
    
    return keyInfo.id;
  }

  /**
   * Destroy all keys and cleanup
   */
  destroy(): void {
    this.stopKeyRotation();
    
    // Securely clear all keys
    for (const [keyId, keyInfo] of this.keys) {
      keyInfo.key.fill(0);
      this.emit('key-destroyed', { keyId });
    }
    
    this.keys.clear();
    this.currentKeyId = null;
    this.emit('destroyed');
  }
}
