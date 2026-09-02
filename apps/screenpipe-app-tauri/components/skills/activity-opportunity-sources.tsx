// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { useMemo } from "react";

import {
  ActivityEntryArtifacts,
  historyDocumentFromNative,
  type ActivityArtifact,
  type ActivityLedgerArtifactInterval,
} from "@/components/activity-ledger";
import type { SkillSource } from "@/components/skills/skill-source-list";
import type { ActivityHistoryEntry } from "@/lib/activity-review-prompt";
import type {
  OpportunityEvidence,
  SkillOpportunity,
  SkillSearchContext,
} from "@/lib/utils/tauri";

function opportunityEvidenceHref(evidence: OpportunityEvidence): string {
  const meetingId = evidence.meetingIds[0];
  if (meetingId) {
    const params = new URLSearchParams({
      section: "meetings",
      meetingId: String(meetingId),
      meetingView: "best",
    });
    return `/home?${params.toString()}`;
  }
  const frameId = evidence.frameReferences?.[0]?.frameId ?? evidence.frameIds[0];
  if (frameId) {
    return `screenpipe://frame/${frameId}?timestamp=${encodeURIComponent(evidence.startAt)}`;
  }
  return `screenpipe://timeline?timestamp=${encodeURIComponent(evidence.startAt)}`;
}

function searchContextHref(context: SkillSearchContext): string {
  if (context.representativeFrameId) {
    return `screenpipe://frame/${context.representativeFrameId}?timestamp=${encodeURIComponent(context.representativeTimestamp)}`;
  }
  return `screenpipe://timeline?timestamp=${encodeURIComponent(context.startAt)}`;
}

function sourceMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function activityEntryForOpportunityEvidence(
  source: OpportunityEvidence,
): ActivityHistoryEntry {
  const meetingEvidence: ActivityArtifact[] = source.meetingIds.map(
    (meetingId) => ({
      kind: "meeting",
      at: source.startAt,
      frame_id: null,
      meeting_id: meetingId,
      app_name: source.apps[0] ?? null,
      label: source.title,
    }),
  );
  const screenEvidence: ActivityArtifact[] = (source.frameReferences ?? []).map(
    (reference) => ({
      kind: "screen",
      at: reference.timestamp,
      frame_id: reference.frameId,
      meeting_id: null,
      app_name: reference.appName,
      browser_url: reference.browserUrl ?? null,
      label: reference.windowName || source.title,
    }),
  );

  if (screenEvidence.length === 0) {
    screenEvidence.push(
      ...source.apps.map((app, index) => ({
        kind: "screen" as const,
        at: source.startAt,
        frame_id: source.frameIds[index] ?? source.frameIds[0] ?? null,
        meeting_id: null,
        app_name: app,
        label: source.title,
      })),
    );
  }

  if (screenEvidence.length === 0 && source.frameIds.length > 0) {
    screenEvidence.push({
      kind: "screen",
      at: source.startAt,
      frame_id: source.frameIds[0],
      meeting_id: null,
      app_name: null,
      label: source.title,
    });
  }
  if (meetingEvidence.length === 0 && screenEvidence.length === 0) {
    screenEvidence.push({
      kind: "screen",
      at: source.startAt,
      frame_id: null,
      meeting_id: null,
      app_name: null,
      label: source.title,
    });
  }

  return {
    id: source.activityId,
    kind: meetingEvidence.length > 0 ? "meeting" : "work",
    meeting_id: source.meetingIds[0] ?? null,
    start_at: source.startAt,
    end_at: source.endAt,
    title: source.title,
    summary: source.summary,
    evidence: [...meetingEvidence, ...screenEvidence],
  };
}

