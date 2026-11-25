const express = require('express');
const app = express();
app.use(express.json());

const inventory = new Map();
const shipments = new Map();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/inventory', (req, res) => {
  const { sku, name, quantity, reorderLevel = 5 } = req.body;
  if (!sku || !name || !Number.isInteger(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'invalid inventory payload' });
  }
  if (inventory.has(sku)) return res.status(409).json({ error: 'duplicate sku' });
  const item = { sku, name, quantity, reorderLevel };
  inventory.set(sku, item);
  return res.status(201).json(item);
});

app.get('/inventory', (_req, res) => res.json([...inventory.values()]));

app.post('/shipments', (req, res) => {
  const { sku, quantity, destination } = req.body;
  const item = inventory.get(sku);
  if (!item) return res.status(404).json({ error: 'sku not found' });
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be positive' });
  }
  if (item.quantity < quantity) return res.status(409).json({ error: 'insufficient inventory' });
  item.quantity -= quantity;
  const id = `SHP-${shipments.size + 1}`;
  const shipment = { id, sku, quantity, destination, status: 'created' };
  shipments.set(id, shipment);
  return res.status(201).json(shipment);
});

app.get('/shipments/:id', (req, res) => {
  const shipment = shipments.get(req.params.id);
  if (!shipment) return res.status(404).json({ error: 'shipment not found' });
  return res.json(shipment);
});

app.post('/shipments/:id/dispatch', (req, res) => {
  const shipment = shipments.get(req.params.id);
  if (!shipment) return res.status(404).json({ error: 'shipment not found' });
  if (shipment.status !== 'created') return res.status(409).json({ error: 'shipment cannot be dispatched' });
  shipment.status = 'dispatched';
  shipment.carrier = req.body.carrier || 'standard';
  return res.json(shipment);
});

module.exports = app;
