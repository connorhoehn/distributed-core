import { EventEmitter } from 'events';
import { FailureDetector } from '../../monitoring/FailureDetector';
import { ResourceRouter } from '../../routing/ResourceRouter';
import { ConnectionRegistry } from '../../connections/ConnectionRegistry';

export interface FailureDetectorBridgeTargets {
  router?: ResourceRouter;
  connectionRegistry?: ConnectionRegistry;
}

export interface FailureDetectorBridgeConfig {
  handleSuspected?: boolean;
}

export class FailureDetectorBridge extends EventEmitter {
  private readonly detector: FailureDetector;
  private readonly targets: FailureDetectorBridgeTargets;
  private readonly config: Required<FailureDetectorBridgeConfig>;
  private started = false;

  private readonly onNodeFailed: (nodeId: string, reason: string) => void;
  private readonly onNodeSuspected: (nodeId: string) => void;

  constructor(
    detector: FailureDetector,
    targets: FailureDetectorBridgeTargets,
    config?: FailureDetectorBridgeConfig,
  ) {
    super();
    this.detector = detector;
    this.targets = targets;
    this.config = { handleSuspected: config?.handleSuspected ?? false };

    this.onNodeFailed = (nodeId: string, reason: string) => {
      void this.handleFailure(nodeId, reason);
    };
    this.onNodeSuspected = (nodeId: string) => {
      void this.handleFailure(nodeId, 'suspected');
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.detector.on('node-failed', this.onNodeFailed);
    if (this.config.handleSuspected) {
      this.detector.on('node-suspected', this.onNodeSuspected);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.detector.off('node-failed', this.onNodeFailed);
    this.detector.off('node-suspected', this.onNodeSuspected);
  }

  isStarted(): boolean {
    return this.started;
  }

  private async handleFailure(nodeId: string, reason: string): Promise<void> {
    try {
      let orphanedResources = 0;
      let expiredConnections = 0;

      if (this.targets.router) {
        const before = this.targets.router.getAllResources().filter(r => r.ownerNodeId === nodeId).length;
        this.targets.router.handleNodeLeft(nodeId);
        orphanedResources = before;
      }

      if (this.targets.connectionRegistry) {
        expiredConnections = await this.targets.connectionRegistry.handleRemoteNodeFailure(nodeId);
      }

      this.emit('cleanup:triggered', nodeId, { orphanedResources, expiredConnections });
    } catch (err) {
      this.emit('cleanup:error', nodeId, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
