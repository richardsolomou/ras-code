import { describe, expect, it } from "@effect/vitest";

import {
  MAX_TRANSCRIPT_CHARACTERS,
  renderForkTranscript,
  withForkTranscript,
  withProviderSwitchTranscript,
} from "./forkTranscript.ts";

describe("renderForkTranscript", () => {
  it("returns undefined when there is nothing to hand over", () => {
    expect(renderForkTranscript([])).toBeUndefined();
    expect(renderForkTranscript([{ role: "user", text: "   " }])).toBeUndefined();
  });

  it("renders the prefix as a labelled context block", () => {
    const transcript = renderForkTranscript([
      { role: "user", text: "add a button" },
      { role: "assistant", text: "added it" },
    ]);
    expect(transcript).toContain("<forked-conversation>");
    expect(transcript).toContain("### User\nadd a button");
    expect(transcript).toContain("### Assistant\nadded it");
    expect(transcript).toContain("</forked-conversation>");
    expect(transcript).not.toContain("dropped to fit");
  });

  it("drops the oldest messages first when the prefix is too long", () => {
    // Two of these cannot both fit at any budget.
    const long = "x".repeat(MAX_TRANSCRIPT_CHARACTERS - 100);
    const transcript = renderForkTranscript([
      { role: "user", text: `oldest ${long}` },
      { role: "assistant", text: `newest ${long}` },
    ]);
    expect(transcript).toContain("dropped to fit");
    expect(transcript).toContain("newest");
    expect(transcript).not.toContain("oldest");
  });

  it("carries a long conversation whole rather than its tail", () => {
    // An ordinary long thread, the size the budget exists to carry whole.
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${index} ${"detail ".repeat(100)}`,
    }));
    const transcript = renderForkTranscript(messages);
    expect(transcript).toContain("turn 0 ");
    expect(transcript).not.toContain("dropped to fit");
  });

  it("leaves the message untouched when there is no inherited history", () => {
    expect(withForkTranscript({ messageText: "go", inheritedMessages: [] })).toBe("go");
  });

  it("prepends the transcript to the fork's opening prompt", () => {
    const prompt = withForkTranscript({
      messageText: "try it another way",
      inheritedMessages: [{ role: "user", text: "add a button" }],
    });
    expect(prompt.endsWith("try it another way")).toBe(true);
    expect(prompt.indexOf("add a button")).toBeLessThan(prompt.indexOf("try it another way"));
  });

  it("labels a provider switch without repeating the current message", () => {
    const prompt = withProviderSwitchTranscript({
      messageText: "continue",
      priorMessages: [
        { role: "user", text: "inspect the bug" },
        { role: "assistant", text: "I found it" },
      ],
    });
    expect(prompt).toContain("<provider-switch-conversation>");
    expect(prompt.match(/continue/g)).toHaveLength(1);
  });
});
