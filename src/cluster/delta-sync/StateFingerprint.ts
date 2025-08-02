/**
 * StateFingerprint - Merkle tree-based state hashing for efficient comparison
 */

import * as crypto from 'crypto';
import { LogicalService, ClusterState } from '../introspection/ClusterIntrospection';

/**
 * Fingerprint representing state at a point in time
 */
export interface StateFingerprint {
  rootHash: string;                    // Single hash representing entire state
  serviceHashes: Map<string, string>;  // Per-service hashes for quick comparison
  timestamp: number;
  nodeId: string;
  version: number;
  serviceCount: number;
}

/**
 * Merkle tree node for hierarchical state verification
 */
interface MerkleNode {
  hash: string;
  children?: MerkleNode[];
  data?: any;
  key?: string;
}

/**
 * Configuration for state fingerprinting
 */
export interface FingerprintConfig {
  hashAlgorithm: 'sha256' | 'sha1' | 'md5';
  includeTimestamps: boolean;
  includeMetadata: boolean;
  includeStats: boolean;
  chunkSize: number; // For large service catalogs
}

/**
 * StateFingerprint generates compact hashes for efficient state comparison
 * using Merkle trees for hierarchical verification
 */
export class StateFingerprintGenerator {
  private config: FingerprintConfig;

  constructor(config: Partial<FingerprintConfig> = {}) {
    this.config = {
      hashAlgorithm: 'sha256',
      includeTimestamps: false, // Exclude for deterministic hashing
      includeMetadata: true,
      includeStats: true,
      chunkSize: 100, // Process services in chunks
      ...config
    };
  }

  /**
   * Generate fingerprint for cluster state
   */
  generateFingerprint(state: ClusterState, nodeId: string): StateFingerprint {
    const serviceHashes = new Map<string, string>();
    const sortedServices = [...state.logicalServices].sort((a, b) => a.id.localeCompare(b.id));

    // Generate hash for each service
    for (const service of sortedServices) {
      const serviceHash = this.hashService(service);
      serviceHashes.set(service.id, serviceHash);
    }

    // Build Merkle tree and get root hash
    const merkleRoot = this.buildMerkleTree(sortedServices);
    
    return {
      rootHash: merkleRoot.hash,
      serviceHashes,
      timestamp: Date.now(),
      nodeId,
      version: 1,
      serviceCount: sortedServices.length
    };
  }

  /**
   * Generate fingerprint for specific services only
   */
  generateServiceFingerprint(services: LogicalService[], nodeId: string): StateFingerprint {
    const serviceHashes = new Map<string, string>();
    const sortedServices = [...services].sort((a, b) => a.id.localeCompare(b.id));

    for (const service of sortedServices) {
      const serviceHash = this.hashService(service);
      serviceHashes.set(service.id, serviceHash);
    }

    const merkleRoot = this.buildMerkleTree(sortedServices);
    
    return {
      rootHash: merkleRoot.hash,
      serviceHashes,
      timestamp: Date.now(),
      nodeId,
      version: 1,
      serviceCount: sortedServices.length
    };
  }

  /**
   * Compare two fingerprints to identify differences
   */
  compareFingerprints(local: StateFingerprint, remote: StateFingerprint): FingerprintComparison {
    if (local.rootHash === remote.rootHash) {
      return {
        identical: true,
        addedServices: [],
        removedServices: [],
        modifiedServices: [],
        hashDifferences: 0
      };
    }

    const addedServices: string[] = [];
    const removedServices: string[] = [];
    const modifiedServices: string[] = [];

    // Find added services (in remote but not local)
    for (const [serviceId, hash] of remote.serviceHashes) {
      if (!local.serviceHashes.has(serviceId)) {
        addedServices.push(serviceId);
      } else if (local.serviceHashes.get(serviceId) !== hash) {
        modifiedServices.push(serviceId);
      }
    }

    // Find removed services (in local but not remote)
    for (const serviceId of local.serviceHashes.keys()) {
      if (!remote.serviceHashes.has(serviceId)) {
        removedServices.push(serviceId);
      }
    }

    return {
      identical: false,
      addedServices,
      removedServices,
      modifiedServices,
      hashDifferences: addedServices.length + removedServices.length + modifiedServices.length
    };
  }

  /**
   * Verify fingerprint integrity
   */
  verifyFingerprint(fingerprint: StateFingerprint, services: LogicalService[]): boolean {
    const recomputedFingerprint = this.generateServiceFingerprint(services, fingerprint.nodeId);
    return recomputedFingerprint.rootHash === fingerprint.rootHash;
  }

