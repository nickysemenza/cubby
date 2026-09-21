import { inventoryShortcode } from "@cubby/schemas/identifiers";
import { tradeSchema } from "@cubby/schemas/task-fields";
/**
 * BulkDiscardInventoryDialog — write off units from a selection of shelf rows.
 *
 * The inventory-side counterpart to `ProductDiscardDialog`, and deliberately
 * the simpler of the two. That one starts from a product, so it has to fetch
 * every shelf the product sits on and make the operator pick one; a selection
 * of inventory rows has already answered that per row, which is why bulk
 * discard is only offered where the rows ARE entries.
 *
 * Two things it must do that a confirmation dialog does not:
 *
 *  - **List the lines it will write, before writing them.** There is no undo in
 *    this repo, and a discard mints a permanent $0 ledger line per row. So
 *    every row states what it holds and what it becomes, through the shell's
 *    `effect` projection — including the rows that empty, which are removed
 *    from the shelf rather than reduced.
 *  - **Refuse more than the row holds.** `discardFromInventoryEntries` refuses
 *    it server-side (see the guard there for why bulk diverges from the
 *    permissive single-row path); this marks the row `blocked` so the refusal
 *    is visible before the request rather than as an error toast after it.
 *
 * Date and reason are shared because they describe the event; quantity is per
 * row because each row holds a different amount.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { type FC, useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import type { InventoryDialogItem } from "~/app/_components/inventory/dialog-item";
import { inventory } from "~/app/inventory/inventory.functions";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Stack } from "~/components/layout";
import { QuantityInput } from "~/components/ui/quantity-input";
import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";

import { DiscardLineFields } from "./discard-line-fields";

const formSchema = z.object({
  trade: tradeSchema,
  date: z.string().nullable(),
  reason: z.string(),
  quantities: z.record(inventoryShortcode, z.number().nullable()),
});

type DiscardValues = z.infer<typeof formSchema>;

interface BulkDiscardInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryDialogItem[];
  /** Called after a successful discard — the caller clears its row selection. */
  onSuccess?: () => void;
}

/**
 * Keyed by entry rather than a `useFieldArray`: the shell owns the row list and
 * hands `renderItem` an item, not an index, so a lookup is what the projection
 * and the input both need.
 */
const defaultQuantities = (items: InventoryDialogItem[]) =>
  Object.fromEntries(
    // The whole row, not 1: a selection of shelf rows reads as "these are
    // gone". The single-product dialog prefills 1 for the opposite reason —
    // there the operator named a product, not a quantity.
    items.map((item) => [item.id, item.amount.value] as const),
  );

// Through `format_quantity`, the same way `QuantityInput` renders the field
// beside it: half a coil reads "1/2" in the input, and a projection that said
// "0.5" for the remainder would be the one place on the row that disagreed.
const amountLabel = (value: number, unit: string) =>
  `${wasm.format_quantity(value)} ${unit}`;

export const BulkDiscardInventoryDialog: FC<
  BulkDiscardInventoryDialogProps
