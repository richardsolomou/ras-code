---
name: RAS Code
description: A flight-control console for coding agents — lamps for state, legends for labels, one amber action.
colors:
  enamel-canvas: "#16141c"
  enamel-desk: "#100f15"
  enamel-raised: "#1f1c26"
  enamel-popover: "#1c1a24"
  enamel-hover: "#2a2733"
  enamel-rule: "#332f3d"
  legend-ink: "#e6e2ee"
  legend-muted: "#9b96a9"
  lamp-unlit: "#3a3646"
  lamp-amber: "#f0c24b"
  lamp-green: "#52c46f"
  lamp-red: "#e5645a"
  info-blue: "#8fb8e8"
  light-plate: "#ffffff"
  light-primary: "#2a2733"
  light-green: "#2f8f4a"
typography:
  body:
    fontFamily: "Barlow, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
  legend:
    fontFamily: "'Barlow Semi Condensed', Barlow, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
rounded:
  lamp: "2px"
  control: "0.625rem"
  transport: "8px"
  panel: "0.75rem"
spacing:
  sidebar-inset: "0.75rem"
  sidebar-gap: "0.625rem"
  row-inset: "0.75rem"
  row-height: "36px"
components:
  button-transport:
    backgroundColor: "{colors.lamp-amber}"
    textColor: "{colors.enamel-desk}"
    rounded: "{rounded.transport}"
    height: "36px"
    width: "36px"
  selector-cap:
    backgroundColor: "{colors.enamel-raised}"
    textColor: "{colors.legend-ink}"
    typography: "{typography.legend}"
    rounded: "{rounded.control}"
    padding: "0 0.625rem"
  sidebar-row:
    backgroundColor: "{colors.enamel-desk}"
    textColor: "{colors.legend-ink}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
    height: "{spacing.row-height}"
  sidebar-row-selected:
    backgroundColor: "{colors.enamel-hover}"
    textColor: "{colors.legend-ink}"
    rounded: "{rounded.control}"
  status-lamp:
    backgroundColor: "{colors.lamp-unlit}"
    rounded: "{rounded.lamp}"
    size: "10px"
---

# Design System: RAS Code

## Overview

**Creative North Star: "Mission Control Console"**

RAS Code is the room where many agents run at once. The interface borrows the discipline of an Apollo-era flight-control console: enamel panels, engraved legends, and square indicator lamps that tell you a station's state from across the room. Colour is not decoration — it is state. Everything that is not state sits in near-black violet enamel so that the few lit lamps and the one amber action carry the eye.

The system is dense but calm. Threads are stations; projects are engraved section legends; the composer is the station's control block. The rejected defaults are explicit: no near-black-plus-neon-glow developer-tool look, no glass or blur panels, no cream-paper opposite, and no teal or emerald greens anywhere.

**Key Characteristics:**

- Near-black violet enamel ground with tonal layering, no shadows for depth.
- State is a lamp _and_ a mark: colour plus glyph, so status survives colour-blindness.
- One amber element per view: the primary action, or a waiting lamp.
- Two type voices: Barlow for reading, Barlow Semi Condensed in tracked caps for legends.
- Performance is part of the look: the only motion is a slow opacity pulse on a working lamp.

## Colors

Near-black violet enamel carries the surface; lamps and the single action carry the colour.

### Primary

