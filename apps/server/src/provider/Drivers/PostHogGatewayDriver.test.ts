import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  buildClaudeChildEnvironment,
  buildCodexChildEnvironment,
  buildGatewayModels,
  postHogGatewayBaseInstructions,
  composeGatewaySnapshot,
  CROSS_SHAPE_SWITCH_MESSAGE,
  makeGatewayAdapter,
  mergeUsageLimits,
  resolveGatewayBaseUrl,
} from "./PostHogGatewayDriver.ts";

const INSTANCE = ProviderInstanceId.make("posthog_gateway");
const THREAD = "thread-1" as ThreadId;
const BASE_URL = "https://ai-gateway.us.posthog.com";

describe("postHogGatewayBaseInstructions", () => {
  it("defers model identity to each turn", () => {
    const instructions = postHogGatewayBaseInstructions();

    assert.match(instructions, /provided in each turn's developer instructions/);
    assert.strictEqual(instructions.includes("zai-org/glm-5.3-flash"), false);
  });
});

const childSnapshot = (input: {
  readonly driver: string;
  readonly status: ServerProvider["status"];
  readonly models?: ServerProvider["models"];
  readonly usageLimit?: ServerProvider["usageLimit"];
  readonly message?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(`posthog_gateway_${input.driver}`),
  driver: ProviderDriverKind.make(input.driver),
  enabled: true,
  installed: input.status !== "error",
  version: null,
  status: input.status,
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...(input.message ? { message: input.message } : {}),
  models: input.models ?? [],
  slashCommands: [],
  skills: [],
  ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}),
});

const compose = (overrides: {
  readonly claude?: ServerProvider;
  readonly codex?: ServerProvider;
  readonly catalog?: ReadonlyArray<{ readonly id: string; readonly name: string | null }>;
  readonly hasKey?: boolean;
}) =>
  composeGatewaySnapshot({
    instanceId: INSTANCE,
    displayName: undefined,
    accentColor: undefined,
    enabled: true,
    continuationGroupKey: "claude:home:/home/dev",
    claude: overrides.claude ?? childSnapshot({ driver: "claudeAgent", status: "ready" }),
    codex: overrides.codex ?? childSnapshot({ driver: "codex", status: "ready" }),
    catalog: overrides.catalog ?? [],
    defaultModel: "claude-sonnet-4-6",
    hasKey: overrides.hasKey ?? true,
    baseUrl: BASE_URL,
  });

interface StubAdapter {
  readonly startInputs: Array<{
    readonly provider?: string | undefined;
    readonly modelSelection?: { readonly instanceId: string; readonly model: string } | undefined;
  }>;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly calls: Array<string>;
  readonly sessions: Set<string>;
}

