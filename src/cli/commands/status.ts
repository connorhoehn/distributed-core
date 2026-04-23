/**
 * status command - Query cluster health and membership
 *
 * Creates a temporary node, joins the cluster via seed nodes, reads
 * health/membership data, prints it, and exits. For a research kernel
 * this approach (joining as a full member to read state) is acceptable.
 */

import { createNode } from '../../frontdoor';
import { ResolvedConfig } from '../config';
import { printTable, printJson, printError, printInfo } from '../output';

export async function statusCommand(config: ResolvedConfig): Promise<void> {
  const handle = await createNode({
    id: config.nodeId || `status-probe-${Date.now()}`,
    port: config.port,
    address: config.host,
    transport: config.transport === 'grpc' ? 'tcp' : config.transport,
    seedNodes: config.seedNodes,
    logging: config.enableLogging,
    region: config.region,
    zone: config.zone,
    role: 'probe',
  });

  try {
    await handle.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to connect to cluster: ${msg}`);
    process.exitCode = 1;
    return;
  }

  try {
    const health = handle.getCluster().getClusterHealth();
    const membership = handle.getMembership();

    if (config.outputJson) {
      const members: Record<string, unknown>[] = [];
      membership.forEach((entry: any, id: string) => {
        members.push({ id, status: entry.status, lastSeen: entry.lastSeen });
      });
      printJson({ health, members });
    } else {
      printInfo('Cluster Health');
      printInfo(`  Total nodes:    ${health.totalNodes}`);
      printInfo(`  Alive:          ${health.aliveNodes}`);
      printInfo(`  Suspect:        ${health.suspectNodes}`);
      printInfo(`  Dead:           ${health.deadNodes}`);
      printInfo(`  Health ratio:   ${(health.healthRatio * 100).toFixed(1)}%`);
      printInfo(`  Healthy:        ${health.isHealthy ? 'yes' : 'no'}`);
      printInfo('');

      const headers = ['Node ID', 'Status', 'Last Seen'];
      const rows: string[][] = [];
      membership.forEach((entry: any, id: string) => {
        rows.push([id, entry.status, new Date(entry.lastSeen).toISOString()]);
      });
      printTable(headers, rows);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to read cluster status: ${msg}`);
    process.exitCode = 1;
  } finally {
    try {
      await handle.stop();
    } catch {
      // Best-effort cleanup
    }
  }
}
