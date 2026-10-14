import {
  CURRENT_MEMBER_FILTER,
  UNRESOLVABLE_ENTITY_FILTER,
} from "@cubby/shared";

import { currentMemberLedgerParty } from "~/server/repo/current-member-party";

import type { EntityKernelContext } from "./adapter";

const mentionsCurrentMember = (value: unknown) =>
  value === CURRENT_MEMBER_FILTER ||
  (Array.isArray(value) && value.includes(CURRENT_MEMBER_FILTER));

/**
 * Replace `@me` in parsed list filters with the actor's member shortcode.
 *
 * Only Ledger Party filter schemas accept the token, so any top-level value
 * carrying it is one. An actor with no linked member resolves to
 * `UNRESOLVABLE_ENTITY_FILTER`, which matches nothing: dropping the value
 * would widen "my stuff" into everyone's.
 */
export async function resolveCurrentMemberFilters<T>(
  context: Pick<EntityKernelContext, "db" | "actorContext">,
  filters: T,
): Promise<T> {
  if (
    typeof filters !== "object" ||
    filters === null ||
    !Object.values(filters).some(mentionsCurrentMember)
  )
    return filters;
  const member = await currentMemberLedgerParty(
    context.db,
    context.actorContext,
  );
  const code = member?.shortcode ?? UNRESOLVABLE_ENTITY_FILTER;
  const swap = (value: unknown) =>
    value === CURRENT_MEMBER_FILTER ? code : value;
  // SAFETY: only top-level values change, each from `@me` to a shortcode or
  // the unresolvable sentinel, both valid members of the same filter schemas.
  return Object.fromEntries(
    Object.entries(filters).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(swap) : swap(value),
    ]),
  ) as T;
}
