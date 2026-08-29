# Relay observability

> For maintainers. Using RAS Code? See [docs/user](../user/).

The relay Worker, the mobile app, and first-party relay clients all export OpenTelemetry spans to one
PostHog project over OTLP. PostHog is an OTLP receiver, so there is nothing to provision: the Alchemy
stack owns no observability resources, and every producer authenticates with the same project token.

Configuration lives in two values:

- `POSTHOG_PROJECT_TOKEN`, the `phc_` project token. It is a public client identifier, which is why
  release builds embed it for the mobile app and hosted web client. CI still stores it as an
  environment secret so it is masked in workflow logs; it grants ingest only and cannot read data.
- `POSTHOG_OTLP_TRACES_URL`, defaulting to `https://us.i.posthog.com/i/v1/traces`. Set it for the EU
  region or a self-hosted PostHog instance.

Spans are authorized with `Authorization: Bearer <project token>`. Stages are distinguished by the
`service.name` resource attribute rather than by separate datasets, so a personal stage and
production land in the same project and are filtered apart at query time.

Deploy from `infra/relay` with the normal Alchemy workflow:

```sh
vp run deploy
```

The Worker emits Effect's built-in HTTP server spans plus endpoint and database child spans.
Effect's OpenTelemetry exporter stores semantic HTTP attributes below the `attributes.` prefix.
Query them with HogQL against `posthog.trace_spans`:

```sql
SELECT timestamp, name, trace_id, duration_nano, service_name,
       attributes['http.request.method'] AS method,
       attributes['url.path'] AS path,
       attributes['http.response.status_code'] AS status,
       attributes['http.route'] AS endpoint,
       attributes['custom.relay.operation'] AS relay_operation
FROM posthog.trace_spans
WHERE service_name = 'ras-code-relay-worker'
  AND name LIKE 'http.server%'
ORDER BY timestamp DESC
LIMIT 200
```

Relay-specific span annotations are stored under the `custom.` attribute prefix; `relay.operation` is
one of the emitted custom attributes.

Agents should prefer PostHog queries for completed incidents instead of tailing the Cloudflare
Worker. Reading traces needs a PostHog login or a personal API key; the project token is
ingest-only and cannot query.
