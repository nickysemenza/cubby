import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import { HIGH_CONFIDENCE_PROBABILITY } from "@cubby/schemas/ai-evaluation";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { z } from "zod";

import { CategoryLabelById } from "~/entity/presentation/category-label";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Description } from "~/ui/text/description";

import { formatProbability } from "./field-suggestion";
import { SuggestionBody } from "./suggestion-body";

export type SuggestionSurface = "inline" | "line";

/** A proposal a person can act on: a different value Cubby is confident in. */
export function actionableSuggestion(
  suggestion: FieldSuggestion | null,
  current: string | null,
): suggestion is FieldSuggestion & { value: string } {
  if (!suggestion?.value || suggestion.value === current) return false;
  if (suggestion.probability == null) return false;
  return suggestion.probability >= HIGH_CONFIDENCE_PROBABILITY;
}

const SuggestionVisitContext = createContext<{
  dismissed: ReadonlySet<string>;
  dismiss: (key: string) => void;
} | null>(null);

const useSuggestionVisit = () => useContext(SuggestionVisitContext);

export function SuggestionVisitProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  return (
    <SuggestionVisitContext
      value={{
        dismissed,
        dismiss: (key) =>
          setDismissed((previous) => new Set([...previous, key])),
      }}
    >
      {children}
    </SuggestionVisitContext>
  );
}

/** Reject/accept/saving/failure state shared by every review surface. */
function useSuggestionActions(
  key: string,
  onApply: () => void | Promise<void>,
  pending: boolean | undefined,
  onDismiss?: () => void | Promise<void>,
) {
  const visit = useSuggestionVisit();
  const [localDismissed, setLocalDismissed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const active = useRef(false);
  const dismissed = visit ? visit.dismissed.has(key) : localDismissed === key;
  const hide = () => (visit ? visit.dismiss(key) : setLocalDismissed(key));
  // Hide at once; the Miss is evidence for fixing prompts, so a failed
  // write surfaces as a toast instead of keeping the Suggestion on screen.
  const dismiss = async () => {
    hide();
    try {
      await onDismiss?.();
    } catch (error) {
      showErrorToast(error);
    }
  };
  const apply = async () => {
    if (active.current || pending) return;
    active.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await onApply();
      hide();
    } catch (error) {
      setFailure(error);
      showErrorToast(error);
    } finally {
      active.current = false;
      setSaving(false);
    }
  };
  return { dismissed, dismiss, apply, saving, failure };
}

/** The key includes the question, current value and answer: new evidence can be reviewed. */
function suggestionReviewKey(
  questionKey: string,
  currentValue: string | null,
  suggestion: FieldSuggestion | null | undefined,
) {
  return JSON.stringify([
    questionKey,
    currentValue,
    suggestion?.value,
    ...(suggestion?.financeReview
      ? [suggestion.financeReview.fingerprint]
      : []),
  ]);
}

/** Saved finance evidence a spending suggestion read beyond its basis. */
function FinanceEvidence({ suggestion }: { suggestion: FieldSuggestion }) {
  const evidence = suggestion.financeReview?.evidence;
  if (!evidence) return null;
  return (
    <div className="space-y-1 text-xs">
      <p>
        {evidence.principalLineCount} principal lines across{" "}
        {evidence.distinctPurchaseCount} purchases;{" "}
        {evidence.unknownCategoryLineCount} lines without a product category.
      </p>
      {evidence.categories.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {evidence.categories.map((category) => (
            <CategoryLabelById
              key={category.id}
              id={category.id}
              name={category.name}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A prune proposal lists each redundant entry and why. */
function Removals({ suggestion }: { suggestion: FieldSuggestion }) {
  if (suggestion.operation !== "remove" || suggestion.removals.length === 0)
    return null;
  return (
    <>
      {suggestion.removals.map((removal) => (
        <Description
          key={removal.value}
          size="xs"
          className="text-muted-foreground"
        >
          {removal.value} · {removal.reason} ·{" "}
          {formatProbability(removal.probability)}
        </Description>
      ))}
    </>
  );
}

export function SuggestionReview({
  suggestion,
  currentValue,
  currentLabel,
  questionKey,
  pending,
  onApply,
  onDismiss,
  onUseDifferent,
  basis = [],
  notice,
  outcome = null,
  renderValue,
  surface = "inline",
  children,
  explain,
}: {
  children?: ReactNode;
  explain?: (pending: ReactNode) => ReactNode;
  suggestion: FieldSuggestion | null;
  currentValue: string | null;
  currentLabel?: ReactNode;
  questionKey: string;
  pending?: boolean;
  onApply: () => void | Promise<void>;
  onDismiss?: () => void | Promise<void>;
  /** Opens an editor whose saved value is recorded as this suggestion's Miss. */
  onUseDifferent?: () => void;
  /** Labels of the manifest basis fields the decision read. */
  basis?: readonly string[];
  notice?: string;
  /** A rejected proposal stays settled for this visit. */
  outcome?: FieldSuggestionOutcome | null;
  /** One field presentation for the proposal, alternative, and member evidence. */
  renderValue?: (
    value: z.infer<ReturnType<typeof z.json>>,
    label?: string,
  ) => ReactNode;
  /** Inline values show the proposal and Accept, with evidence expanded
   * only by an explicit Review disclosure. */
  surface?: SuggestionSurface;
}) {
  const key = suggestionReviewKey(questionKey, currentValue, suggestion);
  const { dismissed, dismiss, apply, saving, failure } = useSuggestionActions(
    key,
    onApply,
    pending,
    onDismiss,
  );
  if (
    outcome?.reviewStatus === "rejected" ||
    dismissed ||
    !actionableSuggestion(suggestion, currentValue)
  )
    return <>{children}</>;
  const isRemove = suggestion.operation === "remove";
  const runnerUp = suggestion.alternatives[0];
  const body = (
    <SuggestionBody
      explain={explain}
      compact={surface === "inline"}
      current={
        !isRemove && currentValue?.trim()
          ? (children ?? currentLabel ?? currentValue)
          : null
      }
      proposed={
        isRemove
          ? `${suggestion.label ?? `Remove ${suggestion.value}`}${suggestion.detail ? ` — ${suggestion.detail}` : ""}`
          : (renderValue?.(suggestion.value, suggestion.label ?? undefined) ??
            suggestion.label ??
            suggestion.value)
      }
      probability={suggestion.probability}
      confidence={suggestion.confidence}
      runnerUp={
        runnerUp && !isRemove
          ? {
              label:
                renderValue?.(runnerUp.value, runnerUp.label) ?? runnerUp.label,
              probability: runnerUp.probability,
            }
          : null
      }
      removal={isRemove}
      reasoning={suggestion.reasoning}
      basis={basis}
      provenance={{ model: null, runId: null, at: null }}
      evidence={
        <>
          <Removals suggestion={suggestion} />
          <FinanceEvidence suggestion={suggestion} />
        </>
      }
      notice={
        suggestion.financeReview
          ? "Based on saved record and linked items"
          : notice
      }
      saving={saving}
      disabled={pending}
      failure={failure}
      onAccept={() => void apply()}
      onReject={() => void dismiss()}
      onUseDifferent={onUseDifferent}
    />
  );
  return (
    <>
      {!isRemove && currentValue?.trim() ? null : children}
      {body}
    </>
  );
}
