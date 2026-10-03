import type { InventoryReceivingContextOut } from "@cubby/schemas/inventory";

const DEFAULT_RECEIVING_UNIT = "each";

type Guidance = Pick<
  InventoryReceivingContextOut,
  | "alreadyCounted"
  | "defaultQuantity"
  | "defaultUnit"
  | "suggestedPlan"
  | "locationPlans"
>;

/**
 * The one definition of receiving defaults; web and native render it as-is.
 * Importing a purchase never stocks, so a Product that is already counted (own
 * stock, or a stocked match that may be the same item) prefills no quantity.
 * A one-of-a-kind item (`expectedQuantity === 1`) with exactly one entry moves
 * wherever it is received, mirroring `validateReceivingChoice`, which refuses
 * anything else for it.
 */
export function deriveReceivingGuidance(input: {
  expectedQuantity: number | null;
  stock: Array<
    Pick<InventoryReceivingContextOut["stock"][number], "id" | "locationId"> & {
      amount: { unit: string };
    }
  >;
  matches: Array<{ inventoryCount: number }>;
}): Guidance {
  const alreadyCounted =
    input.stock.length > 0 ||
    input.matches.some((match) => match.inventoryCount > 0);
  const sole =
    input.expectedQuantity === 1 && input.stock.length === 1
      ? input.stock[0]
      : undefined;
  return {
    alreadyCounted,
    defaultQuantity: alreadyCounted ? null : 1,
    defaultUnit: DEFAULT_RECEIVING_UNIT,
    suggestedPlan: sole
      ? { kind: "move", entryId: sole.id, fromLocationId: sole.locationId }
      : { kind: "create" },
    locationPlans: sole
      ? []
      : input.stock.map((entry) => ({
          locationId: entry.locationId,
          plan: {
            kind: "add" as const,
            entryId: entry.id,
            unit: entry.amount.unit,
          },
        })),
  };
}
