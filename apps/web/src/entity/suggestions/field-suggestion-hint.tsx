import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import type { ReactNode } from "react";

import { suggestion as suggestionApi } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";

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
  quiet = false,
  renderValue,
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
  /** See `SuggestionReview`'s `quiet`: only an actionable proposal renders. */
  quiet?: boolean;
  renderValue?: Parameters<typeof SuggestionReview>[0]["renderValue"];
}) {
  if (applied && quiet) return null;
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
      onDismiss={async () => {
        const suggestionId =
          suggestion?.suggestionId ??
          (outcome?.kind === "evaluated" ? outcome.suggestionId : undefined);
        if (!suggestionId) throw new Error("Suggestion Suggestion is missing");
        await suggestionApi.review.call({
          suggestionId,
          operationId: crypto.randomUUID(),
          verdict: "wrong",
          intent: "history",
        });
      }}
      alternative={alternative}
      outcome={outcome}
      surface={surface}
      autoFilled={autoFilled}
      quiet={quiet}
      renderValue={renderValue}
    />
  );
}
