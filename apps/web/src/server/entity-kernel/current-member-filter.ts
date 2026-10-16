import { repositoryCurrentMember } from "@cubby/schemas/pagination";
import {
  CURRENT_MEMBER_FILTER,
  UNRESOLVABLE_ENTITY_FILTER,
} from "@cubby/shared";
import { z } from "zod";

import { currentMemberLedgerParty } from "~/server/domains/ledger-party/repo/current-member-party";

import type { EntityKernelContext } from "./adapter";

const mentionsCurrentMember = (value: unknown) =>
  value === CURRENT_MEMBER_FILTER ||
  (Array.isArray(value) && value.includes(CURRENT_MEMBER_FILTER));

// A Ledger Party filter accepts `@me` but no other free text, so a probe only
// free text accepts tells it apart from a search or text filter that merely
// contains the literal "@me".
const TEXT_PROBE = `${CURRENT_MEMBER_FILTER} text`;
const isPartyFilter = (field: z.ZodType) =>
  field.safeParse([CURRENT_MEMBER_FILTER]).success &&
  !field.safeParse(TEXT_PROBE).success;

/** The object schema under optional/nullable/default/catch wrappers, if any. */
const filterObjectSchema = (schema: z.ZodType): z.ZodObject | undefined => {
  if (schema instanceof z.ZodObject) return schema;
  const inner: unknown =
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch
      ? schema.unwrap()
      : undefined;
  return inner instanceof z.ZodType ? filterObjectSchema(inner) : undefined;
};

/**
 * Replace `@me` in parsed input with the actor's member shortcode, wherever
 * `schema` places a Ledger Party filter — top-level list filters or a nested
 * `filters` object. A search for the text "@me" stays text. An actor with no
 * linked member resolves to `UNRESOLVABLE_ENTITY_FILTER`, which matches
 * nothing: dropping the value would widen "my stuff" into everyone's.
 */
export async function resolveCurrentMemberFilters<T>(
  context: Pick<EntityKernelContext, "db" | "actorContext">,
  schema: z.ZodType,
  input: T,
): Promise<T> {
  if (!JSON.stringify(input ?? null).includes(`"${CURRENT_MEMBER_FILTER}"`))
    return input;
  let code: string | undefined;
  const member = async () => {
    code ??=
      (await currentMemberLedgerParty(context.db, context.actorContext))
        ?.shortcode ?? UNRESOLVABLE_ENTITY_FILTER;
    return code;
  };
  const visit = async <V>(fieldSchema: z.ZodType, value: V): Promise<V> => {
    const objectSchema = filterObjectSchema(fieldSchema);
    if (
      objectSchema === undefined ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    )
      return value;
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => {
        const field = objectSchema.shape[key];
        if (!(field instanceof z.ZodType)) return [key, item] as const;
        if (
          mentionsCurrentMember(item) &&
          isPartyFilter(field) &&
          !repositoryCurrentMember.has(field)
        ) {
          const resolved = await member();
          const swap = (entry: unknown) =>
            entry === CURRENT_MEMBER_FILTER ? resolved : entry;
          return [
            key,
            Array.isArray(item) ? item.map(swap) : swap(item),
          ] as const;
        }
        return [key, await visit(field, item)] as const;
      }),
    );
    // SAFETY: only party-filter values change, each from `@me` to a shortcode
    // or the unresolvable sentinel, both members of the same field schema.
    return Object.fromEntries(entries) as V;
  };
  return visit(schema, input);
}
