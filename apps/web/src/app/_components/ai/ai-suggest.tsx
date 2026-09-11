import type { Confidence } from "@cubby/schemas/ai";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { getErrorMessage } from "~/lib/error-utils";

import { AiProposalCard, AiProvenance } from "./ai-proposal-card";

/**
 * A field paired with a "Suggest" button. Owns the ai-availability gate,
 * request-basis snapshots, stale-response rejection, and explicit acceptance.
 * Domain adapters keep their typed field patches local.
 *
 * The button is the registry's `suggest` verb, so the icon, the label and the
 * phone treatment are the same on every field that offers one; `object` names
 * what this field suggests ("category", "type", "a location") and stays in the
 * accessible name after the text is hidden below `sm`.
 */
export function FieldWithAISuggest<
  TResult extends { confidence: Confidence; reasoning: string },
>({
  field,
  enabled,
  disabledReason,
  object,
  basisKey,
  currentValue,
  fieldDirty,
  runSuggest,
  onAccept,
  onDismiss,
  children,
}: {
  field: ReactNode;
  /** Inputs sufficient to suggest (caller-computed; e.g. name && manufacturer). */
  enabled: boolean;
  /** Why the button is unavailable, e.g. "Enter product name first". */
  disabledReason: string;
  /** What this field suggests: "category", "type", "a location". */
  object: string;
  /** Stable serialization of the values the model will inspect. */
  basisKey: string;
  /** The field value when a proposal was requested; manual changes invalidate it. */
  currentValue: unknown;
  /** Exposed so domain callers state their edit-state contract explicitly. */
  fieldDirty: boolean;
  runSuggest: () => Promise<TResult>;
  onAccept: (result: TResult) => void;
  onDismiss?: (result: TResult) => void;
  /**
   * The value being proposed, named. Without it the card explains a choice it
   * never states — the reasoning has to be read as a riddle for the answer.
   */
  children?: (result: TResult) => ReactNode;
}) {
  const [suggestion, setSuggestion] = useState<{
    result: TResult;
    basisKey: string;
    currentValue: unknown;
    at: Date;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const basisRef = useRef(basisKey);
  basisRef.current = basisKey;

  useEffect(() => {
    if (
      suggestion &&
      (suggestion.basisKey !== basisKey ||
        (fieldDirty && suggestion.currentValue !== currentValue))
    ) {
      setSuggestion(null);
    }
  }, [basisKey, currentValue, fieldDirty, suggestion]);

  const handleSuggest = async () => {
    if (!enabled) return;
    const requestBasis = basisKey;
    const requestValue = currentValue;
    setIsLoading(true);
    try {
      const result = await runSuggest();
      // A response for old product/location inputs is not a proposal anymore.
      if (basisRef.current !== requestBasis) return;
      setSuggestion({
        result,
        basisKey: requestBasis,
        currentValue: requestValue,
        at: new Date(),
      });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Stack gap="sm">
      <Row align="end" gap="sm">
        <div className="flex-1">{field}</div>
        <VerbButton
          verb="suggest"
          object={object}
          phoneIconOnly
          pending={isLoading}
          disabledReason={enabled ? undefined : disabledReason}
          className="min-h-9 max-sm:min-h-11"
          onClick={() => void handleSuggest()}
        />
      </Row>

      {/* Visible, not only a `title`: the button's own tooltip cannot open on
          a touch device, which is where half this form is filled in. */}
      {!enabled && <Description size="xs">{disabledReason}</Description>}

      {suggestion && (
        <AiProposalCard
          label={`Suggested ${object}`}
          confidence={suggestion.result.confidence}
          reasoning={suggestion.result.reasoning}
          // The suggest endpoints answer with the value alone: no model, no
          // analysis timestamp. Until `packages/schemas/src/ai.ts` carries
          // them, the honest provenance is when it was asked.
          provenance={<AiProvenance analyzedAt={suggestion.at} />}
          onAccept={() => {
            onAccept(suggestion.result);
            setSuggestion(null);
          }}
          onDismiss={() => {
            onDismiss?.(suggestion.result);
            setSuggestion(null);
          }}
        >
          {children?.(suggestion.result)}
        </AiProposalCard>
      )}
    </Stack>
  );
}
