/**
 * Node.ts
 * 
 * PRINCIPLES AND IDEALS
 * 
 * 1. Composability:
 *    - The Node class acts as a composition root for the distributed system runtime.
 *    - It integrates independent subsystems (cluster, router, messaging, sessions, connections, diagnostics).
 * 
 * 2. Encapsulation:
 *    - Node owns the full lifecycle and coordination of its internal components.
 *    - External systems interact with Node, not its internals, unless explicitly exposed.
 * 
 * 3. Observability:
 *    - Node provides a central place for diagnostics, chaos injection, metrics, and visibility into node state.
 * 
 * 4. Portability:
 *    - Designed to work in any environment (test harness, CLI launcher, embedded runtime, gateway process).
 * 
 * 5. Extendability:
 *    - The Node class is designed to evolve: adding RPC handlers, coordination protocols, or runtime plugins should not require rewriting core logic.
 * 
 * OBJECTIVES (CURRENT AND FUTURE)
 * 
 * ✅ Phase 1 - Core Runtime
 *    - Instantiate and manage ClusterManager, Router, and core handler registries.
 *    - Handle start() and stop() lifecycle hooks.
 *    - Provide a routeMessage() entry point for inbound messages.
 * 
 * 🛠️ Phase 2 - Runtime Identity and Discovery
 *    - Expose node metadata (id, region, labels).
 *    - Hook into membership protocols (gossip, failure detection).
 *    - Participate in consistent hashing ring.
 * 
 * 🔌 Phase 3 - Transport Integration
 *    - Allow external adapters (WebSocket, gRPC, in-memory) to call routeMessage().
 *    - Integrate session-level connection tracking and stream management.
 * 
 * 📡 Cluster Coordination and Orchestration
 *    - Participate in leader election, cluster health reporting, and sharded task assignment.
 *    - React to changes in membership or partitions.
 * 
 * 🔍 Phase 5 - Observability & Fault Injection
 *    - Integrate metrics and diagnostics tracking for local + remote events.
 *    - Inject synthetic faults and latency with ChaosInjector.
 * 
 * 🎯 Final Vision
 *    - Node represents a self-managing, runtime container that can participate
 *      in distributed coordination, handle routing, and provide observability.
 */

import { ClusterManager } from '../cluster/ClusterManager';
import { BootstrapConfig } from '../config/BootstrapConfig';
import { Router } from '../messaging/Router';
import { RoutedMessage, MessageHandler } from '../messaging/types';
import { ConnectionManager } from '../connections/ConnectionManager';
import { Session } from '../connections/Session';
import { NodeMetadata } from '../identity/NodeMetadata';
import { MetricsTracker } from '../monitoring/metrics/MetricsTracker';
import { ChaosInjector } from '../diagnostics/ChaosInjector';
import { Transport } from '../transport/Transport';
import { InMemoryAdapter } from '../transport/adapters/InMemoryAdapter';
import { NodeInfo, ClusterHealth, ClusterTopology, ClusterMetadata } from '../cluster/types';
import { Logger } from './logger';
import { HealthServer } from './HealthServer';

/**
 * Configuration options for creating a {@link Node} instance.
 *
 * @param id - Unique identifier for the node within the cluster.
 * @param transport - Optional custom transport; defaults to an in-memory adapter.
 * @param seedNodes - Addresses of existing cluster members used for bootstrapping.
 * @param lifecycle - Tuning knobs for graceful shutdown, draining, and rebalancing.
 */
export interface NodeConfig {
  id: string;
  clusterId?: string;        // For NodeMetadata
  service?: string;          // For NodeMetadata
  region?: string;
  zone?: string;
  role?: string;
  tags?: Record<string, string>;
  seedNodes?: string[];
  transport?: Transport;
  enableMetrics?: boolean;
  enableChaos?: boolean;
  enableLogging?: boolean;
  healthPort?: number;
  
  // Lifecycle configuration for shutdown behavior
  lifecycle?: {
    shutdownTimeout?: number;
    drainTimeout?: number;
    enableAutoRebalance?: boolean;
    rebalanceThreshold?: number;
    enableGracefulShutdown?: boolean;
    maxShutdownWait?: number;
  };
}

/**
 * The top-level runtime container for a distributed system participant.
 *
 * Node acts as the composition root, wiring together cluster management,
 * message routing, connection tracking, metrics, and chaos injection into
 * a single lifecycle-managed unit. External code interacts with Node rather
 * than its internal subsystems directly.
 *
 * Typical usage:
 * ```ts
 * const node = new Node({ id: 'node-1', seedNodes: ['host:3000'] });
 * await node.start();
 * node.registerHandler('chat', (msg, session) => { ... });
 * await node.stop();
 * ```
 */
export class Node {
  readonly id: string;
  readonly metadata: NodeMetadata;

  // Core subsystems
  readonly cluster: ClusterManager;
  readonly router: Router;
  readonly connections: ConnectionManager;
  readonly metrics: MetricsTracker | null;
  readonly chaos: ChaosInjector | null;

