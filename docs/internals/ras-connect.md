# RAS Connect

> For maintainers. Using RAS Code? See [docs/user](../user/).

RAS Connect uses one Clerk application for web, desktop, and mobile authentication. The relay verifies
two kinds of bearer credential: template JWTs generated from the `ras-code-relay` template with the shared
`ras-code-relay` audience, and Clerk OAuth tokens issued to the CLI. `verifyRelayClientBearerToken` in
`infra/relay/src/http/Api.ts` tries the template/session path first and falls back to OAuth
verification (`acceptsToken: "oauth_token"`), so the CLI's OAuth credential works without a JWT
template.

For the wider system diagram, see
[ras-code-connect-auth-flow.html](./ras-code-connect-auth-flow.html).

## Application Keys

RAS Connect is disabled in a fresh clone. To enable it for source builds against the production
deployment, copy the repository-root example file:

```sh
cp .env.example .env
```

`.env.example` carries the production public identifiers (the same values baked into official
release builds). To target a different Clerk application or relay, set the values yourself in a
repository-root `.env` or `.env.local` file:

```dotenv
RAS_CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
RAS_CODE_CLERK_JWT_TEMPLATE=<JWT template name>
RAS_CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
RAS_CODE_RELAY_URL=https://relay.example.com
```

The shared client loader projects these canonical values into framework-specific `VITE_*` and
`EXPO_PUBLIC_*` aliases. Existing aliases remain accepted as overrides for compatibility, but new
client configuration should use the canonical names.

Configuration precedence is:

1. Process or CI environment variables.
2. Repository-root `.env.local`.
3. Repository-root `.env`.

The Clerk publishable key, JWT template name, CLI OAuth client ID, and relay URL are public
identifiers, not secrets.
Web, desktop, mobile, and bundled server builds statically inject the values they consume during
their build step. A built artifact does not need an environment file at runtime. CI release builds
should set `RAS_CODE_CLERK_PUBLISHABLE_KEY`, `RAS_CODE_CLERK_JWT_TEMPLATE`,
`RAS_CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `RAS_CODE_RELAY_URL` before building. EAS preview and
production builds only need the Clerk publishable key, JWT template name, and relay URL in their EAS
environment.

When any client-facing public value is absent, cloud UI is omitted. The `ras connect` command group is
always registered: when the CLI public values are absent, `makeCli` in `apps/server/src/bin.ts`
registers a hidden fallback `connect` command that reports the missing configuration instead of
silently vanishing from help. The bundled server still accepts runtime overrides for self-hosted or
operator-managed deployments.

For a hosted relay deployment, copy `infra/relay/.env.example` to `infra/relay/.env`. The relay
deployment reads `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`,
`RELAY_TUNNEL_GATEWAY_DOMAIN`, `CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_AUDIENCE` through Effect
`Config`. `RELAY_TUNNEL_NAMESPACE` optionally controls the internal tunnel-record prefix. There are
no checked-in deployment defaults.
`vp run --filter ras-code-relay deploy` invokes Alchemy from the relay directory, so Alchemy loads
`infra/relay/.env`. After a successful deployment, the wrapper updates the repository-root `.env`
with the deployed HTTPS relay URL. The relay still requires
`CLERK_SECRET_KEY` as an Alchemy secret. Never put `CLERK_SECRET_KEY` in a client application
environment or commit it to the repository.

The `prod` Alchemy stage owns the retained PlanetScale database. Non-production stages reference
that database and provision isolated PlanetScale branches, so deploy `prod` before creating a
personal developer stage.

## Headless CLI OAuth Application

The `ras connect` commands authorize a headless environment with a separate Clerk OAuth application.
This uses an OAuth public client with PKCE, so the CLI stores no client secret.

In **Clerk Dashboard > OAuth applications**:

1. Create an OAuth application for the RAS Code CLI.
2. Enable the **Public** option so authorization-code exchange uses PKCE.
3. Add **both** allowed redirect URIs:
   - `http://127.0.0.1:34338/callback` for the loopback listener;
   - `https://code.ras.sh/connect/callback` for the hosted out-of-band flow. This is
     `connectCallbackUrl(RAS_CODE_HOSTED_APP_URL)` from `packages/shared/src/connectAuth.ts`; a
     custom hosted app URL changes the callback origin. Omitting the build-time hosted app URL
     breaks headless and SSH authorization.
