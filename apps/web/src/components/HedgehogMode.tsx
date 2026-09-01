import { useEffect, useRef, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";

const MAX_CONTEXT_LOSS_REMOUNTS = 3;
const REMOUNT_DELAY_MS = 2_000;
const CONTEXT_CHECK_INTERVAL_MS = 10_000;

type HedgehogModeModule = Pick<typeof import("@posthog/hedgehog-mode"), "HedgeHogMode">;

export interface HedgehogModeHandle {
  destroy(): void;
  isContextLost(): boolean;
}

export interface HedgehogModeMountOptions {
  readonly assetsUrl: string;
  readonly onQuit: () => void;
  readonly onContextLost?: () => void;
}

type LoadHedgehogMode = () => Promise<HedgehogModeModule>;

const loadHedgehogMode: LoadHedgehogMode = () => import("@posthog/hedgehog-mode");

export function getHedgehogModeAssetsUrl(
  baseUrl = import.meta.env.BASE_URL,
  origin = window.location.origin,
): string {
  return new URL(`${baseUrl}hedgehog-mode`, origin).toString().replace(/\/$/, "");
}

export async function mountHedgehogMode(
  container: HTMLDivElement,
  options: HedgehogModeMountOptions,
  load: LoadHedgehogMode = loadHedgehogMode,
): Promise<HedgehogModeHandle> {
  const { HedgeHogMode } = await load();
  let quitTimer: ReturnType<typeof setTimeout> | null = null;
  const game = new HedgeHogMode({
    assetsUrl: options.assetsUrl,
    onQuit: (activeGame) => {
      activeGame.getAllHedgehogs().forEach((hedgehog) => {
        hedgehog.updateSprite("wave", { reset: true, loop: false });
      });
      quitTimer = setTimeout(options.onQuit, 1_000);
    },
  });

  try {
    await game.render(container);
  } catch (error) {
    game.destroy();
    throw error;
  }

  const canvas = game.app.canvas;
  const notifyContextLost = () => options.onContextLost?.();
  canvas.addEventListener("webglcontextlost", notifyContextLost, { once: true });

  return {
    destroy: () => {
      if (quitTimer) clearTimeout(quitTimer);
      canvas.removeEventListener("webglcontextlost", notifyContextLost);
      game.destroy();
    },
    isContextLost: () => {
      const renderer = game.app.renderer as unknown as {
        context?: { isLost?: boolean };
      };
      return renderer.context?.isLost === true;
    },
  };
}

export function HedgehogMode() {
  const enabled = useClientSettings((settings) => settings.hedgehogMode);
  const updateSettings = useUpdateClientSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const [gameDead, setGameDead] = useState(false);

  useEffect(() => {
    if (!enabled) setGameDead(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || gameDead || !containerRef.current) return;

    let cancelled = false;
    let losses = 0;
    let handle: HedgehogModeHandle | null = null;
    let remountTimer: ReturnType<typeof setTimeout> | null = null;
    const container = containerRef.current;

    const destroyGame = () => {
      try {
        handle?.destroy();
      } catch (error) {
        console.error("Failed to destroy hedgehog mode", error);
      }
      handle = null;
      container.replaceChildren();
    };

    const mountGame = () => {
      if (cancelled || handle) return;
      void mountHedgehogMode(container, {
        assetsUrl: getHedgehogModeAssetsUrl(),
        onQuit: () => updateSettings({ hedgehogMode: false }),
        onContextLost: handleContextLost,
      })
        .then((mountedHandle) => {
          if (cancelled) {
            mountedHandle.destroy();
            return;
          }
          handle = mountedHandle;
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.error("Failed to mount hedgehog mode", error);
          setGameDead(true);
        });
    };

    const handleContextLost = () => {
      if (!handle) return;
      losses += 1;
      console.error("Hedgehog mode WebGL context lost", { losses });
      destroyGame();
      if (losses > MAX_CONTEXT_LOSS_REMOUNTS) {
        setGameDead(true);
        return;
      }
      remountTimer = setTimeout(mountGame, REMOUNT_DELAY_MS);
    };

    const checkContext = () => {
      if (!document.hidden && handle?.isContextLost()) handleContextLost();
    };

    mountGame();
    const contextCheckInterval = setInterval(checkContext, CONTEXT_CHECK_INTERVAL_MS);
    window.addEventListener("focus", checkContext);
    document.addEventListener("visibilitychange", checkContext);

    return () => {
      cancelled = true;
      clearInterval(contextCheckInterval);
      window.removeEventListener("focus", checkContext);
      document.removeEventListener("visibilitychange", checkContext);
      if (remountTimer) clearTimeout(remountTimer);
      destroyGame();
    };
  }, [enabled, gameDead, updateSettings]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none fixed inset-0 z-[999998]"
      style={{ visibility: enabled && !gameDead ? "visible" : "hidden" }}
      aria-hidden="true"
    />
  );
}
