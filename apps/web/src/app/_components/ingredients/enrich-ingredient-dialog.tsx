import type { ProductCreateInput } from "@cubby/schemas/product";
import { useRouter } from "@tanstack/react-router";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ProductForm } from "~/app/_components/products/product-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidatesFor } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

interface EnrichIngredientDialogProps {
  /** The ingredient to enrich; the dialog is open while this is non-null. */
  ingredient: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Optional callback after a product is successfully created. */
  onEnriched?: () => void;
}

/**
 * Shared "enrich an ingredient" dialog: a centered modal embedding the existing
 * ProductForm pre-linked to the ingredient. Saving creates a linked product via
 * the standard product.create (which carries USDA NDB/UPC + price). Used by the
 * enrichment queue and the ingredient detail page.
 */
export function EnrichIngredientDialog({
  ingredient,
  onOpenChange,
  onEnriched,
}: EnrichIngredientDialogProps) {
  const api = useTRPC();
  const router = useRouter();

  const createProduct = useActionMutation({
    entity: "product",
    mutationFn: api.product.create.mutationOptions,
    success: (product) =>
      savedWithBackgroundWork(
        product.sideEffects,
        `Enriched ${ingredient?.name ?? "ingredient"}`,
      ),
    // Refresh react-query consumers (list, preview getByID)...
    invalidateKeys: invalidatesFor("ingredient"),
    onSuccess: () => {
      // ...and any route loader (the full /ingredients/$id detail).
      void router.invalidate();
      onOpenChange(false);
      onEnriched?.();
    },
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });

  return (
    <Dialog
      open={ingredient !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent size="xl">
        {ingredient && (
          <>
            <DialogHeader>
              <DialogTitle>Enrich {ingredient.name}</DialogTitle>
              <DialogDescription>
                Pick a USDA food for nutrition and conversions. Tip: enter the
                price as a purchase unit mapping (e.g. 5&nbsp;lb = $3.99) so
                recipe cost can convert — a per-item price won&apos;t cost
                weight/volume recipe lines.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              <ProductForm
                mode="create"
                isPending={createProduct.isPending}
                error={createProduct.error?.message}
                onCancel={() => onOpenChange(false)}
                onCreate={(payload: ProductCreateInput) =>
                  createProduct.mutate(payload)
                }
                initialName={ingredient.name}
                initialIngredient={{ id: ingredient.id, name: ingredient.name }}
                embedded
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
