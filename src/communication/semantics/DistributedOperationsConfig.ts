export interface DistributedOperationsConfig {
  maxConcurrentOps: number;
  timeoutMs: number;
  retryAttempts: number;
  batchSize: number;
}

export const defaultOperationsConfig: DistributedOperationsConfig = {
  maxConcurrentOps: 100,
  timeoutMs: 5000,
  retryAttempts: 3,
  batchSize: 10
};
