import type { ProductCreateInput } from "@cubby/schemas/product";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { ProductForm } from "~/app/_components/products/product-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";

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
  const queryClient = useQueryClient();
  const router = useRouter();

  const createProduct = useMutation(
    api.product.create.mutationOptions({
      onSuccess: () => {
        toast.success(`Enriched ${ingredient?.name ?? "ingredient"}.`);
        // Refresh react-query consumers (list, preview getByID) and any route
        // loader (the full /ingredients/$id detail) so the new product shows.
        queryClient.invalidateQueries({ queryKey: [["ingredient"]] });
        void router.invalidate();
        onOpenChange(false);
        onEnriched?.();
      },
      onError: (err) => {
        toast.error(`Failed to create product: ${getErrorMessage(err)}`);
      },
    }),
  );

  return (
    <Dialog
      open={ingredient !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
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
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
