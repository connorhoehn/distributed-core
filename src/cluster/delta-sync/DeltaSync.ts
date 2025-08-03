/**
 * DeltaSync - High-performance delta synchronization engine with compression and encryption
 */

import { StateDelta, StateDeltaManager, DeltaApplicationResult, DeltaConfig } from './StateDelta';
import { StateFingerprint, StateFingerprintGenerator, FingerprintComparison } from './StateFingerprint';
import { LogicalService, ClusterState, PerformanceMetrics } from '../introspection/ClusterIntrospection';
import { ClusterHealth, ClusterTopology, ClusterMetadata } from '../types';
import { Encryption } from '../../transport/Encryption';
import { MessageCache } from '../../transport/MessageCache';
import { EventEmitter } from 'events';
import * as zlib from 'zlib';
import { promisify } from 'util';

/**
 * Compressed delta payload
 */
export interface CompressedDelta {
  originalDelta: StateDelta;
  compressedData: Buffer;
  compressionRatio: number;
  compressionAlgorithm: 'gzip' | 'deflate' | 'brotli';
}

/**
 * Encrypted delta payload
 */
export interface EncryptedDelta {
  originalDelta: StateDelta;
  encryptedData: Buffer;
  encryptionMetadata: {
    algorithm: string;
    keyId: string;
    iv: Buffer;
    tag?: Buffer;
  };
}

/**
 * Sync session configuration
 */
export interface SyncSessionConfig {
  nodeId: string;
  targetNodeId: string;
  enableCompression: boolean;
  enableEncryption: boolean;
  compressionThreshold: number;    // Bytes
  maxDeltasPerBatch: number;
  batchTimeoutMs: number;
  retryAttempts: number;
  bandwidth: {
    maxBytesPerSecond?: number;
    burstAllowance?: number;
  };
}

/**
 * Sync session metrics
 */
export interface SyncMetrics {
  totalDeltas: number;
  totalBytes: number;
  compressedBytes: number;
  encryptedBytes: number;
  transmissionTime: number;
  compressionRatio: number;
  bandwidthSaved: number;
  operationsApplied: number;
  conflicts: number;
  errors: number;
}

/**
 * Sync session status
 */
export type SyncStatus = 'idle' | 'fingerprinting' | 'generating' | 'transmitting' | 'applying' | 'complete' | 'error';

/**
 * Sync session
 */
export interface SyncSession {
  id: string;
  config: SyncSessionConfig;
  status: SyncStatus;
  metrics: SyncMetrics;
  startTime: number;
  endTime?: number;
  error?: string;
  
  // Progress tracking
  fingerprintComparison?: FingerprintComparison;
  generatedDeltas: StateDelta[];
  transmittedDeltas: StateDelta[];
  appliedDeltas: StateDelta[];
  failedDeltas: StateDelta[];
}

/**
 * Bandwidth monitor for rate limiting
 */
class BandwidthMonitor {
  private bytesTransmitted = 0;
  private windowStart = Date.now();
  private readonly windowSize = 1000; // 1 second
  
  constructor(private maxBytesPerSecond?: number) {}

  async throttle(bytes: number): Promise<void> {
    if (!this.maxBytesPerSecond) return;

    const now = Date.now();
    
    // Reset window if needed
    if (now - this.windowStart >= this.windowSize) {
      this.bytesTransmitted = 0;
      this.windowStart = now;
    }

    // Check if we need to throttle
    if (this.bytesTransmitted + bytes > this.maxBytesPerSecond) {
      const delay = this.windowSize - (now - this.windowStart);
      if (delay > 0) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          timer.unref(); // Prevent Jest hanging
        });
        // Reset after delay
        this.bytesTransmitted = 0;
        this.windowStart = Date.now();
      }
    }

    this.bytesTransmitted += bytes;
  }

  getCurrentUsage(): { bytesPerSecond: number; utilizationPercent: number } {
    const now = Date.now();
    const elapsed = now - this.windowStart;
    const bytesPerSecond = elapsed > 0 ? (this.bytesTransmitted / elapsed) * 1000 : 0;
    const utilizationPercent = this.maxBytesPerSecond ? 
      (bytesPerSecond / this.maxBytesPerSecond) * 100 : 0;

    return { bytesPerSecond, utilizationPercent };
  }
}

/**
 * DeltaSync engine for efficient state synchronization
 */
