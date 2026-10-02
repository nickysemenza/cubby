import type { ShortcodeFor } from "@cubby/schemas/identifiers";

import type { ProductPickerIntent } from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import { EntityPicker, type EntityPickerProps } from "./entity-picker";
import type { EntitySearchScope } from "./entity-search-hooks";
import {
  type EntitySearchEntity,
  useEntityListSource,
} from "./with-search-hook";

type EntityReferencePickerProps<E extends EntitySearchEntity> = {
  entity: E;
  intent?: ProductPickerIntent;
  scope?: EntitySearchScope | null;
  /** Offer the entity's create-from-picker affordance (ingredient, location,
   * product) when the typed name matches nothing. */
  creatable?: boolean;
  /** Annotate or disable candidates in place (e.g. invalid move targets). */
  mapItems?: (
    items: ComboboxItem<ShortcodeFor<E>>[],
  ) => ComboboxItem<ShortcodeFor<E>>[];
} & Omit<
  EntityPickerProps<ShortcodeFor<E>>,
  | "entity"
  | "items"
  | "onSearchChange"
  | "onOpenChange"
  | "isLoading"
  | "onCreateNew"
>;

/** A searchable single-entity picker wired to `useEntityListSource`. */
export function EntityReferencePicker<E extends EntitySearchEntity>({
  entity,
  intent,
  scope,
  creatable = false,
  mapItems,
  ...picker
}: EntityReferencePickerProps<E>) {
  const { dialog, items, onCreateNew, ...search } = useEntityListSource(
    entity,
    { intent, scope },
  );
  return (
    <>
      {dialog}
      <EntityPicker
        {...picker}
        {...search}
        entity={entity}
        items={mapItems ? mapItems(items) : items}
        onCreateNew={creatable ? onCreateNew : undefined}
      />
    </>
  );
}
