# PostHog telemetry

RAS Code sends anonymous telemetry to PostHog. The server uses the first available hashed Codex account ID, hashed Claude user ID, or installation-scoped anonymous ID as the distinct ID. Authenticated web and desktop clients load the browser SDK only after the server confirms that telemetry is enabled. `RAS_CODE_TELEMETRY_ENABLED=false` disables every telemetry product in this document.

## Products

| Product           | What RAS Code sends                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product analytics | Server, provider, authenticated client, normalized pageview, and structural autocapture events.                                                                          |
| Web analytics     | Normalized authenticated pageviews and privacy-safe web performance events from web and desktop clients.                                                                 |
| Session replay    | Authenticated web and desktop sessions with all text, inputs, element attributes, network data, console output, and fonts excluded or masked.                            |
| Heatmaps          | Click and pointer coordinates grouped under normalized synthetic routes.                                                                                                 |
| Feature flags     | Server-side evaluation of the `ras-code-ai-observability` kill switch every five minutes.                                                                                |
| Error tracking    | Unhandled server and browser exceptions plus generic provider failure exceptions. Messages, source context, local paths, and local variables are removed before capture. |
| LLM analytics     | One prompt-free `$ai_generation` event for every completed, failed, cancelled, or aborted provider turn.                                                                 |
| Logs              | Allowlisted provider completion, abort, and failure records over OTLP. Arbitrary application logs are not exported.                                                      |
| Metrics           | Provider turn count, duration, token count, and reported cost with low-cardinality provider, state, and direction attributes.                                            |
| Traces            | Existing RAS Connect and mobile OTLP traces. Their setup remains separate from server telemetry.                                                                         |

The browser SDK does not load on pairing, connection, or other unauthenticated screens. It uses normalized synthetic URLs, disables GeoIP enrichment and person profiles, and does not record repository or conversation content. Surveys and console-log capture remain disabled.

Browser requests use `/t` through the Vite proxy in development and `https://t.ras.sh` in production. The short development path avoids common analytics-blocking rules while preserving a single browser origin. Server telemetry also uses `https://t.ras.sh` by default and can be redirected for source deployments.

## Configuration

| Variable                                 | Default                       | Meaning                                                                                                              |
| ---------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `RAS_CODE_TELEMETRY_ENABLED`             | `true`                        | Enables all server-side PostHog telemetry. Set it to `false` for a complete opt-out.                                 |
| `RAS_CODE_POSTHOG_KEY`                   | Official public project token | Selects the PostHog project. The token is ingest-only and is not a secret.                                           |
| `RAS_CODE_POSTHOG_HOST`                  | `https://t.ras.sh`            | Selects the server telemetry proxy or self-hosted origin. The official browser client always uses the managed proxy. |
| `RAS_CODE_POSTHOG_LOGS_URL`              | `<host>/i/v1/logs`            | Overrides the OTLP/HTTP logs endpoint.                                                                               |
| `RAS_CODE_TELEMETRY_FLUSH_BATCH_SIZE`    | `20`                          | Sets the PostHog event flush threshold.                                                                              |
| `RAS_CODE_TELEMETRY_MAX_BUFFERED_EVENTS` | `1000`                        | Bounds the PostHog event queue and provider-turn telemetry state.                                                    |

Create a boolean feature flag with the key `ras-code-ai-observability` and enable it for 100% of users. Setting it to `false` stops new `$ai_generation` events without changing product events, logs, metrics, or error tracking. A missing flag or failed evaluation leaves AI observability enabled so a PostHog outage cannot change provider behavior. Generation events carry the exact evaluated flag value.

Enable Session Replay in the PostHog project before release. The client respects the project-side replay switch and sampling configuration, then applies the masking rules below. Heatmap capture is enabled in the client and does not depend on the project-side heatmap switch.

## AI generation events

