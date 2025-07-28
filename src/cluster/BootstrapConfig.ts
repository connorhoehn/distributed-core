import { NodeId } from '../types';

export interface BootstrapOptions {
  seedNodes: NodeId[];
  joinTimeout: number;
  gossipInterval: number;
}

export class BootstrapConfig {
  constructor(
    public seedNodes: NodeId[] = [],
    public joinTimeout: number = 5000,
    public gossipInterval: number = 1000
  ) {}

  static create(options: Partial<BootstrapOptions> = {}): BootstrapConfig {
    return new BootstrapConfig(
      options.seedNodes || [],
      options.joinTimeout || 5000,
      options.gossipInterval || 1000
    );
  }

  addSeedNode(node: NodeId): void {
    this.seedNodes.push(node);
  }

  getSeedNodes(): NodeId[] {
    return [...this.seedNodes];
  }
}
