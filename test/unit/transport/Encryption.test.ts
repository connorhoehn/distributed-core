import { Encryption, EncryptionOptions } from '../../../src/transport/Encryption';

describe('Encryption Module', () => {
  let encryption: Encryption;

  beforeEach(async () => {
    encryption = new Encryption();
    await encryption.initialize();
  });

  afterEach(() => {
    encryption.destroy();
  });

  describe('Basic Encryption/Decryption', () => {
    test('should encrypt and decrypt data successfully', () => {
      const plaintext = 'Hello, World!';
      
      const encrypted = encryption.encrypt(plaintext);
      expect(encrypted).toHaveProperty('data');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('tag');
      expect(encrypted).toHaveProperty('keyVersion');
      expect(encrypted.algorithm).toBe('aes-256-gcm');

      const decrypted = encryption.decrypt(encrypted);
      expect(decrypted.toString('utf8')).toBe(plaintext);
    });

    test('should handle binary data', () => {
      const binaryData = Buffer.from([1, 2, 3, 4, 5]);
      
      const encrypted = encryption.encrypt(binaryData);
      const decrypted = encryption.decrypt(encrypted);
      
      expect(Buffer.compare(decrypted, binaryData)).toBe(0);
    });

    test('should use different IVs for each encryption', () => {
      const plaintext = 'same data';
      
      const encrypted1 = encryption.encrypt(plaintext);
      const encrypted2 = encryption.encrypt(plaintext);
      
      expect(Buffer.compare(encrypted1.iv, encrypted2.iv)).not.toBe(0);
      expect(Buffer.compare(encrypted1.data, encrypted2.data)).not.toBe(0);
    });
  });

  describe('Key Management', () => {
    test('should generate new keys', async () => {
      const keyId = await encryption.generateNewKey();
      expect(typeof keyId).toBe('string');
      expect(keyId).toMatch(/^key-/);
    });

    test('should handle key rotation', async () => {
      const initialKey = encryption.getCurrentKey();
      const newKeyId = await encryption.generateNewKey();
      const newKey = encryption.getCurrentKey();
      
      expect(newKey?.version).toBeGreaterThan(initialKey?.version || 0);
    });

    test('should maintain multiple key versions', async () => {
      await encryption.generateNewKey();
      await encryption.generateNewKey();
      
      const versions = encryption.getKeyVersions();
      expect(versions.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('HMAC Authentication', () => {
    test('should generate and verify HMAC', () => {
      const data = Buffer.from('test data');
      
      const hmac = encryption.generateHMAC(data);
      expect(hmac).toBeInstanceOf(Buffer);
      expect(hmac.length).toBe(32); // SHA-256 output
      
      const isValid = encryption.verifyHMAC(data, hmac);
      expect(isValid).toBe(true);
    });

    test('should reject invalid HMAC', () => {
      const data = Buffer.from('test data');
      const hmac = encryption.generateHMAC(data);
      
      // Modify the data
      const tamperedData = Buffer.from('tampered data');
      const isValid = encryption.verifyHMAC(tamperedData, hmac);
      expect(isValid).toBe(false);
    });
  });

  describe('Key Export/Import', () => {
    test('should export and import keys', () => {
      const transportKey = Buffer.from('01234567890123456789012345678901');
      const currentKey = encryption.getCurrentKey();
      
      if (currentKey) {
        const exported = encryption.exportKey(currentKey.id, transportKey);
        expect(exported).toBeInstanceOf(Buffer);
        
        // Clear current key and import
        encryption.destroy();
        const newEncryption = new Encryption();
        const importedKeyId = newEncryption.importKey(exported, transportKey);
        expect(typeof importedKeyId).toBe('string');
        
        newEncryption.destroy();
      }
    });
  });

  describe('Error Handling', () => {
    test('should throw error when not initialized', () => {
      const newEncryption = new Encryption();
      expect(() => newEncryption.encrypt('test')).toThrow();
      newEncryption.destroy();
    });

    test('should throw error for invalid key version', () => {
      const encrypted = encryption.encrypt('test');
      encrypted.keyVersion = 9999; // Invalid version
      
      expect(() => encryption.decrypt(encrypted)).toThrow();
    });
  });
});
