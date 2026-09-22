import type { FieldSuggestion } from "@cubby/schemas/ai";
import { ArrowRight } from "lucide-react";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

/** A `remove` (prune) proposal reviews at 0.85 regardless of `alternative` or
 * whether the field already has a value — it is never a "replace a value
 * with another guess" alternative, so the stricter 0.95 alternative gate
 * doesn't apply to it. */
const REMOVE_THRESHOLD = 0.85;

export function actionableSuggestion(
  suggestion: FieldSuggestion | null,
  current: string | null,
  alternative = false,
): suggestion is FieldSuggestion & { value: string } {
  if (!suggestion?.value || suggestion.value === current) return false;
  if (suggestion.probability == null) return false;
  if (suggestion.operation === "remove") {
    return suggestion.probability >= REMOVE_THRESHOLD;
  }
  return (
    suggestion.probability >= (alternative || current?.trim() ? 0.95 : 0.85)
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

/** Dismiss/apply/saving/failed state shared by both the `remove` and `set`
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
  const [failed, setFailed] = useState(false);
  const active = useRef(false);
  const dismissed = visit ? visit.dismissed.has(key) : localDismissed === key;
  const dismiss = () => (visit ? visit.dismiss(key) : setLocalDismissed(key));
  const apply = async () => {
    if (active.current || pending) return;
    active.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await onApply();
      dismiss();
    } catch {
      setFailed(true);
    } finally {
      active.current = false;
      setSaving(false);
    }
  };
  return { dismissed, dismiss, apply, saving, failed };
}

interface ReviewBodyProps {
  suggestion: FieldSuggestion & { value: string };
  pending?: boolean;
  saving: boolean;
  failed: boolean;
  apply: () => void;
  dismiss: () => void;
  applyLabel: string;
  children?: ReactNode;
}

/** A prune (`operation: "remove"`) proposal never replaces the current value
 * with another guess — it always shows the current chips as-is, plus why one
 * or more of them is redundant, not an arrow-to-a-new-value flow. */
function RemoveReviewBody({
  suggestion,
  pending,
  saving,
  failed,
  apply,
  dismiss,
  applyLabel,
  children,
}: ReviewBodyProps) {
  return (
    <Stack
      gap="xs"
      className="min-w-0 whitespace-normal"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
      <Description size="xs" className="text-muted-foreground">
        {suggestion.label ?? `Remove ${suggestion.value}`}
        {suggestion.detail ? ` — ${suggestion.detail}` : ""}
      </Description>
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
          Keep
        </Button>
      </Row>
      {failed ? (
        <Description size="xs" role="alert">
          Could not save. Try again.
        </Description>
      ) : null}
    </Stack>
  );
}

function SetReviewBody({
  suggestion,
  currentValue,
  currentLabel,
  pending,
  saving,
  failed,
  apply,
  dismiss,
  applyLabel,
  children,
}: ReviewBodyProps & {
  currentValue: string | null;
  currentLabel?: ReactNode;
}) {
  return (
    <Stack
      gap="xs"
      className="min-w-0 whitespace-normal"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {!currentValue?.trim() ? children : null}
      <Row gap="xs" wrap className="text-xs">
        {currentValue?.trim() ? (
          <>
            {reviewCurrentContent(children, currentLabel, currentValue)}
            <ArrowRight
              className="size-3.5 shrink-0"
              aria-label="suggested replacement"
            />
          </>
        ) : null}
        <span className="text-primary">
          Suggested: {suggestion.label ?? suggestion.value}
        </span>
      </Row>
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
          {currentValue?.trim() ? "Keep current" : "Dismiss"}
        </Button>
      </Row>
      {failed ? (
        <Description size="xs" role="alert">
          Could not save. Try again.
        </Description>
      ) : null}
    </Stack>
  );
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
}) {
  const key = JSON.stringify([questionKey, currentValue, suggestion?.value]);
  const { dismissed, dismiss, apply, saving, failed } = useSuggestionActions(
    key,
    onApply,
    pending,
  );
  if (!actionableSuggestion(suggestion, currentValue, alternative) || dismissed)
    return children ?? null;
  const isRemove = suggestion.operation === "remove";
  const resolvedApplyLabel =
    applyLabel ?? (isRemove ? "Remove tags" : "Use suggestion");
  const bodyProps: ReviewBodyProps = {
    suggestion,
    pending,
    saving,
    failed,
    apply,
    dismiss,
    applyLabel: resolvedApplyLabel,
    children,
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
