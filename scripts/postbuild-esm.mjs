#!/usr/bin/env node
// Build ESM output under dist/esm/ from the four published entrypoints
// using esbuild in bundled mode.
//
// Why bundle (and not per-file transform)?
// The TS source mixes type and value re-exports in the same `export { ... }`
// statements (e.g. `export { Foo, FooConfig } from './foo'` where FooConfig is
// an interface). Per-file ESM transform leaves those as runtime named exports
// and Node fails them with "does not provide an export named ...". A few files
// also use the CJS-only `import X = require('mod')` syntax and dynamic
// `require()` calls inside function bodies — bundling resolves all of that
// uniformly because esbuild's bundler understands these constructs.
//
// We mark every direct + transitive dependency as `external` so the bundle
// stays as thin as possible and consumers' npm dedupe still works.
//
// After bundling we drop a `dist/esm/package.json` containing
// {"type":"module"} so Node treats the .js files in that subtree as ESM.
// The top-level package.json stays CJS-by-default (no "type" field) so
// `require('distributed-core')` keeps working unchanged.

import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const srcDir = join(repoRoot, 'src');
const outDir = join(repoRoot, 'dist', 'esm');

const pkg = require(join(repoRoot, 'package.json'));

// Mark every package dependency as external — bundling library code only,
// not its runtime deps.
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  // Node built-ins esbuild doesn't already mark as external for us.
  'node:*',
];

// The four entrypoints exposed via the `exports` map.
const entries = [
  { in: join(srcDir, 'index.ts'), out: 'index' },
  { in: join(srcDir, 'applications/pipeline/index.ts'), out: 'applications/pipeline/index' },
  { in: join(srcDir, 'gateway/index.ts'), out: 'gateway/index' },
  { in: join(srcDir, 'routing/index.ts'), out: 'routing/index' },
];

await build({
  entryPoints: entries,
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  bundle: true,
  splitting: true,
  sourcemap: true,
  logLevel: 'warning',
  external,
  outExtension: { '.js': '.js' },
  tsconfig: join(repoRoot, 'tsconfig.json'),
  // Bundling marks the output ESM, so dynamic `require()` calls in source
  // (e.g. `require('os').loadavg()`) need a real `require` binding. Inject
  // one via banner so they resolve at runtime.
  banner: {
    js:
      `import { createRequire as __dcoreCreateRequire } from 'node:module';\n` +
      `const require = __dcoreCreateRequire(import.meta.url);\n`,
  },
});

mkdirSync(outDir, { recursive: true });
const pkgPath = join(outDir, 'package.json');
writeFileSync(pkgPath, JSON.stringify({ type: 'module' }, null, 2) + '\n', 'utf8');

console.log(`[postbuild-esm] bundled ${entries.length} entrypoints to ${relative(repoRoot, outDir)}/`);
console.log(`[postbuild-esm] wrote ${relative(repoRoot, pkgPath)}`);
