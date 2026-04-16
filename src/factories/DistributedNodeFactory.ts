import { Node, NodeConfig } from '../common/Node';
import { ClusterManager } from '../cluster/ClusterManager';
import { ResourceRegistry, ResourceRegistryConfig } from '../resources/core/ResourceRegistry';
import { ResourceManager } from '../resources/management/ResourceManager';
import { ResourceAttachmentService } from '../resources/attachment/ResourceAttachmentService';
import { ResourceDistributionEngine } from '../resources/distribution/ResourceDistributionEngine';
import { ClusterFanoutRouter } from '../resources/distribution/ClusterFanoutRouter';
import { ResourceOperation, VectorClock } from '../resources/core/ResourceOperation';
import { Transport } from '../transport/Transport';
import { WebSocketAdapter } from '../transport/adapters/WebSocketAdapter';
import { TCPAdapter } from '../transport/adapters/TCPAdapter';
import { ConnectionManager } from '../connections/ConnectionManager';
import { NodeId } from '../types';
import { EntityRegistryType } from '../cluster/core/entity/EntityRegistryFactory';
import { ClusterRouting } from '../routing/ClusterRouting';
import { ResourceManagementFactory } from '../resources/core/ResourceManagementFactory';
import { IntegratedCommunicationLayer } from '../communication/core/IntegratedCommunicationLayer';
import { SemanticsConfig } from '../communication/semantics/SemanticsConfig';

// NEW IMPORTS: Phase-based lifecycle services
import { NodeLifecycle } from '../services/lifecycle/NodeLifecycle';
import { InitPhase } from '../services/lifecycle/phases/InitPhase';
import { NetworkPhase } from '../services/lifecycle/phases/NetworkPhase';
import { MembershipPhase } from '../services/lifecycle/phases/MembershipPhase';
import { StateSyncPhase } from '../services/lifecycle/phases/StateSyncPhase';
import { ClientPhase } from '../services/lifecycle/phases/ClientPhase';
import { ReadyPhase } from '../services/lifecycle/phases/ReadyPhase';
import { NetworkService } from '../services/adapters/NetworkService';
import { CommunicationService } from '../services/adapters/CommunicationService';
import { StateSyncService } from '../services/adapters/StateSyncService';
import { ClientConnectionService } from '../services/adapters/ClientConnectionService';
import { SeedRegistryAdapter } from '../services/adapters/SeedRegistryAdapter';
import { ResourceWiring } from '../services/wiring/ResourceWiring';


/**
 * Extended node configuration for fully-featured distributed nodes, including
 * transport selection, resource management, network binding, and cluster tuning.
 */
export interface DistributedNodeConfig extends Omit<NodeConfig, 'transport'> {
  // Network transport configuration
  transport?: {
    type: 'websocket' | 'tcp' | 'grpc' | 'custom';
    options?: any;
    customTransport?: Transport;
  };

  // Resource management configuration
  resources?: {
    enableProductionScale?: boolean;
    enableAttachmentService?: boolean;
    enableDistributionEngine?: boolean;
    registryConfig?: any;
  };

  // Network address configuration
  network?: {
    address: string;
    port: number;
    host?: string;
  };

  // Advanced cluster configuration
  cluster?: {
    virtualNodesPerNode?: number;
    replicationFactor?: number;
    enableAntiEntropy?: boolean;
  };

  // Semantics configuration for integrated communication layer
  semantics?: SemanticsConfig;
}

/** The set of fully-wired components returned after creating a distributed node. */
export interface DistributedNodeComponents {
  node: Node;
  clusterManager: ClusterManager;
  resourceManager?: ResourceManager;
  resourceAttachment?: ResourceAttachmentService;
  resourceDistribution?: ResourceDistributionEngine;
  clusterFanoutRouter?: ClusterFanoutRouter;
  clusterTransport: Transport;  // node↔node transport
  clientTransport: Transport;   // client↔node transport
  comms?: IntegratedCommunicationLayer;
}

