# RAS Connect Relay

> [!NOTE]
> Sign in to RAS Connect from the app under Settings > Connections.

The relay is the hosted control plane for RAS Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

Managed traffic passes through the relay Worker's shared path gateway. A per-environment Durable
Object multiplexes it over the RAS Code server's authenticated outbound connector.
See the [RAS Connect architecture overview](../../docs/internals/ras-code-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking RAS Code environments to a cloud account.
- Provisioning deterministic managed environment endpoints and relay sessions.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter ras-code-relay deploy
```

The stack provisions the Cloudflare Worker, Durable Objects, queues, gateway resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk and APNs credentials. Production adopts
the configured API and gateway DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The `prod` Alchemy stage is the shared hosted relay for stable and canary clients and owns the
database named by `RELAY_DATABASE_NAME`. Every other stage gets its own
`<RELAY_DATABASE_NAME>-<stage>` database on the same Postgres server, so stages never share tables:

```sh
vp run --filter ras-code-relay deploy --stage prod
vp run --filter ras-code-relay deploy --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`code-relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`code-relay-dev-julius.<RELAY_API_ZONE_NAME>`. Clients use
`RELAY_GATEWAY_DOMAIN/e/<digest>/`; the Worker sends each request to the endpoint's Durable Object,
which multiplexes it over the environment's outbound connector. Keep the API and gateway zone the
same when Cloudflare's Universal SSL certificate must cover only first-level subdomains.
`RELAY_DOMAIN` remains available as an explicit API domain override.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and canary release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_DATABASE_HOST`
- `RELAY_DATABASE_NAME`
- `RELAY_DATABASE_USER`
- `RELAY_GATEWAY_ZONE_NAME`
- `RELAY_GATEWAY_DOMAIN`
- `RELAY_ENDPOINT_NAMESPACE`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`
- `POSTHOG_PROJECT_TOKEN`
- `RELAY_DATABASE_PASSWORD`
- `RELAY_DATABASE_ACCESS_CLIENT_ID`
- `RELAY_DATABASE_ACCESS_CLIENT_SECRET`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. Postgres is reached through a Cloudflare Tunnel guarded by an
Access application, so it needs no public port; Hyperdrive authenticates with the Access service
token. Migrations run from the deploy host over `cloudflared access tcp` rather than through
Hyperdrive. The release workflow reads the production relay's derived public URL and Clerk
publishable key from the same environment for downstream desktop, CLI, and hosted web builds.

See:

- [RAS Connect Clerk Setup](../../docs/internals/ras-connect.md) for Clerk keys, JWT templates, and sign-up restrictions
  setup.
- [Relay Database](../../docs/operations/relay-database.md) for the tunnel, Access, and migration topology.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [RAS Connect Architecture Overview](../../docs/internals/ras-code-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.
