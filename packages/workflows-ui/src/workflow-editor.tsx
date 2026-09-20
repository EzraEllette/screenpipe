// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Plus,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { WorkflowMap } from "./model";
import {
  moveBlock,
  validWorkflowEdit,
  workflowEdit,
  type WorkflowEdit,
  type StageEdit,
} from "./workflow-edits";
import styles from "./workflow-editor.module.css";

function Text({
  label,
  value,
  onChange,
  title = false,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  title?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "0px";
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        resize();
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={label}
      placeholder={label}
      className={title ? styles.title : undefined}
      value={value}
      maxLength={8000}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function WorkflowEditor({
  workflow,
  save,
  close,
}: {
  workflow: WorkflowMap;
  save: (draft: WorkflowEdit) => Promise<void>;
  close: () => void;
}) {
  const key = `screenpipe:workflow-edit:${workflow.id ?? workflow.title}`;
  const [initial] = useState(() => workflowEdit(workflow));
  const [draft, setDraft] = useState<WorkflowEdit>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (saved?.id === initial.id && validWorkflowEdit(saved, true))
        return saved;
    } catch {
      /* Optional tab-local recovery. */
    }
    return initial;
  });
  const [history, setHistory] = useState<WorkflowEdit[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragging = useRef<{ stage: number; detail?: number } | null>(null);
  const busy = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const valid = validWorkflowEdit(draft);
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
    } catch {
      /* Editing still works when storage is full/disabled. */
    }
  }, [draft, dirty, key]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change(next: WorkflowEdit) {
    setHistory((h) => [...h.slice(-49), draft]);
    setDraft(next);
    setError("");
  }
  function stageChange(index: number, next: StageEdit) {
    change({
      ...draft,
      stages: draft.stages.map((s, i) => (i === index ? next : s)),
    });
  }
  function moveStage(from: number, to: number) {
    const stages = moveBlock(draft.stages, from, to);
    if (stages !== draft.stages) {
      change({ ...draft, stages });
      setAnnouncement(`Step moved to position ${to + 1}`);
    }
  }
  function moveDetail(stage: number, from: number, to: number) {
    const old = draft.stages[stage];
    const procedure = moveBlock(old.procedure, from, to);
    if (old.procedure !== procedure) {
      stageChange(stage, { ...old, procedure });
      setAnnouncement(`Block moved to position ${to + 1}`);
    }
  }
  function focusField(label: string) {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
        ?.focus(),
    );
  }
  function clearDraft() {
    try {
      sessionStorage.removeItem(key);
    } catch {}
  }
  async function submit() {
    if (!dirty || !valid || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await save(draft);
      clearDraft();
      close();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not save. Your draft is still here.",
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <section
      className={styles.editor}
      aria-label="Edit workflow"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
        // Keep host navigation shortcuts out of editable blocks.
        e.stopPropagation();
      }}
    >
      <header className={styles.toolbar}>
        <div>
          <strong>Edit workflow</strong>
          <span role="status">
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : "Your edits stay through AI updates"}
          </span>
        </div>
        <div>
          <button
            type="button"
            title="Undo last edit"
            aria-label="Undo last edit"
            disabled={!history.length || saving}
            onClick={() => {
              setDraft(history[history.length - 1]);
              setHistory((h) => h.slice(0, -1));
              setError("");
            }}
          >
            <Undo2 size={17} />
          </button>
          <button
            type="button"
            title="Cancel edits"
            aria-label="Cancel edits"
            disabled={saving}
            onClick={() => {
              clearDraft();
              close();
            }}
          >
            <X size={17} />
          </button>
          <button
            type="button"
            className={styles.save}
            disabled={!dirty || !valid || saving}
            onClick={() => void submit()}
          >
            <Check size={16} />
            Save
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {draft.expected_revision !== (workflow.revision ?? 0) && (
        <p role="alert" className={styles.error}>
          A newer version is available. Your draft is kept.{" "}
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              clearDraft();
              close();
            }}
          >
            Discard draft and view latest
          </button>
        </p>
      )}
      <fieldset disabled={saving}>
        <div className={styles.intro}>
          <Text
            title
            label="Workflow title"
            value={draft.title}
            onChange={(title) => change({ ...draft, title })}
          />
          <Text
            label="Workflow description"
            value={draft.description}
            onChange={(description) => change({ ...draft, description })}
          />
        </div>
        <label className={styles.endpoint}>
          Starts when
          <Text
            label="Workflow trigger"
            value={draft.trigger}
            onChange={(trigger) => change({ ...draft, trigger })}
          />
        </label>
        <div className={styles.steps}>
          {draft.stages.map((stage, index) => (
            <article
              className={`${styles.step} ${dragOver === index ? styles.drop : ""}`}
              key={
                stage.sourceIndex === null
                  ? `new-${index}`
                  : `source-${stage.sourceIndex}`
              }
              aria-label={`Step ${index + 1}`}
              onDragOver={(e) => {
                if (
                  dragging.current?.detail === undefined &&
                  dragging.current
                ) {
                  e.preventDefault();
                  setDragOver(index);
                }
              }}
              onDrop={(e) => {
                if (
                  dragging.current?.detail === undefined &&
                  dragging.current
                ) {
                  e.preventDefault();
                  moveStage(dragging.current.stage, index);
                  dragging.current = null;
                  setDragOver(null);
                }
              }}
            >
              <div className={styles.stepTop}>
                <button
                  type="button"
                  className={styles.grip}
                  draggable
                  title="Drag step. Alt + Up/Down to reorder."
                  aria-label={`Move step ${index + 1}`}
                  onKeyDown={(e) => {
                    if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
                      e.preventDefault();
                      moveStage(index, index + (e.key === "ArrowUp" ? -1 : 1));
                    }
                  }}
                  onDragStart={(e) => {
                    dragging.current = { stage: index };
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", "workflow-step");
                  }}
                  onDragEnd={() => {
                    dragging.current = null;
                    setDragOver(null);
                  }}
                >
                  <GripVertical size={18} />
                </button>
                <span className={styles.number}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className={styles.controls}>
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => moveStage(index, index - 1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} down`}
                    title="Move down"
                    disabled={index === draft.stages.length - 1}
                    onClick={() => moveStage(index, index + 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete step ${index + 1}`}
                    title="Delete step"
                    disabled={draft.stages.length === 1}
                    onClick={() =>
                      change({
                        ...draft,
                        stages: draft.stages.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <Text
                title
                label={`Step ${index + 1} title`}
                value={stage.name}
                onChange={(name) => stageChange(index, { ...stage, name })}
              />
              <Text
                label={`Step ${index + 1} description`}
                value={stage.description}
                onChange={(description) =>
                  stageChange(index, { ...stage, description })
                }
              />
              <div className={styles.blocks}>
                {stage.procedure.map((detail, detailIndex) => (
                  <div
                    className={styles.block}
                    key={
                      detail.sourceIndex === null
                        ? `new-${detailIndex}`
                        : `source-${detail.sourceIndex}`
                    }
                    onDragOver={(e) => {
                      if (
                        dragging.current?.stage === index &&
                        dragging.current.detail !== undefined
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                    }}
                    onDrop={(e) => {
                      if (
                        dragging.current?.stage === index &&
                        dragging.current.detail !== undefined
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        moveDetail(index, dragging.current.detail, detailIndex);
                        dragging.current = null;
                      }
                    }}
                  >
                    <button
                      className={styles.grip}
                      type="button"
                      draggable
                      title="Drag block. Alt + Up/Down to reorder."
                      aria-label={`Move block ${detailIndex + 1} in step ${index + 1}`}
                      onKeyDown={(e) => {
                        if (
                          e.altKey &&
                          ["ArrowUp", "ArrowDown"].includes(e.key)
                        ) {
                          e.preventDefault();
                          moveDetail(
                            index,
                            detailIndex,
                            detailIndex + (e.key === "ArrowUp" ? -1 : 1),
                          );
                        }
                      }}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        dragging.current = {
                          stage: index,
                          detail: detailIndex,
                        };
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", "workflow-block");
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                      }}
                    >
                      <GripVertical size={15} />
                    </button>
                    <select
                      aria-label={`Block ${detailIndex + 1} type in step ${index + 1}`}
                      value={detail.kind}
                      onChange={(e) =>
                        stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.map((p, i) =>
                            i === detailIndex
                              ? { ...p, kind: e.target.value as typeof p.kind }
                              : p,
                          ),
                        })
                      }
                    >
                      {["action", "input", "output", "decision", "check"].map(
                        (kind) => (
                          <option key={kind}>{kind}</option>
                        ),
                      )}
                    </select>
                    <Text
                      label={`Block ${detailIndex + 1} in step ${index + 1}`}
                      value={detail.text}
                      onChange={(text) =>
                        stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.map((p, i) =>
                            i === detailIndex ? { ...p, text } : p,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      title="Delete block"
                      aria-label={`Delete block ${detailIndex + 1} in step ${index + 1}`}
                      onClick={() =>
                        stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.filter(
                            (_, i) => i !== detailIndex,
                          ),
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={styles.add}
                disabled={stage.procedure.length >= 100}
                onClick={() => {
                  stageChange(index, {
                    ...stage,
                    procedure: [
                      ...stage.procedure,
                      { sourceIndex: null, kind: "action", text: "" },
                    ],
                  });
                  focusField(
                    `Block ${stage.procedure.length + 1} in step ${index + 1}`,
                  );
                }}
              >
                <Plus size={14} />
                Add block
              </button>
            </article>
          ))}
        </div>
        <button
          type="button"
          className={styles.addStep}
          disabled={draft.stages.length >= 100}
          onClick={() => {
            change({
              ...draft,
              stages: [
                ...draft.stages,
                { sourceIndex: null, name: "", description: "", procedure: [] },
              ],
            });
            focusField(`Step ${draft.stages.length + 1} title`);
          }}
        >
          <Plus size={16} />
          Add step
        </button>
        <label className={styles.endpoint}>
          Ends with
          <Text
            label="Workflow outcome"
            value={draft.outcome}
            onChange={(outcome) => change({ ...draft, outcome })}
          />
        </label>
      </fieldset>
      <p className={styles.note}>
        Captured sources are preserved as references. Edited instructions are
        not verified observations.
      </p>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
