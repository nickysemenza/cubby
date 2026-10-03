import type {
  InventoryShortcode,
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
/**
 * ProductDiscardDialog — record that units were thrown away or written off.
 *
 * The exact mirror of ReceiveExpenseDialog, and it branches on entry count for
 * the same reason: what the operator has to decide depends entirely on how many
 * shelves the product sits on, and that decision belongs somewhere visible
 * rather than inside a server-side guess.
 *
 * The inventory checkbox is the one thing worth reading twice. Inventory never
 * auto-decrements is a binding tenet, and clearing the shelf here does not
 * breach it: nothing happens as a side effect of recording money. This is an
 * explicit instruction, on a dialog naming the entry and the count, that the
 * operator can decline. Doing it in the same transaction as the ledger row is
 * the point — otherwise expected and actual diverge in the gap between two
 * writes, which is precisely the drift the Variance column exists to catch.
 */
import { tradeSchema } from "@cubby/schemas/task-fields";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { type FC, useEffect, useId, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { DiscardLineFields } from "~/features/inventory/discard-line-fields";
import { product as productOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { WorkflowDialog } from "~/ui/dialogs/workflow-dialog";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Description } from "~/ui/primitives/description";

import { NullableNumericField, SelectField } from "../../ui/form-utils";

const formSchema = z.object({
  trade: tradeSchema,
  quantity: z.number().positive(),
  date: z.string().nullable(),
  reason: z.string(),
  adjustInventory: z.boolean(),
  /** "" means unpicked — the server never guesses which shelf. */
  inventoryEntryId: z.string(),
});

type DiscardValues = z.infer<typeof formSchema>;

/**
 * Structural on purpose, so one dialog serves both the detail page and the
 * products list — `productWithFoodOut.inventoryEntry` and
 * `productListItemOut.inventoryEntry` both satisfy it.
 */
interface ProductDiscardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: {
    id: ProductShortcode;
    name: string;
    inventoryEntry: ReadonlyArray<{
      id: InventoryShortcode;
      amount: { value: number; unit: string };
      location: { id: LocationShortcode; name: string };
    }>;
  };
  /**
   * Pre-select the shelf being discarded from, for callers that opened this
   * from a specific inventory row. Seeds the form's defaults, so a caller that
   * reuses one mounted dialog across rows must key the element by the same id
   * (`key={entryId}`) to remount it for the next row.
   *
   * This does not weaken "the server never guesses which shelf" — the value
   * comes from a row the operator clicked, and they can still change it.
   */
  defaultInventoryEntryId?: InventoryShortcode;
  /**
   * Units to prefill, for a caller that knows how many the ledger says are
   * outstanding (the shelf triage discards what it cannot find, not one unit).
   * Seeds the form like `defaultInventoryEntryId`, and a shelf entry still caps
   * it, so a part-used shelf never proposes binning more than it holds.
   */
  defaultQuantity?: number;
  /** Called once the discard is recorded — not on cancel. */
  onComplete?: () => void;
}

/**
 * The server's advisory answer for the current inputs: the warning (this
 * removes the shelf row rather than reducing it, removes more than it holds, or
 * leaves a row claiming stock that was just written off) and the default
 * quantity. Warnings, not blocks: see `describeDiscard`. Whether a shelf choice
 * is owed is computed locally from the shelves and enforced by the server, so a
 * slow or failed preview never blocks the discard, and a previous answer is
 * never shown as the current one.
 */
function useDiscardPreview(input: {
  open: boolean;
  productId: ProductShortcode;
  quantity: number | null;
  adjustInventory: boolean;
  inventoryEntryId: string;
}) {
  const parsedQuantity = z.number().positive().safeParse(input.quantity);
  const { data: preview } = useQuery({
    ...productOperations.discardPreview.queryOptions({
      productId: input.productId,
      quantity: parsedQuantity.success ? parsedQuantity.data : null,
      adjustInventory: input.adjustInventory,
      inventoryEntryId: input.inventoryEntryId
        ? parseShortcodeFor("inventory", input.inventoryEntryId)
        : null,
    }),
    enabled: input.open,
  });
  return {
    selectedEntry: preview?.selectedShelf ?? null,
    warning: preview?.warning ?? null,
    defaultQuantity: preview?.defaultQuantity ?? null,
  };
}

export const ProductDiscardDialog: FC<ProductDiscardDialogProps> = ({
  open,
  onOpenChange,
  product,
  defaultInventoryEntryId,
  defaultQuantity,
  onComplete,
}) => {
  const adjustInventoryId = useId();
  const entries = product.inventoryEntry;
  const soleEntry = entries.length === 1 ? entries[0] : undefined;

  const form = useForm<DiscardValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      // The server's preview supplies the default when the caller has none
      // (see the effect below); a caller that knows better seeds it here.
      quantity: defaultQuantity ?? 1,
      date: format(new Date(), "yyyy-MM-dd"),
      reason: "",
      adjustInventory: entries.length > 0,
      inventoryEntryId: defaultInventoryEntryId ?? soleEntry?.id ?? "",
    },
  });

  const close = (nextOpen: boolean) => {
    if (!nextOpen) form.reset();
    onOpenChange(nextOpen);
  };

  const discard = useActionMutation({
    mutationFn: productOperations.discard.mutationOptions,
    success: (result) =>
      // `inventory.removed` was dead payload until now: the server reports that
      // it soft-deleted the shelf row and the toast said nothing about it.
      `Discarded ${Math.abs(result.storedQuantity)} × ${product.name}${
        result.inventory?.removed ? " — shelf entry removed" : ""
      }`,
    onSuccess: () => {
      close(false);
      onComplete?.();
    },
  });

  const entryOptions = useMemo(
    () =>
      entries.map((entry) => ({
        value: entry.id,
        label: `${entry.location.name} — ${entry.amount.value} ${entry.amount.unit}`,
      })),
    [entries],
  );

  const adjustInventory = form.watch("adjustInventory");
  const inventoryEntryId = form.watch("inventoryEntryId");
  const quantity = form.watch("quantity");
  const {
    selectedEntry,
    warning,
    defaultQuantity: serverDefaultQuantity,
  } = useDiscardPreview({
    open,
    productId: product.id,
    quantity,
    adjustInventory,
    inventoryEntryId,
  });

  // Only blocks when a choice is genuinely owed: several shelves, and the
  // operator has asked for one of them to be decremented. The server enforces
  // the same rule, so this is a convenience rather than the authority.
  const needsEntryChoice =
    adjustInventory && entries.length > 1 && inventoryEntryId === "";

  const quantityDirty = form.formState.dirtyFields.quantity === true;
  useEffect(() => {
    if (
      defaultQuantity === undefined &&
      serverDefaultQuantity !== null &&
      !quantityDirty
    ) {
      form.setValue("quantity", serverDefaultQuantity);
    }
  }, [defaultQuantity, serverDefaultQuantity, quantityDirty, form]);

  const submit = form.handleSubmit((values) => {
    discard.mutate({
      productId: product.id,
      quantity: values.quantity,
      date: values.date,
      trade: values.trade,
      reason: values.reason.trim() || null,
      adjustInventory: values.adjustInventory,
      inventoryEntryId: values.adjustInventory
        ? values.inventoryEntryId
          ? parseShortcodeFor("inventory", values.inventoryEntryId)
          : null
        : null,
    });
  });

  return (
    <WorkflowDialog
      open={open}
      onOpenChange={close}
      title="Discard"
      description={`Record that units of "${product.name}" were thrown away, broken, or given away. Logs a $0 expense with a negative quantity — no vendor, no order.`}
      primary={{
        label: "Discard",
        pending: discard.isPending,
        disabled: needsEntryChoice,
        onClick: () => void submit(),
      }}
    >
      <Stack gap="md">
        <NullableNumericField
          form={form}
          name="quantity"
          label="Units discarded"
          placeholder="1"
          fraction
        />
        <DiscardLineFields
          form={form}
          productId={product.id}
          productName={product.name}
        />

        {entries.length === 0 ? (
          <Description>
            Not stocked anywhere, so there is nothing to take off a shelf — this
            just records the exit in the ledger.
          </Description>
        ) : (
          <Stack gap="sm">
            <Controller
              control={form.control}
              name="adjustInventory"
              render={({ field }) => (
                <Row gap="sm" align="center">
                  <Checkbox
                    id={adjustInventoryId}
                    checked={field.value}
                    onCheckedChange={(checked) =>
                      field.onChange(checked === true)
                    }
                  />
                  <label htmlFor={adjustInventoryId} className="text-sm">
                    Also take these units off the shelf
                  </label>
                </Row>
              )}
            />
            {adjustInventory && selectedEntry ? (
              <Description>
                Removing from {selectedEntry.location.name}, which currently
                holds {selectedEntry.amount.value} {selectedEntry.amount.unit}.
              </Description>
            ) : null}
            {warning ? (
              <div
                className={
                  warning.tone === "destructive"
                    ? "rounded border-2 border-destructive bg-destructive/10 p-2 text-xs text-destructive"
                    : "rounded border-2 border-warning bg-warning/10 p-2 text-xs text-warning-ink"
                }
              >
                {warning.message}
              </div>
            ) : null}
            {adjustInventory && entries.length > 1 ? (
              <SelectField
                form={form}
                name="inventoryEntryId"
                label="Take from"
                options={entryOptions}
                placeholder="Pick a shelf…"
              />
            ) : null}
          </Stack>
        )}
      </Stack>
    </WorkflowDialog>
  );
};
