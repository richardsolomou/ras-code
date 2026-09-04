import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "identifies the %s harness and describes media embedding",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(`running in RAS Code through the ${harness} harness.`);
      expect(instructions).toContain("embed images and videos");
      expect(instructions).toContain("inside the project directory");
      expect(instructions).not.toContain("undefined");
    },
  );

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names a resolved model as the identifier to report", () => {
    expect(buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.1-codex" })).toContain(
      'The active model identifier is "gpt-5.1-codex"',
    );
  });

  it("claims no model identifier when none resolved", () => {
    expect(buildRuntimeInstructions({ harness: "Cursor", model: "auto" })).not.toContain(
      "active model identifier",
    );
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
