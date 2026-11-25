# Gateway observability

Use the project's pinned Node version. The Gateway listens on loopback and continues to expose the same three versioned system operations. Monitoring is enabled explicitly for development or staging.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDUAPP_MONITORING_MODE` | unset | Enable `development` or `staging`. |
| `GATEWAY_PORT` | `3010` | Gateway HTTP listener on 127.0.0.1. |
| `EDUAPP_METRICS_PORT` | `9464` | Separate loopback metrics listener. |
| `EDUAPP_READINESS_API_PORT` | unset in development | Port of the API on 127.0.0.1. Required in staging. |

Start the Gateway in a local development shell.

```sh
EDUAPP_MONITORING_MODE=development node apps/api-gateway/src/main.mjs
```

For a staging-profile smoke check on the same host, start the built modular API on loopback port 3000 and start the Gateway with the dependency check enabled.

```sh
EDUAPP_MONITORING_MODE=staging EDUAPP_READINESS_API_PORT=3000 node apps/api-gateway/src/main.mjs
```

From the same host, query each interface.

```sh
curl -i http://127.0.0.1:3010/v1/health/live
curl -i http://127.0.0.1:3010/v1/health/ready
curl -fsS http://127.0.0.1:9464/metrics
node --test tests/S02-W05/*.test.mjs
```

Expect a 200 live response throughout an API outage. The next readiness probe gives a 503 and records a `gateway.alert` transition with state `firing`. When the local API recovers, the next successful probe records state `resolved`. Match the `X-Request-Id` response header to the `request_id` log field and use `trace_id` and `parent_span_id` to follow the readiness probe. Gateway stdout contains the structured records. The loopback metrics listener can be scraped by a local collector.

Keep the metrics port outside public reverse-proxy routes. Feed readiness into the environment's normal health checks because each alert evaluates on a readiness request. Telemetry stays process-local until an environment configures log collection and scraping. Unsetting `EDUAPP_MONITORING_MODE` and restarting the local Gateway disables monitoring and restores the standalone readiness behavior.
