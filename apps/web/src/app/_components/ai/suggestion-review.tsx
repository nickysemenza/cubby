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

export function actionableSuggestion(
  suggestion: FieldSuggestion | null,
  current: string | null,
): suggestion is FieldSuggestion & { value: string } {
  return Boolean(
    suggestion?.value &&
    suggestion.value !== current &&
    suggestion.probability != null &&
    suggestion.probability >= (current?.trim() ? 0.95 : 0.85),
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

/** The key includes the question, current value and answer: new evidence can be reviewed. */
export function SuggestionReview({
  suggestion,
  currentValue,
  currentLabel,
  questionKey,
  pending,
  onApply,
  children,
}: {
  children?: ReactNode;
  suggestion: FieldSuggestion | null;
  currentValue: string | null;
  currentLabel?: ReactNode;
  questionKey: string;
  pending?: boolean;
  onApply: () => void | Promise<void>;
}) {
  const visit = useSuggestionVisit();
  const [localDismissed, setLocalDismissed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(false);
  const key = JSON.stringify([questionKey, currentValue, suggestion?.value]);
  const dismiss = () => (visit ? visit.dismiss(key) : setLocalDismissed(key));
  if (
    !actionableSuggestion(suggestion, currentValue) ||
    visit?.dismissed.has(key) ||
    localDismissed === key
  )
    return children ?? null;
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
            {children ?? <span>{currentLabel ?? currentValue}</span>}
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
          {saving ? "Saving…" : "Use suggestion"}
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
