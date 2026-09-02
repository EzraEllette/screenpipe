// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { buildActivitySearchResult } from "./activity-search-tool";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

describe("activity-search tool", () => {
  it("forces Activity search and preserves stable evidence references", async () => {
    const endpoints: string[] = [];
    const result = await buildActivitySearchResult(
      {
        q: "revenue",
        content_type: "ocr",
        start_time: "2026-08-01T00:00:00Z",
        end_time: "2026-09-01T00:00:00Z",
        limit: 10,
        order: "ascending",
      },
      async (endpoint) => {
        endpoints.push(endpoint);
        return jsonResponse({
          data: [
            {
              type: "Activity",
              content: {
                id: "activity-review-revenue-2026-08-12",
                producer: "activity-history-pi-v9",
                kind: "work_session",
                start_at: "2026-08-12T15:00:00Z",
                end_at: "2026-08-12T15:08:00Z",
                title: "Reviewed revenue metrics",
                summary: "Compared current revenue across two analytics products.",
                evidence: [
                  {
                    kind: "frame",
                    at: "2026-08-12T15:02:00Z",
                    frame_id: 912,
                    app_name: "Arc",
                    label: "Stripe MRR dashboard",
                  },
                ],
              },
            },
          ],
          pagination: { total: 3, offset: 0 },
        });
      },
    );

    const url = new URL(endpoints[0], "http://screenpipe.local");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("content_type")).toBe("activity");
    expect(url.searchParams.get("q")).toBe("revenue");
    expect(url.searchParams.get("order")).toBe("ascending");
    expect(result.hasResults).toBe(true);
    expect(result.text).toContain("[Activity activity-review-revenue-2026-08-12]");
    expect(result.text).toContain(
      "pair these frames only with this Activity ID",
    );
    expect(result.text).toContain("2026-08-12T15:02:00Z | Arc | frame:912");
    expect(result.text).toContain("use offset=1 for more");
  });

  it("returns an actionable empty result", async () => {
    const result = await buildActivitySearchResult(
      {
        start_time: "2026-08-01T00:00:00Z",
        end_time: "2026-09-01T00:00:00Z",
      },
      async () => jsonResponse({ data: [], pagination: { total: 0, offset: 0 } }),
    );

    expect(result.hasResults).toBe(false);
    expect(result.text).toContain("wider time range");
  });
});
