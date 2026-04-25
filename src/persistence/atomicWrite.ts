import * as fs from 'fs/promises';
import * as path from 'path';
import { defaultLogger } from '../common/logger';

/**
 * Atomically writes a file using the write-temp → fsync → rename pattern.
 *
 * The caller supplies a `writer` callback that receives the temp-file path and
 * must write all content to it.  After the callback resolves:
 *   1. The temp file is fsync'd (ensures kernel buffers are flushed to storage).
 *   2. The temp file is renamed over `finalPath` (atomic on a POSIX filesystem).
 *   3. The parent directory is fsync'd so the new directory entry is durable
 *      (best-effort; some file systems / kernels do not support dir-fd sync and
 *      will get a warning rather than an error).
 *
 * If anything fails the temp file is removed and the original `finalPath` is
 * left untouched.
 */
export async function atomicWriteFile(
  finalPath: string,
  writer: (tmpPath: string) => Promise<void>,
): Promise<void> {
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    await writer(tmpPath);

    // fsync the temp file so its contents reach stable storage.
    const fileHandle = await fs.open(tmpPath, 'r+');
    try {
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    // Rename over the final path — atomic on the same filesystem.
    await fs.rename(tmpPath, finalPath);

    // fsync the parent directory to make the new directory entry durable.
    // Not all file systems support syncing a directory fd; treat failure as
    // advisory (warn but don't throw).
    const dirHandle = await fs.open(path.dirname(finalPath), 'r').catch(() => null);
    if (dirHandle) {
      try {
        await dirHandle.sync();
      } catch {
        defaultLogger.warn(
          '[atomicWriteFile] Directory fsync not supported on this filesystem; ' +
            'directory-entry durability may be reduced.',
        );
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    }
  } catch (err) {
    // Best-effort cleanup of the temp file; leave finalPath untouched.
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
