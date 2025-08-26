import { ResourcePublisher, ResourceSubscriber } from './ports';
import { ResourceAttachmentService } from '../../resources/attachment/ResourceAttachmentService';
import { ResourceDistributionEngine } from '../../resources/distribution/ResourceDistributionEngine';
import { ClusterFanoutRouter } from '../../resources/distribution/ClusterFanoutRouter';
import { ResourceAuthorizationService } from '../../resources/security/ResourceAuthorizationService';
import { WriteAheadLog } from '../../persistence/WriteAheadLog';
import { OperationDeduplicator } from '../../communication/deduplication/OperationDeduplicator';
import { CausalOrderingEngine } from '../../communication/ordering/CausalOrderingEngine';
import { SemanticsConfig } from '../semantics/SemanticsConfig';

// Flow control interface (to be implemented)
export interface FlowControlManager {
  canAccept(connectionId: string): boolean;
  recordWrite(connectionId: string, bytes: number): void;
  recordDrop(connectionId: string, reason: string): void;
}

/**
 * Integrated Communication Layer - Single façade for all resource communication
 * 
 * This is the composition root that the factory returns, providing a clean
 * interface that hides all internal wiring and EventEmitter dependencies.
 * 
 * Enforces:
 * - WAL-before-send semantics
 * - Proper operation ordering (causal, dedup)
 * - Authorization at all boundaries
 * - Flow control and backpressure
 * - Clean lifecycle management
 */
export class IntegratedCommunicationLayer {
  // Public façades for client interactions
  public publisher!: ResourcePublisher;
  public subscriber!: ResourceSubscriber;

  // Core services (exposed for advanced use cases)
  public attachment!: ResourceAttachmentService;
  public distribution!: ResourceDistributionEngine;
  public router!: ClusterFanoutRouter;
  public authz!: ResourceAuthorizationService;
  public wal!: WriteAheadLog;
  public flow!: FlowControlManager;
  public dedup!: OperationDeduplicator;
  public causal!: CausalOrderingEngine;

  // Optional observability property
  public observability?: {
    getMetrics: () => any;
    printSummary: () => void;
  };

  // Lifecycle management
  public async start(): Promise<void> {
    // Implementation here
  }
  public async stop(): Promise<void> {
    // Implementation here
  }
}

/**
 * Configuration for creating the integrated layer
 */
export interface IntegratedLayerConfig {
  nodeId: string;
  semantics: SemanticsConfig;
  enableWAL: boolean;
  enableAuth: boolean;
  enableFlowControl: boolean;
}

/**
 * Result of factory composition including validation
 */
export interface IntegratedLayerResult {
  layer: IntegratedCommunicationLayer;
  warnings: string[];
  config: IntegratedLayerConfig;
}
