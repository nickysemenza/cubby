import type { Amount } from "@cubby/schemas/codec";
import type { InventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";

export type InventoryItem = InventoryWithLocationAndProductOut;

export interface UndoAction {
  run: () => Promise<void>;
}

// One staged, uncommitted decision about an expected inventory row. Nothing is
// written to the DB until "Done" commits the whole resolved set at once.
export type ItemResolution =
  | { kind: "verify" }
  | { kind: "adjust"; amount: Amount }
  | { kind: "remove" }
  | {
      kind: "relocate";
      targetLocationId: InfLocation["id"];
      targetLocationName: string;
    };
