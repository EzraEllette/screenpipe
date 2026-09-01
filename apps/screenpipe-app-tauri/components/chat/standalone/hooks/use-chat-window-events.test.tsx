// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(async () => undefined),
  listeners: new Map<string, (event: { payload: any }) => void | Promise<void>>(),
  loadConversationFile: vi.fn(),
  updateConversationFlags: vi.fn(),
  getActivityOpportunities: vi.fn(),
  claimPrefillHandling: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: vi.fn(
    async (
      event: string,
      handler: (event: { payload: any }) => void | Promise<void>,
    ) => {
      mocks.listeners.set(event, handler);
      return () => mocks.listeners.delete(event);
    },
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "home" }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
vi.mock("@/lib/chat-storage", () => ({
  loadConversationFile: mocks.loadConversationFile,
  updateConversationFlags: mocks.updateConversationFlags,
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    getActivityOpportunities: mocks.getActivityOpportunities,
  },
}));
vi.mock("@/components/chat/standalone/hooks/use-chat-prefill-events", () => ({
  useChatPrefillEvents: () => ({
    claimPrefillHandling: mocks.claimPrefillHandling,
  }),
}));

import {
  useChatConversationRoutingEvents,
  useChatPrefillListener,
} from "./use-chat-window-events";
import { useChatStore } from "@/lib/stores/chat-store";

const savedConversation = {
  id: "saved-chat",
  title: "saved conversation",
  messages: [
    { id: "u1", role: "user", content: "question", timestamp: 1 },
    { id: "a1", role: "assistant", content: "answer", timestamp: 2 },
  ],
  createdAt: 1,
  updatedAt: 2,
};

function seedSession(overrides: Record<string, unknown> = {}) {
  useChatStore.getState().actions.upsert({
    id: savedConversation.id,
    title: savedConversation.title,
    preview: "answer",
    status: "idle",
    messageCount: savedConversation.messages.length,
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    unread: false,
    ...overrides,
  });
}

