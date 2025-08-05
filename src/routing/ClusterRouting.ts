import { MembershipEntry } from '../cluster/types';
import { IClusterManagerContext, IRequiresContext } from '../cluster/core/IClusterManagerContext';

export interface RoutingOptions {
  strategy: 'CONSISTENT_HASH' | 'ROUND_ROBIN' | 'RANDOM' | 'LOCALITY_AWARE';
  replicationFactor: number;
  preferLocalZone: boolean;
}

/**
 * ClusterRouting handles key routing and replica selection
 */
export class ClusterRouting implements IRequiresContext {
  private context?: IClusterManagerContext;

  constructor() {}

  setContext(context: IClusterManagerContext): void {
    this.context = context;
  }

  private ensureContext(): IClusterManagerContext {
    if (!this.context) {
      throw new Error('ClusterRouting context not set');
    }
    return this.context;
  }

  /**
   * Get the primary node responsible for a key
   */
  getNodeForKey(key: string): string | null {
    const context = this.ensureContext();
    return context.hashRing.getNode(key);
  }

  /**
   * Get replica nodes for key (including primary)
   */
  getReplicaNodes(key: string, replicaCount: number = 3): string[] {
    const context = this.ensureContext();
    return context.hashRing.getNodes(key, replicaCount);
  }

  /**
   * Get N nodes responsible for key with advanced routing options
   */
  getNodesForKey(key: string, options: Partial<RoutingOptions> = {}): string[] {
    const context = this.ensureContext();
    
    const opts: RoutingOptions = {
      strategy: 'CONSISTENT_HASH',
      replicationFactor: 3,
      preferLocalZone: false,
      ...options
    };

    switch (opts.strategy) {
      case 'CONSISTENT_HASH':
        return context.hashRing.getNodes(key, opts.replicationFactor);
      
      case 'ROUND_ROBIN':
        return this.getAliveMembers().map(member => member.id);
      
      case 'RANDOM':
        const members = this.getAliveMembers().map(member => member.id);
        return this.shuffleArray([...members]).slice(0, opts.replicationFactor);
      
      case 'LOCALITY_AWARE':
        return this.getLocalityAwareNodes(key, opts);
      
      default:
        return context.hashRing.getNodes(key, opts.replicationFactor);
    }
  }

  /**
   * Get nodes with locality awareness
   */
  private getLocalityAwareNodes(key: string, options: RoutingOptions): string[] {
    const context = this.ensureContext();
    const allNodes = this.getAliveMembers();
    const localNode = context.getLocalNodeInfo();
    
    if (options.preferLocalZone && localNode.metadata?.zone) {
      const localZoneNodes = allNodes.filter(node => 
        node.metadata?.zone === localNode.metadata?.zone
      );
      
      if (localZoneNodes.length >= options.replicationFactor) {
        return localZoneNodes.slice(0, options.replicationFactor).map(n => n.id);
      }
    }
    
    // Fallback to consistent hashing
    return context.hashRing.getNodes(key, options.replicationFactor);
  }

  /**
   * Get all alive members
   */
  private getAliveMembers(): MembershipEntry[] {
    const context = this.ensureContext();
    return context.membership.getAllMembers()
      .filter(entry => entry.status === 'ALIVE');
  }

  /**
   * Fisher-Yates shuffle algorithm
   */
  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}
