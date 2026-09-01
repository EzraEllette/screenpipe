// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  getActivityOpportunities: vi.fn(),
  saveActivityOpportunitySkillDraft: vi.fn(),
  installActivityOpportunitySkillDraft: vi.fn(),
  startActivityOpportunitySkillDraft: vi.fn(),
  showChatWithPrefill: vi.fn(),
  openChatConversationInCurrentChatSurface: vi.fn(),
  getAppServerBaseUrl: vi.fn(),
  toast: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    getActivityOpportunities: mocks.getActivityOpportunities,
    saveActivityOpportunitySkillDraft: mocks.saveActivityOpportunitySkillDraft,
    installActivityOpportunitySkillDraft:
      mocks.installActivityOpportunitySkillDraft,
    startActivityOpportunitySkillDraft:
      mocks.startActivityOpportunitySkillDraft,
  },
}));

vi.mock("@/lib/chat-utils", () => ({
  showChatWithPrefill: mocks.showChatWithPrefill,
  openChatConversationInCurrentChatSurface:
    mocks.openChatConversationInCurrentChatSurface,
}));

vi.mock("@/lib/notifications/app-server", () => ({
  getAppServerBaseUrl: mocks.getAppServerBaseUrl,
}));

vi.mock("@/lib/hooks/use-tauri-event", () => ({
  useTauriEvent: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    mocks.eventHandlers.set(event, handler);
  },
}));

vi.mock("@/components/ui/use-toast", () => ({ toast: mocks.toast }));

vi.mock("@/components/skills/skill-draft-editor", () => ({
  SkillDraftEditor: (props: {
    phase: string;
    value: string;
    saveState: string;
    onChange: (value: string) => void;
    onTest: (prompt: string) => void;
    onInstall: () => void;
    onRequestChange: (request: string) => void;
    onRetry: (changeRequest?: string) => void;
    retryRequiresChange?: boolean;
    installing?: boolean;
    readOnly?: boolean;
    installed?: boolean;
    historical?: boolean;
    detached?: boolean;
    onOpenCurrent?: () => void;
    onOpenDraftChat?: () => void;
    sources?: Array<{
      id: string;
      label: string;
      artifacts?: ReactNode;
    }>;
  }) => (
    <div
      data-testid="skill-draft-editor"
      data-phase={props.phase}
      data-installed={String(props.installed ?? false)}
      data-installing={String(props.installing ?? false)}
      data-historical={String(props.historical ?? false)}
      data-detached={String(props.detached ?? false)}
    >
      <textarea
        aria-label="draft markdown"
        value={props.value}
        disabled={props.readOnly || props.installing}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <span data-testid="save-state">{props.saveState}</span>
      <button
        disabled={props.installing}
        onClick={() => props.onTest("verify today's MRR")}
      >
        test
      </button>
      <button disabled={props.installing} onClick={props.onInstall}>
        install
      </button>
      <button
        disabled={props.installing}
        onClick={() => props.onRequestChange("include weekly growth")}
      >
        change
      </button>
      <button
        disabled={props.installing}
        onClick={() =>
          props.onRetry(
            props.retryRequiresChange ? "include weekly growth" : undefined,
          )
        }
      >
        retry
      </button>
      {props.onOpenCurrent ? (
        <button onClick={props.onOpenCurrent}>open current</button>
      ) : null}
      {props.onOpenDraftChat ? (
        <button onClick={props.onOpenDraftChat}>open draft chat</button>
      ) : null}
      {props.sources?.map((source) => (
        <div key={source.id} data-testid={`draft-source-${source.id}`}>
          {source.label}
          {source.artifacts}
        </div>
      ))}
    </div>
  ),
}));

import {
  ActivityOpportunitySkillDraft,
  findActivityOpportunitySkillDraft,
  useActivityOpportunitySkillDraft,
} from "./activity-opportunity-skill-draft";

const SKILL_MD = [
  "---",
  "name: review MRR",
  "description: Compare Stripe and PostHog revenue.",
  "---",
  "",
  "# Review MRR",
].join("\n");

function skillDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1",
    conversationId: "skill-draft-chat",
    path: "/data/skill-drafts/opportunity-1/draft-1/SKILL.md",
    phase: "ready",
    skillMd: SKILL_MD,
    startedAt: "2026-08-31T12:00:00Z",
    updatedAt: "2026-08-31T12:01:00Z",
    completedAt: "2026-08-31T12:01:00Z",
    ...overrides,
  };
}

