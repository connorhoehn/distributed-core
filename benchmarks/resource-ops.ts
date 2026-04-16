/**
 * Resource Operations Benchmark
 * Measures: CRUD throughput, distribution latency
 * Run: npx ts-node benchmarks/resource-ops.ts
 */

import { ResourceRegistry, ResourceRegistryConfig } from '../src/resources/core/ResourceRegistry';
import { ResourceMetadata, ResourceState, ResourceHealth, ResourceTypeDefinition } from '../src/resources/types';

// ---------------------------------------------------------------------------
// Suppress framework log noise during benchmarks
// ---------------------------------------------------------------------------
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function muteLogger(): void {
  console.log = (...args: any[]) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (first.startsWith('[INFO]') || first.startsWith('[DEBUG]') || first.startsWith('[WARN]')) return;
    origLog(...args);
  };
  console.warn = (...args: any[]) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (first.startsWith('[WARN]')) return;
    origWarn(...args);
  };
}

function restoreLogger(): void {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatOps(ops: number): string {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M ops/sec`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(2)}K ops/sec`;
  return `${ops.toFixed(2)} ops/sec`;
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(2)} us`;
  return `${ms.toFixed(2)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function makeResource(id: string, type: string): ResourceMetadata {
  return {
    id,
    resourceId: id,
    type,
    resourceType: type,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    timestamp: Date.now(),
    nodeId: 'bench-node',
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
  };
}

async function createRegistry(): Promise<ResourceRegistry> {
  const config: ResourceRegistryConfig = {
    nodeId: 'bench-node',
    entityRegistryType: 'memory',
  };
  const registry = new ResourceRegistry(config);
  await registry.start();
  return registry;
}

function registerType(registry: ResourceRegistry, typeName: string): void {
  const def: ResourceTypeDefinition = {
    name: typeName,
    typeName,
    version: '1.0.0',
    schema: {},
  };
  registry.registerResourceType(def);
}

function printHeader(title: string): void {
  origLog('\n' + '='.repeat(60));
  origLog(`  ${title}`);
  origLog('='.repeat(60));
}

function printResult(label: string, value: string): void {
  origLog(`  ${label.padEnd(36)} ${value}`);
}

// ---------------------------------------------------------------------------
// Benchmark 1 — Single-node resource CRUD
// ---------------------------------------------------------------------------

async function benchCRUD(): Promise<void> {
  printHeader('Benchmark 1: Single-node Resource CRUD (10,000 resources)');

  const registry = await createRegistry();
  registerType(registry, 'bench-type');

  const COUNT = 10_000;
  const ids: string[] = [];
  for (let i = 0; i < COUNT; i++) ids.push(`res-${i}`);

  // CREATE
  let start = performance.now();
  for (const id of ids) {
    await registry.createResource(makeResource(id, 'bench-type'));
  }
  let elapsed = performance.now() - start;
  printResult('CREATE (10K)', formatOps((COUNT / elapsed) * 1000));
  printResult('  avg latency', formatMs(elapsed / COUNT));

  // READ
  start = performance.now();
  for (const id of ids) {
    registry.getResource(id);
  }
  elapsed = performance.now() - start;
  printResult('READ (10K)', formatOps((COUNT / elapsed) * 1000));
  printResult('  avg latency', formatMs(elapsed / COUNT));

  // UPDATE
  start = performance.now();
  for (const id of ids) {
    await registry.updateResource(id, { state: ResourceState.SCALING });
  }
  elapsed = performance.now() - start;
  printResult('UPDATE (10K)', formatOps((COUNT / elapsed) * 1000));
  printResult('  avg latency', formatMs(elapsed / COUNT));

  // DELETE
  start = performance.now();
  for (const id of ids) {
    await registry.removeResource(id);
  }
  elapsed = performance.now() - start;
  printResult('DELETE (10K)', formatOps((COUNT / elapsed) * 1000));
  printResult('  avg latency', formatMs(elapsed / COUNT));

  await registry.stop();
}

// ---------------------------------------------------------------------------
// Benchmark 2 — Resource type registration throughput
// ---------------------------------------------------------------------------

async function benchTypeRegistration(): Promise<void> {
  printHeader('Benchmark 2: Resource Type Registration Throughput');

  const registry = await createRegistry();

  const TYPE_COUNT = 10_000;
  const start = performance.now();
  for (let i = 0; i < TYPE_COUNT; i++) {
    registerType(registry, `type-${i}`);
  }
  const elapsed = performance.now() - start;

  printResult('Register types (10K)', formatOps((TYPE_COUNT / elapsed) * 1000));
  printResult('  avg latency', formatMs(elapsed / TYPE_COUNT));
  printResult('  total time', formatMs(elapsed));

  await registry.stop();
}

// ---------------------------------------------------------------------------
// Benchmark 3 — Resource query by type
// ---------------------------------------------------------------------------

async function benchQueryByType(): Promise<void> {
  printHeader('Benchmark 3: Resource Query by Type (10K across 10 types)');

  const registry = await createRegistry();

  const TYPES = 10;
  const PER_TYPE = 1_000;
  const TOTAL = TYPES * PER_TYPE;

  for (let t = 0; t < TYPES; t++) {
    registerType(registry, `qtype-${t}`);
  }

  // Populate resources across types
  for (let t = 0; t < TYPES; t++) {
    for (let i = 0; i < PER_TYPE; i++) {
      await registry.createResource(makeResource(`q-${t}-${i}`, `qtype-${t}`));
    }
  }

  // Query each type
  const ITERATIONS = 100;
  const start = performance.now();
  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let t = 0; t < TYPES; t++) {
      registry.getResourcesByType(`qtype-${t}`);
    }
  }
  const elapsed = performance.now() - start;
  const totalQueries = ITERATIONS * TYPES;

  printResult('Total resources', `${TOTAL}`);
  printResult('Query iterations', `${ITERATIONS} x ${TYPES} types = ${totalQueries} queries`);
  printResult('Query throughput', formatOps((totalQueries / elapsed) * 1000));
  printResult('  avg latency', formatMs(elapsed / totalQueries));
  printResult('  total time', formatMs(elapsed));

  await registry.stop();
}

