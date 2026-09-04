#!/usr/bin/env node

/**
 * Rewrites upstream (T3 Code) vocabulary into ours.
 *
 * `--patch` reads a unified diff on stdin, maps its paths and rebrands its body, and writes the
 * result to stdout, so an upstream patch applies against our tree. Otherwise it rewrites the named
 * files in place, which is what the sync skill runs over the files a cherry-pick left conflicted.
 *
 * The substitution table lives in `lib/upstreamRebrandMap.ts`. It is assistive, not authoritative:
 * whatever it cannot decide is reported as a residual token for a human to resolve.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { findResidualBrandTokens, rebrandPatch, rebrandText } from "./lib/upstreamRebrandMap.ts";

const readStdin = Effect.promise(async () => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
});

const reportResiduals = Effect.fn("reportResiduals")(function* (label: string, text: string) {
  const residuals = findResidualBrandTokens(text);
  if (residuals.length === 0) {
    return;
  }
  const tokens = [...new Set(residuals.map((residual) => residual.token))].sort();
  yield* Console.error(`${label}: ${residuals.length} residual brand tokens: ${tokens.join(", ")}`);
});

export const runRebrandPatch = Effect.fn("runRebrandPatch")(function* () {
  const patch = yield* readStdin;
  const rebranded = rebrandPatch(patch);
  yield* reportResiduals("stdin", rebranded);
  process.stdout.write(rebranded);
});

/**
 * The rebrand tooling names upstream on purpose: every rule's pattern, every
 * fixture, and this file's own description are upstream spellings, so rewriting
 * them silently breaks the map.
 */
const isRebrandToolingPath = (path: string) =>
  /(?:^|\/)scripts\/(?:upstream-rebrand\.ts|lib\/upstreamRebrandMap(?:\.test)?\.ts)$/.test(path);

export const runRebrandFiles = Effect.fn("runRebrandFiles")(function* (
  paths: ReadonlyArray<string>,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const path of paths) {
    if (isRebrandToolingPath(path)) {
      yield* Console.log(`${path}: skipped, the rebrand tooling names upstream on purpose`);
      continue;
    }
    if (!(yield* fs.exists(path))) {
      // File lists come from commit diffs, which name paths the pick deleted.
      yield* Console.log(`${path}: skipped, no longer present`);
      continue;
    }
    const original = yield* fs.readFileString(path);
    const rebranded = rebrandText(original);
    yield* reportResiduals(path, rebranded);
    if (rebranded === original) {
      yield* Console.log(`${path}: unchanged`);
      continue;
    }
    if (!dryRun) {
      yield* fs.writeFileString(path, rebranded);
    }
    yield* Console.log(`${path}: rebranded${dryRun ? " (dry run)" : ""}`);
  }
});

const upstreamRebrandCommand = Command.make(
  "upstream-rebrand",
  {
    patch: Flag.boolean("patch").pipe(
      Flag.withDescription("Read a unified diff on stdin and write the rebranded diff to stdout."),
      Flag.withDefault(false),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Report what would change without writing files."),
      Flag.withDefault(false),
    ),
    paths: Argument.string("file").pipe(
      Argument.withDescription("Files to rewrite in place."),
      Argument.variadic(),
    ),
  },
  ({ patch, dryRun, paths }) => (patch ? runRebrandPatch() : runRebrandFiles(paths, dryRun)),
).pipe(Command.withDescription("Rewrite upstream vocabulary into RAS Code vocabulary."));

if (import.meta.main) {
  Command.run(upstreamRebrandCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