- **Lamp Amber** (#f0c24b): the transport (send) button, the waiting lamp, the active model-picker rail. Never used for text on the enamel and never for more than one non-lamp element in a view.

### Secondary

- **Signal Green** (#52c46f): the working lamp, success states, switch "on", diff additions. Plain green — never teal or emerald.
- **Failure Red** (#e5645a): the failed lamp and error text.

### Neutral

- **Enamel Canvas** (#16141c): the main pane.
- **Enamel Desk** (#100f15): the sidebar and other chrome one step behind the canvas.
- **Enamel Raised** (#1f1c26): cards, the composer, selector caps.
- **Enamel Popover** (#1c1a24): menus and popovers.
- **Enamel Hover** (#2a2733): hovered and selected rows; also the light-mode primary button.
- **Enamel Rule** (#332f3d): 1px dividers and control rims.
- **Legend Ink** (#e6e2ee): body text.
- **Legend Muted** (#9b96a9): secondary text and legends.
- **Unlit Lamp** (#3a3646): an idle station; also the scrollbar thumb.
- **Info Blue** (#8fb8e8): informational text only (never fills).

### Named Rules

**The One Amber Rule.** Exactly one amber element per view outside the lamps: the primary action. A second amber control means one of them is wrong.
**The Lamp-and-Mark Rule.** Every state colour is paired with its glyph (◌ working, ⚑ waiting, ✕ failed, ✓ settled). Colour alone never carries state.
**The Violet Neutral Rule.** Every grey in the system is violet-tinted (#2a2733 / #3a3646 family). Green-tinted or blue-tinted greys are defects.

## Typography

**Body Font:** Barlow (with the system sans stack)
**Legend Font:** Barlow Semi Condensed (with Barlow)
**Mono Font:** ui-monospace stack, for code, paths and measurements only

**Character:** an industrial grotesk pairing — Barlow reads like console documentation; its semi-condensed sibling in tracked caps reads like an engraved panel legend.

### Hierarchy

- **Headline** (500, 1.75rem–2rem, 1.15): the draft prompt "What should we build in …?" and page titles.
- **Title** (500, 1rem–1.125rem, 1.3): thread titles, settings row titles.
- **Body** (400, 17px default interface size, 1.5): messages and descriptions; prose measure stays under 75ch in the timeline.
- **Legend** (600, 0.6875rem, 0.08em tracking, uppercase, Barlow Semi Condensed): project labels, shelf headers (Settled, Snoozed), settings section titles, key hints, composer selector caps,

### Named Rules

**The Legend Rule.** Uppercase tracked caps are reserved for labels that name a region or a control; body copy and thread titles are never set in caps.

## Layout

A fixed 256px console rail (the sidebar) on the left, the selected station's pane filling the rest, the composer anchored at the bottom of the pane at a 48rem measure. Sidebar geometry: 0.75rem content inset, 0.625rem control gap, 36px rows with 0.75rem horizontal inset. Settings pages use a two-column row: title and description on the left, control right-aligned. On phones the rail collapses to a sheet and the composer's selector caps collapse to the model cap plus an overflow control. Spacing rhythm is 4px-based; more space above a legend than below it.

## Elevation & Depth

Flat by construction. Depth is tonal: desk (#100f15) behind canvas (#16141c) behind raised panels (#1f1c26) behind popovers (#1c1a24). Rims are 1px enamel-rule lines or 1px inset shadows on lamps and caps; drop shadows appear only under floating popovers and toasts. There is no glass, no backdrop blur, and no coloured glow.

### Named Rules

**The No-Glass Rule.** Panels are opaque enamel. Translucency and blur are never used as materials.

## Shapes

Small, precise radii: lamps 2px, selector caps and rows 0.625rem, the transport button 8px, panels 0.75rem. Lamps are always square (10px) with a 1px inset rim. The wordmark and app icon are built from the same square lamp on a 3×5 grid; the icon is a single lamp-R inset from the enamel edge, the in-app wordmark spells RAS in lamps — amber on dark enamel, `--wordmark` (the light primary) on light.

## Components

### Buttons

- **Transport (primary):** amber fill (#f0c24b), enamel-desk text, 8px radius, 36px square; colour-only transition, no glow, no scale.
- **Secondary / ghost:** enamel-raised fill with a 1px enamel-rule rim, legend-ink text.
- **Pressed / active:** an inset 1px rim; the box never changes size between states.

### Selector Caps (model, effort, access)

- **Style:** enamel-raised cap with a 1px darker inset rim, legend face in tracked caps, 0.625rem radius.
- **State:** the open cap and the active picker rail carry amber.

### Status Lamp

- **Style:** 10px square, 2px radius, 1px inset rim; colour from state (green working, amber waiting, red failed, unlit idle); settled shows the ✓ mark with the lamp off.
- **Motion:** working pulses opacity over 1.2s; disabled under `prefers-reduced-motion`.

### Sidebar Row (station)

- **Style:** 36px row, project label as an engraved legend with its provider icon, thread title in body type, lamp + glyph on the right.
- **Hover / selected:** enamel-hover fill; focus ring 2px amber.

### Inputs

- **Style:** enamel-raised field, 1px enamel-rule border, 0.625rem radius, legend-ink text, caret and selection in amber.
- **Focus:** 2px amber ring, no glow.

### Switch

- **On:** signal green track; **Off:** unlit-lamp track.

## Do's and Don'ts

### Do:

- **Do** spend colour on state and on the one action; keep everything else enamel.
- **Do** pair every status colour with its glyph.
- **Do** set region and control labels in the legend face, uppercase, 0.08em tracking.
- **Do** keep every control's box identical across rest, hover, pressed and active.
- **Do** use violet-tinted neutrals (#2a2733 / #3a3646) for anything that is not text or state.

### Don't:

- **Don't** use teal, emerald or any green-tinted grey.
- **Don't** add glass, blur, glow or gradient text.
- **Don't** put a second amber control in a view.
- **Don't** animate continuously; the working lamp's pulse is the only ambient motion.
- **Don't** set thread titles or body copy in caps.