`$ai_generation` contains the provider, model, terminal state, latency, reported cost, and available input, cache-read, and output token counts. The trace ID is the opaque turn ID, and the session ID is the opaque thread ID. RAS Code never adds `$ai_input` or `$ai_output_choices`; it also ignores provider error messages and abort reasons.

The PostHog SDK captures uncaught exceptions and unhandled rejections. A `before_send` hook replaces exception messages with `Redacted exception`, removes source context and variables, and reduces source paths to their final filename while retaining frame locations for grouping.

Browser error capture uses the same rules. Browser builds retain source maps locally, but release automation must inject and upload them with the PostHog CLI before stack traces can be resolved in PostHog. Uploading requires a personal API key and is not part of the public runtime configuration.

## Browser collection

Authenticated web and desktop clients collect one pageview per normalized route, tag name and structural position for autocaptured interactions, Web Vitals without attribution, pointer coordinates for heatmaps, and a layout-only session replay. Dynamic route segments become `:id`, query strings and fragments are removed, and URLs use the synthetic `app.ras-code.local` host.

All replay text, input values, and element attributes are masked. Network bodies, network headers, console logs, JSON-LD, and fonts are not recorded. The event sanitizer independently removes referrers, element text and attributes, exception messages, source context, and absolute paths before sending data. Mobile does not load the browser SDK; its existing OTLP traces and server-side authenticated client events remain available.

## Client events

These events use the metadata from the WebSocket connection that caused them.
The metadata is not a person property or server-global current-client value.
Two clients connected to one server can report different values at the same
time.

| Event                   | Description                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.connected`      | The server accepted an authenticated WebSocket connection. Reconnects count again. Use this event for connection diagnostics, not active-use counts. |
| `client.thread.started` | The server accepted a command that created a thread.                                                                                                 |
| `client.turn.requested` | The server accepted a turn request. This is the standard active-use event.                                                                           |

`provider.turn.sent` stays a provider execution event. It does not receive
client metadata because a provider turn can continue after the requesting
client disconnects.

## Recommended properties

Client properties appear on the three client events when the connected client
reports them. Older clients can omit every client property.

| Property               | Values and meaning                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`              | Product client: `web`, `desktop`, or `mobile`.                                                                                                                                                  |
| `webDeployment`        | Web delivery: `hosted` for the hosted app or `server` for web files served by a RAS Code server. Web only. This does not describe connection distance.                                          |
| `clientOs`             | `macOS`, `Windows`, `Linux`, `iOS`, `Android`, `ChromeOS`, `other`, or `unknown`.                                                                                                               |
| `clientDeviceType`     | `desktop`, `phone`, `tablet`, or `unknown`. This is separate from `surface`.                                                                                                                    |
| `clientBrowser`        | Normalized browser family. Web only. Browser detection is best effort.                                                                                                                          |
| `clientAppVersion`     | Version of the connected client.                                                                                                                                                                |
| `clientOsMajorVersion` | Client OS major version when the native client reports it. Initially mobile only.                                                                                                               |
| `clientDeviceModel`    | Hardware model when the native client reports it. Initially mobile only. This is not a user-assigned device name.                                                                               |
| `connectionMethod`     | `direct`, `ssh`, `relay`, or `unknown`. `direct` means that the client connected to the server endpoint without an SSH or relay connection. It does not mean both processes run on one machine. |

Server properties appear on all events, including server boot and background
events.

| Property           | Values and meaning                                             |
| ------------------ | -------------------------------------------------------------- |
| `serverOs`         | Server process OS, normalized to the same names as `clientOs`. |
| `serverArch`       | Server process architecture.                                   |
| `serverWslDistro`  | WSL distribution from `WSL_DISTRO_NAME`, when present.         |
| `serverAppVersion` | RAS Code server version.                                       |
| `serverMode`       | Server runtime mode: `desktop` or `web`.                       |

## Legacy properties

Existing property meanings do not change:

