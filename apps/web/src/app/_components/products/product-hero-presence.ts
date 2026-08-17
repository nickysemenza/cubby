import type { Amount } from "@cubby/schemas/codec";

/**
 * What the product hero says about where this product is.
 *
 * Extracted from the JSX because all four of its decisions were wrong at once
 * and nothing could see them: the stat rendered `entries.length` under the
 * label "On hand" (a different number than `onHandUnits`), "Locations" counted
 * shelves the product sat on while the section below counted locations it IS,
 * and the stamp keyed on shelf rows so a rack in service read "NOT STOCKED".
 *
 * Returns data, not nodes, so the rules are unit-testable.
 */
export interface HeroPresenceInput {
  /** Live InventoryEntry rows — loose stock. */
  entryCount: number;
  /**
   * Unit shared by those rows. Absent when there are none, which is the
   * ordinary case for a product held entirely as bins.
   */
  entryUnit: string | undefined;
  /**
   * The SERVER's on-hand total: stock units plus locations that ARE this
   * product. Null only when the shelf rows carry mixed units, where no sum is
   * meaningful. Never recomputed here — this page deriving its own on-hand is
   * what let the list and the detail disagree twice.
   */
  onHandUnits: number | null;
  /** Locations that ARE this product, from `quantityLedger`. */
  locationCount: number;
}

export type HeroPresence = {
  /**
   * `amount` whenever the server produced a total; `entryCount` only for the
   * mixed-unit case, where the honest answer is how many rows there are rather
   * than a sum that would mean nothing.
   */
  onHand:
    | { kind: "amount"; label: "On hand"; amount: Amount }
    | { kind: "entries"; label: "Entries"; count: number };
  /** Anywhere it is: loose stock plus bins in service. */
  presenceCount: number;
  inStock: boolean;
};

export const heroPresence = ({
  entryCount,
  entryUnit,
  onHandUnits,
  locationCount,
}: HeroPresenceInput): HeroPresence => {
  const presenceCount = entryCount + locationCount;
  return {
    onHand:
      onHandUnits !== null
        ? {
            kind: "amount",
            label: "On hand",
            // A location is one unit by definition, so `each` is the right
            // fallback when there is no shelf row to borrow a unit from.
            amount: { value: onHandUnits, unit: entryUnit ?? "each" },
          }
        : { kind: "entries", label: "Entries", count: entryCount },
    presenceCount,
    inStock: presenceCount > 0,
  };
};
