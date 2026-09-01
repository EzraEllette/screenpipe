// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, Plus, Search } from "lucide-react";

import {
  ActivityHistoryRow,
  historyDocumentFromNative,
} from "@/components/activity-ledger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ActivityHistoryEntry } from "@/lib/activity-review-prompt";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";
import { commands } from "@/lib/utils/tauri";

const ACTIVITY_HISTORY_START = new Date(0).toISOString();
const RESULT_LIMIT = 12;

export interface ActivitySearchContext {
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
}

export interface ActivityContextPickerProps {
  onSelect: (context: ActivitySearchContext) => void | Promise<void>;
  trigger?: React.ReactElement;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function normalizedQueryTerms(query: string): string[] {
  return query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

export function activityMatchesQuery(
  entry: ActivityHistoryEntry,
  query: string,
): boolean {
  const terms = normalizedQueryTerms(query);
  if (terms.length === 0) return true;
  const searchableText = [
    entry.title,
    entry.summary,
    ...entry.evidence.flatMap((evidence) => [
      evidence.app_name ?? "",
      evidence.label,
    ]),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => searchableText.includes(term));
}

export function buildActivitySearchContext(
  query: string,
  entry: ActivityHistoryEntry,
): ActivitySearchContext {
  const frameIds = Array.from(
    new Set(
      entry.evidence.flatMap((evidence) =>
        evidence.kind === "screen" &&
        evidence.frame_id !== null &&
        Number.isSafeInteger(evidence.frame_id) &&
        evidence.frame_id > 0
          ? [evidence.frame_id]
          : [],
      ),
    ),
  );
  const representative =
    entry.evidence.find(
      (evidence) =>
        evidence.kind === "screen" &&
        evidence.frame_id !== null &&
        evidence.frame_id > 0,
    ) ?? entry.evidence[0];
  const appName =
    entry.evidence.find((evidence) => evidence.app_name?.trim())?.app_name ??
    "";

  return {
    source: "activity-history",
    query: query.trim() || entry.title,
    startAt: entry.start_at,
    endAt: entry.end_at,
    frameIds,
    representativeFrameId: representative?.frame_id ?? 0,
    representativeTimestamp: representative?.at ?? entry.start_at,
    appName,
    windowName: entry.title,
    snippet: entry.summary,
    url: "",
    activity: entry,
  };
}

function formatActivityMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ResultRow({
  entry,
  disabled,
  selecting,
  onSelect,
}: {
  entry: ActivityHistoryEntry;
  disabled: boolean;
  selecting: boolean;
  onSelect: () => void;
}) {
  return (
    <ActivityHistoryRow
      entry={entry}
      timeLabel={formatActivityMoment(entry.start_at)}
      role="listitem"
      className="px-5 transition-colors duration-150 hover:bg-muted/40"
      actions={
        <button
          type="button"
          disabled={disabled}
          onClick={onSelect}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
          aria-label={`Add ${entry.title}`}
        >
          {selecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          add
        </button>
      }
    />
  );
}

export function ActivityContextPicker({
  onSelect,
  trigger,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: ActivityContextPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activities, setActivities] = useState<ActivityHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadRequestRef = useRef(0);
  const open = controlledOpen ?? internalOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setQuery("");
        setSelectingId(null);
        setSelectionError(null);
        setActivities([]);
      } else {
        loadRequestRef.current += 1;
        setLoading(false);
      }
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );

  const loadActivities = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await commands.getActivityHistory(
        ACTIVITY_HISTORY_START,
        new Date().toISOString(),
      );
      if (result.status === "error") throw new Error(result.error);
      if (request !== loadRequestRef.current) return;
      const history = historyDocumentFromNative(result.data.entries);
      setActivities(history?.entries ?? []);
    } catch (error) {
      if (request !== loadRequestRef.current) return;
      setLoadError(
        error instanceof Error ? error.message : "could not load activities",
      );
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadActivities();
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      loadRequestRef.current += 1;
    };
  }, [loadActivities, open]);

  useTauriEvent("activity-history-updated", () => {
    if (open) void loadActivities();
  });

  const matchingActivities = useMemo(() => {
    if (!query.trim()) return [];
    return activities
      .filter((entry) => activityMatchesQuery(entry, query))
      .sort(
        (left, right) =>
          new Date(right.start_at).getTime() -
          new Date(left.start_at).getTime(),
      )
      .slice(0, RESULT_LIMIT);
  }, [activities, query]);

  const selectActivity = useCallback(
    async (entry: ActivityHistoryEntry) => {
      setSelectingId(entry.id);
      setSelectionError(null);
      try {
        await onSelect(buildActivitySearchContext(query, entry));
        setOpen(false);
      } catch (error) {
        setSelectionError(
          error instanceof Error
            ? error.message
            : "could not add this activity",
        );
      } finally {
        setSelectingId(null);
      }
    },
    [onSelect, query, setOpen],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild disabled={disabled}>
        {trigger ?? (
          <Button type="button" variant="ghost" size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            add activity
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>add activity</DialogTitle>
          <DialogDescription>
            find an activity that belongs in this skill
          </DialogDescription>
        </DialogHeader>

        <div className="relative border-b border-border p-3">
          <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectionError(null);
            }}
            placeholder="search activities"
            aria-label="search activities"
            autoComplete="off"
            className="pl-9"
          />
        </div>

        <div
          role="list"
          aria-label="activity search results"
          className="max-h-[min(62vh,560px)] min-h-44 overflow-y-auto"
        >
          {matchingActivities.map((entry) => (
            <ResultRow
              key={`${entry.id}:${entry.start_at}`}
              entry={entry}
              disabled={selectingId !== null}
              selecting={selectingId === entry.id}
              onSelect={() => void selectActivity(entry)}
            />
          ))}

          {matchingActivities.length === 0 ? (
            <div className="flex min-h-44 items-center justify-center px-6 text-center font-mono text-xs text-muted-foreground">
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  loading activities
                </span>
              ) : loadError ? (
                <span role="alert">activities unavailable. try again</span>
              ) : !query.trim() ? (
                "type to search activities"
              ) : activities.length === 0 ? (
                "no generated activities yet"
              ) : (
                `no activities found for “${query.trim()}”`
              )}
            </div>
          ) : null}
        </div>

        {selectionError ? (
          <p
            role="alert"
            className="border-t border-border px-4 py-2 text-xs text-destructive"
          >
            {selectionError}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
