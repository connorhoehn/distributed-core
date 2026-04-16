import { ResourceRegistry, ResourceRegistryConfig, Caller } from '../../../src/resources/core/ResourceRegistry';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceState,
  ResourceHealth,
} from '../../../src/resources/types';
import {
  ResourceAuthorizationService,
  Permission,
  Role,
} from '../../../src/resources/security/ResourceAuthorizationService';

function makeResourceType(): ResourceTypeDefinition {
  return {
    name: 'Auth Test Resource',
    typeName: 'auth-resource',
    version: '1.0.0',
    schema: { type: 'object' },
  };
}

function makeResource(overrides: Partial<ResourceMetadata> = {}): ResourceMetadata {
  return {
    id: 'auth-id-1',
    resourceId: 'auth-resource-1',
    type: 'test',
    resourceType: 'auth-resource',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    nodeId: 'test-node-1',
    timestamp: Date.now(),
    capacity: { current: 0, maximum: 100, reserved: 0, unit: 'items' },
    performance: { latency: 0, throughput: 0, errorRate: 0 },
    distribution: { shardCount: 1 },
    applicationData: { name: 'Auth Test' },
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
    ...overrides,
  };
}

describe('ResourceRegistry Authorization', () => {
  let authService: ResourceAuthorizationService;
  let registry: ResourceRegistry;

  const adminCaller: Caller = { id: 'admin-user', roles: ['admin'] };
  const readerCaller: Caller = { id: 'reader-user', roles: ['reader'] };
  const unauthorizedCaller: Caller = { id: 'nobody', roles: [] };

  beforeEach(async () => {
    authService = new ResourceAuthorizationService({ defaultDeny: true });

    // Define roles
    const adminRole: Role = {
      name: 'admin',
      permissions: [Permission.ADMIN],
      resourcePatterns: ['*'],
    };
    const readerRole: Role = {
      name: 'reader',
      permissions: [Permission.READ],
      resourcePatterns: ['*'],
    };

    authService.defineRole(adminRole);
    authService.defineRole(readerRole);

    authService.assignRole('admin-user', 'admin');
    authService.assignRole('reader-user', 'reader');

    const config: ResourceRegistryConfig = {
      nodeId: 'test-node-1',
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true },
      authorizationService: authService,
    };

    registry = new ResourceRegistry(config);
    registry.registerResourceType(makeResourceType());
    await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
  });

  // --- createResource ---

  test('authorized caller can create a resource', async () => {
    const resource = await registry.createResource(makeResource(), adminCaller);
    expect(resource).toBeDefined();
    expect(resource.resourceId).toBe('auth-resource-1');
  });

  test('unauthorized caller cannot create a resource', async () => {
    await expect(
      registry.createResource(makeResource(), unauthorizedCaller)
    ).rejects.toThrow('Unauthorized: cannot create resource');
  });

  test('reader cannot create a resource', async () => {
    await expect(
      registry.createResource(makeResource(), readerCaller)
    ).rejects.toThrow('Unauthorized: cannot create resource');
  });

  // --- getResource ---

  test('authorized caller can read a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    const fetched = await registry.getResource('auth-resource-1', readerCaller);
    expect(fetched).not.toBeNull();
    expect(fetched!.resourceId).toBe('auth-resource-1');
  });

  test('unauthorized caller cannot read a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    await expect(
      registry.getResource('auth-resource-1', unauthorizedCaller)
    ).rejects.toThrow('Unauthorized: cannot read resource');
  });

  // --- updateResource ---

  test('authorized caller can update a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    const updated = await registry.updateResource(
      'auth-resource-1',
      { applicationData: { name: 'Updated' } },
      adminCaller
    );
    expect(updated.applicationData.name).toBe('Updated');
  });

  test('reader cannot update a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    await expect(
      registry.updateResource(
        'auth-resource-1',
        { applicationData: { name: 'Hacked' } },
        readerCaller
      )
    ).rejects.toThrow('Unauthorized: cannot update resource');
  });

  test('unauthorized caller cannot update a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    await expect(
      registry.updateResource(
        'auth-resource-1',
        { applicationData: { name: 'Hacked' } },
        unauthorizedCaller
      )
    ).rejects.toThrow('Unauthorized: cannot update resource');
  });

  // --- removeResource ---

  test('authorized caller can remove a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    await expect(
      registry.removeResource('auth-resource-1', adminCaller)
    ).resolves.toBeUndefined();
  });

  test('reader cannot remove a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    await expect(
      registry.removeResource('auth-resource-1', readerCaller)
    ).rejects.toThrow('Unauthorized: cannot delete resource');
  });

  test('unauthorized caller cannot remove a resource', async () => {
    await registry.createResource(makeResource(), adminCaller);
    await expect(
      registry.removeResource('auth-resource-1', unauthorizedCaller)
    ).rejects.toThrow('Unauthorized: cannot delete resource');
  });

  // --- No auth service (optional behaviour) ---

  test('operations succeed without auth service configured', async () => {
    const noAuthRegistry = new ResourceRegistry({
      nodeId: 'test-node-1',
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true },
      // no authorizationService
    });
    noAuthRegistry.registerResourceType(makeResourceType());
    await noAuthRegistry.start();

    const created = await noAuthRegistry.createResource(makeResource());
    expect(created.resourceId).toBe('auth-resource-1');

    const fetched = await noAuthRegistry.getResource('auth-resource-1');
    expect(fetched).not.toBeNull();

    const updated = await noAuthRegistry.updateResource('auth-resource-1', {
      applicationData: { name: 'No Auth Update' },
    });
    expect(updated.applicationData.name).toBe('No Auth Update');

    await noAuthRegistry.removeResource('auth-resource-1');
    const gone = await noAuthRegistry.getResource('auth-resource-1');
    expect(gone).toBeNull();

    await noAuthRegistry.stop();
  });

  // --- Caller without id defaults to anonymous (denied by default-deny) ---

  test('missing caller is treated as anonymous and denied under default-deny', async () => {
    // When auth service is configured but no caller is passed,
    // the caller defaults to { id: 'anonymous' } which has no roles => denied
    await expect(
      registry.createResource(makeResource())
    ).rejects.toThrow('Unauthorized: cannot create resource');
  });
});
