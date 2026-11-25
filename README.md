# Child Two — Warehouse Catalogue API

An Express service for inventory intake, shipment creation, shipment lookup and dispatch.

## Run
`npm install`
`npm start`

## Existing tests
`npm test`

## Deliberate analysis gaps
Only the health route is currently tested. Missing high-value journeys include receiving inventory, creating a shipment, verifying inventory decrement, retrieving the shipment and dispatching it. Boundary and conflict behaviours (duplicate SKU, insufficient inventory, repeated dispatch) also need tests.
