import { z } from "zod";

/**
 * How a RunStep knows its population. `count` freezes one COUNT over the
 * predicate its pager walks when the step starts (late arrivals belong to the
 * next pass; inputs that leave eligibility are tallied `removed`). `estimate`
 * is a provider's "about N". `tally` has no stored input set to count, so it
 * shows running counts without a bar, percentage or ETA.
 */
export const runStepInputMode = z.enum(["count", "estimate", "tally"]);
export type RunStepInputMode = z.infer<typeof runStepInputMode>;

/** Why a step has no countable stored input; a stored table always counts. */
type RunStepTallyReason =
  /** One bounded maintenance call, not a page over a population. */
  | "once"
  /** Admits work as it opens (image admission), so the set never closes. */
  | "admission";

export type RunStepDeclaration = {
  key: string;
  label: string;
  /** What the step is for, in one sentence a member reads. */
  purpose: string;
  /** The current action while it runs; a page may report a narrower one. */
  action: string;
  /** What one counted item is (`seeds`, `charges`, `evaluations`). */
  unit: string;
  input:
    | { mode: "count" }
    | { mode: "estimate" }
    | { mode: "tally"; reason: RunStepTallyReason };
  /** The Sweep family that includes this step; unset steps always run. */
  family?: string;
  /** Suggestions this step produced, as the declared Suggestions list filtered by Run and family. */
  results?: { family: string };
};

export type RunKindDeclaration = {
  label: string;
  description: string;
  /** Who starts it: a member, the scheduler, an agent, or system work. */
  trigger: "member" | "scheduled" | "agent" | "system";
  /** Scheduler passes that exist only when a pass wrote; hidden from the default Runs list. */
  routine?: true;
  /** No current code creates it; retained rows stay readable. */
  historical?: true;
  /**
   * What the universal `run.execute` Job runs: the RunStep ledger, the Run's
   * AI evaluations, or mailbox discovery. Absent: another owner executes it
   * (an agent, an import, an inline call).
   */
  execution?: "steps" | "ai_work" | "mail_discovery";
  /** AI work the Run owns directly (`AiEvaluation.runId`) or requested by reference. */
  aiWork?: "owned" | "requested";
  /** Where list and detail progress counts come from. */
  progress:
    | "targets"
    | "calls"
    | "operations"
    | "checkpoint"
    | "records"
    | "steps";
  /** Ordered RunSteps; each `(kind, step.key)` has exactly one server driver. */
  steps?: readonly RunStepDeclaration[];
};

const once = { mode: "tally", reason: "once" } as const;
const counted = { mode: "count" } as const;

/**
 * Every Run kind, declared once. The purpose enum, labels, list filters,
 * execution admission and RunStep ledgers derive from this table; the server
 * registry (`server/domains/run/service/run-step-registry.ts`) supplies one
 * driver per declared step and fails typecheck when one is missing.
 */
