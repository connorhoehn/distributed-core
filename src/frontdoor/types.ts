import { Transport } from '../transport/Transport';
import { RangeHandler } from '../coordinators/types';

/**
 * Options for creating a single node via createNode().
 * All fields are optional with sensible defaults.
 */
export interface NodeOptions {
  /** Node identifier. Auto-generated via createId if omitted. */
  id?: string;
  /** Bind address for the transport layer. Default: '127.0.0.1' */
  address?: string;
  /** Port for the transport layer. Default: 0 (ephemeral) */
  port?: number;
  /** Transport type string or pre-constructed Transport instance. Default: 'in-memory' */
  transport?: 'in-memory' | 'websocket' | 'tcp' | 'udp' | 'http' | Transport;
  /** Seed node addresses for cluster discovery. Default: [] */
  seedNodes?: string[];
  /** Geographic region metadata. */
  region?: string;
  /** Availability zone metadata. */
  zone?: string;
  /** Node role (e.g. 'worker', 'coordinator'). */
  role?: string;
  /** Arbitrary key-value tags for this node. */
  tags?: Record<string, string>;
  /** Cluster identifier. Default: 'default-cluster' */
  clusterId?: string;
  /** Persistence backend type. Default: 'memory' */
  persistence?: 'memory' | 'wal';
  /** Gossip protocol interval in ms. */
  gossipInterval?: number;
  /** Timeout for joining the cluster in ms. */
  joinTimeout?: number;
  /** Enable metrics tracking. Default: true */
  metrics?: boolean;
  /** Enable diagnostics subsystem. Default: false */
  diagnostics?: boolean;
  /** Enable chaos injection subsystem. Default: false */
  chaos?: boolean;
  /** Enable logging output. Default: false */
  logging?: boolean;
  /** Automatically start the node after creation. Default: false */
  autoStart?: boolean;
}

/**
 * Options for creating a multi-node cluster via createCluster().
 */
export interface ClusterOptions {
  /** Number of nodes to create. Default: 3 */
  size?: number;
  /** Starting port for sequential allocation. Default: 0 (ephemeral) */
  basePort?: number;
  /** Transport type for all nodes. Default: 'in-memory' */
  transport?: 'in-memory' | 'websocket' | 'tcp' | 'udp' | 'http';
  /** Default options applied to every node. */
  nodeDefaults?: Partial<NodeOptions>;
  /** Per-node option overrides (merged on top of nodeDefaults). */
  nodes?: Partial<NodeOptions>[];
  /** Automatically start all nodes after creation. Default: false */
  autoStart?: boolean;
  /** Delay between sequential node starts in ms. Default: 100 */
  startupDelay?: number;
  /** Shared cluster identifier. Auto-generated if omitted. */
  clusterId?: string;
}

/**
 * Options for creating an agent node (node + range coordinator) via createAgent().
 * Extends NodeOptions with coordinator-specific configuration.
 */
export interface AgentOptions extends NodeOptions {
  /** Coordinator backend type. Default: 'in-memory' */
  coordinator?: 'in-memory' | 'gossip' | 'etcd' | 'zookeeper';
  /** Ring identifier for range coordination. Default: 'default-ring' */
  ringId?: string;
  /** Required: handler for range lifecycle and message processing. */
  rangeHandler: RangeHandler;
  /** Extra configuration passed to the coordinator backend. */
  coordinatorConfig?: Record<string, any>;
}
