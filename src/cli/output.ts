/**
 * CLI output formatting helpers
 *
 * Provides simple table, JSON, and colored output for the CLI
 * using ANSI escape codes. Zero external dependencies.
 */

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

/**
 * Print a formatted table with headers and rows.
 * Columns are auto-sized to fit the widest value.
 */
export function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => {
    const dataWidths = rows.map((r) => (r[i] || '').length);
    return Math.max(h.length, ...dataWidths);
  });

  const separator = colWidths.map((w) => '-'.repeat(w + 2)).join('+');
  const formatRow = (cells: string[]) =>
    cells.map((c, i) => ` ${(c || '').padEnd(colWidths[i])} `).join('|');

  console.log(`${BOLD}${formatRow(headers)}${RESET}`);
  console.log(separator);
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

/**
 * Print data as formatted JSON.
 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print a success message in green.
 */
export function printSuccess(msg: string): void {
  console.log(`${GREEN}${msg}${RESET}`);
}

/**
 * Print an error message in red.
 */
export function printError(msg: string): void {
  console.error(`${RED}Error: ${msg}${RESET}`);
}

/**
 * Print a warning message in yellow.
 */
export function printWarning(msg: string): void {
  console.warn(`${YELLOW}Warning: ${msg}${RESET}`);
}

/**
 * Print an info message in cyan.
 */
export function printInfo(msg: string): void {
  console.log(`${CYAN}${msg}${RESET}`);
}
