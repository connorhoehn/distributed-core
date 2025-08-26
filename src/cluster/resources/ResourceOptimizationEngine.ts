import { ResourceMetadata, ResourceState, ResourceHealth } from './types';
import { ResourceRegistry } from './ResourceRegistry';
import { ClusterManager } from '../ClusterManager';
import { ResourceQueryEngine } from './ResourceQueryEngine';
import { ResourceMonitoringSystem } from './ResourceMonitoringSystem';

export interface OptimizationRecommendation {
  recommendationId: string;
  resourceId: string;
  type: 'SCALE_UP' | 'SCALE_DOWN' | 'MIGRATE' | 'REDISTRIBUTE' | 'CONSOLIDATE' | 'REPLICATE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  reasoning: string;
  estimatedImpact: {
    performanceImprovement?: number; // percentage
    costReduction?: number; // percentage
    reliabilityImprovement?: number; // percentage
  };
  actions: OptimizationAction[];
  timestamp: number;
  estimatedExecutionTime: number; // milliseconds
}

export interface OptimizationAction {
  actionType: 'MOVE_RESOURCE' | 'SCALE_CAPACITY' | 'UPDATE_CONFIG' | 'CREATE_REPLICA' | 'REMOVE_REPLICA';
  targetNodeId?: string;
  sourceNodeId?: string;
  parameters: Record<string, any>;
  estimatedDuration: number;
}

export interface ClusterOptimizationStrategy {
  loadBalancingWeight: number; // 0-1
  costOptimizationWeight: number; // 0-1
  performanceWeight: number; // 0-1
  reliabilityWeight: number; // 0-1
  consolidationThreshold: number; // 0-1, when to consolidate resources
  scaleUpThreshold: number; // 0-1, when to scale up
  scaleDownThreshold: number; // 0-1, when to scale down
}

export interface NodeCapacityAnalysis {
  nodeId: string;
  totalCapacity: number;
  usedCapacity: number;
  availableCapacity: number;
  utilizationRate: number;
  performanceScore: number;
  healthScore: number;
  resourceCount: number;
  resourceTypes: Set<string>;
  estimatedCostPerHour: number;
}

/**
 * Intelligent resource optimization engine
 * Analyzes cluster state and provides recommendations for optimal resource placement and scaling
 */
export class ResourceOptimizationEngine {
  private optimizationHistory = new Map<string, OptimizationRecommendation[]>(); // resourceId -> recommendations
  private nodeAnalysisCache = new Map<string, NodeCapacityAnalysis>(); // nodeId -> analysis
  private lastOptimizationRun = 0;
  private optimizationInterval?: NodeJS.Timeout;
  
  constructor(
    private resourceRegistry: ResourceRegistry,
    private clusterManager: ClusterManager,
    private queryEngine: ResourceQueryEngine,
    private monitoringSystem: ResourceMonitoringSystem,
    private strategy: ClusterOptimizationStrategy = {
      loadBalancingWeight: 0.3,
      costOptimizationWeight: 0.2,
      performanceWeight: 0.3,
      reliabilityWeight: 0.2,
      consolidationThreshold: 0.3,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.2
    },
    private config: {
      optimizationInterval?: number;
      maxRecommendations?: number;
      enableAutomaticOptimization?: boolean;
    } = {}
  ) {
    this.setupOptimizationScheduler();
  }

  /**
   * Analyze cluster and generate optimization recommendations
   */
  async generateOptimizationRecommendations(): Promise<OptimizationRecommendation[]> {
    const startTime = Date.now();
    const recommendations: OptimizationRecommendation[] = [];
    
    // Update node analysis cache
    await this.updateNodeAnalysis();
    
    // Get all resources for analysis
    const allResources = Array.from(this.resourceRegistry.getAllResources());
    
    console.log(`🔍 Analyzing ${allResources.length} resources across ${this.nodeAnalysisCache.size} nodes`);
    
    // Analyze each resource for optimization opportunities
    for (const resource of allResources) {
      const resourceRecommendations = await this.analyzeResource(resource);
      recommendations.push(...resourceRecommendations);
    }
    
    // Analyze cluster-wide optimization opportunities
    const clusterRecommendations = await this.analyzeClusterOptimization();
    recommendations.push(...clusterRecommendations);
    
    // Sort recommendations by priority and potential impact
    const sortedRecommendations = this.prioritizeRecommendations(recommendations);
    
    // Store recommendations in history
    for (const recommendation of sortedRecommendations) {
      if (!this.optimizationHistory.has(recommendation.resourceId)) {
        this.optimizationHistory.set(recommendation.resourceId, []);
      }
      this.optimizationHistory.get(recommendation.resourceId)!.push(recommendation);
    }
    
    this.lastOptimizationRun = Date.now();
    
    console.log(`✅ Generated ${sortedRecommendations.length} optimization recommendations in ${Date.now() - startTime}ms`);
    
    return sortedRecommendations.slice(0, this.config.maxRecommendations || 50);
  }

