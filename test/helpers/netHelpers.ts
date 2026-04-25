/**
 * Network test helpers — port allocation utilities.
 *
 * Using port: 0 lets the OS assign a free ephemeral port. Call
 * `getFreePort()` before constructing a server if you need to know the
 * port number up front (e.g. to build a URL for an HTTP request inside
 * the same test).
 */

import * as net from 'net';

/**
 * Ask the OS for a free TCP port on 127.0.0.1.
 *
 * The server is immediately closed after the port is reserved, so there
 * is a tiny TOCTOU window — but in practice this is fine for unit tests
 * running on localhost where ports are not shared with other processes.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Unexpected server address type')));
        return;
      }
      const { port } = addr;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.once('error', reject);
  });
}
