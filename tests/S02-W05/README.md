# S02-W05 acceptance

```sh
node --test tests/S02-W05/*.test.mjs
```

The development-profile test serves a real loopback Gateway, using synthetic identities in two owner scopes. Successful and failed responses preserve their request IDs in the trace, and counters and latency distributions are privately scrapeable. Synthetic names, tenant and actor IDs, headers, payloads, paths, query strings, trace input, credentials, idempotency keys and thrown errors stay out of logs and metric samples.

The staging-profile test runs a separate loopback API and drives a healthy response, a failure, a timeout and recovery. It verifies the 200 liveness response during the outage, 503 readiness, firing and resolved alerts, readiness gauge changes, and parent and child span correlation across the configured probe. Configuration and a failing log sink have additional coverage.

The tests use synthetic local fixtures and do not contact a staging or production host.
