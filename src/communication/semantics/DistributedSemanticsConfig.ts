export interface DistributedSemanticsFlags {
  enableCausalOrdering: boolean;
  enableDeduplication: boolean;
  enableDeliveryGuards: boolean;
  enableAttachments: boolean;
  'obs.trace'?: boolean; // Add the missing flag
}

export class DistributedSemanticsConfig {
  public flags: DistributedSemanticsFlags;
  public consistency: 'eventual' | 'strong' | 'causal';
  public replication: {
    factor: number;
    strategy: string;
  };

  constructor(config?: Partial<DistributedSemanticsConfig>) {
    this.flags = {
      enableCausalOrdering: true,
      enableDeduplication: true,
      enableDeliveryGuards: true,
      enableAttachments: true,
      'obs.trace': false,
      ...config?.flags
    };
    this.consistency = config?.consistency || 'causal';
    this.replication = {
      factor: 3,
      strategy: 'quorum',
      ...config?.replication
    };
  }

  isEnabled(flag: keyof DistributedSemanticsFlags): boolean {
    return !!this.flags[flag];
  }
}

export const globalSemanticsConfig = new DistributedSemanticsConfig();
