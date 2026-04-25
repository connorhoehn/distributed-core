/**
 * examples/cluster-redis — minimum wiring for `RedisPubSubManager`.
 *
 * Prerequisites:
 *   - A running Redis (e.g. `docker run --rm -p 6379:6379 redis:7`).
 *   - The optional peer dependency installed: `npm install redis@^5`.
 *
 * Run with: `REDIS_URL=redis://localhost:6379 ts-node examples/cluster-redis/run.ts`
 *
 * Two managers (different localNodeIds) share a Redis instance and exchange
 * messages on the same topic — demonstrating cross-process pubsub without
 * each integrator re-implementing the SUBSCRIBE/PUBLISH split, dedup, and
 * reconnect logic by hand.
 */

import { RedisPubSubManager } from '../../src/gateway/pubsub/RedisPubSubManager';

async function main(): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

  const a = new RedisPubSubManager({ localNodeId: 'node-a', url });
  const b = new RedisPubSubManager({ localNodeId: 'node-b', url });

  await a.start();
  await b.start();

  b.subscribe('greetings', (_topic, payload, meta) => {
    console.log(`[node-b] received from ${meta.publisherNodeId}:`, payload);
  });

  // Give Redis a moment to confirm the SUBSCRIBE before the first PUBLISH.
  await new Promise((r) => setTimeout(r, 100));

  await a.publish('greetings', { hello: 'world' });
  await a.publish('greetings', { count: 42 });

  await new Promise((r) => setTimeout(r, 200));

  await a.stop();
  await b.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
