// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, vi } from "vitest";
import registerActivityDiscovery from "../activity-discovery";

type ToolDef = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<any>;
};

function getTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  registerActivityDiscovery({
    registerTool: (tool: ToolDef) => {
      tools[tool.name] = tool;
    },
  } as any);
  return tools;
}

function successfulFetch(body: unknown = { data: [] }) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.SCREENPIPE_LOCAL_API_URL;
const originalApiPort = process.env.SCREENPIPE_LOCAL_API_PORT;
const originalApiKey = process.env.SCREENPIPE_LOCAL_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.SCREENPIPE_LOCAL_API_URL;
  else process.env.SCREENPIPE_LOCAL_API_URL = originalApiUrl;
  if (originalApiPort === undefined)
    delete process.env.SCREENPIPE_LOCAL_API_PORT;
  else process.env.SCREENPIPE_LOCAL_API_PORT = originalApiPort;
  if (originalApiKey === undefined) delete process.env.SCREENPIPE_LOCAL_API_KEY;
  else process.env.SCREENPIPE_LOCAL_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe("activity discovery extension", () => {
  it("registers only the five dedicated read tools", () => {
    expect(Object.keys(getTools()).sort()).toEqual([
      "activity_search",
      "activity_summary",
      "frame_context",
      "keyword_search",
      "search_content",
    ]);
  });

  it("searches stable Activity Ledger records through the authenticated API", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://127.0.0.1:43991/";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = successfulFetch();
    globalThis.fetch = fetchMock as any;

    await getTools().activity_search.execute(
      "call-1",
      {
        q: "MRR",
        start_time: "30d ago",
        end_time: "now",
        limit: 999,
        offset: -4,
        order: "ascending",
      },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, options] = fetchMock.mock.calls[0] as any;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe("http://127.0.0.1:43991");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("content_type")).toBe("activity");
    expect(url.searchParams.get("q")).toBe("MRR");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("order")).toBe("ascending");
    // `/search` returns dotted field projections as flat keys. Discovery needs
    // the normal nested Activity shape so the trace can audit stable IDs and
    // frame evidence.
    expect(url.searchParams.get("fields")).toBeNull();
    expect(options.method).toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer local-secret");
    expect(options.headers["X-Screenpipe-Client"]).toBe("api");
  });

  it("keeps official nested evidence shapes instead of dotted projections", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      const projected = url.searchParams.has("fields");
      const isActivity = url.searchParams.get("content_type") === "activity";
      const data = isActivity
        ? projected
          ? [
              {
                type: "Activity",
                "content.id": "activity-1",
                "content.evidence": [{ frameId: 41 }],
              },
            ]
          : [
              {
                type: "Activity",
                content: {
                  id: "activity-1",
                  evidence: [{ frameId: 41 }],
                },
              },
            ]
        : projected
          ? [
              {
                type: "Accessibility",
                "content.frame_id": 42,
                "content.app_name": "Arc",
              },
            ]
          : [
              {
                type: "Accessibility",
                content: { frame_id: 42, app_name: "Arc" },
              },
            ];
      return new Response(JSON.stringify({ data, pagination: { total: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as any;
    const tools = getTools();

    const activity = await tools.activity_search.execute(
      "call-nested-activity",
      { start_time: "30d ago", end_time: "now" },
      new AbortController().signal,
    );
    const screen = await tools.search_content.execute(
      "call-nested-screen",
      { q: "Stripe", start_time: "30d ago", end_time: "now" },
      new AbortController().signal,
    );

    expect(JSON.parse(activity.content[0].text).data[0]).toEqual({
      type: "Activity",
      content: {
        id: "activity-1",
        evidence: [
          { activity_id: "activity-1", frame_id: 41, app_name: null },
        ],
      },
    });
    expect(JSON.parse(screen.content[0].text).data[0]).toEqual({
      type: "Accessibility",
      content: {
        frame_id: 42,
        app_name: "Arc",
        browser_url: null,
        text: "",
        text_truncated: false,
      },
    });
    for (const [rawUrl] of fetchMock.mock.calls) {
      expect(new URL(String(rawUrl)).searchParams.has("fields")).toBe(false);
    }
  });

  it("keeps broad Activity reads lean while retaining pagination metadata", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      const offset = Number(url.searchParams.get("offset"));
      const returned = offset === 0 ? 30 : 15;
      return new Response(
        JSON.stringify({
          data: Array.from({ length: returned }, (_, index) => ({
            type: "Activity",
            content: {
              id: `activity-${offset + index}`,
              evidence: [
                {
                  frame_id: offset + index + 1,
                  at: "2026-08-30T10:00:00Z",
                  app_name: "Arc",
                  label: "Activity evidence",
                },
              ],
            },
          })),
          pagination: { limit: 30, offset, total: 45 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    globalThis.fetch = fetchMock as any;
    const activitySearch = getTools().activity_search;

    const first = await activitySearch.execute(
      "call-page-1",
      { start_time: "30d ago", end_time: "now", order: "ascending" },
      new AbortController().signal,
    );
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const firstBody = JSON.parse(first.content[0].text);
    expect(firstUrl.searchParams.get("limit")).toBe("30");
    expect(firstUrl.searchParams.get("offset")).toBe("0");
    expect(firstBody.pagination).toMatchObject({
      limit: 30,
      offset: 0,
      total: 45,
      returned: 30,
      scanned: 30,
      hasMore: true,
      nextOffset: 30,
    });

    const last = await activitySearch.execute(
      "call-page-2",
      {
        start_time: "30d ago",
        end_time: "now",
        limit: 30,
        offset: firstBody.pagination.nextOffset,
        order: "ascending",
      },
      new AbortController().signal,
    );
    const lastUrl = new URL(String(fetchMock.mock.calls[1][0]));
    const lastBody = JSON.parse(last.content[0].text);
    expect(lastUrl.searchParams.get("offset")).toBe("30");
    expect(lastBody.pagination).toMatchObject({
      limit: 30,
      offset: 30,
      total: 45,
      returned: 15,
      scanned: 15,
      hasMore: false,
      nextOffset: null,
    });

    const schema = (activitySearch as any).parameters.properties.limit;
    expect(schema.default).toBe(30);
    expect(schema.maximum).toBe(50);
    expect(schema.description).toContain("focused searches");
  });

  it("does not offer Activity rows that cannot map an ID to screen evidence", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    globalThis.fetch = successfulFetch({
      data: [
        {
          type: "Activity",
          content: {
            id: "audio-only",
            title: "Discussed revenue",
            evidence: [{ frame_id: null, meeting_id: 9 }],
          },
        },
        {
          type: "Activity",
          content: {
            id: "screen-backed",
            title: "Reviewed revenue",
            evidence: [{ frame_id: 91, app_name: "Arc" }],
          },
        },
      ],
      pagination: { limit: 30, offset: 0, total: 2 },
    }) as any;

    const result = await getTools().activity_search.execute(
      "screen-backed-only",
      { q: "revenue" },
      new AbortController().signal,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].content.id).toBe("screen-backed");
    expect(body.data[0].content.evidence[0]).toMatchObject({
      activity_id: "screen-backed",
      frame_id: 91,
    });
    expect(body.pagination).toMatchObject({ returned: 1, scanned: 2 });
  });

  it("omits Activity rows without a stable ID", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    globalThis.fetch = successfulFetch({
      data: [
        {
          type: "Activity",
          content: { evidence: [{ frame_id: 91, app_name: "Arc" }] },
        },
      ],
      pagination: { limit: 30, offset: 0, total: 1 },
    }) as any;

    const result = await getTools().activity_search.execute(
      "stable-id-only",
      { q: "revenue" },
      new AbortController().signal,
    );
    expect(JSON.parse(result.content[0].text).data).toEqual([]);
  });

  it("serializes local API reads when the model requests tools in parallel", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    let releaseFirst: (() => void) | undefined;
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return new Response(JSON.stringify({ data: [], pagination: { total: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as any;
    const tools = getTools();

    const first = tools.activity_search.execute(
      "parallel-1",
      { q: "first" },
      new AbortController().signal,
    );
    const second = tools.search_content.execute(
      "parallel-2",
      { q: "second" },
      new AbortController().signal,
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst?.();
    }
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds frame context while retaining authoritative attribution", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const text = `${"before ".repeat(900)}Stripe revenue dashboard${" after".repeat(900)}`;
    globalThis.fetch = successfulFetch({
      frame_id: 42,
      timestamp: "2026-08-30T10:00:00Z",
      app_name: "Arc",
      window_name: "Stripe — MRR",
      browser_url: "https://dashboard.stripe.com/metrics",
      focused: true,
      text,
      nodes: Array.from({ length: 500 }, () => ({ role: "button" })),
      urls: ["https://dashboard.stripe.com/metrics"],
      text_source: "accessibility",
    }) as any;

    const result = await getTools().frame_context.execute(
      "frame-1",
      { frame_id: 42, q: "Review Stripe MRR" },
      new AbortController().signal,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      frame_id: 42,
      app_name: "Arc",
      window_name: "Stripe — MRR",
      focused: true,
      text_truncated: true,
    });
    expect(body).not.toHaveProperty("nodes");
    expect(body.text.length).toBeLessThanOrEqual(8_000);
    expect(body.text).toContain("Stripe revenue dashboard");
  });

  it("keeps screen searches focused and rejects non-screen content types", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = successfulFetch();
    globalThis.fetch = fetchMock as any;

    await getTools().search_content.execute(
      "call-2",
      { q: "Stripe", content_type: "audio", order: "descending" },
      new AbortController().signal,
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("content_type")).toBe("accessibility");
    expect(url.searchParams.get("focused")).toBe("true");
    expect(url.searchParams.get("on_screen")).toBe("true");
    expect(url.searchParams.get("start_time")).toBe("30d ago");
    expect(url.searchParams.get("end_time")).toBe("now");
    expect(url.searchParams.get("order")).toBe("descending");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("fields")).toBeNull();
  });

  it("maps keyword tool names to the official endpoint parameters", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = successfulFetch([]);
    globalThis.fetch = fetchMock as any;

    await getTools().keyword_search.execute(
      "call-3",
      { q: "monthly recurring", app_name: "Arc", fuzzy_match: true },
      new AbortController().signal,
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/search/keyword");
    expect(url.searchParams.get("query")).toBe("monthly recurring");
    expect(url.searchParams.get("q")).toBeNull();
    expect(url.searchParams.get("app_names")).toBe("Arc");
    expect(url.searchParams.get("fuzzy_match")).toBe("true");
  });

  it("bounds keyword evidence without dropping frame attribution", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    globalThis.fetch = successfulFetch([
      {
        frame_id: 91,
        timestamp: "2026-08-30T10:00:00Z",
        app_name: "Arc",
        window_name: "Stripe — MRR",
        url: "https://dashboard.stripe.com/metrics",
        confidence: 0.9,
        text: `${"before ".repeat(500)}monthly recurring revenue${" after".repeat(500)}`,
        text_source: "accessibility",
        text_positions: Array.from({ length: 500 }, () => 1),
      },
    ]) as any;

    const result = await getTools().keyword_search.execute(
      "keyword-bounded",
      { q: "monthly recurring revenue" },
      new AbortController().signal,
    );
    const [item] = JSON.parse(result.content[0].text);
    expect(item).toMatchObject({
      frame_id: 91,
      app_name: "Arc",
      window_name: "Stripe — MRR",
      text_truncated: true,
    });
    expect(item).not.toHaveProperty("text_positions");
    expect(item.text.length).toBeLessThanOrEqual(1_600);
    expect(item.text).toContain("monthly recurring revenue");
  });

  it("uses only a validated positive ID for frame context", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = successfulFetch();
    globalThis.fetch = fetchMock as any;

    await getTools().frame_context.execute(
      "call-4",
      { frame_id: 42 },
      new AbortController().signal,
    );
    const validUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(validUrl.pathname).toBe("/frames/42/context");

    const invalid = await getTools().frame_context.execute(
      "call-5",
      { frame_id: "42/../../raw_sql" },
      new AbortController().signal,
    );
    expect(invalid.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses non-loopback API URLs and missing authentication", async () => {
    process.env.SCREENPIPE_LOCAL_API_URL = "https://example.com";
    process.env.SCREENPIPE_LOCAL_API_KEY = "local-secret";
    const fetchMock = successfulFetch();
    globalThis.fetch = fetchMock as any;

    const remote = await getTools().activity_summary.execute(
      "call-6",
      {},
      new AbortController().signal,
    );
    expect(remote.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.SCREENPIPE_LOCAL_API_URL = "http://localhost:3030";
    delete process.env.SCREENPIPE_LOCAL_API_KEY;
    const unauthenticated = await getTools().activity_summary.execute(
      "call-7",
      {},
      new AbortController().signal,
    );
    expect(unauthenticated.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