export const RUN_KINDS = {
  account_sync: {
    label: "Account sync",
    description: "A vendor account's order history sync.",
    trigger: "agent",
    historical: true,
    progress: "targets",
  },
  mail_import: {
    label: "Purchase research",
    description: "An agent researching purchases from Email and accounts.",
    trigger: "agent",
    progress: "targets",
  },
  purchase_validation: {
    label: "Purchase validation",
    description: "An agent validating imported purchases.",
    trigger: "agent",
    historical: true,
    progress: "targets",
  },
  product_enrichment: {
    label: "Product enrichment",
    description: "An agent enriching Product identity facts.",
    trigger: "agent",
    historical: true,
    progress: "targets",
  },
  photo_inventory: {
    label: "Photo inventory",
    description: "A batch of belongings photos turned into inventory.",
    trigger: "member",
    progress: "targets",
  },
  // Every AI call belongs to a run; these purposes group work that is not an
  // import. Their lifetime is set by `trigger` (`ephemeral` or not).
  ai_suggest: {
    label: "AI suggestions",
    description: "Decision-model suggestions requested while a member works.",
    trigger: "member",
    progress: "calls",
  },
  suggestion_sweep: {
    label: "Suggestion sweep",
    description: "Field suggestions for one entity's records.",
    trigger: "member",
    execution: "ai_work",
    aiWork: "requested",
    progress: "checkpoint",
  },
  ai_refresh: {
    label: "AI refresh",
    description: "AI evaluations whose inputs or policy changed.",
    trigger: "system",
    execution: "ai_work",
    aiWork: "owned",
    progress: "checkpoint",
  },
  background: {
    label: "Background",
    description: "Single background AI calls grouped for usage.",
    trigger: "system",
    progress: "operations",
  },
  file_import: {
    label: "File import",
    description: "A member's receipt, order Email or vendor export import.",
    trigger: "member",
    progress: "records",
  },
  mail_search: {
    label: "Mail search",
    description: "A Gmail search for purchase evidence.",
    trigger: "agent",
    historical: true,
    progress: "operations",
  },
  mail_discovery: {
    label: "Mail discovery",
    description: "One mailbox's pass over new purchase mail.",
    trigger: "scheduled",
    execution: "mail_discovery",
    progress: "checkpoint",
  },
  mail_reclassify: {
    label: "Email reclassification",
    description: "A member's reclassification of selected Emails.",
    trigger: "member",
    execution: "ai_work",
    aiWork: "requested",
    progress: "checkpoint",
  },
  connection_discovery: {
    label: "Connection discovery",
    description:
      "The routine pass that evaluates records whose connection inputs changed.",
    trigger: "scheduled",
    routine: true,
    execution: "ai_work",
    aiWork: "owned",
    progress: "checkpoint",
  },
  maintenance: {
    label: "Maintenance",
    description: "The nightly pass over household backlogs and upkeep.",
    trigger: "scheduled",
    execution: "steps",
    progress: "steps",
    steps: [
      {
        key: "image-repair",
        label: "Image processing repair",
        purpose: "Requeues image work that lost its executor.",
        action: "Repairing image work",
        unit: "images",
        input: once,
      },
      {
        key: "exif",
        label: "EXIF/GPS extraction",
        purpose: "Reads capture time and location from image originals.",
        action: "Extracting metadata",
        unit: "images",
        input: counted,
      },
      {
        key: "pending-uploads",
        label: "Abandoned uploads",
        purpose: "Removes uploads abandoned after presign.",
        action: "Removing abandoned uploads",
        unit: "uploads",
        input: counted,
      },
      {
        key: "photo-runs",
        label: "Photo Run advance",
        purpose: "Advances photo Runs waiting on finished image work.",
        action: "Advancing photo Runs",
        unit: "Runs",
        input: once,
      },
      {
        key: "coordinators",
        label: "Coordinator retirement",
        purpose: "Retires idle coordinators.",
        action: "Retiring coordinators",
        unit: "coordinators",
        input: once,
      },
      {
        key: "runs",
        label: "Stale and routine Runs",
        purpose: "Moves stale Runs to review and reconciles Run history.",
        action: "Reconciling Runs",
        unit: "Runs",
        input: once,
      },
      {
        key: "original-disposal",
        label: "Email original disposal",
        purpose: "Disposes stored Email originals that are no longer needed.",
        action: "Disposing originals",
        unit: "originals",
        input: once,
      },
      {
        key: "derived-refresh",
        label: "Derived work admission",
        purpose: "Admits a fresh pass of every derived refresh family.",
        action: "Admitting derived refresh",
        unit: "families",
        input: once,
      },
      {
        key: "calendar",
        label: "Calendar refresh",
        purpose: "Refreshes the household calendar feed.",
        action: "Refreshing the calendar",
        unit: "feeds",
        input: once,
      },
      {
        key: "mail-discovery",
        label: "Mail discovery",
        purpose: "Starts each connected mailbox's discovery Run.",
        action: "Starting mail discovery",
        unit: "mailboxes",
        input: once,
      },
      {
        key: "image-backfill",
        label: "Image work admission",
        purpose: "Admits paid image work for images that still need it.",
        action: "Admitting image work",
        unit: "images",
        input: { mode: "tally", reason: "admission" },
      },
    ],
  },
  derived_refresh: {
    label: "Derived refresh",
    description:
      "A routine pass that rebuilt derived data (search, totals, embeddings).",
    trigger: "scheduled",
    routine: true,
    progress: "steps",
    steps: [
      {
        key: "search",
        label: "Search documents",
        purpose: "Rebuilds search documents whose sources changed.",
        action: "Checking search sources",
        unit: "sources",
        // Sources span every searchable table; the live document count is
        // the cheap "about N" until the pass reaches its end.
        input: { mode: "estimate" },
        family: "search",
      },
      {
        key: "recipes",
        label: "Recipe totals",
        purpose: "Recomputes recipe nutrition and cost totals.",
        action: "Recomputing recipes",
        unit: "recipes",
        input: counted,
        family: "recipes",
      },
      {
        key: "conversions",
        label: "Unit conversions",
        purpose: "Rechecks Product unit-conversion coverage.",
        action: "Checking Products",
        unit: "products",
        input: counted,
        family: "conversions",
      },
      {
        key: "embeddings",
        label: "Embedding admission",
        purpose: "Admits embedding work for search documents without one.",
        action: "Admitting embeddings",
        unit: "documents",
        input: counted,
        family: "embeddings",
      },
      {
        key: "orphans",
        label: "Orphan cleanup",
        purpose: "Retires search documents and vectors whose source is gone.",
        action: "Checking search documents",
        unit: "documents",
        input: counted,
        family: "orphans",
      },
    ],
  },
  sweep: {
    label: "Sweep",
    description: "A pass that refreshes Suggestions for chosen families.",
    trigger: "member",
    execution: "steps",
    progress: "steps",
    // Statement evidence consumes the transfer family's descriptor labels, so
    // transfer steps come first.
    steps: [
      {
        key: "transfer_pair_scan",
        label: "Transfer pairs: scan",
        purpose:
          "Scans each candidate movement for matching legs and publishes pairs.",
        action: "Scanning movements",
        unit: "movements",
        input: counted,
        family: "transfer_pair",
        results: { family: "transfer_pair" },
      },
      {
        key: "transfer_pair_retire",
        label: "Transfer pairs: retire",
        purpose: "Retires pending pairs that are no longer candidates.",
        action: "Rechecking pending pairs",
        unit: "pairs",
        input: counted,
        family: "transfer_pair",
      },
      {
        key: "transfer_pair_label",
        label: "Transfer pairs: label",
        purpose: "Asks the decision model to label each pair's movement.",
        action: "Labelling pairs",
        unit: "pairs",
        input: counted,
        family: "transfer_pair",
        results: { family: "transfer_pair" },
      },
      {
        key: "statement_generate",
        label: "Statements: match",
        purpose: "Matches unmatched statement charges to ledger evidence.",
        action: "Matching charges",
        unit: "charges",
        input: counted,
        family: "statement_transaction",
        results: { family: "statement_transaction" },
      },
      {
        key: "statement_holds",
        label: "Statements: vanished holds",
        purpose: "Rechecks pending holds that disappeared from statements.",
        action: "Checking holds",
        unit: "holds",
        input: counted,
        family: "statement_transaction",
      },
      {
        key: "statement_label",
        label: "Statements: label",
        purpose: "Asks the decision model to label each statement Suggestion.",
        action: "Labelling suggestions",
        unit: "suggestions",
        input: counted,
        family: "statement_transaction",
        results: { family: "statement_transaction" },
      },
      {
        key: "connection_roster",
        label: "Connections: roster",
        purpose:
          "Queues an evaluation for each record whose connection inputs changed.",
        action: "Queueing records",
        unit: "records",
        input: counted,
        family: "recommendation",
      },
      {
        key: "connection_evaluate",
        label: "Connections: evaluate",
        purpose: "Evaluates each queued record for connections.",
        action: "Waiting for evaluations",
        unit: "evaluations",
        input: counted,
        family: "recommendation",
        results: { family: "recommendation" },
      },
      {
        key: "field_roster",
        label: "Fields: roster",
        purpose: "Queues an evaluation for each record's decision fields.",
        action: "Queueing fields",
        unit: "entities",
        input: counted,
        family: "field",
      },
      {
        key: "field_evaluate",
        label: "Fields: evaluate",
        purpose: "Evaluates each queued field for a Suggestion.",
        action: "Waiting for evaluations",
        unit: "evaluations",
        input: counted,
        family: "field",
        results: { family: "field" },
      },
    ],
  },
} as const satisfies Record<string, RunKindDeclaration>;