  /**
   * Get optimization recommendations for a specific resource
   */
  getResourceRecommendations(resourceId: string): OptimizationRecommendation[] {
    return this.optimizationHistory.get(resourceId) || [];
  }

  /**
   * Find optimal placement for a new resource
   */
  async findOptimalPlacement(
    resourceMetadata: ResourceMetadata,
    constraints?: {
      requiredNodeFeatures?: string[];
      excludeNodes?: string[];
      preferredRegion?: string;
      maxLatency?: number;
    }
  ): Promise<{
    recommendedNodeId: string;
    alternativeNodes: string[];
    reasoning: string;
    placementScore: number;
  }> {
    await this.updateNodeAnalysis();
    
    const eligibleNodes = Array.from(this.nodeAnalysisCache.values())
      .filter(node => this.isNodeEligible(node, resourceMetadata, constraints))
      .map(node => ({
        ...node,
        placementScore: this.calculatePlacementScore(node, resourceMetadata)
      }))
      .sort((a, b) => b.placementScore - a.placementScore);
    
    if (eligibleNodes.length === 0) {
      throw new Error('No eligible nodes found for resource placement');
    }
    
    const recommended = eligibleNodes[0];
    const alternatives = eligibleNodes.slice(1, 4).map(n => n.nodeId); // Top 3 alternatives
    
    const reasoning = this.generatePlacementReasoning(recommended, resourceMetadata);
    
    return {
      recommendedNodeId: recommended.nodeId,
      alternativeNodes: alternatives,
      reasoning,
      placementScore: recommended.placementScore
    };
  }

  /**
   * Analyze cluster-wide resource distribution efficiency
   */
  async analyzeClusterEfficiency(): Promise<{
    overallEfficiency: number; // 0-1
    loadBalanceScore: number; // 0-1
    resourceDistributionScore: number; // 0-1
    performanceScore: number; // 0-1
    costEfficiencyScore: number; // 0-1
    recommendations: string[];
    hotspots: string[]; // overloaded nodes
    underutilizedNodes: string[];
  }> {
    await this.updateNodeAnalysis();
    
    const nodes = Array.from(this.nodeAnalysisCache.values());
    
    // Calculate load balance score
    const utilizationRates = nodes.map(n => n.utilizationRate);
    const avgUtilization = utilizationRates.reduce((sum, rate) => sum + rate, 0) / utilizationRates.length;
    const utilizationVariance = utilizationRates.reduce((sum, rate) => sum + Math.pow(rate - avgUtilization, 2), 0) / utilizationRates.length;
    const loadBalanceScore = Math.max(0, 1 - utilizationVariance * 4); // Higher variance = lower score
    
    // Calculate resource distribution score
    const resourceCounts = nodes.map(n => n.resourceCount);
    const avgResourceCount = resourceCounts.reduce((sum, count) => sum + count, 0) / resourceCounts.length;
    const resourceVariance = resourceCounts.reduce((sum, count) => sum + Math.pow(count - avgResourceCount, 2), 0) / resourceCounts.length;
    const resourceDistributionScore = Math.max(0, 1 - resourceVariance / Math.max(avgResourceCount, 1));
    
    // Calculate performance score
    const performanceScores = nodes.map(n => n.performanceScore);
    const performanceScore = performanceScores.reduce((sum, score) => sum + score, 0) / performanceScores.length;
    
    // Calculate cost efficiency score
    const totalCost = nodes.reduce((sum, n) => sum + n.estimatedCostPerHour, 0);
    const totalCapacity = nodes.reduce((sum, n) => sum + n.totalCapacity, 0);
    const costEfficiencyScore = totalCapacity > 0 ? Math.min(1, 100 / totalCost) : 0; // Lower cost per capacity unit = higher score
    
    // Overall efficiency is weighted average
    const overallEfficiency = (
      loadBalanceScore * this.strategy.loadBalancingWeight +
      resourceDistributionScore * 0.2 +
      performanceScore * this.strategy.performanceWeight +
      costEfficiencyScore * this.strategy.costOptimizationWeight
    );
    
    // Identify hotspots and underutilized nodes
    const hotspots = nodes
      .filter(n => n.utilizationRate > this.strategy.scaleUpThreshold)
      .map(n => n.nodeId);
    
    const underutilizedNodes = nodes
      .filter(n => n.utilizationRate < this.strategy.scaleDownThreshold && n.resourceCount > 0)
      .map(n => n.nodeId);
    
    // Generate recommendations
    const recommendations: string[] = [];
    if (loadBalanceScore < 0.7) {
      recommendations.push('Improve load balancing across cluster nodes');
    }
    if (hotspots.length > 0) {
      recommendations.push(`Scale up or redistribute resources from overloaded nodes: ${hotspots.join(', ')}`);
    }
    if (underutilizedNodes.length > 0) {
      recommendations.push(`Consider consolidating resources from underutilized nodes: ${underutilizedNodes.join(', ')}`);
    }
    if (performanceScore < 0.6) {
      recommendations.push('Investigate performance issues across the cluster');
    }
    
    return {
      overallEfficiency,
      loadBalanceScore,
      resourceDistributionScore,
      performanceScore,
      costEfficiencyScore,
      recommendations,
      hotspots,
      underutilizedNodes
    };
  }

