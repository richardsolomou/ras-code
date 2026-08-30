import { scopeThreadRef } from "@ras-code/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@ras-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_PANE_MIN_WIDTH,
  selectFocusedThread,
  canOpenThreadInSplit,
  canSplitPaneRow,
  clampPaneFraction,
  INITIAL_CHAT_PANE_LAYOUT,
  planPaneFocusChange,
  planPaneSplit,
  reconcileCompanion,
  shouldCollapseOnNavigation,
  type ChatPaneMeasuredLayout,
} from "./chatPaneStore";

const threadRef = (threadId: string, environmentId = "env-1") =>
  scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId);

const alpha = threadRef("alpha");
const beta = threadRef("beta");
const gamma = threadRef("gamma");

const splitLayout = (overrides: Partial<ChatPaneMeasuredLayout> = {}): ChatPaneMeasuredLayout => ({
  ...INITIAL_CHAT_PANE_LAYOUT,
  companion: beta,
  // Room for two panes unless a test takes it away.
  canSplit: true,
  ...overrides,
});

describe("canSplitPaneRow", () => {
  it("rejects a row too narrow for two readable panes", () => {
    expect(canSplitPaneRow(CHAT_PANE_MIN_WIDTH * 2 - 1)).toBe(false);
  });

  it("accepts a row that fits both panes at the minimum width", () => {
    expect(canSplitPaneRow(CHAT_PANE_MIN_WIDTH * 2)).toBe(true);
  });
});

describe("clampPaneFraction", () => {
  it("holds the divider away from the edge so the narrow pane keeps its minimum", () => {
    expect(clampPaneFraction(0.95, CHAT_PANE_MIN_WIDTH * 4)).toBeCloseTo(0.75);
  });

  it("leaves a divider that already clears the minimum on both sides", () => {
    expect(clampPaneFraction(0.6, CHAT_PANE_MIN_WIDTH * 4)).toBeCloseTo(0.6);
  });

  it("centres the divider when the row cannot give both panes the minimum", () => {
    expect(clampPaneFraction(0.8, CHAT_PANE_MIN_WIDTH)).toBe(0.5);
  });

  it("falls back to a plain clamp before the row has been measured", () => {
    expect(clampPaneFraction(0.95, 0)).toBeCloseTo(0.75);
  });
});

describe("planPaneSplit", () => {
  it("puts the dropped thread in the pane on the side it was dropped", () => {
    expect(
      planPaneSplit({
        layout: INITIAL_CHAT_PANE_LAYOUT,
        routed: alpha,
        dropped: beta,
        side: "left",
      }),
    ).toEqual({ ...INITIAL_CHAT_PANE_LAYOUT, companion: beta, companionSide: "left" });
  });

  it("refuses to sit a thread beside itself", () => {
    expect(
      planPaneSplit({
        layout: INITIAL_CHAT_PANE_LAYOUT,
        routed: alpha,
        dropped: alpha,
        side: "right",
      }),
    ).toBeNull();
  });

  it("treats re-dropping the companion on the side it already holds as a no-op", () => {
    expect(
      planPaneSplit({
        layout: splitLayout({ companionSide: "right" }),
        routed: alpha,
        dropped: beta,
        side: "right",
      }),
    ).toBeNull();
  });

  it("leaves focus in the pane the user was working in", () => {
    expect(
      planPaneSplit({
        layout: { ...INITIAL_CHAT_PANE_LAYOUT, focusedPane: "companion" },
        routed: alpha,
        dropped: beta,
        side: "right",
      })?.focusedPane,
    ).toBe("routed");
  });

  it("moves the companion across when it is dropped on the other side", () => {
    expect(
      planPaneSplit({
        layout: splitLayout({ companionSide: "right" }),
        routed: alpha,
        dropped: beta,
        side: "left",
      })?.companionSide,
    ).toBe("left");
  });

  it("splits against an unrouted pane, so a draft landing page can still take a drop", () => {
    expect(
      planPaneSplit({
        layout: INITIAL_CHAT_PANE_LAYOUT,
        routed: null,
        dropped: beta,
        side: "right",
      })?.companion,
    ).toEqual(beta);
  });
});

describe("selectFocusedThread", () => {
  it("marks the routed thread while the routed pane holds focus", () => {
    expect(selectFocusedThread(splitLayout({ focusedPane: "routed" }), alpha)).toEqual(alpha);
  });

  it("marks the companion once the user works in it", () => {
    expect(selectFocusedThread(splitLayout({ focusedPane: "companion" }), alpha)).toEqual(beta);
  });

  it("falls back to the routed thread when no companion is open", () => {
    expect(
      selectFocusedThread(splitLayout({ companion: null, focusedPane: "companion" }), alpha),
    ).toEqual(alpha);
  });

  it("falls back to the routed thread when the row is too narrow to show the companion", () => {
    expect(
      selectFocusedThread(splitLayout({ focusedPane: "companion", canSplit: false }), alpha),
    ).toEqual(alpha);
  });
});