export class DeltaSyncEngine extends EventEmitter {
  private fingerprintGenerator: StateFingerprintGenerator;
  private deltaManager: StateDeltaManager;
  private encryption: Encryption;
  private messageCache: MessageCache;
  private activeSessions = new Map<string, SyncSession>();
  
  // Compression functions
  private gzipAsync = promisify(zlib.gzip);
  private gunzipAsync = promisify(zlib.gunzip);
  private deflateAsync = promisify(zlib.deflate);
  private inflateAsync = promisify(zlib.inflate);
  private brotliCompressAsync = promisify(zlib.brotliCompress);
  private brotliDecompressAsync = promisify(zlib.brotliDecompress);

  constructor(
    fingerprintConfig?: any,
    deltaConfig?: Partial<DeltaConfig>,
    encryptionConfig?: any
  ) {
    super();
    
    this.fingerprintGenerator = new StateFingerprintGenerator(fingerprintConfig);
    this.deltaManager = new StateDeltaManager(deltaConfig);
    this.encryption = new Encryption(encryptionConfig);
    this.messageCache = new MessageCache();
  }

  /**
   * Start sync session between two nodes
   */
  async startSyncSession(
    localServices: LogicalService[],
    remoteFingerprint: StateFingerprint,
    config: SyncSessionConfig
  ): Promise<SyncSession> {
    const session: SyncSession = {
      id: `sync-${config.nodeId}-${config.targetNodeId}-${Date.now()}`,
      config,
      status: 'fingerprinting',
      metrics: this.createEmptyMetrics(),
      startTime: Date.now(),
      generatedDeltas: [],
      transmittedDeltas: [],
      appliedDeltas: [],
      failedDeltas: []
    };

    this.activeSessions.set(session.id, session);
    this.emit('sessionStarted', session);

    try {
      // Generate local fingerprint
      session.status = 'fingerprinting';
      const localFingerprint = this.fingerprintGenerator.generateServiceFingerprint(localServices, config.nodeId);
      
      // Compare fingerprints
      const comparison = this.fingerprintGenerator.compareFingerprints(
        localFingerprint, 
        remoteFingerprint
      );
      
      session.fingerprintComparison = comparison;

      // Check if sync is needed
      if (comparison.identical) {
        session.status = 'complete';
        session.endTime = Date.now();
        this.emit('sessionComplete', session);
        return session;
      }

      // Generate deltas
      session.status = 'generating';
      const deltas = this.deltaManager.generateDelta(
        localServices,
        comparison,
        config.nodeId,
        localFingerprint.rootHash,
        config.targetNodeId
      );

      session.generatedDeltas = deltas;
      session.metrics.totalDeltas = deltas.length;

      // Process and transmit deltas
      await this.transmitDeltas(session);

      session.status = 'complete';
      session.endTime = Date.now();
      this.emit('sessionComplete', session);

    } catch (error) {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : String(error);
      session.endTime = Date.now();
      this.emit('sessionError', session, error);
    }

    return session;
  }

  /**
   * Apply incoming deltas to local state
   */
  async applyIncomingDeltas(
    currentServices: LogicalService[],
    deltas: StateDelta[],
    sessionId?: string
  ): Promise<DeltaApplicationResult> {
    const session = sessionId ? this.activeSessions.get(sessionId) : undefined;
    
    if (session) {
      session.status = 'applying';
    }

    const allResults: DeltaApplicationResult[] = [];
    let currentState = [...currentServices];

    try {
      // Process deltas in sequence order
      const sortedDeltas = deltas.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      for (const delta of sortedDeltas) {
        // Decrypt if needed
        const decryptedDelta = await this.decryptDelta(delta);
        
        // Decompress if needed
        const decompressedDelta = await this.decompressDelta(decryptedDelta);

        // Validate delta
        const validation = this.deltaManager.validateDelta(decompressedDelta);
        if (!validation.valid) {
          // Handle invalid delta gracefully instead of throwing
          allResults.push({
            success: false,
            appliedOperations: 0,
            resultingServices: currentState,
            conflicts: [],
            failedOperations: [],
            newFingerprint: ''
          });
          continue;
        }

        // Apply delta
        const result = this.deltaManager.applyDelta(currentState, decompressedDelta);
        allResults.push(result);

        if (result.success) {
          currentState = result.resultingServices;
          if (session) {
            session.appliedDeltas.push(decompressedDelta);
            session.metrics.operationsApplied += result.appliedOperations;
          }
        } else {
          if (session) {
            session.failedDeltas.push(decompressedDelta);
            session.metrics.conflicts += result.conflicts.length;
          }
        }
      }

      // Merge all results
      const mergedResult: DeltaApplicationResult = {
        success: allResults.every(r => r.success),
        appliedOperations: allResults.reduce((sum, r) => sum + r.appliedOperations, 0),
        failedOperations: allResults.flatMap(r => r.failedOperations),
        conflicts: allResults.flatMap(r => r.conflicts),
        resultingServices: currentState,
        newFingerprint: '' // Will be calculated if needed
      };

      return mergedResult;

    } catch (error) {
      if (session) {
        session.metrics.errors++;
      }
      throw error;
    }
  }