4. Enable the `openid`, `profile`, and `email` scopes.
5. Set `RAS_CODE_CLERK_CLI_OAUTH_CLIENT_ID` in the repository-root `.env` file and release build
   environment to the generated public client ID.

Both CLI flows start at the hosted `/connect` page (`buildConnectAuthorizeRequestUrl` in
`packages/shared/src/connectAuth.ts`), which waits for a Clerk session and then forwards the request
to Clerk's `/oauth/authorize`. The CLI never opens `/oauth/authorize` directly: a signed-out browser
sent there goes through Clerk's sign-in redirect, which drops the authorize query parameters and
fails the flow with `unsupported_response_type` or an empty `state` (#5051). The loopback flow marks
the request with a `port` fragment parameter so the hosted page asks Clerk to redirect the
authorization code straight to `http://127.0.0.1:<port>/callback`; the out-of-band flow omits it and
uses the hosted `/connect/callback` page instead. The CLI derives Clerk's frontend API URL from the
publishable key and calls only the `/oauth/token` endpoint directly. The relay is not involved in
the OAuth handshake; it only validates the issued Clerk bearer token when the CLI manages an
environment link.

## Managed tunnel gateway

Managed environments are published through one certificate-bearing hostname. For the RAS-hosted
deployment, clients receive URLs such as `https://code-tunnels.ras.sh/e/<endpoint-id>/` and
`wss://code-tunnels.ras.sh/e/<endpoint-id>/ws`.

The relay Worker maps the endpoint ID to an internal first-level DNS record such as
`code-<endpoint-id>.ras.sh` and uses Cloudflare's same-zone DNS resolve override. The public Host and
full gateway path remain unchanged through the tunnel. The environment server removes the gateway
prefix only for route matching and validates DPoP against the original public URL. Do not replace
this with forwarded-host headers; those headers are client-controlled and deliberately ignored by
environment authentication.

Using `ras.sh` for both `RELAY_API_ZONE_NAME` and `RELAY_TUNNEL_ZONE_NAME`, with
`code-tunnels.ras.sh` as `RELAY_TUNNEL_GATEWAY_DOMAIN`, keeps every Cloudflare edge hostname at the
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
cloud exposure. `ras connect link` installs the pinned managed `cloudflared` binary when needed,
authorizes when needed, and records durable intent to expose the environment. It works without a
running RAS Code server. The next `ras serve` or `ras start` reconciles the relay link and launches the
managed tunnel. `ras connect unlink` records disabled intent immediately, stops a reachable running
connector, and attempts to revoke the relay-side environment record. It retains the stored CLI
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

## JWT Template

In **Clerk Dashboard > JWT templates**, create a template with:

| Setting | Value                         |
| ------- | ----------------------------- |
| Name    | `ras-code-relay`              |
| Claims  | `{ "aud": "ras-code-relay" }` |

Set `RAS_CODE_CLERK_JWT_TEMPLATE=ras-code-relay` in the repository-root `.env`, and set
`CLERK_JWT_AUDIENCE=ras-code-relay` in `infra/relay/.env`. Define `CLERK_JWT_TEMPLATE` and
`CLERK_JWT_AUDIENCE` in the production relay deployment environment as well. The stable `aud` value
is shared by production and non-production relay stages. The client-facing `RAS_CODE_RELAY_URL` still
selects the concrete relay deployment, but changing that URL does not require a JWT template change.

## Desktop OAuth Redirect Allowlist

The desktop app opens OAuth in the system browser and returns to the app with a custom URL scheme.
In **Clerk Dashboard > Native applications**, enable the Native API and add these entries under the
mobile SSO redirect allowlist:

```text
ras-code-dev://app/
ras-code://app/
```

Local desktop development uses `ras-code-dev://app`, while packaged builds use `ras-code://app`. Add the
matching origin to each Clerk instance's Backend API `allowed_origins` array as well. The development
Clerk instance should only need `ras-code-dev://app`; the production Clerk instance should only need
`ras-code://app`. `@clerk/electron` owns the native request adapter, encrypted Clerk token persistence,
external-browser OAuth transport, and callback delivery for initial sign-in and linked-account flows.

There is currently no Dashboard UI for `allowed_origins`. Preserve any existing entries and update
the instance through the Backend API:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["ras-code://app"]}'
```

Never put `CLERK_SECRET_KEY` in the desktop app, a client-facing environment file, or a build
artifact.

## Desktop Passkeys

The production macOS bundle ID is `com.richardsolomou.ras-code`. To enable native passkeys:

1. Create an explicit macOS App ID for `com.richardsolomou.ras-code` in the Apple Developer portal and enable
   **Associated Domains**.
2. Create a compatible macOS provisioning profile for that App ID and the certificate used to sign
   the distributed app.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID. This is
   also the configuration point for Electron/macOS passkeys.
4. Confirm Clerk serves `https://<frontend-api>/.well-known/apple-app-site-association` and that
   `webcredentials.apps` contains `<TEAM_ID>.com.richardsolomou.ras-code`.
