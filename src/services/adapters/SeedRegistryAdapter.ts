import { ISeedRegistry } from '../ports';
import { SeedNodeInfo } from '../../config/BootstrapConfig';

/**
 * SeedRegistryAdapter adapts BootstrapConfig to ISeedRegistry interface
 */
export class SeedRegistryAdapter implements ISeedRegistry {
  constructor(private config: any) {}

  getBootstrapSeeds(): SeedNodeInfo[] {
    // Adapt from BootstrapConfig.getSeedNodes() to SeedNodeInfo[]
    const seedNodes = this.config.getSeedNodes?.() || [];
    return seedNodes.map((seed: string) => ({
      id: seed,
      address: seed.includes(':') ? seed.split(':')[0] : seed,
      port: seed.includes(':') ? parseInt(seed.split(':')[1], 10) : 8080,
      metadata: { endpoint: seed }
    }));
  }

  startHealthMonitoring(): void {
    // Placeholder for seed health monitoring
    console.log('[SeedRegistry] Started health monitoring');
  }

  stopHealthMonitoring(): void {
    // Placeholder for stopping health monitoring
    console.log('[SeedRegistry] Stopped health monitoring');
  }

  markSuccess(id: string): void {
    console.log(`[SeedRegistry] Marked seed ${id} as successful`);
  }

  markFailure(id: string, err?: Error): void {
    console.log(`[SeedRegistry] Marked seed ${id} as failed:`, err?.message);
  }
}
