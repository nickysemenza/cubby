import type { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import type {
  SuggestionListRow,
  SuggestionListFamily,
} from "@cubby/schemas/suggestion-list";
import type { SQL } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import type { recommendationScopes } from "~/server/generic/suggestions/repo/pending-admission";
import type { SuggestionFamilyPresentation } from "~/server/generic/suggestions/repo/suggestion-presentation";
import type { AffectedRecordsSpec } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

import type { Handler, Review } from "./review";
import type { Prediction } from "./review-plan";

export interface SuggestionFamilyDeclaration<F extends SuggestionListFamily>
  extends SuggestionFamilyPresentation<F>, Omit<Handler, "apply"> {
  apply?: Handler["apply"];
  family: F;
  applicationKind?: NonNullable<Review["application"]>["kind"];
  applicationError?: string;
  supportsDraft?: boolean;
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

  kind: "proposal" | "automatic_decision";
  label: string;
  affectedRecords: AffectedRecordsSpec;
  actionable: SQL;
  scopes?: typeof recommendationScopes;
  summarize?: (value: z.infer<ReturnType<typeof z.json>>) => string;
}
