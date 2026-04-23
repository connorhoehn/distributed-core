import { NodeHandle } from './NodeHandle';
import { RangeCoordinator } from '../coordinators/RangeCoordinator';
import { ClusterView, RangeId } from '../coordinators/types';

/**
 * Wraps a NodeHandle and its associated RangeCoordinator,
 * providing a unified lifecycle for agent nodes that participate
 * in range-based coordination.
 */
export class AgentHandle {
  readonly nodeHandle: NodeHandle;
  readonly coordinator: RangeCoordinator;

  constructor(nodeHandle: NodeHandle, coordinator: RangeCoordinator) {
    this.nodeHandle = nodeHandle;
    this.coordinator = coordinator;
  }

  /** Start the underlying node and the range coordinator. */
  async start(): Promise<void> {
    await this.nodeHandle.start();
    await this.coordinator.start();
  }

  /** Stop the range coordinator and then the underlying node. */
  async stop(): Promise<void> {
    await this.coordinator.stop();
    await this.nodeHandle.stop();
  }

  /** Returns true if the underlying node is running. */
  isRunning(): boolean {
    return this.nodeHandle.isRunning();
  }

  /** Get the node's unique identifier. */
  get id(): string {
    return this.nodeHandle.id;
  }

  /** Get the current cluster view from the coordinator. */
  async getClusterStatus(): Promise<ClusterView> {
    return this.coordinator.getClusterStatus();
  }

  /** Get ranges currently owned by this agent. */
  async getOwnedRanges(): Promise<RangeId[]> {
    return this.coordinator.getOwnedRanges();
  }

  /** Trigger a manual range rebalance. */
  async rebalanceRanges(): Promise<void> {
    return this.coordinator.rebalanceRanges();
  }
}
