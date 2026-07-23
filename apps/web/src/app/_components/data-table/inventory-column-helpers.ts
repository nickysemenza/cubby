import type { Amount } from "@cubby/schemas/codec";
import type { LocationType } from "@cubby/schemas/location";
import type { ComboboxItem } from "../combobox/combobox-types";
import type { CellClipboardSpec } from "./cell-clipboard";
import { entityCellData, specFromCellData } from "./cell-data";

export interface InventoryEntryBase {
  id: string;
  amount: Amount;
  location?: { id: string; name: string; type: LocationType };
  product?: { id: string; name: string; manufacturer: string };
}

export type InventoryRelatedEntity =
  | {
      entity: "location";
      data: { id: string; name: string; type: LocationType };
    }
  | {
      entity: "product";
      data: { id: string; name: string; manufacturer: string };
    };

/**
 * Per-cell entity clipboard spec, for cells that build their own spec inline
 * (e.g. `inventory-entries-cell`) rather than declaring column `meta.cellData`.
 * Thin adapter over the canonical `entityCellData` builder — one source of
 * truth for entity copy/paste.
 */
export function entityCellClipboard(
  entity: string,
  item: ComboboxItem | null,
  save: (id: never) => Promise<void>,
): CellClipboardSpec {
  return specFromCellData(
    entityCellData<null>(
      entity,
      () => item,
      async (_row, id) => {
        await save(id as never);
      },
    ),
    null,
  );
}
