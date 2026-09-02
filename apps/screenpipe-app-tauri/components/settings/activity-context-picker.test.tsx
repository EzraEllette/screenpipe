// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityHistoryEntry } from "@/lib/activity-review-prompt";
import {
  ActivityContextPicker,
  activityMatchesQuery,
  buildActivitySearchContext,
} from "./activity-context-picker";

const mocks = vi.hoisted(() => ({
  getActivityHistory: vi.fn(),
  activityHistoryUpdated: null as null | (() => void),
}));

vi.mock("@/lib/utils/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/tauri")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getActivityHistory: mocks.getActivityHistory,
    },
  };
});

vi.mock("@/lib/hooks/use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: () => void) => {
    if (event === "activity-history-updated") {
      mocks.activityHistoryUpdated = handler;
    }
  },
}));

vi.mock("@/lib/notifications/app-server", () => ({
  getAppServerBaseUrl: vi.fn(async () => "http://localhost:11435"),
}));

const STRIPE_ACTIVITY: ActivityHistoryEntry = {
  id: "check-mrr",
  kind: "work",
  meeting_id: null,
  start_at: "2026-08-30T17:29:20.000Z",
  end_at: "2026-08-30T17:31:05.000Z",
  title: "Check recurring revenue",
  summary: "Compared current MRR in Stripe with the PostHog dashboard.",
  evidence: [
    {
      kind: "screen",
      at: "2026-08-30T17:30:00.000Z",
      frame_id: 42,
      meeting_id: null,
      app_name: "Stripe",
      label: "Revenue overview",
    },
    {
      kind: "screen",
      at: "2026-08-30T17:30:40.000Z",
      frame_id: 43,
      meeting_id: null,
      app_name: "PostHog",
      label: "Revenue dashboard",
    },
  ],
};

const REVIEW_ACTIVITY: ActivityHistoryEntry = {
  id: "review-pr",
  kind: "work",
  meeting_id: null,
  start_at: "2026-08-31T18:00:00.000Z",
  end_at: "2026-08-31T18:20:00.000Z",
  title: "Review a pull request",
  summary: "Checked a focused patch and wrote review findings.",
  evidence: [
    {
      kind: "screen",
      at: "2026-08-31T18:04:00.000Z",
      frame_id: 84,
      meeting_id: null,
      app_name: "Arc",
      label: "GitHub pull request",
    },
  ],
};

function historyResult(entries: ActivityHistoryEntry[]) {
  return {
    status: "ok" as const,
    data: { entries, coverage: [] },
  };
}

beforeEach(() => {
  mocks.activityHistoryUpdated = null;
  mocks.getActivityHistory.mockReset();
  mocks.getActivityHistory.mockResolvedValue(
    historyResult([STRIPE_ACTIVITY, REVIEW_ACTIVITY]),
  );
});

describe("activity history context", () => {
  it("keeps the generated activity interval and evidence frames", () => {
    expect(
      buildActivitySearchContext("  stripe mrr ", STRIPE_ACTIVITY),
    ).toEqual({
      source: "activity-history",
      query: "stripe mrr",
      startAt: "2026-08-30T17:29:20.000Z",
      endAt: "2026-08-30T17:31:05.000Z",
      frameIds: [42, 43],
      representativeFrameId: 42,
      representativeTimestamp: "2026-08-30T17:30:00.000Z",
      appName: "Stripe",
      windowName: "Check recurring revenue",
      snippet: "Compared current MRR in Stripe with the PostHog dashboard.",
      url: "",
      activity: STRIPE_ACTIVITY,
    });
  });

  it("matches human activity text and source evidence", () => {
    expect(activityMatchesQuery(STRIPE_ACTIVITY, "recurring PostHog")).toBe(
      true,
    );
    expect(activityMatchesQuery(REVIEW_ACTIVITY, "github arc")).toBe(true);
    expect(activityMatchesQuery(REVIEW_ACTIVITY, "stripe")).toBe(false);
  });
});

describe("ActivityContextPicker", () => {
  it("searches generated activities and returns the selected full activity", async () => {
    const onSelect = vi.fn();
    render(<ActivityContextPicker onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "add activity" }));

    expect(screen.getByRole("dialog")).toHaveClass("ph-no-capture");
    await waitFor(() => expect(mocks.getActivityHistory).toHaveBeenCalled());
    const input = screen.getByRole("textbox", { name: "search activities" });
    expect(await screen.findByText("type to search activities")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Review a pull request" }),
    ).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "stripe mrr" } });

    expect(
      await screen.findByRole("heading", { name: "Check recurring revenue" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Compared current MRR in Stripe with the PostHog dashboard.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Review a pull request" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: /Open Stripe .* in Timeline/i,
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Add Check recurring revenue" }),
    );

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "activity-history",
          query: "stripe mrr",
          startAt: STRIPE_ACTIVITY.start_at,
          endAt: STRIPE_ACTIVITY.end_at,
          frameIds: [42, 43],
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("refreshes the open list when activity generation finishes", async () => {
    render(<ActivityContextPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "add activity" }));
    await waitFor(() =>
      expect(mocks.getActivityHistory).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      mocks.activityHistoryUpdated?.();
    });

    await waitFor(() =>
      expect(mocks.getActivityHistory).toHaveBeenCalledTimes(2),
    );
  });

  it("does not let an older load overwrite a completed refresh", async () => {
    let resolveInitial:
      ((value: ReturnType<typeof historyResult>) => void) | undefined;
    let resolveRefresh:
      ((value: ReturnType<typeof historyResult>) => void) | undefined;
    mocks.getActivityHistory
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    render(<ActivityContextPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "add activity" }));
    await waitFor(() =>
      expect(mocks.getActivityHistory).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      mocks.activityHistoryUpdated?.();
    });
    await waitFor(() =>
      expect(mocks.getActivityHistory).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      resolveRefresh?.(historyResult([REVIEW_ACTIVITY]));
    });
    await act(async () => {
      resolveInitial?.(historyResult([STRIPE_ACTIVITY]));
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "search activities" }),
      { target: { value: "review" } },
    );

    expect(
      await screen.findByRole("heading", { name: "Review a pull request" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Check recurring revenue" }),
    ).not.toBeInTheDocument();
  });
});
