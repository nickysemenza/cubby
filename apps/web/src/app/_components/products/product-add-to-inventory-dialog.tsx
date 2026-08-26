/**
 * ProductAddToInventoryDialog — stock a known product from its detail page.
 *
 * The product is fixed, so the only thing missing is where it goes: pick a
 * location — or let the AI suggester read the roster and propose one — then the
 * shared QuickInventoryAdd form (product prefilled) handles the amount and the
 * create.
 */

import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { type FC, useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  getOptionalLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { QuickInventoryAdd } from "~/app/_components/inventory/quick-inventory-add";
import { LocationFieldWithAI } from "~/app/_components/locations/location-field-with-ai";
import { product as productOperations } from "~/app/products/product.functions";
import { Stack } from "~/components/layout";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Description } from "~/components/ui/description";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

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
  /**
   * What the ledger and this kit's parts already account for, when the caller
   * knows. Omitted by callers that don't, which simply skips the warning.
   */
  accounting?: {
    /** Units the ledger says were acquired and not disposed of. */
    expectedQuantity: number;
    /** Units already on shelves under THIS product's own name. */
    ownOnHandUnits: number | null;
    /** Live `ProductComponent` edges — zero means this is not a kit. */
    componentCount: number;
  };
}

/**
 * Whether stocking one more unit here would account for more kits than were
 * bought.
 *
 * Deliberately NOT "the parent is stocked XOR the parts are". A partially
 * opened multi-pack is a legitimate mix — two AirTag 4-packs, one opened into
 * four loose singles and one still sealed, is `1 parent + 4 components` and
 * values correctly. What is never legitimate is accounting for more units than
 * the ledger says were acquired, which is the real double-count.
 *
 * Complete kits, not loose parts: a kit whose parts are half-present accounts
 * for zero whole kits, so this stays quiet rather than warning on a shortfall
 * that the variance cue already reports.
 */
export const kitsAccountedByParts = (
  components: readonly { quantity: number; onHandUnits: number | null }[],
): number | null => {
  if (components.length === 0) return null;
  let complete = Number.POSITIVE_INFINITY;
  for (const component of components) {
    // A mixed-unit part cannot be counted, so the kit's accounting is
    // unanswerable rather than zero — silence beats a wrong number.
    if (component.onHandUnits === null) return null;
    complete = Math.min(
      complete,
      Math.floor(component.onHandUnits / component.quantity),
    );
  }
  return complete;
};

export const ProductAddToInventoryDialog: FC<
  ProductAddToInventoryDialogProps
> = ({ open, onOpenChange, product, accounting }) => {
  // Same query the Kit Components section makes, so this costs nothing extra.
  const { data: components } = useQuery({
    ...productOperations.components.queryOptions({
      parentProductId: product.id,
    }),
    enabled: open && (accounting?.componentCount ?? 0) > 0,
  });
  const overAccounted = useMemo(() => {
    if (!accounting || !components) return null;
    const byParts = kitsAccountedByParts(components);
    if (byParts === null) return null;
    const accounted = byParts + (accounting.ownOnHandUnits ?? 0);
    // Only a ledger that says something can be exceeded. Expected 0 means no
    // receipt was ever entered, not that nothing is owned, so stay quiet.
    if (accounting.expectedQuantity <= 0) return null;
    return accounted >= accounting.expectedQuantity
      ? { accounted, expected: accounting.expectedQuantity }
      : null;
  }, [accounting, components]);

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
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      size="md"
      title="Add to Inventory"
      description={`Stock "${product.name}" at a location.`}
    >
      <Stack gap="md">
        {overAccounted && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Already accounted for</AlertTitle>
            <AlertDescription>
              Its parts hold {overAccounted.accounted} of the{" "}
              {overAccounted.expected} you bought. Adding one here counts a unit
              you don't own — unless you have another still assembled or sealed.
            </AlertDescription>
          </Alert>
        )}
        <LocationFieldWithAI
          form={form}
          name="location"
          productId={product.id}
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
    </ResponsiveDialog>
  );
};
