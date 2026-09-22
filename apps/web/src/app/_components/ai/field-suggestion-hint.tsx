import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import type { ReactNode } from "react";

import { stringLabelOf } from "./field-suggestion";
import type { SuggestionOutcomeSurface } from "./suggestion-outcome-mark";
import { SuggestionOutcomeMark } from "./suggestion-outcome-mark";
import { SuggestionReview } from "./suggestion-review";

export function FieldSuggestionHint({
  suggestion,
  applied,
  onApply,
  pending,
  currentValue = null,
  currentLabel,
  questionKey = "",
  alternative = false,
  outcome = null,
  surface = "line",
  autoFilled = false,
}: {
  suggestion: FieldSuggestion | null;
  applied: boolean;
  onApply?: () => void | Promise<void>;
  pending?: boolean;
  currentValue?: string | null;
  currentLabel?: ReactNode;
  questionKey?: string;
  alternative?: boolean;
  outcome?: FieldSuggestionOutcome | null;
  surface?: SuggestionOutcomeSurface;
  autoFilled?: boolean;
}) {
  if (applied) {
    // Already applied (auto-filled or manually matched) — no proposal to
    // review, but the mark still says why: "Filled in"/"Agrees with …".
    return (
      <SuggestionOutcomeMark
        outcome={outcome}
        suggestion={suggestion}
        currentValue={currentValue}
        currentLabel={stringLabelOf(currentLabel)}
        autoFilled={autoFilled}
        surface="line"
        actionable={false}
      />
    );
  }
  if (!onApply) return null;
  return (
    <SuggestionReview
      suggestion={suggestion}
      currentValue={currentValue}
      currentLabel={currentLabel}
      questionKey={questionKey}
      pending={pending}
      onApply={onApply}
      alternative={alternative}
      outcome={outcome}
      surface={surface}
      autoFilled={autoFilled}
    />
  );
}
