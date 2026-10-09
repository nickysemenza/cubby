import type { Amount } from "@cubby/schemas/codec";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  parseShortcodeFor,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";

import type { ComboboxItem } from "../combobox/combobox-types";
import type { CellClipboardSpec } from "./cell-clipboard";
import { entityCellData, specFromCellData } from "./cell-data";

export interface InventoryEntryBase {
  id: string;
  amount: Amount;
  location?: { id: string; name: string; type: LocationType | null };
  product?: { id: string; name: string; manufacturer: string };
}

export type InventoryRelatedEntity =
  | {
      entity: "location";
      data: { id: string; name: string; type: LocationType | null };
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
export function entityCellClipboard<E extends ShortcodeEntity>(
  entity: E,
  item: ComboboxItem<ShortcodeFor<E>> | null,
  save: (id: ShortcodeFor<E>) => Promise<void>,
): CellClipboardSpec<ComboboxItem<ShortcodeFor<E>> | null> {
  return specFromCellData(
    entityCellData<null, ShortcodeFor<E>>(
      entity,
      (value) => parseShortcodeFor(entity, value),
      () => item,
      async (_row, id) => {
        await save(id);
      },
    ),
    null,
  );
}
