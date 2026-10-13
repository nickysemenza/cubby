import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { showErrorToast } from "~/ui/feedback/error-details";
import { Description } from "~/ui/primitives/description";

import { CellFrame } from "../../ui/data-table/cell-frame";
import { useRowActive } from "../../ui/data-table/row-activity";
import { formatProbability, stringLabelOf } from "./field-suggestion";
import { SuggestionBody } from "./suggestion-body";
import type { SuggestionOutcomeSurface } from "./suggestion-outcome-mark";
import { SuggestionOutcomeMark } from "./suggestion-outcome-mark";

/** An empty-field `set` proposal, and a `remove` (prune) proposal regardless
 * of `alternative` or whether the field already has a value — a prune is
 * never a "replace a value with another guess" alternative, so the stricter
 * `ALTERNATIVE_THRESHOLD` gate doesn't apply to it. */
export const FILL_THRESHOLD = 0.85;
/** A `set` proposal replacing a value the field already has, or answering a
 * "provided" (already-populated basis) request. */
export const ALTERNATIVE_THRESHOLD = 0.95;

/** The probability bar `suggestion` must clear to become actionable — shared
 * by the gate (`actionableSuggestion`) and the outcome mark's "needs NN%"
 * copy so the two can't drift apart. */
export function reviewThreshold(
  suggestion: FieldSuggestion,
  current: string | null,
  alternative: boolean,
): typeof FILL_THRESHOLD | typeof ALTERNATIVE_THRESHOLD {
  if (suggestion.operation === "remove") return FILL_THRESHOLD;
  return alternative || current?.trim()
    ? ALTERNATIVE_THRESHOLD
    : FILL_THRESHOLD;
}

export function actionableSuggestion(
  suggestion: FieldSuggestion | null,
  current: string | null,
  alternative = false,
): suggestion is FieldSuggestion & { value: string } {
  if (!suggestion?.value || suggestion.value === current) return false;
  if (suggestion.probability == null) return false;
  return (
    suggestion.probability >= reviewThreshold(suggestion, current, alternative)
  );
}

const SuggestionVisitContext = createContext<{
  dismissed: ReadonlySet<string>;
  dismiss: (key: string) => void;
} | null>(null);

export const useSuggestionVisit = () => useContext(SuggestionVisitContext);

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
export function useSuggestionActions(
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

/** A table cell has a fixed width, so its value and mark share one row where
 * the value truncates: the glyph appended as a bare sibling overflowed the
 * cell by its own width once it rendered. Other surfaces keep their flow. */
function MarkedValue({
  surface,
  children,
  mark,
}: {
  surface: SuggestionOutcomeSurface;
  children: ReactNode;
  mark: ReactNode;
}) {
  if (surface !== "cell")
    return (
      <>
        {children}
        {mark}
      </>
    );
  return <CellFrame trailing={mark}>{children}</CellFrame>;
}

/** The key includes the question, current value and answer: new evidence can be reviewed. */
export function suggestionReviewKey(
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
      {evidence.categories.map((category) => (
        <p key={category.id}>
          <a className="underline" href={`/product-categories/${category.id}`}>
            {category.emoji} {category.name}
          </a>
        </p>
      ))}
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
  alternative = false,
  outcome = null,
  surface = "inline",
  autoFilled = false,
  prune = false,
  quiet,
  error,
  children,
}: {
  children?: ReactNode;
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
  alternative?: boolean;
  /** What the decision model's decision tier did with this field — drives the always-visible
   * mark even when there's no actionable proposal (or none at all). */
  outcome?: FieldSuggestionOutcome | null;
  /** `"cell"` folds the whole body into the mark's popover so a dense table
   * row stays 32px. Inline values show the proposal and Accept, with
   * evidence expanded only by an explicit Review disclosure. */
  surface?: SuggestionOutcomeSurface;
  autoFilled?: boolean;
  /** Whether the target is a `mode: "prune"` field — changes the mark's
   * "nothing to remove" copy for a declined removal. */
  prune?: boolean;
  /** The suggestion query failed; the mark shows it rather than vanishing. */
  error?: unknown;
  /** A form whose status line already reports every checked field: show only
   * an actionable proposal, never a status-only mark. */
  quiet?: boolean;
}) {
  const key = suggestionReviewKey(questionKey, currentValue, suggestion);
  const { dismissed, dismiss, apply, saving, failure } = useSuggestionActions(
    key,
    onApply,
    pending,
    onDismiss,
  );
  const rowActive = useRowActive();
  const markCurrentLabel = stringLabelOf(currentLabel);
  // Cleared the bar or not is a fact about the proposal itself, independent
  // of whether the person went on to reject it — a rejected-but-actionable
  // suggestion still reads "Suggested X", not "Leaning X … needs 85%".
  const meetsBar = actionableSuggestion(suggestion, currentValue, alternative);
  if (!meetsBar || dismissed) {
    if (quiet) return <>{children}</>;
    // A status-only mark (checking, unavailable, declined) is quiet on an idle
    // table row; an actionable proposal below always shows. See row-activity.
    if (surface === "cell" && !rowActive)
      return (
        <MarkedValue
          surface={surface}
          mark={<span aria-hidden className="size-5 shrink-0" />}
        >
          {children}
        </MarkedValue>
      );
    return (
      <MarkedValue
        surface={surface}
        mark={
          <SuggestionOutcomeMark
            outcome={outcome}
            suggestion={suggestion}
            currentValue={currentValue}
            currentLabel={markCurrentLabel}
            alternative={alternative}
            autoFilled={autoFilled}
            surface={surface}
            actionable={meetsBar}
            dismissed={dismissed}
            prune={prune}
            pending={pending}
            error={error}
          />
        }
      >
        {children}
      </MarkedValue>
    );
  }
  const isRemove = suggestion.operation === "remove";
  const runnerUp = suggestion.alternatives[0];
  const body = (
    <SuggestionBody
      compact={surface === "inline"}
      current={
        !isRemove && currentValue?.trim()
          ? (children ?? currentLabel ?? currentValue)
          : null
      }
      proposed={
        isRemove
          ? `${suggestion.label ?? `Remove ${suggestion.value}`}${suggestion.detail ? ` — ${suggestion.detail}` : ""}`
          : (suggestion.label ?? suggestion.value)
      }
      probability={suggestion.probability}
      confidence={suggestion.confidence}
      runnerUp={
        runnerUp && !isRemove
          ? { label: runnerUp.label, probability: runnerUp.probability }
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
  if (surface === "cell") {
    return (
      <MarkedValue
        surface={surface}
        mark={
          <SuggestionOutcomeMark
            outcome={outcome}
            suggestion={suggestion}
            currentValue={currentValue}
            currentLabel={markCurrentLabel}
            alternative={alternative}
            autoFilled={autoFilled}
            surface={surface}
            actionable
            prune={prune}
            review={body}
          />
        }
      >
        {children}
      </MarkedValue>
    );
  }
  return (
    <>
      {!isRemove && currentValue?.trim() ? null : children}
      {body}
    </>
  );
}