/**
 * Singleton factory that assembles a complete distributed node stack from a
 * {@link DistributedNodeConfig}: transport layer, cluster manager, resource
 * management, communication layer, and a phase-based lifecycle.
 *
 * Use the fluent {@link DistributedNodeBuilder} (via {@link DistributedNodeFactory.builder})
 * for ergonomic configuration:
 *
 * ```ts
 * const components = await DistributedNodeFactory.builder()
 *   .id('node-1')
 *   .network('127.0.0.1', 4000)
 *   .transport('websocket')
 *   .seedNodes(['127.0.0.1:4001'])
 *   .enableResources()
 *   .build();
 *
 * // components.node, components.clusterManager, components.resourceManager, etc.
 * ```
 *
 * Supports two primary data-flow paths:
 * 1. **Inbound** -- Client request flows through ConnectionManager, ResourceAttachmentService,
 *    ResourceManager, ClusterFanoutRouter, and out via the network transport to remote nodes.
 * 2. **Outbound** -- Local resource changes propagate via ResourceDistributionEngine and
 *    ClusterManager to all cluster members, which feed them back through
 *    ResourceAttachmentService to local client connections.
 */
export class DistributedNodeFactory {
  private static instance: DistributedNodeFactory;

  static getInstance(): DistributedNodeFactory {
    if (!DistributedNodeFactory.instance) {
      DistributedNodeFactory.instance = new DistributedNodeFactory();
    }
    return DistributedNodeFactory.instance;
  }

  private constructor() {}

  /**
   * Create a fully configured distributed node, wire all subsystems, and run the phase-based lifecycle.
   * @param config - Full distributed node configuration.
   * @returns All wired components, ready for use.
   */
  async createNode(config: DistributedNodeConfig): Promise<DistributedNodeComponents> {
    // 1. Create cluster transport (node↔node) and client transport (client↔node)
    const clusterTransport = this.createTransport(config, 'cluster');
    const clientTransport = this.createTransport(config, 'client');

    // 2. Create base node configuration (use cluster transport for inter-node comms)
    const nodeConfig: NodeConfig = {
      ...config,
      transport: clusterTransport
    };

    // 3. Create base node
    const node = new Node(nodeConfig);

    // 4. Get cluster manager reference
    const clusterManager = node.cluster;

    // 5. Create resource management components if enabled
    let resourceManager: ResourceManager | undefined;
    let resourceAttachment: ResourceAttachmentService | undefined;
    let resourceDistribution: ResourceDistributionEngine | undefined;
    let clusterFanoutRouter: ClusterFanoutRouter | undefined;

    if (config.resources?.enableProductionScale !== false) {
      // Create ResourceRegistry with proper configuration
      const resourceRegistryConfig: ResourceRegistryConfig = {
        nodeId: config.id,
        entityRegistryType: 'memory' as const,
        clusterManager
      };
      const resourceRegistry = new ResourceRegistry(resourceRegistryConfig);
      
      // Create ResourceManager
      resourceManager = new ResourceManager(
        resourceRegistry,
        clusterManager,
        node.metrics!
      );

      // Create ResourceAttachmentService if enabled
      if (config.resources?.enableAttachmentService !== false) {
        resourceAttachment = new ResourceAttachmentService(node.connections);
      }

      // Create ResourceDistributionEngine if enabled
      if (config.resources?.enableDistributionEngine !== false) {
        resourceDistribution = new ResourceDistributionEngine(
          resourceRegistry,
          clusterManager
        );
      }

      // Create ClusterFanoutRouter (pure routing with clusterManager)
      clusterFanoutRouter = new ClusterFanoutRouter(
        clusterManager,
        {
          preferPrimary: true,
          replicationFactor: 2,
          useGossipFallback: true
        }
      );
    }

    // 6. Create integrated communication layer if resources are enabled
    let comms: IntegratedCommunicationLayer | undefined;
    if (config.resources?.enableProductionScale !== false) {
      // Create client adapter interface for ResourceManagementFactory
      const clientAdapter = {
        connectionManager: node.connections,
        async start() {
          await clientTransport.start();
        },
        async stop() {
          await clientTransport.stop();
        }
      };

      // Create cluster adapter interface
      const clusterAdapter = {
        async start() {
          await clusterTransport.start();
        },
        async stop() {
          await clusterTransport.stop();
        }
      };

      // Create integrated communication layer using SOLID factory
      const result = ResourceManagementFactory.createIntegratedCommunicationLayer({
        clusterManager,
        clientAdapter: clientAdapter as any,
        semantics: config.semantics
      });

      comms = result.layer;
    }

    // 7. Build service adapters (NEW: Replace direct wiring with service layer)
    const networkService = new NetworkService(clusterTransport, clientTransport);
    const communicationService = new CommunicationService(clusterManager.getCommunication());
    const seedRegistry = new SeedRegistryAdapter(clusterManager.config);
    const stateSyncService = new StateSyncService(/* deltaSyncEngine, stateReconciler, walCoordinator */);
    const clientConnectionService = new ClientConnectionService(
      node.connections,
      resourceAttachment,
      resourceManager,
      clusterFanoutRouter,
      clusterManager,
      comms
    );

    // 8. Set up resource wiring for cluster distribution (Workflow 2 from old wireComponents)
    if (resourceManager && resourceDistribution && clusterFanoutRouter && resourceAttachment) {
      const resourceWiring = new ResourceWiring(
        resourceManager,
        resourceDistribution,
        clusterFanoutRouter,
        clusterManager,
        resourceAttachment
      );
      resourceWiring.setupResourceEventHandlers();
      resourceWiring.setupClusterMessageHandlers();
    }

    // 9. Create and start lifecycle with ordered phases
    const lifecycle = new NodeLifecycle([
      new InitPhase(seedRegistry),
      new NetworkPhase(networkService, communicationService),
      new MembershipPhase(seedRegistry, communicationService, 5000),
      new StateSyncPhase(stateSyncService),
      new ClientPhase(clientConnectionService, networkService),
      new ReadyPhase()
    ]);

    // Start the node lifecycle (replaces wireComponents call)
    await lifecycle.start();

    return {
      node,
      clusterManager,
      resourceManager,
      resourceAttachment,
      resourceDistribution,
      clusterFanoutRouter,
      clusterTransport,
      clientTransport,
      comms
    };
  }

