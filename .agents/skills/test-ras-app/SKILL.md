---
name: test-ras-app
description: Launch, retain, and test the RAS Code web app in isolated development environments, including first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, cross-turn dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run RAS Code locally, iteratively test UI behavior with a human, recover from an expired or consumed pairing token, isolate dev state, or prepare test data in state.sqlite.
---

# Test RAS App

Use this skill for the web client. For iOS Simulator, Android Emulator, or physical-device testing against an isolated RAS Code backend, use the sibling [`test-ras-mobile`](../test-ras-mobile/SKILL.md) skill.

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.ras-code` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/ras-code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `vp run dev`. Add `--share` when the user needs to open it from another tailnet device. In a linked worktree it defaults to that worktree's gitignored `.ras-code`; pass `--home-dir <base-dir>` only when the test needs a different isolated directory.
4. Keep the terminal session alive. Redirect its output to a log file and read back only the lines you need; never stream the dev log into the transcript or print the whole file. It writes about 500 bytes before it is ready, then roughly 2.5 KB per idle minute of Vite chatter, so every re-read of the whole file costs more than the last.

   ```bash
   vp run dev > /tmp/ras-dev.log 2>&1 &
   until grep -q '/pair#token=' /tmp/ras-dev.log; do sleep 2; done
   grep -E '\[dev-runner\]|Local: |pairingUrl:' /tmp/ras-dev.log
   ```

   Those three lines carry the base directory and server port, the web origin, and the pairing URL. Keep the process id from `$!` so you can stop exactly the process you started.

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.ras-code` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The worktree-local default deliberately outranks an ambient `RAS_CODE_HOME`; do not pass the shared home through to a worktree dev server.

Ports are derived from the worktree path but can shift when occupied. Always read the actual values from the `[dev-runner]` line.

Shared browser dev is single-origin: Vite proxies the backend paths, so never set `VITE_HTTP_URL` or `VITE_WS_URL` for `dev`/`dev:web`.

The dev runner disables browser auto-open by default. Do not pass `--browser` during automated testing: an automatically opened page can consume the one-time bootstrap token before the controlled browser uses it.

### Verify a shared environment before human handoff

When another person will use the printed pairing URL, first open the shared origin without the pairing path or fragment in the controlled browser and confirm the RAS Code app loads. This browser navigation is required even when curl succeeds because browsers block some otherwise reachable ports before making a network request.

Do not open the other person's complete pairing URL during this reachability check; doing so consumes its one-time token. If the agent also needs an authenticated browser, create and consume a separate pairing token, then leave a fresh token for the other person.

## Keep the verification loop cheap

`preview_snapshot` is by far the most expensive call in this skill: one call returns a PNG screenshot, the full semantic element list, diagnostics, and action history. Its sibling tools each say "use snapshot first to inspect the page", which turns a ten-step flow into ten snapshots and dominates the cost of a session. Do not carry that habit into this skill.

Budget one snapshot when you first reach a screen you have not seen, and one at the end as visual evidence. Drive and check everything in between with calls that return only what you asked for:

| To do this               | Use                                                                        | Not                                |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------- |
| Wait for a state         | `preview_wait_for` with `locator`, `text`, or `urlIncludes`                | a snapshot poll                    |
| Assert a value           | `preview_evaluate` returning only the fields under test                    | reading it out of a snapshot       |
| Find a locator           | `preview_evaluate` over `document.querySelectorAll`                        | scanning the semantic element list |
| Confirm the page moved   | `preview_status`                                                           | a snapshot                         |
| Capture motion or timing | `preview_recording_start` and `preview_recording_stop`, which write a file | a burst of snapshots               |

Return the smallest projection that answers the question. `(() => ({ open: !!document.querySelector("[data-chat-composer-top-drawer]") }))()` costs a few tokens; reading the same fact out of a snapshot costs thousands.

`preview_snapshot` needs a visible preview surface. It fails outright in a background-only session — one opened with `open: false`, or any session with no preview attached. Treat the failure as a signal to assert with `preview_evaluate`, not as something to retry.

## Preserve the environment while iterating

Treat the overall testing or implementation loop—not an assistant turn or one verification pass—as the environment lifecycle boundary.

- Keep the dev process, base directory, selected ports, authenticated browser tab, registered projects, and seeded fixtures alive while the user may inspect the result or request follow-up changes.
- Do not stop the server merely because one verification pass completed or because you are yielding a response to the user.
- Before starting another environment, check whether the existing process and browser tab still serve the task. Reuse them when healthy instead of discarding useful state.
- On a later turn, verify that the existing process is alive and reuse its printed ports and base directory. If it exited, restart with the same base directory; create a new pairing token only when the browser session is no longer valid.
- Tell the user when a test environment remains available, including its non-secret web URL when useful. Include a pairing token only when the user still needs to pair (see below).

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Keep pairing URLs out of screenshots, committed files, and durable logs. When the user asked for a shared environment, the deliverable IS the full pairing URL — paste it in your reply, token and all; a bare origin is useless to them. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it, so never open a URL you handed to the user.

## Recover a consumed or expired pairing token

Run `node apps/server/src/bin.ts pair` from the repository root. It discovers the running dev server (worktree `.ras-code` first, same precedence as the dev runner) and prints a fresh `Pair URL` against the server's current web origin, including a `--share` tailnet origin. Pass `--base-dir <base-dir>` only when the server was started with `--home-dir`, using the identical path.

Tokens from `pair` carry standard client scopes. The startup pairing URL carries admin scopes; if the user needs Settings → Connections management (`access:write`), restart the server and hand over the new startup URL instead.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/ras-sqlite-state.ts query` for schema discovery and read-only checks.
- Stop the dev server before using `node apps/server/scripts/ras-sqlite-state.ts exec`, then restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when testing business behavior or projection correctness.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

The helper refuses to write to the shared `~/.ras-code` directory by default and creates a database backup before each mutation.

## Tear down only when the testing loop is finished

Tear down when the user explicitly asks, confirms the iteration is finished, or the overall task is genuinely complete with no pending human review. Do not infer completion from the end of an assistant turn.

When teardown is appropriate:

1. Stop the dev process with its terminal interrupt.
2. Preserve the isolated base directory when it contains useful reproduction evidence or state for a likely follow-up.
3. Otherwise remove only a path created for this test after resolving and verifying the exact target.

If completion is uncertain, keep the environment alive and mention that it is retained for further iteration. A fresh isolated base directory remains the safest reset when authentication, migrations, or fixture state becomes ambiguous.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- If the pairing URL is no longer visible, create a replacement token with both `--dev-url` and `--base-url`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If the UI shows unexpected data, verify that every command uses the identical explicit base directory before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
