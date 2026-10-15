import type { ActorContext } from "@cubby/schemas/context";
import {
  createEmailAccuracyEvaluationInput,
  createEmailAccuracyEvaluationOut,
  emailAccuracyReport,
  emailAccuracyRoster,
  emailAccuracyRosterItem,
  getEmailAccuracyReportInput,
  gradeEmailAccuracyItemInput,
  gradeEmailAccuracyItemOut,
  listBlindEmailAccuracyItemsInput,
  listBlindEmailAccuracyItemsOut,
  type EmailAccuracyBinaryMetrics,
  type EmailAccuracyReport,
  type EmailAccuracyRoster,
  type EmailAccuracyRosterItem,
  type EmailAccuracyStratum,
} from "@cubby/schemas/email-accuracy";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import {
  emailAccuracyEvaluation,
  feedback,
  emailClassificationObservation,
  ledgerParty,
  email as emailTable,
} from "~/server/db/schema";
import { recordFeedback } from "~/server/generic/assessment/repo/assessment";
import {
  ensureEmailAssessment,
  emailGradeMetadata,
} from "~/server/generic/assessment/repo/assessment-email";

type Client = DrizzleClient | DrizzleTransaction;
type Evaluation = typeof emailAccuracyEvaluation.$inferSelect;
const gradeRow = emailGradeMetadata.extend({
  id: z.uuid(),
  reason: z.string().nullable(),
  createdAt: z.date(),
});
type Grade = z.infer<typeof gradeRow>;
async function readGrades(
  client: Client,
  evaluationId: string,
): Promise<Grade[]> {
  const rows = await client
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.authority, "evaluation"),
        sql`${feedback.metadata} @> ${JSON.stringify({ kind: "email_accuracy", evaluationId })}::jsonb`,
      ),
    );
  return rows.map((row) =>
    gradeRow.parse({
      ...z.object({}).passthrough().parse(row.metadata),
      id: row.id,
      reason: row.reason,
      createdAt: row.createdAt,
    }),
  );
}

async function assertMember(client: Client, actor: ActorContext) {
  if (actor.runId !== null || actor.channel === "system")
    throw new Error(
      "Email accuracy review requires a member actor without a Run.",
    );
  const [member] = await client
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, ledgerPartyKind.enum.member),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  if (!member) throw new Error("Email accuracy review requires a live member.");
}

function validatedRoster(evaluation: Evaluation): EmailAccuracyRoster {
  const roster = emailAccuracyRoster.parse(evaluation.roster);
  const strata = new Map(roster.strata.map((s) => [s.id, s]));
  const predictions = new Set<string>();
  const emails = new Set<string>();
  if (
    (roster.memberEmailCount === null) !==
      (roster.unpredictedEmailCount === null) ||
    (roster.memberEmailCount !== null &&
      roster.unpredictedEmailCount !== null &&
      roster.memberEmailCount !==
        evaluation.populationCount + roster.unpredictedEmailCount) ||
    strata.size !== roster.strata.length ||
    roster.items.length !== evaluation.sampleSize ||
    roster.strata.reduce((n, s) => n + s.populationCount, 0) !==
      evaluation.populationCount ||
    roster.strata.reduce((n, s) => n + s.sampleCount, 0) !==
      evaluation.sampleSize
  )
    throw new Error(
      "Email accuracy roster has inconsistent sample denominators.",
    );
  for (const item of roster.items) {
    const stratum = strata.get(item.stratumId);
    if (
      !stratum ||
      stratum.stage !== item.stage ||
      stratum.classification !== item.classification ||
      stratum.model !== item.model ||
      predictions.has(item.predictionId) ||
      emails.has(item.emailId)
    )
      throw new Error(
        "Email accuracy roster has inconsistent frozen prediction membership.",
      );
    predictions.add(item.predictionId);
    emails.add(item.emailId);
  }
  for (const stratum of strata.values()) {
    if (
      stratum.sampleCount > stratum.populationCount ||
      stratum.inclusionProbability !==
        stratum.sampleCount / stratum.populationCount ||
      roster.items.filter((item) => item.stratumId === stratum.id).length !==
        stratum.sampleCount
    )
      throw new Error(
        "Email accuracy requires known, consistent inclusion probabilities.",
      );
  }
  return roster;
}