  /**
   * Create transport based on configuration
   * @param config Node configuration
   * @param type 'cluster' for node↔node or 'client' for client↔node
   */
  private createTransport(config: DistributedNodeConfig, type: 'cluster' | 'client' = 'cluster'): Transport {
    if (config.transport?.customTransport) {
      return config.transport.customTransport;
    }

    if (!config.network) {
      throw new Error('Network configuration required for distributed node');
    }

    const nodeId: NodeId = {
      id: config.id,
      address: config.network.address,
      port: config.network.port
    };

    const transportType = config.transport?.type || 'websocket';
    const transportOptions = config.transport?.options || {};

    // For client transport, add offset to port to avoid conflicts
    const portOffset = type === 'client' ? 1000 : 0;
    const effectivePort = config.network.port + portOffset;

    switch (transportType) {
      case 'websocket':
        return new WebSocketAdapter({
          id: config.id,
          address: config.network.address,
          port: effectivePort
        }, {
          host: config.network.host || '0.0.0.0',
          port: effectivePort,
          ...transportOptions
        });

      case 'tcp':
        return new TCPAdapter({
          id: config.id,
          address: config.network.address,
          port: effectivePort
        }, {
          host: config.network.host || '0.0.0.0',
          port: effectivePort,
          ...transportOptions
        });

      case 'grpc':
        throw new Error('gRPC transport is not yet supported. Use "websocket" or "tcp" instead.');

      default:
        throw new Error(`Unsupported transport type: ${transportType}`);
    }
  }

