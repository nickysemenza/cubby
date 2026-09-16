import type { ProductCreateInput } from "@cubby/schemas/product";
import { useState } from "react";

import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import type { EntityEditResultFor } from "~/entities/editing/intent-types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { getErrorMessage } from "~/lib/error-utils";

import { ProductForm } from "./product-form";

interface ProductCreateDialogSeed {
  name?: string;
  expectedQuantity?: number | null;
  manufacturer?: string;
  upc?: string | null;
  fdcId?: number | null;
}

/**
 * Product-only create host. Product keeps a bespoke rich form (589 lines:
 * images, unit mappings, label nutrition, external ids) rather than the
 * generic editor — this dialog is the one non-page place that form is
 * created from (the picker's "create new" affordance and the USDA food
 * detail page's "create product from this food" action). `products.new.tsx`
 * is the page-based sibling for the same form.
 */
export function ProductCreateDialog({
  open,
  onOpenChange,
  seed = {},
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: ProductCreateDialogSeed;
  onSuccess?: (result: EntityEditResultFor<"product">) => void;
}) {
  const commands = useEntityCommands("product");
  const [error, setError] = useState<string>();
  const submit = async (data: ProductCreateInput) => {
    setError(undefined);
    try {
      const execution = await commands.submit({
        operation: "create",
        intent: "full",
        data,
      });
      if (execution.operation !== "create") {
        throw new Error(`product create returned ${execution.operation}.`);
      }
      onOpenChange(false);
      onSuccess?.(execution.result);
      return execution.result;
    } catch (cause) {
      setError(getErrorMessage(cause));
      throw cause;
    }
  };

  if (!open) return null;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create New Product"
      size="xl"
    >
      <ProductForm
        mode="create"
        isPending={commands.isPending}
        error={error}
        onCancel={() => onOpenChange(false)}
        onCreate={(data) => void submit(data)}
        initialName={seed.name}
        initialExpectedQuantity={seed.expectedQuantity}
        initialManufacturer={seed.manufacturer}
        initialUpc={seed.upc}
        initialFdcId={seed.fdcId}
        embedded
      />
    </ResponsiveDialog>
  );
}
