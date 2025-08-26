import { ResourceOperation, OpType } from '../../resources/core/ResourceOperation';
import { SemanticsConfig } from '../semantics/SemanticsConfig';

/**
 * Ports/Interfaces for dependency inversion (D in SOLID)
 * 
 * These define the contracts that adapters must implement,
 * allowing the factory to compose concrete implementations
 * without hard-coding dependencies.
 */

export interface ClusterSender {
  sendTo(nodeId: string, bytes: Uint8Array): Promise<void>;
}

export interface ClusterReceiver {
  onMessage(handler: (from: string, bytes: Uint8Array) => void): void;
}

export interface TransportServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TimeProvider {
  nowMs(): number;
}

export interface OperationEnvelopeManager {
  wrap<T>(type: OpType, resourceId: string, payload: T): ResourceOperation<T>;
}

/**
 * Configuration validator for build-time validation
 */
export interface ConfigValidator {
  validateDistributedConfig(cfg: {
    semantics: SemanticsConfig;
    network: any;
    resources: any;
  }): { 
    errors: string[];
    warnings: string[];
  };
}

/**
 * Clean ingress façades that replace EventEmitter coupling
 */
export interface ResourcePublisher {
  publishFromClient(connId: string, resourceId: string, body: Uint8Array, meta?: any): Promise<void>;
  publishFromSystem(resourceId: string, op: ResourceOperation): Promise<void>;
}

export interface ResourceSubscriber {
  join(connId: string, resourceId: string, filters?: any): Promise<void>;
  leave(connId: string, resourceId: string): Promise<void>;
}
