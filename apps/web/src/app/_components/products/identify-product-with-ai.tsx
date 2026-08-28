import type { ProductIdentification } from "@cubby/schemas/ai";
import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { ai } from "~/lib/ai.functions";
import { getErrorMessage } from "~/lib/error-utils";

import { ConfidenceReasoningCard } from "../ai/ai-suggest";
import type { PendingImage } from "../PendingImageUpload";

type ProductIdentityUpdate =
  | { field: "name" | "manufacturer" | "model"; value: string }
  | {
      field: "category";
      value: Exclude<ProductIdentification["category"], null>;
    };

interface ProductIdentityFormPort {
  setValue(update: ProductIdentityUpdate): void;
}

interface IdentifyProductButtonProps {
  form: ProductIdentityFormPort;
  pendingImages: PendingImage[];
}

export function IdentifyProductButton({
  form,
  pendingImages,
}: IdentifyProductButtonProps) {
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
    form.setValue({ field: "name", value: identification.name });
    form.setValue({
      field: "manufacturer",
      value: identification.manufacturer,
    });
    if (identification.category !== null) {
      form.setValue({ field: "category", value: identification.category });
    }
    if (identification.model !== null) {
      form.setValue({ field: "model", value: identification.model });
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