const stubAdapter = (
  driver: string,
  events: ReadonlyArray<ProviderRuntimeEvent> = [],
): StubAdapter => {
  const calls: Array<string> = [];
  const startInputs: StubAdapter["startInputs"] = [];
  const sessions = new Set<string>();
  const session = (threadId: ThreadId): ProviderSession => ({
    provider: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(`posthog_gateway_${driver}`),
    status: "ready",
    runtimeMode: "approval-required",
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: ProviderDriverKind.make(driver),
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      Effect.sync(() => {
        calls.push(`${driver}:startSession`);
        startInputs.push(input);
        sessions.add(input.threadId);
        return session(input.threadId);
      }),
    sendTurn: (input) =>
      Effect.sync(() => {
        calls.push(`${driver}:sendTurn`);
        return { threadId: input.threadId, turnId: "turn-1" as never };
      }),
    interruptTurn: () => Effect.sync(() => void calls.push(`${driver}:interruptTurn`)),
    respondToRequest: () => Effect.sync(() => void calls.push(`${driver}:respondToRequest`)),
    respondToUserInput: () => Effect.sync(() => void calls.push(`${driver}:respondToUserInput`)),
    stopSession: (threadId) =>
      Effect.sync(() => {
        calls.push(`${driver}:stopSession`);
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => [...sessions].map((id) => session(id as ThreadId))),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.sync(() => {
        calls.push(`${driver}:readThread`);
        return { threadId, turns: [] };
      }),
    rollbackThread: (threadId) =>
      Effect.sync(() => {
        calls.push(`${driver}:rollbackThread`);
        return { threadId, turns: [] };
      }),
    stopAll: () => Effect.sync(() => void calls.push(`${driver}:stopAll`)),
    streamEvents: Stream.fromIterable(events),
  };
  return { adapter, calls, startInputs, sessions };
};

const runtimeEvent = (driver: string): ProviderRuntimeEvent =>
  ({
    type: "session.updated",
    id: "event-1",
    provider: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(`posthog_gateway_${driver}`),
    threadId: THREAD,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as ProviderRuntimeEvent;

const makeAdapter = (anthropic: StubAdapter, openai: StubAdapter) =>
  makeGatewayAdapter({
    instanceId: INSTANCE,
    children: { anthropic: anthropic.adapter, openai: openai.adapter },
    childInstanceIds: {
      anthropic: ProviderInstanceId.make(`${INSTANCE}_claude`),
      openai: ProviderInstanceId.make(`${INSTANCE}_codex`),
    },
  });

describe("resolveGatewayBaseUrl", () => {
  it("prefers the configured origin", () => {
    assert.strictEqual(
      resolveGatewayBaseUrl({ configuredBaseUrl: "https://gw.test", environment: [] }),
      "https://gw.test",
    );
  });

  it("falls back to a gateway origin already written in the environment", () => {
    assert.strictEqual(
      resolveGatewayBaseUrl({
        configuredBaseUrl: "  ",
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "https://legacy.test", sensitive: false },
        ],
      }),
      "https://legacy.test",
    );
  });
});

describe("child environments", () => {
  it("overwrites an inherited Anthropic key with the gateway token", () => {
    const environment = buildClaudeChildEnvironment({
      environment: [{ name: "ANTHROPIC_API_KEY", value: "shell-key", sensitive: true }],
      baseUrl: BASE_URL,
      key: "phs_test",
    });
    assert.strictEqual(environment.find((entry) => entry.name === "ANTHROPIC_API_KEY")?.value, "");
    assert.strictEqual(
      environment.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value,
      "phs_test",
    );
  });

  it("republishes the key under the name Codex's launch args read", () => {
    const environment = buildCodexChildEnvironment({
      environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "phs_test", sensitive: true }],
      key: "phs_test",
    });
    assert.strictEqual(
      environment.find((entry) => entry.name === "RAS_GATEWAY_KEY")?.value,
      "phs_test",
    );
  });
});

