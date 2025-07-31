export interface FailureDetectorOptions {
  heartbeatInterval?: number;
  failureTimeout?: number;
  deadTimeout?: number;
  pingTimeout?: number;
  maxMissedHeartbeats?: number;
  maxMissedPings?: number;
  enableActiveProbing?: boolean;
  enableLogging?: boolean;
}

export interface LifecycleOptions {
  shutdownTimeout?: number;
  drainTimeout?: number;
  enableAutoRebalance?: boolean;
  rebalanceThreshold?: number;
  enableGracefulShutdown?: boolean;
  maxShutdownWait?: number;
}

export interface BootstrapOptions {
  seedNodes: string[];
  joinTimeout: number;
  gossipInterval: number;
  enableLogging: boolean;
  failureDetector?: FailureDetectorOptions;
  keyManager?: KeyManagerOptions;
  lifecycle?: LifecycleOptions;
}

export interface KeyManagerOptions {
  privateKeyPem?: string;
  publicKeyPem?: string;
  keySize?: number;
  algorithm?: 'rsa' | 'ec';
  curve?: string;
  enableLogging?: boolean;
}

export class BootstrapConfig {
  constructor(
    public seedNodes: string[] = [],
    public joinTimeout: number = 5000,
    public gossipInterval: number = 1000,
    public enableLogging: boolean = false,
    public failureDetector: FailureDetectorOptions = {},
    public keyManager: KeyManagerOptions = {},
    public lifecycle: LifecycleOptions = {}
  ) {}

  static create(options: Partial<BootstrapOptions> = {}): BootstrapConfig {
    return new BootstrapConfig(
      options.seedNodes || [],
      options.joinTimeout || 5000,
      options.gossipInterval || 1000,
      options.enableLogging || false,
      options.failureDetector || {},
      options.keyManager || {},
      options.lifecycle || {}
    );
  }

  addSeedNode(node: string): void {
    this.seedNodes.push(node);
  }

  getSeedNodes(): string[] {
    return [...this.seedNodes];
  }
}