  /**
   * Compress delta if above threshold
   */
  async compressDelta(
    delta: StateDelta,
    algorithm: 'gzip' | 'deflate' | 'brotli' = 'gzip'
  ): Promise<CompressedDelta | StateDelta> {
    const serialized = JSON.stringify(delta);
    const originalSize = Buffer.byteLength(serialized, 'utf8');

    // Check if compression is beneficial
    if (originalSize < this.deltaManager.getConfig().compressionThreshold) {
      return delta;
    }

    let compressed: Buffer;
    
    switch (algorithm) {
      case 'gzip':
        compressed = await this.gzipAsync(serialized);
        break;
      case 'deflate':
        compressed = await this.deflateAsync(serialized);
        break;
      case 'brotli':
        compressed = await this.brotliCompressAsync(serialized);
        break;
    }

    const compressionRatio = compressed.length / originalSize;

    // Only use compression if it actually reduces size significantly
    if (compressionRatio > 0.9) {
      return delta;
    }

    const compressedDelta: CompressedDelta = {
      originalDelta: {
        ...delta,
        compressed: true,
        originalSize,
        compressedSize: compressed.length
      },
      compressedData: compressed,
      compressionRatio,
      compressionAlgorithm: algorithm
    };

    return compressedDelta;
  }

  /**
   * Decompress delta
   */
  async decompressDelta(delta: StateDelta | CompressedDelta): Promise<StateDelta> {
    if (!('compressedData' in delta)) {
      return delta as StateDelta;
    }

    const compressed = delta as CompressedDelta;
    let decompressed: Buffer;

    switch (compressed.compressionAlgorithm) {
      case 'gzip':
        decompressed = await this.gunzipAsync(compressed.compressedData);
        break;
      case 'deflate':
        decompressed = await this.inflateAsync(compressed.compressedData);
        break;
      case 'brotli':
        decompressed = await this.brotliDecompressAsync(compressed.compressedData);
        break;
    }

    const deltaData = JSON.parse(decompressed.toString('utf8'));
    return { ...deltaData, compressed: false };
  }

  /**
   * Encrypt delta if configured
   */
  async encryptDelta(delta: StateDelta): Promise<EncryptedDelta | StateDelta> {
    if (!this.deltaManager.getConfig().enableEncryption) {
      return delta;
    }

    const serialized = JSON.stringify(delta);
    const encrypted = await this.encryption.encrypt(Buffer.from(serialized, 'utf8'));

    const encryptedDelta: EncryptedDelta = {
      originalDelta: {
        ...delta,
        encrypted: true
      },
      encryptedData: encrypted.data,
      encryptionMetadata: {
        algorithm: encrypted.algorithm,
        keyId: 'default', // Use default key for now
        iv: encrypted.iv,
        tag: encrypted.tag
      }
    };

    return encryptedDelta;
  }

  /**
   * Decrypt delta
   */
  async decryptDelta(delta: StateDelta | EncryptedDelta): Promise<StateDelta> {
    if (!('encryptedData' in delta)) {
      return delta as StateDelta;
    }

    const encrypted = delta as EncryptedDelta;
    
    const decrypted = this.encryption.decrypt({
      data: encrypted.encryptedData,
      iv: encrypted.encryptionMetadata.iv,
      tag: encrypted.encryptionMetadata.tag || Buffer.alloc(0),
      keyVersion: 1, // Default key version
      algorithm: encrypted.encryptionMetadata.algorithm
    });

    const deltaData = JSON.parse(decrypted.toString('utf8'));
    return { ...deltaData, encrypted: false };
  }

