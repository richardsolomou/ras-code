# Release Checklist

> For maintainers. Using RAS Code? See [docs/user](../user/).

This document covers the unified release workflow for stable and canary desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push to `main` for canary releases, so every merge ships immediately
  - a daily schedule at 09:03 UTC for stable releases
  - push tag matching `v*.*.*` for a stable release on a specific version
  - manual `workflow_dispatch` for either channel
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Reads the shared production RAS Connect relay URL and Clerk client configuration before packaging clients.
- Builds four artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Canary runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and canary compares to the previous canary tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `canary*.yml`, and `*.blockmap`) in release assets.
- Publishes the CLI package (`apps/server`, npm package `ras-code`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - canary releases publish npm dist-tag `canary`
- Deploys the hosted web app to Cloudflare Workers only after a release is published:
  - stable releases deploy the `latest` hosted app channel
  - canary releases deploy the `canary` hosted app channel
- Signing is optional and auto-detected per platform from secrets.

## Required release credentials

Stable releases require these GitHub Actions secrets in addition to the platform and deployment
credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The finalize job uses them to commit and push aligned package versions to `main` as the Release App.
GitHub Release publication uses the repository-scoped workflow token so it has a rate-limit quota
independent from the shared Release App installation.

## RAS Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Stable and canary
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The
release workflow reads the relay URL and Clerk client configuration from the existing `production`
GitHub Actions environment before building desktop, CLI, or hosted web artifacts.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `ALCHEMY_STATE_STORE_CREDENTIALS` (see [Relay Database](./relay-database.md#deployment-credentials))

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_DATABASE_HOST`
- `RELAY_DATABASE_NAME`
- `RELAY_DATABASE_USER`
- `RELAY_GATEWAY_ZONE_NAME`
- `RELAY_GATEWAY_DOMAIN`
- `RELAY_ENDPOINT_NAMESPACE`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `code-relay.<RELAY_API_ZONE_NAME>` domain

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`
- `POSTHOG_PROJECT_TOKEN`
- `RELAY_DATABASE_PASSWORD`
- `RELAY_DATABASE_ACCESS_CLIENT_ID`
- `RELAY_DATABASE_ACCESS_CLIENT_SECRET`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. Postgres is self-hosted and never exposed on a public port:
cloudflared publishes it as `RELAY_DATABASE_HOST`, a Cloudflare Access application guards that
hostname, and Hyperdrive authenticates with the Access service token. The `prod` stage owns
`RELAY_DATABASE_NAME`; every other stage gets its own `<RELAY_DATABASE_NAME>-<stage>` database on the
same server. Migrations run from the deploy host over `cloudflared access tcp`, which the deploy
workflow opens before the stack runs and closes afterwards.
Production adopts the configured relay API and gateway DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

### Built-in relay cutover

The built-in relay release is a hard cutover from the previous per-environment Cloudflare Tunnel transport. Before merging, run `ras connect unlink` on each linked environment so the old relay removes its tunnel and DNS record. Replace the production environment variables `RELAY_TUNNEL_ZONE_NAME`, `RELAY_TUNNEL_GATEWAY_DOMAIN`, and `RELAY_TUNNEL_NAMESPACE` with `RELAY_GATEWAY_ZONE_NAME`, `RELAY_GATEWAY_DOMAIN`, and `RELAY_ENDPOINT_NAMESPACE`. Deployment deletes any remaining legacy links, and the release workflow waits for the production relay deployment on the same commit before publishing clients. Update each server and link it again after the relay is live. Mixed old and new relay transports are not supported.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter ras-code-relay deploy --stage "$USER" --env-file .env.local
```

## Hosted web app release deployment

The hosted app is a Cloudflare Worker serving the built SPA as static assets,
deployed by `.github/workflows/release.yml` after the GitHub Release succeeds.
The Alchemy stack lives in `infra/web`, and the deployment stage names the
release channel, so a stage typo cannot publish canary assets onto the stable
domain.

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `ALCHEMY_STATE_STORE_CREDENTIALS` (see [Relay Database](./relay-database.md#deployment-credentials))

Required GitHub Actions variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `RAS_CODE_WEB_ROUTER_URL`: set to `https://code.ras.sh` for the RAS-hosted deployment.
- `RAS_CODE_WEB_CANARY_DOMAIN`: set to `code-canary.ras.sh` for the RAS-hosted deployment.

Worker custom domains, which Alchemy attaches:

- `code.ras.sh`: the stable channel and the domain users open, served by the `latest` stage.
- `code-canary.ras.sh`: the canary channel, served by the `canary` stage. Canary
  needs its own name because the router proxies to it; stable does not, because
  the router serves stable itself.

Both channels deploy the same Worker entry, `apps/web/worker.ts`. Only the
`latest` stage receives `RAS_CODE_WEB_ROUTER_HOST` and
`RAS_CODE_WEB_CANARY_ORIGIN`, so only it routes; the canary deployment serves
its own assets unconditionally. Users opt into a channel by visiting
`/__ras-code/channel?channel=latest` or `/__ras-code/channel?channel=canary`,
which sets the `ras_code_web_channel` cookie. On the router domain the Worker
reads that cookie and proxies to the canary origin when it says `canary`;
otherwise it serves its own assets. The canary domain never routes, so a stale
cookie cannot cause a loop.

Known limitation: Cloudflare serves static assets before invoking the Worker, so
the router does not see requests whose path exactly matches a built file. Channel
switching therefore takes effect on application routes but not on `/`, which
resolves directly to `index.html`. The stack sets `runWorkerFirst` on the router
deployment, but Alchemy does not currently forward it — a deployed version
reports `raw_run_worker_first: false`.

The release deploy job rewrites release package versions before the build so the
hosted app's About panel renders the release version. It also passes
`VITE_HOSTED_APP_CHANNEL=latest|canary`, which renders the hosted update track
selector in the About panel. Changing the selector navigates through
`/__ras-code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

Deploy a channel by hand with:

```sh
vp run --filter ras-code-web-infra deploy --stage latest --yes
```

## Mobile app releases (EAS)

- Workflows: `.github/workflows/mobile-eas-preview.yml` and `mobile-eas-production.yml`
- Expo account: `richardsolomou`, project `@richardsolomou/ras-code`
- Required secret: `EXPO_TOKEN`, an access token belonging to the `ras-code-ci` robot user

`apps/mobile/app.config.ts` pins the EAS project ID and owner, and `apps/mobile/eas.json` pins
`ascAppId` for App Store submission. All three identify one specific Expo project and one App Store
Connect app record, so they change together or not at all.

iOS builds sign against the same `com.richardsolomou.ras-code` App ID the desktop app uses. EAS
enables missing capabilities on that App ID automatically, which invalidates the macOS provisioning
profile; see the Apple signing notes below.

Trader status must be recorded in App Store Connect before a new app can be submitted in the EU.
Only an Admin or the Account Holder can provide it.

### Mobile update tracks

Store builds embed the `production` EAS Update channel, and the app overrides its own channel request
header at runtime (Settings → Update Track), so one binary serves both tracks:

- `canary`: `mobile-eas-production.yml` publishes on every merge to main that touches the mobile app.
- `production`: `release.yml` calls `mobile-eas-production.yml` with `mode=release` after a stable
  release publishes, so mobile stable follows full releases like the desktop app does.

Store builds are still cut from main, so a fresh binary embeds newer JavaScript than the production
channel holds. expo-updates launches the newest update it has, so those users stay on the embedded
bundle until the next stable release publishes an OTA that overtakes it — no downgrade, just a quiet
window where stable OTAs are no-ops.

Both publishes are fingerprint-gated against finished `production`-profile builds, because both
channels are served to the same binaries. `mobile-eas-production.yml` creates the channel on first
publish if it does not exist yet; to create it by hand, run `eas channel:create canary` from
`apps/mobile`.

`inputs.mode` discriminates the trigger inside `mobile-eas-production.yml`, not `github.event_name`:
under `workflow_call` the event name is the caller's, so a stable tag release would otherwise be
mistaken for a push to main.

## Canary builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push to `main`, so a merge ships as a canary release immediately
  - manual `workflow_dispatch` with `channel=canary`
- Runs the same desktop quality gates and artifact matrix as the stable flow.
- Collapses through the queue rather than by canceling: at most one run stays
  pending, and a newer merge replaces the one waiting. A burst ships the release
  in flight plus the newest commit, not one release per commit. Nothing is
  canceled mid-release, because npm and the GitHub release publish before the
  hosted web deploy and the AUR package, so a cancel between them would leave a
  version installable that never shipped to those two.
- Skips the release the finalize job pushes back to `main`, so a stable version
  bump does not immediately cut a canary of itself.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-canary.YYYYMMDD.<run_number>`
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the canary base. For example, `0.0.17` produces canaries on `0.0.18-canary.*` — the version the next daily stable release will carry.
- Publishes Electron auto-update metadata to the dedicated `canary` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `ras-code`) to the `canary` npm dist-tag using the same canary version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `ras-code@<version>` package available on
npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact stable or canary version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view ras-code@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx ras-code@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `RAS_CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `canary*.yml` for canary releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `canary-mac.yml` on canary, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship a
Linux-only `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar. WSL verifies
and extracts that archive into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside
the selected distro, then reuses it for later launches of the same update. The
Windows-side `wsl-server-tree/<version>` extraction remains a fallback and is
removed after the distro-local runtime passes preflight.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build with a WSL node-pty prebuild omits the WSL archive or SHA-256
  sidecar, the sidecar digest does not match the emitted archive, or required
  Linux runtime members are absent.
- The emitted WSL archive contains Windows/Darwin node-pty payloads, ConPTY,
  pnpm install metadata, or Windows-only FFF, ffi-rs, or msgpackr bindings.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow invokes `node apps/server/scripts/cli.ts publish` after aligning package versions. That
script temporarily prepares the `ras-code` package, then runs `vp pm publish --filter ras-code ...` from the
repository root so workspace publish configuration is applied correctly.

Checklist:

1. Confirm npm org/user owns package `ras-code` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. The daily stable release, or a pushed `vX.Y.Z` tag, will:
   - align the release package versions to `X.Y.Z`
   - build web + server
   - invoke the CLI publish script with npm dist-tag `latest`
5. Canary runs invoke the same publish script with npm dist-tag `canary`.

## 1) Release validation and unsigned builds

There is no dry-run path, and no branch to experiment on: a merge to `main` is a
real canary release. Pushing any accepted non-canary tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `ras-code` with npm dist-tag
`latest`, creates a real GitHub Release, publishes the hosted app to `code.ras.sh`,
and can commit a version bump to `main` in the finalize job. Do not push a test tag
to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=canary`; this still publishes a real canary npm package, GitHub
prerelease, desktop updater release, and hosted canary alias, but it does not update stable aliases or
commit a version bump to `main`. Only run it when a real canary release is acceptable.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from the production Clerk publishable key.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.richardsolomou.ras-code` and enable every capability both the
   desktop and the iOS app need: Associated Domains, Push Notifications, App Groups (assigned to
   `group.com.richardsolomou.ras-code`), and Sign in with Apple. The iOS app shares this bundle ID,
   so enabling them all up front avoids a later capability change.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [RAS Connect Clerk Setup](../internals/ras-connect.md#desktop-passkeys).
11. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.
- Adding or removing an App ID capability marks every provisioning profile for that App ID
  `Invalid`. Regenerate the profile and refresh `MACOS_PROVISIONING_PROFILE` whenever the App ID
  changes, including when an EAS build changes it.
- The App Store Connect key needs only the Developer role to notarize. Editing capabilities,
  profiles, or certificates through the API needs Admin, so the portal is the simpler path for those
  one-off changes.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## Tagging a stable release

```sh
git fetch origin main
git tag -f -a vX.Y.Z origin/main -m "RAS Code X.Y.Z"
test "$(git rev-list -n1 vX.Y.Z)" = "$(git rev-parse origin/main)" || echo "refusing: tag is not origin/main"
git push origin refs/tags/vX.Y.Z
```

The `-f` and the check are both load-bearing. Syncing with upstream adds the `t3code` remote, which brings hundreds of upstream tags into the clone, so most plausible version names already exist locally. A plain `git tag vX.Y.Z` then fails with "already exists" while a separate push still succeeds — shipping upstream's tag, pointing at an upstream commit, and starting a release build from code that is not ours.

If that happens, delete the tag from the remote and cancel the run before it builds:

```sh
git push origin :refs/tags/vX.Y.Z
gh run cancel <run-id>
```

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - release quality checks pass (or are skipped because CI is already green on the tagged commit)
   - all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.richardsolomou.ras-code` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
