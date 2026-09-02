import { expect, it } from "@effect/vitest";

import { codexMaintenanceResolver } from "./CodexDriver.ts";

const npmGlobalUpdateArgs = [
  "install",
  "-g",
  "--allow-scripts=@openai/codex",
  "@openai/codex@latest",
];

it("updates a standalone codex install through codex update", () => {
  expect(
    codexMaintenanceResolver.resolve({
      binaryPath: "codex",
      resolvedCommandPath: "/Users/dev/.local/bin/codex",
      realCommandPath:
        "/Users/dev/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex",
    }).update,
  ).toEqual({
    command: "codex update",
    executable: "codex",
    args: ["update"],
    lockKey: "codex-native",
  });
});

it("updates a standalone codex install reached through a shim that hides the bin symlink", () => {
  expect(
    codexMaintenanceResolver.resolve({
      binaryPath: "codex",
      resolvedCommandPath: "/Users/dev/.local/share/mise/shims/codex",
      realCommandPath:
        "/Users/dev/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex",
    }).update?.executable,
  ).toBe("codex");
});

it("keeps npm global updates for an npm-installed codex", () => {
  expect(
    codexMaintenanceResolver.resolve({
      binaryPath: "codex",
      resolvedCommandPath: "/Users/dev/.local/share/mise/installs/node/24.18.0/bin/codex",
      realCommandPath:
        "/Users/dev/.local/share/mise/installs/node/24.18.0/lib/node_modules/@openai/codex/bin/codex.js",
    }).update,
  ).toEqual({
    command: `npm ${npmGlobalUpdateArgs.join(" ")}`,
    executable: "npm",
    args: npmGlobalUpdateArgs,
    lockKey: "npm-global",
  });
});

it("keeps homebrew updates for a homebrew-installed codex", () => {
  expect(
    codexMaintenanceResolver.resolve({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/homebrew/bin/codex",
    }).update,
  ).toEqual({
    command: "brew upgrade codex",
    executable: "brew",
    args: ["upgrade", "codex"],
    lockKey: "homebrew",
  });
});
