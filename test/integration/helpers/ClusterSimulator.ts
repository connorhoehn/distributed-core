/**
 * ClusterSimulator — multi-node in-process test harness.
 *
 * Each simulated node gets:
 *  - Its own InMemoryEntityRegistry
 *  - A view of the shared in-memory PubSub bus (partition-aware)
 *  - An EntityRegistrySyncAdapter auto-started on the shared bus
 *  - A FakeClusterManager stub (membership table)
 *  - A ResourceRouter wired to that registry + cluster
 *  - A DistributedLock wired to the shared registry (via sync adapter)
 *
 * Partition model: a Map<nodeId, Set<nodeId>> of reachable peers. When A
 * publishes, the message is delivered only to nodes in A's reachable set.
 * heal() restores full connectivity; partition() slices the cluster.
 */

import { EventEmitter } from 'events';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../src/cluster/entity/types';
import { EntityRegistrySyncAdapter } from '../../../src/cluster/entity/EntityRegistrySyncAdapter';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { DistributedLock } from '../../../src/cluster/locks/DistributedLock';
import { PubSubMessageMetadata } from '../../../src/gateway/pubsub/types';
import { MembershipEntry } from '../../../src/cluster/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulatedNodeConfig {
  nodeId: string;
  address?: string;
  port?: number;
}

export interface SimulatedPubSub {
  subscribe(topic: string, handler: (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void): string;
  unsubscribe(id: string): void;
  publish(topic: string, payload: unknown): Promise<void>;
}

export interface SimulatedNode {
  nodeId: string;
  pubsub: SimulatedPubSub;
  registry: EntityRegistry;
  sync: EntityRegistrySyncAdapter;
  cluster: FakeClusterManager;
  router: ResourceRouter;
  lock: DistributedLock;
}

// ---------------------------------------------------------------------------
// FakeClusterManager
// ---------------------------------------------------------------------------

export class FakeClusterManager extends EventEmitter {
  readonly localNodeId: string;
  private readonly simulator: ClusterSimulator;

  constructor(localNodeId: string, simulator: ClusterSimulator) {
    super();
    this.localNodeId = localNodeId;
    this.simulator = simulator;
  }

  getMembership(): Map<string, MembershipEntry> {
    // Returns only nodes reachable from this node (respects partitions)
    const all = this.simulator.nodes();
    const reachable = this.simulator.getReachable(this.localNodeId);
    const result = new Map<string, MembershipEntry>();
    for (const node of all) {
      if (reachable.has(node.nodeId)) {
        result.set(node.nodeId, {
          id: node.nodeId,
          status: 'ALIVE',
          lastSeen: Date.now(),
          version: 1,
          lastUpdated: Date.now(),
          metadata: {
            address: this.simulator.getAddress(node.nodeId),
            port: this.simulator.getPort(node.nodeId),
          },
        } as MembershipEntry);
      }
    }
    return result;
  }

