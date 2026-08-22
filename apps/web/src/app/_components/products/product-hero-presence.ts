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
 * "Locations" then flipped the other way: counting only locations it IS made a
 * product sitting on a shelf read "LOCATIONS 0" above a table listing that
 * shelf. Both readings are half the answer, so the stat is now the union and
 * it is decided HERE — the one decision this module did not own is the one
 * that broke twice.
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
  /**
   * Locations holding loose stock of this product — one id per InventoryEntry
   * row, so duplicates are expected and deduped here.
   */
  stockedLocationIds: readonly string[];
  /**
   * Locations that ARE this product: `servingAsLocations`, the same live
   * population `quantityLedger.locationCount` counts. Taken as ids rather than
   * that count because the stat below needs to know WHICH ones, and both ride
   * the same detail read — embedded there precisely so the hero cannot
   * disagree with the table beneath it mid-flight.
   */
  identityLocationIds: readonly string[];
  /**
   * Live `ProductComponent` edges where this product is the parent. Non-zero
   * means it is a kit, and a kit that has been split into a composition record
   * holds its stock under its parts' names rather than its own.
   */
  componentCount: number;
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
  /**
   * The hero's "Locations" stat: every distinct place this product can be
   * found, whether it sits there or IS there.
   *
   * A set, not a sum. The two populations are ordinarily disjoint — a 4-pack
   * of racks with one in service as a shelf and the rest boxed in the main area
   * is genuinely findable in two places — but a bin holding loose stock of its
   * own SKU is one place, and adding would claim two.
   *
   * `quantityLedger.locationCount` deliberately stays narrow: on-hand adds it
   * to the inventory sum, so widening it there would double-count every
   * container promoted to a Location. This is a display figure only.
   */
  locationCount: number;
  /**
   * The hero stamp. Three states, not two, because "no stock under this name"
   * and "nothing to find anywhere" are different facts and the hero used to
   * say the second when it meant the first.
   *
   * A decomposed kit keeps the Expense and holds nothing of its own — the shelf
   * claim moved to its parts — so `EXPECTED 1 / ENTRIES 0` under "Not stocked"
   * read as a deficit on a set that is fully accounted for. That `1` is not
   * wrong and must not be zeroed: it is the kit's own acquisition, and the
   * projection multiplies it by each edge's quantity to give the components
   * their expected counts. Zero it and the parts' expectations collapse with
   * it, turning two real nightstands into an unexplained surplus. So the stamp
   * is what changes, not the ledger.
   */
  stamp: { label: string; tone: "green" | "ink" };
};

export const heroPresence = ({
  entryCount,
  entryUnit,
  onHandUnits,
  stockedLocationIds,
  identityLocationIds,
  componentCount,
}: HeroPresenceInput): HeroPresence => {
  const presenceCount = entryCount + identityLocationIds.length;
  const locationCount = new Set([...stockedLocationIds, ...identityLocationIds])
    .size;
  // Own stock wins: a kit still sealed in its box is stocked as itself, and
  // saying "stocked as parts" over a shelf row would be the wrong fact.
  const stamp: HeroPresence["stamp"] =
    presenceCount > 0
      ? { label: "In stock", tone: "green" }
      : componentCount > 0
        ? { label: "Stocked as parts", tone: "green" }
        : { label: "Not stocked", tone: "ink" };
  return {
    stamp,
    locationCount,
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
  };
};
