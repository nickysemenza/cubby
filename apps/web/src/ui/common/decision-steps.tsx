import type { DecisionStep } from "@cubby/schemas/decision-step";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { RecordDot, RecordList, RecordRow } from "./record-list";

import "./decision-steps.css";

export interface DecisionStepsProps {
  steps: readonly DecisionStep[];
  renderBody: (step: DecisionStep) => ReactNode;
  media?: ReactNode;
  renderAction?: (step: DecisionStep) => ReactNode;
  "aria-label"?: string;
}

const statusLabel = {
  done: "Done",
  needs_input: "Needs you",
  blocked: "Blocked",
  not_needed: "Not needed",
} as const;

/** Interactive RecordList timeline. Hidden bodies stay mounted so form drafts and receipts survive. */
export function DecisionSteps({
  steps,
  renderBody,
  media,
  renderAction,
  "aria-label": label = "Decisions",
}: DecisionStepsProps) {
  const id = useId();
  const [openKey, setOpenKey] = useState<string | null>(
    () => steps.find((step) => step.status === "needs_input")?.key ?? null,
  );
  const selected = steps.find((step) => step.key === openKey);
  const effectiveKey =
    openKey === null
      ? null
      : selected &&
          selected.status !== "blocked" &&
          selected.status !== "not_needed"
        ? openKey
        : (steps.find((step) => step.status === "needs_input")?.key ?? null);
  const root = useRef<HTMLDivElement>(null);
  const previousKey = useRef(effectiveKey);
  useEffect(() => {
    if (previousKey.current === effectiveKey) return;
    previousKey.current = effectiveKey;
    const body = root.current?.querySelector<HTMLElement>(
      "[data-decision-body]:not([hidden])",
    );
    const target = body?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role="combobox"], a[href], [tabindex="0"]',
    );
    (target ?? body)?.focus();
  }, [effectiveKey]);

  return (
    <div
      ref={root}
      className="decision-steps"
      data-with-media={media ? "" : undefined}
    >
      {media ? <div className="decision-steps-media">{media}</div> : null}
      <RecordList
        variant="timeline"
        aria-label={label}
        className="decision-steps-ledger"
      >
        {steps.map((step, index) => {
          const expanded = effectiveKey === step.key;
          const disabled =
            step.status === "blocked" || step.status === "not_needed";
          const bodyId = `${id}-body-${index}`;
          const triggerId = `${id}-trigger-${index}`;
          return (
            <RecordRow
              key={step.key}
              leading={
                <RecordDot
                  label={statusLabel[step.status]}
                  state={
                    step.status === "done"
                      ? "done"
                      : step.status === "not_needed"
                        ? "skipped"
                        : step.status === "blocked"
                          ? "not_reached"
                          : undefined
                  }
                  color={
                    step.status === "needs_input" ? "var(--signal)" : undefined
                  }
                />
              }
              primary={
                <>
                  <span className="font-medium">{step.label}</span>
                  <span
                    className="decision-step-summary"
                    data-create={
                      step.key === "product" && step.action === "create"
                        ? ""
                        : undefined
                    }
                  >
                    {[step.summary, step.blockedReason]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </>
              }
              actions={
                <>
                  {renderAction?.(step)}
                  <button
                    type="button"
                    id={triggerId}
                    aria-label={
                      step.status === "done"
                        ? `Change ${step.label}`
                        : disabled
                          ? step.label
                          : `${expanded ? "Close" : "Open"} ${step.label}`
                    }
                    aria-expanded={expanded}
                    aria-controls={bodyId}
                    disabled={disabled}
                    onClick={() => setOpenKey(expanded ? null : step.key)}
                    className="decision-step-trigger"
                  >
                    {disabled
                      ? statusLabel[step.status]
                      : step.status === "done"
                        ? "change"
                        : expanded
                          ? "close"
                          : "open"}
                  </button>
                </>
              }
              detail={
                <section
                  id={bodyId}
                  aria-labelledby={triggerId}
                  tabIndex={-1}
                  hidden={!expanded}
                  data-decision-body
                >
                  {renderBody(step)}
                </section>
              }
            />
          );
        })}
      </RecordList>
    </div>
  );
}