  /**
   * Get cluster capacity forecast
   */
  async getCapacityForecast(timeHorizonHours = 24): Promise<{
    currentCapacity: number;
    projectedDemand: number;
    capacityGap: number;
    recommendedActions: string[];
    confidenceLevel: number;
  }> {
    await this.updateNodeAnalysis();
    
    const currentCapacity = Array.from(this.nodeAnalysisCache.values())
      .reduce((sum, node) => sum + node.availableCapacity, 0);
    
    // Simple linear projection based on recent growth
    const allResources = Array.from(this.resourceRegistry.getAllResources());
    const recentResources = allResources.filter(r => Date.now() - r.timestamp < 86400000); // Last 24 hours
    const growthRate = recentResources.length / Math.max(allResources.length - recentResources.length, 1);
    
    const projectedDemand = allResources.reduce((sum, r) => sum + r.capacity.current, 0) * 
      Math.pow(1 + growthRate, timeHorizonHours / 24);
    
    const capacityGap = projectedDemand - currentCapacity;
    
    const recommendedActions: string[] = [];
    let confidenceLevel = 0.7; // Base confidence
    
    if (capacityGap > 0) {
      recommendedActions.push(`Add capacity for ${Math.ceil(capacityGap)} units`);
      if (capacityGap > currentCapacity * 0.5) {
        recommendedActions.push('Consider adding new nodes to the cluster');
        confidenceLevel = 0.6; // Lower confidence for large changes
      }
    } else {
      recommendedActions.push('Current capacity is sufficient for projected demand');
      if (Math.abs(capacityGap) > currentCapacity * 0.3) {
        recommendedActions.push('Consider scaling down to reduce costs');
      }
    }
    
    return {
      currentCapacity,
      projectedDemand,
      capacityGap,
      recommendedActions,
      confidenceLevel
    };
  }

