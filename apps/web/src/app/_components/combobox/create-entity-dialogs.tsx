import type { LocationCreateInput, LocationOut } from "@cubby/schemas/location";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { ComponentProps, ReactNode } from "react";
import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

/**
 * Common dialog wrapper that prevents closing when clicking on Popover contents.
 * Used by all Create*Dialog components.
 */
function CreateEntityDialogWrapper({
  isOpen,
  onOpenChange,
  title,
  children,
  size = "md",
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  size?: ComponentProps<typeof DialogContent>["size"];
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function CreateIngredientDialog({
  isOpen,
  onOpenChange,
  onCancel,
  onCreate,
  isPending,
  error,
  initialName,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: { name: string; aliases: string[] }) => void;
  isPending: boolean;
  error?: string;
  initialName?: string;
}) {
  return (
    <CreateEntityDialogWrapper
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Create New Ingredient"
    >
      <IngredientForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
      />
    </CreateEntityDialogWrapper>
  );
}

export function CreateLocationDialog({
  isOpen,
  onOpenChange,
  onCancel,
  onCreate,
  isPending,
  error,
  initialName,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: LocationCreateInput) => Promise<LocationOut>;
  isPending: boolean;
  error?: string;
  initialName?: string;
}) {
  return (
    <CreateEntityDialogWrapper
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Create New Location"
    >
      <LocationForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
      />
    </CreateEntityDialogWrapper>
  );
}

export function CreateProductDialog({
  isOpen,
  onOpenChange,
  onCancel,
  onCreate,
  isPending,
  error,
  initialName,
  initialExpectedQuantity,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: ProductCreateInput) => void;
  isPending: boolean;
  error?: string;
  initialName?: string;
  initialExpectedQuantity?: number | null;
}) {
  return (
    <CreateEntityDialogWrapper
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Create New Product"
      size="xl"
    >
      <ProductForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
        initialExpectedQuantity={initialExpectedQuantity}
        embedded
      />
    </CreateEntityDialogWrapper>
  );
}
