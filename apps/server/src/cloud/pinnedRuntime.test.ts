import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

const exitCode = (code: number) => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const successfulRunner = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: { readonly nativeModulesLoad?: boolean } = {},
) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.args[0] !== "install") {
          return exitCode(options.nativeModulesLoad === false ? 1 : 0);
        }
        const prefixIndex = input.args.indexOf("--prefix");
        const stagingDir = input.args[prefixIndex + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        const entry = path.join(stagingDir, "node_modules", "ras-code", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-test-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        nodePath: "node",
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), "1.2.3\n");
    }),
  );

  it.effect("opts the install in to node-pty's build script", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-test-",
      });
      const installs: Array<ProcessRunner.ProcessRunInput> = [];
      let stagingNpmrc = "";
      const inner = successfulRunner(fs, path);
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            if (input.args[0] === "install") {
              installs.push(input);
            }
            const result = yield* inner.run(input);
            if (input.args[0] === "install" && input.cwd !== undefined) {
              stagingNpmrc = yield* fs
                .readFileString(path.join(input.cwd, ".npmrc"))
                .pipe(Effect.orElseSucceed(() => ""));
            }
            return result;
          }),
      });

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        nodePath: "node",
        validate: () => Effect.void,
      });

      // npm reads the opt-in from the directory it runs in, not from --prefix,
      // so the cwd and the npmrc have to agree.
      const install = installs[0];
      assert.isDefined(install);
      assert.equal(install?.cwd, install?.args[install.args.indexOf("--prefix") + 1]);
      assert.include(stagingNpmrc, "allow-scripts=node-pty");
    }),
  );

  it.effect("does not publish a runtime whose native modules fail to load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-test-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path, { nativeModulesLoad: false }),
        nodePath: "node",
        validate: () => Effect.void,
      }).pipe(Effect.flip);

      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.isFalse(yield* fs.exists(finalPaths.sentinelPath));
    }),
  );

  it.effect("reinstalls a pinned runtime whose native modules stopped loading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-test-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      // A tree installed before the opt-in existed: sentinel present, no pty.node.
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "export {};\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      let installs = 0;
      const inner = successfulRunner(fs, path, { nativeModulesLoad: false });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            if (input.args[0] === "install") installs += 1;
            return yield* inner.run(input);
          }),
      });

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        nodePath: "node",
        validate: () => Effect.void,
      }).pipe(Effect.ignore);

      assert.equal(installs, 1);
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-test-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        nodePath: "node",
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-repair-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        nodePath: "node",
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-repair-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      let validations = 0;
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        nodePath: "node",
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ras-code-pinned-runtime-interrupt-",
      });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        nodePath: "node",
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});
