/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  
  // Test discovery
  testMatch: [
    '<rootDir>/test/e2e/cluster/**/*.test.ts',
    '<rootDir>/test/e2e/coordinator/**/*.test.ts'
  ],
  
  // TypeScript configuration
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  
  // Test execution settings
  testTimeout: 45000,  // 45 seconds for cluster operations
  maxWorkers: 1,       // Prevent port conflicts by running tests sequentially
  
  // Handle detection and cleanup
  detectOpenHandles: true,
  forceExit: true,
  
  // Setup and teardown
  setupFilesAfterEnv: ['<rootDir>/test/support/cluster-jest-setup.ts'],
  
  // Coverage settings (optional)
  collectCoverageFrom: [
    'src/cluster/**/*.ts',
    'src/coordinators/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts'
  ],
  
  // Module resolution
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  
  // Test result reporting
  verbose: true,
  testResultsProcessor: undefined,
  
  // Global test variables
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
  
  // Test environment variables
  testEnvironmentOptions: {
    // Node-specific options if needed
  },
  
  // Error handling
  errorOnDeprecated: false, // Allow deprecation warnings for now
  bail: false, // Continue running tests even if some fail
  
  // Test timing
  slowTestThreshold: 30, // Mark tests over 30s as slow
  
  // Display options
  displayName: {
    name: 'Cluster E2E Tests',
    color: 'blue'
  }
};
