import { ResourceOperation } from '../core/ResourceOperation';

export enum Permission {
  READ = 'read',
  WRITE = 'write',
  DELETE = 'delete',
  ADMIN = 'admin'
}

export interface Principal {
  id: string;
  type: 'user' | 'service' | 'node';
  attributes: Record<string, any>;
}

export interface Role {
  name: string;
  permissions: Permission[];
  resourcePatterns: string[];
  conditions?: AuthCondition[];
}

export interface AuthCondition {
  type: 'time' | 'attribute' | 'resource' | 'custom';
  operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'gt' | 'lt' | 'contains' | 'matches';
  field: string;
  value: any;
  evaluator?: (context: AuthContext) => boolean;
}

export interface AuthContext {
  principal: Principal;
  operation: ResourceOperation;
  resource: any;
  timestamp: number;
  environment: Record<string, any>;
}

export interface AuthResult {
  allowed: boolean;
  reason?: string;
  requiredPermissions?: Permission[];
  appliedPolicies?: string[];
}

export interface Policy {
  id: string;
  name: string;
  effect: 'allow' | 'deny';
  principals: string[];
  resources: string[];
  actions: string[];
  conditions?: AuthCondition[];
  priority: number;
}

export interface AuthorizationConfig {
  defaultDeny: boolean;
  enableAuditLog: boolean;
  cacheTimeoutMs: number;
  maxCacheSize: number;
}

export class ResourceAuthorizationService {
  private readonly roles = new Map<string, Role>();
  private readonly policies = new Map<string, Policy>();
  private readonly principalRoles = new Map<string, string[]>();
  private readonly authCache = new Map<string, { result: AuthResult; timestamp: number }>();
  private readonly config: AuthorizationConfig;

  constructor(config: Partial<AuthorizationConfig> = {}) {
    this.config = {
      defaultDeny: config.defaultDeny ?? true,
      enableAuditLog: config.enableAuditLog ?? true,
      cacheTimeoutMs: config.cacheTimeoutMs ?? 300000, // 5 minutes
      maxCacheSize: config.maxCacheSize ?? 10000
    };
  }

  /**
   * Define a role with permissions and resource patterns
   */
  defineRole(role: Role): void {
    this.roles.set(role.name, role);
    this.clearAuthCache();
  }

  /**
   * Assign a role to a principal
   */
  assignRole(principalId: string, roleName: string): void {
    const currentRoles = this.principalRoles.get(principalId) || [];
    if (!currentRoles.includes(roleName)) {
      currentRoles.push(roleName);
      this.principalRoles.set(principalId, currentRoles);
      this.clearAuthCache();
    }
  }

  /**
   * Remove a role from a principal
   */
  revokeRole(principalId: string, roleName: string): void {
    const currentRoles = this.principalRoles.get(principalId) || [];
    const updatedRoles = currentRoles.filter(role => role !== roleName);
    this.principalRoles.set(principalId, updatedRoles);
    this.clearAuthCache();
  }

  /**
   * Create a policy for fine-grained access control
   */
  createPolicy(policy: Policy): void {
    this.policies.set(policy.id, policy);
    this.clearAuthCache();
  }

  /**
   * Remove a policy
   */
  removePolicy(policyId: string): void {
    this.policies.delete(policyId);
    this.clearAuthCache();
  }

  /**
   * Authorize a resource operation
   */
  async authorize(context: AuthContext): Promise<AuthResult> {
    // Check cache first
    const cacheKey = this.generateCacheKey(context);
    const cached = this.authCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTimeoutMs) {
      return cached.result;
    }

    // Perform authorization
    const result = await this.performAuthorization(context);

    // Cache the result
    this.cacheResult(cacheKey, result);

    // Audit log (in real implementation, use proper audit logger)
    if (this.config.enableAuditLog) {
      this.auditLog(context, result);
    }