describe("canOpenThreadInSplit", () => {
  it("offers a split for a thread that is in neither pane", () => {
    expect(canOpenThreadInSplit(splitLayout(), { routed: alpha, candidate: gamma })).toBe(true);
  });

  it("refuses the thread already in the routed pane", () => {
    expect(canOpenThreadInSplit(splitLayout(), { routed: alpha, candidate: alpha })).toBe(false);
  });

  it("refuses the thread already in the companion, which would be a no-op", () => {
    expect(canOpenThreadInSplit(splitLayout(), { routed: alpha, candidate: beta })).toBe(false);
  });

  it("refuses any split on a row with no room for two panes", () => {
    expect(
      canOpenThreadInSplit(splitLayout({ canSplit: false }), { routed: alpha, candidate: gamma }),
    ).toBe(false);
  });
});

describe("planPaneFocusChange", () => {
  it("navigates to the thread that was in the companion", () => {
    expect(planPaneFocusChange(splitLayout(), alpha)?.navigateTo).toEqual(beta);
  });

  it("hands the routed thread to the companion so both stay on screen", () => {
    expect(planPaneFocusChange(splitLayout(), alpha)?.layout.companion).toEqual(alpha);
  });

  it("flips the side with the swap so neither pane moves on screen", () => {
    expect(
      planPaneFocusChange(splitLayout({ companionSide: "right" }), alpha)?.layout.companionSide,
    ).toBe("left");
  });

  it("keeps the divider where the user left it", () => {
    expect(
      planPaneFocusChange(splitLayout({ leftFraction: 0.3 }), alpha)?.layout.leftFraction,
    ).toBe(0.3);
  });

  it("adopts the companion as the only pane when the route has no thread to hand back", () => {
    expect(planPaneFocusChange(splitLayout(), null)).toEqual({
      layout: { ...splitLayout(), companion: null },
      navigateTo: beta,
    });
  });

  it("does nothing when the inset holds a single pane", () => {
    expect(planPaneFocusChange(INITIAL_CHAT_PANE_LAYOUT, alpha)).toBeNull();
  });
});

describe("shouldCollapseOnNavigation", () => {
  const keys = {
    previousRouteId: "thread:env-1:alpha",
    nextRouteId: "thread:env-1:gamma",
    previousRoutedKey: "env-1:alpha",
    companionKey: "env-1:beta",
  };

  it("collapses the split when the route moves to an unrelated thread", () => {
    expect(shouldCollapseOnNavigation(keys)).toBe(true);
  });

  it("leaves a single pane alone", () => {
    expect(shouldCollapseOnNavigation({ ...keys, companionKey: null })).toBe(false);
  });

  it("ignores a route that has not actually moved", () => {
    expect(shouldCollapseOnNavigation({ ...keys, nextRouteId: keys.previousRouteId })).toBe(false);
  });

  it("keeps both panes when the companion is promoted", () => {
    expect(
      shouldCollapseOnNavigation({
        previousRouteId: "thread:env-1:beta",
        nextRouteId: "thread:env-1:alpha",
        previousRoutedKey: "env-1:beta",
        companionKey: "env-1:beta",
      }),
    ).toBe(false);
  });

  it("keeps both panes when a draft promotes in place, which moves no route", () => {
    expect(
      shouldCollapseOnNavigation({
        previousRouteId: "draft:draft-1",
        nextRouteId: "draft:draft-1",
        previousRoutedKey: null,
        companionKey: "env-1:beta",
      }),
    ).toBe(false);
  });

  it("collapses when leaving a draft for a thread, since that is a real navigation", () => {
    expect(
      shouldCollapseOnNavigation({
        previousRouteId: "draft:draft-1",
        nextRouteId: "thread:env-1:gamma",
        previousRoutedKey: null,
        companionKey: "env-1:beta",
      }),
    ).toBe(true);
  });
});

describe("reconcileCompanion", () => {
  it("drops a companion the routed pane has navigated onto", () => {
    expect(
      reconcileCompanion({
        layout: splitLayout(),
        routedKey: "env-1:beta",
        knownThreadKeys: new Set(["env-1:beta"]),
      }).companion,
    ).toBeNull();
  });

  it("returns focus to the routed pane when the companion goes away", () => {
    expect(
      reconcileCompanion({
        layout: splitLayout({ focusedPane: "companion" }),
        routedKey: "env-1:alpha",
        knownThreadKeys: new Set(["env-1:alpha"]),
      }).focusedPane,
    ).toBe("routed");
  });

  it("drops a companion whose thread its own environment no longer has", () => {
    expect(
      reconcileCompanion({
        layout: splitLayout(),
        routedKey: "env-1:alpha",
        knownThreadKeys: new Set(["env-1:alpha"]),
      }).companion,
    ).toBeNull();
  });

  it("holds a companion whose environment has not reported yet", () => {
    expect(
      reconcileCompanion({
        layout: splitLayout({ companion: threadRef("beta", "env-2") }),
        routedKey: "env-1:alpha",
        knownThreadKeys: new Set(["env-1:alpha", "env-1:other"]),
      }).companion,
    ).toEqual(threadRef("beta", "env-2"));
  });

  it("holds the companion while the thread list is still empty", () => {
    expect(
      reconcileCompanion({
        layout: splitLayout(),
        routedKey: "env-1:alpha",
        knownThreadKeys: new Set(),
      }).companion,
    ).toEqual(beta);
  });

  it("keeps a companion that still exists beside a different routed thread", () => {
    expect(
      reconcileCompanion({
        layout: splitLayout(),
        routedKey: "env-1:alpha",
        knownThreadKeys: new Set(["env-1:alpha", "env-1:beta"]),
      }).companion,
    ).toEqual(beta);
  });
});
