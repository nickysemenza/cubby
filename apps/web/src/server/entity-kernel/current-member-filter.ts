import {
  CURRENT_MEMBER_FILTER,
  UNRESOLVABLE_ENTITY_FILTER,
} from "@cubby/shared";
import { z } from "zod";

import { currentMemberLedgerParty } from "~/server/repo/current-member-party";

import type { EntityKernelContext } from "./adapter";

const mentionsCurrentMember = (value: unknown) =>
  value === CURRENT_MEMBER_FILTER ||
  (Array.isArray(value) && value.includes(CURRENT_MEMBER_FILTER));

// A Ledger Party filter accepts `@me` but no other free text, so a probe only
// free text accepts tells it apart from a search or text filter that merely
// contains the literal "@me".
const TEXT_PROBE = `${CURRENT_MEMBER_FILTER} text`;
const isPartyFilter = (schema: z.ZodType, key: string) => {
  const field = schema instanceof z.ZodObject ? schema.shape[key] : undefined;
  return (
    field instanceof z.ZodType &&
    field.safeParse([CURRENT_MEMBER_FILTER]).success &&
    !field.safeParse(TEXT_PROBE).success
  );
};

/**
 * Replace `@me` in parsed list filters with the actor's member shortcode.
 *
 * Only fields `schema` declares as Ledger Party filters are rewritten; a
 * search for the text "@me" stays text. An actor with no linked member
 * resolves to `UNRESOLVABLE_ENTITY_FILTER`, which matches nothing: dropping
 * the value would widen "my stuff" into everyone's.
 */
export async function resolveCurrentMemberFilters<T>(
  context: Pick<EntityKernelContext, "db" | "actorContext">,
  schema: z.ZodType,
  filters: T,
): Promise<T> {
  if (typeof filters !== "object" || filters === null) return filters;
  const partyKeys = new Set(
    Object.entries(filters).flatMap(([key, value]) =>
      mentionsCurrentMember(value) && isPartyFilter(schema, key) ? [key] : [],
    ),
  );
  if (partyKeys.size === 0) return filters;
  const member = await currentMemberLedgerParty(
    context.db,
    context.actorContext,
  );
  const code = member?.shortcode ?? UNRESOLVABLE_ENTITY_FILTER;
  const swap = (value: unknown) =>
    value === CURRENT_MEMBER_FILTER ? code : value;
  // SAFETY: only party-filter values change, each from `@me` to a shortcode
  // or the unresolvable sentinel, both members of the same filter schema.
  return Object.fromEntries(
    Object.entries(filters).map(([key, value]) => [
      key,
      !partyKeys.has(key)
        ? value
        : Array.isArray(value)
          ? value.map(swap)
          : swap(value),
    ]),
  ) as T;
}
