import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import type { SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { declareAffectedRecords } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

/** Transfer reviews live on transferPair scopes and expose their identity actions through Needs you. */
export const transferPairSuggestions: SuggestionFamilyDeclaration<"transfer_pair"> =
  {
    family: "transfer_pair",
    ...suggestionReviewFamilies.transfer_pair,
    keys: async () => [],
    rows: async () => new Map(),
    outcomes: async () => ({
      applied: 0,
      rejected: 0,
      superseded: 0,
      resolved: 0,
      fields: [],
    }),
    acceptAsIs: () => null,
    ...declareAffectedRecords({
      roles: ["outflow", "inflow"],
      forward: () => sql`'[]'::jsonb`,
      references: [],
    }),
    actionable: sql`false`,
  };
