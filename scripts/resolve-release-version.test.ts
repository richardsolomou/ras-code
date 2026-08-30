import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  readDesktopBaseVersion,
  resolveStableReleaseMetadata,
  resolveCanaryBaseVersion,
  resolveCanaryReleaseMetadata,
  resolveCanaryTargetVersion,
  writeReleaseOutput,
} from "./resolve-release-version.ts";

it("strips prerelease and build metadata when deriving the canary base version", () => {
  assert.equal(resolveCanaryBaseVersion("0.0.17"), "0.0.17");
  assert.equal(resolveCanaryBaseVersion("9.9.9-smoke.0"), "9.9.9");
  assert.equal(resolveCanaryBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
});

it.effect("bumps the patch version before deriving canary prerelease versions", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveCanaryTargetVersion("0.0.17"), "0.0.18");
    assert.equal(yield* resolveCanaryTargetVersion("9.9.9-smoke.0"), "9.9.10");
    assert.equal(yield* resolveCanaryTargetVersion("1.2.3-beta.4+build.9"), "1.2.4");
  }),
);

it.effect("reports the invalid desktop package version", () =>
  Effect.gen(function* () {
    const error = yield* resolveCanaryTargetVersion("canary").pipe(Effect.flip);

    assert.equal(error._tag, "InvalidDesktopPackageVersionError");
    assert.equal(error.version, "canary");
    assert.equal(error.message, "Invalid desktop package version 'canary'.");
  }),
);

it("names a stable release after the base version alone", () => {
  assert.deepStrictEqual(resolveStableReleaseMetadata("9.9.10", "abcdef1234567890"), {
    baseVersion: "9.9.10",
    version: "9.9.10",
    tag: "v9.9.10",
    name: "RAS Code v9.9.10",
    shortSha: "abcdef123456",
  });
});

it("derives canary metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveCanaryReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-canary.20260413.321",
      tag: "v9.9.10-canary.20260413.321",
      name: "RAS Code Canary 9.9.10-canary.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

it.effect("preserves the GITHUB_OUTPUT configuration cause", () => {
  const metadata = resolveCanaryReleaseMetadata("1.2.4", "20260620", 42, "abcdef1234567890");
  const configCause = new ConfigProvider.SourceError({ message: "environment unavailable" });

  return Effect.gen(function* () {
    const configError = yield* writeReleaseOutput(metadata, true).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make(() => Effect.fail(configCause)),
      ),
      Effect.flip,
    );

    if (configError._tag !== "ReleaseGitHubOutputConfigError") {
      return assert.fail(`Unexpected error: ${configError._tag}`);
    }
    assert.instanceOf(configError.cause, Config.ConfigError);
    assert.strictEqual(configError.cause.cause, configCause);
    assert.notInclude(configError.message, configCause.message);
  });
});

it.layer(NodeServices.layer)("readDesktopBaseVersion", (it) => {
  it.effect("preserves desktop package read context and its platform cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-release-version-read-",
      });
      const packageJsonPath = path.join(rootDir, "apps/desktop/package.json");

      const error = yield* readDesktopBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "ReleaseDesktopPackageError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.packageJsonPath, packageJsonPath);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );

  it.effect("preserves desktop package decode context and its schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-release-version-decode-",
      });
      const packageJsonPath = path.join(rootDir, "apps/desktop/package.json");
      yield* fs.makeDirectory(path.dirname(packageJsonPath), { recursive: true });
      yield* fs.writeFileString(packageJsonPath, "{");

      const error = yield* readDesktopBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "ReleaseDesktopPackageError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "decode");
      assert.equal(error.packageJsonPath, packageJsonPath);
      assert.ok(error.cause !== undefined);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );
});
