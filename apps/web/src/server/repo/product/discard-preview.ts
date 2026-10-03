import type {
  ProductDiscardPreviewInput,
  ProductDiscardPreviewOut,
} from "@cubby/schemas/product";

/** One live shelf row a discard could draw from. */
export type DiscardShelf = ProductDiscardPreviewOut["shelves"][number];

/**
 * What a discard will do before it runs: which shelf it touches, whether the
 * operator still owes a shelf choice, and the advisory warning.
 *
 * Warnings, not blocks. Tenet 1 makes the shelf a stale-tolerant ballpark, so
 * "shelf says 3, all 5 went in the bin" is a legitimate discard — see the note
 * in `discard.ts` for why `writeDiscardLine` does not refuse over-subtraction.
 * The verdict lives here so web and native read one answer instead of each
 * re-deriving it from the shelf list.
 */
export const describeDiscard = (
  shelves: readonly DiscardShelf[],
  input: Pick<
    ProductDiscardPreviewInput,
    "quantity" | "adjustInventory" | "inventoryEntryId"
  >,
): Omit<ProductDiscardPreviewOut, "productName" | "shelves"> => {
  const sole = shelves.length === 1 ? shelves[0] : undefined;
  const named = shelves.find((shelf) => shelf.id === input.inventoryEntryId);
  const selectedShelf = sole ?? named ?? null;
  const needsShelfChoice =
    input.adjustInventory && shelves.length > 1 && named === undefined;

  const warning = ((): ProductDiscardPreviewOut["warning"] => {
    const { quantity } = input;
    if (!selectedShelf || quantity === null || quantity <= 0) return null;
    const { value: held, unit } = selectedShelf.amount;
    const where = selectedShelf.location.name;
    if (!input.adjustInventory) {
      return quantity >= held
        ? {
            tone: "warning",
            message: `${where} will still show ${held} ${unit} even though you are recording these as gone.`,
          }
        : null;
    }
    if (quantity > held) {
      return {
        tone: "destructive",
        message: `That is more than ${where} holds (${held} ${unit}). The whole entry will be removed, and the ledger will still record −${quantity}.`,
      };
    }
    if (quantity === held) {
      return {
        tone: "warning",
        message: `This empties ${where} — the entry is removed from that shelf, not just reduced.`,
      };
    }
    return null;
  })();

  return {
    ledgerOnly: shelves.length === 0,
    selectedShelf,
    needsShelfChoice,
    warning,
  };
};
