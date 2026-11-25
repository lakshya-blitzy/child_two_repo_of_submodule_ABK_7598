const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

// These tests intentionally focus on the health route and a single validation contract.
// Full workflow coverage is intentionally absent from this fixture.
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
