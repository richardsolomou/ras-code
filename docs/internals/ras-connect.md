# RAS Connect

RAS Connect uses Clerk for cloud identity. The relay manages environment links,
credentials for reaching environments, and the managed gateway. The relay
carries the traffic itself: client HTTP and WebSocket sessions run through the
Worker and its Durable Object, not through a per-environment tunnel hostname the
client reaches directly.

Clerk, deployment, and native authentication setup live in the
[Connect setup runbook](../operations/connect-setup.md).

## The relay is a trusted broker

An authenticated cloud user still needs an active environment link. The relay
asks that environment to mint a one-time bootstrap credential bound to the
client's DPoP key. The client exchanges it directly with the environment for an
[environment session](./environment-auth.md). The relay never receives that
session token, and possessing the bootstrap credential alone does not permit
redeeming it without the client's private key.

Both sides authenticate this exchange. The environment accepts only bounded,
replay-guarded relay proofs for its own identity, linked user, and requested
operation. Signed environment responses bind the result to the request nonce;
mint responses also bind the credential to the client proof key. The relay
verifies those bindings before returning a credential. This prevents a different
process behind the tunnel from impersonating the linked environment. The checks
meet in the
[environment cloud handlers](../../apps/server/src/cloud/http.ts) and
[relay connector](../../infra/relay/src/environments/EnvironmentConnector.ts).

The relay holds the signing authority for mint requests. DPoP protects an honest
exchange from credential reuse; it does not make a compromised relay signing
key harmless. Keep that trust assumption explicit when changing the protocol.

Managed tunnels expose only a validated loopback HTTP origin. Link proof checks
reject forwarded authority headers, and the relay resolves endpoints from its
own managed allocations rather than a caller-supplied URL. Health and mint
requests must not follow redirects. These restrictions keep endpoint discovery
from turning into arbitrary relay egress or exposing another service on the
environment host.

## A link outlives a connector process

CLI authorization, desired exposure, and a running connector have different
lifetimes. Linking can record intent while the server is stopped. Startup
reconciles that intent. CLI logout removes the stored cloud credential and
disables exposure without uninstalling the environment's background service.

Managed allocations belong to a user/environment pair. Provisioning checkpoints
external tunnel and DNS resources so retries can reconcile partial work. A
normal shutdown of a CLI-managed link releases its tunnel to avoid paying for
an idle resource, retaining the hostname reservation for the next startup.
It also retains the allocation record so the environment remains "offline"
rather than becoming "not authorized".

Two cases must retain the tunnel across shutdown. A link installed through a
client has no startup provisioning path and depends on its stored connector
token. An update handoff immediately starts a replacement server, and replacing
the tunnel would add routing propagation delay to every update. These exceptions
belong to [shutdown handling](../../apps/server/src/cloud/http.ts).

Release and unlink claim the allocation generation before deleting external
resources. A delayed cleanup must not delete a tunnel reused by a concurrent
restart or relink. Unlink commits authorization revocation before external
teardown, because a database failure must leave the active link usable. Failed
teardown retains enough state to retry. See the
[managed endpoint lifecycle](../../infra/relay/src/environments/ManagedEndpointProvider.ts).

## OAuth traps

Interactive clients and the headless CLI use the same Clerk application but
different credentials. The relay accepts both session-template JWTs and CLI
OAuth tokens; requiring a JWT template for the CLI would reject valid logins.
The CLI is a public OAuth client using PKCE and stores no client secret.

CLI authorization starts on the hosted `/connect` page so sign-in completes
before entering Clerk's authorize endpoint. Sending a signed-out browser
straight to that endpoint loses the authorize parameters during the sign-in
redirect. The [shared flow](../../packages/shared/src/connectAuth.ts) preserves
PKCE and state for both loopback and pasted-code callbacks. SSH and headless
sessions use the pasted-code flow because the browser cannot ordinarily reach a
listener on the remote machine.

## Managed relay gateway

Managed environments are published through one certificate-bearing hostname. For the RAS-hosted
deployment, clients receive URLs such as `https://code-tunnels.ras.sh/e/<endpoint-id>/` and
`wss://code-tunnels.ras.sh/e/<endpoint-id>/ws`.

The environment server opens an authenticated outbound WebSocket to the relay Worker. The Worker
routes each public endpoint to one Durable Object, which multiplexes HTTP requests and WebSocket
sessions over that connector. The relay strips the gateway prefix before forwarding a route while
the managed endpoint configuration preserves the original public URL for DPoP validation. Do not
replace this with forwarded-host headers; those headers are client-controlled and deliberately
ignored by environment authentication.

### Connector liveness

