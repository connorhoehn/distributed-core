import { ResourceOperation } from '../../resources/core/ResourceOperation';


/**
 * ResourceLeaseManager provides distributed ownership coordination
 * 
 * Prevents split-brain scenarios by ensuring only one node can be authoritative
 * for a resource at any given time through monotonic lease terms.
 */
export interface ResourceLeaseManager {
  acquire(resourceId: string, ttlMs: number): Promise<{ term: number; fenced: boolean }>;
  renew(resourceId: string, term: number): Promise<boolean>;
  release(resourceId: string, term: number): Promise<void>;
  current(resourceId: string): Promise<number>; // highest granted term
}

export interface LeaseRecord {
  resourceId: string;
  term: number;
  nodeId: string;
  acquiredAt: number;
  expiresAt: number;
  renewCount: number;
}

export interface LeaseConfig {
  defaultTtlMs: number;
  renewIntervalMs: number;
  maxRenewAttempts: number;
  fenceGracePeriodMs: number;
  storageAdapter: 'etcd' | 'consul' | 'memory';
}

/**
 * Etcd-backed implementation for production use
 * Uses Compare-And-Swap operations for atomic lease management
 */
export class EtcdResourceLeaseManager implements ResourceLeaseManager {
  private config: LeaseConfig;
  private etcdClient: any; // EtcdClient
  private nodeId: string;
  private activeLeases = new Map<string, LeaseRecord>();
  private renewalTimers = new Map<string, any>();

  constructor(etcdClient: any, nodeId: string, config: Partial<LeaseConfig> = {}) {
    this.etcdClient = etcdClient;
    this.nodeId = nodeId;
    this.config = {
      defaultTtlMs: 30000,
      renewIntervalMs: 10000,
      maxRenewAttempts: 3,
      fenceGracePeriodMs: 5000,
      storageAdapter: 'etcd',
      ...config
    };
  }

  async acquire(resourceId: string, ttlMs: number = this.config.defaultTtlMs): Promise<{ term: number; fenced: boolean }> {
    const key = this.leaseKey(resourceId);
    const now = Date.now();
    const expiresAt = now + ttlMs;

    try {
      // Get current lease state
      const currentLease = await this.getCurrentLease(resourceId);
      const newTerm = currentLease ? currentLease.term + 1 : 1;

      // Attempt atomic acquire using Compare-And-Swap
      const leaseRecord: LeaseRecord = {
        resourceId,
        term: newTerm,
        nodeId: this.nodeId,
        acquiredAt: now,
        expiresAt,
        renewCount: 0
      };

      const success = await this.atomicAcquire(key, leaseRecord, currentLease);
      
      if (success) {
        this.activeLeases.set(resourceId, leaseRecord);
        this.scheduleRenewal(resourceId, newTerm);
        
        console.log(`🔒 Acquired lease for resource ${resourceId}, term ${newTerm}`);
        return { term: newTerm, fenced: false };
      } else {
        // Another node acquired the lease
        const activeLease = await this.getCurrentLease(resourceId);
        console.log(`🚫 Failed to acquire lease for resource ${resourceId}, active term ${activeLease?.term}`);
        return { term: activeLease?.term || 0, fenced: true };
      }
    } catch (error) {
      console.error(`❌ Error acquiring lease for resource ${resourceId}:`, error);
      throw error;
    }
  }

