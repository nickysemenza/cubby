import { shortcodeSchema } from "@cubby/schemas/identifiers";

import type {
  DetailEntity,
  EntityDetailByEntity,
} from "./generated/entity-details.gen";
import type {
  ListEntity,
  EntityListResultByEntity,
} from "./generated/entity-lists.gen";

/** The server validates the complete selected schema. Its shortcode discriminates
 * the returned union without loading those schemas again in the browser. */
export function correlateEntityDetail<E extends DetailEntity>(
  entity: E,
  value: EntityDetailByEntity[DetailEntity] | null,
): EntityDetailByEntity[E] | null;
export function correlateEntityDetail(
  entity: DetailEntity,
  value: EntityDetailByEntity[DetailEntity] | null,
): EntityDetailByEntity[DetailEntity] | null {
  if (value !== null) shortcodeSchema(entity).parse(value.id);
  return value;
}

export function correlateEntityList<E extends ListEntity>(
  entity: E,
  value: EntityListResultByEntity[ListEntity],
): EntityListResultByEntity[E];
export function correlateEntityList(
  entity: ListEntity,
  value: EntityListResultByEntity[ListEntity],
): EntityListResultByEntity[ListEntity] {
  const id = shortcodeSchema(entity);
  for (const row of value.items) id.parse(row.id);
  return value;
}
