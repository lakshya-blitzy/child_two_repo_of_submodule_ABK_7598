// This file covers shipment lifecycle only: GET /shipments/:id and POST /shipments/:id/dispatch.
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

test('reading a shipment returns the stored shipment and rejects an unknown id', async () => {
  const seed = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-READ-1', name: 'Anchor', quantity: 5 }),
  });
  assert.equal(seed.status, 201);

  const creation = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-READ-1', quantity: 2, destination: 'Lisbon' }),
  });
  assert.equal(creation.status, 201);
  const created = await creation.json();

  const read = await fetch(`${base}/shipments/${created.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), created);

  const missing = await fetch(`${base}/shipments/SHP-999`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'shipment not found' });
});

test('dispatching a shipment marks it dispatched with the given or default carrier', async () => {
  const seedA = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-DISPATCH-A', name: 'Bolt', quantity: 5 }),
  });
  assert.equal(seedA.status, 201);

  const seedB = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-DISPATCH-B', name: 'Rope', quantity: 5 }),
  });
  assert.equal(seedB.status, 201);

  const creationA = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-DISPATCH-A', quantity: 1, destination: 'Porto' }),
  });
  assert.equal(creationA.status, 201);
  const createdA = await creationA.json();

  const creationB = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-DISPATCH-B', quantity: 1, destination: 'Braga' }),
  });
  assert.equal(creationB.status, 201);
  const createdB = await creationB.json();

  const dispatchA = await fetch(`${base}/shipments/${createdA.id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(dispatchA.status, 200);
  assert.deepEqual(await dispatchA.json(), { ...createdA, status: 'dispatched', carrier: 'standard' });

  const dispatchB = await fetch(`${base}/shipments/${createdB.id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carrier: 'dhl' }),
  });
  assert.equal(dispatchB.status, 200);
  const dispatchedB = await dispatchB.json();
  assert.deepEqual(dispatchedB, { ...createdB, status: 'dispatched', carrier: 'dhl' });

  const readB = await fetch(`${base}/shipments/${createdB.id}`);
  assert.equal(readB.status, 200);
  assert.deepEqual(await readB.json(), dispatchedB);
});

test('dispatching a shipment twice conflicts and an unknown id is not found', async () => {
  const seed = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-TWICE-1', name: 'Crate', quantity: 5 }),
  });
  assert.equal(seed.status, 201);

  const creation = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-LIFE-TWICE-1', quantity: 2, destination: 'Faro' }),
  });
  assert.equal(creation.status, 201);
  const created = await creation.json();

  const first = await fetch(`${base}/shipments/${created.id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(first.status, 200);
  const dispatched = await first.json();

  const second = await fetch(`${base}/shipments/${created.id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'shipment cannot be dispatched' });

  const read = await fetch(`${base}/shipments/${created.id}`);
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.equal(readBody.status, 'dispatched');
  assert.deepEqual(readBody, dispatched);

  const unknown = await fetch(`${base}/shipments/SHP-999/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'shipment not found' });
});
