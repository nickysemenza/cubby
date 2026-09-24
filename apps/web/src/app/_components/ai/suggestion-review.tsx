import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { showErrorToast } from "~/components/feedback/error-details";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { useIsMobile } from "~/hooks/useMobile";
import { getAppErrorDetails } from "~/lib/error-utils";

import { CellFrame } from "../data-table/cell-frame";
import { stringLabelOf } from "./field-suggestion";
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

function reviewCurrentContent(
  children: ReactNode,
  currentLabel: ReactNode,
  currentValue: string,
) {
  return children ?? <span>{currentLabel ?? currentValue}</span>;
}

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

/** Dismiss/apply/saving/failure state shared by both the `remove` and `set`
 * review bodies — factored out so `SuggestionReview` itself stays a thin
 * gate + layout switch instead of owning every branch. */
function useSuggestionActions(
  key: string,
  onApply: () => void | Promise<void>,
  pending: boolean | undefined,
) {
  const visit = useSuggestionVisit();
  const [localDismissed, setLocalDismissed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const active = useRef(false);
  const dismissed = visit ? visit.dismissed.has(key) : localDismissed === key;
  const dismiss = () => (visit ? visit.dismiss(key) : setLocalDismissed(key));
  const apply = async () => {
    if (active.current || pending) return;
    active.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await onApply();
      dismiss();
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

interface ReviewBodyProps {
  suggestion: FieldSuggestion & { value: string };
  pending?: boolean;
  saving: boolean;
  failure: unknown;
  apply: () => void;
  dismiss: () => void;
  applyLabel: string;
  children?: ReactNode;
  outcome: FieldSuggestionOutcome | null;
  surface: SuggestionOutcomeSurface;
  alternative: boolean;
  autoFilled: boolean;
  prune?: boolean;
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

/** The Use/Remove + Keep row, shared by every inline body and the cell
 * popover's review slot — one button implementation, never duplicated. */
function ReviewButtons({
  isRemove = false,
  applyLabel,
  saving,
  pending,
  apply,
  dismiss,
  hasCurrentValue,
}: {
  isRemove?: boolean;
  applyLabel: string;
  saving: boolean;
  pending?: boolean;
  apply: () => void;
  dismiss: () => void;
  hasCurrentValue: boolean;
}) {
  return (
    <Row gap="xs" wrap>
      <Button
        type="button"
        variant="link"
        size="xs"
        className="min-h-11 md:min-h-0"
        disabled={pending || saving}
        onClick={apply}
      >
        {saving ? "Saving…" : applyLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="min-h-11 md:min-h-0"
        disabled={saving}
        onClick={dismiss}
      >
        {isRemove ? "Keep" : hasCurrentValue ? "Keep current" : "Dismiss"}
      </Button>
    </Row>
  );
}

function ReviewFailure({ failure }: { failure: unknown }) {
  if (failure === null) return null;
  return (
    <Description size="xs" role="alert">
      Could not save: {getAppErrorDetails(failure).message}
    </Description>
  );
}

/** A prune (`operation: "remove"`) proposal never replaces the current value
 * with another guess — it always shows the current chips as-is, plus why one
 * or more of them is redundant, not an arrow-to-a-new-value flow. */
function RemoveReviewBody({
  suggestion,
  pending,
  saving,
  failure,
  apply,
  dismiss,
  applyLabel,
  children,
  outcome,
  surface,
  alternative,
  autoFilled,
  prune,
}: ReviewBodyProps) {
  return (
    <Stack
      gap="xs"
      className="min-w-0 whitespace-normal"
      onClick={stop}
      onMouseDown={stop}
    >
      <Row gap="xs" wrap>
        {children}
        <Description size="xs" className="text-muted-foreground">
          {suggestion.label ?? `Remove ${suggestion.value}`}
          {suggestion.detail ? ` — ${suggestion.detail}` : ""}
        </Description>
        <SuggestionOutcomeMark
          outcome={outcome}
          suggestion={suggestion}
          alternative={alternative}
          autoFilled={autoFilled}
          surface={surface}
          actionable
          prune={prune}
        />
        <ReviewButtons
          isRemove
          applyLabel={applyLabel}
          saving={saving}
          pending={pending}
          apply={apply}
          dismiss={dismiss}
          hasCurrentValue={false}
        />
      </Row>
      <ReviewFailure failure={failure} />
    </Stack>
  );
}

function SetReviewBody({
  suggestion,
  currentValue,
  currentLabel,
  pending,
  saving,
  failure,
  apply,
  dismiss,
  applyLabel,
  children,
  outcome,
  surface,
  alternative,
  autoFilled,
}: ReviewBodyProps & {
  currentValue: string | null;
  currentLabel?: ReactNode;
}) {
  return (
    <Stack
      gap="xs"
      className="min-w-0 whitespace-normal"
      onClick={stop}
      onMouseDown={stop}
    >
      <Row gap="xs" wrap className="text-xs">
        {!currentValue?.trim() ? children : null}
        {currentValue?.trim() ? (
          <>
            {reviewCurrentContent(children, currentLabel, currentValue)}
            <ArrowRight
              className="size-3.5 shrink-0"
              aria-label="suggested replacement"
            />
          </>
        ) : null}
        {/* After the arrow the cobalt value already reads as the proposal;
            "Suggested:" there only cost the width the row needs to stay one line. */}
        <span className="text-primary">
          {currentValue?.trim() ? "" : "Suggested: "}
          {suggestion.label ?? suggestion.value}
        </span>
        <SuggestionOutcomeMark
          outcome={outcome}
          suggestion={suggestion}
          currentValue={currentValue}
          currentLabel={stringLabelOf(currentLabel)}
          alternative={alternative}
          autoFilled={autoFilled}
          surface={surface}
          actionable
        />
        <ReviewButtons
          applyLabel={applyLabel}
          saving={saving}
          pending={pending}
          apply={apply}
          dismiss={dismiss}
          hasCurrentValue={Boolean(currentValue?.trim())}
        />
      </Row>
      <ReviewFailure failure={failure} />
    </Stack>
  );
}

/** The cell-surface popover's review slot: current value (for a `set`
 * proposal), then the same buttons and failure line the inline bodies use —
 * no separate button implementation. */
function CellReviewSlot({
  isRemove,
  currentValue,
  currentLabel,
  pending,
  saving,
  failure,
  apply,
  dismiss,
  applyLabel,
}: {
  isRemove: boolean;
  currentValue: string | null;
  currentLabel?: ReactNode;
  pending?: boolean;
  saving: boolean;
  failure: unknown;
  apply: () => void;
  dismiss: () => void;
  applyLabel: string;
}) {
  return (
    <Stack
      gap="xs"
      className="min-w-0 whitespace-normal"
      onClick={stop}
      onMouseDown={stop}
    >
      {!isRemove && currentValue?.trim() ? (
        <Description size="xs" className="text-muted-foreground">
          Current: {currentLabel ?? currentValue}
        </Description>
      ) : null}
      <ReviewButtons
        isRemove={isRemove}
        applyLabel={applyLabel}
        saving={saving}
        pending={pending}
        apply={apply}
        dismiss={dismiss}
        hasCurrentValue={Boolean(currentValue?.trim())}
      />
      <ReviewFailure failure={failure} />
    </Stack>
  );
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
export function SuggestionReview({
  suggestion,
  currentValue,
  currentLabel,
  questionKey,
  pending,
  onApply,
  applyLabel,
  alternative = false,
  outcome = null,
  surface = "inline",
  autoFilled = false,
  prune = false,
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
  applyLabel?: string;
  alternative?: boolean;
  /** What Jev's decision tier did with this field — drives the always-visible
   * mark even when there's no actionable proposal (or none at all). */
  outcome?: FieldSuggestionOutcome | null;
  /** `"cell"` folds the whole proposal (headline + buttons) into the mark's
   * popover so a dense table row stays 32px, as does `"inline"` on a phone;
   * otherwise the proposal renders directly, on the value's own line. */
  surface?: SuggestionOutcomeSurface;
  autoFilled?: boolean;
  /** Whether the target is a `mode: "prune"` field — changes the mark's
   * "nothing to remove" copy for a declined removal. */
  prune?: boolean;
  /** The suggestion query failed; the mark shows it rather than vanishing. */
  error?: unknown;
}) {
  const key = JSON.stringify([questionKey, currentValue, suggestion?.value]);
  const { dismissed, dismiss, apply, saving, failure } = useSuggestionActions(
    key,
    onApply,
    pending,
  );
  const isMobile = useIsMobile();
  const markCurrentLabel = stringLabelOf(currentLabel);
  // Cleared the bar or not is a fact about the proposal itself, independent
  // of whether the person went on to dismiss it — a dismissed-but-actionable
  // suggestion still reads "Suggested X", not "Leaning X … needs 85%".
  const meetsBar = actionableSuggestion(suggestion, currentValue, alternative);
  if (!meetsBar || dismissed) {
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
  const resolvedApplyLabel =
    applyLabel ?? (isRemove ? "Remove tags" : "Use suggestion");
  // Phones fold every inline review into the glyph too: an inline review
  // arriving after load grew the page under the reader's finger (+96px), and
  // neither engine's scroll anchoring held the tapped control in place.
  if (surface === "cell" || (surface === "inline" && isMobile)) {
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
            review={
              <CellReviewSlot
                isRemove={isRemove}
                currentValue={currentValue}
                currentLabel={currentLabel}
                pending={pending}
                saving={saving}
                failure={failure}
                apply={apply}
                dismiss={dismiss}
                applyLabel={resolvedApplyLabel}
              />
            }
          />
        }
      >
        {children}
      </MarkedValue>
    );
  }
  const bodyProps: ReviewBodyProps = {
    suggestion,
    pending,
    saving,
    failure,
    apply,
    dismiss,
    applyLabel: resolvedApplyLabel,
    children,
    outcome,
    surface,
    alternative,
    autoFilled,
    prune,
  };
  return isRemove ? (
    <RemoveReviewBody {...bodyProps} />
  ) : (
    <SetReviewBody
      {...bodyProps}
      currentValue={currentValue}
      currentLabel={currentLabel}
    />
  );
}
