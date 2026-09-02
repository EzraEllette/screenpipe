// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type {
  ActivityOpportunitySnapshot,
  HandoffActivityOpportunityRequest,
  InstallActivityOpportunitySkillDraftRequest,
  SaveActivityOpportunitySkillDraftRequest,
  StartActivityOpportunitySkillDraftRequest,
  UpdateActivityOpportunityRequest,
} from "@/lib/utils/tauri";
import type { ActivityHistoryEntry } from "@/lib/activity-review-prompt";
import { BrainOpportunities } from "../brain-opportunities";

const mocks = vi.hoisted(() => ({
  getActivityOpportunities: vi.fn(),
  updateActivityOpportunity: vi.fn(),
  createActivityOpportunitySkill: vi.fn(),
  startActivityOpportunitySkillDraft: vi.fn(),
  saveActivityOpportunitySkillDraft: vi.fn(),
  installActivityOpportunitySkillDraft: vi.fn(),
  setActivityOpportunitySkillEnabled: vi.fn(),
  handoffActivityOpportunity: vi.fn(),
  showChatWithPrefill: vi.fn(async () => null),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/utils/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/tauri")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getActivityOpportunities: mocks.getActivityOpportunities,
      updateActivityOpportunity: mocks.updateActivityOpportunity,
      createActivityOpportunitySkill: mocks.createActivityOpportunitySkill,
      startActivityOpportunitySkillDraft:
        mocks.startActivityOpportunitySkillDraft,
      saveActivityOpportunitySkillDraft:
        mocks.saveActivityOpportunitySkillDraft,
      installActivityOpportunitySkillDraft:
        mocks.installActivityOpportunitySkillDraft,
      setActivityOpportunitySkillEnabled:
        mocks.setActivityOpportunitySkillEnabled,
      handoffActivityOpportunity: mocks.handoffActivityOpportunity,
    },
  };
});

vi.mock("@/lib/hooks/use-tauri-event", () => ({
  useTauriEvent: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    mocks.eventHandlers.set(event, handler);
  },
}));

vi.mock("@/lib/chat-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-utils")>();
  return {
    ...actual,
    showChatWithPrefill: mocks.showChatWithPrefill,
  };
});

vi.mock("../activity-context-picker", () => ({
  ActivityContextPicker: ({
    onSelect,
    disabled,
  }: {
    onSelect: (context: {
      source: "activity-history";
      query: string;
      startAt: string;
      endAt: string;
      frameIds: number[];
      representativeFrameId: number;
      representativeTimestamp: string;
      appName: string;
      windowName: string;
      snippet: string;
      url: string;
      activity: ActivityHistoryEntry;
    }) => void | Promise<void>;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() =>
        void onSelect({
          source: "activity-history",
          query: "stripe mrr",
          startAt: "2026-08-22T17:00:00Z",
          endAt: "2026-08-22T17:05:00Z",
          frameIds: [7001, 7002],
          representativeFrameId: 7001,
          representativeTimestamp: "2026-08-22T17:02:00Z",
          appName: "Stripe",
          windowName: "Revenue overview",
          snippet: "Monthly recurring revenue and recent movement.",
          url: "https://dashboard.stripe.com/overview",
          activity: {
            id: "activity-stripe-mrr",
            kind: "work",
            meeting_id: null,
            start_at: "2026-08-22T17:00:00Z",
            end_at: "2026-08-22T17:05:00Z",
            title: "Revenue overview",
            summary: "Monthly recurring revenue and recent movement.",
            evidence: [
              {
                kind: "screen",
                at: "2026-08-22T17:02:00Z",
                frame_id: 7001,
                meeting_id: null,
                app_name: "Stripe",
                label: "Revenue overview",
              },
              {
                kind: "screen",
                at: "2026-08-22T17:04:00Z",
                frame_id: 7002,
                meeting_id: null,
                app_name: "PostHog",
                label: "Revenue dashboard",
              },
            ],
          },
        })
      }
    >
      add activity
    </button>
  ),
}));

function evidence(
  activityId: string,
  title: string,
  app: string,
  startAt: string,
  durationMinutes = 30,
) {
  return {
    activityId,
    startAt,
    endAt: new Date(
      new Date(startAt).getTime() + durationMinutes * 60_000,
    ).toISOString(),
    title,
    summary: `Source-backed evidence for ${title}.`,
    apps: [app],
    frameIds: [Number(activityId.replace(/\D/g, "")) || 1],
    meetingIds: [],
    excluded: false,
  };
}

