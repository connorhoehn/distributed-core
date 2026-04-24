/**
 * benchmarks/eventBus.bench.ts
 *
 * Benchmarks EventBus publish() throughput under three durability modes:
 *   1. No WAL   — pure in-memory, fastest path
 *   2. WAL sync=0  — write-ahead log, sync disabled (OS-level buffering)
 *   3. WAL sync=100ms — write-ahead log, background sync every 100ms
 *
 * Run directly:  npx ts-node benchmarks/eventBus.bench.ts [--iterations N]
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { EventBus } from '../src/messaging/EventBus';
import { PubSubHandler, PubSubMessageMetadata } from '../src/gateway/pubsub/types';
import { bench, printHeader, printResult, printSeparator, parseIterations } from './harness';

// ---------------------------------------------------------------------------
// Minimal stub PubSubManager — delivers locally only, no network, no cluster.
// ---------------------------------------------------------------------------
class StubPubSub extends EventEmitter {
  private subs: Map<string, { id: string; handler: PubSubHandler }[]> = new Map();
  private counter = 0;

  subscribe(topic: string, handler: PubSubHandler): string {
    const id = `sub-${++this.counter}`;
    const list = this.subs.get(topic) ?? [];
    list.push({ id, handler });
    this.subs.set(topic, list);
    return id;
  }

  unsubscribe(subscriptionId: string): boolean {
    for (const [topic, list] of this.subs) {
      const idx = list.findIndex((s) => s.id === subscriptionId);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) this.subs.delete(topic);
        return true;
      }
    }
    return false;
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    const meta: PubSubMessageMetadata = {
      messageId: `m-${Date.now()}`,
      publisherNodeId: 'stub',
      timestamp: Date.now(),
      topic,
    };
    const list = this.subs.get(topic);
    if (list) {
      for (const sub of list) {
        sub.handler(topic, payload, meta);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTmpPath(suffix: string): string {
  return path.join(os.tmpdir(), `bench-eventbus-${process.pid}-${suffix}.wal`);
}

function cleanupPath(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const iterations = parseIterations(100_000);

  console.log('\n=== EventBus Benchmarks ===');
  printHeader();

  // --- no WAL ---
  {
    const pubsub = new StubPubSub();
    const bus = new EventBus(pubsub as any, 'bench-node', { topic: 'bench' });
    await bus.start();

    const result = await bench(
      'EventBus.publish() [no WAL]',
      async () => {
        await bus.publish('ping', { value: 42 });
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
    await bus.stop();
  }

  // --- WAL sync=0 ---
  {
    const walPath = makeTmpPath('sync0');
    try {
      const pubsub = new StubPubSub();
      const bus = new EventBus(pubsub as any, 'bench-node', {
        topic: 'bench',
        walFilePath: walPath,
        walSyncIntervalMs: 0,
      });
      await bus.start();

      const result = await bench(
        'EventBus.publish() [WAL sync=0]',
        async () => {
          await bus.publish('ping', { value: 42 });
        },
        { warmup: 100, iterations: Math.min(iterations, 10_000) },
      );
      printResult(result);
      await bus.stop();
    } finally {
      cleanupPath(walPath);
    }
  }

  // --- WAL sync=100ms ---
  {
    const walPath = makeTmpPath('sync100');
    try {
      const pubsub = new StubPubSub();
      const bus = new EventBus(pubsub as any, 'bench-node', {
        topic: 'bench',
        walFilePath: walPath,
        walSyncIntervalMs: 100,
      });
      await bus.start();

      const result = await bench(
        'EventBus.publish() [WAL sync=100ms]',
        async () => {
          await bus.publish('ping', { value: 42 });
        },
        { warmup: 100, iterations: Math.min(iterations, 10_000) },
      );
      printResult(result);
      await bus.stop();
    } finally {
      cleanupPath(walPath);
    }
  }

  printSeparator();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
