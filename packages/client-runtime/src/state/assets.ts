import { AssetResource, EnvironmentId, WS_METHODS } from "@ras-code/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedErrorClass<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

/**
 * Why an asset URL could not be issued, in the terms a reader cares about.
 * A dead "unavailable" chip sends people hunting through server logs, and the
 * most common cause -- a file written outside the project folder, often on a
 * machine the client is not even running on -- is invisible without this.
 */
export type AssetUrlFailureReason =
  | "outside-project"
  | "not-found"
  | "unsupported-type"
  | "unavailable";

const ASSET_FAILURE_REASON_BY_TAG: Record<string, AssetUrlFailureReason> = {
  AssetWorkspaceAssetOutsideRootError: "outside-project",
  AssetWorkspacePathValidationError: "outside-project",
  AssetWorkspaceAssetNotFoundError: "not-found",
  AssetAttachmentNotFoundError: "not-found",
  AssetProjectFaviconNotFoundError: "not-found",
  AssetPreviewTypeValidationError: "unsupported-type",
};

/** Reads the failure reason out of a create-url rejection. */
export function assetUrlFailureReason(cause: Cause.Cause<unknown>): AssetUrlFailureReason {
  const error: unknown = Cause.squash(cause);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? (error as { readonly _tag: unknown })._tag
      : null;
  return (typeof tag === "string" ? ASSET_FAILURE_REASON_BY_TAG[tag] : undefined) ?? "unavailable";
}

/** Short, user-facing text for an image that could not be loaded. */
export function assetUrlFailureLabel(reason: AssetUrlFailureReason): string {
  switch (reason) {
    case "outside-project":
      return "Image is outside the project folder";
    case "not-found":
      return "Image not found";
    case "unsupported-type":
      return "Unsupported image type";
    case "unavailable":
      return "Image unavailable";
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl).toString();
  } catch {
    try {
      return environmentEndpointUrl(httpBaseUrl, relativeUrl);
    } catch {
      return null;
    }
  }
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const createUrl = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    tag: WS_METHODS.assetsCreateUrl,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}
