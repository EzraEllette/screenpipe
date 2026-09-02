// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";

import { activityOpportunityErrorKind } from "./activity-opportunities";

describe("activity opportunity analytics", () => {
  it("classifies the native optimistic-concurrency response without emitting it", () => {
    expect(
      activityOpportunityErrorKind(
        new Error("Opportunity changed; reload it before installing the skill"),
      ),
    ).toBe("conflict");
  });
});