function readySnapshot(): ActivityOpportunitySnapshot {
  return {
    analysisState: "ready",
    generatedAt: "2026-08-22T18:00:00Z",
    skills: [
      {
        id: "feedback-to-fix",
        revision: 1,
        status: "pending",
        name: "turn product feedback into a focused fix",
        description:
          "Trace a reported issue through reproduction, implementation, and review-ready evidence.",
        notes: "",
        blueprint: {
          trigger: "When product feedback needs a focused fix.",
          steps: ["Read the report", "Implement the fix", "Verify the result"],
          verification: "Attach direct acceptance evidence.",
        },
        occurrences: [
          { activityIds: ["activity-101"] },
          { activityIds: ["activity-102"] },
          { activityIds: ["activity-105"] },
        ],
        evidence: [
          evidence(
            "activity-101",
            "Review sample onboarding issue",
            "Slack",
            "2026-08-20T16:12:00Z",
          ),
          evidence(
            "activity-102",
            "Refine the activity ledger",
            "Cursor",
            "2026-08-20T17:04:00Z",
          ),
          evidence(
            "activity-105",
            "Verify the focused fix",
            "Arc",
            "2026-08-21T18:22:00Z",
          ),
        ],
        supportingContexts: [],
        drafts: [],
      },
      {
        id: "review-brief",
        revision: 1,
        status: "pending",
        name: "prepare a pull request review brief",
        description: "Turn a code change into a concise reviewer brief.",
        notes: "",
        blueprint: {
          trigger: "When a change is ready for review.",
          steps: ["Read the diff", "Match checks", "Write the brief"],
          verification: "Every claim maps to evidence.",
        },
        evidence: [
          evidence(
            "activity-103",
            "Review the Activity history diff",
            "Cursor",
            "2026-08-18T21:08:00Z",
          ),
        ],
        supportingContexts: [],
        drafts: [],
      },
      {
        id: "meeting-followups",
        revision: 1,
        status: "pending",
        name: "turn meeting decisions into follow-ups",
        description: "Extract decisions, owners, and next actions.",
        notes: "",
        blueprint: {
          trigger: "When a meeting ends with decisions.",
          steps: ["Review the meeting", "Assign owners", "Send the recap"],
          verification: "Every follow-up has an owner.",
        },
        evidence: [
          evidence(
            "activity-104",
            "Review product sync notes",
            "screenpipe",
            "2026-08-15T18:03:00Z",
          ),
        ],
        supportingContexts: [],
        drafts: [],
      },
    ],
    unfinished: [
      {
        id: "activity-review-flow",
        revision: 1,
        status: "pending",
        title: "finish the Activity ledger review flow",
        description:
          "Complete the empty, populated, and evidence-review states for the Activity ledger.",
        goal: "The Activity ledger is ready for a focused review.",
        leftOff: "The last visible step was a note about the empty state.",
        lastSeenAt: "2026-08-22T17:18:00Z",
        agentSteps: [
          "reopen the Activity ledger work",
          "verify empty and populated states",
          "prepare the review handoff",
        ],
        notes: "",
        evidence: [
          evidence(
            "activity-102",
            "Refine the activity ledger",
            "Cursor",
            "2026-08-20T17:04:00Z",
          ),
          evidence(
            "activity-105",
            "Inspect sample pull request",
            "Arc",
            "2026-08-20T18:29:00Z",
          ),
        ],
      },
      {
        id: "onboarding-reply",
        revision: 1,
        status: "pending",
        title: "close the onboarding issue thread",
        description: "Return to the onboarding report with a clear outcome.",
        goal: "",
        leftOff: "The Slack reply field contained a partial status update.",
        lastSeenAt: "2026-08-22T16:00:00Z",
        agentSteps: [
          "reopen the thread",
          "verify the outcome",
          "send the reply",
        ],
        notes: "",
        evidence: [
          evidence(
            "activity-101",
            "Review sample onboarding issue",
            "Slack",
            "2026-08-20T16:12:00Z",
          ),
        ],
      },
    ],
  };
}