  getLocalNodeInfo(): object {
    return {
      id: this.localNodeId,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      metadata: {
        address: this.simulator.getAddress(this.localNodeId),
        port: this.simulator.getPort(this.localNodeId),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Shared in-memory PubSub bus
// ---------------------------------------------------------------------------

interface SubRecord {
  nodeId: string;
  topic: string;
  handler: (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void;
  id: string;
}

class SharedPubSubBus {
  private readonly subs: SubRecord[] = [];
  private idCounter = 0;

  /** Reachability map: nodeId -> Set of nodeIds that can receive messages from it */
  private reachability: Map<string, Set<string>> | null = null;
  /** Killed nodes: no messages delivered to/from them */
  private killed: Set<string> = new Set();

  bind(nodeId: string): SimulatedPubSub {
    const bus = this;
    return {
      subscribe(topic, handler) {
        const id = `${nodeId}-sub-${bus.idCounter++}`;
        bus.subs.push({ nodeId, topic, handler, id });
        return id;
      },
      unsubscribe(id) {
        const idx = bus.subs.findIndex((s) => s.id === id);
        if (idx !== -1) bus.subs.splice(idx, 1);
      },
      async publish(topic, payload) {
        if (bus.killed.has(nodeId)) return;

        const meta: PubSubMessageMetadata = {
          publisherNodeId: nodeId,
          messageId: `msg-${nodeId}-${bus.idCounter++}`,
          timestamp: Date.now(),
          topic,
        };

        const reachable = bus.reachability?.get(nodeId) ?? null;

        for (const sub of [...bus.subs]) {
          if (bus.killed.has(sub.nodeId)) continue;
          if (reachable !== null && !reachable.has(sub.nodeId)) continue;
          sub.handler(topic, payload, meta);
        }
      },
    };
  }

  setReachability(map: Map<string, Set<string>> | null): void {
    this.reachability = map;
  }

  kill(nodeId: string): void {
    this.killed.add(nodeId);
    // Remove all subscriptions for this node
    let i = this.subs.length;
    while (i--) {
      if (this.subs[i].nodeId === nodeId) {
        this.subs.splice(i, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ClusterSimulator
// ---------------------------------------------------------------------------

export class ClusterSimulator {
  private readonly configs: Map<string, SimulatedNodeConfig> = new Map();
  private readonly _nodes: Map<string, SimulatedNode> = new Map();
  private readonly bus: SharedPubSubBus = new SharedPubSubBus();
  private reachabilityMap: Map<string, Set<string>> | null = null;
  private killed: Set<string> = new Set();

  constructor(nodeConfigs: SimulatedNodeConfig[]) {
    for (const cfg of nodeConfigs) {
      this.configs.set(cfg.nodeId, cfg);
    }
    this._buildNodes();
  }

  private _buildNodes(): void {
    for (const cfg of this.configs.values()) {
      const registry = EntityRegistryFactory.createMemory(cfg.nodeId, { enableTestMode: true });
      const pubsub = this.bus.bind(cfg.nodeId);
      const cluster = new FakeClusterManager(cfg.nodeId, this);
      const sync = new EntityRegistrySyncAdapter(registry as any, pubsub as any, cfg.nodeId, {
        topic: 'entity-sync',
      });
      const router = new ResourceRouter(cfg.nodeId, registry, cluster as any);
      const lock = new DistributedLock(registry, cfg.nodeId);

      this._nodes.set(cfg.nodeId, {
        nodeId: cfg.nodeId,
        pubsub,
        registry,
        sync,
        cluster,
        router,
        lock,
      });
    }
  }

  async startAll(): Promise<void> {
    for (const node of this._nodes.values()) {
      await node.registry.start();
      node.sync.start();
      await node.router.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const node of this._nodes.values()) {
      if (this.killed.has(node.nodeId)) continue;
      node.sync.stop();
      await node.router.stop();
      await node.registry.stop();
    }
  }

  node(nodeId: string): SimulatedNode {
    const n = this._nodes.get(nodeId);
    if (!n) throw new Error(`Node "${nodeId}" not found in simulator`);
    return n;
  }

  nodes(): SimulatedNode[] {
    return Array.from(this._nodes.values()).filter((n) => !this.killed.has(n.nodeId));
  }

  allNodes(): SimulatedNode[] {
    return Array.from(this._nodes.values());
  }

  // ---------------------------------------------------------------------------
  // Network partitioning
  // ---------------------------------------------------------------------------

  /**
   * Partition the cluster into two groups. Nodes in groupA can only reach
   * nodes in groupA; same for groupB.
   */
  async partition(groupA: string[], groupB: string[]): Promise<void> {
    const map = new Map<string, Set<string>>();
    for (const id of groupA) {
      map.set(id, new Set(groupA));
    }
    for (const id of groupB) {
      map.set(id, new Set(groupB));
    }
    this.reachabilityMap = map;
    this.bus.setReachability(map);
    // Emit member-left on each side for nodes on the other side
    for (const idA of groupA) {
      const cluster = this._nodes.get(idA)?.cluster;
      if (cluster) {
        for (const idB of groupB) {
          cluster.emit('member-left', idB);
        }
      }
    }
    for (const idB of groupB) {
      const cluster = this._nodes.get(idB)?.cluster;
      if (cluster) {
        for (const idA of groupA) {
          cluster.emit('member-left', idA);
        }
      }
    }
  }

  /** Restore full connectivity. */
  async heal(): Promise<void> {
    this.reachabilityMap = null;
    this.bus.setReachability(null);
  }

  /**
   * Kill a node: removes it from all other nodes' membership views and emits
   * member-left on surviving nodes' cluster stubs.
   */
  async killNode(nodeId: string): Promise<void> {
    this.killed.add(nodeId);
    this.bus.kill(nodeId);

    // Stop the node's resources
    const node = this._nodes.get(nodeId);
    if (node) {
      node.sync.stop();
      try { await node.router.stop(); } catch { /* ignore */ }
      try { await node.registry.stop(); } catch { /* ignore */ }
    }

    // Notify surviving nodes
    for (const [id, survivingNode] of this._nodes) {
      if (id === nodeId) continue;
      if (this.killed.has(id)) continue;
      survivingNode.cluster.emit('member-left', nodeId);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  getReachable(fromNodeId: string): Set<string> {
    if (this.reachabilityMap === null) {
      // Full connectivity: all alive nodes
      return new Set(
        Array.from(this._nodes.keys()).filter((id) => !this.killed.has(id))
      );
    }
    return this.reachabilityMap.get(fromNodeId) ?? new Set([fromNodeId]);
  }

  getAddress(nodeId: string): string {
    return this.configs.get(nodeId)?.address ?? '127.0.0.1';
  }

  getPort(nodeId: string): number {
    return this.configs.get(nodeId)?.port ?? 7000;
  }

  /**
   * Wait for gossip to propagate. Uses real timers.
   */
  async settle(ms = 50): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, ms));
  }
}
