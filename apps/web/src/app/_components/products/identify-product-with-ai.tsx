import type { ProductIdentification } from "@cubby/schemas/ai";
import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { ai } from "~/lib/ai.functions";
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
  const [result, setResult] = useState<{
    value: ProductIdentification;
    basisKey: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const imageUrls = pendingImages.map((img) => img.url);
  const basisKey = imageUrls.join("\u0000");
  const canIdentify = imageUrls.length > 0 && !isLoading;

  const handleIdentify = useCallback(async () => {
    if (imageUrls.length === 0) return;

    setIsLoading(true);
    try {
      const identification = await ai.identifyProduct.call({
        imageUrls,
      });
      setResult({ value: identification, basisKey });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [basisKey, imageUrls]);

  const accept = useCallback(() => {
    if (!result) return;
    const identification = result.value;
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
    setResult(null);
    toast.success("Product details applied from photo");
  }, [form, result]);

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

      {result?.basisKey === basisKey && (
        <Stack gap="xs" className="border-t border-border pt-2">
          <ConfidenceReasoningCard
            label="AI Identification"
            confidence={result.value.confidence}
            reasoning={result.value.reasoning}
          />
          <Row gap="xs">
            <Button type="button" size="sm" onClick={accept}>
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setResult(null)}
            >
              Dismiss
            </Button>
          </Row>
        </Stack>
      )}
    </Stack>
  );
}
