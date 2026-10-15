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
    "quantity" | "adjustInventory" | "inventoryEntryId" | "requestedQuantity"
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

  // "Threw away the rest" is the common case on a part-used shelf, so a 0.5
  // entry prefills 0.5 — but a shelf of 12 still prefills 1, not the lot.
  // A caller that knows better (the triage proposes what the ledger expects)
  // asks for it; the shelf still caps it, so a part-used shelf never proposes
  // binning more than it holds. A shelf at or below zero cannot cap: the
  // default must stay positive.
  const requested = input.requestedQuantity ?? 1;
  const held = selectedShelf?.amount.value ?? 0;
  const defaultQuantity = held > 0 ? Math.min(requested, held) : requested;

  return {
    defaultQuantity,
    ledgerOnly: shelves.length === 0,
    selectedShelf,
    needsShelfChoice,
    warning,
  };
};
