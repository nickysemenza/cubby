import type { ProductIdentification } from "@cubby/schemas/ai";
import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useTRPCClient } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { ConfidenceReasoningCard } from "../ai/ai-suggest";
import type { PendingImage } from "../PendingImageUpload";

interface IdentifyProductButtonProps<
  TFieldValues extends FieldValues = FieldValues,
> {
  form: UseFormReturn<TFieldValues>;
  pendingImages: PendingImage[];
}

export function IdentifyProductButton<
  TFieldValues extends FieldValues = FieldValues,
>({ form, pendingImages }: IdentifyProductButtonProps<TFieldValues>) {
  const [result, setResult] = useState<ProductIdentification | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const trpcClient = useTRPCClient();

  const imageUrls = pendingImages.map((img) => img.url);
  const canIdentify = imageUrls.length > 0 && !isLoading;

  const handleIdentify = useCallback(async () => {
    if (imageUrls.length === 0) return;

    setIsLoading(true);
    try {
      const identification = await trpcClient.ai.identifyProduct.mutate({
        imageUrls,
      });
      setResult(identification);

      // Auto-fill form fields
      form.setValue(
        "name" as Path<TFieldValues>,
        identification.name as TFieldValues[Path<TFieldValues>],
      );
      form.setValue(
        "manufacturer" as Path<TFieldValues>,
        identification.manufacturer as TFieldValues[Path<TFieldValues>],
      );
      if (identification.category !== null) {
        form.setValue(
          "category" as Path<TFieldValues>,
          identification.category as TFieldValues[Path<TFieldValues>],
        );
      }
      if (identification.model !== null) {
        form.setValue(
          "model" as Path<TFieldValues>,
          identification.model as TFieldValues[Path<TFieldValues>],
        );
      }

      toast.success("Product identified from photo");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [imageUrls, trpcClient, form]);

  if (imageUrls.length === 0) {
    return null;
  }

  return (
    <Stack className="items-start" gap="sm">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleIdentify}
        disabled={!canIdentify}
      >
        {isLoading ? <Spinner /> : <Sparkles className="size-4" />}
        <span className="ml-1">Identify Product</span>
      </Button>

      {result && (
        <ConfidenceReasoningCard
          label="AI Identification"
          confidence={result.confidence}
          reasoning={result.reasoning}
        />
      )}
    </Stack>
  );
}
