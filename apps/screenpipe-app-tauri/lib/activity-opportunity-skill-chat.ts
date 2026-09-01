// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ActivityOpportunitySnapshot } from "@/lib/utils/tauri";

const SKILL_DRAFT_CONVERSATION_PREFIX = "skill-draft-";

export function isActivityOpportunitySkillDraftConversation(
  conversationId: string | null | undefined,
): boolean {
  return conversationId?.startsWith(SKILL_DRAFT_CONVERSATION_PREFIX) ?? false;
}

export function findActivityOpportunitySkillDraftPath(
  snapshot: ActivityOpportunitySnapshot,
  conversationId: string,
): string | null {
  return findActivityOpportunitySkillDraftChat(snapshot, conversationId)?.path
    ?? null;
}

export function findActivityOpportunitySkillDraftChat(
  snapshot: ActivityOpportunitySnapshot,
  conversationId: string,
): { path: string; title: string | null } | null {
  for (const opportunity of snapshot.skills) {
    const draftIndex = opportunity.drafts?.findIndex(
      (candidate) => candidate.conversationId === conversationId,
    ) ?? -1;
    if (draftIndex < 0) continue;
    const draft = opportunity.drafts?.[draftIndex];
    if (!draft) continue;
    const createdSkill = opportunity.createdSkill;
    const path =
      createdSkill && createdSkill.installedDraftId === draft.id
        ? createdSkill.path
        : draft.path;
    const skillName = opportunity.name?.trim();
    return {
      path,
      title: skillName
        ? `${draftIndex > 0 ? "Revise" : "Create"} ${skillName} skill`
        : null,
    };
  }
  return null;
}
