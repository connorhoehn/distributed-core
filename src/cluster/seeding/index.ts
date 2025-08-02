/**
 * Advanced Seed Node Management System
 * 
 * Provides structured seed node management with health monitoring,
 * discovery capabilities, and backward compatibility.
 */

export { SeedNodeInfo, SeedNodeHealthStatus, SeedNodeRegistry } from './SeedNodeRegistry';
export { 
  SeedDiscoveryStrategy, 
  SeedDiscoveryConfig, 
  DiscoveryResult, 
  SeedNodeDiscovery 
} from './SeedNodeDiscovery';

// The enhanced BootstrapConfig is now the main BootstrapConfig in ../config/
// This maintains backward compatibility while adding advanced features
