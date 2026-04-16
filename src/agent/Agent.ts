/**
 * Agent.ts
 *
 * A lightweight management facade over Node, ClusterManager, and optionally
 * ResourceRegistry.  Agent does not add new functionality -- it provides a
 * clean, high-level API for cluster management operations that would
 * otherwise require reaching into multiple subsystems.
 */

import { Node } from '../common/Node';
import { ResourceRegistry } from '../resources/core/ResourceRegistry';
import { NodeInfo, ClusterHealth, ClusterTopology, ClusterMetadata, MembershipEntry } from '../cluster/types';
import { ResourceMetadata } from '../resources/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Human-readable label for this agent instance. */
  name?: string;

  /** Optional resource registry for resource-level operations. */
  resourceRegistry?: ResourceRegistry;

  /** When true, include verbose diagnostics in health reports. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface ClusterStatus {
  health: ClusterHealth;
  topology: ClusterTopology;
  metadata: ClusterMetadata;
}

export interface MemberInfo {
  id: string;
  status: string;
  lastSeen: number;
  version: number;
  metadata?: Record<string, unknown>;
}

export interface ResourceSummary {
  id: string;
  type: string;
  state: string;
  nodeId: string;
}

export interface ResourceDetail extends ResourceSummary {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  health: string;
  tags?: Record<string, string>;
  capacity?: { current: number; maximum: number; reserved: number; unit?: string };
}

export interface HealthStatus {
  nodeId: string;
  running: boolean;
  clusterHealthy: boolean;
  memberCount: number;
  resourceCount: number | null;
}

export interface DiagnosticReport {
  timestamp: number;
  node: NodeInfo;
  cluster: ClusterStatus;
  members: MemberInfo[];
  resources: ResourceSummary[] | null;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * Agent provides a management interface for a distributed node.
 * It wraps a Node and exposes high-level operations for cluster management.
 */
export class Agent {
  private started = false;

  constructor(
    private readonly node: Node,
    private readonly config: AgentConfig = {},
  ) {}

  // -- Accessors ------------------------------------------------------------

  /** The underlying Node instance. */
  getNode(): Node {
    return this.node;
  }

  /** The agent name (falls back to the node id). */
  get name(): string {
    return this.config.name ?? this.node.id;
  }

  /** Whether the agent has been started. */
  isRunning(): boolean {
    return this.started;
  }

  // -- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(`Agent "${this.name}" is already started`);
    }
    if (!this.node.isRunning()) {
      await this.node.start();
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    if (this.node.isRunning()) {
      await this.node.stop();
    }
    this.started = false;
  }

  // -- Cluster operations ---------------------------------------------------

  async getClusterStatus(): Promise<ClusterStatus> {
    return {
      health: this.node.getClusterHealth(),
      topology: this.node.getClusterTopology(),
      metadata: this.node.getClusterMetadata(),
    };
  }

  async getNodeInfo(): Promise<NodeInfo> {
    return this.node.getNodeInfo();
  }

  async listMembers(): Promise<MemberInfo[]> {
    const membership = this.node.getMembership();
    const members: MemberInfo[] = Array.from(membership.entries()).map(([id, entry]) => ({
      id,
      status: entry.status,
      lastSeen: entry.lastSeen,
      version: entry.version,
      metadata: entry.metadata as Record<string, unknown> | undefined,
    }));

    return members;
  }

  // -- Resource operations --------------------------------------------------

  async listResources(type?: string): Promise<ResourceSummary[]> {
    const registry = this.config.resourceRegistry;
    if (!registry) {
      return [];
    }

    const resources: ResourceMetadata[] = type
      ? registry.getResourcesByType(type)
      : registry.getAllResources();

    return resources.map(toResourceSummary);
  }

  async getResource(id: string): Promise<ResourceDetail | null> {
    const registry = this.config.resourceRegistry;
    if (!registry) {
      return null;
    }

    const resource = registry.getResource(id);
    if (!resource) {
      return null;
    }

    return toResourceDetail(resource);
  }

  // -- Health / diagnostics -------------------------------------------------

  async getHealth(): Promise<HealthStatus> {
    const registry = this.config.resourceRegistry;
    const clusterHealth = this.node.getClusterHealth();

    return {
      nodeId: this.node.id,
      running: this.node.isRunning(),
      clusterHealthy: clusterHealth.isHealthy,
      memberCount: this.node.getMemberCount(),
      resourceCount: registry ? registry.getAllResources().length : null,
    };
  }

  async runDiagnostics(): Promise<DiagnosticReport> {
    const [nodeInfo, cluster, members, resources] = await Promise.all([
      this.getNodeInfo(),
      this.getClusterStatus(),
      this.listMembers(),
      this.config.resourceRegistry ? this.listResources() : Promise.resolve(null),
    ]);

    return {
      timestamp: Date.now(),
      node: nodeInfo,
      cluster,
      members,
      resources,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResourceSummary(r: ResourceMetadata): ResourceSummary {
  return {
    id: r.resourceId,
    type: r.resourceType,
    state: r.state,
    nodeId: r.nodeId,
  };
}

function toResourceDetail(r: ResourceMetadata): ResourceDetail {
  return {
    ...toResourceSummary(r),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    health: r.health,
    tags: r.tags,
    capacity: r.capacity,
  };
}
