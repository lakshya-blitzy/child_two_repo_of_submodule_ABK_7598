// This file covers the inventory routes only: POST /inventory and GET /inventory.
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let server;
let base;

test.before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

function postJson(path, payload) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// The stored Maps outlive a single test in this process, so a read-back is always narrowed to
// the SKUs the calling test wrote; asserting the whole list would couple the cases to each other.
async function readInventoryFor(skus) {
  const response = await fetch(`${base}/inventory`);
  assert.equal(response.status, 200);
  const stored = await response.json();
  return stored.filter((item) => skus.includes(item.sku));
}

test('creating inventory stores the item and defaults reorder level to 5', async () => {
  const expected = { sku: 'SKU-INV-DEFAULT-1', name: 'Bolt', quantity: 7, reorderLevel: 5 };

  const created = await postJson('/inventory', { sku: 'SKU-INV-DEFAULT-1', name: 'Bolt', quantity: 7 });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), expected);

  assert.deepEqual(await readInventoryFor(['SKU-INV-DEFAULT-1']), [expected]);
});

test('creating inventory rejects a payload missing required fields', async () => {
  const payloads = [
    { name: 'NoSku', quantity: 1 },
    { sku: 'SKU-INV-BAD-2', quantity: 1 },
    { sku: 'SKU-INV-BAD-3', name: 'BadQty', quantity: '5' },
    { sku: 'SKU-INV-BAD-4', name: 'NegQty', quantity: -1 },
  ];

  for (const payload of payloads) {
    const response = await postJson('/inventory', payload);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.deepEqual(await response.json(), { error: 'invalid inventory payload' });
  }

  assert.deepEqual(await readInventoryFor(['SKU-INV-BAD-2', 'SKU-INV-BAD-3', 'SKU-INV-BAD-4']), []);
});

test('creating inventory rejects a duplicate sku', async () => {
  const stored = { sku: 'SKU-INV-DUP-1', name: 'Plate', quantity: 4, reorderLevel: 5 };

  const created = await postJson('/inventory', { sku: 'SKU-INV-DUP-1', name: 'Plate', quantity: 4 });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), stored);

  const duplicate = await postJson('/inventory', { sku: 'SKU-INV-DUP-1', name: 'Other', quantity: 9 });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'duplicate sku' });

  assert.deepEqual(await readInventoryFor(['SKU-INV-DUP-1']), [stored]);
});

test('listing inventory returns stored items in insertion order with current quantities', async () => {
  const nut = await postJson('/inventory', { sku: 'SKU-INV-ORDER-B', name: 'Nut', quantity: 8 });
  assert.equal(nut.status, 201);
  const washer = await postJson('/inventory', { sku: 'SKU-INV-ORDER-A', name: 'Washer', quantity: 5 });
  assert.equal(washer.status, 201);

  const reserved = await postJson('/shipments', { sku: 'SKU-INV-ORDER-B', quantity: 3, destination: 'Lyon' });
  assert.equal(reserved.status, 201);

  assert.deepEqual(await readInventoryFor(['SKU-INV-ORDER-A', 'SKU-INV-ORDER-B']), [
    { sku: 'SKU-INV-ORDER-B', name: 'Nut', quantity: 5, reorderLevel: 5 },
    { sku: 'SKU-INV-ORDER-A', name: 'Washer', quantity: 5, reorderLevel: 5 },
  ]);
});
