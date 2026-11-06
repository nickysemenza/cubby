import type { SuggestionListFamily } from "@cubby/schemas/suggestion-list";
import type { SQL } from "drizzle-orm";
import type { z } from "zod";

import { declareAffectedRecords } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

import type { recommendationScopes } from "./pending-admission";
import type { Handler } from "./review";
import type { SuggestionFamilyPresentation } from "./suggestion-presentation";
export interface SuggestionFamilyDeclaration<F extends SuggestionListFamily>
  extends SuggestionFamilyPresentation<F>, Handler {
  family: F;
  kind: "proposal" | "automatic_decision";
  label: string;
  affectedRecords: Parameters<typeof declareAffectedRecords>[0];
  actionable: SQL;
  scopes?: typeof recommendationScopes;
  summarize?: (value: z.infer<ReturnType<typeof z.json>>) => string;
}