function renderRoutingHook(
  loadConversation: ReturnType<typeof vi.fn>,
  renderedMessages = savedConversation.messages,
  openFilePreview = vi.fn(),
) {
  return renderHook(() =>
    useChatConversationRoutingEvents({
      loadConversation,
      startNewConversation: vi.fn(async () => undefined),
      tryInChatStartNewRef: { current: null },
      piSessionIdRef: { current: savedConversation.id },
      renderedMessagesRef: { current: renderedMessages },
      focusMessageById: vi.fn(),
      openFilePreview,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  if (!window.localStorage) {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  }
  localStorage.clear();
  mocks.getActivityOpportunities.mockResolvedValue({
    status: "ok",
    data: {
      analysisState: "ready",
      generatedAt: "2026-09-01T12:00:00Z",
      skills: [],
      unfinished: [],
    },
  });
  mocks.claimPrefillHandling.mockResolvedValue({ claimed: true });
  mocks.updateConversationFlags.mockResolvedValue(undefined);
  useChatStore.setState({
    sessions: {},
    ephemeralSideConversationIds: {},
    openChatIds: [],
    splitChatId: null,
    splitChatPosition: "right",
    diskHydrated: false,
    currentId: null,
    panelSessionId: null,
  });
});

describe("chat prefill artifact handoff", () => {
  it("opens an auto-sent test chat with its skill artifact and no split chat", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const textarea = document.createElement("textarea");
    const openFilePreview = vi.fn();
    useChatStore.getState().actions.openChat("stale-split-chat");
    useChatStore
      .getState()
      .actions.setSplitChat("stale-split-chat", "left");

    renderHook(() =>
      useChatPrefillListener({
        setIsPreparingPrefill: vi.fn(),
        setPrefillContext: vi.fn(),
        setPrefillFrameId: vi.fn(),
        setPrefillSource: vi.fn(),
        setPastedImages: vi.fn(),
        setInput: vi.fn(),
        inputRef: { current: textarea },
        piStreamingTextRef: { current: "" },
        piMessageIdRef: { current: null },
        piContentBlocksRef: { current: [] },
        optimisticSteerRef: { current: null },
        piLastErrorRef: { current: null },
        piSessionIdRef: { current: "new-chat" },
        piSessionSyncedRef: { current: false },
        autoSendBypassRef: { current: false },
        sendMessageRef: { current: sendMessage },
        setIsLoading: vi.fn(),
        setIsStreaming: vi.fn(),
        setMessages: vi.fn(),
        setConversationId: vi.fn(),
        openFilePreview,
      }),
    );

    await waitFor(() => expect(mocks.listeners.has("chat-prefill")).toBe(true));
    act(() => {
      mocks.listeners.get("chat-prefill")?.({
        payload: {
          context: "skill context",
          prompt: "Test objective: check MRR",
          autoSend: true,
          targetWindow: "home",
          conversationId: "skill-test-chat",
          filePreviewPath:
            "/data/skill-drafts/opportunity-1/draft-1/SKILL.md",
        },
      });
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(openFilePreview).toHaveBeenCalledWith(
      "/data/skill-drafts/opportunity-1/draft-1/SKILL.md",
      "hidden",
      "skill-test-chat",
    );
    expect(useChatStore.getState().currentId).toBe("skill-test-chat");
    expect(useChatStore.getState().splitChatId).toBeNull();
  });
});

describe("current conversation routing", () => {
  it("loads a pending conversation when Chat mounts after navigation", async () => {
    localStorage.setItem("pending-chat-conversation", savedConversation.id);
    mocks.loadConversationFile.mockResolvedValue(savedConversation);
    const loadConversation = vi.fn(async () => undefined);

    renderRoutingHook(loadConversation, []);

    await waitFor(() =>
      expect(loadConversation).toHaveBeenCalledWith(savedConversation),
    );
    expect(localStorage.getItem("pending-chat-conversation")).toBeNull();
  });

  it("hydrates a metadata-only current tab after a renderer reload", async () => {
    seedSession();
    mocks.loadConversationFile.mockResolvedValue(savedConversation);
    const loadConversation = vi.fn(async () => undefined);
    renderRoutingHook(loadConversation, []);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId: savedConversation.id, targetWindow: "home" },
      });
    });

    expect(mocks.loadConversationFile).toHaveBeenCalledWith(
      savedConversation.id,
    );
    expect(loadConversation).toHaveBeenCalledWith(savedConversation);
  });

  it("keeps the fast path for an already-renderable current tab", async () => {
    seedSession({
      messages: savedConversation.messages,
      hydratedAt: 10,
    });
    const loadConversation = vi.fn(async () => undefined);
    renderRoutingHook(loadConversation);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId: savedConversation.id, targetWindow: "home" },
      });
    });

    expect(mocks.loadConversationFile).not.toHaveBeenCalled();
    expect(loadConversation).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith("chat-current-session", {
      id: savedConversation.id,
    });
  });

  it("restores a skill draft preview when its owning chat is opened from recents", async () => {
    const conversationId = "skill-draft-owner";
    const path = "/data/skill-drafts/opportunity-1/draft-1/SKILL.md";
    const loadConversation = vi.fn(async () => undefined);
    const openFilePreview = vi.fn();
    mocks.loadConversationFile.mockResolvedValue({
      ...savedConversation,
      id: conversationId,
    });
    mocks.getActivityOpportunities.mockResolvedValue({
      status: "ok",
      data: {
        analysisState: "ready",
        generatedAt: "2026-09-01T12:00:00Z",
        skills: [
          {
            id: "opportunity-1",
            drafts: [{ conversationId, path }],
          },
        ],
        unfinished: [],
      },
    });
    renderRoutingHook(loadConversation, [], openFilePreview);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId, targetWindow: "home" },
      });
    });

    expect(mocks.getActivityOpportunities).toHaveBeenCalledOnce();
    expect(openFilePreview).toHaveBeenCalledWith(path, "hidden", conversationId);
  });

  it("repairs a generated generic skill-chat title from the opportunity", async () => {
    const conversationId = "skill-draft-owner";
    const path = "/data/skill-drafts/opportunity-1/draft-1/SKILL.md";
    const loadConversation = vi.fn(async () => undefined);
    mocks.loadConversationFile.mockResolvedValue({
      ...savedConversation,
      id: conversationId,
      title: "Create a New Skill",
      titleSource: "ai",
    });
    mocks.getActivityOpportunities.mockResolvedValue({
      status: "ok",
      data: {
        analysisState: "ready",
        generatedAt: "2026-09-01T12:00:00Z",
        skills: [
          {
            id: "opportunity-1",
            name: "review MRR",
            drafts: [{ id: "draft-1", conversationId, path }],
          },
        ],
        unfinished: [],
      },
    });
    renderRoutingHook(loadConversation, []);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId, targetWindow: "home" },
      });
    });

    expect(mocks.updateConversationFlags).toHaveBeenCalledWith(conversationId, {
      title: "Create review MRR skill",
      titleSource: "ai",
    });
    expect(mocks.emit).toHaveBeenCalledWith("chat-conversation-saved", {
      id: conversationId,
      title: "Create review MRR skill",
      titleSource: "ai",
    });
  });

  it("repairs the in-memory title before a new skill chat has a file", async () => {
    const conversationId = "skill-draft-owner";
    const path = "/data/skill-drafts/opportunity-1/draft-1/SKILL.md";
    mocks.loadConversationFile.mockResolvedValue(null);
    mocks.getActivityOpportunities.mockResolvedValue({
      status: "ok",
      data: {
        analysisState: "ready",
        generatedAt: "2026-09-01T12:00:00Z",
        skills: [
          {
            id: "opportunity-1",
            name: "review MRR",
            drafts: [{ id: "draft-1", conversationId, path }],
          },
        ],
        unfinished: [],
      },
    });
    seedSession({
      id: conversationId,
      title: "Create a New Skill",
      titleSource: "fallback",
    });
    renderRoutingHook(vi.fn(async () => undefined), []);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId, targetWindow: "home" },
      });
    });

    expect(useChatStore.getState().sessions[conversationId]).toMatchObject({
      title: "Create review MRR skill",
      titleSource: "ai",
    });
  });

  it("preserves a user-renamed skill chat title", async () => {
    const conversationId = "skill-draft-owner";
    const path = "/data/skill-drafts/opportunity-1/draft-1/SKILL.md";
    mocks.loadConversationFile.mockResolvedValue({
      ...savedConversation,
      id: conversationId,
      title: "My weekly revenue ritual",
      titleSource: "user",
    });
    mocks.getActivityOpportunities.mockResolvedValue({
      status: "ok",
      data: {
        analysisState: "ready",
        generatedAt: "2026-09-01T12:00:00Z",
        skills: [
          {
            id: "opportunity-1",
            name: "review MRR",
            drafts: [{ id: "draft-1", conversationId, path }],
          },
        ],
        unfinished: [],
      },
    });
    renderRoutingHook(vi.fn(async () => undefined), []);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId, targetWindow: "home" },
      });
    });

    expect(mocks.updateConversationFlags).not.toHaveBeenCalled();
  });

  it("prefers a persisted user title over stale in-memory metadata", async () => {
    const conversationId = "skill-draft-owner";
    const path = "/data/skill-drafts/opportunity-1/draft-1/SKILL.md";
    mocks.loadConversationFile.mockResolvedValue({
      ...savedConversation,
      id: conversationId,
      title: "My weekly revenue ritual",
      titleSource: "user",
    });
    mocks.getActivityOpportunities.mockResolvedValue({
      status: "ok",
      data: {
        analysisState: "ready",
        generatedAt: "2026-09-01T12:00:00Z",
        skills: [
          {
            id: "opportunity-1",
            name: "review MRR",
            drafts: [{ id: "draft-1", conversationId, path }],
          },
        ],
        unfinished: [],
      },
    });
    seedSession({
      id: conversationId,
      title: "Create a New Skill",
      titleSource: "ai",
    });
    renderRoutingHook(vi.fn(async () => undefined), []);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId, targetWindow: "home" },
      });
    });

    expect(mocks.updateConversationFlags).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[conversationId]).toMatchObject({
      title: "My weekly revenue ritual",
      titleSource: "user",
    });
  });

  it("restores created-skill actions for the chat that installed the skill", async () => {
    const conversationId = "skill-draft-installed";
    const draftPath = "/data/skill-drafts/opportunity-1/draft-1/SKILL.md";
    const createdSkillPath = "/data/skills/review-mrr/SKILL.md";
    const loadConversation = vi.fn(async () => undefined);
    const openFilePreview = vi.fn();
    mocks.loadConversationFile.mockResolvedValue({
      ...savedConversation,
      id: conversationId,
    });
    mocks.getActivityOpportunities.mockResolvedValue({
      status: "ok",
      data: {
        analysisState: "ready",
        generatedAt: "2026-09-01T12:00:00Z",
        skills: [
          {
            id: "opportunity-1",
            drafts: [
              {
                id: "draft-1",
                conversationId,
                path: draftPath,
              },
            ],
            createdSkill: {
              installedDraftId: "draft-1",
              path: createdSkillPath,
            },
          },
        ],
        unfinished: [],
      },
    });
    renderRoutingHook(loadConversation, [], openFilePreview);

    await waitFor(() =>
      expect(mocks.listeners.has("chat-load-conversation")).toBe(true),
    );
    await act(async () => {
      await mocks.listeners.get("chat-load-conversation")?.({
        payload: { conversationId, targetWindow: "home" },
      });
    });

    expect(openFilePreview).toHaveBeenCalledWith(
      createdSkillPath,
      "hidden",
      conversationId,
    );
  });
});