- `clientType` describes how the server runs. It is `desktop-app` for a desktop
  server and `cli-web-client` for a CLI web server. It does not describe the
  connected client. Use `surface` and `webDeployment` for new reports.
- `platform`, `arch`, `wsl`, and `rasCodeCodeVersion` describe the server. Use the
  new `server*` names for new reports.
- `appVersion` describes the connected client. Use `clientAppVersion` for new
  reports.
- Mobile connection events keep `os`, `osMajorVersion`, and `deviceModel`.
  Use the new `client*` names for new reports.

## PostHog dashboard

Create one saved dashboard named `Client and platform usage`. Set
`client.turn.requested` as the event for active-use reports. A user can appear
in several client groups during one period, so do not add breakdown values to
calculate a total.

Save these insights:

| Insight                         | Configuration                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active users, daily             | Trends, `client.turn.requested`, unique users, daily interval.                                                                                                                                                                                                                          |
| Active users, weekly            | Trends, `client.turn.requested`, unique users, weekly interval.                                                                                                                                                                                                                         |
| Active users, monthly           | Trends, `client.turn.requested`, unique users, monthly interval.                                                                                                                                                                                                                        |
| Client usage                    | Trends, `client.turn.requested`, unique users. Save four filtered series: `surface = desktop`, `surface = mobile`, `surface = web` and `webDeployment = hosted`, and `surface = web` and `webDeployment = server`. Name them Desktop, Native mobile, Hosted web, and Server-served web. |
| Client OS, active users         | Trends, `client.turn.requested`, unique users, breakdown by `clientOs`.                                                                                                                                                                                                                 |
| Client OS, turns                | Trends, `client.turn.requested`, total events, breakdown by `clientOs`.                                                                                                                                                                                                                 |
| Client versus server OS         | Table, `client.turn.requested`, breakdown by `clientOs` and `serverOs`.                                                                                                                                                                                                                 |
| Connection method, active users | Trends, `client.turn.requested`, unique users, breakdown by `connectionMethod`.                                                                                                                                                                                                         |
| Connection method, turns        | Trends, `client.turn.requested`, total events, breakdown by `connectionMethod`.                                                                                                                                                                                                         |
| Mobile devices                  | Table, `client.turn.requested`, filter `surface = mobile`, breakdown by `clientOs`, `clientOsMajorVersion`, and `clientDeviceType`.                                                                                                                                                     |
| Client version adoption         | Trends, `client.turn.requested`, unique users, breakdown by `clientAppVersion`.                                                                                                                                                                                                         |
| Server version adoption         | Trends, `client.turn.requested`, unique users, breakdown by `serverAppVersion`.                                                                                                                                                                                                         |
| Missing metadata                | Table or SQL insight that shows the percentage of `client.turn.requested` events where each of `surface`, `clientOs`, `clientDeviceType`, `clientAppVersion`, and `connectionMethod` is absent. Track `webDeployment` and `clientBrowser` only within `surface = web`.                  |

In PostHog Data management, use the event and property descriptions from this
document. Mark the recommended properties as verified. Keep `clientType`
visible with its legacy description so old reports remain understandable.

## Collection and release boundary

Client values are best effort. Invalid values are ignored and never reject a
connection. Browser clients use user-agent data for broad OS, browser, phone,
and tablet groups. They do not infer CPU architecture or an exact OS version
from `navigator.platform`.

This telemetry does not collect raw URLs, secrets, prompts, responses, provider error text, abort reasons, IP address properties, source context, local variables, absolute source paths, or user-assigned device names. It measures authenticated product use and aggregate provider runtime behavior. It does not measure a person who visits the hosted app without connecting to a server.

The new fields start with the first client and server release that contains
this metadata path. Historical events cannot reliably identify the client OS,
hosted web use, device type, or connection method when the old client did not
send those fields. Reports must treat missing values as pre-release or older
client data instead of backfilling them from server fields.
