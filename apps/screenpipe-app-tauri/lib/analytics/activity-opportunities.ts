// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import posthog from "posthog-js";

export type ActivityOpportunityGroup = "ideas" | "created" | "unfinished";
export type ActivityOpportunityActionResult = "completed" | "failed";
export type ActivityOpportunityErrorKind =
  | "conflict"
  | "network"
  | "not_found"
  | "permission"
  | "storage"
  | "validation"
  | "unknown";

type ActionOutcome = {
  result: ActivityOpportunityActionResult;
  duration_ms: number;
  error_kind?: ActivityOpportunityErrorKind;
};

type SourceOutcome = ActionOutcome & {
  action: "added" | "excluded" | "included" | "removed";
  source_type: "added_activity" | "discovered_activity";
  evidence_count: number;
  supporting_context_count: number;
};

export type ActivityOpportunityEventProperties = {
  activity_opportunity_viewed: {
    group: ActivityOpportunityGroup;
    analysis_state: "loading" | "running" | "ready" | "error";
    skill_idea_count: number;
    skill_draft_count: number;
    created_skill_count: number;
    unfinished_count: number;
  };
  activity_opportunity_group_selected: {
    group: ActivityOpportunityGroup;
  };
  activity_opportunity_skill_opened: {
    destination: "created_skill" | "detail" | "draft_chat";
    status: "created" | "dismissed" | "drafting" | "pending";
    rank: number;
    occurrence_count: number;
    evidence_count: number;
    supporting_context_count: number;
    result: ActivityOpportunityActionResult;
    error_kind?: ActivityOpportunityErrorKind;
  };
  activity_opportunity_skill_rejected: ActionOutcome & {
    rank: number;
    occurrence_count: number;
    evidence_count: number;
  };
  activity_opportunity_skill_edited: ActionOutcome & {
    changed_name: boolean;
    changed_description: boolean;
    changed_notes: boolean;
  };
  activity_opportunity_skill_source_changed: SourceOutcome;
  activity_opportunity_skill_draft_requested: ActionOutcome & {
    occurrence_count: number;
    evidence_count: number;
    supporting_context_count: number;
    has_notes: boolean;
  };
  activity_opportunity_unfinished_opened: {
    rank: number;
    evidence_count: number;
  };
  activity_opportunity_unfinished_edited: ActionOutcome & {
    changed_description: boolean;
    changed_goal: boolean;
  };
  activity_opportunity_unfinished_source_changed: SourceOutcome;
  activity_opportunity_unfinished_dismissed: ActionOutcome & {
    evidence_count: number;
  };
  activity_opportunity_unfinished_restored: ActionOutcome & {
    restored_count: number;
  };
  activity_opportunity_unfinished_handoff: ActionOutcome & {
    evidence_count: number;
  };
  activity_opportunity_skill_draft_opened: {
    phase: "error" | "ready" | "running";
    presentation: "active" | "detached" | "historical" | "installed";
    evidence_count: number;
    supporting_context_count: number;
  };
  activity_opportunity_skill_draft_edited: {
    phase: "ready";
  };
  activity_opportunity_skill_test: ActionOutcome;
  activity_opportunity_skill_install: ActionOutcome;
  activity_opportunity_skill_revision: ActionOutcome & {
    source: "created_skill" | "draft";
  };
  activity_opportunity_skill_draft_retry: ActionOutcome & {
    requires_change: boolean;
  };
  activity_opportunity_skill_draft_chat_opened: ActionOutcome & {
    destination: "current_draft" | "draft_chat";
  };
  activity_opportunity_created_skill_opened: {
    enabled: boolean;
    evidence_count: number;
    supporting_context_count: number;
  };
  activity_opportunity_created_skill_enabled: ActionOutcome & {
    enabled: boolean;
  };
  activity_opportunity_created_skill_location_opened: ActionOutcome;
};

export function activityOpportunityErrorKind(
  error: unknown,
): ActivityOpportunityErrorKind {
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.toLowerCase();
  if (
    normalized.includes("revision") ||
    normalized.includes("conflict") ||
    normalized.includes("opportunity changed")
  ) {
    return "conflict";
  }
  if (normalized.includes("not found") || normalized.includes("missing")) {
    return "not_found";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("denied") ||
    normalized.includes("unauthorized")
  ) {
    return "permission";
  }
  if (
    normalized.includes("network") ||
    normalized.includes("offline") ||
    normalized.includes("connect") ||
    normalized.includes("timeout")
  ) {
    return "network";
  }
  if (
    normalized.includes("file") ||
    normalized.includes("directory") ||
    normalized.includes("persist") ||
    normalized.includes("storage")
  ) {
    return "storage";
  }
  if (
    normalized.includes("invalid") ||
    normalized.includes("required") ||
    normalized.includes("at least") ||
    normalized.includes("finalize")
  ) {
    return "validation";
  }
  return "unknown";
}

export function captureActivityOpportunityEvent<
  EventName extends keyof ActivityOpportunityEventProperties,
>(
  event: EventName,
  properties: ActivityOpportunityEventProperties[EventName],
): void {
  posthog.capture(event, properties);
}

export function activityOpportunityDuration(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
