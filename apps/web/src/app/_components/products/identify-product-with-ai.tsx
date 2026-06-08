import type { ProductIdentification } from "@cubby/schemas/ai";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC, useTRPCClient } from "~/trpc/react";
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

  const api = useTRPC();
  const trpcClient = useTRPCClient();

  const { data: aiStatus } = useQuery(
    api.ai.isAvailable.queryOptions(undefined, {
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );

  const imageUrls = pendingImages.map((img) => img.url);
  const canIdentify = aiStatus?.available && imageUrls.length > 0 && !isLoading;

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

  if (!aiStatus?.available || imageUrls.length === 0) {
    return null;
  }

  const confidenceColor = {
    high: "text-positive",
    medium: "text-yellow-600",
    low: "text-destructive",
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleIdentify}
        disabled={!canIdentify}
      >
        {isLoading ? <Spinner /> : <Sparkles className="h-4 w-4" />}
        <span className="ml-1">Identify Product</span>
      </Button>

      {result && (
        <div className="rounded-md bg-muted/50 p-2 text-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">AI Identification:</span>
            <span className={confidenceColor[result.confidence]}>
              {result.confidence} confidence
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{result.reasoning}</p>
        </div>
      )}
    </div>
  );
}
