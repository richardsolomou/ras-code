import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";

export class NodePtyModuleLoadError extends Schema.TaggedErrorClass<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return (
      `Failed to load node-pty for ${this.platform}-${this.architecture}. ` +
      "The install left no native binary behind, which is what happens when npm skips " +
      "node-pty's build script: npm 12 blocks dependency build scripts by default and " +
      "node-pty publishes no prebuilt binary for Linux. Allow it with " +
      "`npm config set allow-scripts=node-pty --location=user`, then reinstall."
    );
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

/**
 * Binaries we publish for platforms node-pty has no prebuild for, resolved
 * against the bundled output so `dist/prebuilds/<platform>-<arch>/pty.node`
 * travels with the package. Absent when running from source, where the
 * workspace install builds node-pty itself.
 */
const shippedNodePtyBinaryPath = (platform: string, architecture: string): string =>
  NodeURL.fileURLToPath(
    new URL(`./prebuilds/${platform}-${architecture}/pty.node`, import.meta.url),
  );

const nodePtyNativeModuleCandidates = (
  path: Path.Path,
  packageDir: string,
  platform: string,
  architecture: string,
): ReadonlyArray<string> => [
  path.join(packageDir, "build", "Release", "pty.node"),
  path.join(packageDir, "build", "Debug", "pty.node"),
  path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "pty.node"),
];

/**
 * Puts a usable `pty.node` where node-pty's loader looks for one.
 *
 * node-pty publishes prebuilds for macOS and Windows only, so on Linux its
 * binary is compiled during install — which npm 12 skips unless the installing
 * project opts in, leaving an install that looks complete and cannot start.
 * Nothing inside the package can opt in on behalf of `npx` or a global install,
 * so ship the binary and copy it into place instead.
 *
 * Best effort by design: a read-only install has nothing to stage into, and the
 * load error that follows names the remedy.
 */
export const stageNodePtyNativeModule = Effect.fn("NodePtyAdapter.stageNativeModule")(
  function* (input: {
    readonly packageDir: string;
    readonly shippedBinaryPath: string;
    readonly platform: string;
    readonly architecture: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const candidates = nodePtyNativeModuleCandidates(
      path,
      input.packageDir,
      input.platform,
      input.architecture,
    );
    for (const candidate of candidates) {
      if (yield* fs.exists(candidate)) {
        return "already-present" as const;
      }
    }
    if (!(yield* fs.exists(input.shippedBinaryPath))) {
      return "not-shipped" as const;
    }

    const targetDir = path.join(
      input.packageDir,
      "prebuilds",
      `${input.platform}-${input.architecture}`,
    );
    yield* fs.makeDirectory(targetDir, { recursive: true });
    // Rename so a second server starting concurrently never observes a partial
    // binary through node-pty's loader.
    const staging = path.join(targetDir, `.pty.node.${process.pid}`);
    yield* fs.copyFile(input.shippedBinaryPath, staging);
    yield* fs.rename(staging, path.join(targetDir, "pty.node"));
    return "staged" as const;
  },
);

const stageNodePtyNativeModuleForHost = Effect.fn("NodePtyAdapter.stageNativeModuleForHost")(
  function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    const requireForNodePty = NodeModule.createRequire(import.meta.url);
    const packageDir = path.dirname(requireForNodePty.resolve("node-pty/package.json"));
    return yield* stageNodePtyNativeModule({
      packageDir,
      shippedBinaryPath: shippedNodePtyBinaryPath(platform, architecture),
      platform,
      architecture,
    });
  },
);

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = NodeModule.createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;

  constructor(process: import("node-pty").IPty) {
    this.process = process;
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* (
  loadNodePtyModule: NodePtyModuleLoader = () => import("node-pty"),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  yield* stageNodePtyNativeModuleForHost().pipe(Effect.orElseSucceed(() => "unavailable" as const));

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessArchitecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () =>
          nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          }),
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      return new NodePtyProcess(ptyProcess);
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
