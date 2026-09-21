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
import { format } from "date-fns";
import { type FC, useId, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { product as productOperations } from "~/app/products/product.functions";
import { tradeOptions } from "~/app/projects/trade-options";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../form-utils";

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
}

export const ProductDiscardDialog: FC<ProductDiscardDialogProps> = ({
  open,
  onOpenChange,
  product,
  defaultInventoryEntryId,
}) => {
  const adjustInventoryId = useId();
  const entries = product.inventoryEntry;
  const soleEntry = entries.length === 1 ? entries[0] : undefined;

  const defaultEntry =
    entries.find((entry) => entry.id === defaultInventoryEntryId) ?? soleEntry;

  const form = useForm<DiscardValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      // "Threw away the rest" is the common case on a part-used shelf, so a 0.5
      // entry prefills 0.5 — but a shelf of 12 still prefills 1 rather than
      // proposing to bin the lot.
      quantity: Math.min(1, defaultEntry?.amount.value ?? 1),
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
    onSuccess: () => close(false),
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
  // Whichever shelf the discard will actually touch. The sole-entry case never
  // renders the picker, so it has no id to match on.
  const selectedEntry =
    soleEntry ?? entries.find((entry) => entry.id === inventoryEntryId);
  // Only blocks when a choice is genuinely owed: several shelves, and the
  // operator has asked for one of them to be decremented.
  const needsEntryChoice =
    adjustInventory && entries.length > 1 && inventoryEntryId === "";

  /**
   * What the operator cannot see from the numbers alone: that this discard
   * *removes* the shelf row rather than reducing it, that it removes more than
   * the row holds, or that declining the checkbox leaves a row claiming stock
   * that was just written off.
   *
   * Warnings, not blocks. Tenet 1 makes the shelf a stale-tolerant ballpark, so
   * "shelf says 3, all 5 went in the bin" is a legitimate discard — see the note
   * on the else-branch in repo/product/discard.ts for why this is the one
   * inventory subtraction that does not refuse over-subtraction server-side.
   */
  const warning = ((): {
    tone: "warning" | "destructive";
    message: string;
  } | null => {
    const parsedQuantity = z.number().positive().safeParse(quantity);
    if (!selectedEntry || !parsedQuantity.success) {
      return null;
    }
    const validQuantity = parsedQuantity.data;
    const { value: held, unit } = selectedEntry.amount;
    const where = selectedEntry.location.name;
    if (!adjustInventory) {
      return validQuantity >= held
        ? {
            tone: "warning",
            message: `${where} will still show ${held} ${unit} even though you are recording these as gone.`,
          }
        : null;
    }
    if (validQuantity > held) {
      return {
        tone: "destructive",
        message: `That is more than ${where} holds (${held} ${unit}). The whole entry will be removed, and the ledger will still record −${validQuantity}.`,
      };
    }
    if (validQuantity === held) {
      return {
        tone: "warning",
        message: `This empties ${where} — the entry is removed from that shelf, not just reduced.`,
      };
    }
    return null;
  })();

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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Discard</DialogTitle>
          <DialogDescription>
            Record that units of "{product.name}" were thrown away, broken, or
            given away. Logs a $0 expense with a negative quantity — no vendor,
            no order.
          </DialogDescription>
        </DialogHeader>
        <Stack gap="md">
          <NullableNumericField
            form={form}
            name="quantity"
            label="Units discarded"
            placeholder="1"
            fraction
          />
          <PlainDateField
            form={form}
            name="date"
            label="Date"
            clearLabel="Date unknown"
          />
          <SelectField
            form={form}
            name="trade"
            label="Trade"
            options={tradeOptions}
            placeholder="Choose a trade…"
          />
          <UnifiedTextField
            form={form}
            name="reason"
            label="Reason"
            placeholder="Broke, worn out, given away…"
          />

          {entries.length === 0 ? (
            <Description>
              Not stocked anywhere, so there is nothing to take off a shelf —
              this just records the exit in the ledger.
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
                  holds {selectedEntry.amount.value} {selectedEntry.amount.unit}
                  .
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

          <Row justify="end" gap="sm">
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={needsEntryChoice || discard.isPending}
            >
              Discard
            </Button>
          </Row>
        </Stack>
      </DialogContent>
    </Dialog>
  );
};
