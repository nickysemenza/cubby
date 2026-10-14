/**
 * A requested exact-entity filter whose URL value was not a valid shortcode.
 *
 * This must remain distinct from omission: omitted filters are unrestricted,
 * while this value resolves to an empty id set and therefore matches nothing.
 * It is not a valid shortcode and cannot collide with a real entity.
 */
export const UNRESOLVABLE_ENTITY_FILTER =
  "__unresolvable_entity_filter__" as const;

/**
 * The signed-in member, as a value of any Ledger Party filter.
 *
 * Saved views, URLs, and native filter state carry the token itself so one
 * declaration means "me" for every member; the entity kernel replaces it with
 * the actor's member shortcode before a repository runs, or with
 * `UNRESOLVABLE_ENTITY_FILTER` when the actor has no linked member, so an
 * unlinked actor matches nothing instead of losing the filter.
 */
export const CURRENT_MEMBER_FILTER = "@me" as const;
