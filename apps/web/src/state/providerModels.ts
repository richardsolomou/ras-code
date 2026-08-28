import { WS_METHODS } from "@ras-code/contracts";
import { createEnvironmentRpcCommand } from "@ras-code/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerModelsEnvironment = {
  listRemoteModels: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:provider:list-remote-models",
    tag: WS_METHODS.providerListRemoteModels,
  }),
};
