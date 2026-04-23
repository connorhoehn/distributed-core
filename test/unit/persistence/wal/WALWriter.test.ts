import { WALWriterImpl } from '../../../../src/persistence/wal/WALWriter';
import { WALFileImpl } from '../../../../src/persistence/wal/WALFile';
import { EntityUpdate } from '../../../../src/persistence/wal/types';

// Mock the WALFileImpl to avoid real filesystem I/O
jest.mock('../../../../src/persistence/wal/WALFile');

const MockedWALFileImpl = WALFileImpl as jest.MockedClass<typeof WALFileImpl>;

function makeMockFileImpl() {
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

function makeEntityUpdate(overrides: Partial<EntityUpdate> = {}): EntityUpdate {
  return {
    entityId: 'entity-1',
    version: 1,
    timestamp: Date.now(),
    operation: 'CREATE',
    ...overrides
  };
}

describe('WALWriterImpl', () => {
  let mockFileInstance: jest.Mocked<WALFileImpl>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFileInstance = makeMockFileImpl();
    // The constructor calls new WALFileImpl(filePath), so set up the mock to return our instance
    MockedWALFileImpl.mockImplementation(() => mockFileInstance);
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe('constructor', () => {
    test('should instantiate without error using default config', () => {
      const writer = new WALWriterImpl();
      expect(writer).toBeInstanceOf(WALWriterImpl);
      writer.close().catch(() => {});
    });

    test('should accept a custom filePath', () => {
      const writer = new WALWriterImpl({ filePath: '/custom/path.wal' });
      expect(writer).toBeInstanceOf(WALWriterImpl);
      writer.close().catch(() => {});
    });

    test('should accept all WALConfig fields', () => {
      const writer = new WALWriterImpl({
        filePath: '/data/entity.wal',
        maxFileSize: 50 * 1024 * 1024,
        syncInterval: 500,
        compressionEnabled: true,
        checksumEnabled: false
      });
      expect(writer).toBeInstanceOf(WALWriterImpl);
      writer.close().catch(() => {});
    });

    test('should start with LSN at 0', () => {
      const writer = new WALWriterImpl();
      expect(writer.getCurrentLSN()).toBe(0);
      writer.close().catch(() => {});
    });
  });

  describe('append', () => {
    test('should return an incrementing LSN starting at 1', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      const lsn1 = await writer.append(makeEntityUpdate());
      const lsn2 = await writer.append(makeEntityUpdate({ entityId: 'entity-2', version: 2 }));
      const lsn3 = await writer.append(makeEntityUpdate({ entityId: 'entity-3', version: 3 }));

      expect(lsn1).toBe(1);
      expect(lsn2).toBe(2);
      expect(lsn3).toBe(3);

      await writer.close();
    });

    test('should call walFile.append once per update', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      await writer.append(makeEntityUpdate());
      await writer.append(makeEntityUpdate({ entityId: 'entity-2', version: 2 }));

      expect(mockFileInstance.append).toHaveBeenCalledTimes(2);
      await writer.close();
    });

    test('should throw when file size limit is exceeded', async () => {
      mockFileInstance.getSize.mockResolvedValue(200 * 1024 * 1024); // 200MB > default 100MB

      const writer = new WALWriterImpl({ syncInterval: 0, maxFileSize: 100 * 1024 * 1024 });

      await expect(writer.append(makeEntityUpdate())).rejects.toThrow('WAL file size limit exceeded');
      await writer.close();
    });

    test('should track current LSN after appends', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      await writer.append(makeEntityUpdate());
      await writer.append(makeEntityUpdate({ entityId: 'entity-2', version: 2 }));

      expect(writer.getCurrentLSN()).toBe(2);
      await writer.close();
    });
  });

  describe('flush and sync', () => {
    test('flush should call walFile.flush', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      await writer.flush();

      expect(mockFileInstance.flush).toHaveBeenCalled();
      await writer.close();
    });

    test('sync should call walFile.flush', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      await writer.sync();

      expect(mockFileInstance.flush).toHaveBeenCalled();
      await writer.close();
    });
  });

  describe('close', () => {
    test('should call close without crashing', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      await expect(writer.close()).resolves.toBeUndefined();
      expect(mockFileInstance.close).toHaveBeenCalled();
    });

    test('should flush before closing', async () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });

      await writer.close();

      expect(mockFileInstance.flush).toHaveBeenCalled();
      expect(mockFileInstance.close).toHaveBeenCalled();
    });
  });

  describe('getCurrentLSN', () => {
    test('should return current LSN', () => {
      const writer = new WALWriterImpl({ syncInterval: 0 });
      expect(writer.getCurrentLSN()).toBe(0);
      writer.close().catch(() => {});
    });
  });
});
