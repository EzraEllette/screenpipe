// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { normalizeTimeFields } from "./time-normalization";

type CallApi = (endpoint: string) => Promise<Response>;

type ActivityEvidence = {
  kind?: string;
  at?: string;
  frame_id?: number;
  meeting_id?: number;
  app_name?: string;
  label?: string;
};

type ActivityContent = {
  id?: string;
  producer?: string;
  kind?: string;
  meeting_id?: number;
  start_at?: string;
  end_at?: string;
  title?: string;
  summary?: string;
  evidence?: ActivityEvidence[];
};

function evidenceLine(evidence: ActivityEvidence): string {
  const context = [
    evidence.at,
    evidence.app_name,
    evidence.frame_id != null ? `frame:${evidence.frame_id}` : undefined,
    evidence.meeting_id != null ? `meeting:${evidence.meeting_id}` : undefined,
    evidence.kind,
  ].filter(Boolean);
  const prefix = context.length ? `${context.join(" | ")} — ` : "";
  return `  - ${prefix}${evidence.label || "evidence"}`;
}

export function formatActivityRecord(content: ActivityContent): string {
  const identity = content.id || "?";
  const metadata = [content.kind, content.producer].filter(Boolean).join(" | ");
  const timeRange = `${content.start_at || "?"} → ${content.end_at || "?"}`;
  const meeting = content.meeting_id != null ? ` | meeting:${content.meeting_id}` : "";
  const evidence = Array.isArray(content.evidence) ? content.evidence : [];
  const evidenceText = evidence.length
    ? `Evidence for Activity ${identity} (pair these frames only with this Activity ID):\n${evidence.map(evidenceLine).join("\n")}`
    : "Evidence: none";

  return (
    `[Activity ${identity}] ${content.title || "Untitled activity"}\n` +
    `${timeRange}${metadata ? ` | ${metadata}` : ""}${meeting}\n` +
    `${content.summary || ""}\n` +
    evidenceText
  );
}

export async function buildActivitySearchResult(
  args: Record<string, unknown>,
  callApi: CallApi,
): Promise<{ text: string; hasResults: boolean }> {
  const normalized = normalizeTimeFields(args);
  const params = new URLSearchParams({ content_type: "activity" });
  for (const key of [
    "q",
    "start_time",
    "end_time",
    "limit",
    "offset",
    "order",
    "max_content_length",
    "filter_pii",
  ]) {
    const value = normalized[key];
    if (value !== null && value !== undefined && value !== "") {
      params.append(key, String(value));
    }
  }

  const response = await callApi(`/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Activity search returned HTTP ${response.status}`);
  }
  const data = await response.json();
  const results = Array.isArray(data.data)
    ? data.data.filter((item: { type?: string }) => item.type === "Activity")
    : [];
  const pagination = data.pagination || {};

  if (results.length === 0) {
    return {
      text: "No generated activities found. Try a wider time range or omit q.",
      hasResults: false,
    };
  }

  const total = pagination.total ?? "?";
  const nextOffset = (pagination.offset || 0) + results.length;
  const next =
    typeof pagination.total === "number" && pagination.total > nextOffset
      ? ` (use offset=${nextOffset} for more)`
      : "";
  return {
    text:
      `Activities: ${results.length}/${total}${next}\n\n` +
      results
        .map((result: { content?: ActivityContent }) => formatActivityRecord(result.content || {}))
        .join("\n---\n"),
    hasResults: true,
  };
}
