import { EventEmitter } from 'events';
import { ResourceTypeDefinition } from './types';

/**
 * ResourceTypeRegistry - Central registry for resource type definitions
 * 
 * This bridges the Refactoring Roadmap requirements with the Entity Integration Plan
 * by providing a centralized way to register and manage resource types that can
 * be used across different application modules.
 */
export class ResourceTypeRegistry extends EventEmitter {
  private resourceTypes = new Map<string, ResourceTypeDefinition>();
  private isStarted = false;

  constructor() {
    super();
  }

  async start(): Promise<void> {
    this.isStarted = true;
    this.emit('registry:started');
  }

  async stop(): Promise<void> {
    this.isStarted = false;
    this.resourceTypes.clear();
    this.emit('registry:stopped');
  }

  /**
   * Register a new resource type definition
   */
  registerResourceType(definition: ResourceTypeDefinition): void {
    if (!this.isStarted) {
      throw new Error('ResourceTypeRegistry is not started. Call start() first.');
    }

    if (this.resourceTypes.has(definition.typeName)) {
      throw new Error(`Resource type '${definition.typeName}' is already registered`);
    }

    this.resourceTypes.set(definition.typeName, definition);
    this.emit('resource-type:registered', definition);
  }

  /**
   * Get a resource type definition by name
   */
  getResourceType(typeName: string): ResourceTypeDefinition | undefined {
    return this.resourceTypes.get(typeName);
  }

  /**
   * Get all registered resource types
   */
  getAllResourceTypes(): ResourceTypeDefinition[] {
    return Array.from(this.resourceTypes.values());
  }

  /**
   * Check if a resource type is registered
   */
  hasResourceType(typeName: string): boolean {
    return this.resourceTypes.has(typeName);
  }

  /**
   * Unregister a resource type
   */
  unregisterResourceType(typeName: string): boolean {
    const existed = this.resourceTypes.delete(typeName);
    if (existed) {
      this.emit('resource-type:unregistered', typeName);
    }
    return existed;
  }

  /**
   * Get resource types by category or filter
   */
  getResourceTypesByFilter(filter: (def: ResourceTypeDefinition) => boolean): ResourceTypeDefinition[] {
    return Array.from(this.resourceTypes.values()).filter(filter);
  }
}
