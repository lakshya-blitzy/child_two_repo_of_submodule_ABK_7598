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
// Each attempt and each request carries its own bound, so a connection that is accepted but
// never answered cannot outlive the wait it belongs to.
const READY_ATTEMPT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;
// Above the internal worst case (10 s readiness + five 5 s requests + 5 s teardown), so this
// backstop can never pre-empt a bounded failure that reports its own cause.
const TEST_TIMEOUT_MS = 60000;

async function startService() {
  // src/index.js logs the PORT value it read rather than the port it bound, so PORT=0 would
  // leave the ephemeral port unknowable: the parent reserves a free port and hands it over,
  // closing the probe first so the child cannot be handed a port still held here.
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: reserved } = probe.address();
      probe.close(() => resolve(reserved));
    });
  });
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
  // A spawn failure emits 'error' and never 'exit', so it records the reason and aborts the
  // wait: polling on would spend the whole deadline on a process that was never started.
  let spawnError = null;
  const stopWaiting = new AbortController();
  child.on('error', (error) => {
    spawnError = error;
    output += `spawn error: ${error.message}\n`;
    stopWaiting.abort();
  });

  // The deadline error carries the last reason seen, so a health endpoint answering 500 is
  // distinguishable from a start that was merely slow.
  let lastFailure = 'no attempt completed';
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError !== null) {
      throw new Error(
        `service could not be spawned on port ${port}: ${spawnError.message}\n${output}`,
      );
    }
    // A child killed by a signal leaves exitCode null, so both fields are checked, as in
    // stopService, and the error names whichever of the two ended the child.
    if (child.exitCode !== null || child.signalCode !== null) {
      const endedBy =
        child.signalCode === null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new Error(
        `service exited with ${endedBy} before becoming ready on port ${port}\n${output}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`, {
        // The attempt takes what is left of the readiness budget, so a socket that connects
        // but never answers cannot push the wait past the 10 s deadline.
        signal: AbortSignal.any([
          stopWaiting.signal,
          AbortSignal.timeout(
            Math.min(READY_ATTEMPT_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
          ),
        ]),
      });
      if (response.status === 200) {
        // Released here rather than left to the connection pool, which would hold the socket
        // until teardown kills the child.
        await response.body?.cancel();
        return { child, baseUrl };
      }
      lastFailure = `GET /health responded ${response.status}: ${await response.text()}`;
    } catch (error) {
      // A refused or abandoned attempt while the listener is still binding: poll again.
      lastFailure = `GET /health failed: ${error.message}`;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  child.kill('SIGKILL');
  throw new Error(
    `service did not become ready on port ${port} within ${READY_TIMEOUT_MS} ms\n` +
      `last attempt: ${lastFailure}\n${output}`,
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

test('operator receives stock, reserves it in a shipment, dispatches it and reads both back',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { child, baseUrl } = await startService();

    try {
      const intakeResponse = await fetch(`${baseUrl}/inventory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku: 'SKU-1', name: 'Widget', quantity: 10 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch((error) => {
        throw new Error(`POST /inventory failed: ${error.message}`, { cause: error });
      });
      const intakeBody = await intakeResponse.text();
      assert.equal(
        intakeResponse.status,
        201,
        `POST /inventory returned ${intakeResponse.status}: ${intakeBody}`,
      );
      assert.deepEqual(
        JSON.parse(intakeBody),
        {
          sku: 'SKU-1',
          name: 'Widget',
          quantity: 10,
          reorderLevel: 5,
        },
        `POST /inventory stored item: ${intakeBody}`,
      );

      const shipmentResponse = await fetch(`${baseUrl}/shipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku: 'SKU-1', quantity: 4, destination: 'Berlin' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch((error) => {
        throw new Error(`POST /shipments failed: ${error.message}`, { cause: error });
      });
      const shipmentBody = await shipmentResponse.text();
      assert.equal(
        shipmentResponse.status,
        201,
        `POST /shipments returned ${shipmentResponse.status}: ${shipmentBody}`,
      );
      const shipment = JSON.parse(shipmentBody);
      assert.equal(shipment.id, 'SHP-1', `POST /shipments shipment id: ${shipmentBody}`);
      assert.equal(shipment.status, 'created', `POST /shipments initial status: ${shipmentBody}`);

      const dispatchResponse = await fetch(`${baseUrl}/shipments/SHP-1/dispatch`, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch((error) => {
        throw new Error(
          `POST /shipments/SHP-1/dispatch failed: ${error.message}`,
          { cause: error },
        );
      });
      const dispatchBody = await dispatchResponse.text();
      assert.equal(
        dispatchResponse.status,
        200,
        `POST /shipments/SHP-1/dispatch returned ${dispatchResponse.status}: ${dispatchBody}`,
      );
      const dispatched = JSON.parse(dispatchBody);
      assert.equal(dispatched.status, 'dispatched', `dispatch response status: ${dispatchBody}`);
      assert.equal(dispatched.carrier, 'standard', `dispatch response carrier: ${dispatchBody}`);

      const shipmentReadResponse = await fetch(`${baseUrl}/shipments/SHP-1`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch((error) => {
        throw new Error(`GET /shipments/SHP-1 failed: ${error.message}`, { cause: error });
      });
      const shipmentReadBody = await shipmentReadResponse.text();
      assert.equal(
        shipmentReadResponse.status,
        200,
        `GET /shipments/SHP-1 returned ${shipmentReadResponse.status}: ${shipmentReadBody}`,
      );
      const persistedShipment = JSON.parse(shipmentReadBody);
      assert.equal(persistedShipment.status, 'dispatched', `read-back status: ${shipmentReadBody}`);
      assert.equal(persistedShipment.carrier, 'standard', `read-back carrier: ${shipmentReadBody}`);

      const inventoryResponse = await fetch(`${baseUrl}/inventory`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch((error) => {
        throw new Error(`GET /inventory failed: ${error.message}`, { cause: error });
      });
      const inventoryBody = await inventoryResponse.text();
      assert.equal(
        inventoryResponse.status,
        200,
        `GET /inventory returned ${inventoryResponse.status}: ${inventoryBody}`,
      );
      const items = JSON.parse(inventoryBody);
      assert.equal(items.length, 1, `GET /inventory item count: ${inventoryBody}`);
      assert.equal(items[0].sku, 'SKU-1', `GET /inventory item sku: ${inventoryBody}`);
      assert.equal(items[0].quantity, 6, `GET /inventory remaining quantity: ${inventoryBody}`);
    } finally {
      await stopService(child);
    }
  });
