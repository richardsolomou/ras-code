import { useAtomValue } from "@effect/atom-react";
import {
  assetUrlFailureReason,
  resolveAssetUrl,
  type AssetUrlFailureReason,
} from "@ras-code/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@ras-code/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@ras-code/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export {
  assetUrlFailureLabel,
  resolveAssetUrl,
  type AssetUrlFailureReason,
} from "@ras-code/client-runtime/state/assets";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly reason: AssetUrlFailureReason }
  | {
      readonly _tag: "Success";
      readonly url: string;
      readonly sourcePath?: string;
      readonly iconEmoji?: string;
    };

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
  );
  if (result._tag === "Failure") {
    return { _tag: "Failure", reason: assetUrlFailureReason(result.cause) };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null
    ? { _tag: "Failure", reason: "unavailable" }
    : {
        _tag: "Success",
        url,
        ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
        ...(result.value.iconEmoji !== undefined ? { iconEmoji: result.value.iconEmoji } : {}),
      };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
}

/** Re-mints an exact-file capability after a file change or an explicit retry. */
export function useAssetUrlRefresh(
  environmentId: EnvironmentId,
  resource: AssetResource,
): () => Promise<void> {
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }, [environmentId, resource, refresh]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
