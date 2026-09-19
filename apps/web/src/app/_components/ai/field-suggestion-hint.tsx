import type { FieldSuggestion } from "@cubby/schemas/ai";

import { actionVerbs } from "~/app/_components/actions/action-verbs";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

import { confidenceColor } from "./ai-proposal-card";

/**
 * The silent, non-modal cousin of `AiProposalCard`/`FieldWithAISuggest`: a
 * one-line hint under a field, no animation (DESIGN.md), and no accept/dismiss
 * pair — `applied` already reflects reality (auto-filled or manually
 * matching), and `onApply` is the only action, since there's nothing to
 * dismiss when nothing was written yet.
 */
export function FieldSuggestionHint({
  suggestion,
  applied,
  onApply,
  pending,
}: {
  suggestion: FieldSuggestion | null;
  applied: boolean;
  onApply?: () => void;
  pending?: boolean;
}) {
  if (!suggestion?.value) return null;
  const Icon = actionVerbs.suggest.icon;

  return (
    <Row align="center" gap="xs" wrap>
      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      {applied ? (
        <Description size="xs" as="span">
          Suggested ·{" "}
          <span className={confidenceColor[suggestion.confidence]}>
            {suggestion.confidence}
          </span>
        </Description>
      ) : (
        <>
          <Description size="xs" as="span">
            Suggested: {suggestion.label ?? suggestion.value}
          </Description>
          {onApply && (
            <Button
              type="button"
              variant="link"
              size="xs"
              disabled={pending}
              onClick={onApply}
            >
              Apply
            </Button>
          )}
        </>
      )}
    </Row>
  );
}
