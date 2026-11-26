# Child Two — Warehouse Catalogue API

An Express service for inventory intake, shipment creation, shipment lookup and dispatch.

## Run
`npm install`
`npm start`

## Existing tests
`npm test`

## Deliberate analysis gaps
Every route is covered at the integration level. `test/inventory.test.js` covers inventory intake with its payload and duplicate-SKU guards and inventory listing with the post-reservation quantity and insertion order; `test/shipments.test.js` covers shipment creation with its in-place stock decrement and the three refusals (unknown SKU, non-positive or non-integer quantity, insufficient inventory); `test/shipment-lifecycle.test.js` covers shipment retrieval with its 404 and dispatch with the default and the supplied carrier plus the repeated-dispatch 409; `test/entrypoint.test.js` covers the process entry point; `test/routes.test.js` still covers the health route. What is deliberately left uncovered: no coverage threshold is configured, so coverage is tracked by behaviour, by hand, in the section below; the module-level `inventory` and `shipments` Maps live for the life of a process and are never exported, so no test can reset them and a test reads back only the keys it wrote; and nothing covers concurrent requests or the non-transactional decrement-then-insert in `POST /shipments`.

## Integration test results

Everything recorded here is integration-level: each test drives real HTTP over a loopback socket (`app.listen(0)` plus the global `fetch`) or spawns the entry point and talks to it over its own socket (`node src/index.js`, or `npm run start` for the recorded manifest case), and none of it calls a handler directly or substitutes the transport. The one case that can issue no request is `entry point falls back to port 3000 when PORT is unset` where port 3000 is held: it skips instead of running, as recorded below. Every command below was run from `services/warehouse-catalogue-api` on Node.js v22.23.5 with `express@4.21.2`.

### Expected failure

`manifest start script serves the app` in `test/entrypoint.test.js` fails on purpose.

- Reason: `package.json:5` sets `start` to `node src/server.js`, and `src/server.js:53` is `module.exports = app` with no `listen` call, so `npm start` starts a process that serves nothing; the bind and the startup log live in `src/index.js`, which the manifest does not start.
- Reproducing command: `node --test --test-name-pattern="manifest start script" test/entrypoint.test.js`
- Observed TAP line:

```text
not ok 1 - manifest start script serves the app # TODO package.json:5 sets start to `node src/server.js`, and src/server.js:53 is `module.exports = app` with no listen call, so `npm start` starts a process that serves nothing
```

The summary of that run is `# tests 1`, `# pass 0`, `# fail 0`, `# todo 1`, exit code 0. The test is deliberately marked as an expected failure with the runner's `{ todo: <reason> }` idiom — Node's runner has no `xfail` — so it is counted under `# todo` and never under `# fail`, and production behaviour was not changed to make it pass.

### Run evidence

| Command | Observed summary |
| --- | --- |
| `node --test test/routes.test.js` (the pre-existing health test on its own) | `# tests 1`, `# pass 1`, `# fail 0`, exit 0 |
| `node --test test/inventory.test.js` | `# tests 4`, `# pass 4`, `# fail 0`, exit 0 |
| `node --test test/shipments.test.js` | `# tests 4`, `# pass 4`, `# fail 0`, exit 0 |
| `node --test test/shipment-lifecycle.test.js` | `# tests 3`, `# pass 3`, `# fail 0`, exit 0 |
| `node --test test/entrypoint.test.js` | `# tests 3`, `# pass 2`, `# fail 0`, `# todo 1`, exit 0 |
| `npm test` (full suite) | `# tests 15`, `# pass 14`, `# fail 0`, `# todo 1`, exit 0 |

Each passing case on its own, one command per case — the fourteen passing cases (the pre-existing health case plus the thirteen new ones), since `manifest start script serves the app` is the expected failure recorded above:

