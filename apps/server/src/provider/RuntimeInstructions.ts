/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  // A gateway can route a request to a model the harness never names, so the
  // agent has to be told the identifier rather than left to report its own.
  const identityInfo = modelInfo
    ? ` The active model identifier is "${model}". If the user asks which model is running, answer with this exact identifier. Do not say that the model identifier is unavailable.`
    : "";
  return `<runtime_info>In case you're asked: you are running in RAS Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise.${identityInfo} You can embed images and videos in your response using Markdown, and the reader sees them only when the file lives inside the project directory.</runtime_info>`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
