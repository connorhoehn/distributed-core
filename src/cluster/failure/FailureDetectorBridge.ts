import { EventEmitter } from 'events';
import { FailureDetector } from '../../monitoring/FailureDetector';
import { ResourceRouter } from '../../routing/ResourceRouter';
import { ConnectionRegistry } from '../../connections/ConnectionRegistry';
import { DistributedLock } from '../locks/DistributedLock';
import { LifecycleAware } from '../../common/LifecycleAware';

export interface FailureDetectorBridgeTargets {
  router?: ResourceRouter;
  connectionRegistry?: ConnectionRegistry;
  lock?: DistributedLock;
}

export interface FailureDetectorBridgeConfig {
  handleSuspected?: boolean;
}

export class FailureDetectorBridge extends EventEmitter implements LifecycleAware {
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

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.detector.on('node-failed', this.onNodeFailed);
    if (this.config.handleSuspected) {
      this.detector.on('node-suspected', this.onNodeSuspected);
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.started = false;
    this.detector.off('node-failed', this.onNodeFailed);
    this.detector.off('node-suspected', this.onNodeSuspected);
    return Promise.resolve();
  }

  isStarted(): boolean {
    return this.started;
  }

  private async handleFailure(nodeId: string, reason: string): Promise<void> {
    try {
      let orphanedResources = 0;
      let expiredConnections = 0;
      let releasedLocks = 0;

      if (this.targets.router) {
        const before = this.targets.router.getAllResources().filter(r => r.ownerNodeId === nodeId).length;
        this.targets.router.handleNodeLeft(nodeId);
        orphanedResources = before;
      }

      if (this.targets.connectionRegistry) {
        expiredConnections = await this.targets.connectionRegistry.handleRemoteNodeFailure(nodeId);
      }

      if (this.targets.lock) {
        releasedLocks = this.targets.lock.handleRemoteNodeFailure(nodeId);
      }

      this.emit('cleanup:triggered', nodeId, { orphanedResources, expiredConnections, releasedLocks });
    } catch (err) {
      this.emit('cleanup:error', nodeId, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
