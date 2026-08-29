<!-- markdownlint-disable MD033 MD041 -->

<div align="center">

<img src="assets/prod/logo.svg" width="96" height="96" alt="RAS Code logo">

# RAS Code

**An opinionated control surface for the coding agents on your machine.**

[![Build](https://img.shields.io/github/actions/workflow/status/richardsolomou/ras-code/ci.yml?branch=main)](https://github.com/richardsolomou/ras-code/actions/workflows/ci.yml) [![License](https://img.shields.io/github/license/richardsolomou/ras-code)](LICENSE)

</div>

## Product

RAS Code brings the best parts of [T3 Code](https://github.com/pingdotgg/t3code), [Conductor](https://conductor.build), and [PostHog Desktop](https://posthog.com) into one project. It runs the agent CLIs you already pay for — Claude Code, Codex, Cursor, Grok Build, and OpenCode — and gives you one place to direct them from a desktop app, a browser, or your phone.

You can:

- Run several agents in parallel, each in its own git worktree, and review their diffs before you merge.
- Drive the same session from the RAS Code desktop, web, or mobile app.
- Reach your machine remotely over your local network, Tailscale, or a tunnel.
- Restore any turn from its checkpoint when an agent goes wrong.

The server is event-sourced: clients send typed commands, a pure decider turns them into events, and a projector derives the state the UI renders. Provider CLIs run as subprocesses behind per-provider adapters.

## Scope

RAS Code is an independent, opinionated fork. It tracks upstream T3 Code changes selectively while shipping its own desktop, web, mobile, and hosted RAS Connect surfaces. Existing T3 Code wire contracts remain append-only for compatibility.

## Use

Install and authenticate at least one provider first:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

Build the desktop app or run the server from source (see Development). Pair a browser or the mobile app with the pairing URL the server prints on start.

User guides live in [docs/user](docs/user): [install](docs/user/install.md), [remote access](docs/user/remote-access.md), [keyboard shortcuts](docs/user/keybindings.md), [permission modes](docs/user/permission-modes.md), [source control](docs/user/source-control.md).

## Development

Development requires Node 24.x, pnpm 11.10.0, and the [Vite+](https://viteplus.dev/guide/) `vp` CLI.

```sh
vp i
vp run dev
```

`vp run dev` starts the server and web app; `vp run dev:desktop` starts the Electron shell. Run `vp check` before you submit a change. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and test details. Read [AGENTS.md](AGENTS.md) for architecture rules.

To sync with upstream:

```sh
git fetch upstream
git merge upstream/main
```

## Architecture

- `apps/server` contains the WebSocket server, orchestration, provider adapters, and checkpointing.
- `apps/web` contains the React UI; `apps/desktop` wraps it in Electron; `apps/mobile` is the React Native app.
- `packages/contracts` contains the Effect Schema wire contracts shared by every surface.
- `packages/client-runtime` contains client logic shared by web and mobile.
- `packages/shared` contains runtime utilities shared by server and clients.

See [docs/internals/overview.md](docs/internals/overview.md) for the full picture.

## Credits and license

RAS Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by Ping Labs. T3 Code and T3 are marks of Ping Labs; RAS Code is unofficial and is not endorsed by them.

RAS Code is licensed under the [MIT License](LICENSE).
