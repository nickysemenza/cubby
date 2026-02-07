import type { CategorySuggestion } from "@cubby/schemas/ai";
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
import { productCategoryOptionsWithTheme } from "./product-category-icons";

interface CategoryFieldWithAIProps<
  TFieldValues extends FieldValues = FieldValues,
> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  productName: string;
  manufacturer: string;
  disabled?: boolean;
  description?: string;
}

export function CategoryFieldWithAI<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  productName,
  manufacturer,
  disabled = false,
  description,
}: CategoryFieldWithAIProps<TFieldValues>) {
  const [suggestion, setSuggestion] = useState<CategorySuggestion | null>(null);
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
    if (!productName.trim() || !manufacturer.trim()) {
      return;
    }

    setIsLoading(true);
    try {
      const result = await trpcClient.ai.suggestCategory.query({
        productName,
        manufacturer,
      });
      setSuggestion(result);
      // Auto-apply the suggestion
      form.setValue(name, result.category as TFieldValues[typeof name]);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [productName, manufacturer, trpcClient, form, name]);

  const canSuggest =
    aiStatus?.available && productName.trim() && manufacturer.trim();

  const confidenceColor = {
    high: "text-green-600",
    medium: "text-yellow-600",
    low: "text-red-600",
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <SelectField
            form={form}
            name={name}
            label="Category"
            options={productCategoryOptionsWithTheme}
            placeholder="Select category"
            nullable={true}
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
                size="sm"
                onClick={handleSuggest}
                disabled={!canSuggest || isLoading}
                className="mb-[2px]"
              />
            }
          >
            {isLoading ? <Spinner /> : <Sparkles className="h-4 w-4" />}
            <span className="ml-1 hidden sm:inline">Suggest</span>
          </TooltipTrigger>
          <TooltipContent>
            {!aiStatus?.available
              ? "AI not configured (add ANTHROPIC_API_KEY)"
              : !productName.trim()
                ? "Enter product name first"
                : !manufacturer.trim()
                  ? "Enter manufacturer first"
                  : "Use AI to suggest category"}
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