  private transport: Transport;
  private isStarted = false;
  private startedAt: number = 0;
  private enableLogging: boolean;
  private logger: Logger;
  private healthServer: HealthServer | null = null;

  /**
   * Create a new Node with the given configuration.
   * @param config - Node identity, networking, and feature-flag options.
   */
  constructor(config: NodeConfig) {
    this.id = config.id;
    this.enableLogging = config.enableLogging ?? false;
    this.logger = Logger.create(`Node:${config.id}`);

    // Initialize transport (default to InMemoryAdapter if not provided)
    this.transport = config.transport || new InMemoryAdapter({
      id: config.id,
      address: 'localhost',
      port: 0
    });

    // Initialize cluster management
    const bootstrapConfig = new BootstrapConfig(
      config.seedNodes || [],
      5000, // joinTimeout
      1000, // gossipInterval
      this.enableLogging
    );
    const nodeMetadata = {
      region: config.region,
      zone: config.zone,
      role: config.role,
      tags: config.tags
    };
    this.cluster = new ClusterManager(config.id, this.transport, bootstrapConfig, 100, nodeMetadata, config.lifecycle);

    // Initialize proper NodeMetadata with all required fields
    const keyManager = this.cluster.getKeyManager();
    const pubKey = keyManager ? keyManager.getPublicKey() : 'temp-key';
    
    this.metadata = new NodeMetadata(
      config.id,
      config.clusterId || 'default-cluster',
      config.service || 'distributed-core',
      config.zone || 'default-zone',
      config.region || 'default-region',
      pubKey
    );

    // Initialize other subsystems
    this.router = new Router();
    this.connections = new ConnectionManager();
    this.metrics = config.enableMetrics !== false ? new MetricsTracker() : null;
    this.chaos = config.enableChaos !== false ? new ChaosInjector() : null;

    // Set up optional HTTP health server
    if (config.healthPort) {
      this.healthServer = new HealthServer(
        config.healthPort,
        () => ({
          status: 'ok',
          nodeId: this.id,
          uptime: this.startedAt ? Date.now() - this.startedAt : 0,
          memberCount: this.getMemberCount(),
        }),
        () => {
          const membership = this.getMembership();
          const members = Array.from(membership.entries()).map(([id, entry]) => ({
            id,
            status: String(entry.status),
          }));
          return {
            nodeId: this.id,
            members,
            clusterHealth: this.getClusterHealth(),
          };
        },
        () => this.getMetrics(),
      );
    }

    // Register core message handlers
    this.registerCoreHandlers();
  }

  /**
   * Get node region from metadata
   */
  get region(): string {
    return this.metadata.region;
  }

  /**
   * Get node zone from metadata
   */
  get zone(): string {
    return this.metadata.zone;
  }

  /**
   * Start the node and all its subsystems (transport, cluster, metrics).
   * @throws If the node is already started or a subsystem fails to initialise.
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error(`Node ${this.id} is already started`);
    }

    try {
      // Start subsystems in order
      await this.transport.start();
      await this.cluster.start();
      
      // Note: MetricsTracker doesn't have start/stop methods yet - skip for now
      // if (this.metrics) {
      //   await this.metrics.start();
      // }

      // Set up transport message routing - this will depend on actual Transport API
      // this.transport.onMessage((message) => {
      //   this.routeMessage(message);
      // });

      this.isStarted = true;
      this.startedAt = Date.now();

      if (this.healthServer) {
        await this.healthServer.start();
      }

      if (this.enableLogging) {
        this.logger.info('Started successfully');
      }
    } catch (error) {
      if (this.enableLogging) {
        this.logger.error('Failed to start:', error);
      }
      await this.stop(); // Cleanup on failure
      throw error;
    }
  }

  /**
   * Gracefully stop the node, leaving the cluster and shutting down subsystems in reverse order.
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    try {
      // First, gracefully leave the cluster to notify other nodes
      try {
        if (this.cluster && typeof this.cluster.leave === 'function') {
          if (this.enableLogging) {
            this.logger.info('Gracefully leaving cluster...');
          }
          await this.cluster.leave(5000); // 5 second timeout for departure
        }
      } catch (leaveError) {
        if (this.enableLogging) {
          this.logger.warn('Graceful cluster leave failed:', leaveError);
        }
        // Continue with shutdown even if graceful leave fails
      }

      // Stop subsystems in reverse order
      // Note: MetricsTracker doesn't have start/stop methods yet - skip for now
      // if (this.metrics) {
      //   await this.metrics.stop();
      // }
      
      await this.cluster.stop();
      await this.transport.stop();
      
      if (this.healthServer) {
        await this.healthServer.stop();
      }

      // Close all connections to clean up timers
      this.connections.closeAll();

      this.isStarted = false;
      if (this.enableLogging) {
        this.logger.info('Stopped successfully');
      }
    } catch (error) {
      if (this.enableLogging) {
        this.logger.error('Error during stop:', error);
      }
      throw error;
    }
  }

  /**
   * Route an incoming message through the node's registered handlers.
   * @param message - The message to route.
   * @param session - Optional session context; a default session is used if omitted.
   */
  routeMessage(message: RoutedMessage, session?: Session): void {
    try {
      // Router expects a Session, so create a default one if not provided
      const defaultSession = session || new Session('default', {});
      this.router.route(message, defaultSession);
      
      // Track metrics if enabled - MetricsTracker doesn't have track method yet
      // if (this.metrics) {
      //   this.metrics.track('messages.routed', 1);
      // }
    } catch (error) {
      if (this.enableLogging) {
        this.logger.error('Failed to route message:', error);
      }
      // if (this.metrics) {
      //   this.metrics.track('messages.routing_errors', 1);
      // }
    }
  }

