import { EventEmitter } from 'events';
import { PubSubManager } from '../../../../src/gateway/pubsub/PubSubManager';
import { SignedPubSubManager } from '../../../../src/gateway/pubsub/SignedPubSubManager';
import { KeyManager } from '../../../../src/identity/KeyManager';
import { MembershipEntry } from '../../../../src/cluster/types';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeTransport() {
  const listeners: ((msg: unknown) => void)[] = [];
  return {
    onMessage: (fn: (msg: unknown) => void) => listeners.push(fn),
    removeMessageListener: (fn: (msg: unknown) => void) => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    send: jest.fn().mockResolvedValue(undefined),
    getLocalNodeInfo: () => ({ id: 'node-a', address: '127.0.0.1', port: 7000 }),
  };
}

function makeCluster(localNodeId: string) {
  const emitter = new EventEmitter();
  const membership = new Map<string, MembershipEntry>();
  membership.set(localNodeId, {
    id: localNodeId,
    status: 'ALIVE',
    lastSeen: Date.now(),
    version: 1,
    lastUpdated: Date.now(),
    metadata: { address: '127.0.0.1', port: 7000 },
  } as MembershipEntry);
  return {
    getMembership: () => membership,
    on: (e: string, h: (...a: unknown[]) => void) => emitter.on(e, h),
    off: (e: string, h: (...a: unknown[]) => void) => emitter.off(e, h),
    emit: (e: string, ...a: unknown[]) => emitter.emit(e, ...a),
  };
}

function makePubSubManager(nodeId = 'node-a') {
  const transport = makeTransport();
  const cluster = makeCluster(nodeId);
  const pubsub = new PubSubManager(nodeId, transport as any, cluster as any, {
    enableCrossNodeDelivery: false,
  });
  return { pubsub, transport, cluster };
}

// EC keys are ~10x faster than RSA; generate once per suite
let kmA: KeyManager;
let kmB: KeyManager;

beforeAll(() => {
  kmA = new KeyManager({ algorithm: 'ec', curve: 'secp256k1', enableLogging: false });
  kmB = new KeyManager({ algorithm: 'ec', curve: 'secp256k1', enableLogging: false });
});

