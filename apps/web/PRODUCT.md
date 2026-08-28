# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run coding agents (Claude Code, Codex, Cursor, Grok, OpenCode) for hours a day and want one place to direct several of them at once — on a desktop app, in a browser, or from a phone. Primary user today is Richard (the maintainer); the product is public open source and must read as a credible tool to anyone who installs it.

## Product Purpose

RAS Code is an opinionated control surface for the coding agents on your machine: start threads per project, run agents in parallel worktrees, review diffs, approve actions, and reach your machine remotely. It fuses what its author likes about T3 Code (the open, remote-ready core it forks), Conductor (spacious, parallel-agent workflow), and PostHog Desktop (usage-based model access) into one project. Success: an agent-driving developer notices nothing dropped, lying, or stale, and prefers it over the harnesses' own UIs.

## Positioning

Provider-agnostic and harness-agnostic: subscriptions first, with automatic fallback to a self-owned gateway when a limit is hit, and a gateway provider that routes each model to the right harness without the user choosing. Bring-your-own-subscription, open at the core, remote by design.

## Operating Context

Long-running sessions in a dark room with many threads visible at once; high-refresh displays where repaint and dropped frames are noticed; frequent glances at sidebar state (working, waiting, failed); notifications when a thread needs the user. Three surfaces share one design language: web (also served locally), Electron desktop, and React Native mobile.

## Capabilities and Constraints

Event-sourced server; typed WebSocket contracts that must stay compatible with the official T3 Code iOS app; provider adapters per harness; per-project and global default models; provider fallback bindings; local notifications; project icons (file or emoji). Layout and flows are inherited from T3 Code and stay as they are in this pass; visual language may change freely. Performance is a hard constraint: no continuously repainting animation, GPU-cheap effects only.

## Brand Commitments

Name: RAS Code (short id `ras-code`). Contact domain ras.sh. Standalone identity — deliberately not a sibling of the author's other projects (stl.quest, praetorium.gg) and not a PostHog derivative, though PostHog AI Gateway appears as a provider with PostHog's own logo. Current mark (a stroked R monogram with a cursor block) is provisional and replaceable.

## Evidence on Hand

Working product with real data (13 projects) at `~/.ras-code/dev`; brand asset pipeline at `assets/` (Icon Composer projects for dev/nightly/prod, generated icon sets); provider icons in `apps/web/src/components/Icons.tsx`; palette tokens in `apps/web/src/index.css` (dark default: canvas #202020, sidebar #1a1a1a). No testimonials, user counts, or press — none may be invented.

## Product Principles

- Nothing dropped, nothing lying: every status the UI shows is live and true.
- Calm density: many threads legible at a glance without noise.
- Agnostic by default: no harness or vendor gets visual precedence over another.
- Open at the core: what ships is what is in the repo.
- Performance is part of correctness.