function addCreatedSkill(
  snapshot: ActivityOpportunitySnapshot,
  enabled = true,
) {
  const skill = snapshot.skills[0];
  const installedDraft = {
    id: "installed-draft",
    conversationId: "skill-draft-installed",
    path: `/Users/screenpipe/.screenpipe/skill-drafts/${skill.id}/installed-draft/SKILL.md`,
    phase: "ready" as const,
    skillMd:
      '---\nname: "verified-fix"\ndescription: "Turn feedback into a verified fix."\n---\n\nFollow the repeated workflow.\n',
    startedAt: "2026-08-30T12:00:00Z",
    updatedAt: "2026-08-30T12:02:00Z",
    completedAt: "2026-08-30T12:02:00Z",
  };
  skill.status = "created";
  skill.name = "verified fix";
  skill.description = "Turn feedback into a verified fix.";
  skill.drafts = [installedDraft];
  skill.currentDraftId = installedDraft.id;
  skill.createdSkill = {
    key: "verified-fix",
    path: "/Users/screenpipe/.screenpipe/skills/verified-fix/SKILL.md",
    skillMd: installedDraft.skillMd,
    sha256: "a".repeat(64),
    createdAt: "2026-08-30T12:03:00Z",
    enabled,
    installedDraftId: installedDraft.id,
  } as never;
  return { skill, installedDraft };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

let backendSnapshot: ActivityOpportunitySnapshot;

function installStatefulCommands(snapshot: ActivityOpportunitySnapshot) {
  mocks.getActivityOpportunities.mockImplementation(async () => ({
    status: "ok",
    data: clone(snapshot),
  }));
  mocks.updateActivityOpportunity.mockImplementation(
    async (request: UpdateActivityOpportunityRequest) => {
      const items =
        request.kind === "skill" ? snapshot.skills : snapshot.unfinished;
      const item = items.find((candidate) => candidate.id === request.id);
      if (!item || item.revision !== request.revision) {
        return { status: "error", error: "revision mismatch" };
      }
      if (request.description !== undefined) {
        item.description = request.description ?? "";
      }
      if (request.notes !== undefined) item.notes = request.notes ?? "";
      if (request.excludedActivityIds !== undefined) {
        const excluded = new Set(request.excludedActivityIds ?? []);
        item.evidence = item.evidence.map((source) => ({
          ...source,
          excluded: excluded.has(source.activityId),
        }));
      }
      if (request.kind === "skill") {
        if (request.supportingContexts !== undefined) {
          item.supportingContexts = clone(request.supportingContexts);
        }
        if (request.name !== undefined) item.name = request.name ?? "";
        if (
          request.name !== undefined ||
          request.description !== undefined ||
          request.notes !== undefined ||
          request.excludedActivityIds !== undefined ||
          request.supportingContexts !== undefined
        ) {
          item.edited = true;
        }
      } else {
        if (request.goal !== undefined) item.goal = request.goal ?? "";
        if (request.agentSteps !== undefined) {
          item.agentSteps = request.agentSteps ?? [];
        }
      }
      if (request.dismissed !== undefined) {
        item.status = request.dismissed ? "dismissed" : "pending";
      }
      item.revision += 1;
      return { status: "ok", data: clone(snapshot) };
    },
  );
  mocks.createActivityOpportunitySkill.mockImplementation(
    async ({ id, revision }: { id: string; revision: number }) => {
      const skill = snapshot.skills.find((item) => item.id === id);
      if (!skill || skill.revision !== revision) {
        return { status: "error", error: "revision mismatch" };
      }
      const createdSkill = {
        path: `/Users/screenpipe/.screenpipe/skills/${id}/SKILL.md`,
        skillMd: `# ${skill.name}\n\n${skill.description}\n\n## Steps\n\n1. Read the source activities.`,
      };
      skill.status = "created";
      skill.createdSkill = createdSkill;
      skill.revision += 1;
      return { status: "ok", data: createdSkill };
    },
  );
  mocks.startActivityOpportunitySkillDraft.mockImplementation(
    async (request: StartActivityOpportunitySkillDraftRequest) => {
      const skill = snapshot.skills.find((item) => item.id === request.id);
      if (!skill || skill.revision !== request.revision) {
        return { status: "error", error: "revision mismatch" };
      }
      const existing = skill.drafts.find(
        (draft) =>
          draft.id === skill.currentDraftId && draft.phase === "running",
      );
      if (existing) return { status: "ok", data: clone(existing) };
      const draft = {
        id: `draft-${skill.drafts.length + 1}`,
        conversationId: `skill-draft-${skill.id}-${skill.drafts.length + 1}`,
        path: `/Users/screenpipe/.screenpipe/skill-drafts/${skill.id}/draft-${skill.drafts.length + 1}/SKILL.md`,
        phase: "running" as const,
        skillMd: "",
        startedAt: "2026-08-22T18:01:00Z",
        updatedAt: "2026-08-22T18:01:00Z",
      };
      skill.status = "drafting";
      skill.edited = true;
      skill.drafts.push(draft);
      skill.currentDraftId = draft.id;
      skill.revision += 1;
      return { status: "ok", data: clone(draft) };
    },
  );
  mocks.saveActivityOpportunitySkillDraft.mockImplementation(
    async (request: SaveActivityOpportunitySkillDraftRequest) => {
      const skill = snapshot.skills.find((item) => item.id === request.id);
      const draft = skill?.drafts.find(
        (candidate) => candidate.id === request.draftId,
      );
      if (!skill || !draft) {
        return { status: "error", error: "draft not found" };
      }
      draft.skillMd = request.skillMd;
      draft.phase = "ready";
      draft.updatedAt = "2026-08-22T18:02:00Z";
      skill.revision += 1;
      return { status: "ok", data: clone(draft) };
    },
  );
  mocks.installActivityOpportunitySkillDraft.mockImplementation(
    async (request: InstallActivityOpportunitySkillDraftRequest) => {
      const skill = snapshot.skills.find((item) => item.id === request.id);
      const draft = skill?.drafts.find(
        (candidate) => candidate.id === request.draftId,
      );
      if (!skill || !draft || skill.revision !== request.revision) {
        return { status: "error", error: "revision mismatch" };
      }
      const createdSkill = {
        path: `/Users/screenpipe/.screenpipe/skills/${skill.id}/SKILL.md`,
        skillMd: draft.skillMd,
      };
      skill.status = "created";
      skill.createdSkill = createdSkill;
      skill.revision += 1;
      return { status: "ok", data: clone(createdSkill) };
    },
  );
  mocks.setActivityOpportunitySkillEnabled.mockImplementation(
    async (request: { id: string; revision: number; enabled: boolean }) => {
      const skill = snapshot.skills.find((item) => item.id === request.id);
      if (!skill?.createdSkill || skill.revision !== request.revision) {
        return { status: "error", error: "revision mismatch" };
      }
      skill.createdSkill = {
        ...skill.createdSkill,
        enabled: request.enabled,
      } as never;
      skill.revision += 1;
      return { status: "ok", data: clone(skill.createdSkill) };
    },
  );
  mocks.handoffActivityOpportunity.mockImplementation(
    async (request: HandoffActivityOpportunityRequest) => {
      const task = snapshot.unfinished.find((item) => item.id === request.id);
      if (!task || task.revision !== request.revision) {
        return { status: "error", error: "revision mismatch" };
      }
      task.status = "handed_off";
      task.conversationId = request.conversationId;
      task.revision += 1;
      return { status: "ok", data: clone(task) };
    },
  );
}

beforeEach(() => {
  backendSnapshot = readySnapshot();
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.eventHandlers.clear();
  installStatefulCommands(backendSnapshot);
});

afterEach(() => cleanup());

describe("BrainOpportunities", () => {
  it("loads the persisted opportunity snapshot", async () => {
    const onCountChange = vi.fn();
    render(<BrainOpportunities onOpportunityCountChange={onCountChange} />);

    expect(screen.getByText("loading opportunities")).toBeTruthy();
    expect(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    ).toBeTruthy();
    expect(screen.getByTestId("opportunities-tab-ideas")).toHaveTextContent(
      "3",
    );
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(5));
  });

  it("ranks skills by occurrences instead of supporting activity rows", async () => {
    const sources = (...activityIds: string[]) =>
      activityIds.map((activityId, index) =>
        evidence(
          activityId,
          `Source ${activityId}`,
          "Cursor",
          new Date(Date.UTC(2026, 7, 15, index)).toISOString(),
        ),
      );
    const [threeOccurrences, twoOccurrencesFourRows, twoOccurrencesTwoRows] =
      backendSnapshot.skills;
    threeOccurrences.evidence = sources(
      "activity-101",
      "activity-102",
      "activity-105",
    );
    threeOccurrences.occurrences = [
      { activityIds: ["activity-101"] },
      { activityIds: ["activity-102"] },
      { activityIds: ["activity-105"] },
    ];
    twoOccurrencesFourRows.evidence = sources(
      "activity-103",
      "activity-106",
      "activity-107",
      "activity-108",
    );
    twoOccurrencesFourRows.occurrences = [
      { activityIds: ["activity-103", "activity-106"] },
      { activityIds: ["activity-107", "activity-108"] },
    ];
    twoOccurrencesTwoRows.evidence = sources("activity-104", "activity-109");
    twoOccurrencesTwoRows.occurrences = [
      { activityIds: ["activity-104"] },
      { activityIds: ["activity-109"] },
    ];
    backendSnapshot.skills = [
      twoOccurrencesFourRows,
      threeOccurrences,
      twoOccurrencesTwoRows,
    ];

    render(<BrainOpportunities />);

    const panel = await screen.findByTestId("skill-opportunities-panel");
    await screen.findByTestId("skill-opportunity-feedback-to-fix");
    const rowIds = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "[data-testid^='skill-opportunity-']",
      ),
      (row) => row.dataset.testid,
    );
    expect(rowIds).toEqual([
      "skill-opportunity-feedback-to-fix",
      "skill-opportunity-review-brief",
      "skill-opportunity-meeting-followups",
    ]);
    expect(screen.queryByText(/repeats/)).toBeNull();
  });

  it("can prioritize two long episodes over more frequent short work", async () => {
    const source = (
      activityId: string,
      startAt: string,
      durationMinutes: number,
    ) =>
      evidence(
        activityId,
        `Source ${activityId}`,
        "Cursor",
        startAt,
        durationMinutes,
      );
    const [threeShortEpisodes, twoLongEpisodes, twoModerateEpisodes] =
      backendSnapshot.skills;
    threeShortEpisodes.evidence = [
      source("activity-101", "2026-08-15T09:00:00Z", 5),
      source("activity-102", "2026-08-16T09:00:00Z", 5),
      source("activity-105", "2026-08-17T09:00:00Z", 5),
    ];
    threeShortEpisodes.occurrences = [
      { activityIds: ["activity-101"] },
      { activityIds: ["activity-102"] },
      { activityIds: ["activity-105"] },
    ];
    twoLongEpisodes.evidence = [
      source("activity-103", "2026-08-15T10:00:00Z", 90),
      source("activity-106", "2026-08-16T10:00:00Z", 90),
    ];
    twoLongEpisodes.occurrences = [
      { activityIds: ["activity-103"] },
      { activityIds: ["activity-106"] },
    ];
    twoModerateEpisodes.evidence = [
      source("activity-104", "2026-08-15T12:00:00Z", 30),
      source("activity-109", "2026-08-16T12:00:00Z", 30),
    ];
    twoModerateEpisodes.occurrences = [
      { activityIds: ["activity-104"] },
      { activityIds: ["activity-109"] },
    ];
    backendSnapshot.skills = [
      threeShortEpisodes,
      twoModerateEpisodes,
      twoLongEpisodes,
    ];

    render(<BrainOpportunities />);

    const panel = await screen.findByTestId("skill-opportunities-panel");
    await screen.findByTestId("skill-opportunity-review-brief");
    const rowIds = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "[data-testid^='skill-opportunity-']",
      ),
      (row) => row.dataset.testid,
    );
    expect(rowIds).toEqual([
      "skill-opportunity-review-brief",
      "skill-opportunity-feedback-to-fix",
      "skill-opportunity-meeting-followups",
    ]);
  });

  it("keeps stable ties when grouped or excluded rows add no verified time", async () => {
    const [baseline, grouped] = backendSnapshot.skills;
    baseline.evidence = [
      evidence(
        "activity-101",
        "Baseline one",
        "Cursor",
        "2026-08-15T09:00:00Z",
      ),
      evidence(
        "activity-102",
        "Baseline two",
        "Cursor",
        "2026-08-16T09:00:00Z",
      ),
    ];
    baseline.occurrences = [
      { activityIds: ["activity-101"] },
      { activityIds: ["activity-102"] },
    ];
    grouped.evidence = [
      evidence(
        "activity-103",
        "Grouped one",
        "Cursor",
        "2026-08-15T10:00:00Z",
      ),
      evidence(
        "activity-106",
        "Overlapping one",
        "Cursor",
        "2026-08-15T10:00:00Z",
      ),
      evidence(
        "activity-107",
        "Grouped two",
        "Cursor",
        "2026-08-16T10:00:00Z",
      ),
      evidence(
        "activity-108",
        "Overlapping two",
        "Cursor",
        "2026-08-16T10:00:00Z",
      ),
      evidence(
        "activity-112",
        "One long outlier",
        "Cursor",
        "2026-08-15T11:00:00Z",
        240,
      ),
      {
        ...evidence(
          "activity-110",
          "Excluded long one",
          "Cursor",
          "2026-08-15T10:30:00Z",
          240,
        ),
        excluded: true,
      },
      {
        ...evidence(
          "activity-111",
          "Excluded long two",
          "Cursor",
          "2026-08-16T10:30:00Z",
          240,
        ),
        excluded: true,
      },
    ];
    grouped.occurrences = [
      {
        activityIds: [
          "activity-103",
          "activity-106",
          "activity-110",
          "activity-112",
        ],
      },
      {
        activityIds: ["activity-107", "activity-108", "activity-111"],
      },
    ];
    backendSnapshot.skills = [baseline, grouped];

    render(<BrainOpportunities />);

    const panel = await screen.findByTestId("skill-opportunities-panel");
    await screen.findByTestId("skill-opportunity-feedback-to-fix");
    const rowIds = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "[data-testid^='skill-opportunity-']",
      ),
      (row) => row.dataset.testid,
    );
    expect(rowIds).toEqual([
      "skill-opportunity-feedback-to-fix",
      "skill-opportunity-review-brief",
    ]);
  });

  it("persists review changes and opens the exact background draft chat", async () => {
    const onOpenSkillDraftChat = vi.fn(async () => undefined);
    render(<BrainOpportunities onOpenSkillDraftChat={onOpenSkillDraftChat} />);

    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    fireEvent.change(screen.getByTestId("skill-draft-name"), {
      target: { value: "turn feedback into a verified fix" },
    });
    fireEvent.click(screen.getByText("add note"));
    fireEvent.change(screen.getByTestId("skill-draft-notes"), {
      target: { value: "Keep the final customer reply short." },
    });

    const sourceEvidence = screen.getByTestId("skill-source-evidence");
    fireEvent.click(within(sourceEvidence).getByText("activity evidence"));
    fireEvent.click(
      within(sourceEvidence).getByRole("button", {
        name: "remove Review sample onboarding issue",
      }),
    );
    await waitFor(() =>
      expect(
        within(sourceEvidence).getByRole("button", {
          name: "include Review sample onboarding issue",
        }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("create-skill-draft"));
    expect(screen.getByTestId("create-skill-draft")).toHaveTextContent(
      "starting…",
    );
    await waitFor(() =>
      expect(mocks.startActivityOpportunitySkillDraft).toHaveBeenCalledTimes(1),
    );
    expect(backendSnapshot.skills[0]).toMatchObject({
      status: "drafting",
      name: "turn feedback into a verified fix",
      notes: "Keep the final customer reply short.",
    });
    expect(backendSnapshot.skills[0].evidence[0].excluded).toBe(true);
    const createdDraft = backendSnapshot.skills[0].drafts[0];
    await waitFor(() =>
      expect(onOpenSkillDraftChat).toHaveBeenCalledWith(
        createdDraft.conversationId,
        createdDraft.path,
      ),
    );
    expect(screen.getByTestId("opportunities-tab-ideas")).toHaveTextContent(
      "3",
    );
  });

  it("requires a goal and hands the finalized brief to one fresh chat", async () => {
    const onStartAgentChat = vi.fn(async (prefill) =>
      Promise.resolve(prefill.conversationId ?? null),
    );
    render(<BrainOpportunities onStartAgentChat={onStartAgentChat} />);

    fireEvent.click(await screen.findByTestId("opportunities-tab-unfinished"));
    fireEvent.click(
      screen.getByTestId("unfinished-opportunity-onboarding-reply"),
    );

    const startButton = screen.getByTestId("start-opportunity-agent");
    expect(startButton).toBeDisabled();
    fireEvent.change(screen.getByTestId("unfinished-task-goal"), {
      target: {
        value: "The reporter has a sent reply with the verified outcome.",
      },
    });
    expect(startButton).not.toBeDisabled();

    fireEvent.click(startButton);
    await waitFor(() => expect(onStartAgentChat).toHaveBeenCalledTimes(1));
    const prefill = onStartAgentChat.mock.calls[0][0];
    const handoff = mocks.handoffActivityOpportunity.mock.calls[0][0];
    expect(prefill).toMatchObject({
      autoSend: true,
      source: "library-unfinished-work",
      useHomeChat: true,
      conversationId: handoff.conversationId,
    });
    expect(prefill.context).toContain(
      "Stopping goal: The reporter has a sent reply with the verified outcome.",
    );
    expect(backendSnapshot.unfinished[1]).toMatchObject({
      status: "handed_off",
      conversationId: handoff.conversationId,
    });
    expect(screen.queryByTestId("opportunity-agent-progress")).toBeNull();
  });

  it("persists reversible not-unfinished feedback", async () => {
    render(<BrainOpportunities />);

    fireEvent.click(await screen.findByTestId("opportunities-tab-unfinished"));
    fireEvent.click(
      screen.getByTestId("unfinished-opportunity-activity-review-flow"),
    );
    fireEvent.click(screen.getByRole("button", { name: /not unfinished/i }));

    expect(
      await screen.findByText("1 marked not unfinished", { exact: false }),
    ).toBeTruthy();
    expect(backendSnapshot.unfinished[0].status).toBe("dismissed");
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(
      await screen.findByTestId("unfinished-opportunity-activity-review-flow"),
    ).toBeTruthy();
    expect(backendSnapshot.unfinished[0].status).toBe("pending");
  });

  it("updates from the native analyzer event", async () => {
    render(<BrainOpportunities />);
    await screen.findByTestId("skill-opportunity-feedback-to-fix");

    const next = readySnapshot();
    next.skills = [];
    next.unfinished = [];
    act(() => {
      mocks.eventHandlers.get("activity-opportunities-updated")?.({
        payload: next,
      });
    });

    expect(await screen.findByText("no skill ideas yet")).toBeTruthy();
  });

  it("accepts analyzer revisions for suggestions the user has not edited", async () => {
    render(<BrainOpportunities />);
    await screen.findByTestId("skill-opportunity-feedback-to-fix");

    const next = readySnapshot();
    next.skills[0].revision = 2;
    next.skills[0].name = "turn customer reports into verified fixes";
    act(() => {
      mocks.eventHandlers.get("activity-opportunities-updated")?.({
        payload: next,
      });
    });

    expect(
      await screen.findByText("turn customer reports into verified fixes"),
    ).toBeTruthy();
  });

  it("rebases untouched fields when analysis updates a partly edited draft", async () => {
    render(<BrainOpportunities />);
    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    fireEvent.click(screen.getByText("add note"));
    fireEvent.change(screen.getByTestId("skill-draft-notes"), {
      target: { value: "Keep the customer reply concise." },
    });

    const next = readySnapshot();
    next.skills[0].revision = 2;
    next.skills[0].name = "turn reports into verified fixes";
    act(() => {
      mocks.eventHandlers.get("activity-opportunities-updated")?.({
        payload: next,
      });
    });

    expect(screen.getByTestId("skill-draft-name")).toHaveValue(
      "turn reports into verified fixes",
    );
    expect(screen.getByTestId("skill-draft-notes")).toHaveValue(
      "Keep the customer reply concise.",
    );
    await waitFor(() =>
      expect(mocks.updateActivityOpportunity).toHaveBeenCalledWith({
        kind: "skill",
        id: "feedback-to-fix",
        revision: 2,
        notes: "Keep the customer reply concise.",
      }),
    );
  });

  it("preserves a second field edited while the first save is in flight", async () => {
    let firstRequest: UpdateActivityOpportunityRequest | null = null;
    let resolveFirst:
      | ((value: { status: "ok"; data: ActivityOpportunitySnapshot }) => void)
      | null = null;
    mocks.updateActivityOpportunity.mockImplementationOnce(
      (request: UpdateActivityOpportunityRequest) => {
        firstRequest = request;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    );

    render(<BrainOpportunities />);
    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    fireEvent.change(screen.getByTestId("skill-draft-name"), {
      target: { value: "turn feedback into a verified fix" },
    });
    await waitFor(
      () => expect(mocks.updateActivityOpportunity).toHaveBeenCalledTimes(1),
      { timeout: 2_000 },
    );

    fireEvent.click(screen.getByText("add note"));
    fireEvent.change(screen.getByTestId("skill-draft-notes"), {
      target: { value: "Preserve this later edit." },
    });
    const submittedName = firstRequest?.name;
    backendSnapshot.skills[0].name = submittedName ?? "";
    backendSnapshot.skills[0].revision += 1;
    act(() => {
      resolveFirst?.({ status: "ok", data: clone(backendSnapshot) });
    });

    expect(screen.getByTestId("skill-draft-notes")).toHaveValue(
      "Preserve this later edit.",
    );
    await waitFor(
      () => expect(mocks.updateActivityOpportunity).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );
    expect(mocks.updateActivityOpportunity.mock.calls[1][0]).toEqual({
      kind: "skill",
      id: "feedback-to-fix",
      revision: 2,
      notes: "Preserve this later edit.",
    });
  });

  it("persists evidence removals", async () => {
    render(<BrainOpportunities />);
    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    const sourceEvidence = screen.getByTestId("skill-source-evidence");
    fireEvent.click(within(sourceEvidence).getByText("activity evidence"));
    fireEvent.click(
      within(sourceEvidence).getByRole("button", {
        name: "remove Review sample onboarding issue",
      }),
    );

    await waitFor(() =>
      expect(mocks.updateActivityOpportunity).toHaveBeenCalledTimes(1),
    );
    expect(mocks.updateActivityOpportunity.mock.calls[0][0]).toEqual({
      kind: "skill",
      id: "feedback-to-fix",
      revision: 1,
      excludedActivityIds: ["activity-101"],
    });
  });

  it("adds an activity as context without counting it as another occurrence", async () => {
    render(<BrainOpportunities />);
    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    const sourceEvidence = screen.getByTestId("skill-source-evidence");
    fireEvent.click(within(sourceEvidence).getByText("activity evidence"));
    fireEvent.click(
      within(sourceEvidence).getByRole("button", { name: "add activity" }),
    );

    await waitFor(() =>
      expect(backendSnapshot.skills[0].supportingContexts).toHaveLength(1),
    );
    expect(backendSnapshot.skills[0].supportingContexts[0]).toMatchObject({
      source: "activity-history",
      query: "stripe mrr",
      startAt: "2026-08-22T17:00:00Z",
      endAt: "2026-08-22T17:05:00Z",
      appName: "Stripe",
      activity: expect.objectContaining({ id: "activity-stripe-mrr" }),
    });
    expect(backendSnapshot.skills[0].occurrences).toHaveLength(3);
    expect(
      await within(sourceEvidence).findByText("added activity"),
    ).toBeTruthy();
    expect(
      within(sourceEvidence).getByRole("link", {
        name: /Open Stripe .* in Timeline/i,
      }),
    ).toHaveAttribute(
      "href",
      "screenpipe://frame/7001",
    );
    expect(
      within(sourceEvidence).getByRole("link", {
        name: /Open PostHog .* in Timeline/i,
      }),
    ).toBeInTheDocument();
  });

  it("uses Activity ledger source affordances for suggestion evidence", async () => {
    render(<BrainOpportunities />);
    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    const sourceEvidence = screen.getByTestId("skill-source-evidence");
    fireEvent.click(within(sourceEvidence).getByText("activity evidence"));

    expect(
      within(sourceEvidence).getByRole("link", {
        name: /Open Slack .* in Timeline/i,
      }),
    ).toHaveAttribute("href", "screenpipe://frame/101");
    expect(
      within(sourceEvidence).getByRole("link", {
        name: /Open Cursor .* in Timeline/i,
      }),
    ).toHaveAttribute("href", "screenpipe://frame/102");
  });

  it("allows a user to start drafting after removing every evidence row", async () => {
    const onOpenSkillDraftChat = vi.fn(async () => undefined);
    backendSnapshot.skills[0].evidence = backendSnapshot.skills[0].evidence.map(
      (source) => ({ ...source, excluded: true }),
    );
    render(<BrainOpportunities onOpenSkillDraftChat={onOpenSkillDraftChat} />);
    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );

    const create = screen.getByTestId("create-skill-draft");
    expect(create).not.toBeDisabled();
    fireEvent.click(create);

    await waitFor(() =>
      expect(mocks.startActivityOpportunitySkillDraft).toHaveBeenCalledTimes(1),
    );
    expect(onOpenSkillDraftChat).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed chat navigation staged for recovery", async () => {
    const onStartAgentChat = vi.fn(async () => {
      throw new Error("chat navigation failed");
    });
    render(<BrainOpportunities onStartAgentChat={onStartAgentChat} />);

    fireEvent.click(await screen.findByTestId("opportunities-tab-unfinished"));
    fireEvent.click(
      screen.getByTestId("unfinished-opportunity-onboarding-reply"),
    );
    fireEvent.change(screen.getByTestId("unfinished-task-goal"), {
      target: { value: "The verified reply has been sent." },
    });
    fireEvent.click(screen.getByTestId("start-opportunity-agent"));

    await waitFor(() => expect(onStartAgentChat).toHaveBeenCalledTimes(1));
    const handoff = mocks.handoffActivityOpportunity.mock.calls[0][0];
    const staged = JSON.parse(
      sessionStorage.getItem("pendingChatPrefill") ?? "{}",
    );
    expect(staged).toMatchObject({
      autoSend: true,
      source: "library-unfinished-work",
      conversationId: handoff.conversationId,
    });
    expect(backendSnapshot.unfinished[1].status).toBe("handed_off");
  });

  it("separates analyzer errors from a genuine empty result", async () => {
    backendSnapshot = {
      analysisState: "error",
      generatedAt: null,
      analysisError: "Opportunity analysis could not reach the agent.",
      skills: [],
      unfinished: [],
    };
    installStatefulCommands(backendSnapshot);
    render(<BrainOpportunities />);

    expect(await screen.findByText("couldn’t analyze activity")).toBeTruthy();
    expect(
      screen.getByText("Opportunity analysis could not reach the agent."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /open activity/i })).toBeTruthy();
  });

  it("shows refresh failures without hiding the last good opportunities", async () => {
    backendSnapshot.analysisState = "error";
    backendSnapshot.analysisError = "Recent activity could not be analyzed.";
    render(<BrainOpportunities />);

    expect(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    ).toBeTruthy();
    expect(
      screen.getByText("Recent activity could not be analyzed."),
    ).toHaveAttribute("role", "alert");
  });

  it("shows three suggestions and promotes the next one after rejection", async () => {
    const template = backendSnapshot.skills[2];
    backendSnapshot.skills.push(
      {
        ...clone(template),
        id: "fourth-suggestion",
        name: "prepare a weekly growth snapshot",
        description: "Summarize the weekly movement for review.",
        evidence: [
          evidence(
            "activity-110",
            "Review weekly growth",
            "PostHog",
            "2026-08-14T18:03:00Z",
          ),
        ],
      },
      {
        ...clone(template),
        id: "fifth-suggestion",
        name: "capture meeting follow-ups",
        description: "Turn meeting decisions into clear next actions.",
        evidence: [
          evidence(
            "activity-111",
            "Review meeting notes",
            "Notion",
            "2026-08-13T18:03:00Z",
          ),
        ],
      },
    );
    render(<BrainOpportunities />);

    await screen.findByTestId("skill-opportunity-feedback-to-fix");
    expect(
      screen.queryByTestId("skill-opportunity-fourth-suggestion"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "show 2 more" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "reject turn product feedback into a focused fix",
      }),
    );

    expect(
      await screen.findByTestId("skill-opportunity-fourth-suggestion"),
    ).toBeTruthy();
    expect(backendSnapshot.skills[0].status).toBe("dismissed");
  });

  it("moves an idea to Continue only after the first edit", async () => {
    render(<BrainOpportunities />);

    fireEvent.click(
      await screen.findByTestId("skill-opportunity-feedback-to-fix"),
    );
    expect(screen.queryByRole("region", { name: /continue/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "all skill ideas" }));
    expect(screen.queryByRole("region", { name: /continue/i })).toBeNull();

    fireEvent.click(screen.getByTestId("skill-opportunity-feedback-to-fix"));
    fireEvent.change(screen.getByTestId("skill-draft-name"), {
      target: { value: "turn feedback into a verified fix" },
    });
    await waitFor(() => expect(backendSnapshot.skills[0].edited).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "all skill ideas" }));

    expect(screen.getByRole("region", { name: /continue/i })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: /continue/i })).getByText(
        "turn feedback into a verified fix",
      ),
    ).toBeTruthy();
  });

  it("reopens an active skill draft as its exact chat", async () => {
    const skill = backendSnapshot.skills[0];
    const draft = {
      id: "draft-ready",
      conversationId: "skill-draft-ready",
      path: "/Users/screenpipe/.screenpipe/skill-drafts/feedback-to-fix/draft-ready/SKILL.md",
      phase: "ready" as const,
      skillMd:
        '---\nname: "verified-fix"\ndescription: "Turn feedback into a verified fix."\n---\n\nFollow the repeated workflow.\n',
      startedAt: "2026-08-22T18:00:00Z",
      updatedAt: "2026-08-22T18:02:00Z",
      completedAt: "2026-08-22T18:02:00Z",
    };
    skill.status = "drafting";
    skill.drafts = [draft];
    skill.currentDraftId = draft.id;
    const onOpenSkillDraftChat = vi.fn(async () => undefined);
    render(<BrainOpportunities onOpenSkillDraftChat={onOpenSkillDraftChat} />);

    const row = await screen.findByTestId("skill-opportunity-feedback-to-fix");
    expect(row).toHaveTextContent("draft ready");
    fireEvent.click(row);

    expect(onOpenSkillDraftChat).toHaveBeenCalledWith(
      draft.conversationId,
      draft.path,
    );
  });

  it("keeps the created list minimal and opens the live skill beside its installed chat", async () => {
    const { skill, installedDraft } = addCreatedSkill(backendSnapshot);
    const onOpenSkillDraftChat = vi.fn(async () => undefined);
    render(<BrainOpportunities onOpenSkillDraftChat={onOpenSkillDraftChat} />);

    await screen.findByTestId("skill-opportunity-review-brief");
    fireEvent.click(screen.getByTestId("opportunities-tab-created"));

    const row = screen.getByTestId(`skill-opportunity-${skill.id}`);
    expect(row).toHaveTextContent("verified fix");
    expect(row).toHaveTextContent("Turn feedback into a verified fix.");
    expect(row).toHaveTextContent("Aug 30, 2026");
    expect(screen.getByText("enabled")).toBeVisible();
    expect(row).not.toHaveTextContent("Follow the repeated workflow");

    fireEvent.click(row);
    expect(onOpenSkillDraftChat).toHaveBeenCalledWith(
      installedDraft.conversationId,
      "/Users/screenpipe/.screenpipe/skills/verified-fix/SKILL.md",
    );
  });

  it("reopens the current uninstalled revision from the created row", async () => {
    const { skill, installedDraft } = addCreatedSkill(backendSnapshot);
    const revisionDraft = {
      ...installedDraft,
      id: "draft-revision",
      conversationId: "skill-draft-revision",
      path: `/Users/screenpipe/.screenpipe/skill-drafts/${skill.id}/draft-revision/SKILL.md`,
      phase: "running" as const,
      skillMd: "",
      completedAt: undefined,
    };
    skill.drafts.push(revisionDraft);
    skill.currentDraftId = revisionDraft.id;
    const onOpenSkillDraftChat = vi.fn(async () => undefined);
    render(<BrainOpportunities onOpenSkillDraftChat={onOpenSkillDraftChat} />);

    await screen.findByTestId("skill-opportunity-review-brief");
    fireEvent.click(screen.getByTestId("opportunities-tab-created"));
    fireEvent.click(screen.getByTestId(`skill-opportunity-${skill.id}`));

    expect(onOpenSkillDraftChat).toHaveBeenCalledWith(
      revisionDraft.conversationId,
      revisionDraft.path,
    );
  });

  it("opens a legacy created skill without a draft chat in the editable side panel", async () => {
    const skill = backendSnapshot.skills[0];
    const path =
      "/Users/screenpipe/.screenpipe/skills/legacy-verified-fix/SKILL.md";
    skill.status = "created";
    skill.name = "legacy verified fix";
    skill.description = "Turn feedback into a verified fix.";
    skill.drafts = [];
    skill.currentDraftId = undefined;
    skill.createdSkill = {
      path,
      skillMd:
        '---\nname: "legacy verified fix"\ndescription: "Turn feedback into a verified fix."\n---\n\nFollow the repeated workflow.\n',
    } as never;

    render(<BrainOpportunities />);

    await screen.findByTestId("skill-opportunity-review-brief");
    fireEvent.click(screen.getByTestId("opportunities-tab-created"));
    fireEvent.click(screen.getByTestId(`skill-opportunity-${skill.id}`));

    await waitFor(() =>
      expect(mocks.showChatWithPrefill).toHaveBeenCalledWith({
        context: "",
        source: "activity-opportunity-created-skill",
        useHomeChat: true,
        filePreviewPath: path,
      }),
    );
  });

  it("lets the user quietly disable a created skill", async () => {
    const { skill } = addCreatedSkill(backendSnapshot);
    render(<BrainOpportunities />);

    await screen.findByTestId("skill-opportunity-review-brief");
    fireEvent.click(screen.getByTestId("opportunities-tab-created"));
    fireEvent.click(
      screen.getByRole("switch", { name: "disable verified fix" }),
    );

    await waitFor(() =>
      expect(mocks.setActivityOpportunitySkillEnabled).toHaveBeenCalledWith({
        id: skill.id,
        revision: 1,
        enabled: false,
      }),
    );
    expect(
      screen.getByRole("switch", { name: "enable verified fix" }),
    ).not.toBeChecked();
    expect(screen.getByText("disabled")).toBeVisible();
  });

  it("does not invent a revision for an idempotent toggle response", async () => {
    const { skill } = addCreatedSkill(backendSnapshot);
    mocks.setActivityOpportunitySkillEnabled.mockImplementation(
      async (request: { id: string; revision: number; enabled: boolean }) => ({
        status: "ok",
        data: { ...skill.createdSkill!, enabled: request.enabled },
      }),
    );
    render(<BrainOpportunities />);

    await screen.findByTestId("skill-opportunity-review-brief");
    fireEvent.click(screen.getByTestId("opportunities-tab-created"));
    const staleEnabledSwitch = screen.getByRole("switch", {
      name: "disable verified fix",
    });
    const next = clone(backendSnapshot);
    const nextSkill = next.skills.find((item) => item.id === skill.id)!;
    nextSkill.revision = 2;
    nextSkill.createdSkill = {
      ...nextSkill.createdSkill!,
      enabled: false,
    } as never;
    act(() => {
      mocks.eventHandlers.get("activity-opportunities-updated")?.({
        payload: next,
      });
      fireEvent.click(staleEnabledSwitch);
    });

    await waitFor(() =>
      expect(mocks.setActivityOpportunitySkillEnabled).toHaveBeenCalledWith({
        id: skill.id,
        revision: 2,
        enabled: false,
      }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "enable verified fix" }),
    );
    await waitFor(() =>
      expect(mocks.setActivityOpportunitySkillEnabled).toHaveBeenLastCalledWith(
        {
          id: skill.id,
          revision: 2,
          enabled: true,
        },
      ),
    );
  });

  it("does not let a stale toggle response replace a newer installed revision", async () => {
    const { skill, installedDraft } = addCreatedSkill(backendSnapshot);
    const staleCreatedSkill = clone(skill.createdSkill!);
    let resolveToggle:
      | ((value: { status: "ok"; data: typeof staleCreatedSkill }) => void)
      | null = null;
    mocks.setActivityOpportunitySkillEnabled.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToggle = resolve;
        }),
    );
    const onOpenSkillDraftChat = vi.fn(async () => undefined);
    render(<BrainOpportunities onOpenSkillDraftChat={onOpenSkillDraftChat} />);

    await screen.findByTestId("skill-opportunity-review-brief");
    fireEvent.click(screen.getByTestId("opportunities-tab-created"));
    fireEvent.click(
      screen.getByRole("switch", { name: "disable verified fix" }),
    );
    await waitFor(() =>
      expect(mocks.setActivityOpportunitySkillEnabled).toHaveBeenCalled(),
    );

    const next = clone(backendSnapshot);
    const nextSkill = next.skills.find((item) => item.id === skill.id)!;
    const nextDraft = {
      ...installedDraft,
      id: "installed-revision",
      conversationId: "skill-draft-installed-revision",
      path: `/Users/screenpipe/.screenpipe/skill-drafts/${skill.id}/installed-revision/SKILL.md`,
      skillMd: installedDraft.skillMd.replace(
        "Follow the repeated workflow.",
        "Follow the revised workflow.",
      ),
    };
    nextSkill.revision = skill.revision + 1;
    nextSkill.drafts.push(nextDraft);
    nextSkill.currentDraftId = nextDraft.id;
    nextSkill.createdSkill = {
      ...nextSkill.createdSkill!,
      path: "/Users/screenpipe/.screenpipe/skills/verified-fix/SKILL.md",
      skillMd: nextDraft.skillMd,
      sha256: "b".repeat(64),
      enabled: true,
      installedDraftId: nextDraft.id,
    } as never;
    act(() => {
      mocks.eventHandlers.get("activity-opportunities-updated")?.({
        payload: next,
      });
    });

    await act(async () => {
      resolveToggle?.({
        status: "ok",
        data: { ...staleCreatedSkill, enabled: false } as never,
      });
      await Promise.resolve();
    });

    expect(
      screen.getByRole("switch", { name: "disable verified fix" }),
    ).toBeChecked();
    fireEvent.click(screen.getByTestId(`skill-opportunity-${skill.id}`));
    expect(onOpenSkillDraftChat).toHaveBeenCalledWith(
      nextDraft.conversationId,
      nextSkill.createdSkill!.path,
    );
  });

  it("supports keyboard tab navigation", async () => {
    render(<BrainOpportunities />);
    await screen.findByTestId("skill-opportunity-feedback-to-fix");

    fireEvent.keyDown(screen.getByTestId("opportunities-tab-ideas"), {
      key: "ArrowRight",
    });
    expect(screen.getByTestId("opportunities-tab-created")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("opportunities-tab-ideas")).not.toHaveAttribute(
      "aria-controls",
    );
  });
});
