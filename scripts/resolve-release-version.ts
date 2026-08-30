#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

export interface ReleaseMetadata {
  readonly baseVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
}

const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));
const RunNumberSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i));
const DesktopPackageJsonSchema = Schema.Struct({
  version: Schema.NonEmptyString,
});

export class InvalidDesktopPackageVersionError extends Schema.TaggedErrorClass<InvalidDesktopPackageVersionError>()(
  "InvalidDesktopPackageVersionError",
  {
    version: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid desktop package version '${this.version}'.`;
  }
}

export class MissingCanaryBuildIdentityError extends Schema.TaggedErrorClass<MissingCanaryBuildIdentityError>()(
  "MissingCanaryBuildIdentityError",
  {},
) {
  override get message(): string {
    return "Canary releases require --date and --run-number.";
  }
}

export class ReleaseDesktopPackageError extends Schema.TaggedErrorClass<ReleaseDesktopPackageError>()(
  "ReleaseDesktopPackageError",
  {
    operation: Schema.Literals(["read", "decode"]),
    packageJsonPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} desktop package metadata at ${this.packageJsonPath}.`;
  }
}

export class ReleaseGitHubOutputConfigError extends Schema.TaggedErrorClass<ReleaseGitHubOutputConfigError>()(
  "ReleaseGitHubOutputConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve the GITHUB_OUTPUT path for release metadata.";
  }
}

export class ReleaseGitHubOutputAppendError extends Schema.TaggedErrorClass<ReleaseGitHubOutputAppendError>()(
  "ReleaseGitHubOutputAppendError",
  {
    outputPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append release metadata to ${this.outputPath}.`;
  }
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const decodeDesktopPackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPackageJsonSchema),
);

export const resolveCanaryBaseVersion = (version: string) => version.replace(/[-+].*$/, "");

export const resolveCanaryTargetVersion = (version: string) => {
  const stableCore = resolveCanaryBaseVersion(version);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableCore);
  if (!match) {
    return Effect.fail(new InvalidDesktopPackageVersionError({ version }));
  }

  const [, major, minor, patch] = match;
  return Effect.succeed(`${major}.${minor}.${Number(patch) + 1}`);
};

/** A stable release ships the base version itself; canaries preview it. */
export const resolveStableReleaseMetadata = (
  baseVersion: string,
  sha: string,
): ReleaseMetadata => ({
  baseVersion,
  version: baseVersion,
  tag: `v${baseVersion}`,
  name: `RAS Code v${baseVersion}`,
  shortSha: sha.slice(0, 12),
});

export const resolveCanaryReleaseMetadata = (
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string,
) => {
  const shortSha = sha.slice(0, 12);
  const version = `${baseVersion}-canary.${date}.${runNumber}`;
  return {
    baseVersion,
    version,
    tag: `v${version}`,
    name: `RAS Code Canary ${version} (${shortSha})`,
    shortSha,
  };
};

export const readDesktopBaseVersion = Effect.fn("readDesktopBaseVersion")(function* (
  rootDir: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = rootDir ? path.resolve(rootDir) : yield* RepoRoot;
  const packageJsonPath = path.join(workspaceRoot, "apps/desktop/package.json");
  const packageJsonSource = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseDesktopPackageError({
          operation: "read",
          packageJsonPath,
          cause,
        }),
    ),
  );
  const packageJson = yield* decodeDesktopPackageJson(packageJsonSource).pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseDesktopPackageError({
          operation: "decode",
          packageJsonPath,
          cause,
        }),
    ),
  );
  return yield* resolveCanaryTargetVersion(packageJson.version);
});

export const writeReleaseOutput = Effect.fn("writeReleaseOutput")(function* (
  metadata: ReleaseMetadata,
  writeGithubOutput: boolean,
) {
  const fs = yield* FileSystem.FileSystem;

  const entries = [
    ["base_version", metadata.baseVersion],
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
    ["short_sha", metadata.shortSha],
  ] as const;

  if (writeGithubOutput) {
    const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseGitHubOutputConfigError({
            cause,
          }),
      ),
    );
    const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
    yield* fs.writeFileString(githubOutputPath, serialized, { flag: "a" }).pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseGitHubOutputAppendError({
            outputPath: githubOutputPath,
            cause,
          }),
      ),
    );
  } else {
    for (const [key, value] of entries) {
      yield* Console.log(`${key}=${value}`);
    }
  }
});

const ReleaseChannel = Schema.Literals(["stable", "canary"]);

const command = Command.make(
  "resolve-release-version",
  {
    channel: Flag.choice("channel", ReleaseChannel.literals).pipe(
      Flag.withDescription("Release channel to resolve metadata for."),
    ),
    date: Flag.string("date").pipe(
      Flag.withSchema(DateSchema),
      Flag.withDescription("Canary build date in YYYYMMDD."),
      Flag.optional,
    ),
    runNumber: Flag.string("run-number").pipe(
      Flag.withSchema(RunNumberSchema),
      Flag.withDescription("GitHub Actions run number."),
      Flag.optional,
    ),
    sha: Flag.string("sha").pipe(
      Flag.withSchema(ShaSchema),
      Flag.withDescription("Commit sha for the release."),
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
    root: Flag.string("root").pipe(
      Flag.withDescription("Workspace root used to resolve apps/desktop/package.json."),
      Flag.optional,
    ),
  },
  ({ channel, date, runNumber, sha, githubOutput, root }) =>
    readDesktopBaseVersion(Option.getOrUndefined(root)).pipe(
      Effect.flatMap((baseVersion) => {
        if (channel === "stable") {
          return Effect.succeed(resolveStableReleaseMetadata(baseVersion, sha));
        }
        if (Option.isNone(date) || Option.isNone(runNumber)) {
          return Effect.fail(new MissingCanaryBuildIdentityError());
        }
        return Effect.succeed(
          resolveCanaryReleaseMetadata(baseVersion, date.value, runNumber.value, sha),
        );
      }),
      Effect.flatMap((metadata) => writeReleaseOutput(metadata, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve stable or canary release version metadata."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