type RunKinds = typeof RUN_KINDS;
export type RunPurpose = keyof RunKinds;
// SAFETY: `Object.keys` of the literal manifest is exactly its non-empty key set.
const purposes = Object.keys(RUN_KINDS) as [RunPurpose, ...RunPurpose[]];

// Generator inputs and runtime schemas share this cycle-safe vocabulary.
export const runPurpose = z.enum(purposes);

const purposesWhere = <P extends RunPurpose>(
  test: (kind: RunKindDeclaration) => boolean,
) =>
  // SAFETY: each caller's `P` names exactly the kinds its `test` admits.
  purposes.filter((purpose) => test(RUN_KINDS[purpose])) as P[];

/** Kinds whose `run.execute` Job pages an ordered RunStep ledger. */
export type StepRunPurpose = {
  [P in RunPurpose]: RunKinds[P] extends { steps: readonly unknown[] }
    ? P
    : never;
}[RunPurpose];
export const STEP_RUN_PURPOSES = purposesWhere<StepRunPurpose>((kind) =>
  Boolean(kind.steps),
);
export const isStepRunPurpose = (
  purpose: RunPurpose | string,
): purpose is StepRunPurpose =>
  STEP_RUN_PURPOSES.some((candidate) => candidate === purpose);

/** The step keys a kind declares, for the server's per-step drivers. */
export type RunStepKey<P extends StepRunPurpose> =
  RunKinds[P]["steps"][number]["key"];