  /**
   * Get node information
   */
  getNodeInfo(): NodeInfo {
    return this.cluster.getNodeInfo();
  }

  /**
   * Get cluster health information
   */
  getClusterHealth(): ClusterHealth {
    return this.cluster.getClusterHealth();
  }

  /**
   * Get cluster topology information
   */
  getClusterTopology(): ClusterTopology {
    return this.cluster.getTopology();
  }

  /**
   * Get cluster metadata
   */
  getClusterMetadata(): ClusterMetadata {
    return this.cluster.getMetadata();
  }

  /**
   * Get the nodes responsible for a given key
   */
  getReplicaNodes(key: string, replicationFactor: number = 3): string[] {
    return this.cluster.getReplicaNodes(key, replicationFactor);
  }

  /**
   * Return the current cluster membership as a map of node ID to {@link MembershipEntry}.
   */
  getMembership() {
    return this.cluster.getMembership();
  }

  /**
   * Get member count
   */
  getMemberCount(): number {
    return this.cluster.getMemberCount();
  }

  /**
   * Inject chaos for testing - ChaosInjector doesn't have inject method yet
   */
  injectChaos(scenario: string, config: any): void {
    // TODO: implement when ChaosInjector has inject method
    // if (this.chaos) {
    //   this.chaos.inject(scenario, config);
    // }
    if (this.enableLogging) {
      this.logger.info(`Chaos injection requested: ${scenario}`, config);
    }
  }

  /**
   * Get current metrics - MetricsTracker doesn't have getMetrics method yet
   */
  getMetrics(): any {
    // TODO: implement when MetricsTracker has getMetrics method
    // return this.metrics ? this.metrics.getMetrics() : {};
    return { nodeId: this.id, isStarted: this.isStarted };
  }

  /**
   * Check if node is started
   */
  isRunning(): boolean {
    return this.isStarted;
  }

  /**
   * Register a handler that will be invoked for messages of the given type.
   * @param messageType - The message type string to match against.
   * @param handlerFn - Callback invoked with the matched message and its session.
   */
  registerHandler(messageType: string, handlerFn: (message: RoutedMessage, session: Session) => void): void {
    const handler: MessageHandler = {
      handle: handlerFn
    };
    this.router.register(messageType, handler);
  }

  /**
   * Create a new connection (since ConnectionManager doesn't have createSession)
   */
  createConnection(connectionId: string, sendFn: any, metadata: any = {}): any {
    return this.connections.createConnection(connectionId, sendFn, metadata);
  }

  /**
   * Get an existing session
   */
  getSession(sessionId: string): Session | undefined {
    return this.connections.getSession(sessionId);
  }

  /**
   * Register core system handlers with proper MessageHandler interface
   */
  private registerCoreHandlers(): void {
    // Health check handler
    this.registerHandler('health', (message: RoutedMessage, session: Session) => {
      // For now, just log the health check - proper response handling would need Transport integration
      if (this.enableLogging) {
        this.logger.info('Health check requested', {
          status: 'healthy',
          nodeId: this.id,
          uptime: this.isStarted ? Date.now() : 0,
          memberCount: this.getMemberCount()
        });
      }
    });

    // Cluster info handler
    this.registerHandler('cluster-info', (message: RoutedMessage, session: Session) => {
      if (this.enableLogging) {
        this.logger.info('Cluster info requested', {
          nodeInfo: this.getNodeInfo(),
          health: this.getClusterHealth(),
          topology: this.getClusterTopology(),
          metadata: this.getClusterMetadata()
        });
      }
    });

    // Metrics handler
    this.registerHandler('metrics', (message: RoutedMessage, session: Session) => {
      if (this.enableLogging) {
        this.logger.info('Metrics requested', this.getMetrics());
      }
    });

    // Echo handler for testing
    this.registerHandler('echo', (message: RoutedMessage, session: Session) => {
      if (this.enableLogging) {
        this.logger.info('Echo response', {
          echo: message['payload'] as unknown,
          from: this.id,
          timestamp: Date.now()
        });
      }
    });
  }
}
