import { z } from "zod";

// Generator inputs and runtime schemas share this cycle-safe vocabulary.
export const runPurpose = z.enum([
  "account_sync",
  "mail_import",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
  // Every AI call belongs to a run; these purposes group work that is not an
  // import. Their lifetime is set by `trigger` (`ephemeral` or not).
  "ai_suggest",
  "suggestion_sweep",
  "ai_refresh",
  "background",
  "file_import",
  "mail_search",
  "mail_discovery",
  "mail_reclassify",
]);
export type RunPurpose = z.infer<typeof runPurpose>;

/** Report presentation only; agent execution and discovery purposes are separate capabilities. */
export const IMPORT_REPORT_RUN_PURPOSES = [
  "account_sync",
  "mail_import",
  "purchase_validation",
  "product_enrichment",
  "file_import",
] as const satisfies readonly RunPurpose[];
const importReportPurposes: ReadonlySet<RunPurpose> = new Set(
  IMPORT_REPORT_RUN_PURPOSES,
);
export const hasImportRunReports = (purpose: RunPurpose): boolean =>
  importReportPurposes.has(purpose);

export const imageProcessingJobKind = z.enum([
  "subject_lift",
  "describe_image",
  "identify_image",
]);
export type ImageProcessingJobKind = z.infer<typeof imageProcessingJobKind>;

export const imageProcessingJobState = z.enum([
  "pending",
  "waiting_for_device",
  "leased",
  "ready",
  "skipped",
  "failed",
]);
export type ImageProcessingJobState = z.infer<typeof imageProcessingJobState>;

export const activityKind = z.enum([
  ...runPurpose.options,
  ...imageProcessingJobKind.options,
]);
export type ActivityKind = z.infer<typeof activityKind>;

/** The label of each run purpose; `runWorkLabel` names one run's actual work. */
export const RUN_PURPOSE_LABEL = {
  account_sync: "Account sync",
  mail_import: "Purchase research",
  purchase_validation: "Purchase validation",
  product_enrichment: "Product enrichment",
  photo_inventory: "Photo inventory",
  ai_suggest: "AI suggestions",
  suggestion_sweep: "Suggestion sweep",
  background: "Background",
  ai_refresh: "AI refresh",
  file_import: "File import",
  mail_search: "Mail search",
  mail_discovery: "Mail discovery",
  mail_reclassify: "Email reclassification",
} as const satisfies Record<RunPurpose, string>;

/** The Runs list's name for each kind of work, for rows and the kind filter. */
export const ACTIVITY_KIND_LABEL = {
  ...RUN_PURPOSE_LABEL,
  subject_lift: "Subject lift",
  describe_image: "Image description",
  identify_image: "Image identification",
} as const satisfies Record<ActivityKind, string>;
