# Updating RAS Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after server updates** is off by default.
Enable it to resume supported active threads once the replacement server is
ready. Terminal commands may still be interrupted.

## Update a connected server

The offered action depends on how the server runs:

Updating restarts the server, so the connection will disappear briefly. **Settings** → **General**
has a **Continue threads after restarts** preference, set per environment. It is off by default.
When enabled, supported provider threads resume after an update, a crash, or a machine restart,
without needing a connected client. RAS Code has to start again on that machine; the preference does
not enable automatic startup. Providers with native promptless continuation use it; other providers
receive a short instruction to continue where they left off. Threads with no saved provider resume
state need a new message. Terminal commands and other running work may still be interrupted.

The update does not remove saved threads, settings, or project files.

## Choose the Action You See

| Action                     | What to do                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Available for the RAS Code Linux background service and for servers run by a current RAS Code desktop app. Select the button and leave RAS Code open while it downloads, installs, restarts, and reconnects. For desktop-app servers this closes and relaunches the desktop app on that machine. If installation fails, the desktop app stays open and reconnects to its server. |
| **Update the desktop app** | Shown for desktop apps that predate remote updates. Open the RAS Code desktop app on the machine that runs the server and install the app update there. Reopen it if needed.                                                                                                                                                                                                     |
| **Copy update command**    | Copy the command, open a terminal on the server machine, stop the current RAS Code server, and relaunch it with the copied command and any startup options you normally use.                                                                                                                                                                                                     |

The available action depends on how that server was started. RAS Code does not update connected
servers silently in the background.

An older background-service launcher may ask you to run the exact
`npx ras-code@<version> service update` command on the server machine. That one local update installs the
rollback support needed for later remote updates, including versions that change the database.

After selecting **Update**, the notice becomes a live status line: **Downloading…** while the new
version is fetched and verified, then **Restarting…** while the server restarts into it. The same
status appears in the conversation and in Connections, so navigating between them does not lose the
update. A failure remains visible with its error and an option to retry.

**Copy update command** gives you `npx ras-code@<client-version>`, which relaunches the server directly
at the matching version. Add whatever startup options you normally use.

If the server instead runs as the RAS Code background service, update the service on the host and
pin the same version:

```sh
npx ras-code@<client-version> service update
```

Replace `<client-version>` with the version shown in the notice. Using
`@latest` only resolves the mismatch if your client is on that release. An older
service launcher may require this local update before it supports remote updates
and rollback.

For a foreground server, the copied command is `npx ras-code@<client-version>`. Add
`serve` if you normally run without a browser, and preserve options such as
`--host` or `--tailscale-serve`. See
[background services](./background-service.md) for service management.

## Canary desktop release notes

The desktop app shows a compact release-notes preview when a canary update is available. Changes
appear newest first within each release. Each release links to its exact page on GitHub, even when
all changes fit in the preview.

The preview shows up to eight changes from each of six releases. When it leaves out changes or older
releases, it shows the exact number and links to the rest. Contributor credits do not count as
changes.

## After the Update

Keep the web or desktop app open while the server restarts. The update completes only after the
service launcher reports that exact update committed and the replacement server is ready to accept
commands. A rollback is reported immediately instead of waiting for a generic reconnect timeout.

If a step fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Mobile updates

The mobile app keeps itself current on its own. When it finds a new version, it downloads it in the
background and installs it automatically the next time you leave the app. Unsent drafts and queued
messages are saved before the restart. Only if the app stays open long enough that the update never
gets that chance does it ask whether to install right away; choosing **Later** is safe and keeps the
automatic install armed.

### Choosing an Update Track

**Settings → App → Update Track** picks which builds the app follows:

- **Stable** follows the daily release.
- **Canary** follows every change merged to main.

Switching downloads the new track, then restarts; unsent drafts and queued messages are saved first.
If the track has no build yet for the version of the app you installed, the app says so and stays
where it was. Switching back to Stable works offline once the app has run a stable build — it leaves
the canary build behind rather than waiting for a stable release to overtake it.

The setting appears only in App Store and TestFlight builds. Development and preview builds follow
the track they were built with.

For remote connection setup and access troubleshooting, see [Remote Access](./remote-access.md).
