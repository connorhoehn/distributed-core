import {
  ResourceAuthorizationService,
  Permission,
  Principal,
  Role,
} from '../../../src/resources/security/ResourceAuthorizationService';
import { ResourceOperation, VectorClock } from '../../../src/resources/core/ResourceOperation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal VectorClock stub -- enough to satisfy the ResourceOperation shape. */
function stubVectorClock(nodeId: string): VectorClock {
  const vector = new Map<string, number>([[nodeId, 1]]);
  return {
    nodeId,
    vector,
    increment() { return this; },
    compare() { return 0; },
    merge() { return this; },
  };
}

function makeOperation(
  type: 'CREATE' | 'UPDATE' | 'DELETE',
  resourceId: string,
): ResourceOperation {
  return {
    opId: `op-${Math.random().toString(36).slice(2)}`,
    resourceId,
    type,
    version: 1,
    timestamp: Date.now(),
    originNodeId: 'node-1',
    payload: {},
    parents: [],
    vectorClock: stubVectorClock('node-1'),
    correlationId: 'corr-1',
    leaseTerm: 1,
  };
}

function makePrincipal(id: string, type: 'user' | 'service' | 'node' = 'user'): Principal {
  return { id, type, attributes: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResourceAuthorizationService - Integration', () => {

  // ---- 1. Authorized user can create resource -----------------------------

  test('authorized user can create resource', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    // Define a writer role that grants WRITE on all resources
    const writerRole: Role = {
      name: 'writer',
      permissions: [Permission.WRITE],
      resourcePatterns: ['*'],
    };
    authService.defineRole(writerRole);
    authService.assignRole('alice', 'writer');

    const result = await authService.authorizeOperation(
      makePrincipal('alice'),
      makeOperation('CREATE', 'doc/readme'),
    );

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('role');
  });

  // ---- 2. Unauthorized user gets rejected ---------------------------------

  test('unauthorized user is denied by default-deny policy', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    // No roles assigned to bob
    const result = await authService.authorizeOperation(
      makePrincipal('bob'),
      makeOperation('CREATE', 'doc/readme'),
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });

  test('user with wrong resource pattern is denied', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    const restrictedWriter: Role = {
      name: 'restricted-writer',
      permissions: [Permission.WRITE],
      resourcePatterns: ['internal/*'],
    };
    authService.defineRole(restrictedWriter);
    authService.assignRole('carol', 'restricted-writer');

    const result = await authService.authorizeOperation(
      makePrincipal('carol'),
      makeOperation('CREATE', 'public/page'),
    );

    expect(result.allowed).toBe(false);
  });

  // ---- 3. Read-only user can read but not write ---------------------------

  test('read-only user can read a resource', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    const readerRole: Role = {
      name: 'reader',
      permissions: [Permission.READ],
      resourcePatterns: ['*'],
    };
    authService.defineRole(readerRole);
    authService.assignRole('dave', 'reader');

    // A "read" operation -- use a type that is not CREATE/UPDATE/DELETE
    // so it falls through to the default READ permission check.
    const readOp = makeOperation('CREATE', 'doc/readme');
    // Override to a custom read-like type -- the getRequiredPermission maps
    // unknown types to READ.
    (readOp as any).type = 'READ';

    const result = await authService.authorizeOperation(
      makePrincipal('dave'),
      readOp,
    );

    expect(result.allowed).toBe(true);
  });

  test('read-only user cannot write a resource', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    const readerRole: Role = {
      name: 'reader',
      permissions: [Permission.READ],
      resourcePatterns: ['*'],
    };
    authService.defineRole(readerRole);
    authService.assignRole('dave', 'reader');

    const result = await authService.authorizeOperation(
      makePrincipal('dave'),
      makeOperation('CREATE', 'doc/readme'),
    );

    expect(result.allowed).toBe(false);
  });

  test('read-only user cannot delete a resource', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    const readerRole: Role = {
      name: 'reader',
      permissions: [Permission.READ],
      resourcePatterns: ['*'],
    };
    authService.defineRole(readerRole);
    authService.assignRole('dave', 'reader');

    const result = await authService.authorizeOperation(
      makePrincipal('dave'),
      makeOperation('DELETE', 'doc/readme'),
    );

    expect(result.allowed).toBe(false);
  });

  // ---- 4. No auth service configured = all operations allowed -------------

  test('default-allow policy permits all operations when no roles exist', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: false });

    // No roles, no policies -- defaultDeny is false so everything is allowed
    const result = await authService.authorizeOperation(
      makePrincipal('anyone'),
      makeOperation('DELETE', 'critical/data'),
    );

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('default policy');
  });

  test('default-allow policy permits reads without roles', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: false });

    const readOp = makeOperation('CREATE', 'doc/readme');
    (readOp as any).type = 'READ';

    const result = await authService.authorizeOperation(
      makePrincipal('anyone'),
      readOp,
    );

    expect(result.allowed).toBe(true);
  });

  test('default-allow policy permits writes without roles', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: false });

    const result = await authService.authorizeOperation(
      makePrincipal('anyone'),
      makeOperation('UPDATE', 'doc/readme'),
    );

    expect(result.allowed).toBe(true);
  });

  // ---- Extra: admin role overrides permission checks ----------------------

  test('admin role grants access regardless of specific permission', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    const adminRole: Role = {
      name: 'admin',
      permissions: [Permission.ADMIN],
      resourcePatterns: ['*'],
    };
    authService.defineRole(adminRole);
    authService.assignRole('superuser', 'admin');

    const deleteResult = await authService.authorizeOperation(
      makePrincipal('superuser'),
      makeOperation('DELETE', 'any/resource'),
    );
    expect(deleteResult.allowed).toBe(true);

    const createResult = await authService.authorizeOperation(
      makePrincipal('superuser'),
      makeOperation('CREATE', 'another/resource'),
    );
    expect(createResult.allowed).toBe(true);
  });

  // ---- Extra: revoking role removes access --------------------------------

  test('revoking a role removes previously granted access', async () => {
    const authService = new ResourceAuthorizationService({ defaultDeny: true });

    const writerRole: Role = {
      name: 'writer',
      permissions: [Permission.WRITE],
      resourcePatterns: ['*'],
    };
    authService.defineRole(writerRole);
    authService.assignRole('eve', 'writer');

    // Should be allowed initially
    let result = await authService.authorizeOperation(
      makePrincipal('eve'),
      makeOperation('CREATE', 'doc/readme'),
    );
    expect(result.allowed).toBe(true);

    // Revoke the role
    authService.revokeRole('eve', 'writer');

    result = await authService.authorizeOperation(
      makePrincipal('eve'),
      makeOperation('CREATE', 'doc/readme'),
    );
    expect(result.allowed).toBe(false);
  });
});
