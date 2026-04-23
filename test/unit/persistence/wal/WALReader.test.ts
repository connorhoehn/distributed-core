import { WALReaderImpl } from '../../../../src/persistence/wal/WALReader';
import { WALFileImpl } from '../../../../src/persistence/wal/WALFile';
import { WALEntry, EntityUpdate } from '../../../../src/persistence/wal/types';

// Mock the WALFileImpl to avoid real filesystem I/O
jest.mock('../../../../src/persistence/wal/WALFile');

const MockedWALFileImpl = WALFileImpl as jest.MockedClass<typeof WALFileImpl>;

function makeWALEntry(lsn: number, overrides: Partial<WALEntry> = {}): WALEntry {
  const update: EntityUpdate = {
    entityId: `entity-${lsn}`,
    version: lsn,
    timestamp: Date.now(),
    operation: 'CREATE'
  };
  // Calculate a matching checksum via WALCoordinatorImpl logic (SHA-256 of JSON-serialized update)
  const crypto = require('crypto');
  const checksum = crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex');

  return {
    logSequenceNumber: lsn,
    timestamp: Date.now(),
    data: update,
    checksum,
    ...overrides
  };
}

function makeMockFileInstance() {
  const instance = new MockedWALFileImpl('/mock/path.wal') as jest.Mocked<WALFileImpl>;
  instance.open = jest.fn().mockResolvedValue(undefined);
  instance.append = jest.fn().mockResolvedValue(undefined);
  instance.readEntries = jest.fn().mockResolvedValue([]);
  instance.getLastLSN = jest.fn().mockResolvedValue(0);
  instance.getSize = jest.fn().mockResolvedValue(0);
  instance.truncate = jest.fn().mockResolvedValue(undefined);
  instance.flush = jest.fn().mockResolvedValue(undefined);
  instance.close = jest.fn().mockResolvedValue(undefined);
  return instance;
}

describe('WALReaderImpl', () => {
  let mockFileInstance: jest.Mocked<WALFileImpl>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFileInstance = makeMockFileInstance();
    MockedWALFileImpl.mockImplementation(() => mockFileInstance);
  });

  describe('constructor', () => {
    test('should instantiate without error given a file path', () => {
      const reader = new WALReaderImpl('/some/path.wal');
      expect(reader).toBeInstanceOf(WALReaderImpl);
    });

    test('should accept any string as file path', () => {
      const reader = new WALReaderImpl('./data/wal/default.wal');
      expect(reader).toBeInstanceOf(WALReaderImpl);
    });
  });

  describe('readAll', () => {
    test('should return an empty array when file is empty', async () => {
      mockFileInstance.readEntries.mockResolvedValue([]);

      const reader = new WALReaderImpl('/some/path.wal');
      const entries = await reader.readAll();

      expect(entries).toEqual([]);
    });

    test('should return valid entries from file', async () => {
      const entry1 = makeWALEntry(1);
      const entry2 = makeWALEntry(2);
      mockFileInstance.readEntries.mockResolvedValue([entry1, entry2]);

      const reader = new WALReaderImpl('/some/path.wal');
      const entries = await reader.readAll();

      expect(entries).toHaveLength(2);
      expect(entries[0].logSequenceNumber).toBe(1);
      expect(entries[1].logSequenceNumber).toBe(2);
    });

    test('should filter out entries with invalid checksums', async () => {
      const validEntry = makeWALEntry(1);
      const invalidEntry: WALEntry = {
        ...makeWALEntry(2),
        checksum: 'bad-checksum'
      };
      mockFileInstance.readEntries.mockResolvedValue([validEntry, invalidEntry]);

      const reader = new WALReaderImpl('/some/path.wal');
      const entries = await reader.readAll();

      expect(entries).toHaveLength(1);
      expect(entries[0].logSequenceNumber).toBe(1);
    });
  });

  describe('getLastSequenceNumber', () => {
    test('should return 0 for an empty file', async () => {
      mockFileInstance.getLastLSN.mockResolvedValue(0);

      const reader = new WALReaderImpl('/some/path.wal');
      const lsn = await reader.getLastSequenceNumber();

      expect(lsn).toBe(0);
    });

    test('should return the last LSN from the file', async () => {
      mockFileInstance.getLastLSN.mockResolvedValue(42);

      const reader = new WALReaderImpl('/some/path.wal');
      const lsn = await reader.getLastSequenceNumber();

      expect(lsn).toBe(42);
    });
  });

  describe('readFrom', () => {
    test('should yield only valid entries from the specified LSN', async () => {
      const entry1 = makeWALEntry(1);
      const entry2 = makeWALEntry(2);
      mockFileInstance.readEntries.mockResolvedValue([entry1, entry2]);

      const reader = new WALReaderImpl('/some/path.wal');
      const yielded: WALEntry[] = [];

      for await (const entry of reader.readFrom(1)) {
        yielded.push(entry);
      }

      expect(yielded).toHaveLength(2);
    });

    test('should yield nothing when file is empty', async () => {
      mockFileInstance.readEntries.mockResolvedValue([]);

      const reader = new WALReaderImpl('/some/path.wal');
      const yielded: WALEntry[] = [];

      for await (const entry of reader.readFrom(0)) {
        yielded.push(entry);
      }

      expect(yielded).toHaveLength(0);
    });
  });

  describe('replay', () => {
    test('should call handler for each valid entry', async () => {
      const entry1 = makeWALEntry(1);
      const entry2 = makeWALEntry(2);
      mockFileInstance.readEntries.mockResolvedValue([entry1, entry2]);

      const reader = new WALReaderImpl('/some/path.wal');
      const processed: WALEntry[] = [];

      await reader.replay(async (entry) => {
        processed.push(entry);
      });

      expect(processed).toHaveLength(2);
      expect(processed[0].logSequenceNumber).toBe(1);
      expect(processed[1].logSequenceNumber).toBe(2);
    });

    test('should continue replay even if handler throws for one entry', async () => {
      const entry1 = makeWALEntry(1);
      const entry2 = makeWALEntry(2);
      mockFileInstance.readEntries.mockResolvedValue([entry1, entry2]);

      const reader = new WALReaderImpl('/some/path.wal');
      const processed: number[] = [];

      await reader.replay(async (entry) => {
        if (entry.logSequenceNumber === 1) {
          throw new Error('handler error');
        }
        processed.push(entry.logSequenceNumber);
      });

      expect(processed).toEqual([2]);
    });
  });

  describe('close', () => {
    test('should close without crashing', async () => {
      const reader = new WALReaderImpl('/some/path.wal');

      await expect(reader.close()).resolves.toBeUndefined();
      expect(mockFileInstance.close).toHaveBeenCalled();
    });
  });
});
