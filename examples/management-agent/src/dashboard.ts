/**
 * Dashboard -- formats a ClusterSnapshot into a human-readable text
 * dashboard for console output.
 */
import { ClusterSnapshot, NodeSnapshot } from './agent-handler';

/**
 * Render a full-width separator line.
 */
function separator(char = '-', width = 60): string {
  return char.repeat(width);
}

/**
 * Render the cluster dashboard as a multi-line string.
 */
export function renderDashboard(snapshot: ClusterSnapshot): string {
  const lines: string[] = [];

  lines.push(separator('='));
  lines.push('  CLUSTER MANAGEMENT DASHBOARD');
  lines.push(`  Collected at: ${new Date(snapshot.timestamp).toISOString()}`);
  lines.push(separator('='));

  // --- Node summary --------------------------------------------------------
  lines.push('');
  lines.push('  NODES');
  lines.push(separator('-'));

  const running = snapshot.nodes.filter((n) => n.isRunning).length;
  const stopped = snapshot.nodes.length - running;
  lines.push(`  Total: ${snapshot.nodes.length}   Running: ${running}   Stopped: ${stopped}`);
  lines.push('');

  for (const node of snapshot.nodes) {
    const status = node.isRunning ? 'UP' : 'DOWN';
    const healthLabel = node.health?.isHealthy ? 'healthy' : 'unhealthy';
    lines.push(
      `  [${status}] ${node.id}  members=${node.memberCount}  health=${healthLabel}`
    );
  }

  // --- System health -------------------------------------------------------
  lines.push('');
  lines.push('  SYSTEM HEALTH');
  lines.push(separator('-'));
  lines.push(`  Overall: ${snapshot.systemHealth?.status ?? 'unknown'}`);

  if (snapshot.systemHealth?.checks) {
    for (const [name, result] of Object.entries<any>(snapshot.systemHealth.checks)) {
      lines.push(`    ${name}: ${result.status} - ${result.message ?? ''}`);
    }
  }

  // --- Performance metrics -------------------------------------------------
  lines.push('');
  lines.push('  PERFORMANCE');
  lines.push(separator('-'));

  if (snapshot.metrics) {
    const m = snapshot.metrics;
    lines.push(`  CPU:    ${m.cpu?.percentage?.toFixed(1) ?? '?'}%`);
    lines.push(`  Memory: ${m.memory?.percentage?.toFixed(1) ?? '?'}%`);
    lines.push(`  Disk:   ${m.disk?.percentage?.toFixed(1) ?? '?'}%`);
  }

  // --- Chaos ---------------------------------------------------------------
  lines.push('');
  lines.push('  CHAOS INJECTION');
  lines.push(separator('-'));
  if (snapshot.chaosActive) {
    lines.push(`  Active scenarios: ${snapshot.activeScenarios.join(', ')}`);
  } else {
    lines.push('  No active chaos scenarios.');
  }

  lines.push('');
  lines.push(separator('='));

  return lines.join('\n');
}
