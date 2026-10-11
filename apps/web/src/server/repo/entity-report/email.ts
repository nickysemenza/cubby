import type { ActorContext } from "@cubby/schemas/context";
import type {
  EmailAccuracyReport,
  EmailAccuracyBinaryMetrics,
} from "@cubby/schemas/email-accuracy";
import type { ReportBlock } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { formatPercent } from "~/lib/number-format";
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
    rows.map((row) => ({
      entity: "email",
      id: row.shortcode,
      title: row.subject ?? "Email",
      subtitle: row.sender,
      trailing: row.receivedAt?.toISOString() ?? null,
    }));
  return [
    {
      kind: "records",
      title: "Accepted Purchases",
      rows: purchases(associations.purchases),
      empty: "No accepted source or linked lifecycle Purchase association.",
    },
    {
      kind: "records",
      title: "Purchase Expenses",
      rows: associations.expenses.map((row) => ({
        entity: "expense",
        id: row.shortcode,
        title: row.name,
        subtitle: null,
        trailing: null,
      })),
      empty: "No live Expenses on associated Purchases.",
    },
    {
      kind: "records",
      title: "Purchase Products",
      rows: associations.products.map((row) => ({
        entity: "product",
        id: row.shortcode,
        title: row.name,
        subtitle: null,
        trailing: null,
      })),
      empty: "No live Products on associated Purchase Expenses.",
    },
    {
      kind: "records",
      title: "Emails for the same Purchases",
      rows: emails(associations.samePurchaseEmails),
      empty: "No other owned Emails associated with these Purchases.",
    },
    {
      kind: "records",
      title: "Gmail thread context",
      rows: emails(associations.threadEmails).map((row) => ({
        ...row,
        statuses: [{ label: "Thread context only", tone: "muted" }],
      })),
      empty:
        "No other owned Emails in this mailbox and thread. Thread context does not associate a Purchase.",
    },
    {
      kind: "records",
      title: "Dismissed Purchase candidates",
      rows: purchases(associations.dismissedCandidates).map((row) => ({
        ...row,
        statuses: [{ label: "Dismissed candidate", tone: "muted" }],
      })),
      empty:
        "No dismissed lifecycle Purchase candidates. Dismissal does not associate a Purchase.",
    },
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
  const recent = await client
    .select({
      id: run.id,
      code: run.shortcode,
      status: run.status,
      input: run.input,
    })
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
  const calls = recent.length
    ? await client
        .select()
        .from(aiUsage)
        .where(
          and(
            inArray(
              aiUsage.runId,
              recent.map((item) => item.id),
            ),
            notDeleted(aiUsage),
          ),
        )
    : [];
  const comparable = recent.flatMap((item) => {
    const input = mailResearchRunInput.safeParse(item.input);
    const usage = calls.filter((call) => call.runId === item.id);
    if (
      item.status !== "completed" ||
      !input.success ||
      !usage.length ||
      usage.some(
        (call) =>
          !["chatgpt", "cache"].includes(call.transport) &&
          (call.transport === "unknown" || call.estimatedCost === null),
      )
    )
      return [];
    const cost = usage.reduce(
      (total, call) =>
        total +
        (["chatgpt", "cache"].includes(call.transport)
          ? 0
          : (call.estimatedCost ?? 0)),
      0,
    );
    return [cost / input.data.sources.length];
  });
  // Actual billing follows the exact frozen source, independently of the
  // bounded recent sample used to estimate a future import.
  const actualSources = email.orderMailId
    ? JSON.stringify({
        kind: "mail_research",
        sources: [{ orderMailId: email.orderMailId, checksum: email.checksum }],
      })
    : null;
  const actualRuns = actualSources
    ? await client
        .select({
          id: run.id,
          code: run.shortcode,
          status: run.status,
          input: run.input,
        })
        .from(run)
        .where(
          and(
            eq(run.ledgerPartyId, email.ledgerPartyId),
            eq(run.purpose, "mail_import"),
            notDeleted(run),
            sql`${run.input} @> ${actualSources}::jsonb`,
          ),
        )
        .orderBy(desc(run.endedAt), desc(run.id))
    : [];
  const actualCalls = actualRuns.length
    ? await client
        .select()
        .from(aiUsage)
        .where(
          and(
            inArray(
              aiUsage.runId,
              actualRuns.map((item) => item.id),
            ),
            notDeleted(aiUsage),
          ),
        )
    : [];
  const actualUsage = actualRuns.flatMap((item) => {
    const input = mailResearchRunInput.safeParse(item.input);
    if (
      !input.success ||
      !input.data.sources.some(
        (source) =>
          source.orderMailId === email.orderMailId &&
          source.checksum === email.checksum,
      )
    )
      return [];
    const usage = actualCalls.filter((call) => call.runId === item.id);
    const groups = new Map<string, typeof usage>();
    for (const call of usage) {
      const key = JSON.stringify([call.model, call.transport]);
      const group = groups.get(key) ?? [];
      group.push(call);
      groups.set(key, group);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => {
        const first = group[0]!;
        const known = group.every(
          (call) =>
            ["chatgpt", "cache"].includes(call.transport) ||
            (call.transport !== "unknown" && call.estimatedCost !== null),
        );
        const cost = known
          ? String(
              group.reduce(
                (sum, call) =>
                  sum +
                  (["chatgpt", "cache"].includes(call.transport)
                    ? 0
                    : (call.estimatedCost ?? 0)),
                0,
              ),
            )
          : "Unknown";
        return {
          id: `${item.id}:${key}`,
          cells: [
            item.code,
            item.status,
            String(input.data.sources.length),
            first.model,
            first.transport,
            String(group.length),
            String(group.filter((call) => call.status === "failed").length),
            cost,
          ],
        };
      });
  });
  const [predictions, candidates, failures, reviews, evaluations] =
    await Promise.all([
      client
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.emailId, id))
        .orderBy(desc(emailClassificationObservation.createdAt))
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
      client
        .select({ id: emailAccuracyEvaluation.id })
        .from(emailAccuracyEvaluation)
        .where(eq(emailAccuracyEvaluation.ownerUserId, actor.userId))
        .orderBy(
          desc(emailAccuracyEvaluation.createdAt),
          desc(emailAccuracyEvaluation.id),
        )
        .limit(1),
    ]);
  const canImport =
    email.classification === "related" &&
    (await hasRetainedEmailImportContent(
      client,
      email.orderMailId,
      selected.content,
    )) &&
    selected.rawChecksum === email.checksum &&
    !["deleted", "excluded", "researching"].includes(email.status);
  const latestEvaluation = evaluations[0];
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
  const associations = await readEmailAssociations(db, code, actor);
  return [
    ...emailAssociationBlocks(associations),
    ...accuracyBlocks,
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
      title: "Independent relevance reviews",
      columns: [
        "Reviewed relevance",
        "Predicted relevance",
        "Prediction checksum",
        "Current checksum",
        "Evidence status",
        "Reviewed at",
        "Reason",
      ],
      rows: reviews.map(({ label, prediction }) => ({
        id: label.id,
        cells: [
          label.classification,
          prediction.classification,
          prediction.checksum ?? "Unknown",
          email.checksum,
          prediction.checksum !== null && prediction.checksum === email.checksum
            ? "Current"
            : "Stale",
          label.createdAt.toISOString(),
          label.reason,
        ],
      })),
      empty: "No independent reviewed label is recorded for this Email.",
    },
    {
      kind: "note",
      text: "Independent reviews describe the original prediction checksum. Stale reviews remain history and do not label current content. Neither these reads nor reviewed labels change the Email's effective import classification.",
    },
    {
      kind: "note",
      text: "Automatic discovery is classification-only. Import runs only when you authorize this Email. A historical cost range is an estimate, not a price cap; model route and work required can change it.",
    },
    {
      kind: "stats",
      figures: [
        {
          id: "pi-cost-low",
          label: "Estimated marginal cost, low",
          value: comparable.length ? Math.min(...comparable) : null,
          format: "money",
        },
        {
          id: "pi-cost-high",
          label: "Estimated marginal cost, high",
          value: comparable.length ? Math.max(...comparable) : null,
          format: "money",
        },
        {
          label: "Comparable settled Runs",
          value: comparable.length,
          format: "count",
        },
      ],
    },
    {
      kind: "note",
      text: comparable.length
        ? `Range per Email from ${comparable.length} recent owned mail-import Runs with known billing routes. ChatGPT plan and cache calls count as zero marginal dollars; gateway/direct costs use recorded estimates. Failed calls are included. Unpriced Runs are excluded.`
        : "No comparable settled Run has a complete known billing route. Cost is unknown; an absent estimate never means free.",
    },
    {
      kind: "records",
      rows: [],
      empty: canImport
        ? "This retained original can be imported individually."
        : "Import needs related, retained, current content and an unclaimed Email. Resolve relevance or retrieve its original first.",
      commands: canImport
        ? [
            {
              id: `import:${code}:${email.checksum}`,
              label: "Import this Email",
              prominent: true,
              confirm:
                "Authorize paid Pi import for this Email? Automatic discovery remains classification-only.",
              request: {
                kind: "import-email",
                id: parseShortcodeFor("email", email.shortcode),
                expectedChecksum: email.checksum,
              },
            },
          ]
        : [],
    },
    {
      kind: "table",
      title: "Actual import Run usage",
      columns: [
        "Run",
        "Status",
        "Emails in Run",
        "Model",
        "Route",
        "Calls",
        "Failed calls",
        "Marginal dollars",
      ],
      rows: actualUsage,
      empty:
        "No calls are recorded for a Run that admitted this exact Email checksum.",
    },
    {
      kind: "note",
      text: "Actual usage is the total for each frozen-source Run, including retries and failed calls. A Run with multiple Emails does not attribute its entire cost to this Email. Unknown routes or prices remain unknown.",
    },
    {
      kind: "table",
      title: "Classification history",
      columns: ["Relevance", "Stage", "Model", "Reason", "Conflict"],
      rows: predictions.map((item) => ({
        id: item.id,
        cells: [
          item.classification,
          item.stage ?? "Unknown",
          item.model ?? "Historical model unknown",
          item.reason ?? "Unknown",
          item.conflict?.kind ?? "",
        ],
      })),
      empty: "No historical prediction is inferred from a retained Email.",
    },
    {
      kind: "table",
      title: "Cheap extraction previews",
      columns: ["Result", "Model", "Evidence checksum", "Decision"],
      rows: candidates.map((item) => ({
        id: item.id,
        cells: [
          item.preview.status,
          item.preview.model ?? "No model call",
          item.preview.checksum,
          item.preview.status === "selected"
            ? `${item.preview.candidate.extraction.status} candidate; review before import`
            : item.preview.reason,
        ],
      })),
      empty: "No complete evidence-bound order candidate has been recorded.",
    },
    ...failures.map((item): ReportBlock => ({
      kind: "note",
      text: `${item.httpStatus ?? "Provider error"}: ${item.error}`,
    })),
  ];
}
