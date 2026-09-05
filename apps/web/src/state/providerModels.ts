import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerModelsEnvironment = {
  listRemoteModels: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:provider:list-remote-models",
    tag: WS_METHODS.providerListRemoteModels,
  }),
};
