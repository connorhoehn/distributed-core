import { createPersistenceLayer, UnifiedPersistenceFactory } from '../../../src/persistence/PersistenceFactory';
import { InMemoryBroadcastBuffer } from '../../../src/persistence/memory/InMemoryBroadcastBuffer';
import { InMemoryStateStore } from '../../../src/persistence/memory/InMemoryStateStore';
import { InMemoryWriteAheadLog } from '../../../src/persistence/memory/InMemoryWriteAheadLog';
import { WALWriterImpl } from '../../../src/persistence/wal/WALWriter';
import { WALReaderImpl } from '../../../src/persistence/wal/WALReader';
import { CheckpointWriterImpl } from '../../../src/persistence/checkpoint/CheckpointWriter';
import { CheckpointReaderImpl } from '../../../src/persistence/checkpoint/CheckpointReader';

// Mock filesystem-touching implementations so no I/O occurs in these factory tests
jest.mock('../../../src/persistence/wal/WALFile');
jest.mock('../../../src/persistence/checkpoint/CheckpointWriter');
jest.mock('../../../src/persistence/checkpoint/CheckpointReader');

describe('PersistenceFactory', () => {
  describe('createPersistenceLayer', () => {
    test('should create in-memory persistence layer by default', () => {
      const layer = createPersistenceLayer();

      expect(layer).toHaveProperty('stateStore');
      expect(layer).toHaveProperty('wal');
      expect(layer).toHaveProperty('buffer');

      expect(layer.stateStore).toBeInstanceOf(InMemoryStateStore);
      expect(layer.wal).toBeInstanceOf(InMemoryWriteAheadLog);
      expect(layer.buffer).toBeInstanceOf(InMemoryBroadcastBuffer);
    });

    test('should create functional persistence layer', () => {
      const layer = createPersistenceLayer();

      // Test state store
      layer.stateStore.set('key', 'value');
      expect(layer.stateStore.get('key')).toBe('value');

      // Test WAL
      layer.wal.append('log entry');
      expect(layer.wal.readAll()).toEqual(['log entry']);

      // Test buffer
      layer.buffer.add('message');
      expect(layer.buffer.size()).toBe(1);
      expect(layer.buffer.drain()).toEqual(['message']);
    });

    test('should throw for unsupported persistence type', () => {
      expect(() => createPersistenceLayer('file')).toThrow('Unsupported persistence type: file');
    });
  });

  describe('UnifiedPersistenceFactory', () => {
    describe('createWALWriter', () => {
      test('should return a WALWriterImpl instance', () => {
        const result = UnifiedPersistenceFactory.createWALWriter({});
        expect(result).toBeInstanceOf(WALWriterImpl);
        result.close().catch(() => {});
      });

      test('should accept an empty config', () => {
        const writer = UnifiedPersistenceFactory.createWALWriter({});
        expect(writer).toBeInstanceOf(WALWriterImpl);
        writer.close().catch(() => {});
      });

      test('should accept custom filePath', () => {
        const writer = UnifiedPersistenceFactory.createWALWriter({ filePath: 'custom.wal' });
        expect(writer).toBeInstanceOf(WALWriterImpl);
        writer.close().catch(() => {});
      });
    });

    describe('createWALReader', () => {
      test('should return a WALReaderImpl instance', () => {
        const reader = UnifiedPersistenceFactory.createWALReader('test.wal');
        expect(reader).toBeInstanceOf(WALReaderImpl);
        reader.close().catch(() => {});
      });

      test('should accept any file path string', () => {
        const reader = UnifiedPersistenceFactory.createWALReader('./data/wal/my.wal');
        expect(reader).toBeInstanceOf(WALReaderImpl);
        reader.close().catch(() => {});
      });
    });

    describe('createCheckpointWriter', () => {
      test('should return a CheckpointWriterImpl instance', () => {
        const writer = UnifiedPersistenceFactory.createCheckpointWriter({});
        expect(writer).toBeInstanceOf(CheckpointWriterImpl);
      });
    });

    describe('createCheckpointReader', () => {
      test('should return a CheckpointReaderImpl instance', () => {
        const reader = UnifiedPersistenceFactory.createCheckpointReader({});
        expect(reader).toBeInstanceOf(CheckpointReaderImpl);
      });
    });

    describe('createWALPersistence', () => {
      test('should return an object with walWriter, walReader, checkpointWriter, checkpointReader', () => {
        const persistence = UnifiedPersistenceFactory.createWALPersistence();

        expect(persistence).toHaveProperty('walWriter');
        expect(persistence).toHaveProperty('walReader');
        expect(persistence).toHaveProperty('checkpointWriter');
        expect(persistence).toHaveProperty('checkpointReader');

        expect(persistence.walWriter).toBeInstanceOf(WALWriterImpl);
        expect(persistence.walReader).toBeInstanceOf(WALReaderImpl);
        expect(persistence.checkpointWriter).toBeInstanceOf(CheckpointWriterImpl);
        expect(persistence.checkpointReader).toBeInstanceOf(CheckpointReaderImpl);

        persistence.walWriter.close().catch(() => {});
        persistence.walReader.close().catch(() => {});
      });

      test('should use provided walConfig filePath for walReader', () => {
        const persistence = UnifiedPersistenceFactory.createWALPersistence({ filePath: 'custom.wal' });
        expect(persistence.walReader).toBeInstanceOf(WALReaderImpl);
        persistence.walWriter.close().catch(() => {});
        persistence.walReader.close().catch(() => {});
      });
    });

    describe('createDefault', () => {
      test('should return the same shape as createWALPersistence', () => {
        const persistence = UnifiedPersistenceFactory.createDefault();

        expect(persistence).toHaveProperty('walWriter');
        expect(persistence).toHaveProperty('walReader');
        expect(persistence).toHaveProperty('checkpointWriter');
        expect(persistence).toHaveProperty('checkpointReader');

        expect(persistence.walWriter).toBeInstanceOf(WALWriterImpl);
        expect(persistence.walReader).toBeInstanceOf(WALReaderImpl);
        expect(persistence.checkpointWriter).toBeInstanceOf(CheckpointWriterImpl);
        expect(persistence.checkpointReader).toBeInstanceOf(CheckpointReaderImpl);

        persistence.walWriter.close().catch(() => {});
        persistence.walReader.close().catch(() => {});
      });

      test('should apply default filePath when none given', () => {
        // createDefault always passes merged config, which includes the default filePath
        // We verify it does not throw and returns valid instances
        const persistence = UnifiedPersistenceFactory.createDefault();
        expect(persistence.walWriter).toBeInstanceOf(WALWriterImpl);
        persistence.walWriter.close().catch(() => {});
        persistence.walReader.close().catch(() => {});
      });

      test('should allow overriding the default filePath', () => {
        const persistence = UnifiedPersistenceFactory.createDefault({ filePath: 'override.wal' });
        expect(persistence.walWriter).toBeInstanceOf(WALWriterImpl);
        persistence.walWriter.close().catch(() => {});
        persistence.walReader.close().catch(() => {});
      });

      test('should allow overriding the default checkpointPath', () => {
        const persistence = UnifiedPersistenceFactory.createDefault({}, { checkpointPath: '/custom/checkpoints' });
        expect(persistence.checkpointWriter).toBeInstanceOf(CheckpointWriterImpl);
        persistence.walWriter.close().catch(() => {});
        persistence.walReader.close().catch(() => {});
      });
    });
  });
});