function opportunity(revision = 4, draft = skillDraft()) {
  return {
    id: "opportunity-1",
    revision,
    status: "drafting",
    name: "review MRR",
    description: "Compare Stripe and PostHog revenue.",
    notes: "",
    blueprint: { trigger: "weekly", steps: ["compare"], verification: "post" },
    occurrences: [],
    evidence: [],
    drafts: [draft],
    currentDraftId: draft.id,
    edited: true,
  };
}

function snapshot(skills = [opportunity()]) {
  return {
    analysisState: "ready",
    generatedAt: "2026-08-31T12:00:00Z",
    skills,
    unfinished: [],
  };
}

function HookHarness({ path }: { path: string }) {
  const match = useActivityOpportunitySkillDraft(path);
  return <span data-testid="matched-draft">{match?.draft.id ?? "none"}</span>;
}

describe("activity opportunity skill draft", () => {
  beforeEach(() => {
    mocks.eventHandlers.clear();
    mocks.getActivityOpportunities.mockReset().mockResolvedValue({
      status: "ok",
      data: snapshot(),
    });
    mocks.saveActivityOpportunitySkillDraft
      .mockReset()
      .mockImplementation(async (request: { skillMd: string }) => ({
        status: "ok",
        data: skillDraft({ skillMd: request.skillMd }),
      }));
    mocks.installActivityOpportunitySkillDraft.mockReset().mockResolvedValue({
      status: "ok",
      data: { path: "/skills/review-mrr/SKILL.md", skillMd: SKILL_MD },
    });
    mocks.startActivityOpportunitySkillDraft.mockReset().mockResolvedValue({
      status: "ok",
      data: skillDraft({
        id: "draft-2",
        conversationId: "skill-revision-chat",
        path: "/data/skill-drafts/opportunity-1/draft-2/SKILL.md",
        phase: "running",
        skillMd: "",
      }),
    });
    mocks.showChatWithPrefill.mockReset().mockResolvedValue("skill-test-chat");
    mocks.openChatConversationInCurrentChatSurface
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.getAppServerBaseUrl
      .mockReset()
      .mockResolvedValue("http://localhost:11535");
    mocks.toast.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("matches only the exact persisted draft path", () => {
    expect(
      findActivityOpportunitySkillDraft(
        snapshot() as never,
        "/data/skill-drafts/opportunity-1/draft-1/SKILL.md",
      )?.draft.id,
    ).toBe("draft-1");
    expect(
      findActivityOpportunitySkillDraft(
        snapshot() as never,
        "/data/skill-drafts/opportunity-1/draft-10/SKILL.md",
      ),
    ).toBeNull();
  });

  it("keeps Activity ledger source affordances beside the draft", async () => {
    const draft = skillDraft();
    const sourcedOpportunity = {
      ...opportunity(4, draft),
      evidence: [
        {
          activityId: "activity-1",
          startAt: "2026-08-29T12:00:00Z",
          endAt: "2026-08-29T12:05:00Z",
          title: "Compare weekly revenue",
          summary: "Checked both revenue views.",
          apps: ["Stripe"],
          frameIds: [42],
          meetingIds: [],
          excluded: false,
        },
      ],
    };

    render(
      <ActivityOpportunitySkillDraft
        conversationId={draft.conversationId}
        match={{ opportunity: sourcedOpportunity as never, draft }}
      />,
    );

    expect(screen.getByTestId("draft-source-activity-1")).toHaveTextContent(
      "Compare weekly revenue",
    );
    const artifact = screen.getByRole("link", {
      name: /Open Stripe .* in Timeline/i,
    });
    expect(artifact).toHaveAttribute("href", "screenpipe://frame/42");
    await waitFor(() =>
      expect(artifact.querySelector("img")).toHaveAttribute(
        "src",
        "http://localhost:11535/app-icon?name=Stripe",
      ),
    );
  });

  it("updates a preview from the persisted opportunities event", async () => {
    mocks.getActivityOpportunities.mockResolvedValueOnce({
      status: "ok",
      data: snapshot([]),
    });
    render(
      <HookHarness path="/data/skill-drafts/opportunity-1/draft-1/SKILL.md" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("matched-draft")).toHaveTextContent("none"),
    );

    act(() => {
      mocks.eventHandlers.get("activity-opportunities-updated")?.({
        payload: snapshot(),
      });
    });

    expect(screen.getByTestId("matched-draft")).toHaveTextContent("draft-1");
  });

  it("refreshes the opportunity snapshot when a chat hands off a new draft path", async () => {
    mocks.getActivityOpportunities
      .mockReset()
      .mockResolvedValueOnce({ status: "ok", data: snapshot([]) })
      .mockResolvedValueOnce({ status: "ok", data: snapshot() });
    const view = render(<HookHarness path="/skills/review-mrr/SKILL.md" />);
    await waitFor(() =>
      expect(screen.getByTestId("matched-draft")).toHaveTextContent("none"),
    );

    view.rerender(
      <HookHarness path="/data/skill-drafts/opportunity-1/draft-1/SKILL.md" />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("matched-draft")).toHaveTextContent("draft-1"),
    );
    expect(mocks.getActivityOpportunities).toHaveBeenCalledTimes(2);
  });

  it("flushes an edit before installing with the latest revision", async () => {
    const edited = `${SKILL_MD}\n\nCheck the weekly change.`;
    mocks.getActivityOpportunities.mockResolvedValueOnce({
      status: "ok",
      data: snapshot([opportunity(5, skillDraft({ skillMd: edited }))]),
    });
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: edited },
    });
    fireEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() =>
      expect(mocks.installActivityOpportunitySkillDraft).toHaveBeenCalledWith({
        id: "opportunity-1",
        revision: 5,
        draftId: "draft-1",
      }),
    );
    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenCalledWith({
      id: "opportunity-1",
      draftId: "draft-1",
      skillMd: edited,
    });
    expect(
      mocks.saveActivityOpportunitySkillDraft.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.installActivityOpportunitySkillDraft.mock.invocationCallOrder[0],
    );
    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-installed",
      "true",
    );
  });

  it("freezes the shown draft and every action for the full install request", async () => {
    const edited = `${SKILL_MD}\n\nCheck the weekly change.`;
    const racedEdit = `${edited}\n\nThis must not enter the install.`;
    let resolveInstall:
      | ((value: {
          status: "ok";
          data: { path: string; skillMd: string };
        }) => void)
      | undefined;
    mocks.getActivityOpportunities.mockResolvedValueOnce({
      status: "ok",
      data: snapshot([opportunity(5, skillDraft({ skillMd: edited }))]),
    });
    mocks.installActivityOpportunitySkillDraft
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInstall = resolve;
          }),
      );
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: edited },
    });
    fireEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() =>
      expect(mocks.installActivityOpportunitySkillDraft).toHaveBeenCalledOnce(),
    );
    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-installing",
      "true",
    );
    expect(screen.getByLabelText("draft markdown")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: racedEdit },
    });
    fireEvent.click(screen.getByRole("button", { name: "test" }));
    fireEvent.click(screen.getByRole("button", { name: "change" }));
    fireEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByLabelText("draft markdown")).toHaveValue(edited);
    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenCalledOnce();
    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenCalledWith({
      id: "opportunity-1",
      draftId: "draft-1",
      skillMd: edited,
    });
    expect(mocks.installActivityOpportunitySkillDraft).toHaveBeenCalledOnce();
    expect(mocks.showChatWithPrefill).not.toHaveBeenCalled();
    expect(mocks.startActivityOpportunitySkillDraft).not.toHaveBeenCalled();

    await act(async () => {
      resolveInstall?.({
        status: "ok",
        data: { path: "/skills/review-mrr/SKILL.md", skillMd: edited },
      });
    });

    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-installed",
      "true",
    );
    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-installing",
      "false",
    );
    expect(screen.getByLabelText("draft markdown")).toHaveValue(edited);
  });

  it("keeps a created-skill revision reviewable until that exact draft is installed", () => {
    const installed = skillDraft({
      id: "draft-installed",
      conversationId: "skill-draft-installed",
      path: "/data/skill-drafts/opportunity-1/draft-installed/SKILL.md",
    });
    const revision = skillDraft({
      id: "draft-revision",
      conversationId: "skill-draft-revision",
      path: "/data/skill-drafts/opportunity-1/draft-revision/SKILL.md",
    });
    const createdOpportunity = {
      ...opportunity(8, revision),
      status: "created",
      drafts: [installed, revision],
      currentDraftId: revision.id,
      createdSkill: {
        key: "review-mrr",
        path: "/skills/review-mrr/SKILL.md",
        skillMd: installed.skillMd,
        sha256: "a".repeat(64),
        createdAt: "2026-08-30T12:00:00Z",
        enabled: true,
        installedDraftId: installed.id,
      },
    };

    render(
      <ActivityOpportunitySkillDraft
        conversationId={revision.conversationId}
        match={{
          opportunity: createdOpportunity as never,
          draft: revision as never,
        }}
      />,
    );

    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-installed",
      "false",
    );
    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-historical",
      "false",
    );
    expect(screen.getByLabelText("draft markdown")).toBeEnabled();
  });

  it("debounces a ready draft edit", async () => {
    vi.useFakeTimers();
    const edited = `${SKILL_MD}\n\nRecord the result.`;
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: edited },
    });
    expect(mocks.saveActivityOpportunitySkillDraft).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(599);
    });
    expect(mocks.saveActivityOpportunitySkillDraft).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenCalledWith({
      id: "opportunity-1",
      draftId: "draft-1",
      skillMd: edited,
    });
  });

  it("queues a pending edit before the draft panel unmounts", async () => {
    vi.useFakeTimers();
    const edited = `${SKILL_MD}\n\nKeep this last edit.`;
    const view = render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: edited },
    });
    view.unmount();

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenCalledWith({
      id: "opportunity-1",
      draftId: "draft-1",
      skillMd: edited,
    });
  });

  it("persists a revert queued behind an in-flight save", async () => {
    vi.useFakeTimers();
    const edited = `${SKILL_MD}\n\nTemporary edit.`;
    let finishFirstSave: ((value: unknown) => void) | undefined;
    mocks.saveActivityOpportunitySkillDraft
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockImplementation(async (request: { skillMd: string }) => ({
        status: "ok",
        data: skillDraft({ skillMd: request.skillMd }),
      }));

    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: edited },
    });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    fireEvent.change(screen.getByLabelText("draft markdown"), {
      target: { value: SKILL_MD },
    });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirstSave?.({
        status: "ok",
        data: skillDraft({ skillMd: edited }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveActivityOpportunitySkillDraft).toHaveBeenLastCalledWith({
      id: "opportunity-1",
      draftId: "draft-1",
      skillMd: SKILL_MD,
    });
  });

  it("tests in a fresh home chat with the same skill artifact beside it", async () => {
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "test" }));

    await waitFor(() =>
      expect(mocks.showChatWithPrefill).toHaveBeenCalledOnce(),
    );
    expect(mocks.showChatWithPrefill).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining(SKILL_MD),
        prompt: "Test objective: verify today's MRR",
        displayLabel: "Test skill: verify today's MRR",
        autoSend: true,
        source: "activity-opportunity-skill-test",
        useHomeChat: true,
        conversationId: expect.any(String),
        filePreviewPath:
          "/data/skill-drafts/opportunity-1/draft-1/SKILL.md",
      }),
    );
  });

  it("opens the exact chat and file returned for a revision", async () => {
    mocks.getActivityOpportunities.mockResolvedValueOnce({
      status: "ok",
      data: snapshot([opportunity(6)]),
    });
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "change" }));

    await waitFor(() =>
      expect(
        mocks.openChatConversationInCurrentChatSurface,
      ).toHaveBeenCalledWith(
        "skill-revision-chat",
        "/data/skill-drafts/opportunity-1/draft-2/SKILL.md",
      ),
    );
    expect(mocks.startActivityOpportunitySkillDraft).toHaveBeenCalledWith({
      id: "opportunity-1",
      revision: 6,
      changeRequest: "include weekly growth",
    });
  });

  it("retries a failed draft in a fresh chat with the latest revision", async () => {
    const failedDraft = skillDraft({
      phase: "error",
      error: "the agent stopped",
      skillMd: "",
    });
    mocks.getActivityOpportunities.mockResolvedValueOnce({
      status: "ok",
      data: snapshot([opportunity(7, failedDraft)]),
    });
    mocks.startActivityOpportunitySkillDraft.mockResolvedValueOnce({
      status: "ok",
      data: skillDraft({
        id: "draft-retry",
        conversationId: "skill-retry-chat",
        path: "/data/skill-drafts/opportunity-1/draft-retry/SKILL.md",
        phase: "running",
        skillMd: "",
      }),
    });
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: opportunity(4, failedDraft) as never,
          draft: failedDraft as never,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() =>
      expect(
        mocks.openChatConversationInCurrentChatSurface,
      ).toHaveBeenCalledWith(
        "skill-retry-chat",
        "/data/skill-drafts/opportunity-1/draft-retry/SKILL.md",
      ),
    );
    expect(mocks.startActivityOpportunitySkillDraft).toHaveBeenCalledWith({
      id: "opportunity-1",
      revision: 7,
    });
    expect(
      mocks.startActivityOpportunitySkillDraft.mock.calls[0]?.[0],
    ).not.toHaveProperty("changeRequest");
  });

  it("requires the user change again when retrying a failed created-skill revision", async () => {
    const installedDraft = skillDraft({
      id: "draft-installed",
      conversationId: "skill-installed-chat",
      path: "/data/skill-drafts/opportunity-1/draft-installed/SKILL.md",
    });
    const failedDraft = skillDraft({
      id: "draft-failed-revision",
      conversationId: "skill-failed-chat",
      path: "/data/skill-drafts/opportunity-1/draft-failed-revision/SKILL.md",
      phase: "error",
      error: "the agent stopped",
      skillMd: "",
    });
    const createdOpportunity = {
      ...opportunity(4, failedDraft),
      status: "created",
      drafts: [installedDraft, failedDraft],
      currentDraftId: failedDraft.id,
      createdSkill: {
        key: "review-mrr",
        path: "/skills/review-mrr/SKILL.md",
        skillMd: installedDraft.skillMd,
        sha256: "a".repeat(64),
        createdAt: "2026-08-30T12:00:00Z",
        enabled: true,
        installedDraftId: installedDraft.id,
      },
    };
    mocks.getActivityOpportunities.mockResolvedValueOnce({
      status: "ok",
      data: snapshot([{ ...createdOpportunity, revision: 9 }]),
    });

    render(
      <ActivityOpportunitySkillDraft
        conversationId={failedDraft.conversationId}
        match={{
          opportunity: createdOpportunity as never,
          draft: failedDraft as never,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() =>
      expect(mocks.startActivityOpportunitySkillDraft).toHaveBeenCalledWith({
        id: "opportunity-1",
        revision: 9,
        changeRequest: "include weekly growth",
      }),
    );
    expect(mocks.openChatConversationInCurrentChatSurface).toHaveBeenCalledWith(
      "skill-revision-chat",
      "/data/skill-drafts/opportunity-1/draft-2/SKILL.md",
    );
  });

  it("renders an installed current draft as read-only", () => {
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-draft-chat"
        match={{
          opportunity: {
            ...opportunity(),
            status: "created",
            createdSkill: {
              key: "review-mrr",
              path: "/skills/review-mrr/SKILL.md",
              skillMd: SKILL_MD,
              sha256: "a".repeat(64),
              createdAt: "2026-08-30T12:00:00Z",
              enabled: true,
              installedDraftId: "draft-1",
            },
          } as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-installed",
      "true",
    );
  });

  it("keeps an old draft read-only and opens the current draft", async () => {
    const oldDraft = skillDraft({
      id: "draft-old",
      conversationId: "skill-old-chat",
      path: "/data/skill-drafts/opportunity-1/draft-old/SKILL.md",
    });
    const currentDraft = skillDraft({
      id: "draft-current",
      conversationId: "skill-current-chat",
      path: "/data/skill-drafts/opportunity-1/draft-current/SKILL.md",
    });
    const oldOpportunity = {
      ...opportunity(),
      drafts: [oldDraft, currentDraft],
      currentDraftId: currentDraft.id,
    };
    render(
      <ActivityOpportunitySkillDraft
        conversationId="skill-old-chat"
        match={{
          opportunity: oldOpportunity as never,
          draft: oldDraft as never,
        }}
      />,
    );

    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-historical",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "open current" }));
    await waitFor(() =>
      expect(
        mocks.openChatConversationInCurrentChatSurface,
      ).toHaveBeenCalledWith(
        "skill-current-chat",
        "/data/skill-drafts/opportunity-1/draft-current/SKILL.md",
      ),
    );
  });

  it("opens the owning chat when a current draft is previewed elsewhere", async () => {
    render(
      <ActivityOpportunitySkillDraft
        conversationId="some-other-chat"
        match={{
          opportunity: opportunity() as never,
          draft: skillDraft() as never,
        }}
      />,
    );

    expect(screen.getByTestId("skill-draft-editor")).toHaveAttribute(
      "data-detached",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "open draft chat" }));
    await waitFor(() =>
      expect(
        mocks.openChatConversationInCurrentChatSurface,
      ).toHaveBeenCalledWith(
        "skill-draft-chat",
        "/data/skill-drafts/opportunity-1/draft-1/SKILL.md",
      ),
    );
  });
});