describe("buildGatewayModels", () => {
  it("takes claude capabilities from the Claude harness", () => {
    const models = buildGatewayModels({
      catalog: [{ id: "claude-sonnet-4-6", name: null }],
      claudeModels: [
        {
          slug: "claude-sonnet-4-6",
          name: "Sonnet",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
      codexModels: [],
      defaultModel: "claude-sonnet-4-6",
    });
    assert.deepStrictEqual(models[0]?.capabilities, { optionDescriptors: [] });
    assert.strictEqual(models[0]?.isDefault, true);
  });

  it("leaves open-weight ids without capabilities", () => {
    const models = buildGatewayModels({
      catalog: [{ id: "zai-org/glm-5.2", name: "GLM 5.2" }],
      claudeModels: [],
      codexModels: [],
      defaultModel: "claude-sonnet-4-6",
    });
    assert.strictEqual(models[0]?.capabilities, null);
    assert.strictEqual(models[0]?.slug, "zai-org/glm-5.2");
  });

  it("groups an interleaved catalog by vendor without reordering within one", () => {
    const models = buildGatewayModels({
      catalog: [
        { id: "zai-org/glm-5.2", name: null },
        { id: "openai/gpt-5.4", name: null },
        { id: "zai-org/glm-5.3-flash", name: null },
        { id: "anthropic/claude-sonnet-4-6", name: null },
        { id: "openai/gpt-5.6", name: null },
      ],
      claudeModels: [],
      codexModels: [],
      defaultModel: "openai/gpt-5.4",
    });

    assert.deepStrictEqual(
      models.map((model) => model.slug),
      [
        "zai-org/glm-5.2",
        "zai-org/glm-5.3-flash",
        "openai/gpt-5.4",
        "openai/gpt-5.6",
        "anthropic/claude-sonnet-4-6",
      ],
    );
  });

  it("labels gateway models with their vendor for grouping", () => {
    const models = buildGatewayModels({
      catalog: [
        { id: "claude-sonnet-4-6", name: null },
        { id: "anthropic/claude-sonnet-4-6", name: null },
        { id: "openai/gpt-5.4", name: null },
        { id: "zai-org/glm-5.2", name: null },
        { id: "moonshotai/kimi-k3", name: null },
      ],
      claudeModels: [],
      codexModels: [],
      defaultModel: "claude-sonnet-4-6",
    });

    assert.deepStrictEqual(
      models.map((model) => model.subProvider),
      ["Anthropic", "Anthropic", "OpenAI", "Z.ai", "Moonshot AI"],
    );
  });
});

describe("composeGatewaySnapshot", () => {
  it("stays ready when only the harness the catalog needs is ready", () => {
    const snapshot = compose({
      codex: childSnapshot({ driver: "codex", status: "error", message: "codex not installed" }),
      catalog: [{ id: "claude-sonnet-4-6", name: null }],
    });
    assert.strictEqual(snapshot.status, "ready");
  });

  it("reports the unready harness the catalog needs", () => {
    const snapshot = compose({
      claude: childSnapshot({ driver: "claudeAgent", status: "error", message: "claude missing" }),
      catalog: [{ id: "claude-sonnet-4-6", name: null }],
    });
    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(snapshot.message, "claude missing");
  });

  it("reports its own driver kind rather than a child's", () => {
    assert.strictEqual(compose({}).driver, ProviderDriverKind.make("posthogGateway"));
  });

  it("is unauthenticated without a key", () => {
    const snapshot = compose({ hasKey: false });
    assert.strictEqual(snapshot.auth.status, "unauthenticated");
    assert.strictEqual(snapshot.status, "error");
  });

  it("adopts the Claude harness continuation key so a Claude thread can move here", () => {
    assert.strictEqual(compose({}).continuation?.groupKey, "claude:home:/home/dev");
  });
});

describe("mergeUsageLimits", () => {
  it("keeps the worse of the two harness reports", () => {
    const merged = mergeUsageLimits(
      { status: "ok", resetsAt: null, kind: null, utilization: null },
      { status: "exhausted", resetsAt: null, kind: "five_hour", utilization: null },
    );
    assert.strictEqual(merged?.status, "exhausted");
  });
});

describe("makeGatewayAdapter", () => {
  it.effect("starts a claude model on the Anthropic harness", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const openai = stubAdapter("codex");
      const adapter = makeAdapter(anthropic, openai);
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
      });
      assert.deepStrictEqual(anthropic.calls, ["claudeAgent:startSession"]);
      assert.deepStrictEqual(openai.calls, []);
    }),
  );

  it.effect("hands each child its own provider kind on startSession", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const openai = stubAdapter("codex");
      const adapter = makeAdapter(anthropic, openai);
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        provider: ProviderDriverKind.make("posthogGateway"),
        modelSelection: { instanceId: INSTANCE, model: "zai-org/glm-5.2" },
      });
      assert.strictEqual(openai.startInputs[0]?.provider, "codex");
      assert.strictEqual(openai.startInputs[0]?.modelSelection?.instanceId, `${INSTANCE}_codex`);
      assert.strictEqual(openai.startInputs[0]?.modelSelection?.model, "zai-org/glm-5.2");
    }),
  );

  it.effect("starts an open model on the Responses harness", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const openai = stubAdapter("codex");
      const adapter = makeAdapter(anthropic, openai);
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "zai-org/glm-5.2" },
      });
      assert.deepStrictEqual(openai.calls, ["codex:startSession"]);
      assert.deepStrictEqual(anthropic.calls, []);
    }),
  );

  it.effect("reports the composite instance on sessions it returns", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const adapter = makeAdapter(anthropic, stubAdapter("codex"));
      const session = yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
      });
      assert.strictEqual(session.providerInstanceId, INSTANCE);
      assert.strictEqual(session.provider, ProviderDriverKind.make("posthogGateway"));
    }),
  );

  it.effect("keeps a started thread on the harness that owns it", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const openai = stubAdapter("codex");
      const adapter = makeAdapter(anthropic, openai);
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
      });
      yield* adapter.sendTurn({ threadId: THREAD, input: "hello" });
      assert.deepStrictEqual(anthropic.calls, ["claudeAgent:startSession", "claudeAgent:sendTurn"]);
    }),
  );

  it.effect("refuses a turn that crosses the request shape", () =>
    Effect.gen(function* () {
      const adapter = makeAdapter(stubAdapter("claudeAgent"), stubAdapter("codex"));
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
      });
      const result = yield* adapter
        .sendTurn({
          threadId: THREAD,
          input: "hello",
          modelSelection: { instanceId: INSTANCE, model: "zai-org/glm-5.2" },
        })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.include(
        String(result._tag === "Failure" ? result.failure.message : ""),
        CROSS_SHAPE_SWITCH_MESSAGE,
      );
    }),
  );

  it.effect("allows a turn that stays on the same request shape", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const adapter = makeAdapter(anthropic, stubAdapter("codex"));
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
      });
      yield* adapter.sendTurn({
        threadId: THREAD,
        input: "hello",
        modelSelection: { instanceId: INSTANCE, model: "claude-opus-5" },
      });
      assert.deepStrictEqual(anthropic.calls, ["claudeAgent:startSession", "claudeAgent:sendTurn"]);
    }),
  );

  it.effect("rewrites both harnesses' events onto the composite instance", () =>
    Effect.gen(function* () {
      const adapter = makeAdapter(
        stubAdapter("claudeAgent", [runtimeEvent("claudeAgent")]),
        stubAdapter("codex", [runtimeEvent("codex")]),
      );
      const events = yield* Stream.runCollect(adapter.streamEvents);
      assert.strictEqual(events.length, 2);
      for (const event of events) {
        assert.strictEqual(event.providerInstanceId, INSTANCE);
        assert.strictEqual(event.provider, ProviderDriverKind.make("posthogGateway"));
      }
    }),
  );

  it.effect("merges both harnesses' session lists", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const openai = stubAdapter("codex");
      const adapter = makeAdapter(anthropic, openai);
      yield* adapter.startSession({
        threadId: THREAD,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
      });
      yield* adapter.startSession({
        threadId: "thread-2" as ThreadId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "zai-org/glm-5.2" },
      });
      const sessions = yield* adapter.listSessions();
      assert.strictEqual(sessions.length, 2);
      assert.deepStrictEqual(
        sessions.map((session) => session.providerInstanceId),
        [INSTANCE, INSTANCE],
      );
    }),
  );

  it.effect("stops every harness", () =>
    Effect.gen(function* () {
      const anthropic = stubAdapter("claudeAgent");
      const openai = stubAdapter("codex");
      yield* makeAdapter(anthropic, openai).stopAll();
      assert.deepStrictEqual(anthropic.calls, ["claudeAgent:stopAll"]);
      assert.deepStrictEqual(openai.calls, ["codex:stopAll"]);
    }),
  );
});
