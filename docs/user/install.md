# Install RAS Code

RAS Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

Command-line use, SSH hosts, and WSL backends need Node.js 22.16+ (22.x), 23.11+
(23.x), or 24.10 and later. The native desktop app includes its server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch RAS Code and configure providers afterwards.

## Run without installing

```bash
npx ras-code@latest
```

This starts the server and opens the local web app. Run
`npx ras-code@latest --help` for command-line options.

### Linux

RAS Code ships the terminal binary for `linux-x64` and `linux-arm64`, so a Linux install needs no
compiler and no build step.

Versions up to 0.0.37 did not. On those, npm 12 blocked the build script that produced it and the
server exited at startup saying it could not load `node-pty`. If you are on one of them, upgrading
is the fix. To recover a machine that cannot start well enough to upgrade itself:

```bash
cd ~/.ras-code/runtime/versions/<version>/node_modules/node-pty && node-gyp rebuild
```

If the web or desktop app shows "RAS Code could not load", check your connection and select
**Reload** to try again.

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                               |
| ------------------ | ------------------------------------- |
| Windows            | `winget install RasCodeTools.RasCode` |
| macOS              | `brew install --cask ras-code`        |
| Arch Linux         | `yay -S ras-code-bin`                 |
| Arch Linux nightly | `yay -S ras-code-nightly-bin`         |

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. RAS Code installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx ras-code app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx ras-code app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

The command adds the directory as a project when needed, focuses the desktop app, and opens a new
thread. It does not launch the desktop app, open a browser, or start a RAS Code server. A background
server does not count as the desktop app. The command also rejects SSH sessions because a remote
shell cannot focus a local desktop window. The CLI package and the running desktop app must both
include `ras-code app` support.

## Mobile app

Install RAS Code from the
[App Store](https://apps.apple.com/us/app/ras-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.richardsolomou.ras-code).

The phone connects to a server on another machine; it does not run agents itself. Follow
[remote access](./remote-access.md) to link it through RAS Connect or a pairing URL.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/richardsolomou/ras-code/releases), or install from a package
registry.

Arch Linux:

Stable:

```bash
yay -S ras-code-bin
```

Canary:

```bash
yay -S ras-code-canary-bin
```

### Windows Subsystem for Linux runtime

When the desktop app runs a WSL backend, it installs the matching server runtime into
`~/.ras-code/wsl-runtime` inside the selected distro. The first launch after installing or updating RAS Code
may take a little longer while that release's runtime is extracted. Later launches reuse the
Linux-local copy so startup does not depend on reading application files through `/mnt/c`. After a
successful launch, RAS Code keeps the current runtime and one previous runtime for rollback and
removes older caches automatically. If a cached runtime stops working, RAS Code launches from the
application files under `/mnt/c` instead and reinstalls the runtime on the next launch.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | CLI                                                                                                        | Default binary      | Log in with                         |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------- |
| Codex       | [Codex CLI](https://developers.openai.com/codex/cli)                                                       | `codex`             | `codex login`                       |
| Claude      | [Claude Code](https://claude.com/product/claude-code)                                                      | `claude`            | `claude auth login`                 |
| Cursor      | [Cursor CLI](https://cursor.com/cli)                                                                       | `cursor-agent`      | `agent login`                       |
| Grok Build  | [Grok Build CLI](https://x.ai/cli)                                                                         | `grok`              | `grok login`                        |
| OpenCode    | [OpenCode](https://opencode.ai)                                                                            | `opencode`          | `opencode auth login`               |
| Antigravity | [Official ACP agent](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) | Managed by RAS Code | **Sign in with Google** in RAS Code |

Provider CLIs must be on the server's `PATH`. If RAS Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, RAS Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating RAS Code](./updating.md): update the app and connected servers.
