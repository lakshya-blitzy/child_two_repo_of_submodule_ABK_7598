const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

// This file covers the health route only.
// Inventory, shipment and dispatch routes are covered in sibling test files.
test('health route responds', async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    server.close();
  }
});
