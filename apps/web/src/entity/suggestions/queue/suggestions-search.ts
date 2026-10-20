import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { suggestionListFamily } from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

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
export const suggestionsSearchSchema = z.object({
  family: suggestionListFamily.optional().catch(undefined),
  /**
   * The page tab: absent lists pending Suggestions; `rules` configures rules.
   * Legacy `applied_automatically` URLs redirect to the automatic-decision audit.
   */
  status: z
    .enum(["applied_automatically", "rules"])
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
  strength: filterParam,
  clean: filterParam,
  entity: filterParam,
  field: filterParam,
  kind: filterParam,
  confidence: filterParam,
  date: filterParam,
  account: filterParam,
  owner: filterParam,
  merchant: filterParam,
  amount: filterParam,
  action: filterParam,
  kindSource: filterParam,
  providerCategory: filterParam,
  providerStatus: filterParam,
  candidate: filterParam,
  modelLabel: filterParam,
  relation: filterParam,
  entityKind: filterParam,
});
export type SuggestionsSearch = z.output<typeof suggestionsSearchSchema>;