> = ({ open, onOpenChange, items, onSuccess }) => {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<DiscardValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      date: format(new Date(), "yyyy-MM-dd"),
      reason: "",
      quantities: defaultQuantities(items),
    },
  });

  // Reseed when the caller opens on a different selection. Keyed on the id list
  // rather than the array identity: the rows are resolved from live list data,
  // so an unrelated invalidation hands back a new array for the same selection
  // and would otherwise wipe in-progress quantity edits.
  const selectionKey = items.map((item) => item.id).join(",");
  useEffect(() => {
    if (!open) return;
    setError(null);
    form.reset({
      date: form.getValues("date"),
      trade: form.getValues("trade"),
      reason: form.getValues("reason"),
      quantities: defaultQuantities(items),
    });
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on selectionKey, not the array identity
  }, [selectionKey, open, form]);

  const quantities = form.watch("quantities");

  // Ambiguous with more than one product staged — same single-item gate as
  // bulk-edit's own basis rule (`bulk-edit-entity-action.tsx`).
  const soleProduct = useMemo(() => {
    const ids = new Set(items.map((item) => item.product.id));
    return ids.size === 1 ? items[0]?.product : undefined;
  }, [items]);

  const discard = useMutation(
    inventory.bulkDiscard.mutationOptions({
      onError: (err) => setError(getErrorMessage(err)),
    }),
  );

  const lines = useMemo(
    () =>
      items.flatMap((item) => {
        const quantity = quantities[item.id] ?? null;
        return quantity !== null && quantity > 0
          ? [{ inventoryEntryId: item.id, quantity }]
          : [];
      }),
    [items, quantities],
  );

  const close = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (lines.length === 0) {
      setError("Enter how much to discard on at least one row.");
      return;
    }
    setError(null);
    if (!(await form.trigger())) return;
    const values = form.getValues();
    let result: Awaited<ReturnType<typeof discard.mutateAsync>>;
    try {
      result = await discard.mutateAsync({
        items: lines,
        date: values.date,
        trade: values.trade,
        reason: values.reason.trim() || null,
      });
    } catch {
      // `onError` already put the refusal on the dialog; keeping it open is the
      // point — a closed dialog would drop the reason with it.
      return;
    }
    const removed = result.items.filter((line) => line.removed).length;
    toast.success(
      `Discarded from ${result.items.length} ${result.items.length === 1 ? "entry" : "entries"}${
        removed > 0
          ? ` — ${removed} shelf ${removed === 1 ? "entry" : "entries"} removed`
          : ""
      }`,
    );
    onSuccess?.();
    close(false);
  };

  return (
    <BulkActionDialog
      open={open}
      onOpenChange={close}
      items={items}
      action="Discard"
      actionLabel="Discard"
      pendingLabel="Discarding..."
      itemNoun="Entry"
      description={`Writes one $0 ledger line per row — no vendor, no order — and takes the units off ${items.length === 1 ? "that shelf" : "each shelf"}.`}
      variant="destructive"
      renderItem={(item) => (
        // Input FIRST, name after: the shell truncates whatever `renderItem`
        // returns, so a control placed after a long product name is what gets
        // clipped away.
        <span className="flex min-w-0 items-center gap-2">
          <Controller
            control={form.control}
            name={`quantities.${item.id}`}
            render={({ field }) => (
              <QuantityInput
                className="h-7 w-16 shrink-0"
                aria-label={`Units of ${item.product.name} to discard from ${item.location.name}`}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
          <span
            className="min-w-0 truncate"
            title={`${item.product.name} — ${item.location.name}`}
          >
            {item.product.name}
            <span className="text-muted-foreground">
              {" "}
              · {item.location.name}
            </span>
          </span>
        </span>
      )}
      effect={(item) => {
        const held = item.amount.value;
        const unit = item.amount.unit;
        const quantity = quantities[item.id] ?? null;
        if (quantity === null || quantity <= 0) {
          return {
            from: amountLabel(held, unit),
            to: amountLabel(held, unit),
            unchanged: true,
          };
        }
        if (quantity > held) {
          return {
            from: amountLabel(held, unit),
            to: amountLabel(held, unit),
            blocked: `only ${amountLabel(held, unit)} here`,
          };
        }
        const remaining = held - quantity;
        return {
          from: amountLabel(held, unit),
          // An emptied entry is soft-deleted rather than left at zero, and the
          // operator cannot tell that from "0 each".
          to: remaining > 0 ? amountLabel(remaining, unit) : "entry removed",
        };
      }}
      unchangedLabel="left alone"
      onSubmit={handleSubmit}
      isPending={discard.isPending}
      error={error}
    >
      <Stack gap="sm">
        <DiscardLineFields
          form={form}
          productId={soleProduct?.id}
          productName={soleProduct?.name}
        />
      </Stack>
    </BulkActionDialog>
  );
};
