import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ProviderRemoteModel,
} from "@ras-code/contracts";
import { runAtomCommand } from "@ras-code/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { describeRemoteModelsError } from "../components/settings/providerGateway.logic";
import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { providerModelsEnvironment } from "../state/providerModels";
import { serverEnvironment } from "../state/server";

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

/**
 * Create the instance, then read its gateway's catalog.
 *
 * The two steps cannot be merged: the gateway key only becomes usable
 * server-side once the settings write has stored it as a secret, and the
 * catalog lookup reads it back from there. `models: null` means the
 * instance exists but the lookup failed — the user can retry from its
 * Models tab.
 */
export async function createGatewayProviderInstance(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly existingInstances: ProviderInstanceConfigMap;
}): Promise<{ readonly created: boolean; readonly models: ReadonlyArray<ProviderRemoteModel> }> {
  const written = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    {
      environmentId: input.environmentId,
      input: {
        patch: {
          providerInstances: { ...input.existingInstances, [input.instanceId]: input.instance },
        },
      },
    },
    { reportFailure: false },
  );
  if (written._tag !== "Success") {
    return { created: false, models: [] };
  }

  const models = await listGatewayModels({
    environmentId: input.environmentId,
    instanceId: input.instanceId,
  });
  return { created: true, models: models ?? [] };
}
