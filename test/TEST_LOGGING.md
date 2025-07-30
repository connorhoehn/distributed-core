# Test Logging Configuration

This document explains how to control logging output in tests for optimal debugging and clean CI/CD runs.

## Overview

The test suite supports two types of logging:

1. **Test Harness Logging** (`enableLogging`): Captures test events and cluster formation events in a logs array for assertions
2. **Debug Console Logging** (`enableDebugLogs`): Controls console.log output from system components like FailureDetector

## Default Behavior

By default, most tests run with clean output (no console logs) for faster CI/CD execution:

- `unit` tests: Debug logs **disabled** 
- `integration` tests: Debug logs **disabled**
- `scenario` tests: Debug logs **enabled** (for detailed analysis)
- `production` tests: Debug logs **enabled** (for production testing)

## Enabling Debug Logs

### For Individual Tests

```typescript
// Clean output (default)
const cluster = createTestCluster({ size: 3, enableLogging: true });

// With debug console logs
const cluster = createTestCluster({ 
  size: 3, 
  enableLogging: true,
  enableDebugLogs: true 
});
```

### For All Tests of a Type

Edit `test/support/test-config.ts` and modify the `logging.enableDebugLogs` setting:

```typescript
integration: {
  // ... other config
  logging: {
    enableDebugLogs: true  // Enable for all integration tests
  }
}
```

### Using Different Test Types

```typescript
// Use scenario config (has debug logs enabled by default)
const cluster = createTestCluster({ 
  size: 3, 
  testType: 'scenario' 
});
```

## What Debug Logs Show

When `enableDebugLogs: true`, you'll see console output like:

```
FailureDetector started for node test-node-0
Started monitoring node test-node-1
FailureDetector stopped for node test-node-0
```

This helps debug:
- Node startup/shutdown sequences
- Failure detection timing
- Cluster formation issues
- Network partition scenarios

## Best Practices

1. **Default to clean output** for fast test execution
2. **Enable debug logs temporarily** when troubleshooting specific issues
3. **Use scenario/production configs** for comprehensive testing with full logging
4. **Keep integration tests clean** for CI/CD performance

## Examples

See `test/examples/debug-logging-example.test.ts` for working examples of all logging configurations.
