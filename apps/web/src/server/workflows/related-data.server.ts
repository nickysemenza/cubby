import {
  relatedBranchInput,
  relatedBranchOutput,
  relatedOptionsInput,
  relatedOptionsOutput,
  relatedPreviewInput,
  relatedPreviewOutput,
  relatedSummaryInput,
  relatedSummaryOutput,
} from "@cubby/schemas/related-view";
import type { z } from "zod";
import type { Database } from "~/server/db";
import {
  loadRelatedBranch,
  loadRelatedOptions,
  loadRelatedPreviews,
  loadRelatedSummary,
} from "~/server/repo/related-view";

export const relatedDataWorkflowSchemas = {
  previews: { input: relatedPreviewInput, output: relatedPreviewOutput },
  branch: { input: relatedBranchInput, output: relatedBranchOutput },
  options: { input: relatedOptionsInput, output: relatedOptionsOutput },
  summary: { input: relatedSummaryInput, output: relatedSummaryOutput },
} as const;

export const loadRelatedPreviewsWorkflow = (
  db: Database,
  input: z.output<typeof relatedPreviewInput>,
) => loadRelatedPreviews(db, input);
export const loadRelatedBranchWorkflow = (
  db: Database,
  input: z.output<typeof relatedBranchInput>,
) => loadRelatedBranch(db, input);
export const loadRelatedOptionsWorkflow = (
  db: Database,
  input: z.output<typeof relatedOptionsInput>,
) => loadRelatedOptions(db, input);
export const loadRelatedSummaryWorkflow = (
  db: Database,
  input: z.output<typeof relatedSummaryInput>,
) => loadRelatedSummary(db, input);
