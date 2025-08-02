import { KeyManager } from '../../../src/identity/KeyManager';

describe('KeyManager Unit Tests', () => {
  let keyManager: KeyManager;
  let sharedRSAKeyManager: KeyManager; // Reuse expensive RSA keys

  beforeAll(() => {
    // Generate expensive RSA keys once for all tests
    sharedRSAKeyManager = new KeyManager({ enableLogging: false });
  });

  beforeEach(() => {
    // Use fast EC keys for most tests by default
    keyManager = new KeyManager({ 
      algorithm: 'ec', 
      curve: 'secp256k1', 
      enableLogging: false 
    });
  });

  describe('Key Generation and Management', () => {
    it('should generate RSA key pair by default', () => {
      // Use the shared RSA instance instead of creating new one
      const publicKey = sharedRSAKeyManager.getPublicKey();
      const privateKey = sharedRSAKeyManager.getPrivateKey();
      
      expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(publicKey).toContain('-----END PUBLIC KEY-----');
      expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
      expect(privateKey).toContain('-----END PRIVATE KEY-----');
    });

    it('should generate EC key pair when configured', () => {
      const ecKeyManager = new KeyManager({ 
        algorithm: 'ec', 
        curve: 'secp256k1',
        enableLogging: false 
      });
      
      const publicKey = ecKeyManager.getPublicKey();
      const privateKey = ecKeyManager.getPrivateKey();
      
      expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should accept pre-generated keys', () => {
      // Use fast EC keys for generating test keys to improve performance
      const testKeyManager = new KeyManager({ 
        algorithm: 'ec', 
        curve: 'secp256k1', 
        enableLogging: false 
      });
      const testPublicKey = testKeyManager.getPublicKey();
      const testPrivateKey = testKeyManager.getPrivateKey();
      
      const keyManagerWithKeys = new KeyManager({
        publicKeyPem: testPublicKey,
        privateKeyPem: testPrivateKey,
        enableLogging: false
      });
      
      expect(keyManagerWithKeys.getPublicKey()).toBe(testPublicKey);
      expect(keyManagerWithKeys.getPrivateKey()).toBe(testPrivateKey);
    });
  });

  describe('Message Signing and Verification', () => {
    it('should sign and verify messages correctly', () => {
      const message = 'Hello, cluster!';
      const signatureResult = keyManager.sign(message);
      
      expect(signatureResult.signature).toBeDefined();
      expect(signatureResult.algorithm).toBe('SHA256');
      expect(signatureResult.timestamp).toBeGreaterThan(0);
      
      const verificationResult = KeyManager.verify(
        message, 
        signatureResult.signature, 
        keyManager.getPublicKey()
      );
      
      expect(verificationResult.isValid).toBe(true);
      expect(verificationResult.publicKey).toBe(keyManager.getPublicKey());
    });

    it('should reject invalid signatures', () => {
      const message = 'Hello, cluster!';
      const fakeSignature = 'invalid_signature_123';
      
      const verificationResult = KeyManager.verify(
        message, 
        fakeSignature, 
        keyManager.getPublicKey()
      );
      
      expect(verificationResult.isValid).toBe(false);
      expect(verificationResult.error).toBeDefined();
    });

    it('should reject signatures from wrong public key', () => {
      const message = 'Hello, cluster!';
      // Use the shared RSA KeyManager as the "other" key manager for this test
      
      const signatureResult = keyManager.sign(message);
      const verificationResult = KeyManager.verify(
        message, 
        signatureResult.signature, 
        sharedRSAKeyManager.getPublicKey()
      );
      
      expect(verificationResult.isValid).toBe(false);
    });
  });

  describe('Cluster Payload Signing', () => {
    it('should sign cluster payloads', () => {
      const payload = {
        type: 'JOIN',
        nodeId: 'node-1',
        data: { message: 'joining cluster' }
      };
      
      const signedPayload = keyManager.signClusterPayload(payload);
      
      expect(signedPayload.signature).toBeDefined();
      expect(signedPayload.signedBy).toBe(keyManager.getPublicKey());
      expect(signedPayload.signedAt).toBeGreaterThan(0);
      expect(signedPayload.type).toBe('JOIN');
      expect(signedPayload.nodeId).toBe('node-1');
    });

    it('should verify cluster payloads', () => {
      const payload = {
        type: 'GOSSIP',
        nodeId: 'node-2',
        data: { updates: ['update1', 'update2'] }
      };
      
      const signedPayload = keyManager.signClusterPayload(payload);
      const isValid = keyManager.verifyClusterPayload(signedPayload);
      
      expect(isValid).toBe(true);
    });

    it('should reject tampered cluster payloads', () => {
      const payload = {
        type: 'GOSSIP',
        nodeId: 'node-2',
        data: { updates: ['update1', 'update2'] }
      };
      
      const signedPayload = keyManager.signClusterPayload(payload);
      
      // Tamper with the payload
      signedPayload.nodeId = 'malicious-node';
      
      const isValid = keyManager.verifyClusterPayload(signedPayload);
      expect(isValid).toBe(false);
    });

    it('should reject payloads without signatures', () => {
      const payload = {
        type: 'JOIN',
        nodeId: 'node-1',
        data: { message: 'joining cluster' }
      };
      
      const isValid = keyManager.verifyClusterPayload(payload);
      expect(isValid).toBe(false);
    });
  });

  describe('HMAC Operations', () => {
    it('should generate and verify HMAC correctly', () => {
      const message = 'cluster secret message';
      const secret = 'shared-cluster-secret';
      
      const hmac = keyManager.generateHMAC(message, secret);
      expect(hmac).toBeDefined();
      expect(hmac.length).toBe(64); // SHA256 hex = 64 chars
      
      const isValid = keyManager.verifyHMAC(message, hmac, secret);
      expect(isValid).toBe(true);
    });

    it('should reject invalid HMAC', () => {
      const message = 'cluster secret message';
      const secret = 'shared-cluster-secret';
      const wrongSecret = 'wrong-secret';
      
      const hmac = keyManager.generateHMAC(message, secret);
      const isValid = keyManager.verifyHMAC(message, hmac, wrongSecret);
      
      expect(isValid).toBe(false);
    });
  });

  describe('Certificate Pinning', () => {
    it('should pin and verify certificates', () => {
      const nodeId = 'test-node-1';
      const publicKey = keyManager.getPublicKey();
      
      keyManager.pinCertificate(nodeId, publicKey);
      
      const isValid = keyManager.verifyPinnedCertificate(nodeId, publicKey);
      expect(isValid).toBe(true);
      
      const pinnedCerts = keyManager.getPinnedCertificates();
      expect(pinnedCerts.get(nodeId)).toBe(publicKey);
    });

    it('should reject wrong certificates for pinned nodes', () => {
      const nodeId = 'test-node-1';
      const publicKey = keyManager.getPublicKey();
      
      // Use the shared RSA KeyManager's public key as the "wrong" key
      const wrongPublicKey = sharedRSAKeyManager.getPublicKey();
      
      keyManager.pinCertificate(nodeId, publicKey);
      
      const isValid = keyManager.verifyPinnedCertificate(nodeId, wrongPublicKey);
      expect(isValid).toBe(false);
    });

    it('should allow unpinning certificates', () => {
      const nodeId = 'test-node-1';
      const publicKey = keyManager.getPublicKey();
      
      keyManager.pinCertificate(nodeId, publicKey);
      expect(keyManager.getPinnedCertificates().has(nodeId)).toBe(true);
      
      const removed = keyManager.unpinCertificate(nodeId);
      expect(removed).toBe(true);
      expect(keyManager.getPinnedCertificates().has(nodeId)).toBe(false);
    });

    it('should return true for unpinned nodes', () => {
      const nodeId = 'unpinned-node';
      const anyPublicKey = keyManager.getPublicKey();
      
      const isValid = keyManager.verifyPinnedCertificate(nodeId, anyPublicKey);
      expect(isValid).toBe(true); // No pinning requirement
    });
  });

  describe('Static Utility Methods', () => {
    it('should generate secure random secrets', () => {
      const secret1 = KeyManager.generateSecret();
      const secret2 = KeyManager.generateSecret();
      
      expect(secret1).toBeDefined();
      expect(secret2).toBeDefined();
      expect(secret1).not.toBe(secret2);
      expect(secret1.length).toBe(64); // 32 bytes = 64 hex chars
      
      const customLengthSecret = KeyManager.generateSecret(16);
      expect(customLengthSecret.length).toBe(32); // 16 bytes = 32 hex chars
    });

    it('should derive keys from passwords', () => {
      const password = 'test-password';
      const salt = 'test-salt';
      
      const key1 = KeyManager.deriveKey(password, salt);
      const key2 = KeyManager.deriveKey(password, salt);
      const key3 = KeyManager.deriveKey(password, 'different-salt');
      
      expect(key1).toBe(key2); // Same password + salt = same key
      expect(key1).not.toBe(key3); // Different salt = different key
      expect(key1.length).toBe(64); // 32 bytes = 64 hex chars
    });
  });

  describe('Encryption and Decryption', () => {
    it('should encrypt and decrypt data correctly', () => {
      const data = 'sensitive cluster configuration';
      const key = KeyManager.generateSecret();
      
      const encrypted = keyManager.encrypt(data, key);
      expect(encrypted.encrypted).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.tag).toBeDefined();
      
      const decrypted = keyManager.decrypt(encrypted, key);
      expect(decrypted).toBe(data);
    });

    it('should fail to decrypt with wrong key', () => {
      const data = 'sensitive cluster configuration';
      const key = KeyManager.generateSecret();
      const wrongKey = KeyManager.generateSecret();
      
      const encrypted = keyManager.encrypt(data, key);
      
      expect(() => {
        keyManager.decrypt(encrypted, wrongKey);
      }).toThrow();
    });

    it('should fail to decrypt tampered data', () => {
      const data = 'sensitive cluster configuration';
      const key = KeyManager.generateSecret();
      
      const encrypted = keyManager.encrypt(data, key);
      
      // Tamper with the encrypted data
      encrypted.encrypted = encrypted.encrypted.slice(0, -2) + 'xx';
      
      expect(() => {
        keyManager.decrypt(encrypted, key);
      }).toThrow();
    });
  });
});