5. Set the local or CI signing configuration described below.

For a local signed build, add these values to `.env.local` or export them before invoking the
desktop artifact command:

```dotenv
RAS_CODE_APPLE_TEAM_ID=ABC1234567
RAS_CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/ras-code.provisionprofile
# Optional: comma-separated override when Clerk's RP ID differs from the Frontend API hostname.
RAS_CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

When `RAS_CODE_CLERK_PASSKEY_RP_DOMAINS` is absent, the build derives the RP domain from
`RAS_CODE_CLERK_PUBLISHABLE_KEY`. Signed macOS builds fail early if the Team ID, provisioning profile,
or RP-domain configuration is missing. The generated main-app entitlements include every configured
`webcredentials:<domain>` entry; helper apps keep Electron's minimal default entitlements.

The normal `dev:desktop` launcher is unsigned and cannot complete macOS passkey ceremonies. For
renderer HMR, build and install a signed app first, run the renderer dev server, then launch the
installed app executable with `VITE_DEV_SERVER_URL` and `RAS_CODE_PORT` set. Rebuild the signed app
after native dependency, main-process, preload, entitlement, provisioning, or signing changes;
renderer-only changes can reuse the installed app.

For the default development ports, run `pnpm dev:web` in one terminal and launch the installed
binary from another:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
RAS_CODE_PORT=13773 \
  "/Applications/RAS Code (Alpha).app/Contents/MacOS/RAS Code (Alpha)"
```

After changing Associated Domains, bump the build version before rebuilding; macOS may otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/RAS Code (Alpha).app"
codesign -d --entitlements :- "/Applications/RAS Code (Alpha).app"
```

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to the same allowlist.

## Sign-in Surfaces

Signed-in users manage RAS Connect under **Connections**. The settings sidebar also has dedicated
controls, rendered by `SettingsSidebarNav.tsx`: `T3ConnectSidebarSignIn` in the footer shows a
**Sign in to RAS Connect** button while signed out, and `T3ConnectSidebarAvatar` shows a Clerk
`UserButton` account control while signed in. Both are gated on cloud public configuration.
Desktop renders the same web bundle, so it has them too. The waitlist enrollment flow from the
private beta was removed when Connect went GA; sign-up is open unless a Clerk restriction below is
enabled.

## Restricting Sign-ups: Known-User Allowlist

For a closed deployment where all permitted users are known in advance, restrict sign-up to
permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.
