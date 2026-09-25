/**
 * ProductBulkAddToInventoryDialog — stock one product or a whole selection at
 * one location.
 *
 * The products are fixed (the caller selected them), so the only shared
 * question is where they go; quantities stay per row because units genuinely
 * differ per product and each one's valuation resolves through its own
 * unit-mapping graph.
 *
 * - **The AI location suggester needs exactly one product.**
 *   `FieldSuggestionProvider` for `inventory.locationId` reads one product's
 *   history as its basis; a mixed selection has no single basis, and picking
 *   one row to stand for the rest would be a guess wearing a suggestion's
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
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQuery } from "@tanstack/react-query";
import { type FC, useEffect, useMemo } from "react";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  AmountFieldGroup,
  DEFAULT_AMOUNT_UNIT,
} from "~/app/_components/inventory/amount-field-group";
import { inventory } from "~/app/inventory/inventory.functions";
import { product as productOperations } from "~/app/products/product.functions";
import { Row, Stack } from "~/components/layout";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { Spinner } from "~/components/ui/spinner";
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
  /**
   * For a single staged product, what the ledger and its kit parts already
   * account for. Omitted by callers that don't know, which skips the warning.
   */
  accounting?: KitAccounting;
}

interface KitAccounting {
  /** Units the ledger says were acquired and not disposed of. */
  expectedQuantity: number;
  /** Units already on shelves under THIS product's own name. */
  ownOnHandUnits: number | null;
  /** Live `ProductComponent` edges — zero means this is not a kit. */
  componentCount: number;
}

/**
 * Whether stocking one more unit here would account for more kits than were
 * bought.
 *
 * Deliberately NOT "the parent is stocked XOR the parts are". A partially
 * opened multi-pack is a legitimate mix — two 4-packs, one opened into four
 * loose singles and one still sealed, is `1 parent + 4 components` and values
 * correctly. What is never legitimate is accounting for more units than the
 * ledger says were acquired, which is the real double-count.
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

function useKitOverAccounting(
  open: boolean,
  productId: ProductShortcode | undefined,
  accounting: KitAccounting | undefined,
) {
  // Same query the Kit Components section makes, so this costs nothing extra.
  const { data: components } = useQuery({
    ...productOperations.components.queryOptions({
      // A parseable placeholder keeps the disabled query's input valid.
      parentProductId: productId ?? productShortcode.parse("PRD-2222"),
    }),
    enabled:
      open && productId !== undefined && (accounting?.componentCount ?? 0) > 0,
  });
  return useMemo(() => {
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
> = ({ open, onOpenChange, products, onComplete, accounting }) => {
  const sole = products.length === 1 ? products[0] : undefined;
  const overAccounted = useKitOverAccounting(open, sole?.id, accounting);
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
  useEffect(() => {
    if (!open) return;
    form.reset({
      location: form.getValues("location"),
      items: rowsFor(products),
    });
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on selectionKey, not the array identity
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
      {/* `min-w-0` here and on every wrapper below is load-bearing, not tidying.
          DialogContent is a `grid` whose items default to `min-width: auto`, so
          one long product name sets a min-content width that spills past the
          dialog's `max-w` — and the popup only scrolls on Y, so the overflow is
          simply unreachable. Break the chain anywhere and `truncate` stops
          working. */}
      <Stack gap="md" className="min-w-0">
        {overAccounted && (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>Already accounted for</AlertTitle>
            <AlertDescription>
              Its parts hold {overAccounted.accounted} of the{" "}
              {overAccounted.expected} you bought. Adding one here counts a unit
              you don't own — unless you have another still assembled or sealed.
            </AlertDescription>
          </Alert>
        )}
        {sole ? (
          <FormProvider {...form}>
            <FieldSuggestionProvider
              entity="inventory"
              mode="create"
              staticBasis={{ productId: sole.id }}
              fieldKeys={["locationId"]}
              paths={{ locationId: "location" }}
            >
              <ComboboxFieldWithSearch
                form={form}
                name="location"
                label="Location"
                searchType="location"
                suggestField="locationId"
              />
            </FieldSuggestionProvider>
          </FormProvider>
        ) : (
          <ComboboxFieldWithSearch
            form={form}
            name="location"
            label="Location"
            searchType="location"
          />
        )}

        {locationId === null ? (
          <Description>Pick a location to stock these products.</Description>
        ) : (
          <Stack gap="sm" className="min-w-0">
            {fields.map((field, index) => {
              const onHand = onHandByProductId.get(field.productId);
              return (
                <Row
                  key={field.id}
                  gap="sm"
                  // Stacks on narrow: side by side, the name compresses to
                  // "Akro-Mils 3…" — which cannot tell two bin sizes apart —
                  // and the remove control runs off the sheet.
                  className="min-w-0 flex-col items-stretch rounded border p-1 sm:flex-row sm:items-end"
                >
                  <Stack gap="tight" className="min-w-0 flex-1">
                    {/* The full name stays reachable on hover — a truncated
                        "Akro-Mils 30210 Hang & Stack Storage Bin, Clear, 5-3/8
                        in L…" is not enough to tell two bin sizes apart. */}
                    <span className="truncate text-sm" title={field.label}>
                      {field.label}
                    </span>
                    {onHand && (
                      <Description size="xs">
                        already {onHand.value} {onHand.unit} here — adds to that
                        row
                      </Description>
                    )}
                  </Stack>
                  <div className="w-full sm:w-44 sm:shrink-0">
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
                    className="self-end sm:mb-1 sm:shrink-0"
                  >
                    <XIcon className="size-4" />
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
