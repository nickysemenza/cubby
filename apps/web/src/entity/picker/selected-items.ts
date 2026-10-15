import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";

import { entityLabel } from "~/entity/entities";
import { entityDetailFor } from "~/entity/entity-detail";

import type {
  ComboboxItem,
  PickerEntity,
} from "../../ui/combobox/combobox-types";
import {
  buildLocationComboboxItemFromDetail,
  buildProductComboboxItem,
  buildRecordComboboxItem,
  buildVendorComboboxItem,
  pickerRecord,
} from "./combobox-builders";

const vendorDetail = z.object({
  name: z.string(),
  logo: z.object({ url: z.string() }).nullish(),
});

/** One detail read → the same row the entity's search provider builds. */
function itemFromDetail(
  entity: PickerEntity,
  id: string,
  detail: unknown,
): ComboboxItem {
  switch (entity) {
    case "product":
      // SAFETY: the product detail read is the shape the product provider's
      // own `buildDetail` consumes for an exact-code lookup.
      return buildProductComboboxItem(detail as never);
    case "location":
      // SAFETY: as above, for `buildLocationComboboxItemFromDetail`.
      return buildLocationComboboxItemFromDetail(detail as never);
    case "vendor": {
      const vendor = vendorDetail.parse(detail);
      return buildVendorComboboxItem(
        {
          id: parseShortcodeFor("vendor", id),
          name: vendor.name,
          logo: vendor.logo ?? null,
        },
        { itemId: "shortcode" },
      );
    }
    default:
      return buildRecordComboboxItem(entity, pickerRecord.parse(detail));
  }
}

/** Product categories carry no picture; every other picker entity's rows do. */
const entityHasThumb = (entity: PickerEntity) => entity !== "productCategory";

/**
 * A roster row can stand for the selection only when it is the record's own
 * row: an AI suggestion seed or a `{ id, name: id }` placeholder lacks the
 * picture (and a placeholder lacks the name), so it is resolved too.
 */
function isComplete(
  item: ComboboxItem | undefined,
  id: string,
  entity: PickerEntity,
) {
  // Only a code of this entity is resolvable; a name-keyed row (the expense
  // vendor) stands for itself.
  if (parseShortcode(id)?.type !== entity) return true;
  if (!item || item.pending || item.name === item.id) return false;
  return item.thumb != null || !entityHasThumb(entity);
}

/**
 * The selected records for stored ids, never their codes. Rows the caller
 * already holds are used as-is; every other id is read by its detail query
 * (cached and batched by the operation transport) and built with the entity's
 * own picker builder, independent of any candidate scope. While a read is in
 * flight the row is `pending`; a failed read names the failure without
 * dropping the stored id. A row the caller held keeps its `presentation`
 * (e.g. a pinned "Suggested" group) on the resolved record.
 */
export function useSelectedPickerItems(
  entity: PickerEntity | undefined,
  ids: readonly string[],
  known: readonly ComboboxItem[],
): ComboboxItem[] {
  const byId = useMemo(
    () => new Map(known.map((item) => [item.id, item])),
    [known],
  );
  const unresolved = entity
    ? [...new Set(ids)].filter((id) => !isComplete(byId.get(id), id, entity))
    : [];
  const results = useQueries({
    queries: entity
      ? unresolved.map((id) => entityDetailFor(entity).queryOptions(id))
      : [],
  });
  return ids.map((id) => {
    const held = byId.get(id);
    const index = unresolved.indexOf(id);
    if (!entity || index < 0) return held ?? { id, name: id };
    const result = results[index];
    // A detail read answers `null` for a record that no longer exists (a
    // stale suggestion, a deleted reference): name the gap, keep the id.
    if (result?.data === null) {
      return {
        id,
        name: `Missing ${entityLabel(entity).toLowerCase()}`,
        presentation: held?.presentation,
      };
    }
    if (result?.data !== undefined) {
      const built = itemFromDetail(entity, id, result.data);
      return held?.presentation
        ? { ...built, presentation: held.presentation }
        : built;
    }
    const heldName = held && held.name !== held.id ? held : null;
    if (result?.isError) {
      return (
        heldName ?? {
          id,
          name: `Couldn't load ${entityLabel(entity).toLowerCase()}`,
          detail: result.error.message,
        }
      );
    }
    return heldName ?? { id, name: "", pending: true };
  });
}
