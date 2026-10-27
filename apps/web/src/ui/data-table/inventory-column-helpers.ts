import type { EntityFieldEnvelopeRead } from "@cubby/schemas/entity-field-envelopes";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  parseShortcodeFor,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";

import type { InlineRefLinkProps } from "~/entity/components/ref-link/inline";

import type { ComboboxItem } from "../combobox/combobox-types";
import type { CellClipboardSpec } from "./cell-clipboard";
import { entityCellData, specFromCellData } from "./cell-data";

export type InventoryEntryBase = {
  id: string;
  fields: Pick<
    EntityFieldEnvelopeRead<"inventory", "list">["fields"],
    "amount"
  >;
};
export type InventoryRelatedEntity =
  | {
      entity: "location";
      data: Extract<InlineRefLinkProps, { entity: "location" }>["data"];
    }
  | {
      entity: "product";
      data: Extract<InlineRefLinkProps, { entity: "product" }>["data"];
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
