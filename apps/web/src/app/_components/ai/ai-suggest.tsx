import type { Confidence } from "@cubby/schemas/ai";
import { Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { getErrorMessage } from "~/lib/error-utils";

/** Confidence → text color. One map (semantic text-warning-ink for medium, not a
 * raw text-yellow-600) shared by every AI-suggestion surface. */
export const confidenceColor = {
  high: "text-positive",
  medium: "text-warning-ink",
  low: "text-destructive",
} satisfies Record<Confidence, string>;

/** The AI result card: a Sparkles header with a confidence chip, then reasoning. */
export function ConfidenceReasoningCard({
  confidence,
  reasoning,
  label = "AI Suggestion",
}: {
  confidence: Confidence;
  reasoning: string;
  label?: string;
}) {
  return (
    <div className="border border-border bg-muted/30 p-2 text-sm">
      <Row align="center" gap="sm">
        <Sparkles className="size-3 text-muted-foreground" />
        <span className="font-medium">{label}:</span>
        <span className={confidenceColor[confidence]}>
          {confidence} confidence
        </span>
      </Row>
      <Description className="mt-1">{reasoning}</Description>
    </div>
  );
}

/**
 * A SelectField paired with an "AI Suggest" button. Owns the ai-availability
 * gate, request-basis snapshots, stale-response rejection, and explicit
 * acceptance. Domain adapters keep their typed field patches local.
 */
export function FieldWithAISuggest<
  TResult extends { confidence: Confidence; reasoning: string },
>({
  field,
  enabled,
  disabledReason,
  suggestLabel,
  basisKey,
  currentValue,
  fieldDirty,
  runSuggest,
  onAccept,
  onDismiss,
}: {
  field: ReactNode;
  /** Inputs sufficient to suggest (caller-computed; e.g. name && manufacturer). */
  enabled: boolean;
  /** Tooltip shown when AI is available but the inputs are incomplete. */
  disabledReason: string;
  /** Tooltip shown when ready, e.g. "Use AI to suggest category". */
  suggestLabel: string;
  /** Stable serialization of the values the model will inspect. */
  basisKey: string;
  /** The field value when a proposal was requested; manual changes invalidate it. */
  currentValue: unknown;
  /** Exposed so domain callers state their edit-state contract explicitly. */
  fieldDirty: boolean;
  runSuggest: () => Promise<TResult>;
  onAccept: (result: TResult) => void;
  onDismiss?: (result: TResult) => void;
}) {
  const [suggestion, setSuggestion] = useState<{
    result: TResult;
    basisKey: string;
    currentValue: unknown;
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

  const canSuggest = enabled;

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

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                onClick={handleSuggest}
                disabled={!canSuggest || isLoading}
              />
            }
          >
            {isLoading ? <Spinner /> : <Sparkles className="size-4" />}
            <span className="ml-1 hidden sm:inline">Suggest</span>
          </TooltipTrigger>
          <TooltipContent>
            {!enabled ? disabledReason : suggestLabel}
          </TooltipContent>
        </Tooltip>
      </Row>

      {suggestion && (
        <Stack gap="xs" className="border-t border-border pt-2">
          <ConfidenceReasoningCard
            confidence={suggestion.result.confidence}
            reasoning={suggestion.result.reasoning}
          />
          <Row gap="xs">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onAccept(suggestion.result);
                setSuggestion(null);
              }}
            >
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onDismiss?.(suggestion.result);
                setSuggestion(null);
              }}
            >
              Dismiss
            </Button>
          </Row>
        </Stack>
      )}
    </Stack>
  );
}