async function ownedEvaluation(
  client: Client,
  id: string,
  actor: ActorContext,
  lock = false,
) {
  await assertMember(client, actor);
  const query = client
    .select()
    .from(emailAccuracyEvaluation)
    .where(
      and(
        eq(emailAccuracyEvaluation.id, id),
        eq(emailAccuracyEvaluation.ownerUserId, actor.userId),
      ),
    )
    .limit(1);
  const [evaluation] = await (lock ? query.for("update") : query);
  if (!evaluation)
    throw new Error("Email accuracy evaluation not found for this member.");
  return { evaluation, roster: validatedRoster(evaluation) };
}

/** Rejection sampling avoids modulo bias, including for small rare strata. */
function uniformIndex(max: number): number {
  const ceiling = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    const sampled = buffer[0];
    if (sampled === undefined)
      throw new Error("Email accuracy random buffer has no entry.");
    value = sampled;
  } while (value >= ceiling);
  return value % max;
}
function shuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  for (let end = shuffled.length - 1; end > 0; end--) {
    const index = uniformIndex(end + 1);
    const picked = shuffled[index];
    const last = shuffled[end];
    if (picked === undefined || last === undefined)
      throw new Error(
        "Email accuracy shuffle index is outside the frozen sample.",
      );
    shuffled[index] = last;
    shuffled[end] = picked;
  }
  return shuffled;
}
function probabilitySample(
  population: readonly EmailAccuracyRosterItem[],
  requested: number,
  memberEmailCount: number,
): EmailAccuracyRoster {
  const groups = new Map<string, EmailAccuracyRosterItem[]>();
  for (const item of population) {
    const group = groups.get(item.stratumId) ?? [];
    group.push(item);
    groups.set(item.stratumId, group);
  }
  if (groups.size > requested)
    throw new Error(
      "Email accuracy sample size must cover every stage/class/model stratum.",
    );
  const size = Math.min(requested, population.length);
  const remaining = size - groups.size;
  const capacity = population.length - groups.size;
  const allocations = [...groups].map(([id, items]) => {
    const exact = capacity ? (remaining * (items.length - 1)) / capacity : 0;
    return {
      id,
      items,
      sampleCount: 1 + Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let left = size - allocations.reduce((n, group) => n + group.sampleCount, 0);
  for (const group of [...allocations].sort(
    (a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id),
  )) {
    if (left > 0 && group.sampleCount < group.items.length) {
      group.sampleCount++;
      left--;
    }
  }
  const strata: EmailAccuracyStratum[] = [];
  const items: EmailAccuracyRosterItem[] = [];
  for (const group of allocations) {
    const first = group.items[0];
    if (!first)
      throw new Error("Email accuracy stratum has no frozen prediction.");
    strata.push({
      id: group.id,
      stage: first.stage,
      classification: first.classification,
      model: first.model,
      populationCount: group.items.length,
      sampleCount: group.sampleCount,
      inclusionProbability: group.sampleCount / group.items.length,
    });
    items.push(...shuffle(group.items).slice(0, group.sampleCount));
  }
  return emailAccuracyRoster.parse({
    version: 1,
    memberEmailCount,
    unpredictedEmailCount: memberEmailCount - population.length,
    strata,
    items: shuffle(items),
  });
}

export async function createEmailAccuracyEvaluation(
  db: Database,
  input: z.input<typeof createEmailAccuracyEvaluationInput>,
  actor: ActorContext,
): Promise<z.infer<typeof createEmailAccuracyEvaluationOut>> {
  const parsed = createEmailAccuracyEvaluationInput.parse(input);
  return withTransaction(db, async (tx) => {
    await assertMember(tx, actor);
    const rows = await tx
      .selectDistinctOn([emailTable.id], {
        prediction: emailClassificationObservation,
      })
      .from(emailTable)
      .leftJoin(
        emailClassificationObservation,
        and(
          eq(emailTable.id, emailClassificationObservation.emailId),
          or(
            isNull(emailClassificationObservation.stage),
            ne(emailClassificationObservation.stage, "resolution"),
          ),
        ),
      )
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, emailTable.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          eq(ledgerParty.kind, ledgerPartyKind.enum.member),
          notDeleted(ledgerParty),
        ),
      )
      .where(notDeleted(emailTable))
      .orderBy(
        emailTable.id,
        desc(emailClassificationObservation.createdAt),
        desc(emailClassificationObservation.id),
      );
    const population = rows.flatMap(({ prediction }) =>
      prediction
        ? [
            emailAccuracyRosterItem.parse({
              predictionId: prediction.id,
              emailId: prediction.emailId,
              checksum: prediction.checksum,
              stratumId: JSON.stringify([
                prediction.stage,
                prediction.classification,
                prediction.model,
              ]),
              classification: prediction.classification,
              stage: prediction.stage,
              model: prediction.model,
              classificationVersion: prediction.classificationVersion,
              promptVersion: prediction.promptVersion,
              operation: prediction.operation,
              predictedAt: prediction.createdAt.toISOString(),
            }),
          ]
        : [],
    );
    const roster = probabilitySample(
      population,
      parsed.sampleSize,
      rows.length,
    );
    const [evaluation] = await tx
      .insert(emailAccuracyEvaluation)
      .values({
        ownerUserId: actor.userId,
        requestedSampleSize: parsed.sampleSize,
        populationCount: population.length,
        sampleSize: roster.items.length,
        roster,
      })
      .returning();
    if (!evaluation)
      throw new Error("Email accuracy evaluation insert returned no row.");
    validatedRoster(evaluation);
    return createEmailAccuracyEvaluationOut.parse({
      evaluationId: evaluation.id,
      createdAt: evaluation.createdAt.toISOString(),
      memberEmailCount: rows.length,
      unpredictedEmailCount: rows.length - population.length,
      populationCount: evaluation.populationCount,
      sampleSize: evaluation.sampleSize,
    });
  });
}

async function rosterEmails(client: Client, roster: EmailAccuracyRoster) {
  if (!roster.items.length) return [];
  return client
    .select({
      id: emailTable.id,
      code: emailTable.shortcode,
      mailboxId: emailTable.mailboxId,
      messageId: emailTable.messageId,
      sender: emailTable.sender,
      subject: emailTable.subject,
      receivedAt: emailTable.receivedAt,
      threadId: emailTable.threadId,
      checksum: emailTable.checksum,
      deletedAt: emailTable.deletedAt,
      ownerUserId: ledgerParty.userId,
      ownerKind: ledgerParty.kind,
      ownerDeletedAt: ledgerParty.deletedAt,
    })
    .from(emailTable)
    .leftJoin(ledgerParty, eq(ledgerParty.id, emailTable.ledgerPartyId))
    .where(
      inArray(
        emailTable.id,
        roster.items.map((item) => parseEntityId("email", item.emailId)),
      ),
    );
}
type RosterEmail = Awaited<ReturnType<typeof rosterEmails>>[number];
function availability(email: RosterEmail | undefined, actor: ActorContext) {
  if (!email || email.deletedAt) return "missing";
  if (
    email.ownerUserId !== actor.userId ||
    email.ownerKind !== ledgerPartyKind.enum.member ||
    email.ownerDeletedAt
  )
    return "ownership_changed";
  return "owned";
}
export async function listBlindEmailAccuracyItems(
  db: Database,
  input: z.input<typeof listBlindEmailAccuracyItemsInput>,
  actor: ActorContext,
): Promise<z.infer<typeof listBlindEmailAccuracyItemsOut>> {
  const parsed = listBlindEmailAccuracyItemsInput.parse(input);
  const client = getDb(db);
  const { roster } = await ownedEvaluation(client, parsed.evaluationId, actor);
  const emails = new Map(
    (await rosterEmails(client, roster)).map((email) => [email.id, email]),
  );
  const grades = await readGrades(client, parsed.evaluationId);
  const graded = new Set(grades.map((grade) => grade.predictionId));
  return listBlindEmailAccuracyItemsOut.parse({
    evaluationId: parsed.evaluationId,
    totalCount: roster.items.length,
    gradedCount: grades.length,
    items: roster.items
      .slice(parsed.offset, parsed.offset + parsed.limit)
      .map((item) => {
        const email = emails.get(parseEntityId("email", item.emailId));
        const status = availability(email, actor);
        const visible = status === "owned" ? email : undefined;
        return {
          predictionId: item.predictionId,
          emailId: visible ? parseShortcodeFor("email", visible.code) : null,
          mailboxId: visible?.mailboxId ?? null,
          messageId: visible?.messageId ?? null,
          headers: visible
            ? {
                sender: visible.sender,
                subject: visible.subject,
                receivedAt: visible.receivedAt?.toISOString() ?? null,
                threadId: visible.threadId,
              }
            : null,
          checksum: item.checksum,
          currentChecksum: visible?.checksum ?? null,
          availability: status,
          graded: graded.has(item.predictionId),
        };
      }),
  });
}
function gradeOutput(grade: Grade) {
  return gradeEmailAccuracyItemOut.parse({
    predictionId: grade.predictionId,
    grade: grade.grade,
    reason: grade.reason,
    reviewedChecksum: grade.reviewedChecksum,
    createdAt: grade.createdAt.toISOString(),
  });
}
export async function gradeEmailAccuracyItem(
  db: Database,
  input: z.input<typeof gradeEmailAccuracyItemInput>,
  actor: ActorContext,
): Promise<z.infer<typeof gradeEmailAccuracyItemOut>> {
  const parsed = gradeEmailAccuracyItemInput.parse(input);
  return withTransaction(db, async (tx) => {
    const { roster } = await ownedEvaluation(
      tx,
      parsed.evaluationId,
      actor,
      true,
    );
    const item = roster.items.find(
      (item) => item.predictionId === parsed.predictionId,
    );
    if (!item)
      throw new Error(
        "Prediction is not in this frozen Email accuracy evaluation.",
      );
    const previous = (await readGrades(tx, parsed.evaluationId)).find(
      (row) => row.predictionId === parsed.predictionId,
    );
    if (previous) {
      if (
        previous.grade !== parsed.grade ||
        previous.reason !== parsed.reason ||
        previous.reviewedChecksum !== parsed.reviewedChecksum
      )
        throw new Error(
          "Email accuracy grade is immutable; replay must match exactly.",
        );
      return gradeOutput(previous);
    }
    if (parsed.grade !== "unavailable") {
      if (!item.checksum || parsed.reviewedChecksum !== item.checksum)
        throw new Error(
          "Email accuracy review must prove the frozen message checksum.",
        );
      const [email] = await tx
        .select({ id: emailTable.id })
        .from(emailTable)
        .innerJoin(
          ledgerParty,
          and(
            eq(ledgerParty.id, emailTable.ledgerPartyId),
            eq(ledgerParty.userId, actor.userId),
            eq(ledgerParty.kind, ledgerPartyKind.enum.member),
            notDeleted(ledgerParty),
          ),
        )
        .where(
          and(
            eq(emailTable.id, parseEntityId("email", item.emailId)),
            notDeleted(emailTable),
          ),
        )
        .for("update")
        .limit(1);
      if (!email)
        throw new Error(
          "Email accuracy labels require a live Email owned by this member.",
        );
    }
    const transactionDb = databaseForTransaction(tx);
    const prediction = await ensureEmailAssessment(
      transactionDb,
      item.predictionId,
    );
    const event = await recordFeedback(transactionDb, {
      assessmentId: prediction.id,
      operationId: `email-accuracy:${parsed.evaluationId}:${item.predictionId}`,
      authority: "evaluation",
      actorUserId: actor.userId,
      verdict:
        parsed.grade === "uncertain"
          ? "uncertain"
          : parsed.grade === "unavailable"
            ? "ungraded"
            : parsed.grade === item.classification
              ? "correct"
              : "wrong",
      correction:
        parsed.grade === "unavailable"
          ? { present: false }
          : { present: true, value: parsed.grade },
      reason: parsed.reason,
      metadata: {
        kind: "email_accuracy",
        evaluationId: parsed.evaluationId,
        predictionId: item.predictionId,
        grade: parsed.grade,
        reviewedChecksum: parsed.reviewedChecksum,
      },
    });
    const grade = gradeRow.parse({
      ...emailGradeMetadata.parse(event.metadata),
      id: event.id,
      reason: event.reason,
      createdAt: event.createdAt,
    });
    if (!grade) throw new Error("Email accuracy grade insert returned no row.");
    return gradeOutput(grade);
  });
}
function binaryPair(item: EmailAccuracyRosterItem, grade: Grade | undefined) {
  return (
    !!grade &&
    (grade.grade === "related" || grade.grade === "unrelated") &&
    (item.classification === "related" || item.classification === "unrelated")
  );
}
/** Only recorded exact model identifiers establish Jev/Clef attribution. */
const isKnownDecisionModel = (model: string | null) =>
  model === "typesafe/jev" || model === "@cf/cloudflare/clef";
function binaryMetrics(
  items: readonly EmailAccuracyRosterItem[],
  strata: ReadonlyMap<string, EmailAccuracyStratum>,
  grades: ReadonlyMap<string, Grade>,
): EmailAccuracyBinaryMetrics {
  const matrix = {
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
  };
  let pairs = 0;
  for (const item of items) {
    const grade = grades.get(item.predictionId);
    const stratum = strata.get(item.stratumId);
    if (!grade || !stratum || !binaryPair(item, grade)) continue;
    const weight = 1 / stratum.inclusionProbability;
    pairs++;
    if (item.classification === "related") {
      if (grade.grade === "related") matrix.truePositive += weight;
      else matrix.falsePositive += weight;
    } else if (grade.grade === "related") matrix.falseNegative += weight;
    else matrix.trueNegative += weight;
  }
  const predictedRelated = matrix.truePositive + matrix.falsePositive;
  const actualRelated = matrix.truePositive + matrix.falseNegative;
  return {
    binaryPairCount: pairs,
    estimatedBinaryPopulation: Object.values(matrix).reduce(
      (n, value) => n + value,
      0,
    ),
    confusionMatrix: matrix,
    precisionRelated: predictedRelated
      ? matrix.truePositive / predictedRelated
      : null,
    recallRelated: actualRelated ? matrix.truePositive / actualRelated : null,
  };
}
function sampleCounts(
  roster: EmailAccuracyRoster,
  grades: ReadonlyMap<string, Grade>,
  emails: ReadonlyMap<RosterEmail["id"], RosterEmail>,
  actor: ActorContext,
): EmailAccuracyReport["counts"] {
  const counts: EmailAccuracyReport["counts"] = {
    graded: grades.size,
    ungraded: roster.items.length - grades.size,
    unavailable: 0,
    uncertainGrade: 0,
    uncertainPrediction: 0,
    unknownModel: 0,
    unknownStage: 0,
    knownOtherModel: 0,
    missingEmail: 0,
    ownershipChanged: 0,
    historicalMetadataUnknown: 0,
  };
  for (const item of roster.items) {
    const grade = grades.get(item.predictionId);
    if (grade?.grade === "unavailable") counts.unavailable++;
    if (grade?.grade === "uncertain") counts.uncertainGrade++;
    if (item.classification === "uncertain") counts.uncertainPrediction++;
    if (item.stage === null) counts.unknownStage++;
    if (item.model === null) counts.unknownModel++;
    else if (!isKnownDecisionModel(item.model)) counts.knownOtherModel++;
    if (item.checksum === null || item.classificationVersion === null)
      counts.historicalMetadataUnknown++;
    const status = availability(
      emails.get(parseEntityId("email", item.emailId)),
      actor,
    );
    if (status === "missing") counts.missingEmail++;
    if (status === "ownership_changed") counts.ownershipChanged++;
  }
  return counts;
}

export async function getEmailAccuracyReport(
  db: Database,
  input: z.input<typeof getEmailAccuracyReportInput>,
  actor: ActorContext,
): Promise<z.infer<typeof emailAccuracyReport>> {
  const parsed = getEmailAccuracyReportInput.parse(input);
  const client = getDb(db);
  const { evaluation, roster } = await ownedEvaluation(
    client,
    parsed.evaluationId,
    actor,
  );
  const grades = new Map(
    (await readGrades(client, evaluation.id)).map((grade) => [
      grade.predictionId,
      grade,
    ]),
  );
  const emails = new Map(
    (await rosterEmails(client, roster)).map((email) => [email.id, email]),
  );
  const strata = new Map(roster.strata.map((s) => [s.id, s]));
  const pipeline = binaryMetrics(roster.items, strata, grades);
  const modelOnly = binaryMetrics(
    roster.items.filter((item) => isKnownDecisionModel(item.model)),
    strata,
    grades,
  );
  const counts = sampleCounts(roster, grades, emails, actor);
  const byStage = new Map<
    EmailAccuracyStratum["stage"],
    EmailAccuracyReport["byStage"][number]
  >();
  const byModel = new Map<
    string | null,
    EmailAccuracyReport["byModel"][number]
  >();
  const reportStrata = roster.strata.map((stratum) => {
    const members = roster.items.filter(
      (item) => item.stratumId === stratum.id,
    );
    const gradedCount = members.filter((item) =>
      grades.has(item.predictionId),
    ).length;
    const stage = byStage.get(stratum.stage) ?? {
      stage: stratum.stage,
      populationCount: 0,
      sampleCount: 0,
      gradedCount: 0,
    };
    const model = byModel.get(stratum.model) ?? {
      model: stratum.model,
      populationCount: 0,
      sampleCount: 0,
      gradedCount: 0,
    };
    for (const total of [stage, model]) {
      total.populationCount += stratum.populationCount;
      total.sampleCount += stratum.sampleCount;
      total.gradedCount += gradedCount;
    }
    byStage.set(stratum.stage, stage);
    byModel.set(stratum.model, model);
    return {
      ...stratum,
      weight: 1 / stratum.inclusionProbability,
      gradedCount,
      binaryPairCount: members.filter((item) =>
        binaryPair(item, grades.get(item.predictionId)),
      ).length,
    };
  });
  const warnings = [
    "Binary metrics are conditional on determinate predictions and reviewed labels; excluded items do not establish total-population recall.",
  ];
  if (roster.memberEmailCount === null || roster.unpredictedEmailCount === null)
    warnings.push(
      "Member-wide coverage was not captured in this frozen evaluation and remains unknown; metrics are conditional on the classified prediction population.",
    );
  else
    warnings.push(
      `Metrics are conditional on the classified prediction population: ${evaluation.populationCount} predicted Emails out of ${roster.memberEmailCount} owned Emails; ${roster.unpredictedEmailCount} owned Emails without a non-resolution prediction are outside the sample.`,
    );
  if (counts.unknownStage)
    warnings.push(
      "Unknown historical decision stages remain a separate stratum; neither stage nor model attribution is inferred.",
    );
  if (counts.ungraded)
    warnings.push(
      "The frozen sample is not fully graded; missing grades may bias conditional estimates.",
    );
  if (counts.unavailable || counts.uncertainGrade || counts.uncertainPrediction)
    warnings.push(
      "Unavailable and uncertain items are excluded from binary metric denominators; exclusion counts may overlap.",
    );
  if (counts.unknownModel)
    warnings.push(
      "Missing actual model identifiers are counted separately and excluded from model-only metrics; stage is not model attribution.",
    );
  if (counts.historicalMetadataUnknown)
    warnings.push(
      "Historical metadata count means missing frozen checksum or classification version; earlier predictions are not reconstructed.",
    );
  if (counts.missingEmail || counts.ownershipChanged)
    warnings.push(
      "Some frozen Emails are missing or no longer owned; private content is not exposed.",
    );
  for (const [name, metrics] of [
    ["Pipeline", pipeline],
    ["Model-only", modelOnly],
  ] as const) {
    if (metrics.precisionRelated === null)
      warnings.push(`${name} related precision denominator is zero.`);
    if (metrics.recallRelated === null)
      warnings.push(`${name} related recall denominator is zero.`);
  }
  return emailAccuracyReport.parse({
    evaluationId: evaluation.id,
    createdAt: evaluation.createdAt.toISOString(),
    memberEmailCount: roster.memberEmailCount,
    unpredictedEmailCount: roster.unpredictedEmailCount,
    populationCount: evaluation.populationCount,
    sampleSize: evaluation.sampleSize,
    pipeline,
    modelOnly,
    items: roster.items.map((item) => {
      const stratum = strata.get(item.stratumId);
      if (!stratum)
        throw new Error("Email accuracy item has no frozen sampling stratum.");
      return {
        predictionId: item.predictionId,
        inclusionProbability: stratum.inclusionProbability,
        weight: 1 / stratum.inclusionProbability,
      };
    }),
    counts,
    strata: reportStrata,
    byStage: [...byStage.values()],
    byModel: [...byModel.values()],
    warnings,
  });
}
