import { describe, expect, it } from "vite-plus/test";
import { EventId } from "@t3tools/contracts";

import { derivePendingFallbackOfferCountFromActivities } from "./ProjectionPipeline.ts";

const activity = (
  kind: string,
  requestId: string,
  activityId: string,
  createdAt = `2026-08-30T00:00:0${activityId}.000Z`,
) => ({
  activityId: EventId.make(activityId),
  createdAt,
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

  it("clears an accepted offer when the response clock is behind", () => {
    expect(
      derivePendingFallbackOfferCountFromActivities([
        activity("provider.fallback.engaged", "request-1", "2", "2026-08-29T23:59:59.000Z"),
        activity("provider.fallback.offered", "request-1", "1", "2026-08-30T00:00:00.000Z"),
      ]),
    ).toBe(0);
  });
});