// ---------------------------------------------------------------------------
// Benchmark 4 — Memory usage with 100K resources
// ---------------------------------------------------------------------------

async function benchMemory(): Promise<void> {
  printHeader('Benchmark 4: Memory Usage (100K resources)');

  // Force GC if available
  if (global.gc) global.gc();

  const heapBefore = process.memoryUsage().heapUsed;

  const registry = await createRegistry();
  registerType(registry, 'mem-type');

  const COUNT = 100_000;

  const start = performance.now();
  for (let i = 0; i < COUNT; i++) {
    await registry.createResource(makeResource(`mem-${i}`, 'mem-type'));
  }
  const elapsed = performance.now() - start;

  if (global.gc) global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDelta = heapAfter - heapBefore;
  const perResource = heapDelta / COUNT;

  printResult('Resources created', `${COUNT.toLocaleString()}`);
  printResult('Creation time', formatMs(elapsed));
  printResult('Creation throughput', formatOps((COUNT / elapsed) * 1000));
  printResult('Heap before', formatBytes(heapBefore));
  printResult('Heap after', formatBytes(heapAfter));
  printResult('Heap delta', formatBytes(heapDelta));
  printResult('Per-resource overhead', formatBytes(Math.round(perResource)));

  await registry.stop();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  origLog('Resource Operations Benchmark');
  origLog(`Node ${process.version} | ${process.platform} ${process.arch}`);
  origLog(`Date: ${new Date().toISOString()}`);

  muteLogger();

  await benchCRUD();
  await benchTypeRegistration();
  await benchQueryByType();
  await benchMemory();

  restoreLogger();

  console.log('\n' + '='.repeat(60));
  console.log('  Benchmark complete');
  console.log('='.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
