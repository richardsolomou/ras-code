import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const spawn = vi.fn(() => ({
  pid: 42,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("node-pty", () => ({ spawn }));

const testLayer = NodePtyAdapter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcessPlatform, "win32"),
      Layer.succeed(HostProcessArchitecture, "x64"),
    ),
  ),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make(() => Promise.reject(cause)).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.include(error.message, "Failed to load node-pty for win32-x64.");
      assert.include(error.message, "allow-scripts=node-pty");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);

it.effect("stages a shipped binary where node-pty's loader looks for one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ras-code-node-pty-" });
    const packageDir = path.join(root, "node-pty");
    const shippedBinaryPath = path.join(root, "shipped", "pty.node");
    yield* fs.makeDirectory(path.dirname(shippedBinaryPath), { recursive: true });
    yield* fs.writeFileString(shippedBinaryPath, "BINARY");

    const outcome = yield* NodePtyAdapter.stageNodePtyNativeModule({
      packageDir,
      shippedBinaryPath,
      platform: "linux",
      architecture: "x64",
    });

    assert.equal(outcome, "staged");
    assert.equal(
      yield* fs.readFileString(path.join(packageDir, "prebuilds", "linux-x64", "pty.node")),
      "BINARY",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves a binary the install already built alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ras-code-node-pty-" });
    const packageDir = path.join(root, "node-pty");
    const built = path.join(packageDir, "build", "Release", "pty.node");
    yield* fs.makeDirectory(path.dirname(built), { recursive: true });
    yield* fs.writeFileString(built, "COMPILED");
    const shippedBinaryPath = path.join(root, "shipped", "pty.node");
    yield* fs.makeDirectory(path.dirname(shippedBinaryPath), { recursive: true });
    yield* fs.writeFileString(shippedBinaryPath, "SHIPPED");

    const outcome = yield* NodePtyAdapter.stageNodePtyNativeModule({
      packageDir,
      shippedBinaryPath,
      platform: "linux",
      architecture: "x64",
    });

    assert.equal(outcome, "already-present");
    assert.equal(yield* fs.readFileString(built), "COMPILED");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does nothing on a platform we ship no binary for", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ras-code-node-pty-" });
    const packageDir = path.join(root, "node-pty");

    const outcome = yield* NodePtyAdapter.stageNodePtyNativeModule({
      packageDir,
      shippedBinaryPath: path.join(root, "shipped", "pty.node"),
      platform: "linux",
      architecture: "riscv64",
    });

    assert.equal(outcome, "not-shipped");
    assert.isFalse(yield* fs.exists(path.join(packageDir, "prebuilds")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
