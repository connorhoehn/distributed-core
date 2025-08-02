#!/usr/bin/env node

/**
 * Quick verification script for transport adapters
 */

const { WebSocketAdapter } = require('../dist/transport/adapters/WebSocketAdapter');
const { TCPAdapter } = require('../dist/transport/adapters/TCPAdapter');

async function testAdapters() {
  console.log('🚀 Testing Transport Adapters...');

  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  try {
    // Test WebSocket Adapter
    console.log('\n📡 Testing WebSocket Adapter');
    const wsAdapter = new WebSocketAdapter(nodeA, { port: 8090 });
    
    await wsAdapter.start();
    console.log('✅ WebSocket adapter started');
    
    const wsStats = wsAdapter.getStats();
    console.log(`📊 WebSocket Stats: ${JSON.stringify({
      isStarted: wsStats.isStarted,
      port: wsStats.port,
      activeConnections: wsStats.activeConnections
    })}`);
    
    await wsAdapter.stop();
    console.log('🛑 WebSocket adapter stopped');

    // Test TCP Adapter
    console.log('\n🔌 Testing TCP Adapter');
    const tcpAdapter = new TCPAdapter(nodeA, { port: 9090 });
    
    await tcpAdapter.start();
    console.log('✅ TCP adapter started');
    
    const tcpStats = tcpAdapter.getStats();
    console.log(`📊 TCP Stats: ${JSON.stringify({
      isStarted: tcpStats.isStarted,
      port: tcpStats.port,
      activeConnections: tcpStats.activeConnections || 0
    })}`);
    
    await tcpAdapter.stop();
    console.log('🛑 TCP adapter stopped');

    console.log('\n🎉 All transport adapters working correctly!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  testAdapters();
}
