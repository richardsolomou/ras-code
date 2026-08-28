import type { EnvironmentId, ProviderInstanceId, ProviderRemoteModel } from "@ras-code/contracts";
import { runAtomCommand } from "@ras-code/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { describeRemoteModelsError } from "../components/settings/providerGateway.logic";
import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { providerModelsEnvironment } from "../state/providerModels";

/**
 * Ask an instance's configured gateway for its model catalog. Resolves to
 * `null` after showing the reason as a toast, so callers only decide
 * whether to continue.
 */
export async function listGatewayModels(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}): Promise<ReadonlyArray<ProviderRemoteModel> | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    providerModelsEnvironment.listRemoteModels,
    { environmentId: input.environmentId, input: { instanceId: input.instanceId } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") {
    toastManager.add({
      type: "error",
      title: "Could not load gateway models",
      description: describeRemoteModelsError(Cause.squash(result.cause)),
    });
    return null;
  }
  return result.value.models;
}