    return result;
  }

  /**
   * Quick authorization check for resource operations
   */
  async authorizeOperation(
    principal: Principal,
    operation: ResourceOperation,
    resource?: any
  ): Promise<AuthResult> {
    const context: AuthContext = {
      principal,
      operation,
      resource: resource || {},
      timestamp: Date.now(),
      environment: {}
    };

    return this.authorize(context);
  }

  /**
   * Perform the actual authorization logic
   */
  private async performAuthorization(context: AuthContext): Promise<AuthResult> {
    const requiredPermission = this.getRequiredPermission(context.operation);
    const appliedPolicies: string[] = [];

    // Step 1: Check explicit policies first
    const policyResult = this.evaluatePolicies(context, appliedPolicies);
    if (policyResult.allowed !== undefined) {
      return {
        allowed: policyResult.allowed,
        reason: policyResult.reason,
        requiredPermissions: [requiredPermission],
        appliedPolicies
      };
    }

    // Step 2: Check role-based permissions
    const roleResult = this.evaluateRoles(context, requiredPermission);
    if (roleResult.allowed) {
      return {
        allowed: true,
        reason: 'Authorized by role-based permissions',
        requiredPermissions: [requiredPermission],
        appliedPolicies
      };
    }

    // Step 3: Apply default policy
    return {
      allowed: !this.config.defaultDeny,
      reason: this.config.defaultDeny 
        ? 'Access denied by default policy' 
        : 'Access allowed by default policy',
      requiredPermissions: [requiredPermission],
      appliedPolicies
    };
  }

  /**
   * Evaluate explicit policies
   */
  private evaluatePolicies(
    context: AuthContext, 
    appliedPolicies: string[]
  ): { allowed?: boolean; reason?: string } {
    // Sort policies by priority (higher priority first)
    const sortedPolicies = Array.from(this.policies.values())
      .sort((a, b) => b.priority - a.priority);

    for (const policy of sortedPolicies) {
      if (this.policyMatches(policy, context)) {
        appliedPolicies.push(policy.id);
        
        if (policy.effect === 'deny') {
          return {
            allowed: false,
            reason: `Access denied by policy: ${policy.name}`
          };
        } else if (policy.effect === 'allow') {
          return {
            allowed: true,
            reason: `Access granted by policy: ${policy.name}`
          };
        }
      }
    }

    return {}; // No matching policies
  }

  /**
   * Check if a policy matches the context
   */
  private policyMatches(policy: Policy, context: AuthContext): boolean {
    // Check principals
    if (policy.principals.length > 0 && 
        !policy.principals.includes(context.principal.id) &&
        !policy.principals.includes('*')) {
      return false;
    }

    // Check resources
    if (policy.resources.length > 0 && 
        !policy.resources.some(pattern => this.matchesPattern(context.operation.resourceId, pattern))) {
      return false;
    }

    // Check actions
    if (policy.actions.length > 0 && 
        !policy.actions.includes(context.operation.type) &&
        !policy.actions.includes('*')) {
      return false;
    }

    // Check conditions
    if (policy.conditions && !this.evaluateConditions(policy.conditions, context)) {
      return false;
    }

    return true;
  }

  /**
   * Evaluate role-based permissions
   */
  private evaluateRoles(context: AuthContext, requiredPermission: Permission): { allowed: boolean } {
    const principalRoles = this.principalRoles.get(context.principal.id) || [];
    
    for (const roleName of principalRoles) {
      const role = this.roles.get(roleName);
      if (!role) continue;

      // Check if role has required permission
      if (!role.permissions.includes(requiredPermission) && 
          !role.permissions.includes(Permission.ADMIN)) {
        continue;
      }

      // Check if resource pattern matches
      if (role.resourcePatterns.length > 0 && 
          !role.resourcePatterns.some(pattern => 
            this.matchesPattern(context.operation.resourceId, pattern))) {
        continue;
      }

      // Check role conditions
      if (role.conditions && !this.evaluateConditions(role.conditions, context)) {
        continue;
      }

      return { allowed: true };
    }

    return { allowed: false };
  }

  /**
   * Evaluate authorization conditions
   */
  private evaluateConditions(conditions: AuthCondition[], context: AuthContext): boolean {
    return conditions.every(condition => this.evaluateCondition(condition, context));
  }

  /**
   * Evaluate a single authorization condition
   */
  private evaluateCondition(condition: AuthCondition, context: AuthContext): boolean {
    // Custom evaluator takes precedence
    if (condition.evaluator) {
      return condition.evaluator(context);
    }

    let fieldValue: any;

    // Get field value based on condition type
    switch (condition.type) {
      case 'time':
        fieldValue = context.timestamp;
        break;
      case 'attribute':
        fieldValue = context.principal.attributes[condition.field];
        break;
      case 'resource':
        fieldValue = this.getNestedValue(context.resource, condition.field);
        break;
      default:
        return false;
    }

    // Apply operator
    switch (condition.operator) {
      case 'equals':
        return fieldValue === condition.value;
      case 'not_equals':
        return fieldValue !== condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(fieldValue);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(fieldValue);
      case 'gt':
        return fieldValue > condition.value;
      case 'lt':
        return fieldValue < condition.value;
      case 'contains':
        return typeof fieldValue === 'string' && fieldValue.includes(condition.value);
      case 'matches':
        return typeof fieldValue === 'string' && new RegExp(condition.value).test(fieldValue);
      default:
        return false;
    }
  }

  /**
   * Get required permission for an operation
   */
  private getRequiredPermission(operation: ResourceOperation): Permission {
    switch (operation.type) {
      case 'CREATE':
      case 'UPDATE':
        return Permission.WRITE;
      case 'DELETE':
        return Permission.DELETE;
      default:
        return Permission.READ;
    }
  }

  /**
   * Pattern matching for resources
   */
  private matchesPattern(resourceId: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\[([^\]]+)\]/g, '[$1]');
    
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(resourceId);
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Generate cache key for authorization result
   */
  private generateCacheKey(context: AuthContext): string {
    const keyParts = [
      context.principal.id,
      context.operation.resourceId,
      context.operation.type,
      JSON.stringify(context.principal.attributes)
    ];
    return keyParts.join(':');
  }

  /**
   * Cache authorization result
   */
  private cacheResult(cacheKey: string, result: AuthResult): void {
    if (this.authCache.size >= this.config.maxCacheSize) {
      // Remove oldest entries
      const entries = Array.from(this.authCache.entries())
        .sort(([, a], [, b]) => a.timestamp - b.timestamp);
      
      const toRemove = entries.slice(0, Math.floor(this.config.maxCacheSize * 0.1));
      for (const [key] of toRemove) {
        this.authCache.delete(key);
      }
    }

    this.authCache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });
  }

  /**
   * Clear authorization cache
   */
  private clearAuthCache(): void {
    this.authCache.clear();
  }

  /**
   * Audit log for authorization decisions
   */
  private auditLog(context: AuthContext, result: AuthResult): void {
    // In real implementation, this would write to proper audit log
    const auditEntry = {
      timestamp: context.timestamp,
      principal: context.principal.id,
      resource: context.operation.resourceId,
      action: context.operation.type,
      result: result.allowed ? 'ALLOW' : 'DENY',
      reason: result.reason,
      policies: result.appliedPolicies
    };
    
    // Would be handled by external audit logger
  }

  /**
   * Get authorization statistics
   */
  getStats() {
    const cacheEntries = Array.from(this.authCache.values());
    const allowedCached = cacheEntries.filter(e => e.result.allowed).length;
    const deniedCached = cacheEntries.filter(e => !e.result.allowed).length;

    return {
      roles: this.roles.size,
      policies: this.policies.size,
      principalsWithRoles: this.principalRoles.size,
      cacheSize: this.authCache.size,
      cachedAllowed: allowedCached,
      cachedDenied: deniedCached,
      cacheHitRate: this.authCache.size > 0 ? (allowedCached + deniedCached) / this.authCache.size : 0
    };
  }

  /**
   * List all roles
   */
  getRoles(): Role[] {
    return Array.from(this.roles.values());
  }

  /**
   * List all policies
   */
  getPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Get roles for a principal
   */
  getPrincipalRoles(principalId: string): string[] {
    return this.principalRoles.get(principalId) || [];
  }
}
