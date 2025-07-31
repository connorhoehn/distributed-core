# Diagnostics Unit Tests

This directory contains comprehensive unit tests for the diagnostics module of the distributed-core library.

## Test Files

### `chaos-injector.unit.test.ts`
Tests for the `ChaosInjector` class which provides chaos engineering capabilities:

**Test Coverage:**
- **Construction and Initialization** - Basic instantiation and configuration
- **Network Failure Injection** - Latency, packet loss, network partitions
- **Node Failure Injection** - Node crashes, memory pressure, CPU stress  
- **Message Failure Injection** - Message drops, corruption, duplication
- **Scenario Management** - Tracking, starting, stopping chaos scenarios
- **Configuration and Settings** - Runtime configuration updates and validation
- **Event Handling and Monitoring** - Event emission and statistics collection
- **Integration with Transport Layer** - Message interception and manipulation
- **Error Handling** - Graceful handling of invalid inputs and edge cases

### `diagnostic-tool.unit.test.ts`
Tests for the `DiagnosticTool` class which provides system monitoring and analysis:

**Test Coverage:**
- **Construction and Initialization** - Basic setup and configuration
- **Health Checks** - System, memory, CPU, network, and disk health monitoring
- **Performance Metrics** - Collection, tracking, and trend analysis
- **Cluster Diagnostics** - Membership, partitions, consensus, topology analysis
- **Message Flow Analysis** - Tracing, throughput, bottlenecks, gossip efficiency
- **System Profiling** - Performance profiling and optimization suggestions
- **Reporting and Export** - Report generation in JSON, CSV, and HTML formats
- **Configuration and Customization** - Runtime configuration and custom health checks
- **Event Handling and Alerts** - Status change events and performance alerts
- **Integration and Lifecycle** - Start/stop operations and external monitoring
- **Error Handling** - Graceful error handling and edge cases

## Implementation Features

### ChaosInjector
- Event-driven architecture using EventEmitter
- Comprehensive validation of input parameters
- Support for multiple concurrent chaos scenarios
- Integration hooks for transport layer manipulation
- Statistical tracking and reporting
- Configurable failure rates and settings

### DiagnosticTool
- Comprehensive system health monitoring
- Performance metrics collection and analysis
- Cluster-specific diagnostic capabilities
- Multiple report export formats
- Configurable alert thresholds
- Custom health check registration
- External monitoring system integration

## Running Tests

To run the diagnostics tests:

```bash
npm test test/unit/diagnostics
```

To run with verbose output:

```bash
npm test test/unit/diagnostics -- --verbose
```

## Test Results

All 73 tests pass successfully:
- **ChaosInjector**: 33 tests covering all major functionality
- **DiagnosticTool**: 40 tests covering comprehensive system diagnostics

The tests validate both the core functionality and edge cases, ensuring robust error handling and proper behavior under various conditions.

## Test-Driven Development

These tests were created following TDD principles and serve as:
1. **Specification** - Defining the expected behavior of the diagnostics modules
2. **Documentation** - Demonstrating how to use the APIs
3. **Safety Net** - Ensuring changes don't break existing functionality
4. **Design Driver** - Influencing the implementation architecture

The comprehensive test coverage ensures that the diagnostics functionality is reliable and well-tested for production use.
