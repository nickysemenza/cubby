import type { SuggestionListFamily } from "@cubby/schemas/suggestion-list";
import type { SQL } from "drizzle-orm";
import type { z } from "zod";

import type { recommendationScopes } from "~/server/generic/suggestions/repo/pending-admission";
import type { SuggestionFamilyPresentation } from "~/server/generic/suggestions/repo/suggestion-presentation";
import { declareAffectedRecords } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

import type { Handler } from "./review";
export interface SuggestionFamilyDeclaration<F extends SuggestionListFamily>
  extends SuggestionFamilyPresentation<F>, Handler {
  family: F;
  kind: "proposal" | "automatic_decision";
  label: string;
  affectedRecords: Omit<Parameters<typeof declareAffectedRecords>[0], "graph"> &
    (F extends "statement_transaction"
      ? Pick<Parameters<typeof declareAffectedRecords>[0], "graph">
      : { graph?: never });
  actionable: SQL;
  scopes?: typeof recommendationScopes;
  summarize?: (value: z.infer<ReturnType<typeof z.json>>) => string;
}
