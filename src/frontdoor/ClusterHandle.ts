import { NodeHandle } from './NodeHandle';
import { delay } from '../common/utils';

/**
 * Wraps an array of NodeHandles representing a local cluster.
 * Provides coordinated lifecycle management and convergence waiting.
 */
export class ClusterHandle {
  private readonly nodes: NodeHandle[];
  private readonly startupDelayMs: number;

  constructor(nodes: NodeHandle[], startupDelay = 100) {
    this.nodes = nodes;
    this.startupDelayMs = startupDelay;
  }

  /**
   * Start all nodes sequentially with a configurable delay between each.
   * Sequential start avoids thundering-herd on the gossip layer.
   */
  async start(): Promise<void> {
    for (let i = 0; i < this.nodes.length; i++) {
      await this.nodes[i].start();
      if (i < this.nodes.length - 1) {
        await delay(this.startupDelayMs);
      }
    }
  }

  /** Stop all nodes (reverse order for graceful departure). */
  async stop(): Promise<void> {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      await this.nodes[i].stop();
    }
  }

  /** Get a node handle by index. */
  getNode(index: number): NodeHandle {
    if (index < 0 || index >= this.nodes.length) {
      throw new RangeError(`Node index ${index} out of bounds (cluster size: ${this.nodes.length})`);
    }
    return this.nodes[index];
  }

  /** Get a node handle by its id. Returns undefined if not found. */
  getNodeById(id: string): NodeHandle | undefined {
    return this.nodes.find(n => n.id === id);
  }

  /** Get all node handles. */
  getNodes(): readonly NodeHandle[] {
    return this.nodes;
  }

  /** Number of nodes in the cluster. */
  get size(): number {
    return this.nodes.length;
  }

  /**
   * Wait until every node in the cluster can see every other node
   * in its membership table.
   *
   * @param timeout Maximum time to wait in ms. Default: 10000
   * @returns true if convergence was reached, false if timed out.
   */
  async waitForConvergence(timeout = 10000): Promise<boolean> {
    const expectedCount = this.nodes.length;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const allConverged = this.nodes.every(
        n => n.getMemberCount() >= expectedCount,
      );
      if (allConverged) {
        return true;
      }
      await delay(50);
    }

    return false;
  }
}