| Command | Observed line |
| --- | --- |
| `node --test --test-name-pattern="health route responds" test/routes.test.js` | `ok 1 - health route responds`, exit 0 |
| `node --test --test-name-pattern="creating inventory stores the item and defaults reorder level to 5" test/inventory.test.js` | `ok 1 - creating inventory stores the item and defaults reorder level to 5`, exit 0 |
| `node --test --test-name-pattern="creating inventory rejects a payload missing required fields" test/inventory.test.js` | `ok 1 - creating inventory rejects a payload missing required fields`, exit 0 |
| `node --test --test-name-pattern="creating inventory rejects a duplicate sku" test/inventory.test.js` | `ok 1 - creating inventory rejects a duplicate sku`, exit 0 |
| `node --test --test-name-pattern="listing inventory returns stored items in insertion order with current quantities" test/inventory.test.js` | `ok 1 - listing inventory returns stored items in insertion order with current quantities`, exit 0 |
| `node --test --test-name-pattern="creating a shipment reserves stock and reports it as created" test/shipments.test.js` | `ok 1 - creating a shipment reserves stock and reports it as created`, exit 0 |
| `node --test --test-name-pattern="creating a shipment rejects a quantity above the available stock" test/shipments.test.js` | `ok 1 - creating a shipment rejects a quantity above the available stock`, exit 0 |
| `node --test --test-name-pattern="creating a shipment rejects a non-positive quantity without touching stock" test/shipments.test.js` | `ok 1 - creating a shipment rejects a non-positive quantity without touching stock`, exit 0 |
| `node --test --test-name-pattern="creating a shipment rejects a sku that is not in the catalogue" test/shipments.test.js` | `ok 1 - creating a shipment rejects a sku that is not in the catalogue`, exit 0 |
| `node --test --test-name-pattern="reading a shipment returns the stored shipment and rejects an unknown id" test/shipment-lifecycle.test.js` | `ok 1 - reading a shipment returns the stored shipment and rejects an unknown id`, exit 0 |
| `node --test --test-name-pattern="dispatching a shipment marks it dispatched with the given or default carrier" test/shipment-lifecycle.test.js` | `ok 1 - dispatching a shipment marks it dispatched with the given or default carrier`, exit 0 |
| `node --test --test-name-pattern="dispatching a shipment twice conflicts and an unknown id is not found" test/shipment-lifecycle.test.js` | `ok 1 - dispatching a shipment twice conflicts and an unknown id is not found`, exit 0 |
| `node --test --test-name-pattern="entry point serves the app on the port named by PORT and logs it" test/entrypoint.test.js` | `ok 1 - entry point serves the app on the port named by PORT and logs it`, exit 0 |
| `node --test --test-name-pattern="entry point falls back to port 3000 when PORT is unset" test/entrypoint.test.js` | `ok 1 - entry point falls back to port 3000 when PORT is unset`, exit 0 |

Port 3000 was free in the environment these runs were taken in, so `entry point falls back to port 3000 when PORT is unset` ran instead of skipping. Where the port is held, that case skips with `port 3000 is occupied in this environment`, and the summaries become `# pass 1`, `# skipped 1`, `# todo 1` for the file and `# pass 13`, `# skipped 1`, `# todo 1` for the full suite, still with exit code 0.

### Coverage

13 of 13 integration behaviours are covered — the pre-existing `GET /health` behaviour plus the 12 newly closed — against a denominator of 13, of which 5 are high priority and 8 medium. The requested target was 90%, which at this denominator is 12 of 13 behaviours (92.3%); 11 of 13 would be 84.6% and would miss, and this work closes 12 behaviours, reaching 13 of 13. The framework-level `400` that `express.json()` returns for a malformed JSON body is deliberately excluded, because it re-tests Express rather than this service.

Line coverage is a secondary measure and settles nothing here: `node --test --experimental-test-coverage` reports `src/server.js` at 100.00% lines / 100.00% branches / 100.00% functions, against 45.28% / 100.00% / 16.67% before this work. `src/index.js` does not appear in that report at all: `node --test` runs each child with a `NODE_V8_COVERAGE` directory and a process writes its coverage only when it exits cleanly, so the `node src/index.js` children — stopped with SIGTERM — flush nothing, and the manifest case starts `src/server.js`, which the route test files already import. The evidence for the entry point is the spawn test above.