  /**
   * Hash a single logical service
   */
  private hashService(service: LogicalService): string {
    const hasher = crypto.createHash(this.config.hashAlgorithm);
    
    // Create deterministic representation
    const serviceData: any = {
      id: service.id,
      type: service.type,
      nodeId: service.nodeId
    };

    if (this.config.includeMetadata) {
      serviceData.metadata = this.sortObject(service.metadata);
    }

    if (this.config.includeStats) {
      serviceData.stats = this.sortObject(service.stats);
    }

    if (this.config.includeTimestamps) {
      serviceData.lastUpdated = service.lastUpdated;
    }

    // Include anti-entropy fields
    serviceData.version = service.version;
    serviceData.vectorClock = this.sortObject(service.vectorClock);
    serviceData.checksum = service.checksum;

    const serialized = JSON.stringify(serviceData);
    hasher.update(serialized);
    
    return hasher.digest('hex');
  }

  /**
   * Build Merkle tree for services
   */
  private buildMerkleTree(services: LogicalService[]): MerkleNode {
    if (services.length === 0) {
      return { hash: this.hashString('') };
    }

    if (services.length === 1) {
      const serviceHash = this.hashService(services[0]);
      return {
        hash: serviceHash,
        data: services[0],
        key: services[0].id
      };
    }

    // Split services into chunks and create leaf nodes
    const leafNodes: MerkleNode[] = [];
    
    for (let i = 0; i < services.length; i += this.config.chunkSize) {
      const chunk = services.slice(i, i + this.config.chunkSize);
      const chunkHashes = chunk.map(s => this.hashService(s));
      const combinedHash = this.hashString(chunkHashes.join(''));
      
      leafNodes.push({
        hash: combinedHash,
        data: chunk,
        key: `chunk-${i}-${Math.min(i + this.config.chunkSize - 1, services.length - 1)}`
      });
    }

    // Build tree bottom-up
    return this.buildTreeLevel(leafNodes);
  }

  /**
   * Build a level of the Merkle tree
   */
  private buildTreeLevel(nodes: MerkleNode[]): MerkleNode {
    if (nodes.length === 1) {
      return nodes[0];
    }

    const nextLevel: MerkleNode[] = [];
    
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : left;
      
      const combinedHash = this.hashString(left.hash + right.hash);
      
      nextLevel.push({
        hash: combinedHash,
        children: [left, right]
      });
    }

    return this.buildTreeLevel(nextLevel);
  }

  /**
   * Hash a string using configured algorithm
   */
  private hashString(input: string): string {
    const hasher = crypto.createHash(this.config.hashAlgorithm);
    hasher.update(input);
    return hasher.digest('hex');
  }

  /**
   * Sort object keys for deterministic serialization
   */
  private sortObject(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObject(item));
    }

    const sorted: any = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = this.sortObject(obj[key]);
    });

    return sorted;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FingerprintConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): FingerprintConfig {
    return { ...this.config };
  }
}

/**
 * Result of fingerprint comparison
 */
export interface FingerprintComparison {
  identical: boolean;
  addedServices: string[];
  removedServices: string[];
  modifiedServices: string[];
  hashDifferences: number;
}

/**
 * Utility functions for fingerprint operations
 */
export class FingerprintUtils {
  /**
   * Calculate fingerprint size in bytes
   */
  static calculateSize(fingerprint: StateFingerprint): number {
    const baseSize = fingerprint.rootHash.length + 
                    fingerprint.nodeId.length + 
                    8 + // timestamp
                    4 + // version
                    4;  // serviceCount

    const serviceHashesSize = Array.from(fingerprint.serviceHashes.entries())
      .reduce((size, [id, hash]) => size + id.length + hash.length, 0);

    return baseSize + serviceHashesSize;
  }

  /**
   * Serialize fingerprint for network transmission
   */
  static serialize(fingerprint: StateFingerprint): Buffer {
    const data = {
      rootHash: fingerprint.rootHash,
      serviceHashes: Object.fromEntries(fingerprint.serviceHashes),
      timestamp: fingerprint.timestamp,
      nodeId: fingerprint.nodeId,
      version: fingerprint.version,
      serviceCount: fingerprint.serviceCount
    };

    return Buffer.from(JSON.stringify(data), 'utf8');
  }

  /**
   * Deserialize fingerprint from network data
   */
  static deserialize(buffer: Buffer): StateFingerprint {
    const data = JSON.parse(buffer.toString('utf8'));
    
    return {
      rootHash: data.rootHash,
      serviceHashes: new Map(Object.entries(data.serviceHashes)),
      timestamp: data.timestamp,
      nodeId: data.nodeId,
      version: data.version,
      serviceCount: data.serviceCount
    };
  }

  /**
   * Create fingerprint summary for logging
   */
  static createSummary(fingerprint: StateFingerprint): string {
    const size = FingerprintUtils.calculateSize(fingerprint);
    return `${fingerprint.rootHash.substring(0, 8)}... (${fingerprint.serviceCount} services, ${size} bytes)`;
  }
}