export type RunStepDeclarationOf<P extends StepRunPurpose> =
  RunKinds[P]["steps"][number];

/** Kinds the universal `run.execute` Job executes. */
export type ExecutedRunPurpose = {
  [P in RunPurpose]: RunKinds[P] extends { execution: string } ? P : never;
}[RunPurpose];
export const EXECUTED_RUN_PURPOSES = purposesWhere<ExecutedRunPurpose>((kind) =>
  Boolean(kind.execution),
);
export const isExecutedRunPurpose = (
  purpose: RunPurpose | string,
): purpose is ExecutedRunPurpose =>
  EXECUTED_RUN_PURPOSES.some((candidate) => candidate === purpose);

/** Routine kinds the default Runs list hides; clearing the filter shows them. */
export const ROUTINE_RUN_PURPOSES = purposesWhere((kind) =>
  Boolean(kind.routine),
);
export const VISIBLE_RUN_PURPOSES = purposesWhere((kind) => !kind.routine);

/** Kinds whose AI evaluations name the Run as their owner (`AiEvaluation.runId`). */
export const OWNED_AI_WORK_PURPOSES = purposesWhere(
  (kind) => kind.aiWork === "owned",
);

export const runStepDeclaration = (
  purpose: RunPurpose | string,
  key: string,
): RunStepDeclaration | undefined =>
  isStepRunPurpose(purpose)
    ? // SAFETY: every manifest step satisfies `RunStepDeclaration`; widening drops only literal keys.
      (RUN_KINDS[purpose].steps as readonly RunStepDeclaration[]).find(
        (step) => step.key === key,
      )
    : undefined;

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
// SAFETY: one entry per manifest purpose, each its own declared label.
export const RUN_PURPOSE_LABEL = Object.fromEntries(
  purposes.map((purpose) => [purpose, RUN_KINDS[purpose].label]),
) as { [P in RunPurpose]: RunKinds[P]["label"] };

/** The Runs list's name for each kind of work, for rows and the kind filter. */
export const ACTIVITY_KIND_LABEL = {
  ...RUN_PURPOSE_LABEL,
  subject_lift: "Subject lift",
  describe_image: "Image description",
  identify_image: "Image identification",
} as const satisfies Record<ActivityKind, string>;

export const runTargetState = z.enum([
  "pending",
  "prepared",
  "completed",
  "skipped",
  "unresolved",
  "needs_evidence",
  "unavailable",
]);
export type RunTargetState = z.infer<typeof runTargetState>;
