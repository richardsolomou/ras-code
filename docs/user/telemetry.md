# Anonymous telemetry

RAS Code sends anonymous product and reliability telemetry to PostHog by default. Its server uses a hashed provider account identifier when one is available, or an installation-scoped anonymous identifier. It does not create a PostHog person profile.

The server telemetry covers authenticated client use, provider and server lifecycle events, prompt-free provider turn timing and token totals, low-cardinality metrics, allowlisted operational logs, and redacted exceptions.

After authentication, web and desktop clients collect normalized pageviews, structural interactions, Web Vitals, pointer coordinates for heatmaps, redacted browser exceptions, and layout-only session replays. All replay text, input values, and element attributes are masked. Network bodies, network headers, console logs, referrers, query strings, fragments, JSON-LD, and fonts are not recorded. Mobile does not load the browser SDK.

RAS Code does not send prompts, responses, repository contents, terminal output, provider error messages, abort reasons, secrets, IP address properties, local variables, source context, or absolute source paths. It does not use PostHog surveys, advertising, or person profiles.

To disable all PostHog telemetry, start the server with `RAS_CODE_TELEMETRY_ENABLED=false`. Authenticated clients receive this setting from the server and do not start browser collection. For a source deployment that sends server telemetry to a different PostHog project, configure `RAS_CODE_POSTHOG_KEY`, `RAS_CODE_POSTHOG_HOST`, and optionally `RAS_CODE_POSTHOG_LOGS_URL`.
