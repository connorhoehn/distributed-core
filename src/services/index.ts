// Barrel file for services module

// Port interfaces
export {
  type Phase,
  type INetworkService,
  type ICommunicationService,
  type ISeedRegistry,
  type IStateSyncService,
  type IClientConnectionService,
  type INodeLifecycle
} from './ports';

// Top-level services (standalone, non-adapter versions)
export {
  ClientConnectionService,
  type ClientConnectionConfig
} from './ClientConnectionService';
export {
  NetworkService,
  type NetworkConfig,
  type NetworkTransports
} from './NetworkService';
export {
  NodeOrchestrationService,
  type NodeOrchestrationConfig
} from './NodeOrchestrationService';

// Adapter services (implement port interfaces, used by lifecycle phases)
export { ClientConnectionService as ClientConnectionAdapter } from './adapters/ClientConnectionService';
export { CommunicationService } from './adapters/CommunicationService';
export { NetworkService as NetworkServiceAdapter } from './adapters/NetworkService';
export { SeedRegistryAdapter } from './adapters/SeedRegistryAdapter';
export { StateSyncService } from './adapters/StateSyncService';

// Lifecycle
export { NodeLifecycle } from './lifecycle/NodeLifecycle';
export { InitPhase } from './lifecycle/phases/InitPhase';
export { NetworkPhase } from './lifecycle/phases/NetworkPhase';
export { MembershipPhase } from './lifecycle/phases/MembershipPhase';
export { StateSyncPhase } from './lifecycle/phases/StateSyncPhase';
export { ClientPhase } from './lifecycle/phases/ClientPhase';
export { ReadyPhase } from './lifecycle/phases/ReadyPhase';

// Wiring
export { ResourceWiring } from './wiring/ResourceWiring';
