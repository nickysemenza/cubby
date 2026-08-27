/**
 * ProductBulkAddToInventoryDialog — stock a whole selection at one location.
 *
 * The multi-row counterpart to `ProductAddToInventoryDialog`. The products are
 * fixed (the caller selected them), so the only shared question is where they
 * go; quantities stay per row because units genuinely differ per product and
 * each one's valuation resolves through its own unit-mapping graph.
 *
 * Two deliberate differences from the single-product dialog:
 *
 * - **No AI location suggester.** `LocationFieldWithAI` reads one product's
 *   history to propose a shelf (`basisKey={productId}`); with a mixed
 *   selection there is no single basis to suggest from, and picking one row's
 *   product to stand for the rest would be a guess wearing a suggestion's
 *   clothes.
 * - **The merge is shown before it happens.** `(productId, locationId,
 *   placement)` is a partial unique index, so an item whose slot is already
 *   occupied sums into that row rather than creating a second one. Silently
 *   summing is how a re-run doubles a shelf, so every already-stocked row says
 *   what it will become.
 */

import {
  type ProductShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { positiveAmount } from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type FC, useEffect, useMemo } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  AmountFieldGroup,
  DEFAULT_AMOUNT_UNIT,
} from "~/app/_components/inventory/amount-field-group";
import { inventory } from "~/app/inventory/inventory.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { Spinner } from "~/components/ui/spinner";
import { invalidatesFor } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { getLocationId, requiredLocationField } from "../form-fields";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";

const formSchema = z.object({
  location: requiredLocationField,
  items: z
    .array(
      z.object({
        productId: productShortcode,
        label: z.string(),
        amount: positiveAmount,
      }),
    )
    .min(1, "Keep at least one product"),
});

type BulkAddValues = z.input<typeof formSchema>;

export interface BulkAddProduct {
  id: ProductShortcode;
  name: string;
  /**
   * Optional because a caller that reached this from a shortcode has a name
   * and nothing else. It only disambiguates the label, so its absence costs a
   * suffix rather than blocking the add.
   */
  manufacturer?: string | null;
}

interface ProductBulkAddToInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: readonly BulkAddProduct[];
  /** Called after a successful add — the caller clears its row selection. */
  onComplete?: () => void;
}

const rowsFor = (products: readonly BulkAddProduct[]) =>
  products.map((product) => ({
    productId: product.id,
    label: product.manufacturer
      ? `${product.name} (${product.manufacturer})`
      : product.name,
    amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
  }));

export const ProductBulkAddToInventoryDialog: FC<
  ProductBulkAddToInventoryDialogProps
> = ({ open, onOpenChange, products, onComplete }) => {
  const form = useForm<BulkAddValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { location: null, items: rowsFor(products) },
  });
  const { fields, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Reseed when the caller opens the dialog on a different selection. Keyed on
  // the id list rather than the array identity: the products are resolved from
  // live list data, so an unrelated invalidation hands back a new array for
  // the same selection and would otherwise wipe in-progress quantity edits.
  const selectionKey = products.map((product) => product.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on selectionKey, not the array identity
  useEffect(() => {
    if (!open) return;
    form.reset({
      location: form.getValues("location"),
      items: rowsFor(products),
    });
  }, [selectionKey, open, form]);

  const location = form.watch("location");
  const locationId = location ? getLocationId(location) : null;

  // What is already on that shelf, so a row that will merge can say so. One
  // query for the whole location — the selection is small, and this endpoint
  // is unpaginated, unlike the entity list.
  const { data: existing } = useQuery({
    ...inventory.getByLocationIds.queryOptions({
      locationIds: locationId ? [locationId] : [],
    }),
    enabled: open && locationId !== null,
  });

  // Stock only: an installed fixture occupies a different slot, so it is not
  // what an added unit would merge into.
  const onHandByProductId = useMemo(() => {
    const map = new Map<string, { value: number; unit: string }>();
    for (const entry of existing ?? []) {
      if (entry.placement !== "stock") continue;
      map.set(entry.product.id, entry.amount);
    }
    return map;
  }, [existing]);

  const addMutation = useActionMutation({
    mutationFn: inventory.bulkAdd.mutationOptions,
    // The inventory fan-out already covers location, product and problems.
    invalidateKeys: invalidatesFor("inventory"),
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        data.mergedCount === 0
          ? `Stocked ${data.createdCount} product${data.createdCount === 1 ? "" : "s"}`
          : `Stocked ${data.items.length} product${data.items.length === 1 ? "" : "s"} — ${data.mergedCount} merged into stock already there`,
      ),
    onSuccess: () => {
      handleOpenChange(false);
      onComplete?.();
    },
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) form.reset({ location: null, items: rowsFor(products) });
    onOpenChange(nextOpen);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    await addMutation.mutateAsync({
      locationId: getLocationId(values.location),
      items: values.items.map((item) => ({
        productId: item.productId,
        amount: item.amount,
      })),
    });
  });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      size="lg"
      title="Add to inventory"
      description={`Stock ${products.length} product${products.length === 1 ? "" : "s"} at one location.`}
      footer={
        <Button
          type="button"
          onClick={onSubmit}
          disabled={addMutation.isPending || fields.length === 0}
        >
          {addMutation.isPending && <Spinner size="sm" />}
          Add {fields.length} to inventory
        </Button>
      }
    >
      <Stack gap="md">
        <ComboboxFieldWithSearch
          form={form}
          name="location"
          label="Location"
          searchType="location"
        />

        {locationId === null ? (
          <Description>Pick a location to stock these products.</Description>
        ) : (
          <Stack gap="sm">
            {fields.map((field, index) => {
              const onHand = onHandByProductId.get(field.productId);
              return (
                <Row
                  key={field.id}
                  align="end"
                  gap="sm"
                  className="rounded border p-1"
                >
                  <Stack gap="tight" className="min-w-0 flex-1">
                    <span className="truncate text-sm">{field.label}</span>
                    {onHand && (
                      <Description size="xs">
                        already {onHand.value} {onHand.unit} here — adds to that
                        row
                      </Description>
                    )}
                  </Stack>
                  <div className="w-56">
                    <AmountFieldGroup
                      form={form}
                      valuePath={`items.${index}.amount.value`}
                      unitPath={`items.${index}.amount.unit`}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${field.label}`}
                    onClick={() => remove(index)}
                    className="mb-1 shrink-0"
                  >
                    <X className="size-4" />
                  </Button>
                </Row>
              );
            })}
          </Stack>
        )}
      </Stack>
    </ResponsiveDialog>
  );
};
