import type { ShortcodeFor } from "@cubby/schemas/identifiers";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { Image } from "~/ui/primitives/image";

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
  const images = useEntityDisplayImages(
    [...items, ...(picker.value ? [picker.value] : [])].map((item) => ({
      entityKind: entity,
      entityId: item.id,
    })),
  );
  const withImage = (item: ComboboxItem<ShortcodeFor<E>>) => {
    const imageUrl =
      images[entityDisplayImageKey({ entityKind: entity, entityId: item.id })]
        ?.url ?? item.imageUrl;
    return {
      ...item,
      imageUrl,
      icon: imageUrl ? (
        <Image
          src={imageUrl}
          alt=""
          displayWidth={40}
          className="size-10 shrink-0 rounded-sm border border-border object-cover"
        />
      ) : (
        item.icon
      ),
    };
  };
  const hydratedItems = items.map(withImage);
  return (
    <>
      {dialog}
      <EntityPicker
        {...picker}
        {...search}
        entity={entity}
        value={picker.value ? withImage(picker.value) : null}
        items={mapItems ? mapItems(hydratedItems) : hydratedItems}
        onCreateNew={creatable ? onCreateNew : undefined}
      />
    </>
  );
}
