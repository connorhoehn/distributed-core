import { IClusterManagerContext, IRequiresContext } from '../../cluster/core/IClusterManagerContext';
import { KeyManager } from '../../identity/KeyManager';

/**
 * ClusterSecurity provides cryptographic and security services for the cluster
 * 
 * Responsibilities:
 * - Certificate management and pinning
 * - Message signature verification
 * - Public key operations
 * - Security policy enforcement
 */
export class ClusterSecurity implements IRequiresContext {
  private context?: IClusterManagerContext;

  /**
   * Set the cluster manager context for delegation
   */
  setContext(context: IClusterManagerContext): void {
    this.context = context;
  }

  /**
   * Get the public key of this node
   */
  getPublicKey(): string {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    return this.context.keyManager.getPublicKey();
  }

  /**
   * Pin a certificate for a specific node (for certificate pinning)
   */
  pinNodeCertificate(nodeId: string, publicKey: string): void {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    this.context.keyManager.pinCertificate(nodeId, publicKey);
  }

  /**
   * Remove pinned certificate for a node
   */
  unpinNodeCertificate(nodeId: string): boolean {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    return this.context.keyManager.unpinCertificate(nodeId);
  }

  /**
   * Get all pinned certificates
   */
  getPinnedCertificates(): Map<string, string> {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    return this.context.keyManager.getPinnedCertificates();
  }

  /**
   * Verify a message signature from a specific node
   */
  verifyNodeMessage(message: string, signature: string, nodeId: string): boolean {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }

    const pinnedCerts = this.context.keyManager.getPinnedCertificates();
    const publicKey = pinnedCerts.get(nodeId);
    
    if (!publicKey) {
      // Log warning if logging is enabled (would need to check config)
      return false;
    }
    
    const result = KeyManager.verify(message, signature, publicKey);
    return result.isValid;
  }

  /**
   * Verify cluster payload signature
   */
  verifyClusterPayload(payload: any): boolean {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    return this.context.keyManager.verifyClusterPayload(payload);
  }

  /**
   * Sign cluster payload
   */
  signClusterPayload<T>(payload: T): T {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    return this.context.keyManager.signClusterPayload(payload);
  }

  /**
   * Verify pinned certificate for a node
   */
  verifyPinnedCertificate(nodeId: string, publicKey: string): boolean {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }
    return this.context.keyManager.verifyPinnedCertificate(nodeId, publicKey);
  }

  /**
   * Get security policy configuration
   */
  getSecurityConfig(): {
    certificatePinningEnabled: boolean;
    messageSigningEnabled: boolean;
    pinnedCertificatesCount: number;
  } {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }

    const pinnedCerts = this.context.keyManager.getPinnedCertificates();
    
    return {
      certificatePinningEnabled: pinnedCerts.size > 0,
      messageSigningEnabled: true, // Assume always enabled
      pinnedCertificatesCount: pinnedCerts.size
    };
  }

  /**
   * Validate node identity and certificates
   */
  validateNodeIdentity(nodeId: string, publicKey?: string): {
    isValid: boolean;
    isPinned: boolean;
    reason?: string;
  } {
    if (!this.context) {
      throw new Error('ClusterSecurity requires context to be set');
    }

    const pinnedCerts = this.context.keyManager.getPinnedCertificates();
    const pinnedKey = pinnedCerts.get(nodeId);

    if (pinnedKey) {
      if (publicKey && pinnedKey !== publicKey) {
        return {
          isValid: false,
          isPinned: true,
          reason: 'Public key mismatch with pinned certificate'
        };
      }
      return {
        isValid: true,
        isPinned: true
      };
    }

    // No pinned certificate - validate based on policy
    return {
      isValid: true, // Accept for now, could implement stricter policy
      isPinned: false
    };
  }
}