Nothing above the socket can tell a healthy idle connector from a dead one, so the environment
server pings the relay every 20 seconds and terminates the socket when a ping goes unanswered for a
whole interval. Cloudflare answers WebSocket protocol pings automatically without waking the Durable
Object, so this costs no relay compute; a measured round trip is around 20ms.

The probe exists because a connector socket can go half-open without either end noticing:
`readyState` still reports `OPEN`, no `close` event ever fires, and the connector stays wedged until
the process restarts. Suspending a laptop or changing network does this, but so does an ordinary
long-lived connection being dropped upstream — an always-on wired host lost its connector that way
after five hours of silence, having logged nothing. Pinging on an interval also stops the socket
from ever being idle long enough to be dropped, so the probe prevents the failure as well as
detecting it.

A closed connector is restarted by the supervisor in `ManagedEndpointRuntime`, which backs off by
doubling up to 30 seconds. The cap matters more than the curve: while the connector is detached the
Durable Object answers `503` and every client sees the environment as offline, so recovery has to
finish inside the time someone spends waiting on their phone.

### Connect round trips

Every leg of a connect traverses the same relay hop, and the legs run serially, so latencies add.
The mint response therefore carries as much as the environment can sign in one reply:

- The environment descriptor rides in the mint proof, so clients skip the descriptor fetch.
- When the client's connect request names `sessionScopes` (a subset of the standard client
  scopes), the environment answers with a bundled `session` instead of a pairing credential: a
  DPoP-bound access token plus a single-use websocket ticket, both signed into the mint proof.
  The client then opens the socket directly, skipping the `/oauth/token` and
  `/api/auth/websocket-ticket` round trips through the tunnel.

Every field is optional in both directions, so version skew degrades to the slower path instead of
failing: environments that predate bundling ignore `sessionScopes` and answer with a credential,
relays that predate it never forward the request, and clients that predate it never ask. The
bundled token is still DPoP-bound to the thumbprint the relay attested in the mint request, so the
relay cannot use what it forwards. Scope requests outside the standard client set fall back to the
credential exchange, where `/oauth/token` reports the precise scope error.

On reconnect, clients skip the mint entirely: a persisted environment token (web stores it in
IndexedDB next to the DPoP key, mobile in the secure store) buys a websocket ticket in one round
trip. A slow ticket response is retried once with a patient budget before the attempt fails; the
cached token is only evicted when the environment explicitly rejects it, never on a timeout.

Using `ras.sh` for both `RELAY_API_ZONE_NAME` and `RELAY_GATEWAY_ZONE_NAME`, with
`code-tunnels.ras.sh` as `RELAY_GATEWAY_DOMAIN`, keeps every Cloudflare edge hostname at the
first subdomain level covered by Universal SSL. No Advanced Certificate Manager wildcard is needed.

The connect command group is:

```sh
ras connect            # default: onboarding
ras connect login
ras connect link       # --publish-only
ras connect status     # --json
ras connect publish    # --disable
ras connect unlink
ras connect logout
```

`ras serve` is a separate top-level command, not a connect subcommand.

`ras connect login` opens the Clerk authorization flow and stores the CLI credential without enabling
cloud exposure. `ras connect link` authorizes when needed and records durable intent to expose the
environment. It works without a running RAS Code server. The next `ras serve` or `ras start`
reconciles the relay link and launches the built-in outbound connector. `ras connect unlink` records
disabled intent immediately, stops a reachable running connector, and attempts to revoke the
relay-side environment record. It retains the stored CLI
authorization so `ras connect link` can re-enable exposure without another browser flow. `ras connect
logout` performs the same cleanup and removes the stored CLI authorization.

The background service has an independent lifecycle. Connect setup may offer to install it, but
logout leaves it running; manage it with `ras service status`, `install`, `update`, and `uninstall`.

### Headless and SSH authorization

The loopback OAuth callback listener binds to port `34338`. That path only works when a browser on
the same machine can reach it, so `authorizeCli` in `apps/server/src/cli/connect.ts` automatically
selects the out-of-band flow when `--headless` is passed or when it detects SSH through
`SSH_CONNECTION` or `SSH_TTY`. The out-of-band flow prints the hosted `/connect` authorization URL
and accepts a pasted authorization code, so no port is involved.

Port forwarding is therefore optional, not required. Forward the port only if you specifically want
the loopback flow over SSH:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

## Sign-in surfaces

Signed-in users manage RAS Connect under **Connections**. The settings sidebar carries its own
controls from `SettingsSidebarNav.tsx`: `RasConnectSidebarSignIn` shows a **Sign in to RAS Connect**
button in the footer while signed out, and `RasConnectSidebarAvatar` shows a Clerk `UserButton`
while signed in. Both are gated on cloud public configuration. Desktop renders the same web bundle,
so it has them too.
