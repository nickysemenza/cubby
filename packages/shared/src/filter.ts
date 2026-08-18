/**
 * A requested exact-entity filter whose URL value was not a valid shortcode.
 *
 * This must remain distinct from omission: omitted filters are unrestricted,
 * while this value resolves to an empty id set and therefore matches nothing.
 * It is not a valid shortcode and cannot collide with a real entity.
 */
export const UNRESOLVABLE_ENTITY_FILTER =
  "__unresolvable_entity_filter__" as const;
