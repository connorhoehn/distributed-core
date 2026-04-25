/**
 * examples/cluster-facade — three-node demo using the Cluster facade.
 *
 * Compare with examples/cluster-collab/run.ts: that file is ~470 lines
 * because it wires PubSub + ClusterManager + Registry + Sync + Router +
 * AutoReclaim + Election by hand. This file is ~30 lines of moving parts
 * because the facade owns the wiring and start/stop ordering.
 *
 * Run with: `npx tsx examples/cluster-facade/run.ts`
 */

import { Cluster } from '../../src/cluster/Cluster';

async function main(): Promise<void> {
  // Three nodes share a single in-memory bus (the InMemoryAdapter has a
  // process-wide registry so nodes auto-discover each other).
  const nodeIds = ['node-A', 'node-B', 'node-C'];

  const clusters = await Promise.all(
    nodeIds.map((nodeId) =>
      Cluster.create({
        // ---- REQUIRED ----
        nodeId,
        topic: 'demo.entities',                 // PubSub topic for sync
        transport: { type: 'memory' },          // in-process bus
        registry: { type: 'memory' },           // ephemeral entity registry

        // ---- DEFAULTED (shown for clarity) ----
        // placement: defaults to LocalPlacement (each node prefers to own its own claims)
        // failureDetection: { heartbeatMs: 1000, deadTimeoutMs: 6000, activeProbing: true }
        // autoReclaim: { jitterMs: 500 } (default-ON; pass `false` to skip)
        // locks: defaults to { ttlMs: 30_000 }
      })
    )
  );

  await Promise.all(clusters.map((c) => c.start()));
  // tiny settle so the in-memory transport finishes its async start handshake
  await new Promise((r) => setTimeout(r, 50));

  // Cross-link membership so PubSubManager.deliverToCluster() can fan out
  // entity-sync messages to peers. In production gossip discovers this; in
  // this in-memory demo we pre-seed each node's view of the cluster.
  for (const c of clusters) {
    for (const peer of clusters) {
      if (peer === c) continue;
      c.clusterManager.membership.addMember({
        id: peer.router.nodeId,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        metadata: { address: '127.0.0.1', port: 0 },
      });
    }
  }

  // Each node claims its own resource. The facade's router defers to the
  // placement strategy (LocalPlacement → "claim it here").
  const handles = await Promise.all(
    clusters.map((c, i) => c.router.claim(`resource-${i}`))
  );
  for (const h of handles) {
    console.log(`claimed ${h.resourceId} on ${h.ownerNodeId}`);
  }

  // Wait for sync propagation across the topic
  await new Promise((r) => setTimeout(r, 100));

  // Each node now sees all 3 resources and can route to the correct owner.
  console.log('\n[router state per node]');
  for (const c of clusters) {
    const all = c.router.getAllResources();
    const summary = all
      .map((h) => `${h.resourceId}→${h.ownerNodeId}`)
      .sort()
      .join(', ');
    console.log(`${c.router.nodeId}: ${summary}`);
  }

  await Promise.all(clusters.map((c) => c.stop()));
  console.log('\nall nodes stopped cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
