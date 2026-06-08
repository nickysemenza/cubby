import type { LocationTypeSuggestion } from "@cubby/schemas/ai";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import { SelectField } from "../form-utils";
import { locationTypeOptionsWithTheme } from "./location-icons";

interface TypeFieldWithAIProps<TFieldValues extends FieldValues = FieldValues> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  locationName: string;
  disabled?: boolean;
  description?: string;
}

export function TypeFieldWithAI<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  locationName,
  disabled = false,
  description,
}: TypeFieldWithAIProps<TFieldValues>) {
  const [suggestion, setSuggestion] = useState<LocationTypeSuggestion | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);

  const api = useTRPC();
  const trpcClient = useTRPCClient();

  // Check if AI is available
  const { data: aiStatus } = useQuery(
    api.ai.isAvailable.queryOptions(undefined, {
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );

  const handleSuggest = useCallback(async () => {
    if (!locationName.trim()) {
      return;
    }

    setIsLoading(true);
    try {
      const result = await trpcClient.ai.suggestLocationType.query({
        locationName,
      });
      setSuggestion(result);
      // Auto-apply the suggestion
      form.setValue(name, result.type as TFieldValues[typeof name]);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [locationName, trpcClient, form, name]);

  const canSuggest = aiStatus?.available && locationName.trim();

  const confidenceColor = {
    high: "text-positive",
    medium: "text-yellow-600",
    low: "text-destructive",
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <SelectField
            form={form}
            name={name}
            label="Type"
            options={locationTypeOptionsWithTheme}
            placeholder="Select a location type"
            disabled={disabled}
            description={description}
          />
        </div>

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
              : !locationName.trim()
                ? "Enter location name first"
                : "Use AI to suggest type"}
          </TooltipContent>
        </Tooltip>
      </div>

      {suggestion && (
        <div className="rounded-md bg-muted/50 p-2 text-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">AI Suggestion:</span>
            <span className={confidenceColor[suggestion.confidence]}>
              {suggestion.confidence} confidence
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{suggestion.reasoning}</p>
        </div>
      )}
    </div>
  );
}
