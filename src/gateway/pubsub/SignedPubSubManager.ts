import { EventEmitter } from 'events';
import { PubSubManager } from './PubSubManager';
import { PubSubHandler, PubSubMessageMetadata, PubSubStats } from './types';
import { KeyManager } from '../../identity/KeyManager';

export interface SignedPubSubManagerConfig {
  /**
   * Strict mode: reject unsigned messages. Default: true.
   * When false, unsigned messages are still delivered but the
   * 'message:rejected' event fires. Invalid signatures always reject.
   */
  strictMode?: boolean;

  /**
   * Per-nodeId public keys (PEM) for signature verification.
   * If not provided for a given publisher, verification falls back to
   * the publisher's public key embedded in the envelope (not supported
   * here — callers must supply keys via this map or accept 'no-public-key').
   */
  publicKeys?: Map<string, string>;
}

export interface SignedMessage<T = unknown> {
  payload: T;
  signature: string;
  publisherNodeId: string;
  timestamp: number;
}

interface RejectedInfo {
  topic: string;
  reason: string;
  publisherNodeId?: string;
}

export class SignedPubSubManager extends EventEmitter {
  private readonly inner: PubSubManager;
  private readonly keyManager: KeyManager;
  private readonly localNodeId: string;
  private readonly strictMode: boolean;
  private readonly publicKeys: Map<string, string>;

  private signedPublished = 0;
  private verified = 0;
  private rejected = 0;

  constructor(
    inner: PubSubManager,
    keyManager: KeyManager,
    localNodeId: string,
    config?: SignedPubSubManagerConfig,
  ) {
    super();
    this.inner = inner;
    this.keyManager = keyManager;
    this.localNodeId = localNodeId;
    this.strictMode = config?.strictMode ?? true;
    this.publicKeys = config?.publicKeys ?? new Map();
  }

  subscribe(topic: string, handler: PubSubHandler): string {
    return this.inner.subscribe(topic, (t, rawPayload, metadata) => {
      const envelope = rawPayload as SignedMessage;

      if (!envelope || typeof envelope !== 'object' || !('publisherNodeId' in envelope)) {
        this.handleRejection(topic, 'no-signature', undefined, handler, t, rawPayload, metadata);
        return;
      }

      const { payload, signature, publisherNodeId, timestamp } = envelope;

      if (!signature) {
        this.handleRejection(topic, 'no-signature', publisherNodeId, handler, t, payload, metadata);
        return;
      }

      const publicKey = this.publicKeys.get(publisherNodeId);
      if (!publicKey) {
        this.rejected++;
        this.emit('message:rejected', { topic, reason: 'no-public-key', publisherNodeId });
        return;
      }

      const serialized = JSON.stringify(payload);
      const result = KeyManager.verify(serialized, signature, publicKey);

      if (!result.isValid) {
        this.rejected++;
        this.emit('message:rejected', { topic, reason: 'invalid-signature', publisherNodeId });
        return;
      }

      this.verified++;
      const adjustedMetadata: PubSubMessageMetadata = {
        ...metadata,
        publisherNodeId,
        timestamp,
      };
      handler(t, payload, adjustedMetadata);
    });
  }

  private handleRejection(
    topic: string,
    reason: string,
    publisherNodeId: string | undefined,
    handler: PubSubHandler,
    t: string,
    payload: unknown,
    metadata: PubSubMessageMetadata,
  ): void {
    this.emit('message:rejected', { topic, reason, publisherNodeId } satisfies RejectedInfo);
    if (!this.strictMode) {
      handler(t, payload, metadata);
    } else {
      this.rejected++;
    }
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    const serialized = JSON.stringify(payload);
    const result = this.keyManager.sign(serialized);

    const envelope: SignedMessage = {
      payload,
      signature: result.signature,
      publisherNodeId: this.localNodeId,
      timestamp: result.timestamp,
    };

    this.signedPublished++;
    await this.inner.publish(topic, envelope);
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.inner.unsubscribe(subscriptionId);
  }

  getTopics(): string[] {
    return this.inner.getTopics();
  }

  getSubscriptionCount(topic?: string): number {
    return this.inner.getSubscriptionCount(topic);
  }

  getStats(): PubSubStats & { signedPublished: number; verified: number; rejected: number } {
    return {
      ...this.inner.getStats(),
      signedPublished: this.signedPublished,
      verified: this.verified,
      rejected: this.rejected,
    };
  }

  destroy(): void {
    this.inner.destroy();
    this.removeAllListeners();
  }

  on(event: 'message:rejected', handler: (info: RejectedInfo) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: 'message:rejected', handler: (info: RejectedInfo) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}
