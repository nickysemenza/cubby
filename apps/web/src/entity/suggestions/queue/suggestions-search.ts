import { assessmentFamily } from "@cubby/schemas/assessment";
import { shortcodeEntities } from "@cubby/schemas/entity-roster";
import { suggestionListFamily } from "@cubby/schemas/suggestion-list";
import {
  suggestionFilterDeclaration,
  type SuggestionFilterSearchKey,
} from "@cubby/schemas/suggestion-list-declarations";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import { compileFilterCodec } from "~/entity/filters";

// Kept apart from the page: the route's `validateSearch` loads eagerly with
// the router, so this module must not import the table.

const shortcodeEntity = z.enum(shortcodeEntities);
const filterParam = z.string().max(1000).optional().catch(undefined);

/** `<entityKind>:<SHORTCODE>` as its parts, or null when malformed. */
export function parseRecordParam(value: string | undefined) {
  const [kind, code] = value?.split(":") ?? [];
  const entity = shortcodeEntity.safeParse(kind).data;
  return entity && code && parseShortcode(code) ? { entity, code } : null;
}

/** The route's search params; table filters ride beside them as their column ids. */
const scopeSearchSchema = z.object({
  family: suggestionListFamily.optional().catch(undefined),
  auditFamily: assessmentFamily.optional().catch(undefined),
  /**
   * The page tab: absent lists pending work; history and rules share its scope.
   * Legacy `applied_automatically` URLs redirect to the automatic tab.
   */
  status: z
    .enum(["applied_automatically", "automatic", "rules"])
    .optional()
    .catch(undefined),
  /** `<entityKind>:<SHORTCODE>`; a connection matches either endpoint. */
  record: z
    .string()
    .max(200)
    .refine((value) => parseRecordParam(value) !== null)
    .optional()
    .catch(undefined),
  runId: z.string().max(40).optional().catch(undefined),
  /** The Sweep this page started, followed in the status line. */
  sweep: z.string().max(40).optional().catch(undefined),
  group: z.literal("account_month").optional().catch(undefined),
  sort: z.string().max(500).optional().catch(undefined),
});
// SAFETY: the codec walks the same declared columns and generated Exclude
// fields as SuggestionFilterSearchKey; every URL value is optional text.
const filterSearchFields = Object.fromEntries(
  compileFilterCodec(suggestionFilterDeclaration.specs).keys.map((key) => [
    key,
    filterParam,
  ]),
) as Record<SuggestionFilterSearchKey, typeof filterParam>;

export const suggestionsSearchSchema = z.object({
  ...filterSearchFields,
  ...scopeSearchSchema.shape,
});
export type SuggestionsSearch = z.output<typeof suggestionsSearchSchema>;
