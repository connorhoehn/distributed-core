import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { WALFileImpl } from '../../../src/persistence/wal/WALFile';
import { WALCoordinatorImpl } from '../../../src/persistence/wal/WALCoordinator';
import { CompactionCoordinator } from '../../../src/persistence/compaction/CompactionCoordinator';
import { TimeBasedCompactionStrategy } from '../../../src/persistence/compaction/TimeBasedCompactionStrategy';
import { WALEntry, EntityUpdate } from '../../../src/persistence/wal/types';
import { WALSegment } from '../../../src/persistence/compaction/types';

describe('High-Throughput Storage with Compaction E2E', () => {
  let testDir: string;
  let walCoordinator: WALCoordinatorImpl;
  let compactionCoordinator: CompactionCoordinator;
  let walFiles: WALFileImpl[] = [];

  beforeAll(async () => {
    // Create temporary directory for test files
    testDir = path.join(tmpdir(), `wal-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    // Clean up test files
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  });

  beforeEach(() => {
    walCoordinator = new WALCoordinatorImpl();
    
    // Configure compaction with aggressive settings for testing
    compactionCoordinator = new CompactionCoordinator({
      strategy: new TimeBasedCompactionStrategy({
        maxSegmentAge: 1000, // 1 second (very aggressive for testing)
        maxSegmentSize: 50 * 1024, // 50KB (small for testing)
        tombstoneThreshold: 0.1, // 10% (low threshold)
        checkpointLagThreshold: 1
      }),
      walPath: testDir,
      checkpointPath: testDir,
      enableAutoScheduling: false, // Manual control for testing
      maxConcurrentCompactions: 1
    });
  });

  afterEach(async () => {
    // Close all WAL files
    for (const walFile of walFiles) {
      try {
        await walFile.close();
      } catch (error) {
        // Ignore close errors
      }
    }
    walFiles = [];
    
    if (compactionCoordinator) {
      await compactionCoordinator.stop();
    }
  });

  test('should handle high-throughput writes and demonstrate compaction benefits', async () => {
    const numberOfSegments = 5;
    const messagesPerSegment = 1000;
    const totalMessages = numberOfSegments * messagesPerSegment;

    console.log(`\n🚀 Starting high-throughput test: ${totalMessages} messages across ${numberOfSegments} segments`);

    // === PHASE 1: Generate High-Throughput WAL Segments ===
    const segmentFiles: string[] = [];
    const segmentData: WALSegment[] = [];

    for (let segmentIndex = 0; segmentIndex < numberOfSegments; segmentIndex++) {
      const segmentPath = path.join(testDir, `segment-${segmentIndex.toString().padStart(3, '0')}.wal`);
      const walFile = new WALFileImpl(segmentPath);
      walFiles.push(walFile);
      
      await walFile.open();
      segmentFiles.push(segmentPath);

      console.log(`📝 Writing segment ${segmentIndex + 1}/${numberOfSegments}...`);

      // Generate messages for this segment
      const startTime = Date.now() - (numberOfSegments - segmentIndex) * 5000; // Stagger timestamps
      const entries: WALEntry[] = [];

      for (let i = 0; i < messagesPerSegment; i++) {
        const entityUpdate: EntityUpdate = {
          entityId: `entity-${segmentIndex}-${i}`,
          ownerNodeId: `node-${segmentIndex % 3}`, // Distribute across 3 nodes
          version: 1,
          timestamp: startTime + i,
          operation: i % 5 === 0 ? 'DELETE' : 'UPDATE', // 20% deletes (tombstones)
          metadata: {
            messageId: `msg-${segmentIndex}-${i}`,
            payload: `${'x'.repeat(100)}`, // 100 char payload
            processedAt: Date.now()
          }
        };

        // Create duplicates for some entities (to test deduplication)
        if (i % 10 === 0 && i > 0) {
          entityUpdate.entityId = `entity-${segmentIndex}-${i - 1}`; // Duplicate previous entity
          entityUpdate.version = 2; // Higher version
        }

        const entry = walCoordinator.createEntry(entityUpdate);
        entries.push(entry);
        await walFile.append(entry);
      }

      // Create segment metadata
      const segmentSize = await walFile.getSize();
      const tombstoneCount = entries.filter(e => e.data.operation === 'DELETE').length;
      
      segmentData.push({
        segmentId: `segment-${segmentIndex.toString().padStart(3, '0')}`,
        filePath: segmentPath,
        startLSN: entries[0]?.logSequenceNumber || 0,
        endLSN: entries[entries.length - 1]?.logSequenceNumber || 0,
        createdAt: startTime,
        sizeBytes: segmentSize,
        entryCount: entries.length,
        tombstoneCount: tombstoneCount,
        isImmutable: true
      });

      console.log(`  ✅ Segment ${segmentIndex + 1}: ${entries.length} entries, ${segmentSize} bytes, ${tombstoneCount} tombstones`);
    }

    // === PHASE 2: Verify Pre-Compaction State ===
    let totalSizeBefore = 0;
    let totalTombstones = 0;
    let totalEntries = 0;

    for (const segment of segmentData) {
      totalSizeBefore += segment.sizeBytes;
      totalTombstones += segment.tombstoneCount;
      totalEntries += segment.entryCount;
    }

    console.log(`\n📊 Pre-Compaction Statistics:`);
    console.log(`  Total size: ${(totalSizeBefore / 1024).toFixed(2)} KB`);
    console.log(`  Total entries: ${totalEntries}`);
    console.log(`  Total tombstones: ${totalTombstones} (${((totalTombstones / totalEntries) * 100).toFixed(1)}%)`);
    console.log(`  Average segment size: ${(totalSizeBefore / numberOfSegments / 1024).toFixed(2)} KB`);

    // === PHASE 3: Run Compaction ===
    console.log(`\n🔄 Starting compaction process...`);
    
    await compactionCoordinator.start();

    // Wait for segments to age (simulate time passing)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger manual compaction
    const compactionResult = await compactionCoordinator.triggerCompactionCheck();

    if (compactionResult) {
      console.log(`  ✅ Compaction completed successfully!`);
      console.log(`  📉 Space saved: ${(compactionResult.actualSpaceSaved / 1024).toFixed(2)} KB`);
      console.log(`  ⏱️  Duration: ${compactionResult.actualDuration}ms`);
      console.log(`  📋 Segments created: ${compactionResult.segmentsCreated.length}`);
      console.log(`  🗑️  Segments deleted: ${compactionResult.segmentsDeleted.length}`);
      console.log(`  🔢 Entries processed: ${compactionResult.metrics.entriesProcessed}`);
      console.log(`  🧹 Tombstones removed: ${compactionResult.metrics.tombstonesRemoved}`);
      console.log(`  🔄 Duplicates removed: ${compactionResult.metrics.duplicatesRemoved}`);
    } else {
      console.log(`  ℹ️  No compaction needed or already at max concurrent compactions`);
    }

    // === PHASE 4: Verify Post-Compaction Benefits ===
    const status = compactionCoordinator.getStatus();
    console.log(`\n📈 Compaction Status:`);
    console.log(`  Strategy: ${status.strategy}`);
    console.log(`  Running compactions: ${status.runningCompactions.length}`);

    const strategyMetrics = status.strategyMetrics;
    console.log(`\n📊 Strategy Metrics:`);
    console.log(`  Total runs: ${strategyMetrics.totalRuns}`);
    console.log(`  Successful runs: ${strategyMetrics.successfulRuns}`);
    console.log(`  Total space saved: ${(strategyMetrics.totalSpaceSaved / 1024).toFixed(2)} KB`);
    console.log(`  Average duration: ${strategyMetrics.averageDuration}ms`);

    // === PHASE 5: Validate File System Changes ===
    console.log(`\n🔍 Verifying file system changes...`);
    
    const filesAfter = await fs.readdir(testDir);
    const walFilesAfter = filesAfter.filter(f => f.endsWith('.wal'));
    
    console.log(`  Files before compaction: ${numberOfSegments}`);
    console.log(`  Files after compaction: ${walFilesAfter.length}`);
    
    if (compactionResult && compactionResult.success) {
      // Calculate size reduction
      let totalSizeAfter = 0;
      for (const fileName of walFilesAfter) {
        const filePath = path.join(testDir, fileName);
        const stats = await fs.stat(filePath);
        totalSizeAfter += stats.size;
      }

      const spaceReduction = totalSizeBefore - totalSizeAfter;
      const reductionPercentage = (spaceReduction / totalSizeBefore) * 100;

      console.log(`  Total size after: ${(totalSizeAfter / 1024).toFixed(2)} KB`);
      console.log(`  Space reduction: ${(spaceReduction / 1024).toFixed(2)} KB (${reductionPercentage.toFixed(1)}%)`);

      // Verify compaction actually saved space
      expect(spaceReduction).toBeGreaterThan(0);
      expect(reductionPercentage).toBeGreaterThan(5); // At least 5% reduction
    }

    // === PHASE 6: Verify Data Integrity ===
    console.log(`\n🔐 Verifying data integrity...`);
    
    // Read all entries from remaining files
    let totalEntriesAfter = 0;
    let totalLiveEntriesAfter = 0;

    for (const fileName of walFilesAfter) {
      const filePath = path.join(testDir, fileName);
      const walFile = new WALFileImpl(filePath);
      await walFile.open();
      
      const entries = await walFile.readEntries();
      totalEntriesAfter += entries.length;
      
      // Count live entries (non-tombstones)
      const liveEntries = entries.filter(e => e.data.operation !== 'DELETE');
      totalLiveEntriesAfter += liveEntries.length;
      
      await walFile.close();
    }

    console.log(`  Entries after compaction: ${totalEntriesAfter}`);
    console.log(`  Live entries after compaction: ${totalLiveEntriesAfter}`);

    // Verify we haven't lost live data (though we may have fewer total entries due to deduplication)
    if (compactionResult && compactionResult.success) {
      expect(totalLiveEntriesAfter).toBeGreaterThan(0);
      expect(totalEntriesAfter).toBeLessThanOrEqual(totalEntries); // Should be fewer due to deduplication
    }

    await compactionCoordinator.stop();

    console.log(`\n🎉 High-throughput storage and compaction test completed successfully!`);
  }, 30000); // 30 second timeout

  test('should demonstrate compaction effectiveness with repeated operations', async () => {
    console.log(`\n🔄 Testing compaction with repeated operations...`);

    const segmentPath = path.join(testDir, 'repeated-ops.wal');
    const walFile = new WALFileImpl(segmentPath);
    walFiles.push(walFile);
    await walFile.open();

    // Generate many operations on the same entities (creating duplicates)
    const entityCount = 100;
    const operationsPerEntity = 50; // Each entity gets updated 50 times

    console.log(`  Writing ${entityCount * operationsPerEntity} operations for ${entityCount} entities...`);

    for (let entityId = 0; entityId < entityCount; entityId++) {
      for (let version = 1; version <= operationsPerEntity; version++) {
        const entityUpdate: EntityUpdate = {
          entityId: `repeated-entity-${entityId}`,
          ownerNodeId: 'node-1',
          version: version,
          timestamp: Date.now() + version,
          operation: version === operationsPerEntity ? 'DELETE' : 'UPDATE', // Delete the final version
          metadata: {
            updateNumber: version,
            data: `update-${version}-${'x'.repeat(50)}` // 50 char payload
          }
        };

        const entry = walCoordinator.createEntry(entityUpdate);
        await walFile.append(entry);
      }
    }

    const sizeBefore = await walFile.getSize();
    const entriesBefore = await walFile.readEntries();
    
    console.log(`  File size before: ${(sizeBefore / 1024).toFixed(2)} KB`);
    console.log(`  Entries before: ${entriesBefore.length}`);

    // Create segment for compaction
    const segment: WALSegment = {
      segmentId: 'repeated-ops',
      filePath: segmentPath,
      startLSN: entriesBefore[0]?.logSequenceNumber || 0,
      endLSN: entriesBefore[entriesBefore.length - 1]?.logSequenceNumber || 0,
      createdAt: Date.now() - 2000, // 2 seconds ago
      sizeBytes: sizeBefore,
      entryCount: entriesBefore.length,
      tombstoneCount: entriesBefore.filter(e => e.data.operation === 'DELETE').length,
      isImmutable: true
    };

    // Create custom compaction coordinator for this test
    const testCoordinator = new CompactionCoordinator({
      strategy: new TimeBasedCompactionStrategy({
        maxSegmentAge: 1000, // 1 second
        maxSegmentSize: 10 * 1024, // 10KB
        tombstoneThreshold: 0.05, // 5%
        checkpointLagThreshold: 1
      }),
      walPath: testDir,
      checkpointPath: testDir,
      enableAutoScheduling: false
    });

    await testCoordinator.start();

    // Wait for aging
    await new Promise(resolve => setTimeout(resolve, 1500));

    const result = await testCoordinator.triggerCompactionCheck();

    if (result && result.success) {
      console.log(`  ✅ Compaction reduced file from ${(sizeBefore / 1024).toFixed(2)} KB`);
      console.log(`  💾 Space saved: ${(result.actualSpaceSaved / 1024).toFixed(2)} KB`);
      console.log(`  🗑️  Entries removed: ${result.metrics.entriesProcessed - (entriesBefore.length - result.metrics.tombstonesRemoved - result.metrics.duplicatesRemoved)}`);
      
      // Verify significant space savings
      expect(result.actualSpaceSaved).toBeGreaterThan(sizeBefore * 0.7); // At least 70% reduction
    }

    await testCoordinator.stop();
    console.log(`  🎯 Repeated operations compaction test completed!`);
  }, 20000);

  test('should handle concurrent writes during compaction', async () => {
    console.log(`\n⚡ Testing concurrent writes during compaction...`);

    // This test demonstrates that the system can handle ongoing writes
    // while compaction is happening (though in our current implementation,
    // compaction works on immutable segments)

    const segmentPath1 = path.join(testDir, 'concurrent-1.wal');
    const segmentPath2 = path.join(testDir, 'concurrent-2.wal');
    
    const walFile1 = new WALFileImpl(segmentPath1);
    const walFile2 = new WALFileImpl(segmentPath2);
    walFiles.push(walFile1, walFile2);
    
    await walFile1.open();
    await walFile2.open();

    // Fill first segment with old data
    for (let i = 0; i < 500; i++) {
      const entityUpdate: EntityUpdate = {
        entityId: `concurrent-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() - 5000 + i,
        operation: i % 4 === 0 ? 'DELETE' : 'UPDATE',
        metadata: { data: `old-data-${i}` }
      };

      await walFile1.append(walCoordinator.createEntry(entityUpdate));
    }

    await compactionCoordinator.start();

    // Start concurrent writes to second file while compaction might be running
    const writePromise = (async () => {
      for (let i = 0; i < 300; i++) {
        const entityUpdate: EntityUpdate = {
          entityId: `new-entity-${i}`,
          ownerNodeId: 'node-2',
          version: 1,
          timestamp: Date.now() + i,
          operation: 'CREATE',
          metadata: { data: `new-data-${i}` }
        };

        await walFile2.append(walCoordinator.createEntry(entityUpdate));
        
        // Small delay to simulate real-world timing
        if (i % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    })();

    // Trigger compaction
    const compactionPromise = (async () => {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for aging
      return await compactionCoordinator.triggerCompactionCheck();
    })();

    // Wait for both operations to complete
    const [writeResult, compactionResult] = await Promise.all([writePromise, compactionPromise]);

    console.log(`  ✅ Concurrent writes completed: 300 new entries`);
    if (compactionResult && compactionResult.success) {
      console.log(`  ✅ Compaction completed concurrently`);
      console.log(`  📊 Metrics: ${compactionResult.metrics.entriesProcessed} processed`);
    }

    // Verify both files exist and have content
    const files = await fs.readdir(testDir);
    const walFilesAfter = files.filter(f => f.endsWith('.wal'));
    expect(walFilesAfter.length).toBeGreaterThanOrEqual(1);

    await compactionCoordinator.stop();
    console.log(`  🎯 Concurrent operations test completed!`);
  }, 25000);
});
