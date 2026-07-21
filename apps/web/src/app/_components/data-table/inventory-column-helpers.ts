import type { Amount } from "@cubby/schemas/codec";
import type { LocationType } from "@cubby/schemas/location";
import type { ComboboxItem } from "../combobox/combobox-types";
import type { CellClipboardSpec } from "./cell-clipboard";

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

export function entityCellClipboard(
  entity: string,
  item: ComboboxItem | null,
  save: (id: never) => Promise<void>,
): CellClipboardSpec {
  return {
    kindKey: `entity:${entity}`,
    getCopyPayload: () =>
      item ? { text: item.name, json: { id: item.id, name: item.name } } : null,
    onPasteValue: async ({ json }) => {
      const pasted = json as { id?: unknown; name?: unknown } | undefined;
      if (
        !pasted ||
        typeof pasted.id !== "string" ||
        typeof pasted.name !== "string"
      ) {
        throw new Error(`Paste a ${entity} cell here`);
      }
      await save(pasted.id as never);
      return { id: pasted.id, name: pasted.name };
    },
  };
}
