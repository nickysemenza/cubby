/**
 * ProductAddToInventoryDialog — stock a known product from its detail page.
 *
 * The product is fixed, so the only thing missing is where it goes: pick a
 * location, then the shared QuickInventoryAdd form (product prefilled) handles
 * the amount and the create.
 */

import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { type FC, useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  getOptionalLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import { QuickInventoryAdd } from "~/app/_components/inventory/quick-inventory-add";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

const formSchema = z.object({ location: optionalLocationField });

type AddToInventoryValues = z.infer<typeof formSchema>;

interface ProductAddToInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: {
    id: ProductShortcode;
    name: string;
    manufacturer: string;
  };
}

export const ProductAddToInventoryDialog: FC<
  ProductAddToInventoryDialogProps
> = ({ open, onOpenChange, product }) => {
  const form = useForm<AddToInventoryValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { location: null },
  });
  const locationId = getOptionalLocationId(form.watch("location"));

  const initialProduct = useMemo(
    () => ({
      id: product.id,
      name: `${product.name} (${product.manufacturer})`,
    }),
    [product],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      form.reset();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add to Inventory</DialogTitle>
          <DialogDescription>
            Stock "{product.name}" at a location.
          </DialogDescription>
        </DialogHeader>
        <Stack gap="md">
          <ComboboxFieldWithSearch
            form={form}
            name="location"
            label="Location"
            searchType="location"
          />
          {locationId ? (
            <QuickInventoryAdd
              locationId={locationId}
              initialProduct={initialProduct}
              onSuccess={() => handleOpenChange(false)}
            />
          ) : (
            <Description>Pick a location to stock this product.</Description>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
};
