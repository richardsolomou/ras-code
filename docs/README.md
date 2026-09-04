# RAS Code docs

## Using RAS Code

- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Working in two threads at once](./user/split-panes.md)
- [Forking threads](./user/forking-threads.md)
- [Notifications](./user/notifications.md)
- [Review usage](./user/usage.md)
- [Anonymous usage data](./user/telemetry.md)
- [Project settings](./user/project-settings.md)
- [Mobile appearance](./user/mobile-appearance.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Anonymous telemetry](./user/telemetry.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [PostHog AI Gateway](./user/providers-posthog-gateway.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on RAS Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [PostHog telemetry](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [RAS Connect](./internals/ras-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Upstream sync](./internals/upstream-sync.md)
- [Voice input](./internals/voice-input.md)
- [Workspace layout](./internals/workspace-layout.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [RAS Connect setup](./operations/connect-setup.md)
- [CI quality gates](./operations/ci.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
