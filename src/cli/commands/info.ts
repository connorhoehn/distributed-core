/**
 * info command - Print detailed cluster topology and introspection data
 *
 * Similar to status but outputs topology, metadata, and ring information.
 */

import { createNode } from '../../frontdoor';
import { ResolvedConfig } from '../config';
import { printTable, printJson, printError, printInfo } from '../output';

export async function infoCommand(config: ResolvedConfig): Promise<void> {
  const handle = await createNode({
    id: config.nodeId || `info-probe-${Date.now()}`,
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
    const cluster = handle.getCluster();
    const health = cluster.getClusterHealth();
    const topology = cluster.getTopology();
    const metadata = cluster.getClusterMetadata();
    const membership = handle.getMembership();

    if (config.outputJson) {
      const members: Record<string, unknown>[] = [];
      membership.forEach((entry: any, id: string) => {
        members.push({
          id,
          status: entry.status,
          lastSeen: entry.lastSeen,
          metadata: entry.metadata,
        });
      });
      printJson({ nodeId: handle.id, health, topology, metadata, members });
    } else {
      // Node info
      printInfo('Node Info');
      printInfo(`  ID:       ${handle.id}`);
      printInfo(`  Running:  ${handle.isRunning() ? 'yes' : 'no'}`);
      printInfo('');

      // Cluster health
      printInfo('Cluster Health');
      printInfo(`  Total:    ${health.totalNodes}`);
      printInfo(`  Alive:    ${health.aliveNodes}`);
      printInfo(`  Suspect:  ${health.suspectNodes}`);
      printInfo(`  Dead:     ${health.deadNodes}`);
      printInfo(`  Healthy:  ${health.isHealthy ? 'yes' : 'no'}`);
      printInfo('');

      // Topology
      printInfo('Topology');
      printInfo(`  Alive nodes:       ${topology.totalAliveNodes}`);
      printInfo(`  Replication factor: ${topology.replicationFactor}`);
      printInfo(`  Avg load balance:   ${topology.averageLoadBalance.toFixed(3)}`);

      if (Object.keys(topology.zones).length > 0) {
        printInfo(`  Zones:             ${JSON.stringify(topology.zones)}`);
      }
      if (Object.keys(topology.regions).length > 0) {
        printInfo(`  Regions:           ${JSON.stringify(topology.regions)}`);
      }
      printInfo('');

      // Metadata
      printInfo('Cluster Metadata');
      printInfo(`  Cluster ID: ${metadata.clusterId}`);
      printInfo(`  Version:    ${metadata.version}`);
      printInfo(`  Node count: ${metadata.nodeCount}`);
      if (metadata.roles.length > 0) {
        printInfo(`  Roles:      ${metadata.roles.join(', ')}`);
      }
      printInfo('');

      // Membership table
      const headers = ['Node ID', 'Status', 'Last Seen', 'Region', 'Zone', 'Role'];
      const rows: string[][] = [];
      membership.forEach((entry: any, id: string) => {
        rows.push([
          id,
          entry.status,
          new Date(entry.lastSeen).toISOString(),
          entry.metadata?.region || '-',
          entry.metadata?.zone || '-',
          entry.metadata?.role || '-',
        ]);
      });
      printTable(headers, rows);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to read cluster info: ${msg}`);
    process.exitCode = 1;
  } finally {
    try {
      await handle.stop();
    } catch {
      // Best-effort cleanup
    }
  }
}