  private async analyzeResource(resource: ResourceMetadata): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];
    
    // Get current node analysis
    const currentNode = this.nodeAnalysisCache.get(resource.nodeId);
    if (!currentNode) return recommendations;
    
    // Get resource performance data
    const performanceData = this.monitoringSystem.getPerformanceAnalytics(resource.resourceId);
    const healthStatus = this.monitoringSystem.getResourceHealthStatus(resource.resourceId);
    
    // Check if resource should be migrated for better performance
    if (performanceData.performanceTrend === 'DEGRADING' || healthStatus.healthTrend === 'DEGRADING') {
      const betterNodes = this.findBetterPlacementNodes(resource, currentNode);
      if (betterNodes.length > 0) {
        recommendations.push({
          recommendationId: this.generateRecommendationId(),
          resourceId: resource.resourceId,
          type: 'MIGRATE',
          priority: healthStatus.currentHealth === ResourceHealth.UNHEALTHY ? 'URGENT' : 'HIGH',
          reasoning: `Resource performance/health is degrading on current node. Better placement available.`,
          estimatedImpact: {
            performanceImprovement: 25,
            reliabilityImprovement: 30
          },
          actions: [{
            actionType: 'MOVE_RESOURCE',
            sourceNodeId: resource.nodeId,
            targetNodeId: betterNodes[0].nodeId,
            parameters: { reason: 'performance_optimization' },
            estimatedDuration: 30000
          }],
          timestamp: Date.now(),
          estimatedExecutionTime: 30000
        });
      }
    }
    
    // Check if resource should be scaled
    const utilizationRate = resource.capacity.current / resource.capacity.maximum;
    if (utilizationRate > this.strategy.scaleUpThreshold) {
      recommendations.push({
        recommendationId: this.generateRecommendationId(),
        resourceId: resource.resourceId,
        type: 'SCALE_UP',
        priority: utilizationRate > 0.95 ? 'URGENT' : 'HIGH',
        reasoning: `Resource utilization is ${(utilizationRate * 100).toFixed(1)}%, approaching capacity limits.`,
        estimatedImpact: {
          performanceImprovement: 40,
          reliabilityImprovement: 20
        },
        actions: [{
          actionType: 'SCALE_CAPACITY',
          parameters: { 
            newCapacity: Math.ceil(resource.capacity.maximum * 1.5),
            currentCapacity: resource.capacity.maximum
          },
          estimatedDuration: 15000
        }],
        timestamp: Date.now(),
        estimatedExecutionTime: 15000
      });
    }
    
    // Check if resource can be scaled down
    if (utilizationRate < this.strategy.scaleDownThreshold && resource.capacity.maximum > 1) {
      recommendations.push({
        recommendationId: this.generateRecommendationId(),
        resourceId: resource.resourceId,
        type: 'SCALE_DOWN',
        priority: 'LOW',
        reasoning: `Resource utilization is only ${(utilizationRate * 100).toFixed(1)}%, capacity can be reduced.`,
        estimatedImpact: {
          costReduction: 30
        },
        actions: [{
          actionType: 'SCALE_CAPACITY',
          parameters: { 
            newCapacity: Math.max(1, Math.ceil(resource.capacity.current * 1.2)),
            currentCapacity: resource.capacity.maximum
          },
          estimatedDuration: 10000
        }],
        timestamp: Date.now(),
        estimatedExecutionTime: 10000
      });
    }
    
    return recommendations;
  }

  private async analyzeClusterOptimization(): Promise<OptimizationRecommendation[] > {
    const recommendations: OptimizationRecommendation[] = [];
    const nodes = Array.from(this.nodeAnalysisCache.values());
    
    // Find consolidation opportunities
    const underutilizedNodes = nodes.filter(n => 
      n.utilizationRate < this.strategy.consolidationThreshold && n.resourceCount > 0
    );
    
    for (const underutilizedNode of underutilizedNodes) {
      const nodeResources = Array.from(this.resourceRegistry.getAllResources())
        .filter(r => r.nodeId === underutilizedNode.nodeId);
      
      // Find target nodes that can accommodate these resources
      const targetNodes = nodes
        .filter(n => n.nodeId !== underutilizedNode.nodeId)
        .filter(n => n.availableCapacity >= underutilizedNode.usedCapacity)
        .sort((a, b) => a.utilizationRate - b.utilizationRate); // Prefer less utilized nodes
      
      if (targetNodes.length > 0) {
        recommendations.push({
          recommendationId: this.generateRecommendationId(),
          resourceId: `cluster-consolidation-${underutilizedNode.nodeId}`,
          type: 'CONSOLIDATE',
          priority: 'MEDIUM',
          reasoning: `Node ${underutilizedNode.nodeId} is underutilized (${(underutilizedNode.utilizationRate * 100).toFixed(1)}%). Resources can be consolidated.`,
          estimatedImpact: {
            costReduction: 25,
            performanceImprovement: 10
          },
          actions: nodeResources.map(resource => ({
            actionType: 'MOVE_RESOURCE' as const,
            sourceNodeId: underutilizedNode.nodeId,
            targetNodeId: targetNodes[0].nodeId,
            parameters: { resourceId: resource.resourceId, reason: 'consolidation' },
            estimatedDuration: 20000
          })),
          timestamp: Date.now(),
          estimatedExecutionTime: nodeResources.length * 20000
        });
      }
    }
    
    return recommendations;
  }

  private async updateNodeAnalysis(): Promise<void> {
    const allMembers = this.clusterManager.membership.getAllMembers()
      .filter(m => m.status === 'ALIVE');
    
    for (const member of allMembers) {
      const nodeResources = Array.from(this.resourceRegistry.getAllResources())
        .filter(r => r.nodeId === member.id);
      
      const totalCapacity = nodeResources.reduce((sum, r) => sum + r.capacity.maximum, 0) || 100; // Default capacity
      const usedCapacity = nodeResources.reduce((sum, r) => sum + r.capacity.current, 0);
      const availableCapacity = totalCapacity - usedCapacity;
      const utilizationRate = totalCapacity > 0 ? usedCapacity / totalCapacity : 0;
      
      // Calculate performance score based on resource performance
      const performanceScore = nodeResources.length > 0
        ? nodeResources.reduce((sum, r) => {
            const perf = r.performance;
            return sum + (perf ? Math.max(0, 1 - perf.latency / 1000) * (1 - perf.errorRate) : 0.5);
          }, 0) / nodeResources.length
        : 0.5;
      
      // Calculate health score
      const healthyResources = nodeResources.filter(r => r.health === ResourceHealth.HEALTHY).length;
      const healthScore = nodeResources.length > 0 ? healthyResources / nodeResources.length : 1;
      
      // Estimate cost (simplified)
      const estimatedCostPerHour = totalCapacity * 0.01; // $0.01 per capacity unit per hour
      
      this.nodeAnalysisCache.set(member.id, {
        nodeId: member.id,
        totalCapacity,
        usedCapacity,
        availableCapacity,
        utilizationRate,
        performanceScore,
        healthScore,
        resourceCount: nodeResources.length,
        resourceTypes: new Set(nodeResources.map(r => r.resourceType)),
        estimatedCostPerHour
      });
    }
  }

  private isNodeEligible(
    node: NodeCapacityAnalysis,
    resource: ResourceMetadata,
    constraints?: any
  ): boolean {
    // Check basic capacity
    if (node.availableCapacity < resource.capacity.maximum) {
      return false;
    }
    
    // Check constraints if provided
    if (constraints?.excludeNodes?.includes(node.nodeId)) {
      return false;
    }
    
    // Add more constraint checks as needed
    return true;
  }

  private calculatePlacementScore(node: NodeCapacityAnalysis, resource: ResourceMetadata): number {
    // Multi-factor scoring
    const capacityScore = Math.min(1, node.availableCapacity / resource.capacity.maximum);
    const utilizationScore = 1 - node.utilizationRate; // Prefer less utilized nodes
    const performanceScore = node.performanceScore;
    const healthScore = node.healthScore;
    const diversityScore = node.resourceTypes.has(resource.resourceType) ? 0.5 : 1; // Prefer diversity
    
    return (
      capacityScore * 0.3 +
      utilizationScore * this.strategy.loadBalancingWeight +
      performanceScore * this.strategy.performanceWeight +
      healthScore * this.strategy.reliabilityWeight +
      diversityScore * 0.1
    );
  }

  private findBetterPlacementNodes(
    resource: ResourceMetadata,
    currentNode: NodeCapacityAnalysis
  ): NodeCapacityAnalysis[] {
    return Array.from(this.nodeAnalysisCache.values())
      .filter(node => node.nodeId !== currentNode.nodeId)
      .filter(node => this.isNodeEligible(node, resource))
      .filter(node => {
        const placementScore = this.calculatePlacementScore(node, resource);
        const currentScore = this.calculatePlacementScore(currentNode, resource);
        return placementScore > currentScore * 1.2; // At least 20% better
      })
      .sort((a, b) => this.calculatePlacementScore(b, resource) - this.calculatePlacementScore(a, resource));
  }

  private generatePlacementReasoning(node: NodeCapacityAnalysis, resource: ResourceMetadata): string {
    const reasons: string[] = [];
    
    if (node.utilizationRate < 0.7) {
      reasons.push('low utilization');
    }
    if (node.performanceScore > 0.8) {
      reasons.push('high performance');
    }
    if (node.healthScore > 0.9) {
      reasons.push('excellent health');
    }
    if (node.availableCapacity > resource.capacity.maximum * 2) {
      reasons.push('abundant capacity');
    }
    
    return `Recommended due to: ${reasons.join(', ') || 'optimal resource allocation'}`;
  }

  private prioritizeRecommendations(recommendations: OptimizationRecommendation[]): OptimizationRecommendation[] {
    const priorityOrder = { 'URGENT': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
    
    return recommendations.sort((a, b) => {
      // Sort by priority first
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      
      // Then by estimated impact
      const aImpact = Object.values(a.estimatedImpact).reduce((sum, val) => sum + (val || 0), 0);
      const bImpact = Object.values(b.estimatedImpact).reduce((sum, val) => sum + (val || 0), 0);
      return bImpact - aImpact;
    });
  }

  private generateRecommendationId(): string {
    return `opt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private setupOptimizationScheduler(): void {
    if (this.config.optimizationInterval) {
      this.optimizationInterval = setInterval(() => {
        this.generateOptimizationRecommendations().catch(error => {
          console.error('Optimization analysis failed:', error);
        });
      }, this.config.optimizationInterval);
    }
  }

  /**
   * Cleanup resources when shutting down
   */
  destroy(): void {
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
    }
    
    this.optimizationHistory.clear();
    this.nodeAnalysisCache.clear();
  }
}
