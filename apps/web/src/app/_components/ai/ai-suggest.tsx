import type { Confidence } from "@cubby/schemas/ai";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";

/** Confidence → text color. One map (semantic text-warning for medium, not a
 * raw text-yellow-600) shared by every AI-suggestion surface. */
export const confidenceColor: Record<Confidence, string> = {
  high: "text-positive",
  medium: "text-warning",
  low: "text-destructive",
};

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
    <div className="rounded-md bg-muted/50 p-2 text-sm">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{label}:</span>
        <span className={confidenceColor[confidence]}>
          {confidence} confidence
        </span>
      </div>
      <p className="mt-1 text-muted-foreground">{reasoning}</p>
    </div>
  );
}

/**
 * A SelectField paired with an "AI Suggest" button. Owns the ai-availability
 * gate, the loading state, and the result card; the field, the suggest call,
 * and the "why is it disabled" tooltip text are supplied by the caller. Category
 * and location-type fields are thin wrappers over this.
 */
export function FieldWithAISuggest<
  TResult extends { confidence: Confidence; reasoning: string },
>({
  field,
  enabled,
  disabledReason,
  suggestLabel,
  runSuggest,
  onResult,
}: {
  field: ReactNode;
  /** Inputs sufficient to suggest (caller-computed; e.g. name && manufacturer). */
  enabled: boolean;
  /** Tooltip shown when AI is available but the inputs are incomplete. */
  disabledReason: string;
  /** Tooltip shown when ready, e.g. "Use AI to suggest category". */
  suggestLabel: string;
  runSuggest: () => Promise<TResult>;
  onResult: (result: TResult) => void;
}) {
  const api = useTRPC();
  const { data: aiStatus } = useQuery(
    api.ai.isAvailable.queryOptions(undefined, {
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );
  const [suggestion, setSuggestion] = useState<TResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const canSuggest = !!aiStatus?.available && enabled;

  const handleSuggest = async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const result = await runSuggest();
      setSuggestion(result);
      onResult(result);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
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
            {isLoading ? <Spinner /> : <Sparkles className="h-4 w-4" />}
            <span className="ml-1 hidden sm:inline">Suggest</span>
          </TooltipTrigger>
          <TooltipContent>
            {!aiStatus?.available
              ? "AI not configured"
              : !enabled
                ? disabledReason
                : suggestLabel}
          </TooltipContent>
        </Tooltip>
      </div>

      {suggestion && (
        <ConfidenceReasoningCard
          confidence={suggestion.confidence}
          reasoning={suggestion.reasoning}
        />
      )}
    </div>
  );
}
