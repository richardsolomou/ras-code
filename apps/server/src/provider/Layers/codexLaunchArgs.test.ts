import * as NodeAssert from "node:assert/strict";

import { posthogGatewayCodexLaunchArgs } from "@t3tools/shared/posthogGateway";
import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses RAS_CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { RAS_CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when RAS_CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { RAS_CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { RAS_CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("PostHog AI Gateway launch args", () => {
  it("reaches codex app-server as the overrides the gateway needs", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(posthogGatewayCodexLaunchArgs().launchArgs), [
      "app-server",
      "-c",
      "model_provider=posthog",
      "-c",
      "model_providers.posthog.name=PostHog AI Gateway",
      "-c",
      "model_providers.posthog.base_url=https://ai-gateway.us.posthog.com/v1",
      "-c",
      "model_providers.posthog.env_key=RAS_GATEWAY_KEY",
      "-c",
      "model_providers.posthog.wire_api=responses",
      "-c",
      "web_search=disabled",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.apps=false",
    ]);
  });
});
