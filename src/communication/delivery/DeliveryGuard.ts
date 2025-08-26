import { ResourceOperation } from '../../resources/core/ResourceOperation';
import { Principal, ResourceAuthorizationService, AuthResult } from '../../resources/security/ResourceAuthorizationService';

// Node.js environment access
declare const console: any;

/**
 * DeliveryGuard provides authorization checks at the delivery point
 * 
 * This ensures that clients only receive resource operations they are authorized to see,
 * even after the operation has been distributed across the cluster.
 */
export class DeliveryGuard {
  private authService: ResourceAuthorizationService;

  constructor(authService: ResourceAuthorizationService) {
    this.authService = authService;
  }

  /**
   * Check if a principal is authorized to receive a resource operation
   */
  async canDeliver(
    principal: Principal, 
    resourceId: string, 
    op: ResourceOperation
  ): Promise<boolean> {
    try {
      // Create authorization context for the delivery check
      const authResult: AuthResult = await this.authService.authorizeOperation(
        principal,
        op,
        { resourceId }
      );

      if (!authResult.allowed) {
        console.log(`🛡️ Delivery blocked for ${principal.id}: ${authResult.reason}`);
        return false;
      }

      console.log(`✅ Delivery authorized for ${principal.id} to resource ${resourceId}`);
      return true;

    } catch (error) {
      console.error(`Failed to check delivery authorization for ${principal.id}:`, error);
      
      // Fail closed - deny delivery on authorization errors
      return false;
    }
  }

  /**
   * Batch authorization check for multiple principals
   */
  async canDeliverToMultiple(
    principals: Principal[], 
    resourceId: string, 
    op: ResourceOperation
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    // Check authorization for each principal
    const checks = principals.map(async (principal) => {
      const canDeliver = await this.canDeliver(principal, resourceId, op);
      results.set(principal.id, canDeliver);
    });

    await Promise.all(checks);
    return results;
  }

  /**
   * Filter a list of principals to only those authorized for delivery
   */
  async filterAuthorized(
    principals: Principal[], 
    resourceId: string, 
    op: ResourceOperation
  ): Promise<Principal[]> {
    const authResults = await this.canDeliverToMultiple(principals, resourceId, op);
    
    return principals.filter(principal => authResults.get(principal.id) === true);
  }
}
