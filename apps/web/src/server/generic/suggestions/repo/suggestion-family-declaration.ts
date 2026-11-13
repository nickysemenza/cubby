import type { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import type {
  SuggestionListRow,
  SuggestionListFamily,
} from "@cubby/schemas/suggestion-list";
import type { SQL } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import type { AutomaticRuleMatch } from "~/server/generic/suggestions/repo/automatic-policy";
import type { recommendationScopes } from "~/server/generic/suggestions/repo/pending-admission";
import type { SuggestionFamilyPresentation } from "~/server/generic/suggestions/repo/suggestion-presentation";
import type { AffectedRecordsSpec } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

import type { Handler, Review } from "./review";
import type { Prediction } from "./review-plan";

type AutomaticCandidate = {
  id: string;
  entity: string;
  field: string;
  kind: string;
  confidence: number;
  model: string;
  judgment: unknown;
};

export interface SuggestionFamilyDeclaration<F extends SuggestionListFamily>
  extends SuggestionFamilyPresentation<F>, Handler {
  family: F;
  applicationKind?: NonNullable<Review["application"]>["kind"];
  applicationError?: string;
  supportsDraft?: boolean;
  fieldHistory?: boolean;
  financial?: boolean;
  suppressionKey?: (subject: Extract<Prediction["subject"], { kind: F }>) => {
    scope: string;
    candidateKey: string;
    error: string;
  };
  validateCorrection?: (input: Review) => void;
  pairKey?: (row: Extract<SuggestionListRow, { family: F }>) => string | null;
  afterApply?: (
    db: Database,
    prediction: Prediction,
    input: Review,
    authority: "automatic" | "member",
  ) => Promise<z.infer<typeof suggestionAcceptanceReceipt> | null>;
  automatic?: {
    match: (row: AutomaticCandidate) => AutomaticRuleMatch[];
    requiresStamp: boolean;
    application?: (row: AutomaticCandidate) => Review["application"];
  };
  kind: "proposal" | "automatic_decision";
  label: string;
  affectedRecords: Omit<AffectedRecordsSpec, "graph"> &
    (F extends "statement_transaction"
      ? Pick<AffectedRecordsSpec, "graph">
      : { graph?: never });
  actionable: SQL;
  scopes?: typeof recommendationScopes;
  summarize?: (value: z.infer<ReturnType<typeof z.json>>) => string;
}
