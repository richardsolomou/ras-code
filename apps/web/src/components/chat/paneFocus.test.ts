import { describe, expect, it, vi } from "vite-plus/test";

import {
  PANE_DEFAULT_FOCUS_SELECTOR,
  registerPaneFocusRestorer,
  restoreActivePaneFocus,
  restorePaneFocus,
  restorePaneFocusAfterClick,
} from "./paneFocus";

function focusTarget(connected = true) {
  return {
    isConnected: connected,
    focus: vi.fn(),
  } as unknown as HTMLElement;
}

function paneRoot(input: {
  remembered?: HTMLElement;
  fallback?: HTMLElement | null;
  selected?: Node;
}) {
  return {
    contains: (target: HTMLElement | Node) =>
      target === input.remembered || (input.selected !== undefined && target === input.selected),
    querySelector: vi.fn((selector: string) => {
      expect(selector).toBe(PANE_DEFAULT_FOCUS_SELECTOR);
      return input.fallback ?? null;
    }),
  } as unknown as HTMLElement;
}

describe("restorePaneFocus", () => {
  it("restores the pane's last connected focus target", () => {
    const remembered = focusTarget();

    expect(restorePaneFocus(paneRoot({ remembered }), remembered)).toBe(true);
    expect(remembered.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("falls back to the composer when the remembered target was removed", () => {
    const remembered = focusTarget(false);
    const fallback = focusTarget();

    expect(restorePaneFocus(paneRoot({ remembered, fallback }), remembered)).toBe(true);
    expect(fallback.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does nothing when the pane has no focusable target", () => {
    expect(restorePaneFocus(paneRoot({}), null)).toBe(false);
  });
});

function textSelection(input: { collapsed?: boolean; within?: Node } = {}) {
  const node = input.within ?? ({} as Node);
  return {
    isCollapsed: input.collapsed ?? false,
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: node }) as Range,
  } as unknown as Selection;
}

describe("restorePaneFocusAfterClick", () => {
  it("restores the pane after a click on non-focusable content", () => {
    const remembered = focusTarget();

    expect(
      restorePaneFocusAfterClick(
        paneRoot({ remembered }),
        {} as EventTarget,
        null,
        remembered,
        null,
      ),
    ).toBe(true);
    expect(remembered.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves a clicked focusable control in charge", () => {
    const remembered = focusTarget();
    const closest = vi.fn((selector: string) =>
      selector.includes("a[href]") && selector.includes("button") ? remembered : null,
    );
    const target = { closest } as unknown as EventTarget;

    expect(
      restorePaneFocusAfterClick(paneRoot({ remembered }), target, null, remembered, null),
    ).toBe(false);
    expect(closest).toHaveBeenCalledOnce();
    expect(remembered.focus).not.toHaveBeenCalled();
  });

  it("leaves focus alone when it already landed inside the pane", () => {
    const remembered = focusTarget();

    expect(
      restorePaneFocusAfterClick(
        paneRoot({ remembered }),
        {} as EventTarget,
        remembered,
        remembered,
        null,
      ),
    ).toBe(false);
    expect(remembered.focus).not.toHaveBeenCalled();
  });

  it("keeps text the click left selected in the pane", () => {
    const remembered = focusTarget();
    const selected = {} as Node;

    expect(
      restorePaneFocusAfterClick(
        paneRoot({ remembered, selected }),
        {} as EventTarget,
        null,
        remembered,
        textSelection({ within: selected }),
      ),
    ).toBe(false);
    expect(remembered.focus).not.toHaveBeenCalled();
  });

  it("restores the pane when the click only moved the caret", () => {
    const remembered = focusTarget();
    const selected = {} as Node;

    expect(
      restorePaneFocusAfterClick(
        paneRoot({ remembered, selected }),
        {} as EventTarget,
        null,
        remembered,
        textSelection({ within: selected, collapsed: true }),
      ),
    ).toBe(true);
    expect(remembered.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("restores the pane when the selected text sits in another pane", () => {
    const remembered = focusTarget();

    expect(
      restorePaneFocusAfterClick(
        paneRoot({ remembered }),
        {} as EventTarget,
        null,
        remembered,
        textSelection(),
      ),
    ).toBe(true);
    expect(remembered.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("restoreActivePaneFocus", () => {
  it("restores focus through the mounted pane workspace", () => {
    const restorer = vi.fn(() => true);
    const unregister = registerPaneFocusRestorer(restorer);

    expect(restoreActivePaneFocus()).toBe(true);
    expect(restorer).toHaveBeenCalledOnce();

    unregister();
    expect(restoreActivePaneFocus()).toBe(false);
  });
});
