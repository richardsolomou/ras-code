import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../index.html?raw";

const THEME_STORAGE_KEY = "ras-code:theme";
const APPEARANCE_STORAGE_KEY = "ras-code:theme-appearance-mode";
const THEME_HALVES_STORAGE_KEY = "ras-code:theme-halves:v1";

const bootScript = (() => {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the inline boot script in index.html");
  return match[1];
})();

function runBootScript(options: {
  storage?: Record<string, string>;
  storageThrows?: boolean;
  prefersDark: boolean;
}) {
  const classes = new Set<string>();
  const storage = new Map(Object.entries(options.storage ?? {}));
  const meta = {
    content: "",
    setAttribute: (_name: string, value: string) => (meta.content = value),
  };
  const documentElement = {
    classList: {
      toggle: (name: string, force: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    style: { backgroundColor: "" },
  };
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => {
        if (options.storageThrows) throw new Error("storage blocked");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.storageThrows) throw new Error("storage blocked");
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        if (options.storageThrows) throw new Error("storage blocked");
        storage.delete(key);
      },
    },
    matchMedia: () => ({ matches: options.prefersDark }),
  };
  const fakeDocument = {
    documentElement,
    querySelectorAll: () => [meta],
  };

  new Function("window", "document", bootScript)(fakeWindow, fakeDocument);

  return {
    backgroundColor: documentElement.style.backgroundColor,
    isDark: classes.has("dark"),
    metaContent: meta.content,
    storage,
  };
}

describe("index.html boot script", () => {
  it.each([
    ["system", false, false],
    ["system", true, true],
    ["light", true, false],
    ["dark", false, true],
  ] as const)("applies %s on a %s dark OS", (appearance, prefersDark, expectedDark) => {
    const result = runBootScript({
      storage: { [APPEARANCE_STORAGE_KEY]: appearance },
      prefersDark,
    });

    expect(result.isDark).toBe(expectedDark);
    expect(result.backgroundColor).toBe(expectedDark ? "#16141C" : "#ffffff");
    expect(result.metaContent).toBe(result.backgroundColor);
  });

  it("applies explicit legacy light and dark preferences without rewriting them", () => {
    const light = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "light" },
      prefersDark: true,
    });
    const dark = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "dark" },
      prefersDark: false,
    });

    expect(light.isDark).toBe(false);
    expect(light.storage.get(THEME_STORAGE_KEY)).toBe("light");
    expect(light.storage.has(APPEARANCE_STORAGE_KEY)).toBe(false);
    expect(dark.isDark).toBe(true);
    expect(dark.storage.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(dark.storage.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });

  it("renders named themes and mixes as system without rewriting them", () => {
    const result = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "grove",
        [THEME_HALVES_STORAGE_KEY]: JSON.stringify({ light: "iris", dark: "ocean" }),
      },
      prefersDark: true,
    });

    expect(result.isDark).toBe(true);
    expect(result.storage.get(THEME_STORAGE_KEY)).toBe("grove");
    expect(result.storage.has(APPEARANCE_STORAGE_KEY)).toBe(false);
    expect(result.storage.get(THEME_HALVES_STORAGE_KEY)).toBe(
      JSON.stringify({ light: "iris", dark: "ocean" }),
    );
  });

  it("follows the OS when storage is unavailable", () => {
    expect(runBootScript({ storageThrows: true, prefersDark: false }).isDark).toBe(false);
    expect(runBootScript({ storageThrows: true, prefersDark: true }).isDark).toBe(true);
  });
});
