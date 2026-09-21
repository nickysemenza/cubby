import type { ProductWithFoodOut } from "@cubby/schemas/product";

import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { useEntityDetailController } from "~/entities/editing/use-entity-detail-controller";

import { ProductForm } from "./product-form";

/**
 * The product edit surface: `ProductForm` in edit mode inside a dialog. It
 * outlives the bespoke product page because its unit-mapping and
 * label-nutrition editors have no generic `structured-field` renderer yet.
 */
export function ProductEditDialog({
  record,
  onClose,
}: {
  record: ProductWithFoodOut;
  onClose: () => void;
}) {
  const editMode = useEntityDetailController({
    entity: "product",
    entityId: record.id,
    onSuccess: onClose,
  });
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && !editMode.isPending) onClose();
      }}
      title="Edit product"
      size="lg"
    >
      <ProductForm
        mode="edit"
        entity={record}
        onEdit={editMode.submit}
        isPending={editMode.isPending}
        error={editMode.error}
        onCancel={() => {
          if (!editMode.isPending) onClose();
        }}
      />
    </ResponsiveDialog>
  );
}
