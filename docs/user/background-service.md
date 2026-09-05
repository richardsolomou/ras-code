# Running RAS Code in the Background

On Linux and macOS, RAS Code can run as a background service for your user, so it is ready without
keeping a terminal open.

## Manage the Service

Install it with the latest RAS Code release:

```sh
npx ras-code@latest service install
```

Check whether it is installed. On Linux this also checks whether the service is running, enabled
at startup, and allowed to keep running after logout:

```sh
npx ras-code@latest service status
```

Update or repair it:

```sh
npx ras-code@latest service update
```

The service uses the same RAS Code version as the CLI you run. To install a nightly or an exact
version, use that version of the CLI:

```sh
npx ras-code@nightly service update
npx ras-code@1.2.3 service update
```

The install and update commands refuse to replace a newer service with an older version. Setup
through RAS Connect leaves a newer service unchanged. To downgrade, select the exact older version
and pass `--allow-downgrade`:

```sh
npx ras-code@1.2.3 service update --allow-downgrade
```

Stop it and remove it from startup:

```sh
npx ras-code@latest service uninstall
```

Updating restarts RAS Code briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The service runs a small stable launcher. Exact RAS Code versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

## Platform Support

**Linux** uses a systemd user unit at `~/.config/systemd/user/ras-code.service`. The service starts
when the machine boots and keeps running after you log out (lingering is enabled during install).
Setup checks the systemd user manager and enables lingering before installing a runtime or stopping
an existing service. If that requires administrator permission, setup stops with a recovery command.

**macOS** uses a launch agent at `~/Library/LaunchAgents/com.richardsolomou.ras-code.service.plist`. It
starts when you log in, not when the Mac boots, and it stops when you log out; macOS has no
equivalent of Linux lingering for user agents. For a Mac that should stay reachable unattended,
turn on automatic login (System Settings → Users & Groups; unavailable while FileVault is on) and
keep the Mac from sleeping.

A few more macOS notes:

- Installing over SSH needs someone logged in at the Mac's screen to start the agent right away.
  Without that, the install command reports an error at the final start step, but the agent is
  fully installed and starts at the next login.
- macOS may show privacy prompts for protected folders such as Desktop, Documents, or Downloads,
  attributed to a bare `node` process, or deny access without a prompt. If agent work fails to
  read those folders, grant Full Disk Access to the node binary listed in the launch agent's
  `ProgramArguments`.
- The agent appears under System Settings → General → Login Items. If it was switched off there,
  or disabled with `launchctl disable`, macOS will not start it at login until you switch it back
  on.

**Windows** is not supported yet.

## Using It with RAS Connect

RAS Connect may offer to install the service during setup so the host stays reachable in the
background. This is only an onboarding shortcut: the service and RAS Connect are managed separately.

Signing out of RAS Connect does not remove the service. Use `ras service uninstall` when you no longer
want RAS Code to start in the background.

## Troubleshooting

Run `ras service status` on the server machine. An installed version alone does not mean the service
is running or will survive logout. Linux status reports these problems:

| Code                       | What it means                                                                    | Recovery                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `linger-disabled`          | The service stops after your last login session ends and does not start at boot. | Run `sudo loginctl enable-linger "$(id -un)"`, then retry setup as your normal user.                                                       |
| `linger-unavailable`       | RAS Code could not verify the logout setting.                                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                                         |
| `user-manager-unavailable` | RAS Code cannot reach your systemd user manager.                                 | Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if needed. |
| `service-disabled`         | The service is not enabled to start automatically.                               | Run the repair command shown by `ras service status`.                                                                                      |
| `service-stopped`          | The service is installed but is not running.                                     | Read the service log and `systemctl --user status ras-code.service`, then run the displayed repair command.                                |

For an SSH host, run the administrator command in an interactive terminal so sudo can prompt for
your password:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Run only the `loginctl` command with sudo. Running `ras-code` with sudo creates a separate installation and
Connect identity for root. If an administrator is unavailable, run `ras serve` in a terminal and
keep that session open.

The repair command shown by status uses the CLI version, or the installed service version if that
is newer. An older stable CLI therefore does not recommend downgrading a nightly installation.
Setup leaves an existing service running if the user-manager or lingering check fails.

`ras service status` prints the log path. The adjacent `server.trace.ndjson` file contains detailed
server traces. For failures after authorization, see [RAS Connect troubleshooting](./remote-access.md#ras-connect-troubleshooting).
