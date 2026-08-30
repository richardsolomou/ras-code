# CI quality gates

> For maintainers. Using RAS Code? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs these quality gates on pull requests
and pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  uses only imports that Electron's sandbox can load. The verifier parses imports, then executes the
  trusted artifact with controlled bridge stubs to confirm that its required APIs are callable.
- **Test**: the workspace test suites, spread over separate runners so no package waits on
  another's CPU: **Test** runs every package except `apps/web` and `apps/server`, **Test Web** runs
  the web suite in two shards, and **Test Server** runs the server suite in three shards (the server
  disables file parallelism, so sharding across runners is the only way to spread it).
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`. A cheap Linux **Mobile Native Changes** job gates it:
  the macOS runner only boots when the diff touches `apps/mobile` Swift/Kotlin sources, the
  SwiftLint/detekt/ktlint configuration, the `Brewfile`, the check script, the root `package.json`
  that defines `lint:mobile`, or `ci.yml`. Otherwise the job is skipped, which GitHub reports as
  success for the required check. Renames are matched on both their old and new path. The gate fails
  open in every other case: if the changed-file list cannot be resolved, GitHub truncates it, or the
  gate job itself fails, the lint runs.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

`.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release. It auto-enables
signing only when platform credentials are present. macOS passkey builds additionally require
`APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing.
Without the core signing credentials, it still releases unsigned artifacts.

Releases are cut from commits on `main`, so the release workflow first looks for a completed, green
CI run on the exact commit and skips its own quality job when it finds one. Otherwise (no run yet,
still running, or failed) it runs the same gates itself, split the same way as CI.

Only jobs that install the full workspace enable the `setup-vp` dependency cache. The cache is
keyed on the lockfile alone and saved by whichever job finishes first, so a filtered install
(`--filter=...`) would save a partial store that every later full install restores and then
re-downloads around. Keep `cache: false` on filtered-install jobs.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
