// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, vi } from "vitest";
import type {
  ActivityOpportunitySnapshot,
  BrainViewCanvasDocument,
  BrainViewDefinition,
  CreatedSkill,
  UnfinishedOpportunity,
} from "@/lib/utils/tauri";
import { mockLocalApiResponse, createMockHealth } from "./browser-engine-mock";
import { createBrowserIpcMock } from "./browser-tauri-mock";

type BrowserSkillDraft = {
  id: string;
  conversationId: string;
  path: string;
  phase: "running" | "ready" | "error";
  skillMd: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
};

type BrowserCreatedSkill = CreatedSkill & {
  key: string;
  sha256: string;
  createdAt: string;
  enabled: boolean;
  installedDraftId?: string | null;
};

type BrowserOpportunitySnapshot = Omit<
  ActivityOpportunitySnapshot,
  "skills"
> & {
  skills: Array<
    Omit<
      ActivityOpportunitySnapshot["skills"][number],
      "status" | "createdSkill"
    > & {
      status: "pending" | "drafting" | "dismissed" | "created";
      drafts: BrowserSkillDraft[];
      currentDraftId?: string | null;
      createdSkill?: BrowserCreatedSkill | null;
    }
  >;
};

function commandError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("browser development runtime", () => {
  it("provides a stateful Tauri store", async () => {
    const onStoreChange = vi.fn();
    const invoke = createBrowserIpcMock({
      mode: "mock",
      apiPort: 3030,
      onStoreChange,
    });

    const rid = invoke("plugin:store|load", { path: "store.bin" }) as number;
    invoke("plugin:store|set", {
      rid,
      key: "settings",
      value: { port: 3030 },
    });

    expect(invoke("plugin:store|get", { rid, key: "settings" })).toEqual([
      { port: 3030 },
      true,
    ]);
    await Promise.resolve();
    expect(onStoreChange).toHaveBeenCalledWith({
      resourceId: rid,
      key: "settings",
      exists: true,
      value: { port: 3030 },
    });
  });

  it("exposes mock and live local API configuration", () => {
    const mockInvoke = createBrowserIpcMock({ mode: "mock", apiPort: 3030 });
    const liveInvoke = createBrowserIpcMock({
      mode: "live",
      apiPort: 3040,
      apiKey: "local-key",
    });

    expect(mockInvoke("get_local_api_config")).toEqual({
      key: null,
      port: 3030,
      auth_enabled: false,
    });
    expect(liveInvoke("get_local_api_config")).toEqual({
      key: "local-key",
      port: 3040,
      auth_enabled: true,
    });
  });

  it("provides imported skills for composer design review", () => {
    const invoke = createBrowserIpcMock({ mode: "mock", apiPort: 3030 });

    expect(invoke("list_imported_skills")).toEqual([
      expect.objectContaining({
        name: "PDF tools",
        path: "/Users/screenpipe/.screenpipe/skills/pdf-tools",
      }),
      expect.objectContaining({ name: "Meeting follow-up" }),
      expect.objectContaining({ name: "Customer discovery" }),
    ]);
    expect(invoke("scan_device_skills")).toEqual([]);
    expect(invoke("list_managed_team_skills")).toEqual([]);
  });

  it("installs provider skills into the browser skills store", () => {
    const invoke = createBrowserIpcMock({ mode: "mock", apiPort: 3030 });
    const registry = invoke("fetch_skills_registry") as Array<{
      name: string;
      imported?: boolean;
    }>;

    expect(registry.map((skill) => skill.name)).toEqual([
      "PDF",
      "MCP Builder",
      "Transcribe",
      "Playwright",
    ]);

    invoke("install_registry_skill", { name: "PDF" });

    expect(invoke("fetch_skills_registry")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "PDF", imported: true }),
      ]),
    );
    expect(invoke("list_imported_skills")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "PDF" })]),
    );
  });

  it("starts a stateful browser agent session and forwards its prompt", async () => {
    const onAgentPrompt = vi.fn();
    const invoke = createBrowserIpcMock({
      mode: "mock",
      apiPort: 3030,
      onAgentPrompt,
    });

    expect(invoke("pi_info", { sessionId: "chat-1" })).toMatchObject({
      running: false,
      sessionId: "chat-1",
    });
    expect(
      invoke("pi_start", {
        sessionId: "chat-1",
        projectDir: "/tmp/chat-1",
      }),
    ).toMatchObject({ running: true, sessionId: "chat-1" });
    expect(
      invoke("pi_prompt", {
        sessionId: "chat-1",
        message: "continue this task",
        displayPreview: "Continue task",
      }),
    ).toMatch(/^browser-prompt-/);

    await Promise.resolve();
    expect(onAgentPrompt).toHaveBeenCalledWith({
      sessionId: "chat-1",
      message: "continue this task",
      displayPreview: "Continue task",
    });
  });

  it("provides stateful Live View fixtures", () => {
    const invoke = createBrowserIpcMock({ mode: "mock", apiPort: 3030 });
    const [view] = invoke("list_brain_views") as BrainViewDefinition[];
    const canvas = invoke("load_brain_view_canvas", {
      viewId: view.id,
    }) as BrainViewCanvasDocument;

    expect(view.title).toBe("How I spend my time today");
    expect(view.slots[0].value).not.toBeNull();
    expect(canvas).toMatchObject({
      viewId: view.id,
      mode: "dashboard",
      revision: 1,
    });

    const savedCanvas = invoke("save_brain_view_canvas", {
      request: {
        viewId: canvas.viewId,
        expectedRevision: canvas.revision,
        mode: "canvas",
        viewport: canvas.viewport,
        blocks: canvas.blocks,
        notes: canvas.notes,
        arrows: canvas.arrows,
        strokes: canvas.strokes,
      },
    }) as BrainViewCanvasDocument;
    expect(savedCanvas).toMatchObject({ mode: "canvas", revision: 2 });

    const savedView = invoke("save_brain_view", {
      request: {
        id: view.id,
        title: view.title,
        expectedRevision: view.revision,
        timeRange: "24h",
        periodPolicy: view.periodPolicy,
        slots: view.slots.map(
          ({ id, title, component, width, order, intent, binding }) => ({
            id,
            title,
            component,
            width,
            order,
            intent,
            binding,
          }),
        ),
      },
    }) as BrainViewDefinition;
    expect(savedView).toMatchObject({ timeRange: "24h", revision: 2 });
    expect(savedView.slots[0].value).toEqual(view.slots[0].value);
    expect(invoke("list_brain_views")).toEqual([savedView]);
  });

  it("exposes ready, empty, and analysis-error opportunity snapshots", () => {
    const readyInvoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const emptyInvoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "empty",
      apiPort: 3030,
    });
    const errorInvoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "backend-error",
      apiPort: 3030,
    });

    const ready = readyInvoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    expect(ready).toMatchObject({
      analysisState: "ready",
      analysisError: null,
    });
    expect(ready.skills).toHaveLength(6);
    expect(ready.unfinished).toHaveLength(2);
    expect(ready.skills[0].evidence[0]).toMatchObject({
      activityId: "browser-dev-mrr-mon",
      apps: ["Stripe", "PostHog"],
      excluded: false,
    });
    const readyDraftPath = ready.skills[0].drafts[0].path;
    expect(ready.skills[0]).toMatchObject({
      id: "check-mrr",
      status: "drafting",
      currentDraftId: "browser-ready-mrr-draft",
      drafts: [
        expect.objectContaining({
          id: "browser-ready-mrr-draft",
          phase: "ready",
          conversationId: "skill-draft-browser-ready-mrr-draft",
          path: expect.stringMatching(
            /skill-drafts\/check-mrr\/browser-ready-mrr-draft\/SKILL\.md$/,
          ),
        }),
      ],
    });
    expect(ready.skills.some((skill) => skill.status === "pending")).toBe(true);
    const created = ready.skills.find(
      (skill) => skill.id === "daily-activity-brief",
    )!;
    const createdConversationId = created.drafts[0].conversationId;
    expect(created).toMatchObject({
      status: "created",
      currentDraftId: "browser-installed-daily-brief-draft",
      createdSkill: {
        installedDraftId: "browser-installed-daily-brief-draft",
      },
      drafts: [
        expect.objectContaining({
          id: "browser-installed-daily-brief-draft",
          phase: "ready",
          conversationId: "skill-draft-browser-installed-daily-brief-draft",
        }),
      ],
    });
    const createdChatBytes = readyInvoke("plugin:fs|read_text_file", {
      path: `/Users/screenpipe/.screenpipe/chats/${createdConversationId}.json`,
    }) as Uint8Array;
    const createdChat = JSON.parse(
      new TextDecoder().decode(createdChatBytes),
    ) as {
      title: string;
      titleSource: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(createdChat).toMatchObject({
      title: "Create write a daily activity brief skill",
      titleSource: "ai",
    });
    expect(createdChat.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Create this skill",
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("# Daily activity brief"),
        }),
      ]),
    );
    expect(
      readyInvoke("read_viewer_file", {
        path: readyDraftPath,
      }),
    ).toMatchObject({
      kind: "text",
      name: "SKILL.md",
      text: expect.stringContaining("Compare current MRR"),
    });

    expect(emptyInvoke("get_activity_opportunities")).toMatchObject({
      analysisState: "ready",
      skills: [],
      unfinished: [],
    });
    expect(errorInvoke("get_activity_opportunities")).toEqual({
      analysisState: "error",
      generatedAt: null,
      analysisError: "mock opportunity analysis failed",
      skills: [],
      unfinished: [],
    });
  });

  it("persists revisioned opportunity edits, exclusions, and dismissal", () => {
    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const initial = invoke(
      "get_activity_opportunities",
    ) as ActivityOpportunitySnapshot;
    const skill = initial.skills.find(
      (candidate) => candidate.id === "review-pull-request",
    )!;
    const excludedActivityId = skill.evidence[0].activityId;

    const dismissed = invoke("update_activity_opportunity", {
      request: {
        kind: "skill",
        id: skill.id,
        revision: skill.revision,
        name: "  focused feedback fix  ",
        notes: "  preserve the customer wording  ",
        excludedActivityIds: [excludedActivityId],
        dismissed: true,
      },
    }) as ActivityOpportunitySnapshot;
    expect(
      dismissed.skills.find((candidate) => candidate.id === skill.id),
    ).toMatchObject({
      revision: 2,
      status: "dismissed",
      name: "focused feedback fix",
      notes: "preserve the customer wording",
    });
    expect(
      dismissed.skills
        .find((candidate) => candidate.id === skill.id)!
        .evidence.find((source) => source.activityId === excludedActivityId)
        ?.excluded,
    ).toBe(true);

    expect(
      commandError(() =>
        invoke("update_activity_opportunity", {
          request: {
            kind: "skill",
            id: skill.id,
            revision: skill.revision,
            dismissed: false,
          },
        }),
      ),
    ).toBe("Opportunity changed; reload it before saving");

    const restored = invoke("update_activity_opportunity", {
      request: {
        kind: "skill",
        id: skill.id,
        revision: 2,
        dismissed: false,
      },
    }) as ActivityOpportunitySnapshot;
    expect(
      restored.skills.find((candidate) => candidate.id === skill.id),
    ).toMatchObject({
      revision: 3,
      status: "pending",
    });
    expect(
      commandError(() =>
        invoke("update_activity_opportunity", {
          request: {
            kind: "skill",
            id: skill.id,
            revision: 3,
            name: "must not survive a rejected update",
            excludedActivityIds: ["foreign-activity"],
          },
        }),
      ),
    ).toBe("excludedActivityIds contains an activity outside this opportunity");
    const afterRejectedUpdate = invoke(
      "get_activity_opportunities",
    ) as ActivityOpportunitySnapshot;
    expect(
      afterRejectedUpdate.skills.find((candidate) => candidate.id === skill.id),
    ).toMatchObject({
      revision: 3,
      name: "focused feedback fix",
    });
  });

  it("creates an idempotent skill from included activity evidence", () => {
    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const initial = invoke(
      "get_activity_opportunities",
    ) as ActivityOpportunitySnapshot;
    const skill = initial.skills.find(
      (candidate) => candidate.id === "review-pull-request",
    )!;
    const excluded = skill.evidence[0].activityId;
    const included = skill.evidence[1].activityId;
    const updated = invoke("update_activity_opportunity", {
      request: {
        kind: "skill",
        id: skill.id,
        revision: skill.revision,
        excludedActivityIds: [excluded],
      },
    }) as ActivityOpportunitySnapshot;
    const revision = updated.skills.find(
      (candidate) => candidate.id === skill.id,
    )!.revision;

    expect(
      commandError(() =>
        invoke("create_activity_opportunity_skill", {
          request: { id: skill.id, revision: skill.revision },
        }),
      ),
    ).toBe("Opportunity changed; reload it before creating the skill");

    const created = invoke("create_activity_opportunity_skill", {
      request: { id: skill.id, revision },
    }) as CreatedSkill;
    expect(created.path).toMatch(/\/review-a-pull-request\/SKILL\.md$/);
    expect(created.skillMd).toContain(`\`${included}\``);
    expect(created.skillMd).not.toContain(`\`${excluded}\``);

    const saved = invoke(
      "get_activity_opportunities",
    ) as ActivityOpportunitySnapshot;
    expect(
      saved.skills.find((candidate) => candidate.id === skill.id),
    ).toMatchObject({
      revision: revision + 1,
      status: "created",
      createdSkill: created,
    });
    expect(
      invoke("create_activity_opportunity_skill", {
        request: { id: skill.id, revision: skill.revision },
      }),
    ).toEqual(created);
  });

  it("rejects a draft that collides with an already installed skill", () => {
    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const initial = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const skill = initial.skills.find(
      (candidate) => candidate.id === "check-mrr",
    )!;
    const draft = skill.drafts.find(
      (candidate) => candidate.id === skill.currentDraftId,
    )!;
    invoke("save_activity_opportunity_skill_draft", {
      request: {
        id: skill.id,
        draftId: draft.id,
        skillMd:
          "---\nname: daily-activity-brief\ndescription: Conflicting replacement.\n---\n\nDo something else.\n",
      },
    });
    const saved = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const savedSkill = saved.skills.find(
      (candidate) => candidate.id === skill.id,
    )!;

    expect(
      commandError(() =>
        invoke("install_activity_opportunity_skill_draft", {
          request: {
            id: savedSkill.id,
            revision: savedSkill.revision,
            draftId: draft.id,
          },
        }),
      ),
    ).toContain("already exists");
  });

  it("moves a skill draft from running to ready, saves it, and installs only on request", async () => {
    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const initial = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const skill = initial.skills.find(
      (candidate) => candidate.id === "meeting-follow-ups",
    )!;
    const startRequest = {
      id: skill.id,
      revision: skill.revision,
      changeRequest: "Keep the final checklist concise.",
    };

    const running = invoke("start_activity_opportunity_skill_draft", {
      request: startRequest,
    }) as BrowserSkillDraft;
    expect(running).toMatchObject({
      phase: "running",
      skillMd: "",
      conversationId: `skill-draft-${running.id}`,
    });
    expect(
      invoke("start_activity_opportunity_skill_draft", {
        request: { ...startRequest, revision: 0 },
      }),
    ).toEqual(running);

    const whileRunning = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const runningSkill = whileRunning.skills.find(
      (candidate) => candidate.id === skill.id,
    )!;
    expect(runningSkill).toMatchObject({
      status: "drafting",
      revision: skill.revision + 1,
      currentDraftId: running.id,
    });
    expect(runningSkill.createdSkill).toBeUndefined();
    expect(
      runningSkill.drafts.find((draft) => draft.id === running.id),
    ).toMatchObject({ phase: "running", skillMd: "" });

    await Promise.resolve();

    const readySnapshot = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const readySkill = readySnapshot.skills.find(
      (candidate) => candidate.id === skill.id,
    )!;
    const readyDraft = readySkill.drafts.find(
      (draft) => draft.id === running.id,
    )!;
    expect(readySkill).toMatchObject({
      status: "drafting",
      revision: skill.revision + 2,
    });
    expect(readySkill.createdSkill).toBeUndefined();
    expect(readyDraft).toMatchObject({
      phase: "ready",
      completedAt: expect.any(String),
    });
    expect(readyDraft.skillMd).toContain(
      "Requested adjustment: Keep the final checklist concise.",
    );
    const chatBytes = invoke("plugin:fs|read_text_file", {
      path: `/Users/screenpipe/.screenpipe/chats/${running.conversationId}.json`,
    }) as Uint8Array;
    const draftChat = JSON.parse(new TextDecoder().decode(chatBytes)) as {
      title: string;
      titleSource: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(draftChat).toMatchObject({
      title: `Revise ${skill.name} skill`,
      titleSource: "ai",
    });
    expect(
      draftChat.messages.find((message) => message.role === "assistant")
        ?.content,
    ).toBe(readyDraft.skillMd);
    expect(invoke("read_viewer_file", { path: readyDraft.path })).toMatchObject(
      { kind: "text", text: readyDraft.skillMd },
    );

    const editedSkillMd = `---
name: "meeting follow-ups"
description: "Turn meeting decisions into a concise, owned follow-up list."
---

# Meeting follow-ups

List each decision, owner, and next action. Keep open questions explicit.
`;
    const savedDraft = invoke("save_activity_opportunity_skill_draft", {
      request: {
        id: skill.id,
        draftId: readyDraft.id,
        skillMd: editedSkillMd,
      },
    }) as BrowserSkillDraft;
    expect(savedDraft.skillMd).toContain('name: "meeting follow-ups"');
    expect(invoke("read_viewer_file", { path: savedDraft.path })).toMatchObject(
      { kind: "text", text: savedDraft.skillMd },
    );

    const savedSnapshot = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const savedSkill = savedSnapshot.skills.find(
      (candidate) => candidate.id === skill.id,
    )!;
    expect(savedSkill).toMatchObject({
      status: "drafting",
      revision: skill.revision + 3,
    });
    expect(savedSkill.createdSkill).toBeUndefined();
    expect(
      commandError(() =>
        invoke("install_activity_opportunity_skill_draft", {
          request: {
            id: skill.id,
            revision: readySkill.revision,
            draftId: savedDraft.id,
          },
        }),
      ),
    ).toBe("Opportunity changed; reload it before installing the skill");

    const created = invoke("install_activity_opportunity_skill_draft", {
      request: {
        id: skill.id,
        revision: savedSkill.revision,
        draftId: savedDraft.id,
      },
    }) as CreatedSkill;
    expect(created).toMatchObject({
      path: expect.stringMatching(/\/meeting-follow-ups\/SKILL\.md$/),
      skillMd: savedDraft.skillMd,
    });
    const installedSnapshot = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    expect(
      installedSnapshot.skills.find((candidate) => candidate.id === skill.id),
    ).toMatchObject({
      status: "created",
      revision: savedSkill.revision + 1,
      name: "meeting follow-ups",
      description:
        "Turn meeting decisions into a concise, owned follow-up list.",
      createdSkill: created,
    });
    expect(
      invoke("install_activity_opportunity_skill_draft", {
        request: {
          id: skill.id,
          revision: savedSkill.revision,
          draftId: savedDraft.id,
        },
      }),
    ).toEqual(created);
  });

  it("keeps the live skill active while a revision is drafted, then replaces it on install", async () => {
    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const initial = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const created = initial.skills.find(
      (candidate) => candidate.id === "daily-activity-brief",
    )!;
    const original = created.createdSkill!;
    expect(
      commandError(() =>
        invoke("save_activity_opportunity_skill_draft", {
          request: {
            id: created.id,
            draftId: original.installedDraftId,
            skillMd: original.skillMd,
          },
        }),
      ),
    ).toBe(
      "An installed skill draft is immutable. Start a revision to change it.",
    );

    const disabled = invoke("set_activity_opportunity_skill_enabled", {
      request: {
        id: created.id,
        revision: created.revision,
        enabled: false,
      },
    }) as BrowserCreatedSkill;
    expect(disabled).toMatchObject({
      key: original.key,
      skillMd: original.skillMd,
      enabled: false,
    });

    const idempotentDisable = invoke("set_activity_opportunity_skill_enabled", {
      request: {
        id: created.id,
        revision: created.revision,
        enabled: false,
      },
    }) as BrowserCreatedSkill;
    expect(idempotentDisable).toEqual(disabled);

    const afterToggle = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const toggled = afterToggle.skills.find(
      (candidate) => candidate.id === created.id,
    )!;
    expect(toggled.revision).toBe(created.revision + 1);
    const running = invoke("start_activity_opportunity_skill_draft", {
      request: {
        id: toggled.id,
        revision: toggled.revision,
        changeRequest: "Include the weekly growth delta.",
      },
    }) as BrowserSkillDraft;
    const revisionChatBytes = invoke("plugin:fs|read_text_file", {
      path: `/Users/screenpipe/.screenpipe/chats/${running.conversationId}.json`,
    }) as Uint8Array;
    const revisionChat = JSON.parse(
      new TextDecoder().decode(revisionChatBytes),
    ) as {
      title: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(revisionChat.title).toBe(
      "Revise write a daily activity brief skill",
    );
    expect(
      revisionChat.messages.find((message) => message.role === "user")?.content,
    ).toBe("Revise this skill: Include the weekly growth delta.");
    const whileDrafting = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    expect(
      whileDrafting.skills.find((candidate) => candidate.id === created.id),
    ).toMatchObject({
      status: "created",
      currentDraftId: running.id,
      createdSkill: {
        skillMd: original.skillMd,
        enabled: false,
      },
    });

    await Promise.resolve();
    const readySnapshot = invoke(
      "get_activity_opportunities",
    ) as BrowserOpportunitySnapshot;
    const readySkill = readySnapshot.skills.find(
      (candidate) => candidate.id === created.id,
    )!;
    const readyDraft = readySkill.drafts.find(
      (candidate) => candidate.id === running.id,
    )!;
    const installed = invoke("install_activity_opportunity_skill_draft", {
      request: {
        id: readySkill.id,
        revision: readySkill.revision,
        draftId: readyDraft.id,
      },
    }) as BrowserCreatedSkill;

    expect(installed).toMatchObject({
      key: original.key,
      path: original.path,
      createdAt: original.createdAt,
      enabled: false,
      installedDraftId: readyDraft.id,
    });
    expect(installed.skillMd).toContain(
      "Requested adjustment: Include the weekly growth delta.",
    );
    expect(installed.sha256).not.toBe(original.sha256);
  });

  it("records an idempotent unfinished-work handoff to one chat", () => {
    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "ready",
      apiPort: 3030,
    });
    const initial = invoke(
      "get_activity_opportunities",
    ) as ActivityOpportunitySnapshot;
    const task = initial.unfinished[0];
    const request = {
      id: task.id,
      revision: task.revision,
      conversationId: "chat-browser-1",
    };

    const handedOff = invoke("handoff_activity_opportunity", {
      request,
    }) as UnfinishedOpportunity;
    expect(handedOff).toMatchObject({
      revision: 2,
      status: "handed_off",
      conversationId: "chat-browser-1",
    });
    expect(invoke("handoff_activity_opportunity", { request })).toEqual(
      handedOff,
    );
    expect(
      commandError(() =>
        invoke("handoff_activity_opportunity", {
          request: { ...request, conversationId: "chat-browser-2" },
        }),
      ),
    ).toBe("This work is already handed off to another chat");
  });

  it("provides external schedules for browser design review", () => {
    const invoke = createBrowserIpcMock({ mode: "mock", apiPort: 3030 });
    const tasks = invoke("list_provider_automations") as Array<{
      provider: string;
      executionScope: string;
      availableActions: string[];
    }>;

    expect(tasks.map((task) => task.provider)).toEqual([
      "codex",
      "codex",
      "claude",
    ]);
    expect(tasks[0].availableActions).toContain("pause");
    expect(tasks[2].executionScope).toBe("session");
  });

  it("supports toggling extensions during browser design review", () => {
    const invoke = createBrowserIpcMock({ mode: "mock", apiPort: 3030 });

    expect(invoke("pi_list_extension_packages")).toEqual([]);
    expect(
      invoke("pi_install_extension_package", { source: "npm:@demo/tool" }),
    ).toEqual([
      expect.objectContaining({ source: "npm:@demo/tool", installed: true }),
    ]);
    expect(invoke("pi_list_extension_packages")).toEqual([
      expect.objectContaining({ source: "npm:@demo/tool", installed: true }),
    ]);
    expect(
      invoke("pi_remove_extension_package", { source: "npm:@demo/tool" }),
    ).toEqual([]);
  });

  it("returns useful empty engine responses", async () => {
    const health = mockLocalApiResponse(
      new URL("http://localhost:3030/health"),
      undefined,
      "ready",
    );
    const search = mockLocalApiResponse(
      new URL("http://localhost:3030/search?q=test"),
      undefined,
      "empty",
    );
    const keywordSearch = mockLocalApiResponse(
      new URL("http://localhost:3030/search/keyword?query=stripe+mrr"),
      undefined,
      "ready",
    );
    const memories = mockLocalApiResponse(
      new URL("http://localhost:3030/memories?limit=1"),
      undefined,
      "ready",
    );
    const artifacts = mockLocalApiResponse(
      new URL("http://localhost:3030/artifacts?limit=1000"),
      undefined,
      "ready",
    );
    const missingArtifact = mockLocalApiResponse(
      new URL("http://localhost:3030/artifacts?id=999999&limit=1"),
      undefined,
      "ready",
    );

    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe("healthy");
    expect(await search.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
    expect(await keywordSearch.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          representative: expect.objectContaining({
            app_name: "Stripe",
            text: expect.stringContaining("stripe mrr"),
          }),
          frame_ids: expect.any(Array),
        }),
      ]),
    );
    expect(await memories.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
    expect(await artifacts.json()).toMatchObject({
      data: [
        {
          id: 4242,
          title: "sync-summary.md",
          source: "imessage-sync",
        },
      ],
      pagination: { total: 1 },
    });
    expect(await missingArtifact.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
  });

  it("seeds a scheduled task for cloud-agent browser review", async () => {
    const pipes = mockLocalApiResponse(
      new URL("http://localhost:3030/pipes?include_executions=true"),
      undefined,
      "ready",
    );
    const status = mockLocalApiResponse(
      new URL("http://localhost:3030/cloud-agents/status"),
      undefined,
      "ready",
    );

    expect(await pipes.json()).toMatchObject({
      data: [
        {
          config: {
            name: "daily-recap",
            agent: "cloud-agent",
            cloud_agent: {
              provider: "codex",
              send_screenpipe_context: false,
            },
          },
        },
      ],
      pagination: { total: 1 },
    });
    expect(await status.json()).toMatchObject({
      providers: [
        { provider: "codex", configured: true },
        { provider: "claude", configured: false },
        { provider: "cursor", configured: false },
      ],
    });
  });

  it("supports an explicit backend failure scenario", async () => {
    const response = mockLocalApiResponse(
      new URL("http://localhost:3030/health"),
      undefined,
      "backend-error",
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "mock backend unavailable",
    });
  });

  it("can render a healthy empty-device state", () => {
    expect(createMockHealth("empty").monitors).toEqual([]);
    expect(createMockHealth("ready").monitors).toHaveLength(1);

    const invoke = createBrowserIpcMock({
      mode: "mock",
      scenario: "empty",
      apiPort: 3030,
    });
    expect(invoke("list_brain_views")).toEqual([]);
    expect(invoke("list_brain_view_template_kits")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "daily-memory" }),
        expect.objectContaining({ id: "meeting-follow-ups" }),
      ]),
    );
  });
});
