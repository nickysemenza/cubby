import type { ActorContext } from "@cubby/schemas/context";
import type {
  EmailAccuracyReport,
  EmailAccuracyBinaryMetrics,
} from "@cubby/schemas/email-accuracy";
import type {
  ReportBlock,
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import {
  parseShortcodeFor,
  runEntityId,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  MAILBOX_CLASSIFICATION_LABEL,
  mailboxClassification,
} from "@cubby/schemas/mailbox-research";
import { mailResearchRunInput, runWorkLabel } from "@cubby/schemas/run-fields";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";

import { formatPercent, formatSmallCurrency } from "~/lib/number-format";
import type { Database } from "~/server/db";
import {
  aiUsage,
  emailCandidateObservation,
  emailClassificationObservation,
  emailClassificationLabel,
  emailAccuracyEvaluation,
  emailRetrievalFailure,
  ledgerParty,
  email as emailTable,
  orderMail,
  run,
} from "~/server/db/schema";
import { hasRetainedEmailImportContent } from "~/server/purchase-import/email-content";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { readEmailAssociations } from "~/server/repo/email";
import { getEmailAccuracyReport } from "~/server/repo/email-accuracy";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import type { ReportViewer } from "./records";

type StatsBlock = Extract<ReportBlock, { kind: "stats" }>;

/**
 * One count per association, then a ledger for each non-empty one; an empty association is only
 * its zero. Thread context and dismissed candidates never associate a Purchase.
 */
function emailAssociationBlocks(
  associations: Awaited<ReturnType<typeof readEmailAssociations>>,
): ReportBlock[] {
  const purchases = (rows: typeof associations.purchases) =>
    rows.map((row) => ({
      entity: "purchase",
      id: row.shortcode,
      title: row.orderId ?? "Purchase",
      subtitle: row.date,
      trailing: null,
    }));
  const emails = (rows: typeof associations.samePurchaseEmails) =>
    rows.map((row): ReportRecordRow => ({
      entity: "email",
      id: row.shortcode,
      title: row.subject ?? "Email",
      subtitle: row.sender,
      trailing: null,
      at: row.receivedAt?.toISOString(),
    }));
  const sets: [label: string, title: string, rows: ReportRecordRow[]][] = [
    [
      "Accepted Purchases",
      "Accepted Purchases",
      purchases(associations.purchases),
    ],
    [
      "Expenses",
      "Purchase Expenses",
      associations.expenses.map((row) => ({
        entity: "expense",
        id: row.shortcode,
        title: row.name,
        subtitle: null,
        trailing: null,
      })),
    ],
    [
      "Products",
      "Purchase Products",
      associations.products.map((row) => ({
        entity: "product",
        id: row.shortcode,
        title: row.name,
        subtitle: null,
        trailing: null,
      })),
    ],
    [
      "Same-Purchase Emails",
      "Emails for the same Purchases",
      emails(associations.samePurchaseEmails),
    ],
    [
      "Gmail thread",
      "Gmail thread context",
      emails(associations.threadEmails).map((row) => ({
        ...row,
        statuses: [{ label: "Thread context only", tone: "muted" }],
      })),
    ],
    [
      "Dismissed candidates",
      "Dismissed Purchase candidates",
      purchases(associations.dismissedCandidates).map((row) => ({
        ...row,
        statuses: [{ label: "Dismissed candidate", tone: "muted" }],
      })),
    ],
  ];
  return [
    {
      kind: "stats",
      title: "Associations",
      figures: sets.map(([label, , rows]) => ({
        label,
        value: rows.length,
        format: "count",
        tone: rows.length ? undefined : ("muted" as const),
      })),
    },
    ...sets.map(([, title, rows]): ReportBlock => ({
      kind: "records",
      presentation: "ledger",
      title,
      rows,
      empty: "",
    })),
  ];
}

function accuracyMetricsBlock(
  metrics: EmailAccuracyBinaryMetrics,
  basis: "pipeline" | "model-only",
): StatsBlock {
  const prefix = `email-accuracy-${basis}`;
  const countFigure = (
    suffix: string,
    label: string,
    value: number,
  ): StatsBlock["figures"][number] => ({
    id: `${prefix}-${suffix}`,
    label,
    value,
    format: "count",
  });
  const ratioFigure = (
    suffix: string,
    label: string,
    value: number | null,
  ): StatsBlock["figures"][number] => ({
    id: `${prefix}-${suffix}`,
    label,
    value,
    format: "text",
    text:
      value === null
        ? "Unknown: zero determinate denominator"
        : formatPercent(value, { maximumFractionDigits: 2 }),
  });
  return {
    kind: "stats",
    title:
      basis === "pipeline"
        ? "Pipeline weighted accuracy"
        : "Exact-known Jev/Clef model-only weighted accuracy",
    figures: [
      countFigure(
        "binary-pairs",
        "Determinate binary sample pairs",
        metrics.binaryPairCount,
      ),
      countFigure(
        "weighted-population",
        "Estimated determinate binary population",
        metrics.estimatedBinaryPopulation,
      ),
      countFigure(
        "tp",
        "Weighted true positives",
        metrics.confusionMatrix.truePositive,
      ),
      countFigure(
        "fp",
        "Weighted false positives",
        metrics.confusionMatrix.falsePositive,
      ),
      countFigure(
        "fn",
        "Weighted false negatives",
        metrics.confusionMatrix.falseNegative,
      ),
      countFigure(
        "tn",
        "Weighted true negatives",
        metrics.confusionMatrix.trueNegative,
      ),
      ratioFigure(
        "precision",
        "Conditional related precision",
        metrics.precisionRelated,
      ),
      ratioFigure(
        "recall",
        "Conditional related recall",
        metrics.recallRelated,
      ),
    ],
  };
}

/** Generic blocks for the authenticated accuracy read model; never used by blind reads. */
function emailAccuracyReviewBlocks(report: EmailAccuracyReport): ReportBlock[] {
  const countFigure = (
    suffix: string,
    label: string,
    value: number | null,
  ): StatsBlock["figures"][number] => ({
    id: `email-accuracy-${suffix}`,
    label,
    value,
    format: "count",
  });
  return [
    {
      kind: "note",
      text: `Latest member-wide evaluation, sampled ${report.createdAt}. The population covers this member's owned Emails, not only this Email. Predictions, roster and independent grades are frozen; newer classifications do not rewrite this measurement.`,
    },
    {
      kind: "stats",
      title: "Accuracy sample and exclusions",
      figures: [
        countFigure(
          "member-emails",
          "Owned member Emails at sampling",
          report.memberEmailCount,
        ),
        countFigure(
          "unpredicted-emails",
          "Owned Emails without a prediction",
          report.unpredictedEmailCount,
        ),
        countFigure(
          "unknown-stage",
          "Decision stage unknown",
          report.counts.unknownStage,
        ),
        countFigure(
          "population",
          "Predicted population Emails",
          report.populationCount,
        ),
        countFigure("sample", "Sampled Emails", report.sampleSize),
        countFigure("graded", "Graded", report.counts.graded),
        countFigure("ungraded", "Ungraded", report.counts.ungraded),
        countFigure(
          "unknown-model",
          "Model unknown",
          report.counts.unknownModel,
        ),
        countFigure(
          "named-other-model",
          "Other known models",
          report.counts.knownOtherModel,
        ),
        countFigure(
          "unavailable",
          "Unavailable originals",
          report.counts.unavailable,
        ),
        countFigure(
          "uncertain-grade",
          "Uncertain reviews",
          report.counts.uncertainGrade,
        ),
        countFigure(
          "uncertain-prediction",
          "Uncertain predictions",
          report.counts.uncertainPrediction,
        ),
        countFigure(
          "historical-unknown",
          "Historical metadata unknown",
          report.counts.historicalMetadataUnknown,
        ),
        countFigure(
          "missing-email",
          "Missing Emails",
          report.counts.missingEmail,
        ),
        countFigure(
          "ownership-changed",
          "Ownership changed",
          report.counts.ownershipChanged,
        ),
      ],
    },
    accuracyMetricsBlock(report.pipeline, "pipeline"),
    accuracyMetricsBlock(report.modelOnly, "model-only"),
    {
      kind: "table",
      title: "Accuracy strata",
      columns: [
        "Stage",
        "Predicted relevance",
        "Model",
        "Population N",
        "Sample n",
        "Inclusion probability",
        "Weight",
        "Graded",
        "Binary pairs",
      ],
      rows: report.strata.map((item) => ({
        id: item.id,
        cells: [
          item.stage ?? "Unknown",
          item.classification,
          item.model ?? "Unknown",
          String(item.populationCount),
          String(item.sampleCount),
          String(item.inclusionProbability),
          String(item.weight),
          String(item.gradedCount),
          String(item.binaryPairCount),
        ],
      })),
      empty: "No eligible predictions in this frozen population.",
    },
    {
      kind: "table",
      title: "Accuracy stage coverage",
      columns: ["Stage", "Population N", "Sample n", "Graded"],
      rows: report.byStage.map((item) => ({
        id: JSON.stringify(item.stage),
        cells: [
          item.stage ?? "Unknown",
          String(item.populationCount),
          String(item.sampleCount),
          String(item.gradedCount),
        ],
      })),
    },
    {
      kind: "table",
      title: "Accuracy model coverage",
      columns: ["Model", "Population N", "Sample n", "Graded"],
      rows: report.byModel.map((item) => ({
        id: JSON.stringify(item.model),
        cells: [
          item.model ?? "Unknown",
          String(item.populationCount),
          String(item.sampleCount),
          String(item.gradedCount),
        ],
      })),
    },
    ...report.warnings.map((text): ReportBlock => ({ kind: "note", text })),
  ];
}

type Observation = typeof emailClassificationObservation.$inferSelect;
type PipelineState = "Ran" | "Skipped" | "Not reached" | "Failed";
const stateTone = {
  Ran: "positive",
  Skipped: "muted",
  "Not reached": "muted",
  Failed: "destructive",
} as const;
const automatedStages = ["rule", "jev", "model"] as const;
const stageStep = {
  rule: "Rule",
  jev: "Jev",
  model: "Relevance model",
} as const satisfies Record<(typeof automatedStages)[number], string>;

const conflictText = (conflict: Observation["conflict"]) =>
  conflict?.kind === "member_review"
    ? `Disagrees with member: ${conflict.memberClassification}`
    : conflict?.kind === "accepted_unrelated"
      ? "Unrelated despite an accepted Purchase"
      : "";

function pipelineRow(
  step: string,
  state: PipelineState,
  input: {
    lines?: (string | null | undefined)[];
    at?: Date | null;
    conflict?: Observation["conflict"];
    entity?: string;
    id?: string;
    commands?: ReportCommand[];
  } = {},
): ReportRecordRow {
  const conflict = conflictText(input.conflict ?? null);
  const statuses: NonNullable<ReportRecordRow["statuses"]> = [
    { label: state, tone: stateTone[state] },
  ];
  if (conflict) statuses.push({ label: conflict, tone: "warning" });
  const row: ReportRecordRow = {
    entity: input.entity ?? null,
    id: input.id ?? null,
    title: step,
    // A stage that did not run says so first: its state is the row's result.
    subtitle:
      [...(state === "Ran" ? [] : [state]), ...(input.lines ?? [])]
        .filter((line): line is string => Boolean(line))
        .join("\n") || null,
    trailing: null,
    statuses,
  };
  if (input.at) row.at = input.at.toISOString();
  if (input.commands?.length) row.commands = input.commands;
  return row;
}

/** Each automated stage: its own result, or why it did not decide this original. */
function stageRow(
  stage: (typeof automatedStages)[number],
  email: typeof emailTable.$inferSelect,
  latest: Observation | undefined,
  decidedBy: (typeof automatedStages)[number] | null,
): ReportRecordRow {
  const step = stageStep[stage];
  if (latest)
    return pipelineRow(step, "Ran", {
      lines: [
        `${MAILBOX_CLASSIFICATION_LABEL[latest.classification]}${latest.model ? ` · ${latest.model}` : ""}`,
        latest.reason,
      ],
      at: latest.createdAt,
      conflict: latest.conflict,
    });
  const order = automatedStages.indexOf(stage);
  if (decidedBy && automatedStages.indexOf(decidedBy) > order)
    return pipelineRow(step, "Ran", {
      lines: ["Left Relevance uncertain; not recorded separately"],
    });
  if (decidedBy && email.classification !== "uncertain")
    return pipelineRow(step, "Skipped", {
      lines: [`${stageStep[decidedBy]} decided first`],
    });
  return pipelineRow(step, "Not reached", {
    lines:
      stage === "model" && email.classification === "uncertain"
        ? [
            "Classification-only discovery skips the relevance model; Reclassify runs it.",
          ]
        : [],
  });
}

const knownCost = (calls: (typeof aiUsage.$inferSelect)[]) =>
  calls.every(
    (call) =>
      ["chatgpt", "cache"].includes(call.transport) ||
      (call.transport !== "unknown" && call.estimatedCost !== null),
  )
    ? calls.reduce(
        (sum, call) =>
          sum +
          (["chatgpt", "cache"].includes(call.transport)
            ? 0
            : (call.estimatedCost ?? 0)),
        0,
      )
    : null;

type EmailRow = typeof emailTable.$inferSelect;
type EmailShortcode = ShortcodeFor<"email">;
type ReportClient = ReturnType<typeof getDb>;

/** A recent per-Email estimate, and the actual Run that admitted this exact source. */
async function loadImportCosts(client: ReportClient, email: EmailRow) {
  const recent = await client
    .select({ id: run.id, status: run.status, input: run.input })
    .from(run)
    .where(
      and(
        eq(run.ledgerPartyId, email.ledgerPartyId),
        eq(run.purpose, "mail_import"),
        notDeleted(run),
      ),
    )
    .orderBy(desc(run.endedAt))
    .limit(50);
  const usageFor = (ids: readonly (typeof run.$inferSelect.id)[]) =>
    ids.length
      ? client
          .select()
          .from(aiUsage)
          .where(and(inArray(aiUsage.runId, [...ids]), notDeleted(aiUsage)))
      : Promise.resolve([]);
  const calls = await usageFor(recent.map((item) => item.id));
  const comparable = recent.flatMap((item) => {
    const input = mailResearchRunInput.safeParse(item.input);
    const usage = calls.filter((call) => call.runId === item.id);
    const cost = knownCost(usage);
    if (item.status !== "completed" || !input.success || !usage.length)
      return [];
    return cost === null ? [] : [cost / input.data.sources.length];
  });
  // Actual billing follows the exact frozen source, independently of the
  // bounded recent sample used to estimate a future import.
  if (!email.orderMailId) return { comparable, importRun: null, usage: [] };
  const sources = JSON.stringify({
    kind: "mail_research",
    sources: [{ orderMailId: email.orderMailId, checksum: email.checksum }],
  });
  const actualRuns = await client
    .select()
    .from(run)
    .where(
      and(
        eq(run.ledgerPartyId, email.ledgerPartyId),
        eq(run.purpose, "mail_import"),
        notDeleted(run),
        sql`${run.input} @> ${sources}::jsonb`,
      ),
    )
    .orderBy(desc(run.endedAt), desc(run.id));
  const importRun =
    actualRuns.find((item) =>
      mailResearchRunInput
        .safeParse(item.input)
        .data?.sources.some(
          (source) =>
            source.orderMailId === email.orderMailId &&
            source.checksum === email.checksum,
        ),
    ) ?? null;
  return {
    comparable,
    importRun,
    usage: importRun ? await usageFor([importRun.id]) : [],
  };
}

function retrievedRow(
  email: EmailRow,
  retained: boolean,
  latestFailure: typeof emailRetrievalFailure.$inferSelect | undefined,
  latestPrediction: Observation | undefined,
) {
  if (
    latestFailure &&
    (!latestPrediction || latestFailure.createdAt > latestPrediction.createdAt)
  )
    return pipelineRow("Retrieved", "Failed", {
      lines: [
        `${latestFailure.httpStatus ?? "Provider error"}: ${latestFailure.error}`,
      ],
      at: latestFailure.createdAt,
    });
  const content = retained
    ? "Original content retained"
    : email.contentClearedAt
      ? "Content cleared; metadata and checksum kept. Reclassify refetches it from Gmail."
      : "Metadata only; Reclassify refetches the original from Gmail.";
  return pipelineRow("Retrieved", "Ran", {
    lines: [content, `Mailbox ${email.mailboxId}`],
    at: email.contentClearedAt ?? email.createdAt,
  });
}

const correctRelevanceCommand = (
  email: EmailRow,
  shortcode: EmailShortcode,
): ReportCommand => ({
  id: `correct:${shortcode}:${email.checksum}`,
  label: "Correct relevance",
  prominent: false,
  confirm:
    "Record your Relevance for this Email? Cubby retrieves its original from Gmail and keeps your decision over later reruns.",
  inputs: [
    {
      kind: "choice",
      key: "classification",
      label: "Relevance",
      options: [
        { value: "related", label: MAILBOX_CLASSIFICATION_LABEL.related },
        { value: "uncertain", label: MAILBOX_CLASSIFICATION_LABEL.uncertain },
      ],
      initial: "related",
    },
    { kind: "text", key: "reason", label: "Reason", initial: null },
  ],
  request: {
    kind: "correct-email-relevance",
    id: shortcode,
    expectedChecksum: email.checksum,
    reviewedChecksum: email.checksum,
    classification: "related",
    reason: "",
  },
});

function memberRow(
  email: EmailRow,
  review: { label: typeof emailClassificationLabel.$inferSelect } | undefined,
  correct: ReportCommand,
) {
  if (email.classificationStage === "resolution")
    return pipelineRow("Member review", "Ran", {
      lines: [
        `Resolved ${MAILBOX_CLASSIFICATION_LABEL[mailboxClassification.parse(email.classification)]}`,
        email.classificationReason,
      ],
      commands: [correct],
    });
  if (review)
    return pipelineRow("Member review", "Ran", {
      lines: [
        `Reviewed ${MAILBOX_CLASSIFICATION_LABEL[review.label.classification]}`,
        review.label.reason,
      ],
      at: review.label.createdAt,
      commands: [correct],
    });
  return pipelineRow("Member review", "Not reached", {
    lines: ["No member review of this original."],
    commands: [correct],
  });
}

function previewRow(
  email: EmailRow,
  shortcode: EmailShortcode,
  preview: typeof emailCandidateObservation.$inferSelect | undefined,
  current: boolean,
) {
  const related = email.classification === "related";
  const commands: ReportCommand[] =
    related && current
      ? [
          {
            id: `preview:${shortcode}:${email.checksum}`,
            label: "Rerun preview",
            prominent: false,
            confirm: "Rerun the cheap extraction preview for this Email?",
            request: {
              kind: "rerun-email-preview",
              id: shortcode,
              expectedChecksum: email.checksum,
            },
          },
        ]
      : [];
  if (preview) {
    const result =
      preview.preview.status === "selected"
        ? `${preview.preview.candidate.extraction.status} candidate`
        : preview.preview.reason;
    return pipelineRow("Extraction preview", "Ran", {
      lines: [`${result} · ${preview.preview.model ?? "No model call"}`],
      at: preview.createdAt,
      commands,
    });
  }
  return related
    ? pipelineRow("Extraction preview", "Not reached", { commands })
    : pipelineRow("Extraction preview", "Skipped", {
        lines: ["Only a related Email is previewed."],
      });
}

function importRow(
  email: EmailRow,
  shortcode: EmailShortcode,
  costs: Awaited<ReturnType<typeof loadImportCosts>>,
  canImport: boolean,
) {
  const { importRun, usage } = costs;
  const estimate =
    email.classification === "related" ? [estimateLine(costs.comparable)] : [];
  if (importRun) {
    // One line per model and route: a Run total, including retries and failed
    // calls, never attributed wholly to this Email; unknown routes stay unknown.
    const usageLines = Object.values(
      groupBy(usage, (call) => JSON.stringify([call.model, call.transport])),
    ).map((group) => {
      const cost = knownCost(group);
      const failed = group.filter((call) => call.status === "failed").length;
      return [
        group[0]!.model,
        group[0]!.transport,
        `${group.length} call(s)${failed ? `, ${failed} failed` : ""}`,
        cost === null ? "Unknown" : formatSmallCurrency(cost),
      ].join(" · ");
    });
    const sources =
      mailResearchRunInput.safeParse(importRun.input).data?.sources.length ?? 1;
    return pipelineRow(
      "Import Run",
      ["failed", "dispatch_failed"].includes(importRun.status)
        ? "Failed"
        : "Ran",
      {
        entity: "run",
        id: importRun.shortcode,
        lines: [
          `${importRun.shortcode} · ${importRun.status} · ${sources} Email(s) in Run`,
          ...usageLines,
          ...estimate,
        ],
        at: importRun.endedAt ?? importRun.startedAt,
      },
    );
  }
  if (email.classification !== "related")
    return pipelineRow("Import Run", "Skipped", {
      lines: ["Only a related Email is imported."],
    });
  if (!canImport)
    return pipelineRow("Import Run", "Not reached", {
      lines: [
        "Import needs related, retained, current content and an unclaimed Email.",
        ...estimate,
      ],
    });
  return pipelineRow("Import Run", "Not reached", {
    lines: ["Import runs only when you authorize this Email.", ...estimate],
    commands: [
      {
        id: `import:${shortcode}:${email.checksum}`,
        label: "Import this Email",
        prominent: true,
        confirm:
          "Authorize paid Pi import for this Email? Automatic discovery remains classification-only.",
        request: {
          kind: "import-email",
          id: shortcode,
          expectedChecksum: email.checksum,
        },
      },
    ],
  });
}

function purchaseRow(
  email: EmailRow,
  purchases: Awaited<ReturnType<typeof readEmailAssociations>>["purchases"],
) {
  const [first] = purchases;
  if (!first)
    return pipelineRow(
      "Linked Purchase",
      email.classification === "related" ? "Not reached" : "Skipped",
    );
  return pipelineRow("Linked Purchase", "Ran", {
    entity: "purchase",
    id: first.shortcode,
    lines: purchases.map(
      (item) => `${item.shortcode}${item.orderId ? ` · ${item.orderId}` : ""}`,
    ),
  });
}

/** A future import's per-Email cost from recent settled Runs; an absent estimate never means free. */
function estimateLine(comparable: readonly number[]) {
  if (!comparable.length)
    return "Cost unknown: no comparable settled Run has a complete known billing route. An absent estimate never means free.";
  const [low, high] = [Math.min(...comparable), Math.max(...comparable)].map(
    formatSmallCurrency,
  );
  return `Est. ${low === high ? low : `${low}–${high}`} per Email from ${comparable.length} comparable settled Run(s); failed calls included, ChatGPT plan and cache calls count as zero. An estimate, not a cap.`;
}

/** The Runs that touched this Email, for the pipeline footer. */
async function runMembership(
  client: ReportClient,
  email: EmailRow,
  runIds: readonly (string | null)[],
) {
  const ids = [
    ...new Set(
      [email.runId, ...runIds].flatMap((value) =>
        value === null ? [] : [runEntityId.parse(value)],
      ),
    ),
  ];
  if (!ids.length) return undefined;
  const runs = await client
    .select({
      id: run.id,
      code: run.shortcode,
      purpose: run.purpose,
      input: run.input,
    })
    .from(run)
    .where(inArray(run.id, ids));
  return `Runs: ${runs
    .map(
      (item) =>
        `${item.code} (${runWorkLabel(item)}${item.id === email.runId ? ", processing" : ""})`,
    )
    .join(", ")}`;
}

export async function emailReviewReport(
  db: Database,
  code: string,
  _viewer: ReportViewer | null,
  actor: ActorContext,
): Promise<ReportBlock[]> {
  const client = getDb(db);
  const id = await resolveOrThrow(db, "email", code);
  const [selected] = await client
    .select({
      email: emailTable,
      content: orderMail.content,
      rawChecksum: orderMail.rawChecksum,
    })
    .from(emailTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, emailTable.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .leftJoin(orderMail, eq(orderMail.id, emailTable.orderMailId))
    .where(eq(emailTable.id, id))
    .limit(1);
  if (!selected) throw new Error("Email was not found for this member.");
  const { email } = selected;
  const shortcode = parseShortcodeFor("email", email.shortcode);
  const costs = await loadImportCosts(client, email);
  const [predictions, candidates, failures, reviews] = await Promise.all([
    client
      .select()
      .from(emailClassificationObservation)
      .where(eq(emailClassificationObservation.emailId, id))
      .orderBy(
        desc(emailClassificationObservation.createdAt),
        desc(emailClassificationObservation.id),
      )
      .limit(20),
    client
      .select()
      .from(emailCandidateObservation)
      .where(eq(emailCandidateObservation.emailId, id))
      .orderBy(desc(emailCandidateObservation.createdAt))
      .limit(5),
    client
      .select()
      .from(emailRetrievalFailure)
      .where(eq(emailRetrievalFailure.emailId, id))
      .orderBy(desc(emailRetrievalFailure.createdAt))
      .limit(5),
    client
      .select({
        label: emailClassificationLabel,
        prediction: emailClassificationObservation,
      })
      .from(emailClassificationLabel)
      .innerJoin(
        emailClassificationObservation,
        eq(
          emailClassificationObservation.id,
          emailClassificationLabel.predictionId,
        ),
      )
      .where(
        and(
          eq(emailClassificationObservation.emailId, id),
          eq(emailClassificationLabel.actorUserId, actor.userId),
        ),
      )
      .orderBy(
        desc(emailClassificationLabel.createdAt),
        desc(emailClassificationLabel.id),
      )
      .limit(20),
  ]);
  const retained = await hasRetainedEmailImportContent(
    client,
    email.orderMailId,
    selected.content,
  );
  const current = retained && selected.rawChecksum === email.checksum;
  const canImport =
    email.classification === "related" &&
    current &&
    !["deleted", "excluded", "researching"].includes(email.status);
  const associations = await readEmailAssociations(db, code, actor);
  // Per-stage results for the current original, newest first.
  const currentPredictions = predictions.filter(
    (item) => item.checksum === email.checksum,
  );
  const decidedBy =
    automatedStages.find((stage) => stage === email.classificationStage) ??
    null;
  const latestAutomated = currentPredictions.find(
    (item) => item.stage !== "resolution",
  );
  const footer = await runMembership(client, email, [
    ...predictions.map((item) => item.runId),
    ...candidates.map((item) => item.runId),
  ]);
  const awaitingAcceptance =
    email.classificationStage !== "resolution" &&
    latestAutomated !== undefined &&
    latestAutomated.classification !== email.classification;
  return [
    {
      kind: "records",
      title: "Email pipeline",
      presentation: "ledger",
      rows: [
        retrievedRow(email, retained, failures[0], predictions[0]),
        ...automatedStages.map((stage) =>
          stageRow(
            stage,
            email,
            currentPredictions.find((item) => item.stage === stage),
            decidedBy,
          ),
        ),
        memberRow(
          email,
          reviews.find(
            ({ prediction }) => prediction.checksum === email.checksum,
          ),
          correctRelevanceCommand(email, shortcode),
        ),
        previewRow(
          email,
          shortcode,
          candidates.find((item) => item.preview.checksum === email.checksum),
          current,
        ),
        importRow(email, shortcode, costs, canImport),
        purchaseRow(email, associations.purchases),
      ],
      empty: "No pipeline steps.",
      footer,
      commands: [
        {
          id: `reclassify:${shortcode}`,
          label: "Reclassify",
          prominent: true,
          confirm:
            "Rerun rule, Jev and the relevance model from this Email's Gmail original? The result is recorded; it replaces Relevance only when nothing retained is dropped.",
          request: { kind: "reclassify-email", ids: [shortcode] },
        },
      ],
    },
    ...(awaitingAcceptance
      ? [
          {
            kind: "note" as const,
            tone: "warning" as const,
            text: `The latest ${latestAutomated.stage ?? "automated"} result is ${latestAutomated.classification}; Relevance stays ${email.classification} until you accept it. Resolve the Email unrelated to accept, or correct its relevance.`,
          },
        ]
      : []),
    {
      kind: "note",
      text: "Member-wide accuracy and review conflicts by stage and model are in the Emails list's Accuracy view.",
    },
    ...emailAssociationBlocks(associations),
    {
      kind: "table",
      title: "Classification history",
      columns: ["Relevance", "Stage", "Model", "Reason", "Conflict"],
      rows: predictions.map((item) => ({
        id: item.id,
        cells: [
          item.classification,
          item.stage ?? "Unknown",
          item.model ?? "Unknown",
          item.reason ?? "Unknown",
          conflictText(item.conflict),
        ],
      })),
      empty: "No historical prediction is inferred from a retained Email.",
    },
    {
      kind: "table",
      title: "Member reviews",
      columns: ["Reviewed", "Predicted", "Evidence", "Reason"],
      rows: reviews.map(({ label, prediction }) => ({
        id: label.id,
        cells: [
          label.classification,
          prediction.classification,
          prediction.checksum === email.checksum ? "Current" : "Stale",
          label.reason,
        ],
      })),
      empty: "No member review label is recorded for this Email.",
    },
    {
      kind: "table",
      title: "Extraction previews",
      columns: ["Result", "Model", "Evidence", "Decision"],
      rows: candidates.map((item) => ({
        id: item.id,
        cells: [
          item.preview.status,
          item.preview.model ?? "No model call",
          item.preview.checksum === email.checksum ? "Current" : "Stale",
          item.preview.status === "selected"
            ? `${item.preview.candidate.extraction.status} candidate; review before import`
            : item.preview.reason,
        ],
      })),
      empty: "No extraction preview has been recorded.",
    },
  ];
}

/** Member-wide accuracy and review conflicts: the Emails list's Accuracy view. */
export async function emailAccuracyViewReport(
  db: Database,
  actor: ActorContext,
): Promise<{ blocks: ReportBlock[] }> {
  const client = getDb(db);
  const [[latestEvaluation], conflicts] = await Promise.all([
    client
      .select({ id: emailAccuracyEvaluation.id })
      .from(emailAccuracyEvaluation)
      .where(eq(emailAccuracyEvaluation.ownerUserId, actor.userId))
      .orderBy(
        desc(emailAccuracyEvaluation.createdAt),
        desc(emailAccuracyEvaluation.id),
      )
      .limit(1),
    client
      .select({
        stage: emailClassificationObservation.stage,
        model: emailClassificationObservation.model,
        count: sql<number>`count(*)::int`,
      })
      .from(emailClassificationObservation)
      .innerJoin(
        emailTable,
        eq(emailTable.id, emailClassificationObservation.emailId),
      )
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, emailTable.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          notDeleted(emailTable),
          sql`${emailClassificationObservation.conflict}->>${"kind"} = ${"member_review"}`,
        ),
      )
      .groupBy(
        emailClassificationObservation.stage,
        emailClassificationObservation.model,
      )
      .orderBy(
        emailClassificationObservation.stage,
        emailClassificationObservation.model,
      ),
  ]);
  const accuracyBlocks: ReportBlock[] = latestEvaluation
    ? emailAccuracyReviewBlocks(
        await getEmailAccuracyReport(
          db,
          { evaluationId: latestEvaluation.id },
          actor,
        ),
      )
    : [
        {
          kind: "note",
          text: "Email accuracy has not yet been reviewed. Start a member-wide sample of the latest owned predictions, including unrelated messages.",
        },
      ];
  return {
    blocks: [
      {
        kind: "records",
        title: "Review Email accuracy",
        rows: [],
        empty:
          "Review through mail.accuracy_sample and imports_read.email_accuracy_blind, then mail.accuracy_grade. A member's Claude or Codex session can read originals with Gmail; grade the frozen checksum before opening prediction metadata. Grades never change import routing.",
        commands: [
          {
            id: "create-email-accuracy",
            prominent: true,
            confirm: null,
            label: "Start a 200-Email accuracy sample",
            request: { kind: "create-email-accuracy", sampleSize: 200 },
          },
        ],
      },
      {
        kind: "table",
        title: "Review conflicts by stage and model",
        columns: ["Stage", "Model", "Conflicting results"],
        rows: conflicts.map((item) => ({
          id: JSON.stringify([item.stage, item.model]),
          cells: [
            item.stage ?? "Unknown",
            item.model ?? "Unknown",
            String(item.count),
          ],
        })),
        empty:
          "No recorded rule, Jev or model result disagrees with a member's review.",
      },
      ...accuracyBlocks,
    ],
  };
}
