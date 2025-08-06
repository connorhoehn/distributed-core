import { EventEmitter } from 'events';
import { ApplicationModule, ApplicationModuleConfig, ApplicationModuleContext, ModuleState } from './types';
import { ClusterManager } from '../cluster/ClusterManager';
import { ResourceRegistry } from '../cluster/resources/ResourceRegistry';
import { ResourceTopologyManager } from '../cluster/topology/ResourceTopologyManager';

/**
 * ApplicationRegistry - Central registry for all application modules
 * 
 * Manages the lifecycle, dependencies, and interactions between different
 * application modules in the distributed cluster system.
 */
export class ApplicationRegistry extends EventEmitter {
  private modules = new Map<string, ApplicationModule>();
  private moduleConfigs = new Map<string, ApplicationModuleConfig>();
  private moduleStates = new Map<string, ModuleState>();
  private dependencies = new Map<string, string[]>(); // moduleId -> dependencies
  private isStarted = false;

  private clusterManager: ClusterManager;
  private resourceRegistry: ResourceRegistry;
  private topologyManager: ResourceTopologyManager;
  private globalConfiguration: Record<string, any>;

  constructor(
    clusterManager: ClusterManager,
    resourceRegistry: ResourceRegistry,
    topologyManager: ResourceTopologyManager,
    globalConfiguration: Record<string, any> = {}
  ) {
    super();
    this.clusterManager = clusterManager;
    this.resourceRegistry = resourceRegistry;
    this.topologyManager = topologyManager;
    this.globalConfiguration = globalConfiguration;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    this.isStarted = true;
    this.emit('registry:started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Stop all modules in reverse dependency order
    const stopOrder = this.calculateStopOrder();
    for (const moduleId of stopOrder) {
      const module = this.modules.get(moduleId);
      if (module && this.moduleStates.get(moduleId) === ModuleState.RUNNING) {
        try {
          await module.stop();
          this.moduleStates.set(moduleId, ModuleState.STOPPED);
        } catch (error) {
          this.emit('registry:module-stop-error', { moduleId, error });
        }
      }
    }

    this.isStarted = false;
    this.emit('registry:stopped');
  }

  /**
   * Register a new application module
   */
  async registerModule(module: ApplicationModule): Promise<void> {
    if (!this.isStarted) {
      throw new Error('ApplicationRegistry is not started. Call start() first.');
    }

    const moduleId = module.moduleId;
    const config = module.getConfiguration();

    if (this.modules.has(moduleId)) {
      throw new Error(`Module '${moduleId}' is already registered`);
    }

    // Validate dependencies
    for (const depId of config.dependencies || []) {
      if (!this.modules.has(depId)) {
        throw new Error(`Module '${moduleId}' depends on unregistered module '${depId}'`);
      }
    }

    // Register the module
    this.modules.set(moduleId, module);
    this.moduleConfigs.set(moduleId, config);
    this.moduleStates.set(moduleId, ModuleState.UNINITIALIZED);
    this.dependencies.set(moduleId, config.dependencies || []);

    // Create application context
    const context = this.createModuleContext(config);

    try {
      // Initialize the module
      await module.initialize(context);
      this.moduleStates.set(moduleId, ModuleState.RUNNING);

      // Start the module if dependencies are satisfied
      if (this.areDependenciesSatisfied(moduleId)) {
        await module.start();
      }

      this.emit('registry:module-registered', { moduleId, config });
    } catch (error) {
      this.moduleStates.set(moduleId, ModuleState.ERROR);
      this.emit('registry:module-error', { moduleId, error });
      throw error;
    }
  }

  /**
   * Unregister an application module
   */
  async unregisterModule(moduleId: string): Promise<void> {
    const module = this.modules.get(moduleId);
    if (!module) {
      throw new Error(`Module '${moduleId}' is not registered`);
    }

    // Check if other modules depend on this one
    const dependents = this.getDependentModules(moduleId);
    if (dependents.length > 0) {
      throw new Error(`Cannot unregister module '${moduleId}'. Dependent modules: ${dependents.join(', ')}`);
    }

    try {
      // Stop the module if running
      if (this.moduleStates.get(moduleId) === ModuleState.RUNNING) {
        await module.stop();
      }

      // Remove from registry
      this.modules.delete(moduleId);
      this.moduleConfigs.delete(moduleId);
      this.moduleStates.delete(moduleId);
      this.dependencies.delete(moduleId);

      this.emit('registry:module-unregistered', { moduleId });
    } catch (error) {
      this.emit('registry:module-error', { moduleId, error });
      throw error;
    }
  }

  /**
   * Get a registered module by ID
   */
  getModule(moduleId: string): ApplicationModule | undefined {
    return this.modules.get(moduleId);
  }

  /**
   * Get all registered modules
   */
  getAllModules(): ApplicationModule[] {
    return Array.from(this.modules.values());
  }

  /**
   * Get modules that manage a specific resource type
   */
  getModulesByResourceType(resourceType: string): ApplicationModule[] {
    return Array.from(this.modules.values()).filter(module =>
      module.managedResourceTypes.includes(resourceType)
    );
  }

  /**
   * Get module configuration
   */
  getModuleConfig(moduleId: string): ApplicationModuleConfig | undefined {
    return this.moduleConfigs.get(moduleId);
  }

  /**
   * Get module state
   */
  getModuleState(moduleId: string): ModuleState | undefined {
    return this.moduleStates.get(moduleId);
  }

  /**
   * Get all module states
   */
  getAllModuleStates(): Map<string, ModuleState> {
    return new Map(this.moduleStates);
  }

  /**
   * Check if all modules are healthy
   */
  async isHealthy(): Promise<boolean> {
    for (const module of this.modules.values()) {
      const health = await module.healthCheck();
      if (!health.healthy) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get comprehensive health status of all modules
   */
  async getHealthStatus(): Promise<{
    overall: boolean;
    modules: Record<string, { healthy: boolean; details?: any }>;
  }> {
    const modules: Record<string, { healthy: boolean; details?: any }> = {};
    let overall = true;

    for (const [moduleId, module] of this.modules) {
      const health = await module.healthCheck();
      modules[moduleId] = health;
      if (!health.healthy) {
        overall = false;
      }
    }

    return { overall, modules };
  }

  /**
   * Update global configuration
   */
  async updateGlobalConfiguration(newConfig: Record<string, any>): Promise<void> {
    this.globalConfiguration = { ...this.globalConfiguration, ...newConfig };
    
    // Notify all modules of configuration update
    for (const [moduleId, module] of this.modules) {
      try {
        const moduleConfig = this.moduleConfigs.get(moduleId)!;
        const updatedConfig = {
          ...moduleConfig,
          configuration: { ...moduleConfig.configuration, ...newConfig }
        };
        await module.updateConfiguration(updatedConfig);
        this.moduleConfigs.set(moduleId, updatedConfig);
      } catch (error) {
        this.emit('registry:configuration-update-error', { moduleId, error });
      }
    }

    this.emit('registry:configuration-updated', newConfig);
  }

  // === PRIVATE METHODS ===

  private createModuleContext(config: ApplicationModuleConfig): ApplicationModuleContext {
    return {
      clusterManager: this.clusterManager,
      resourceRegistry: this.resourceRegistry,
      topologyManager: this.topologyManager,
      moduleRegistry: this,
      configuration: { ...this.globalConfiguration, ...config.configuration },
      logger: {
        info: (message: string, meta?: any) => {
          console.log(`[INFO] [${config.moduleId}] ${message}`, meta || '');
        },
        warn: (message: string, meta?: any) => {
          console.warn(`[WARN] [${config.moduleId}] ${message}`, meta || '');
        },
        error: (message: string, meta?: any) => {
          console.error(`[ERROR] [${config.moduleId}] ${message}`, meta || '');
        },
        debug: (message: string, meta?: any) => {
          console.debug(`[DEBUG] [${config.moduleId}] ${message}`, meta || '');
        }
      }
    };
  }

  private areDependenciesSatisfied(moduleId: string): boolean {
    const dependencies = this.dependencies.get(moduleId) || [];
    return dependencies.every(depId => {
      const depState = this.moduleStates.get(depId);
      return depState === ModuleState.RUNNING;
    });
  }

  private getDependentModules(moduleId: string): string[] {
    const dependents: string[] = [];
    for (const [id, deps] of this.dependencies) {
      if (deps.includes(moduleId)) {
        dependents.push(id);
      }
    }
    return dependents;
  }

  private calculateStopOrder(): string[] {
    // Reverse topological sort to stop modules in proper order
    const visited = new Set<string>();
    const order: string[] = [];

    const visit = (moduleId: string) => {
      if (visited.has(moduleId)) return;
      visited.add(moduleId);

      // Visit dependents first
      const dependents = this.getDependentModules(moduleId);
      for (const dependent of dependents) {
        visit(dependent);
      }

      order.push(moduleId);
    };

    for (const moduleId of this.modules.keys()) {
      visit(moduleId);
    }

    return order.reverse();
  }
}
