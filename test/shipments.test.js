// This file covers shipment creation only: POST /shipments and its refusal paths.
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

test('creating a shipment reserves stock and reports it as created', async () => {
  const seeded = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-RESERVE-1', name: 'Bracket', quantity: 10 })
  });
  assert.equal(seeded.status, 201);

  const response = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-RESERVE-1', quantity: 4, destination: 'Berlin' })
  });
  assert.equal(response.status, 201);
  const { id, ...record } = await response.json();
  assert.match(id, /^SHP-\d+$/);
  assert.deepEqual(record, {
    sku: 'SKU-SHIP-RESERVE-1',
    quantity: 4,
    destination: 'Berlin',
    status: 'created'
  });

  const listed = await (await fetch(`${base}/inventory`)).json();
  const entry = listed.find((item) => item.sku === 'SKU-SHIP-RESERVE-1');
  assert.ok(entry, 'the reserved item is still listed in the inventory');
  assert.equal(entry.quantity, 6);
});

test('creating a shipment rejects a quantity above the available stock', async () => {
  const seeded = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-OVER-1', name: 'Rivet', quantity: 2 })
  });
  assert.equal(seeded.status, 201);

  const refused = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-OVER-1', quantity: 3, destination: 'Madrid' })
  });
  assert.equal(refused.status, 409);
  const refusal = await refused.json();
  assert.deepEqual(refusal, { error: 'insufficient inventory' });
  assert.equal(refusal.id, undefined);

  const afterRefusal = await (await fetch(`${base}/inventory`)).json();
  const refusedItem = afterRefusal.find((item) => item.sku === 'SKU-SHIP-OVER-1');
  assert.ok(refusedItem, 'SKU-SHIP-OVER-1 is still listed in the inventory after the refusal');
  assert.equal(refusedItem.quantity, 2);

  const reserved = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-OVER-1', quantity: 2, destination: 'Madrid' })
  });
  assert.equal(reserved.status, 201);

  const afterReservation = await (await fetch(`${base}/inventory`)).json();
  const reservedItem = afterReservation.find((item) => item.sku === 'SKU-SHIP-OVER-1');
  assert.ok(reservedItem, 'SKU-SHIP-OVER-1 is still listed in the inventory after the full reservation');
  assert.equal(reservedItem.quantity, 0);
});

test('creating a shipment rejects a non-positive quantity without touching stock', async () => {
  const seeded = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-QTY-1', name: 'Washer', quantity: 5 })
  });
  assert.equal(seeded.status, 201);

  for (const quantity of [0, -5, '3']) {
    const response = await fetch(`${base}/shipments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-SHIP-QTY-1', quantity, destination: 'Lisbon' })
    });
    assert.equal(response.status, 400, `quantity ${JSON.stringify(quantity)} is refused`);
    assert.deepEqual(await response.json(), { error: 'quantity must be positive' });
  }

  const listed = await (await fetch(`${base}/inventory`)).json();
  const untouchedItem = listed.find((item) => item.sku === 'SKU-SHIP-QTY-1');
  assert.ok(untouchedItem, 'SKU-SHIP-QTY-1 is still listed in the inventory');
  assert.equal(untouchedItem.quantity, 5);
});

test('creating a shipment rejects a sku that is not in the catalogue', async () => {
  const seeded = await fetch(`${base}/inventory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-MISSING-1', name: 'Clamp', quantity: 2 })
  });
  assert.equal(seeded.status, 201);

  const first = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-MISSING-1', quantity: 1, destination: 'Oslo' })
  });
  assert.equal(first.status, 201);
  const { id: idBeforeRefusal } = await first.json();

  const refused = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-MISSING-1-UNKNOWN', quantity: 1, destination: 'Oslo' })
  });
  assert.equal(refused.status, 404);
  const refusal = await refused.json();
  assert.deepEqual(refusal, { error: 'sku not found' });
  assert.equal(refusal.id, undefined);

  const second = await fetch(`${base}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHIP-MISSING-1', quantity: 1, destination: 'Oslo' })
  });
  assert.equal(second.status, 201);
  const { id: idAfterRefusal } = await second.json();

  // Ids are allocated from the shipment count, so one step between these two ids
  // proves the refused call allocated nothing. Compared relatively: no id value is assumed.
  assert.equal(Number(idAfterRefusal.slice(4)), Number(idBeforeRefusal.slice(4)) + 1);
});
