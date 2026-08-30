import { describe, expect, it } from "vite-plus/test";
import { EventId } from "@ras-code/contracts";

import { derivePendingFallbackOfferCountFromActivities } from "./ProjectionPipeline.ts";

const activity = (kind: string, requestId: string, activityId: string) => ({
  activityId: EventId.make(activityId),
  createdAt: `2026-08-30T00:00:0${activityId}.000Z`,
  kind,
  payload: { requestId },
});

describe("fallback offer shell state", () => {
  it("counts unanswered offers as pending approvals", () => {
    expect(
      derivePendingFallbackOfferCountFromActivities([
        activity("provider.fallback.offered", "request-1", "1"),
      ]),
    ).toBe(1);
  });

  it.each([
    "provider.fallback.engaged",
    "provider.fallback.declined",
    "provider.fallback.offer-expired",
  ])("clears an offer after %s", (kind) => {
    expect(
      derivePendingFallbackOfferCountFromActivities([
        activity("provider.fallback.offered", "request-1", "1"),
        activity(kind, "request-1", "2"),
      ]),
    ).toBe(0);
  });
});