const TOPIC = 'test-topic';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignedPubSubManager', () => {
  describe('1. publish signs; subscriber receives original payload', () => {
    it('delivers the unwrapped payload with correct metadata', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const publicKeys = new Map([['node-a', kmA.getPublicKey()]]);
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', { publicKeys });

      const received: unknown[] = [];
      const metas: PubSubMessageMetadata[] = [];
      signed.subscribe(TOPIC, (_t, payload, meta) => {
        received.push(payload);
        metas.push(meta);
      });

      await signed.publish(TOPIC, { hello: 'world' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ hello: 'world' });
      expect(metas[0].publisherNodeId).toBe('node-a');

      pubsub.destroy();
    });
  });

  describe('2. tampered payload is rejected with invalid-signature', () => {
    it('does not call the handler; emits message:rejected', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const publicKeys = new Map([['node-a', kmA.getPublicKey()]]);
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', { publicKeys });

      const handler = jest.fn();
      const rejections: { topic: string; reason: string; publisherNodeId?: string }[] = [];
      signed.on('message:rejected', (info) => rejections.push(info));
      signed.subscribe(TOPIC, handler);

      // Bypass signed.publish — put a tampered envelope directly into inner
      const legit = kmA.sign(JSON.stringify({ data: 'original' }));
      await pubsub.publish(TOPIC, {
        payload: { data: 'tampered' },
        signature: legit.signature,
        publisherNodeId: 'node-a',
        timestamp: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe('invalid-signature');
      expect(rejections[0].publisherNodeId).toBe('node-a');

      pubsub.destroy();
    });
  });

  describe('3. missing signature in strict mode', () => {
    it('rejects with no-signature and drops message', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const publicKeys = new Map([['node-a', kmA.getPublicKey()]]);
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', { strictMode: true, publicKeys });

      const handler = jest.fn();
      const rejections: { reason: string }[] = [];
      signed.on('message:rejected', (info) => rejections.push(info));
      signed.subscribe(TOPIC, handler);

      // Publish a bare (unsigned) payload directly into inner
      await pubsub.publish(TOPIC, { bare: true });

      expect(handler).not.toHaveBeenCalled();
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe('no-signature');

      pubsub.destroy();
    });
  });

  describe('4. unknown publisher nodeId — no-public-key', () => {
    it('rejects with no-public-key when no key is configured for publisher', async () => {
      const { pubsub } = makePubSubManager('node-a');
      // Empty publicKeys map — no key for node-a
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', { publicKeys: new Map() });

      const handler = jest.fn();
      const rejections: { reason: string; publisherNodeId?: string }[] = [];
      signed.on('message:rejected', (info) => rejections.push(info));
      signed.subscribe(TOPIC, handler);

      // Put a properly-signed envelope in; key just isn't registered
      const sig = kmA.sign(JSON.stringify({ x: 1 }));
      await pubsub.publish(TOPIC, {
        payload: { x: 1 },
        signature: sig.signature,
        publisherNodeId: 'node-a',
        timestamp: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
      expect(rejections[0].reason).toBe('no-public-key');
      expect(rejections[0].publisherNodeId).toBe('node-a');

      pubsub.destroy();
    });
  });

  describe('5. cross-node verification (A signs, B verifies)', () => {
    it('delivers payload when B has A\'s public key', async () => {
      const { pubsub: pubsubA } = makePubSubManager('node-a');
      const { pubsub: pubsubB } = makePubSubManager('node-b');

      const publicKeysForB = new Map([['node-a', kmA.getPublicKey()]]);
      const signedA = new SignedPubSubManager(pubsubA, kmA, 'node-a', {
        publicKeys: new Map([['node-a', kmA.getPublicKey()]]),
      });
      const signedB = new SignedPubSubManager(pubsubB, kmB, 'node-b', {
        publicKeys: publicKeysForB,
      });

      const received: unknown[] = [];
      signedB.subscribe(TOPIC, (_t, payload) => received.push(payload));

      // Simulate A publishing: build a signed envelope as A would, inject into B's inner pubsub
      const payloadData = { from: 'node-a', value: 42 };
      const serialized = JSON.stringify(payloadData);
      const sig = kmA.sign(serialized);
      await pubsubB.publish(TOPIC, {
        payload: payloadData,
        signature: sig.signature,
        publisherNodeId: 'node-a',
        timestamp: sig.timestamp,
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ from: 'node-a', value: 42 });

      pubsubA.destroy();
      pubsubB.destroy();
    });
  });

  describe('6. getStats counters', () => {
    it('tracks signedPublished, verified, and rejected', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const publicKeys = new Map([['node-a', kmA.getPublicKey()]]);
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', { publicKeys });

      signed.subscribe(TOPIC, jest.fn());

      await signed.publish(TOPIC, { a: 1 });
      await signed.publish(TOPIC, { a: 2 });

      // Inject one bad envelope (tampered)
      const legit = kmA.sign(JSON.stringify({ a: 'original' }));
      await pubsub.publish(TOPIC, {
        payload: { a: 'tampered' },
        signature: legit.signature,
        publisherNodeId: 'node-a',
        timestamp: Date.now(),
      });

      const stats = signed.getStats();
      expect(stats.signedPublished).toBe(2);
      expect(stats.verified).toBe(2);
      expect(stats.rejected).toBe(1);

      pubsub.destroy();
    });
  });

  describe('7. message:rejected event payload', () => {
    it('fires with {topic, reason, publisherNodeId}', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', {
        publicKeys: new Map([['node-a', kmA.getPublicKey()]]),
      });

      signed.subscribe(TOPIC, jest.fn());

      const events: { topic: string; reason: string; publisherNodeId?: string }[] = [];
      signed.on('message:rejected', (info) => events.push(info));

      const sig = kmA.sign(JSON.stringify({ original: true }));
      await pubsub.publish(TOPIC, {
        payload: { tampered: true },
        signature: sig.signature,
        publisherNodeId: 'node-a',
        timestamp: Date.now(),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        topic: TOPIC,
        reason: 'invalid-signature',
        publisherNodeId: 'node-a',
      });

      pubsub.destroy();
    });
  });

  describe('8. strictMode: false delivers unsigned messages', () => {
    it('calls handler and fires message:rejected warning for unsigned messages', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', {
        strictMode: false,
        publicKeys: new Map(),
      });

      const received: unknown[] = [];
      const rejections: { reason: string }[] = [];
      signed.on('message:rejected', (info) => rejections.push(info));
      signed.subscribe(TOPIC, (_t, payload) => received.push(payload));

      // Publish a bare (unsigned) payload directly into inner
      await pubsub.publish(TOPIC, { bare: 'value' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ bare: 'value' });
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe('no-signature');

      pubsub.destroy();
    });
  });

  describe('9. destroy cleans up inner pubsub', () => {
    it('unsubscribes handlers after destroy', async () => {
      const { pubsub } = makePubSubManager('node-a');
      const publicKeys = new Map([['node-a', kmA.getPublicKey()]]);
      const signed = new SignedPubSubManager(pubsub, kmA, 'node-a', { publicKeys });

      const handler = jest.fn();
      signed.subscribe(TOPIC, handler);

      signed.destroy();

      // After destroy, pubsub is gone — subscriptions map is cleared
      // Attempting to read topics should return empty
      expect(pubsub.getTopics()).toHaveLength(0);
    });
  });
});
