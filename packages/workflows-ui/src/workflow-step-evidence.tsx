// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Play, X } from "lucide-react";
import type { WorkflowMap, WorkflowStage } from "./model";
import type { WorkflowsPlatform } from "./platform";
import { CapturedMomentButton, WorkflowReplay } from "./workflow-replay";
import styles from "./workflow-step-evidence.module.css";

const when = (value: string) => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";

export function WorkflowStepEvidence({ workflow, stage, platform }: {
  workflow: WorkflowMap; stage: WorkflowStage; platform: WorkflowsPlatform;
}) {
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const replay = useMemo(() => ({ ...workflow, stages: [stage] }), [workflow, stage]);
  const screenshot = stage.screenshot?.visualVerified ? stage.screenshot : null;
  const sources = [...(stage.procedure ?? []).filter(p => p.quote).map(p => ({ text: p.quote, timestamp: p.timestamp, app: p.app })),
    ...stage.evidence.map(e => ({ text: e.detail, timestamp: e.timestamp, app: e.app }))]
    .filter((entry, index, all) => entry.text && all.findIndex(e => e.text === entry.text && e.timestamp === entry.timestamp && e.app === entry.app) === index);
  const canReplay = platform.loadWorkflowRecording && stage.evidence.some(e => !["audio", "meeting"].includes(e.source ?? "") && Number.isFinite(Date.parse(e.timestamp)));
  return <section className={`${styles.evidence} ph-no-capture ph-mask`} aria-label={`References for ${stage.name}`}>
    {screenshot && !playing && <figure className={`${styles.figure} ${expanded ? styles.expanded : ""}`}>
      <button className={styles.imageButton} type="button" aria-label={`${expanded ? "Reduce" : "Enlarge"} screenshot for ${stage.name}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <img src={screenshot.dataUrl} alt={`Captured reference for ${stage.name}`} loading="lazy" draggable={false} data-lm-disable="true" />
        <span className={styles.zoom}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</span>
      </button>
      <figcaption><span>{screenshot.app} · {when(screenshot.timestamp)}</span><CapturedMomentButton compact frameId={screenshot.frameId} timestamp={screenshot.timestamp} open={platform.openCapturedMoment} /></figcaption>
    </figure>}
    {playing && <div className={styles.player}>
      <button type="button" className={styles.close} aria-label={`Close recording for ${stage.name}`} title="Close recording" onClick={() => setPlaying(false)}><X size={15} /></button>
      <WorkflowReplay workflow={replay} loadRecording={platform.loadWorkflowRecording} releaseRecording={platform.releaseWorkflowRecording} openCapturedMoment={platform.openCapturedMoment} />
    </div>}
    <div className={styles.links}>
      {canReplay && !playing && <button type="button" onClick={() => setPlaying(true)} aria-label={`View recording for ${stage.name}`}><Play size={13} />View recording</button>}
      {!!sources.length && <details className={styles.sources}>
        <summary>{sources.length} source{sources.length === 1 ? "" : "s"}<ChevronDown size={12} /></summary>
        <div className={styles.sourceList}>
          {sources.map((source, index) => <details className={styles.rawSource} key={`${source.timestamp}-${index}`}>
            <summary><span>{source.app || "Captured source"} · {when(source.timestamp)}</span><span>Captured text<ChevronDown size={12} /></span></summary>
            <div className={styles.rawText} role="region" aria-label={`Captured text ${index + 1} for ${stage.name}`} tabIndex={0}>{source.text}</div>
          </details>)}
        </div>
      </details>}
    </div>
    {!!stage.openQuestions?.length && <details className={styles.questions}><summary>Unresolved details<ChevronDown size={12} /></summary><ul>{stage.openQuestions.map(q => <li key={q}>{q}</li>)}</ul></details>}
  </section>;
}
