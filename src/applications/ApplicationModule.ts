import { EventEmitter } from 'events';
import { 
  ApplicationModuleConfig, 
  ApplicationModuleContext, 
  ApplicationModuleMetrics, 
  ApplicationModuleDashboardData, 
  ScalingStrategy,
  ModuleState 
} from './types';
import { ResourceMetadata, ResourceTypeDefinition } from '../cluster/resources/types';

/**
 * ApplicationModule - Base interface for all application modules
 * 
 * This interface defines the contract that all application modules must implement
 * to integrate with the generic distributed cluster system.
 */
export abstract class ApplicationModule extends EventEmitter {
  protected config: ApplicationModuleConfig;
  protected context!: ApplicationModuleContext; // Will be initialized in initialize()
  protected state: ModuleState = ModuleState.UNINITIALIZED;
  protected resourceTypes: Map<string, ResourceTypeDefinition> = new Map();

  constructor(config: ApplicationModuleConfig) {
    super();
    this.config = config;
  }

  // === LIFECYCLE METHODS ===

  /**
   * Initialize the application module with cluster context
   */
  async initialize(context: ApplicationModuleContext): Promise<void> {
    this.context = context;
    this.state = ModuleState.INITIALIZING;
    this.emit('module:initializing', this.config.moduleId);

    try {
      // Register resource types with the cluster
      await this.registerResourceTypes();
      
      // Perform module-specific initialization
      await this.onInitialize(context);
      
      this.state = ModuleState.RUNNING;
      this.emit('module:initialized', this.config.moduleId);
    } catch (error) {
      this.state = ModuleState.ERROR;
      this.emit('module:error', { moduleId: this.config.moduleId, error });
      throw error;
    }
  }

  /**
   * Start the application module
   */
  async start(): Promise<void> {
    if (this.state !== ModuleState.RUNNING) {
      throw new Error(`Module ${this.config.moduleId} is not initialized`);
    }

    await this.onStart();
    this.emit('module:started', this.config.moduleId);
  }

  /**
   * Stop the application module
   */
  async stop(): Promise<void> {
    this.state = ModuleState.STOPPING;
    this.emit('module:stopping', this.config.moduleId);

    try {
      await this.onStop();
      this.state = ModuleState.STOPPED;
      this.emit('module:stopped', this.config.moduleId);
    } catch (error) {
      this.state = ModuleState.ERROR;
      this.emit('module:error', { moduleId: this.config.moduleId, error });
      throw error;
    }
  }

  // === RESOURCE MANAGEMENT ===

  /**
   * Create a new resource of this module's type
   */
  abstract createResource(metadata: Partial<ResourceMetadata>): Promise<ResourceMetadata>;

  /**
   * Scale a resource using the provided strategy
   */
  abstract scaleResource(resourceId: string, strategy: ScalingStrategy): Promise<void>;

  /**
   * Delete a resource
   */
  abstract deleteResource(resourceId: string): Promise<void>;

  /**
   * Get resources managed by this module
   */
  getResources(): Promise<ResourceMetadata[]> {
    const allResources: ResourceMetadata[] = [];
    for (const resourceType of this.config.resourceTypes) {
      const resources = this.context.resourceRegistry.getResourcesByType(resourceType);
      allResources.push(...resources);
    }
    return Promise.resolve(allResources);
  }

  // === MONITORING & OBSERVABILITY ===

  /**
   * Get current module metrics
   */
  abstract getMetrics(): Promise<ApplicationModuleMetrics>;

  /**
   * Get dashboard data for visualization
   */
  abstract getDashboardData(): Promise<ApplicationModuleDashboardData>;

  /**
   * Perform health check
   */
  async healthCheck(): Promise<{ healthy: boolean; details?: any }> {
    try {
      const metrics = await this.getMetrics();
      const healthy = metrics.state === ModuleState.RUNNING && metrics.performance.errorRate < 0.1;
      return { 
        healthy, 
        details: { 
          state: metrics.state, 
          errorRate: metrics.performance.errorRate,
          uptime: metrics.performance.uptime
        } 
      };
    } catch (error) {
      return { healthy: false, details: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  // === CONFIGURATION ===

  /**
   * Update module configuration
   */
  async updateConfiguration(newConfig: Partial<ApplicationModuleConfig>): Promise<void> {
    const updatedConfig = { ...this.config, ...newConfig };
    await this.onConfigurationUpdate(updatedConfig);
    this.config = updatedConfig;
    this.emit('module:configuration-updated', { moduleId: this.config.moduleId, config: updatedConfig });
  }

  /**
   * Get current configuration
   */
  getConfiguration(): ApplicationModuleConfig {
    return { ...this.config };
  }

  // === GETTERS ===

  get moduleId(): string {
    return this.config.moduleId;
  }

  get moduleName(): string {
    return this.config.moduleName;
  }

  get moduleState(): ModuleState {
    return this.state;
  }

  get managedResourceTypes(): string[] {
    return [...this.config.resourceTypes];
  }

  // === PROTECTED METHODS (TO BE IMPLEMENTED BY SUBCLASSES) ===

  /**
   * Module-specific initialization logic
   */
  protected abstract onInitialize(context: ApplicationModuleContext): Promise<void>;

  /**
   * Module-specific startup logic
   */
  protected abstract onStart(): Promise<void>;

  /**
   * Module-specific shutdown logic
   */
  protected abstract onStop(): Promise<void>;

  /**
   * Handle configuration updates
   */
  protected abstract onConfigurationUpdate(newConfig: ApplicationModuleConfig): Promise<void>;

  /**
   * Register resource types that this module manages
   */
  protected abstract getResourceTypeDefinitions(): ResourceTypeDefinition[];

  // === PRIVATE METHODS ===

  private async registerResourceTypes(): Promise<void> {
    const definitions = this.getResourceTypeDefinitions();
    
    for (const definition of definitions) {
      // Register with ResourceTypeRegistry
      this.context.resourceRegistry.registerResourceType(definition);
      this.resourceTypes.set(definition.typeName, definition);
      
      this.context.logger.info(`Registered resource type: ${definition.typeName}`, {
        moduleId: this.config.moduleId,
        version: definition.version
      });
    }
  }

  /**
   * Helper method for logging
   */
  protected log(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: any): void {
    if (this.context?.logger) {
      this.context.logger[level](`[${this.config.moduleId}] ${message}`, meta);
    }
  }
}