export function activityEntryForSearchContext(
  context: SkillSearchContext,
): ActivityHistoryEntry {
  const storedActivity = context.activity
    ? historyDocumentFromNative([context.activity])?.entries[0]
    : null;
  if (storedActivity) return storedActivity;

  const title = context.windowName.trim() || context.query;
  const evidence: ActivityArtifact[] = [];

  if (context.appName) {
    evidence.push({
      kind: "screen",
      at: context.representativeTimestamp,
      frame_id: context.representativeFrameId,
      meeting_id: null,
      app_name: context.appName,
      browser_url: null,
      label: title,
    });
  }
  if (context.url) {
    evidence.push({
      kind: "screen",
      at: context.representativeTimestamp,
      frame_id: context.representativeFrameId,
      meeting_id: null,
      app_name: null,
      browser_url: context.url,
      label: title,
    });
  }
  if (evidence.length === 0) {
    evidence.push({
      kind: "screen",
      at: context.representativeTimestamp,
      frame_id: context.representativeFrameId,
      meeting_id: null,
      app_name: null,
      label: title,
    });
  }

  return {
    id: context.id,
    kind: "work",
    meeting_id: null,
    start_at: context.startAt,
    end_at: context.endAt,
    title,
    summary: context.snippet,
    evidence,
  };
}

export function ActivityOpportunitySourceArtifacts({
  source,
}: {
  source: OpportunityEvidence | SkillSearchContext;
}) {
  const { entry, intervals } = useMemo(() => {
    if ("activityId" in source) {
      const entry = activityEntryForOpportunityEvidence(source);
      return {
        entry,
        intervals: (source.frameReferences ?? []).map((reference) => {
          const at = new Date(reference.timestamp).getTime();
          const entryStart = new Date(source.startAt).getTime();
          const entryEnd = new Date(source.endAt).getTime();
          const startAt = Number.isFinite(at)
            ? Math.max(entryStart, at - 30_000)
            : entryStart;
          const endAt = Number.isFinite(at)
            ? Math.min(entryEnd, Math.max(startAt + 1_000, at + 30_000))
            : entryEnd;
          return {
            start_at: new Date(startAt).toISOString(),
            end_at: new Date(endAt).toISOString(),
            app_name: reference.appName || null,
            evidence: [
              {
                source_type: "activity-history",
                source_id: reference.frameId,
                occurred_at: reference.timestamp,
                frame_id: reference.frameId,
                app_name: reference.appName || null,
                window_title: reference.windowName || null,
                browser_url: reference.browserUrl ?? null,
              },
            ],
          };
        }) satisfies ActivityLedgerArtifactInterval[],
      };
    }
    return {
      entry: activityEntryForSearchContext(source),
      intervals: source.activity
        ? ([] as ActivityLedgerArtifactInterval[])
        : ([
            {
              start_at: source.startAt,
              end_at: source.endAt,
              app_name: source.appName || null,
              evidence: [
                {
                  source_type: source.source,
                  source_id: source.representativeFrameId,
                  occurred_at: source.representativeTimestamp,
                  frame_id: source.representativeFrameId,
                  app_name: source.appName || null,
                  window_title: source.windowName || null,
                  browser_url: source.url || null,
                },
              ],
            },
          ] satisfies ActivityLedgerArtifactInterval[]),
    };
  }, [source]);

  return (
    <ActivityEntryArtifacts
      entry={entry}
      intervals={intervals}
      artifactsLoading={false}
    />
  );
}

export function activityOpportunitySkillSources(
  opportunity: SkillOpportunity,
): SkillSource[] {
  const activitySources: SkillSource[] = opportunity.evidence
    .filter((evidence) => !evidence.excluded)
    .map((evidence) => ({
      id: evidence.activityId,
      label: evidence.title,
      detail: [sourceMoment(evidence.startAt), evidence.apps.join(", ")]
        .filter(Boolean)
        .join(" / "),
      href: opportunityEvidenceHref(evidence),
      artifacts: <ActivityOpportunitySourceArtifacts source={evidence} />,
    }));

  const searchContexts: SkillSource[] = (
    opportunity.supportingContexts ?? []
  ).map((context) => ({
    id: context.id,
    label: context.windowName.trim() || context.query,
    detail: [
      context.source === "activity-history"
        ? "added activity"
        : "search context",
      sourceMoment(context.startAt),
      context.appName,
    ]
      .filter(Boolean)
      .join(" / "),
    href: searchContextHref(context),
    artifacts: <ActivityOpportunitySourceArtifacts source={context} />,
  }));

  return [...activitySources, ...searchContexts];
}