  /**
   * Transmit deltas with compression and encryption
   */
  private async transmitDeltas(session: SyncSession): Promise<void> {
    session.status = 'transmitting';
    
    const bandwidthMonitor = new BandwidthMonitor(
      session.config.bandwidth?.maxBytesPerSecond
    );

    let totalOriginalBytes = 0;
    let totalTransmittedBytes = 0;

    for (const delta of session.generatedDeltas) {
      try {
        const originalSize = this.deltaManager.calculateDeltaSize(delta);
        totalOriginalBytes += originalSize;

        // Compress if enabled
        let processedDelta: StateDelta | CompressedDelta = delta;
        if (session.config.enableCompression) {
          processedDelta = await this.compressDelta(delta);
        }

        // Encrypt if enabled
        let finalDelta: StateDelta | CompressedDelta | EncryptedDelta = processedDelta;
        if (session.config.enableEncryption) {
          finalDelta = await this.encryptDelta(processedDelta as StateDelta);
        }

        // Calculate transmitted size
        const transmittedSize = Buffer.byteLength(JSON.stringify(finalDelta), 'utf8');
        totalTransmittedBytes += transmittedSize;

        // Apply bandwidth throttling
        await bandwidthMonitor.throttle(transmittedSize);

        // Simulate transmission (in real implementation, send via transport)
        await this.simulateTransmission(finalDelta, transmittedSize);

        session.transmittedDeltas.push(delta);
        
        this.emit('deltaTransmitted', session, delta, {
          originalSize,
          transmittedSize,
          compressionRatio: transmittedSize / originalSize
        });

      } catch (error) {
        session.failedDeltas.push(delta);
        session.metrics.errors++;
        this.emit('deltaTransmissionError', session, delta, error);
      }
    }

    // Update metrics
    session.metrics.totalBytes = totalOriginalBytes;
    session.metrics.compressedBytes = totalTransmittedBytes;
    session.metrics.compressionRatio = totalTransmittedBytes / totalOriginalBytes;
    session.metrics.bandwidthSaved = totalOriginalBytes - totalTransmittedBytes;
    session.metrics.transmissionTime = Date.now() - session.startTime;
  }

  /**
   * Simulate transmission delay (replace with actual transport in production)
   */
  private async simulateTransmission(delta: any, size: number): Promise<void> {
    // Simulate network latency proportional to size
    const latency = Math.min(10 + (size / 1024), 100); // 10-100ms based on size
    await new Promise(resolve => {
      const timer = setTimeout(resolve, latency);
      timer.unref(); // Prevent Jest hanging
    });
  }

  /**
   * Get session status
   */
  getSession(sessionId: string): SyncSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SyncSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Calculate bandwidth savings across all sessions
   */
  getBandwidthStats(): {
    totalSessions: number;
    totalBytesSaved: number;
    averageCompressionRatio: number;
    totalTransmissionTime: number;
  } {
    const sessions = Array.from(this.activeSessions.values());
    
    return {
      totalSessions: sessions.length,
      totalBytesSaved: sessions.reduce((sum, s) => sum + s.metrics.bandwidthSaved, 0),
      averageCompressionRatio: sessions.length > 0 
        ? sessions.reduce((sum, s) => sum + s.metrics.compressionRatio, 0) / sessions.length
        : 0,
      totalTransmissionTime: sessions.reduce((sum, s) => sum + s.metrics.transmissionTime, 0)
    };
  }

  /**
   * Clean up completed sessions
   */
  cleanup(maxAge: number = 300000): void { // 5 minutes default
    const now = Date.now();
    
    for (const [sessionId, session] of this.activeSessions) {
      if (session.endTime && (now - session.endTime) > maxAge) {
        this.activeSessions.delete(sessionId);
        this.emit('sessionCleaned', sessionId);
      }
    }
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): SyncMetrics {
    return {
      totalDeltas: 0,
      totalBytes: 0,
      compressedBytes: 0,
      encryptedBytes: 0,
      transmissionTime: 0,
      compressionRatio: 1.0,
      bandwidthSaved: 0,
      operationsApplied: 0,
      conflicts: 0,
      errors: 0
    };
  }

  /**
   * Update delta manager configuration
   */
  updateDeltaConfig(config: Partial<DeltaConfig>): void {
    this.deltaManager.updateConfig(config);
  }

  /**
   * Update fingerprint generator configuration
   */
  updateFingerprintConfig(config: any): void {
    this.fingerprintGenerator.updateConfig(config);
  }
}
