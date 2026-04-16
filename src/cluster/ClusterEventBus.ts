import { MembershipEntry } from './types';

/**
 * Minimal event bus interface for subscribing to cluster events.
 * Consumers that only need to listen/unlisten for events should depend on this
 * instead of the full ClusterManager.
 */
export interface IClusterEventBus {
  /** Subscribe to a named cluster event (e.g. `member-joined`, `member-left`). */
  on(event: string, listener: (...args: any[]) => void): this;

  /** Unsubscribe a previously registered listener for a cluster event. */
  off(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Minimal read-only interface for querying cluster membership and routing.
 * Consumers that need cluster info without mutating cluster state should
 * depend on this instead of the full ClusterManager.
 */
export interface IClusterInfo {
  /** The local node's identifier */
  readonly localNodeId: string;

  /** Get the number of members in the cluster */
  getMemberCount(): number;

  /** Get all alive members in the cluster */
  getAliveMembers(): MembershipEntry[];

  /** Get the node responsible for a given key via consistent hashing */
  getNodeForKey(key: string): string | null;

  /** Get replica nodes for a given key */
  getReplicaNodes(key: string, count: number): string[];

  /** Send a custom message to specific cluster nodes */
  sendCustomMessage(type: string, payload: any, targetNodeIds: string[]): Promise<void>;
}

/**
 * Combined type for consumers that need both event subscription and cluster info.
 * Use this in place of a direct ClusterManager dependency.
 */
export type IClusterNode = IClusterInfo & IClusterEventBus;
