import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<{ readonly environmentId: string; readonly label: string }>,
  primaryEnvironmentId: null as string | null,
  activeEnvironmentId: null as string | null,
  selectedEnvironmentId: null as string | null,
  configs: new Map<string, unknown>(),
  select: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

// The selection atom reads through `useAtomValue`, and so does the selected
// device's server config; the config atom family is mocked to a `config:<id>`
// tag so one shim can serve both.
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    if (typeof atom === "string" && atom.startsWith("config:")) {
      return state.configs.get(atom.slice("config:".length)) ?? null;
    }
    return state.selectedEnvironmentId;
  },
  useAtomSet: () => state.select,
}));

vi.mock("./environments", () => ({
  useEnvironments: () => ({ environments: state.environments, isReady: true }),
  usePrimaryEnvironmentId: () => state.primaryEnvironmentId,
}));

vi.mock("./entities", () => ({
  useActiveEnvironmentId: () => state.activeEnvironmentId,
}));

vi.mock("./server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    configValueAtom: (environmentId: string | null) => `config:${environmentId}`,
  },
}));

import {
  useSettingsEnvironmentId,
  useSettingsEnvironmentProviders,
  useSettingsEnvironmentScope,
} from "./settingsEnvironment";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const otherId = EnvironmentId.make("other");

function provider(instanceId: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-30T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function setConfig(environmentId: string, providers: ReadonlyArray<ServerProvider>): void {
  state.configs.set(environmentId, { providers } as unknown as ServerConfig);
}

function render<T>(hook: () => T): T {
  hooks.beginRender();
  return hook();
}

beforeEach(() => {
  hooks.reset();
  state.environments = [
    { environmentId: remoteId, label: "Zulu Remote" },
    { environmentId: primaryId, label: "This device" },
    { environmentId: otherId, label: "Alpha Remote" },
  ];
  state.primaryEnvironmentId = primaryId;
  state.activeEnvironmentId = null;
  state.selectedEnvironmentId = null;
  state.configs = new Map();
  state.select = vi.fn();
});

describe("settings environment scope", () => {
  it("offers every connected device with the serving one first", () => {
    const scope = render(useSettingsEnvironmentScope);

    expect(scope.options.map((option) => option.environmentId)).toEqual([
      primaryId,
      otherId,
      remoteId,
    ]);
    expect(scope.environmentId).toBe(primaryId);
  });

  it("follows an explicit device pick", () => {
    state.selectedEnvironmentId = remoteId;

    expect(render(useSettingsEnvironmentId)).toBe(remoteId);
  });

  it("anchors to the active device when nothing serves this client", () => {
    // The hosted web app: no PrimaryConnectionTarget exists, so without this
    // every server-backed settings row would read defaults and drop its writes.
    state.primaryEnvironmentId = null;
    state.activeEnvironmentId = remoteId;

    expect(render(useSettingsEnvironmentId)).toBe(remoteId);
  });

  it("falls back to the first device when the hosted app has no active one", () => {
    state.primaryEnvironmentId = null;
    state.activeEnvironmentId = null;

    expect(render(useSettingsEnvironmentId)).toBe(otherId);
  });

  it("reads providers from the selected device, not the serving one", () => {
    setConfig(primaryId, [provider("codex")]);
    setConfig(remoteId, [provider("claudeAgent")]);
    state.selectedEnvironmentId = remoteId;

    expect(render(useSettingsEnvironmentProviders).map((entry) => entry.instanceId)).toEqual([
      "claudeAgent",
    ]);
  });

  it("reports no providers rather than another device's when the selection has no config", () => {
    setConfig(primaryId, [provider("codex")]);
    state.selectedEnvironmentId = remoteId;

    expect(render(useSettingsEnvironmentProviders)).toEqual([]);
  });
});
