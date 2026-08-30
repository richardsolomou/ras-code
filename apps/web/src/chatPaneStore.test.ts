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
  openDraftInFocusedPane,
  planThreadDrop,
  planPaneSplit,
  planRouteChange,
  planThreadOpen,
  reconcileCompanion,
  takeRouteOpenPane,
  type ChatPaneMeasuredLayout,
  useChatPaneStore,
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
    ).toEqual({
      ...INITIAL_CHAT_PANE_LAYOUT,
      companion: beta,
      companionSide: "left",
      focusedPane: "companion",
    });
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

  it("focuses the pane receiving the dropped thread", () => {
    expect(
      planPaneSplit({
        layout: { ...INITIAL_CHAT_PANE_LAYOUT, focusedPane: "companion" },
        routed: alpha,
        dropped: beta,
        side: "right",
      })?.focusedPane,
    ).toBe("companion");
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

describe("planThreadOpen", () => {
  it("replaces the active companion without navigating the other pane", () => {
    expect(
      planThreadOpen({
        layout: splitLayout({ focusedPane: "companion" }),
        routed: alpha,
        target: gamma,
      }),
    ).toEqual({
      layout: splitLayout({ companion: gamma, focusedPane: "companion" }),
      navigateTo: null,
    });
  });

  it("navigates the active routed pane without collapsing the split", () => {
    expect(
      planThreadOpen({
        layout: splitLayout({ focusedPane: "routed" }),
        routed: alpha,
        target: gamma,
      }),
    ).toEqual({
      layout: splitLayout({ focusedPane: "routed" }),
      navigateTo: gamma,
    });
  });

  it("activates a thread already visible in the other pane", () => {
    expect(
      planThreadOpen({
        layout: splitLayout({ focusedPane: "routed" }),
        routed: alpha,
        target: beta,
      }),
    ).toEqual({
      layout: splitLayout({ focusedPane: "companion" }),
      navigateTo: null,
    });
  });

  it("falls back to navigation while the companion is hidden", () => {
    expect(
      planThreadOpen({
        layout: splitLayout({ canSplit: false, focusedPane: "companion" }),
        routed: alpha,
        target: gamma,
      }),
    ).toEqual({
      layout: splitLayout({ canSplit: false, focusedPane: "routed" }),
      navigateTo: gamma,
    });
  });
});

describe("planThreadDrop", () => {
  it("opens a new split on the side receiving the drop", () => {
    expect(
      planThreadDrop({
        layout: { ...INITIAL_CHAT_PANE_LAYOUT, canSplit: true },
        routed: alpha,
        target: beta,
        side: "left",
      }),
    ).toEqual({
      layout: {
        ...INITIAL_CHAT_PANE_LAYOUT,
        canSplit: true,
        companion: beta,
        companionSide: "left",
        focusedPane: "companion",
      },
      navigateTo: null,
    });
  });

  it("replaces the pane receiving a drop in an existing split", () => {
    expect(
      planThreadDrop({
        layout: splitLayout({ companionSide: "right" }),
        routed: alpha,
        target: gamma,
        side: "right",
      }),
    ).toEqual({
      layout: splitLayout({
        companion: gamma,
        companionSide: "right",
        focusedPane: "companion",
      }),
      navigateTo: null,
    });
  });

  it("moves an existing pane to the side receiving the drop", () => {
    expect(
      planThreadDrop({
        layout: splitLayout({ companionSide: "right" }),
        routed: alpha,
        target: alpha,
        side: "right",
      }),
    ).toEqual({
      layout: splitLayout({ companionSide: "left", focusedPane: "routed" }),
      navigateTo: null,
    });
  });

  it("navigates when an unseen thread is dropped on the routed pane", () => {
    const layout = splitLayout({ companionSide: "right" });
    expect(
      planThreadDrop({
        layout,
        routed: alpha,
        target: gamma,
        side: "left",
      }),
    ).toEqual({
      layout: splitLayout({ companionSide: "right", focusedPane: "routed" }),
      navigateTo: gamma,
    });
  });

  it("moves the companion when it is dropped on the opposite pane", () => {
    expect(
      planThreadDrop({
        layout: splitLayout({ companionSide: "right" }),
        routed: alpha,
        target: beta,
        side: "left",
      }),
    ).toEqual({
      layout: splitLayout({ companionSide: "left", focusedPane: "companion" }),
      navigateTo: null,
    });
  });
});

describe("draft route intent", () => {
  it("holds the opening pane until the matching route is observed", async () => {
    useChatPaneStore.setState(splitLayout({ focusedPane: "companion" }));

    await openDraftInFocusedPane("new", async () => undefined);

    expect(takeRouteOpenPane("draft:new")).toBe("companion");
    useChatPaneStore.setState({ ...INITIAL_CHAT_PANE_LAYOUT, canSplit: false });
  });

  it("discards intent when a different route wins", async () => {
    useChatPaneStore.setState(splitLayout({ focusedPane: "companion" }));

    await openDraftInFocusedPane("new", async () => undefined);

    expect(takeRouteOpenPane("thread:alpha")).toBeNull();
    expect(takeRouteOpenPane("draft:new")).toBeNull();
    useChatPaneStore.setState({ ...INITIAL_CHAT_PANE_LAYOUT, canSplit: false });
  });

  it("keeps the pane captured before asynchronous navigation", async () => {
    useChatPaneStore.setState(splitLayout({ focusedPane: "routed" }));

    await openDraftInFocusedPane("new", async () => undefined, "companion");

    expect(takeRouteOpenPane("draft:new")).toBe("companion");
    useChatPaneStore.setState({ ...INITIAL_CHAT_PANE_LAYOUT, canSplit: false });
  });

  it("clears pane intent when navigation fails", async () => {
    const failure = new Error("navigation failed");

    await expect(
      openDraftInFocusedPane("new", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(takeRouteOpenPane("draft:new")).toBeNull();
  });
});

describe("planRouteChange", () => {
  it("leaves browser history navigation to a draft in the routed pane", () => {
    const layout = splitLayout({ focusedPane: "companion" });
    expect(
      planRouteChange({
        layout,
        openedFromPane: null,
        previousRouteId: "thread:alpha",
        nextRouteId: "draft:historical",
        previousRouted: alpha,
        nextRouted: null,
      }),
    ).toBe(layout);
  });

  it("puts routed navigation in the active companion's screen position", () => {
    expect(
      planRouteChange({
        layout: splitLayout({ companionSide: "right", focusedPane: "companion" }),
        openedFromPane: "companion",
        previousRouteId: "thread:alpha",
        nextRouteId: "draft:new",
        previousRouted: alpha,
        nextRouted: null,
      }),
    ).toEqual(
      splitLayout({
        companion: alpha,
        companionSide: "left",
        focusedPane: "routed",
      }),
    );
  });

  it("leaves routed navigation in place when that pane is active", () => {
    const layout = splitLayout({ focusedPane: "routed" });
    expect(
      planRouteChange({
        layout,
        openedFromPane: null,
        previousRouteId: "thread:alpha",
        nextRouteId: "thread:gamma",
        previousRouted: alpha,
        nextRouted: gamma,
      }),
    ).toBe(layout);
  });

  it("leaves an unrelated server redirect in the routed pane", () => {
    const layout = splitLayout({ focusedPane: "companion" });
    expect(
      planRouteChange({
        layout,
        openedFromPane: null,
        previousRouteId: "thread:alpha",
        nextRouteId: "thread:gamma",
        previousRouted: alpha,
        nextRouted: gamma,
      }),
    ).toBe(layout);
  });

  it("activates a companion selected through route navigation", () => {
    expect(
      planRouteChange({
        layout: splitLayout({ companionSide: "right", focusedPane: "routed" }),
        openedFromPane: null,
        previousRouteId: "thread:alpha",
        nextRouteId: "thread:beta",
        previousRouted: alpha,
        nextRouted: beta,
      }),
    ).toEqual(
      splitLayout({
        companion: alpha,
        companionSide: "left",
        focusedPane: "routed",
      }),
    );
  });

  it("ignores a draft promotion that keeps the same route target", () => {
    const layout = splitLayout({ focusedPane: "companion" });
    expect(
      planRouteChange({
        layout,
        openedFromPane: null,
        previousRouteId: "draft:new",
        nextRouteId: "draft:new",
        previousRouted: null,
        nextRouted: gamma,
      }),
    ).toBe(layout);
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
