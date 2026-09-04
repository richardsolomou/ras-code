<!-- markdownlint-disable MD013 -->

# Telemetry

RAS Code sends anonymous product and reliability telemetry to PostHog by default. Its server uses a hashed provider account identifier when one is available, or an installation-scoped anonymous identifier. It does not create a PostHog person profile.

The server telemetry covers authenticated client use, provider and server lifecycle events, prompt-free provider turn timing and token totals, low-cardinality metrics, allowlisted operational logs, and redacted exceptions.

After authentication, web and desktop clients collect normalized pageviews, structural interactions, Web Vitals, pointer coordinates for heatmaps, redacted browser exceptions, and layout-only session replays. All replay text, input values, and element attributes are masked. Network bodies, network headers, console logs, referrers, query strings, fragments, JSON-LD, and fonts are not recorded. Mobile does not load the browser SDK.

Official mobile builds use a separate React Native SDK. It records stable screen names, masked session replay, and uncaught JavaScript errors. Text, images, and system views are masked before replay uploads. Console, network, touch, and lifecycle capture are disabled. If you sign in to RAS Connect, mobile analytics uses your account identifier. Source builds do not start the mobile SDK unless both `EXPO_PUBLIC_POSTHOG_API_KEY` and `EXPO_PUBLIC_POSTHOG_HOST` are set.

RAS Code does not send prompts, responses, repository contents, terminal output, provider error messages, abort reasons, secrets, IP address properties, local variables, source context, or absolute source paths. Token totals cover the main agent only and can be complete, partial, or unavailable, depending on what the provider reports. It does not use PostHog surveys, advertising, or person profiles.

To disable server, web, and desktop PostHog telemetry, start the server with `RAS_CODE_TELEMETRY_ENABLED=false`. Authenticated clients receive this setting from the server and do not start browser collection. Source mobile builds disable their separate SDK when either `EXPO_PUBLIC_POSTHOG_API_KEY` or `EXPO_PUBLIC_POSTHOG_HOST` is unset. For a source deployment that sends server telemetry to a different PostHog project, configure `RAS_CODE_POSTHOG_KEY`, `RAS_CODE_POSTHOG_HOST`, and optionally `RAS_CODE_POSTHOG_LOGS_URL`.
