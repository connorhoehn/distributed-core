import { CheckpointWriterImpl } from '../../../src/cluster/entity/checkpoint/CheckpointWriter';
import { CheckpointReaderImpl } from '../../../src/cluster/entity/checkpoint/CheckpointReader';
import { WriteAheadLogEntityRegistry } from '../../../src/cluster/entity/WriteAheadLogEntityRegistry';
import { EntityState } from '../../../src/cluster/entity/checkpoint/types';
import { promises as fs } from 'fs';

describe('Checkpoint Recovery Tests', () => {
  const testDir = './test-data/checkpoints';
  const walDir = './test-data/wal';
  
  beforeEach(async () => {
    // Clean up test directories
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.rm(walDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(walDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directories
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.rm(walDir, { recursive: true, force: true });
  });

  describe('CheckpointWriter', () => {
    it('should write and read snapshots', async () => {
      const writer = new CheckpointWriterImpl({
        checkpointPath: testDir,
        keepHistory: 3
      });

      const entities: Record<string, EntityState> = {
        'entity-1': {
          id: 'entity-1',
          type: 'test',
          data: { value: 'test1' },
          version: 1,
          hostNodeId: 'node-1',
          lastModified: Date.now()
        },
        'entity-2': {
          id: 'entity-2',
          type: 'test',
          data: { value: 'test2' },
          version: 2,
          hostNodeId: 'node-1',
          lastModified: Date.now()
        }
      };

      await writer.writeSnapshot(100, entities);

      // Verify files were created
      const files = await fs.readdir(testDir);
      expect(files).toContain('checkpoint-lsn-00000100.json');
      expect(files).toContain('latest.json');

      // Read latest info
      const latestContent = await fs.readFile(`${testDir}/latest.json`, 'utf-8');
      const latest = JSON.parse(latestContent);
      expect(latest.lsn).toBe(100);
      expect(latest.filename).toBe('checkpoint-lsn-00000100.json');
    });

    it('should cleanup old checkpoints', async () => {
      const writer = new CheckpointWriterImpl({
        checkpointPath: testDir,
        keepHistory: 2
      });

      const entities: Record<string, EntityState> = {
        'entity-1': {
          id: 'entity-1',
          type: 'test',
          data: { value: 'test' },
          version: 1,
          hostNodeId: 'node-1',
          lastModified: Date.now()
        }
      };

      // Create multiple checkpoints
      await writer.writeSnapshot(100, entities);
      await writer.writeSnapshot(200, entities);
      await writer.writeSnapshot(300, entities);

      // Should only keep latest 2
      const files = await fs.readdir(testDir);
      const checkpointFiles = files.filter(f => f.startsWith('checkpoint-lsn-'));
      expect(checkpointFiles).toHaveLength(2);
      expect(checkpointFiles).toContain('checkpoint-lsn-00000200.json');
      expect(checkpointFiles).toContain('checkpoint-lsn-00000300.json');
    });
  });

  describe('CheckpointReader', () => {
    let writer: CheckpointWriterImpl;
    let reader: CheckpointReaderImpl;

    beforeEach(() => {
      writer = new CheckpointWriterImpl({ checkpointPath: testDir });
      reader = new CheckpointReaderImpl({ checkpointPath: testDir });
    });

    it('should read latest snapshot', async () => {
      const entities: Record<string, EntityState> = {
        'entity-1': {
          id: 'entity-1',
          type: 'test',
          data: { value: 'test1' },
          version: 1,
          hostNodeId: 'node-1',
          lastModified: Date.now()
        }
      };

      await writer.writeSnapshot(150, entities);

      const snapshot = await reader.readLatest();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.lsn).toBe(150);
      expect(snapshot!.entities['entity-1'].data.value).toBe('test1');
    });

    it('should return null when no checkpoint exists', async () => {
      const snapshot = await reader.readLatest();
      expect(snapshot).toBeNull();
    });
  });

  describe('WriteAheadLogEntityRegistry with Checkpointing', () => {
    let registry: WriteAheadLogEntityRegistry;

    beforeEach(async () => {
      registry = new WriteAheadLogEntityRegistry('test-node', {
        filePath: `${walDir}/test.wal`,
        syncInterval: 0, // Disable timer for tests
        checkpointPath: testDir,
        interval: 0, // Disable periodic checkpointing for manual control
        lsnThreshold: 3, // Checkpoint every 3 operations
        keepHistory: 2
      });
      await registry.start();
    });

    afterEach(async () => {
      await registry.stop();
    });

    it('should create checkpoint after threshold operations', async () => {
      // Create entities to trigger checkpoint at LSN 3
      await registry.proposeEntity('entity-1', { value: 'test1' });
      await registry.proposeEntity('entity-2', { value: 'test2' });
      await registry.proposeEntity('entity-3', { value: 'test3' });

      // Wait a bit for async checkpoint
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check if checkpoint was created
      const files = await fs.readdir(testDir);
      const checkpointFiles = files.filter(f => f.startsWith('checkpoint-lsn-'));
      expect(checkpointFiles.length).toBeGreaterThan(0);
    });

    it('should restore from checkpoint on restart', async () => {
      // Create entities
      await registry.proposeEntity('entity-1', { value: 'test1' });
      await registry.proposeEntity('entity-2', { value: 'test2' });
      
      // Force checkpoint
      await registry.forceCheckpoint();
      
      // Add more entities after checkpoint
      await registry.proposeEntity('entity-3', { value: 'test3' });
      
      // Stop registry
      await registry.stop();

      // Create new registry instance
      const registry2 = new WriteAheadLogEntityRegistry('test-node', {
        filePath: `${walDir}/test.wal`,
        syncInterval: 0,
        checkpointPath: testDir,
        interval: 0,
        lsnThreshold: 0 // Disable auto-checkpointing
      });

      await registry2.start();

      // Should have all entities restored
      expect(registry2.getEntity('entity-1')).not.toBeNull();
      expect(registry2.getEntity('entity-2')).not.toBeNull();
      expect(registry2.getEntity('entity-3')).not.toBeNull();
      
      const entity1 = registry2.getEntity('entity-1');
      const entity3 = registry2.getEntity('entity-3');
      if (entity1 && entity1.metadata) {
        expect(entity1.metadata.value).toBe('test1');
      }
      if (entity3 && entity3.metadata) {
        expect(entity3.metadata.value).toBe('test3');
      }

      await registry2.stop();
    });
  });
});
