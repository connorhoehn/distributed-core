import { EventEmitter } from 'eventemitter3';

export interface ChaosInjectorConfig {
  defaultFailureRate?: number;
  enableLogging?: boolean;
  maxConcurrentChaos?: number;
}

export interface ChaosScenario {
  type: string;
  parameters: any;
  startTime: Date;
}

export class ChaosInjector extends EventEmitter {
  private config: Required<ChaosInjectorConfig>;
  private activeScenarios: Map<string, ChaosScenario> = new Map();
  private statistics = {
    totalScenariosStarted: 0,
    activeScenariosCount: 0,
    scenarioTypes: new Set<string>()
  };

  constructor(config: ChaosInjectorConfig = {}) {
    super();
    this.config = {
      defaultFailureRate: config.defaultFailureRate ?? 0.05,
      enableLogging: config.enableLogging ?? true,
      maxConcurrentChaos: config.maxConcurrentChaos ?? 10
    };
  }

  isActive(): boolean {
    return this.activeScenarios.size > 0;
  }

  getActiveScenarios(): string[] {
    return Array.from(this.activeScenarios.keys());
  }

  async injectNetworkLatency(latencyMs: number): Promise<void> {
    this.validateLatency(latencyMs);
    await this.startScenario('network-latency', { latencyMs });
  }

  async injectPacketLoss(lossRate: number): Promise<void> {
    this.validateRate(lossRate, 'Packet loss rate');
    await this.startScenario('packet-loss', { lossRate });
  }

  async injectNetworkPartition(nodeIds: string[]): Promise<void> {
    await this.startScenario('network-partition', { nodeIds });
  }

  async injectNodeCrash(nodeId: string): Promise<void> {
    await this.startScenario('node-crash', { nodeId });
  }

  async injectMemoryPressure(nodeId: string, pressureLevel: number): Promise<void> {
    this.validateRate(pressureLevel, 'Memory pressure');
    await this.startScenario('memory-pressure', { nodeId, pressureLevel });
  }

  async injectCpuStress(nodeId: string, cpuLoad: number): Promise<void> {
    this.validateRate(cpuLoad, 'CPU load');
    await this.startScenario('cpu-stress', { nodeId, cpuLoad });
  }

  async injectMessageDrop(dropRate: number): Promise<void> {
    this.validateRate(dropRate, 'Message drop rate');
    await this.startScenario('message-drop', { dropRate });
  }

  async injectMessageCorruption(corruptionRate: number): Promise<void> {
    this.validateRate(corruptionRate, 'Message corruption rate');
    await this.startScenario('message-corruption', { corruptionRate });
  }

  async injectMessageDuplication(duplicationRate: number): Promise<void> {
    this.validateRate(duplicationRate, 'Message duplication rate');
    await this.startScenario('message-duplication', { duplicationRate });
  }

  async startScenario(type: string, parameters: any): Promise<void> {
    const validTypes = [
      'network-latency', 'packet-loss', 'network-partition', 
      'node-crash', 'memory-pressure', 'cpu-stress',
      'message-drop', 'message-corruption', 'message-duplication'
    ];

    if (!validTypes.includes(type)) {
      throw new Error(`Unknown scenario type: ${type}`);
    }

    const scenario: ChaosScenario = {
      type,
      parameters,
      startTime: new Date()
    };

    this.activeScenarios.set(type, scenario);
    this.statistics.totalScenariosStarted++;
    this.statistics.activeScenariosCount = this.activeScenarios.size;
    this.statistics.scenarioTypes.add(type);

    this.emit('scenario-started', {
      type,
      parameters,
      timestamp: scenario.startTime
    });
  }

  async stopScenario(type: string): Promise<void> {
    if (this.activeScenarios.has(type)) {
      this.activeScenarios.delete(type);
      this.statistics.activeScenariosCount = this.activeScenarios.size;
      
      this.emit('scenario-stopped', {
        type,
        timestamp: new Date()
      });
    }
  }

  async stopAll(): Promise<void> {
    const scenarios = Array.from(this.activeScenarios.keys());
    for (const scenario of scenarios) {
      await this.stopScenario(scenario);
    }
  }

  updateConfiguration(newConfig: Partial<ChaosInjectorConfig>): void {
    if (newConfig.defaultFailureRate !== undefined) {
      this.validateRate(newConfig.defaultFailureRate, 'Default failure rate');
      this.config.defaultFailureRate = newConfig.defaultFailureRate;
    }
    if (newConfig.enableLogging !== undefined) {
      this.config.enableLogging = newConfig.enableLogging;
    }
    if (newConfig.maxConcurrentChaos !== undefined) {
      this.config.maxConcurrentChaos = newConfig.maxConcurrentChaos;
    }
  }

  getConfiguration(): Required<ChaosInjectorConfig> {
    return { ...this.config };
  }

  getStatistics() {
    return {
      totalScenariosStarted: this.statistics.totalScenariosStarted,
      activeScenariosCount: this.statistics.activeScenariosCount,
      scenarioTypes: Array.from(this.statistics.scenarioTypes)
    };
  }

  // Transport integration methods
  shouldInterceptMessage(): boolean {
    return this.isActive();
  }

  shouldDelayMessage(): boolean {
    return this.activeScenarios.has('network-latency');
  }

  shouldDropMessage(): boolean {
    if (this.activeScenarios.has('message-drop')) {
      const scenario = this.activeScenarios.get('message-drop');
      return Math.random() < scenario!.parameters.dropRate;
    }
    return false;
  }

  calculateMessageDelay(): number {
    if (this.activeScenarios.has('network-latency')) {
      const scenario = this.activeScenarios.get('network-latency');
      const baseLatency = scenario!.parameters.latencyMs;
      // Add some variance (±20%)
      const variance = baseLatency * 0.2;
      return baseLatency + (Math.random() - 0.5) * variance;
    }
    return 0;
  }

  private validateLatency(latency: number): void {
    if (typeof latency !== 'number' || isNaN(latency)) {
      throw new Error('Latency must be a valid number');
    }
    if (latency < 0) {
      throw new Error('Latency must be non-negative');
    }
  }

  private validateRate(rate: number, rateName: string): void {
    if (typeof rate !== 'number' || isNaN(rate)) {
      throw new Error(`${rateName} must be a valid number`);
    }
    if (rate < 0 || rate > 1) {
      throw new Error(`${rateName} must be between 0 and 1`);
    }
  }
}
