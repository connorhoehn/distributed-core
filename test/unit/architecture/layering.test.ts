/**
 * Architecture Fitness Function Tests
 *
 * These tests enforce architectural boundaries by scanning the source tree.
 * They are fast (filesystem-only) and should run on every CI build so that
 * layering violations are caught before they reach main.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect every .ts file under `dir`. */
function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

/** Return every `from '...'` / `from "..."` import specifier found in `content`. */
function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  // Matches: import ... from 'x'  |  import ... from "x"  |  require('x')
  const importRegex = /(?:from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    paths.push(m[1] ?? m[2]);
  }
  return paths;
}

/** True when `specifier` is a relative path that reaches into `targetModule`. */
function importsModule(specifier: string, targetModule: string): boolean {
  // Normalise to forward-slashes so the check works on Windows too
  const norm = specifier.replace(/\\/g, '/');
  // e.g. '../cluster', '../cluster/Foo', '../../cluster/Foo'
  return new RegExp(`(^|/)${targetModule}(/|$)`).test(norm) && norm.startsWith('.');
}

// ---------------------------------------------------------------------------
// 1. Transport has no cluster imports
// ---------------------------------------------------------------------------

describe('Transport layer boundary', () => {
  const transportDir = path.join(SRC, 'transport');
  const files = collectTsFiles(transportDir);

  it('should have transport source files to validate', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('does not import from the cluster module', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = extractImportPaths(content);
      for (const imp of imports) {
        if (importsModule(imp, 'cluster')) {
          violations.push(`${path.relative(SRC, file)} imports '${imp}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Persistence has no cluster or resources imports
// ---------------------------------------------------------------------------

describe('Persistence layer boundary', () => {
  const persistenceDir = path.join(SRC, 'persistence');
  const files = collectTsFiles(persistenceDir);

  it('should have persistence source files to validate', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(['cluster', 'resources'])('does not import from the %s module', (mod) => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = extractImportPaths(content);
      for (const imp of imports) {
        if (importsModule(imp, mod)) {
          violations.push(`${path.relative(SRC, file)} imports '${imp}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. No circular dependencies between top-level modules
// ---------------------------------------------------------------------------

describe('No circular cross-module imports', () => {
  /**
   * For a given pair (A, B) we assert that the dependency is one-way:
   * if any file in A imports B, then no file in B may import A.
   */
  function detectCircular(moduleA: string, moduleB: string): string[] {
    const dirA = path.join(SRC, moduleA);
    const dirB = path.join(SRC, moduleB);
    const filesA = collectTsFiles(dirA);
    const filesB = collectTsFiles(dirB);

    const aImportsB = filesA.some((f) => {
      const imports = extractImportPaths(fs.readFileSync(f, 'utf-8'));
      return imports.some((imp) => importsModule(imp, moduleB));
    });

    const bImportsA = filesB.some((f) => {
      const imports = extractImportPaths(fs.readFileSync(f, 'utf-8'));
      return imports.some((imp) => importsModule(imp, moduleA));
    });

    if (aImportsB && bImportsA) {
      return [`Circular dependency: ${moduleA} <-> ${moduleB}`];
    }
    return [];
  }

  it.each([
    ['transport', 'cluster'],
    ['persistence', 'cluster'],
    ['resources', 'transport'],
  ])('no circular dependency between %s and %s', (a, b) => {
    const violations = detectCircular(a, b);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Barrel files export only existing modules
// ---------------------------------------------------------------------------

describe('Barrel file exports resolve to real files', () => {
  const barrelFiles = collectTsFiles(SRC).filter((f) => path.basename(f) === 'index.ts');

  it('should have barrel files to validate', () => {
    expect(barrelFiles.length).toBeGreaterThan(0);
  });

  for (const barrel of barrelFiles) {
    const relBarrel = path.relative(SRC, barrel);

    it(`${relBarrel} — all re-exported paths resolve`, () => {
      const content = fs.readFileSync(barrel, 'utf-8');
      const imports = extractImportPaths(content);
      const unresolved: string[] = [];

      for (const imp of imports) {
        // Skip bare-specifier (npm packages)
        if (!imp.startsWith('.')) continue;

        const barrelDir = path.dirname(barrel);
        const resolved = path.resolve(barrelDir, imp);

        // Could be a file (.ts) or a directory with an index.ts
        const candidates = [
          resolved + '.ts',
          resolved + '.tsx',
          path.join(resolved, 'index.ts'),
          resolved, // exact file (rare)
        ];

        const exists = candidates.some((c) => fs.existsSync(c));
        if (!exists) {
          unresolved.push(`'${imp}' (from ${relBarrel})`);
        }
      }

      expect(unresolved).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. No business (chat-specific) logic in core
// ---------------------------------------------------------------------------

describe('No chat-specific business logic in core modules', () => {
  // ChatRoomCoordinator has been moved to examples/chat-room/ — no chat-specific
  // business logic should remain inside src/.
  const ALLOWED_PATH = '__none__'; // sentinel that will never match a real path

  const chatPatterns = [
    /\bchat\s*room\b/i,
    /\bjoin\s*room\b/i,
    /\bleave\s*room\b/i,
    /\bchat\s*message\b/i,
    /\broom\s*member\b/i,
  ];

  it('source filenames do not contain chat-specific terms (outside allowed path)', () => {
    const allFiles = collectTsFiles(SRC);
    const chatTerms = ['chatroom', 'chat-room', 'chat_room', 'joinroom', 'join-room'];
    const violations: string[] = [];

    for (const file of allFiles) {
      const rel = path.relative(SRC, file);
      if (rel.startsWith(ALLOWED_PATH)) continue;

      const lower = path.basename(file).toLowerCase();
      for (const term of chatTerms) {
        if (lower.includes(term)) {
          violations.push(`${rel} — filename contains '${term}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('source file contents do not contain chat-specific terms (outside allowed path)', () => {
    const allFiles = collectTsFiles(SRC);
    const violations: string[] = [];

    for (const file of allFiles) {
      const rel = path.relative(SRC, file);
      if (rel.startsWith(ALLOWED_PATH)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of chatPatterns) {
        if (pattern.test(content)) {
          violations.push(`${rel} — matches ${pattern}`);
          break; // one violation per file is enough
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
