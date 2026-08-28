import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@ras-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fallbackDriverRelation,
  fallbackModelMode,
  fallbackNeedsExplicitModel,
  instanceWithFallback,
  selectableFallbackInstances,
} from "./providerFallback.logic";

const claude = ProviderDriverKind.make("claudeAgent");
const primary = ProviderInstanceId.make("claude_primary");
const gateway = ProviderInstanceId.make("claude_posthog_gateway");
const codex = ProviderInstanceId.make("codex");

const instance = (patch: Partial<ProviderInstanceConfig> = {}): ProviderInstanceConfig => ({
  driver: claude,
  ...patch,
});

describe("selectableFallbackInstances", () => {
  it("offers other enabled instances", () => {
    const candidates = selectableFallbackInstances({
      instanceId: primary,
      instances: { [primary]: instance(), [gateway]: instance({ displayName: "Gateway" }) },
    });
    expect(candidates).toEqual([{ instanceId: gateway, displayName: "Gateway" }]);
  });

  it("never offers the instance itself", () => {
    expect(
      selectableFallbackInstances({ instanceId: primary, instances: { [primary]: instance() } }),
    ).toEqual([]);
  });

  it("omits disabled instances", () => {
    expect(
      selectableFallbackInstances({
        instanceId: primary,
        instances: { [primary]: instance(), [gateway]: instance({ enabled: false }) },
      }),
    ).toEqual([]);
  });

  it("omits an instance that already falls back to this one, so no two-instance cycle forms", () => {
    expect(
      selectableFallbackInstances({
        instanceId: primary,
        instances: {
          [primary]: instance(),
          [gateway]: instance({ fallback: { instanceId: primary } }),
        },
      }),
    ).toEqual([]);
  });

  it("still offers an instance whose fallback points somewhere else", () => {
    expect(
      selectableFallbackInstances({
        instanceId: primary,
        instances: {
          [primary]: instance(),
          [gateway]: instance({ fallback: { instanceId: codex } }),
          [codex]: instance({ driver: ProviderDriverKind.make("codex") }),
        },
      }).map((candidate) => candidate.instanceId),
    ).toEqual([gateway, codex]);
  });

  it("falls back to the instance id when no display name is set", () => {
    expect(
      selectableFallbackInstances({
        instanceId: primary,
        instances: { [primary]: instance(), [gateway]: instance() },
      })[0]?.displayName,
    ).toBe(String(gateway));
  });
});

describe("fallbackModelMode", () => {
  it("defaults to the turn's own model", () => {
    expect(fallbackModelMode(instance({ fallback: { instanceId: gateway } }))).toBe("same");
  });

  it("reports a pinned model", () => {
    expect(fallbackModelMode(instance({ fallback: { instanceId: gateway, model: "glm" } }))).toBe(
      "specific",
    );
  });
});

describe("instanceWithFallback", () => {
  it("writes an explicit null to clear the binding", () => {
    expect(
      instanceWithFallback(instance({ fallback: { instanceId: gateway } }), null).fallback,
    ).toBe(null);
  });

  it("omits the model when the fallback should keep the turn's model", () => {
    expect(instanceWithFallback(instance(), { instanceId: gateway }).fallback).toEqual({
      instanceId: gateway,
    });
  });

  it("stores a pinned model", () => {
    expect(
      instanceWithFallback(instance(), { instanceId: gateway, model: " glm " }).fallback,
    ).toEqual({ instanceId: gateway, model: "glm" });
  });

  it("treats a null model as 'same model'", () => {
    expect(instanceWithFallback(instance(), { instanceId: gateway, model: null }).fallback).toEqual(
      { instanceId: gateway },
    );
  });
});

describe("fallbackDriverRelation", () => {
  const codexInstance = instance({ driver: ProviderDriverKind.make("codex") });

  it("reports no relation when nothing is bound", () => {
    expect(fallbackDriverRelation(instance(), {})).toBe("none");
  });

  it("reports no relation when the bound instance is gone", () => {
    expect(fallbackDriverRelation(instance({ fallback: { instanceId: gateway } }), {})).toBe(
      "none",
    );
  });

  it("recognises a fallback on the same driver", () => {
    expect(
      fallbackDriverRelation(instance({ fallback: { instanceId: gateway } }), {
        [gateway]: instance(),
      }),
    ).toBe("same-driver");
  });

  it("recognises a fallback on a different driver", () => {
    expect(
      fallbackDriverRelation(instance({ fallback: { instanceId: codex } }), {
        [codex]: codexInstance,
      }),
    ).toBe("cross-driver");
  });
});

describe("fallbackNeedsExplicitModel", () => {
  const codexInstances = { [codex]: instance({ driver: ProviderDriverKind.make("codex") }) };

  it("demands a model when the fallback runs on another driver", () => {
    expect(
      fallbackNeedsExplicitModel(instance({ fallback: { instanceId: codex } }), codexInstances),
    ).toBe(true);
  });

  it("lets a gateway fallback reuse the primary's model whatever driver it runs on", () => {
    const gateway = ProviderInstanceId.make("posthog_gateway");
    const gatewayInstances = {
      [gateway]: instance({ driver: ProviderDriverKind.make("posthogGateway") }),
    };
    expect(
      fallbackNeedsExplicitModel(instance({ fallback: { instanceId: gateway } }), gatewayInstances),
    ).toBe(false);
  });

  it("is satisfied once a model is pinned", () => {
    expect(
      fallbackNeedsExplicitModel(
        instance({ fallback: { instanceId: codex, model: "zai-org/glm-5.2" } }),
        codexInstances,
      ),
    ).toBe(false);
  });

  it("never demands a model on the same driver, where the turn's own model carries over", () => {
    expect(
      fallbackNeedsExplicitModel(instance({ fallback: { instanceId: gateway } }), {
        [gateway]: instance(),
      }),
    ).toBe(false);
  });
});

describe("fallbackDriverRelation with continuation keys", () => {
  const claudeInstance = ProviderInstanceId.make("claudeAgent");
  const gatewayInstance = ProviderInstanceId.make("posthog_gateway");
  const instances = {
    [claudeInstance]: { driver: ProviderDriverKind.make("claudeAgent") },
    [gatewayInstance]: { driver: ProviderDriverKind.make("posthogGateway") },
  };
  const instance = {
    driver: ProviderDriverKind.make("claudeAgent"),
    fallback: { instanceId: gatewayInstance },
  };

  it("treats a shared continuation key as continuable even across drivers", () => {
    expect(
      fallbackDriverRelation(
        instance,
        instances,
        {
          [claudeInstance]: "claude:home:/home/dev",
          [gatewayInstance]: "claude:home:/home/dev",
        },
        claudeInstance,
      ),
    ).toBe("same-driver");
  });

  it("treats different continuation keys as a new-threads-only fallback", () => {
    expect(
      fallbackDriverRelation(
        instance,
        instances,
        {
          [claudeInstance]: "claude:home:/home/dev",
          [gatewayInstance]: "claude:home:/home/other",
        },
        claudeInstance,
      ),
    ).toBe("cross-driver");
  });
});