  async renew(resourceId: string, term: number): Promise<boolean> {
    const lease = this.activeLeases.get(resourceId);
    if (!lease || lease.term !== term) {
      console.warn(`⚠️ Cannot renew lease for resource ${resourceId}, term mismatch`);
      return false;
    }

    try {
      const key = this.leaseKey(resourceId);
      const now = Date.now();
      const expiresAt = now + this.config.defaultTtlMs;

      const renewedLease: LeaseRecord = {
        ...lease,
        expiresAt,
        renewCount: lease.renewCount + 1
      };

      const success = await this.atomicRenew(key, renewedLease, term);
      
      if (success) {
        this.activeLeases.set(resourceId, renewedLease);
        console.log(`🔄 Renewed lease for resource ${resourceId}, term ${term}, renew count ${renewedLease.renewCount}`);
        return true;
      } else {
        console.warn(`🚫 Failed to renew lease for resource ${resourceId}, term ${term} - lease lost`);
        this.activeLeases.delete(resourceId);
        this.clearRenewalTimer(resourceId);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error renewing lease for resource ${resourceId}:`, error);
      return false;
    }
  }

  async release(resourceId: string, term: number): Promise<void> {
    const lease = this.activeLeases.get(resourceId);
    if (!lease || lease.term !== term) {
      console.warn(`⚠️ Cannot release lease for resource ${resourceId}, term mismatch`);
      return;
    }

    try {
      const key = this.leaseKey(resourceId);
      await this.atomicRelease(key, term);
      
      this.activeLeases.delete(resourceId);
      this.clearRenewalTimer(resourceId);
      
      console.log(`🔓 Released lease for resource ${resourceId}, term ${term}`);
    } catch (error) {
      console.error(`❌ Error releasing lease for resource ${resourceId}:`, error);
      throw error;
    }
  }

  async current(resourceId: string): Promise<number> {
    try {
      const lease = await this.getCurrentLease(resourceId);
      return lease?.term || 0;
    } catch (error) {
      console.error(`❌ Error getting current lease for resource ${resourceId}:`, error);
      return 0;
    }
  }

  private async getCurrentLease(resourceId: string): Promise<LeaseRecord | null> {
    const key = this.leaseKey(resourceId);
    
    try {
      const result = await this.etcdClient.get(key);
      if (result && result.value) {
        const lease = JSON.parse(result.value) as LeaseRecord;
        
        // Check if lease is expired
        if (lease.expiresAt <= Date.now()) {
          console.log(`⏰ Lease for resource ${resourceId} expired, term ${lease.term}`);
          return null;
        }
        
        return lease;
      }
      return null;
    } catch (error) {
      console.error(`❌ Error getting current lease for ${resourceId}:`, error);
      return null;
    }
  }

  private async atomicAcquire(key: string, newLease: LeaseRecord, currentLease: LeaseRecord | null): Promise<boolean> {
    try {
      if (currentLease && currentLease.expiresAt > Date.now()) {
        // Lease is still active, cannot acquire
        return false;
      }

      // Use Compare-And-Swap for atomic acquisition
      const expectedRevision = currentLease ? await this.getKeyRevision(key) : 0;
      const success = await this.etcdClient.putIfMatch(key, JSON.stringify(newLease), expectedRevision);
      
      return success;
    } catch (error) {
      console.error(`❌ Atomic acquire failed for key ${key}:`, error);
      return false;
    }
  }

  private async atomicRenew(key: string, renewedLease: LeaseRecord, expectedTerm: number): Promise<boolean> {
    try {
      // Verify current lease term matches expected term
      const currentLease = await this.getCurrentLease(renewedLease.resourceId);
      if (!currentLease || currentLease.term !== expectedTerm || currentLease.nodeId !== this.nodeId) {
        return false;
      }

      const success = await this.etcdClient.put(key, JSON.stringify(renewedLease));
      return success;
    } catch (error) {
      console.error(`❌ Atomic renew failed for key ${key}:`, error);
      return false;
    }
  }

  private async atomicRelease(key: string, expectedTerm: number): Promise<void> {
    try {
      // Verify we own the lease before releasing
      const currentLease = await this.getCurrentLease(key.split('/').pop()!);
      if (currentLease && currentLease.term === expectedTerm && currentLease.nodeId === this.nodeId) {
        await this.etcdClient.delete(key);
      }
    } catch (error) {
      console.error(`❌ Atomic release failed for key ${key}:`, error);
      throw error;
    }
  }

  private async getKeyRevision(key: string): Promise<number> {
    try {
      const result = await this.etcdClient.get(key);
      return result ? result.revision : 0;
    } catch (error) {
      return 0;
    }
  }

  private scheduleRenewal(resourceId: string, term: number): void {
    this.clearRenewalTimer(resourceId);
    
    const timer = setTimeout(async () => {
      const renewed = await this.renew(resourceId, term);
      if (renewed) {
        // Schedule next renewal
        this.scheduleRenewal(resourceId, term);
      }
    }, this.config.renewIntervalMs);
    
    this.renewalTimers.set(resourceId, timer);
  }

  private clearRenewalTimer(resourceId: string): void {
    const timer = this.renewalTimers.get(resourceId);
    if (timer) {
      clearTimeout(timer);
      this.renewalTimers.delete(resourceId);
    }
  }

  private leaseKey(resourceId: string): string {
    return `/distributed-core/leases/${resourceId}`;
  }

  // Cleanup method for graceful shutdown
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down ResourceLeaseManager...');
    
    // Clear all renewal timers
    for (const timer of this.renewalTimers.values()) {
      clearTimeout(timer);
    }
    this.renewalTimers.clear();
    
    // Release all active leases
    const releasePromises = Array.from(this.activeLeases.entries()).map(([resourceId, lease]) =>
      this.release(resourceId, lease.term).catch(error => 
        console.error(`Error releasing lease for ${resourceId}:`, error)
      )
    );
    
    await Promise.all(releasePromises);
    console.log('✅ ResourceLeaseManager shutdown complete');
  }
}
