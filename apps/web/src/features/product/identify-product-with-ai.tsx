import type { ProductIdentification } from "@cubby/schemas/ai";
import { useCallback, useMemo } from "react";

import { VerbButton } from "~/entity/actions/action-verb-ui";
import { AiProvenance } from "~/entity/suggestions/ai-proposal-card";
import {
  AiProposalList,
  type AiProposalRow,
} from "~/entity/suggestions/ai-proposal-list";
import { useAiProposal } from "~/entity/suggestions/use-ai-proposal";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";

import type { PendingImage } from "../../entity/entity-media/pending-image-upload";
import { useProductBrandIngress } from "./use-product-brand-ingress";

type ProductIdentityUpdate = {
  field: "name" | "brandId" | "model";
  value: string;
};

interface ProductIdentityFormPort {
  setValue(update: ProductIdentityUpdate): void;
}

/** Stable default so an omitted `existingImages` never re-triggers the
 * `imageUrls` memo (web-runtime hook-default rule: not a fresh `[]`). */
const EMPTY_IMAGES: PendingImage[] = [];

interface IdentifyProductButtonProps {
  form: ProductIdentityFormPort;
  /** Already-attached images, minus any the operator just removed in this
   * session — a public R2 URL the server-side `ai.identifyProduct` can fetch
   * directly, same as a pending upload's. */
  existingImages?: PendingImage[];
  pendingImages: PendingImage[];
}

/** The identity fields the model can read directly from a photo. */
const IDENTITY_FIELDS = [
  { id: "name", label: "Name" },
  { id: "manufacturer", label: "Brand" },
  { id: "model", label: "Model" },
] as const satisfies readonly {
  id: keyof Pick<ProductIdentification, "name" | "manufacturer" | "model">;
  label: string;
}[];

/**
 * Reads a product's identity off its photos and offers each field it found.
 *
 * Two things changed here. The button used to **vanish** when the form had no
 * photo yet — an affordance that is absent and one that does not exist look
 * identical, so nobody learned that adding a photo unlocks it; it is now
 * disabled and says why. And acceptance used to be all four fields or none,
 * which is the wrong grain for a model that reliably reads the brandName
 * off a label and guesses at the model number: each field is its own row, and
 * "Accept all" is still one tap.
 */
export function IdentifyProductButton({
  form,
  existingImages = EMPTY_IMAGES,
  pendingImages,
}: IdentifyProductButtonProps) {
  const brands = useProductBrandIngress();
  const imageUrls = useMemo(
    () => [...existingImages, ...pendingImages].map((img) => img.url),
    [existingImages, pendingImages],
  );
  const basisKey = imageUrls.join("\0");

  const runIdentify = useCallback(
    () => ai.identifyProduct.call({ imageUrls }),
    [imageUrls],
  );

  const { proposal, isLoading, request } = useAiProposal<ProductIdentification>(
    { basisKey, run: runIdentify },
  );

  const identification = proposal?.result ?? null;

  const rows: AiProposalRow[] = identification
    ? IDENTITY_FIELDS.flatMap(({ id, label }) => {
        const value = identification[id];
        return value ? [{ id, title: value, meta: label }] : [];
      })
    : [];

  const applyField = (id: string) => {
    if (!identification) return;
    if (id === "manufacturer") {
      void brands
        .resolve(identification.manufacturer)
        .then((value) => {
          if (value) form.setValue({ field: "brandId", value });
        })
        .catch(showErrorToast);
    } else if (id === "name" || id === "model") {
      const value = identification[id];
      if (value) form.setValue({ field: id, value });
    }
  };

  return (
    <Stack className="items-start" gap="sm">
      <VerbButton
        verb="identify"
        pending={isLoading}
        disabledReason={
          imageUrls.length === 0
            ? "Add a photo to identify the product"
            : undefined
        }
        className="min-h-9 max-sm:min-h-11"
        onClick={() => {
          if (imageUrls.length > 0) void request();
        }}
      />

      {imageUrls.length === 0 && (
        <Description size="xs">
          Add a photo to identify the product.
        </Description>
      )}

      {identification && rows.length > 0 && (
        <AiProposalList
          heading="Read from the photos"
          description={`${identification.confidence} confidence · ${identification.reasoning}`}
          provenance={
            // The identification carries its confidence and reasoning but no
            // model or timestamp, so the honest provenance is when it was
            // asked. `productIdentificationSchema` would have to carry the
            // rest (`packages/schemas/src/ai.ts`).
            <AiProvenance analyzedAt={proposal?.at} />
          }
          // One confidence for the whole read, so it belongs to the run, not
          // to each row: stamping it four times claims the model is equally
          // sure of a brandName read off a label and a guessed model
          // number. Per-field confidence would have to come from
          // `productIdentificationSchema`.
          rows={rows}
          onAccept={applyField}
          onReject={() => undefined}
        />
      )}
    </Stack>
  );
}
