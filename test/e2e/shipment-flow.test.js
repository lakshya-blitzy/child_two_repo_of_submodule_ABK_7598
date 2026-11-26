const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

// End-to-end contract: the service runs as its own process and is addressed over loopback
// TCP, so this file never requires anything under src/. Binding app.listen in-process would
// only repeat the integration-level check that test/routes.test.js already makes.
const SERVICE_ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(SERVICE_ROOT, 'src', 'index.js');
const READY_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 5000;

// src/index.js logs the PORT value it read rather than the port it bound, so PORT=0 would
// leave the ephemeral port unknowable: the parent reserves a free port and hands it over.
function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startService() {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [ENTRY], {
    cwd: SERVICE_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Both pipes are drained into one buffer: an unread pipe blocks the child once full, and
  // the buffer is what turns a failed start into a diagnosable error instead of a timeout.
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.on('error', (error) => {
    output += `spawn error: ${error.message}\n`;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `service exited with code ${child.exitCode} before becoming ready on port ${port}\n${output}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        return { child, baseUrl };
      }
    } catch {
      // Connection refused while the listener is still binding: poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  child.kill('SIGKILL');
  throw new Error(
    `service did not become ready on port ${port} within ${READY_TIMEOUT_MS} ms\n${output}`,
  );
}

// src/index.js installs no signal handler, so SIGTERM ends the process and releases the port.
async function stopService(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolve) => {
    const escalate = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill('SIGTERM');
    // The child can exit between the guard above and the listener registration, and a
    // missed 'exit' event would never fire again.
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(escalate);
      resolve();
    }
  });
}

test('operator receives stock, reserves it in a shipment, dispatches it and reads both back', async () => {
  const { child, baseUrl } = await startService();

  try {
    const intakeResponse = await fetch(`${baseUrl}/inventory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-1', name: 'Widget', quantity: 10 }),
    });
    assert.equal(intakeResponse.status, 201);
    assert.deepEqual(await intakeResponse.json(), {
      sku: 'SKU-1',
      name: 'Widget',
      quantity: 10,
      reorderLevel: 5,
    });

    const shipmentResponse = await fetch(`${baseUrl}/shipments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-1', quantity: 4, destination: 'Berlin' }),
    });
    assert.equal(shipmentResponse.status, 201);
    const shipment = await shipmentResponse.json();
    assert.equal(shipment.id, 'SHP-1');
    assert.equal(shipment.status, 'created');

    const dispatchResponse = await fetch(`${baseUrl}/shipments/SHP-1/dispatch`, { method: 'POST' });
    assert.equal(dispatchResponse.status, 200);
    const dispatched = await dispatchResponse.json();
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched.carrier, 'standard');

    const shipmentReadResponse = await fetch(`${baseUrl}/shipments/SHP-1`);
    assert.equal(shipmentReadResponse.status, 200);
    const persistedShipment = await shipmentReadResponse.json();
    assert.equal(persistedShipment.status, 'dispatched');
    assert.equal(persistedShipment.carrier, 'standard');

    const inventoryResponse = await fetch(`${baseUrl}/inventory`);
    assert.equal(inventoryResponse.status, 200);
    const items = await inventoryResponse.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].sku, 'SKU-1');
    assert.equal(items[0].quantity, 6);
  } finally {
    await stopService(child);
  }
});
