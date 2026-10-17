import {
  RELATIVE_DATE_TODAY,
  relativeDateOffset,
  resolveRelativeDate,
} from "@cubby/shared";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";

import type { EntityKernelContext } from "./adapter";
import {
  filterObjectSchema,
  resolveCurrentMemberFilters,
} from "./current-member-filter";

// A date bound accepts a relative date token but no other free text, so a
// probe only free text accepts tells it apart from a search or text filter
// that merely contains the literal "@today".
const TEXT_PROBE = `${RELATIVE_DATE_TODAY} text`;
const isDateBound = (field: z.ZodType) =>
  field.safeParse(RELATIVE_DATE_TODAY).success &&
  !field.safeParse(TEXT_PROBE).success;

/**
 * Replace every relative date token (`@today`, `@today-30d`) in parsed input
 * with the household-local date it names on `today`, wherever `schema`
 * places a date bound — top-level list filters or a nested `filters` object
 * (#2415). A saved view that pins `@today-1d` therefore reads a different
 * day tomorrow, and repositories only ever see calendar days.
 */
export function resolveRelativeDateFilters<T>(
  schema: z.ZodType,
  input: T,
  today: string = householdLocalDate(),
): T {
  if (!JSON.stringify(input ?? null).includes(`"${RELATIVE_DATE_TODAY}`))
    return input;
  const visit = <V>(fieldSchema: z.ZodType, value: V): V => {
    const objectSchema = filterObjectSchema(fieldSchema);
    if (
      objectSchema === undefined ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    )
      return value;
    // SAFETY: only date-bound values change, each from a token to the
    // calendar day it names, both members of the same field schema.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const field = objectSchema.shape[key];
        if (!(field instanceof z.ZodType)) return [key, item];
        if (
          typeof item === "string" &&
          relativeDateOffset(item) !== undefined &&
          isDateBound(field)
        )
          return [key, resolveRelativeDate(item, today)];
        return [key, visit(field, item)];
      }),
    ) as V;
  };
  return visit(schema, input);
}

/**
 * The entity kernel's filter tokens resolved before any repository runs:
 * `@me` (ADR 0018) and relative dates (#2415).
 */
export async function resolveFilterTokens<T>(
  context: Pick<EntityKernelContext, "db" | "actorContext">,
  schema: z.ZodType,
  input: T,
): Promise<T> {
  return resolveRelativeDateFilters(
    schema,
    await resolveCurrentMemberFilters(context, schema, input),
  );
}
