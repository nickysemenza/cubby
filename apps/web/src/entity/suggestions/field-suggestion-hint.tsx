import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import type { ReactNode } from "react";

import { suggestion as suggestionApi } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";

import { SuggestionReview, type SuggestionSurface } from "./suggestion-review";

/** A form field's actionable proposal; nothing renders once it is applied. */
export function FieldSuggestionHint({
  suggestion,
  applied,
  onApply,
  pending,
  currentValue = null,
  currentLabel,
  questionKey = "",
  outcome = null,
  surface = "line",
  renderValue,
}: {
  suggestion: FieldSuggestion | null;
  applied: boolean;
  onApply?: () => void | Promise<void>;
  pending?: boolean;
  currentValue?: string | null;
  currentLabel?: ReactNode;
  questionKey?: string;
  outcome?: FieldSuggestionOutcome | null;
  surface?: SuggestionSurface;
  renderValue?: Parameters<typeof SuggestionReview>[0]["renderValue"];
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
      onDismiss={async () => {
        const suggestionId =
          suggestion?.suggestionId ??
          (outcome?.kind === "evaluated" ? outcome.suggestionId : undefined);
        if (!suggestionId) return;
        await suggestionApi.review.call({
          suggestionId,
          operationId: crypto.randomUUID(),
          verdict: "wrong",
          intent: "history",
        });
      }}
      outcome={outcome}
      surface={surface}
      renderValue={renderValue}
    />
  );
}
