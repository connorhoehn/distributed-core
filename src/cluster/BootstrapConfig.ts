export interface BootstrapOptions {
  seedNodes: string[];
  joinTimeout: number;
  gossipInterval: number;
  enableLogging: boolean;
}

export class BootstrapConfig {
  constructor(
    public seedNodes: string[] = [],
    public joinTimeout: number = 5000,
    public gossipInterval: number = 1000,
    public enableLogging: boolean = false
  ) {}

  static create(options: Partial<BootstrapOptions> = {}): BootstrapConfig {
    return new BootstrapConfig(
      options.seedNodes || [],
      options.joinTimeout || 5000,
      options.gossipInterval || 1000,
      options.enableLogging || false
    );
  }

  addSeedNode(node: string): void {
    this.seedNodes.push(node);
  }

  getSeedNodes(): string[] {
    return [...this.seedNodes];
  }
}
