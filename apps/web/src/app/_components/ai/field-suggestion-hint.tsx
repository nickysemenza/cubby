import type { FieldSuggestion } from "@cubby/schemas/ai";
import type { ReactNode } from "react";

import { SuggestionReview } from "./suggestion-review";

export function FieldSuggestionHint({
  suggestion,
  applied,
  onApply,
  pending,
  currentValue = null,
  currentLabel,
  questionKey = "",
}: {
  suggestion: FieldSuggestion | null;
  applied: boolean;
  onApply?: () => void | Promise<void>;
  pending?: boolean;
  currentValue?: string | null;
  currentLabel?: ReactNode;
  questionKey?: string;
}) {
  if (applied || !onApply) return null;
  return (
    <SuggestionReview
      suggestion={suggestion}
      currentValue={currentValue}
      currentLabel={currentLabel}
      questionKey={questionKey}
      pending={pending}
      onApply={onApply}
    />
  );
}