  /**
   * Wire components together to support the desired workflows
   */
  /**
   * DEPRECATED: Wire components together to support the desired workflows
   * 
   * This method has been replaced by phase-based lifecycle services.
   * All wiring logic has been moved to:
   * - ClientConnectionService (client message handlers)
   * - ResourceWiring (resource registry event handlers)
   * - Phase services (NetworkPhase, MembershipPhase, etc.)
   */
  private async wireComponents(components: DistributedNodeComponents): Promise<void> {
    // This method is now a no-op. All wiring logic has been moved to service layers.
    // The factory only composes services; runtime behavior is handled by services.
    console.log('✅ Component wiring handled by service layer');
  }

  /**
   * Create a proper ResourceOperation from resource data
   */
  private createResourceOperation(type: 'CREATE' | 'UPDATE' | 'DELETE', resource: any): ResourceOperation {
    // Simple VectorClock implementation
    const vectorClock: VectorClock = {
      nodeId: resource.nodeId || 'unknown',
      vector: new Map(),
      increment: function() { return this; },
      compare: function() { return 0; },
      merge: function(other) { return this; }
    };

    return {
      opId: `${type.toLowerCase()}-${resource.resourceId}-${Date.now()}`,
      resourceId: resource.resourceId,
      type: type,
      version: resource.version || 1,
      timestamp: Date.now(),
      originNodeId: resource.nodeId || 'unknown',
      payload: resource,
      vectorClock,
      correlationId: `${type.toLowerCase()}-${Date.now()}`,
      leaseTerm: 1,
      metadata: {}
    };
  }

  /**
   * Return a new {@link DistributedNodeBuilder} for fluent, step-by-step configuration.
   */
  static builder(): DistributedNodeBuilder {
    return new DistributedNodeBuilder();
  }
}

/**
 * Fluent builder for incrementally constructing a {@link DistributedNodeConfig}
 * and producing a fully-wired {@link DistributedNodeComponents} via {@link build}.
 *
 * All setter methods return `this` for chaining. Call {@link build} to validate
 * the configuration and delegate to {@link DistributedNodeFactory.createNode}.
 */
export class DistributedNodeBuilder {
  private config: DistributedNodeConfig = {
    id: '',
    region: 'default-region',
    zone: 'default-zone',
    role: 'worker'
  };

  id(id: string): this {
    this.config.id = id;
    return this;
  }

  region(region: string): this {
    this.config.region = region;
    return this;
  }

  zone(zone: string): this {
    this.config.zone = zone;
    return this;
  }

  role(role: string): this {
    this.config.role = role;
    return this;
  }

  network(address: string, port: number, host?: string): this {
    this.config.network = { address, port, host };
    return this;
  }

  transport(type: 'websocket' | 'tcp' | 'grpc', options?: any): this {
    this.config.transport = { type, options };
    return this;
  }

  customTransport(transport: Transport): this {
    this.config.transport = { type: 'custom', customTransport: transport };
    return this;
  }

  seedNodes(seeds: string[]): this {
    this.config.seedNodes = seeds;
    return this;
  }

  enableResources(options: {
    productionScale?: boolean;
    attachmentService?: boolean;
    distributionEngine?: boolean;
  } = {}): this {
    this.config.resources = {
      enableProductionScale: options.productionScale !== false,
      enableAttachmentService: options.attachmentService !== false,
      enableDistributionEngine: options.distributionEngine !== false
    };
    return this;
  }

  enableMetrics(enabled: boolean = true): this {
    this.config.enableMetrics = enabled;
    return this;
  }

  enableLogging(enabled: boolean = true): this {
    this.config.enableLogging = enabled;
    return this;
  }

  semantics(semantics: SemanticsConfig): this {
    this.config.semantics = semantics;
    return this;
  }

  /**
   * Validate the accumulated configuration and create the distributed node.
   * @throws If `id` or `network` configuration is missing.
   */
  async build(): Promise<DistributedNodeComponents> {
    if (!this.config.id) {
      throw new Error('Node ID is required');
    }
    if (!this.config.network) {
      throw new Error('Network configuration is required');
    }

    const factory = DistributedNodeFactory.getInstance();
    return await factory.createNode(this.config);
  }
}
