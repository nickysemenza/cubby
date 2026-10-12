import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { buildActorContext } from "@cubby/schemas/context";
import { emailClassificationObservationInput } from "@cubby/schemas/email-observations";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  emailAccuracyEvaluation,
  emailAccuracyGrade,
  emailClassificationLabel,
  emailClassificationObservation,
  email as emailTable,
  user,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  createEmailAccuracyEvaluation,
  getEmailAccuracyReport,
  gradeEmailAccuracyItem,
  listBlindEmailAccuracyItems,
} from "./email-accuracy";

// Persisted failures: foreign/Run actors can inspect mail; blind results leak a
// verdict; new predictions change a frozen sample; rare strata disappear;
// unweighted or ambiguous grades invent recall; replay appends conflicting labels.
describe("member-owned blind Email accuracy", () => {
  const ctx = withTestDb();
  const otherActor = buildActorContext(
    testUserId("synthetic-accuracy-other-member"),
  );
  type PredictionInput = z.input<typeof emailClassificationObservationInput>;

  async function member(userId = ctx.actor.userId) {
    if (userId !== ctx.actor.userId)
      await getDb(ctx.db)
        .insert(user)
        .values({
          id: userId,
          name: "Synthetic other member",
          email: "accuracy-other@example.test",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    return insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic accuracy member",
      kind: "member",
      userId,
    });
  }

  async function prediction(
    partyId: Awaited<ReturnType<typeof member>>["id"],
    subject: string,
    fields: Pick<PredictionInput, "classification" | "stage" | "model">,
  ) {
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: partyId,
      mailboxId: "synthetic-accuracy-mailbox",
      messageId: randomUUID(),
      sender: "synthetic@example.test",
      subject,
      receivedAt: new Date("2026-09-01T12:00:00Z"),
      checksum: "a".repeat(64),
      classification: fields.classification,
      classificationVersion: "synthetic-v1",
      status: fields.classification === "unrelated" ? "excluded" : "pending",
    });
    const [observation] = await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values(
        emailClassificationObservationInput.parse({
          emailId: email.id,
          checksum: email.checksum,
          classificationVersion: "synthetic-v1",
          reason: "SECRET synthetic predicted reason",
          promptVersion: "synthetic-prompt-v1",
          operation: "mailbox-relevance",
          classification: fields.classification,
          stage: fields.stage,
          model: fields.model,
        }),
      )
      .returning();
    if (!observation) throw new Error("Synthetic prediction insert failed");
    return { email, observation };
  }

  it("samples the latest non-resolution prediction per owned Email and exposes only blind public references", async () => {
    const party = await member();
    const foreign = await member(otherActor.userId);
    const local = await prediction(party.id, "Synthetic receipt", {
      classification: "related",
      stage: "decision",
      model: "typesafe/jev",
    });
    await prediction(foreign.id, "PRIVATE foreign receipt", {
      classification: "unrelated",
      stage: "model",
      model: "@cf/cloudflare/clef",
    });
    const [latest] = await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values({
        ...local.observation,
        id: randomUUID(),
        classification: "unrelated",
        createdAt: new Date(local.observation.createdAt.getTime() + 1000),
      })
      .returning();
    await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values({
        ...local.observation,
        id: randomUUID(),
        stage: "resolution",
        createdAt: new Date(local.observation.createdAt.getTime() + 2000),
      });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 10 },
      ctx.actor,
    );
    expect(evaluation).toMatchObject({ populationCount: 1, sampleSize: 1 });
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(blind.items).toHaveLength(1);
    expect(blind.items[0]).toMatchObject({
      predictionId: latest?.id,
      emailId: local.email.shortcode,
      mailboxId: "synthetic-accuracy-mailbox",
      checksum: local.email.checksum,
    });
    for (const forbidden of [
      "classification",
      "reason",
      "stage",
      "model",
      "promptVersion",
      "operation",
      "stratumId",
      "inclusionProbability",
    ])
      expect(blind.items[0]).not.toHaveProperty(forbidden);
    expect(JSON.stringify(blind)).not.toContain("SECRET");
    expect(JSON.stringify(blind)).not.toContain("PRIVATE");
    expect(JSON.stringify(blind)).not.toContain(local.email.id);
    await expect(
      listBlindEmailAccuracyItems(
        ctx.db,
        { evaluationId: evaluation.evaluationId },
        otherActor,
      ),
    ).rejects.toThrow(/member/);
    await expect(
      getEmailAccuracyReport(
        ctx.db,
        { evaluationId: evaluation.evaluationId },
        otherActor,
      ),
    ).rejects.toThrow(/member/);
    await expect(
      createEmailAccuracyEvaluation(
        ctx.db,
        {},
        { ...ctx.actor, runId: parseEntityId("run", randomUUID()) },
      ),
    ).rejects.toThrow(/member/);
    await expect(
      createEmailAccuracyEvaluation(
        ctx.db,
        {},
        { ...ctx.actor, channel: "system" },
      ),
    ).rejects.toThrow(/member/);
  });

  it("freezes prediction identity and content while newer classifications arrive, and stamps only a proven frozen review", async () => {
    const party = await member();
    const original = await prediction(party.id, "Synthetic original", {
      classification: "unrelated",
      stage: "decision",
      model: "typesafe/jev",
    });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      {},
      ctx.actor,
    );
    const before = await getDb(ctx.db).select().from(emailAccuracyEvaluation);
    await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values({
        ...original.observation,
        id: randomUUID(),
        classification: "related",
        checksum: "b".repeat(64),
        createdAt: new Date(original.observation.createdAt.getTime() + 1000),
      });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ checksum: "b".repeat(64), classification: "related" })
      .where(eq(emailTable.id, original.email.id));
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(blind.items[0]).toMatchObject({
      predictionId: original.observation.id,
      checksum: "a".repeat(64),
      currentChecksum: "b".repeat(64),
    });
    await expect(
      gradeEmailAccuracyItem(
        ctx.db,
        {
          evaluationId: evaluation.evaluationId,
          predictionId: original.observation.id,
          grade: "related",
          reason: "Reviewed synthetic current content",
          reviewedChecksum: "b".repeat(64),
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/checksum/);
    await gradeEmailAccuracyItem(
      ctx.db,
      {
        evaluationId: evaluation.evaluationId,
        predictionId: original.observation.id,
        grade: "related",
        reason: "Reviewed the exact frozen synthetic original",
        reviewedChecksum: "a".repeat(64),
      },
      ctx.actor,
    );
    expect(await getDb(ctx.db).select().from(emailAccuracyEvaluation)).toEqual(
      before,
    );
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation)
      .where(eq(emailClassificationObservation.id, original.observation.id));
    expect(unchanged).toEqual(original.observation);
    const [email] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, original.email.id));
    expect(email?.classification).toBe("related");
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(report.pipeline.confusionMatrix).toMatchObject({
      falseNegative: 1,
      truePositive: 0,
    });
  });

  it("reports inverse-probability estimates for unequal strata and attributes models only by exact known values", async () => {
    const party = await member();
    for (let i = 0; i < 6; i++)
      await prediction(party.id, "Synthetic receipt", {
        classification: "related",
        stage: "decision",
        model: "typesafe/jev",
      });
    for (let i = 0; i < 2; i++)
      await prediction(party.id, "Synthetic bulletin", {
        classification: "related",
        stage: "decision",
        model: null,
      });
    for (let i = 0; i < 4; i++)
      await prediction(party.id, "Synthetic invoice", {
        classification: "unrelated",
        stage: "model",
        model: "@cf/cloudflare/clef",
      });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 3 },
      ctx.actor,
    );
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    for (const item of blind.items)
      await gradeEmailAccuracyItem(
        ctx.db,
        {
          evaluationId: evaluation.evaluationId,
          predictionId: item.predictionId,
          grade:
            item.headers?.subject === "Synthetic bulletin"
              ? "unrelated"
              : "related",
          reason: "Reviewed the frozen synthetic message",
          reviewedChecksum: "a".repeat(64),
        },
        ctx.actor,
      );
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(report.pipeline.confusionMatrix).toEqual({
      truePositive: 6,
      falsePositive: 2,
      falseNegative: 4,
      trueNegative: 0,
    });
    expect(report.pipeline.precisionRelated).toBeCloseTo(0.75);
    expect(report.pipeline.recallRelated).toBeCloseTo(0.6);
    expect(report.modelOnly.confusionMatrix).toEqual({
      truePositive: 6,
      falsePositive: 0,
      falseNegative: 4,
      trueNegative: 0,
    });
    expect(report.modelOnly.precisionRelated).toBe(1);
    expect(report.counts.unknownModel).toBe(1);
    expect(
      report.strata
        .map((s) => ({
          populationCount: s.populationCount,
          values: [
            s.populationCount,
            s.sampleCount,
            s.inclusionProbability,
            s.weight,
          ],
        }))
        .sort((a, b) => a.populationCount - b.populationCount)
        .map(({ values }) => values),
    ).toEqual([
      [2, 1, 0.5, 2],
      [4, 1, 0.25, 4],
      [6, 1, 1 / 6, 6],
    ]);
  });

  it("excludes uncertain predictions, uncertain labels and unavailable originals from conditional binary metrics", async () => {
    const party = await member();
    const cases = [
      {
        subject: "Synthetic determinate",
        classification: "related",
        stage: "rule",
        model: null,
        grade: "related",
      },
      {
        subject: "Synthetic ambiguous label",
        classification: "related",
        stage: "decision",
        model: "typesafe/jev",
        grade: "uncertain",
      },
      {
        subject: "Synthetic ambiguous prediction",
        classification: "uncertain",
        stage: "model",
        model: "@cf/cloudflare/clef",
        grade: "related",
      },
      {
        subject: "Synthetic unavailable",
        classification: "unrelated",
        stage: "model",
        model: "synthetic-jev-not-the-model",
        grade: "unavailable",
      },
    ] as const;
    for (const item of cases) await prediction(party.id, item.subject, item);
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 4 },
      ctx.actor,
    );
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    for (const item of blind.items) {
      const known = cases.find((c) => c.subject === item.headers?.subject);
      if (!known) throw new Error("Synthetic sample missing");
      const review =
        known.grade === "unavailable"
          ? { grade: known.grade, reviewedChecksum: null }
          : { grade: known.grade, reviewedChecksum: "a".repeat(64) };
      await gradeEmailAccuracyItem(
        ctx.db,
        {
          evaluationId: evaluation.evaluationId,
          predictionId: item.predictionId,
          ...review,
          reason: "Independent synthetic review",
        },
        ctx.actor,
      );
    }
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(report.counts).toMatchObject({
      unavailable: 1,
      uncertainGrade: 1,
      uncertainPrediction: 1,
      unknownModel: 1,
      knownOtherModel: 1,
    });
    expect(report.pipeline).toMatchObject({
      binaryPairCount: 1,
      precisionRelated: 1,
      recallRelated: 1,
    });
    expect(report.modelOnly).toMatchObject({
      binaryPairCount: 0,
      precisionRelated: null,
      recallRelated: null,
    });
    expect(report.warnings).toContain(
      "Binary metrics are conditional on determinate predictions and reviewed labels; excluded items do not establish total-population recall.",
    );
    expect(
      await getDb(ctx.db).select().from(emailClassificationLabel),
    ).toHaveLength(3);
  });

  it("replays an exact grade once, refuses conflicting grades or foreign selectors, and leaves routing untouched", async () => {
    const party = await member();
    const item = await prediction(party.id, "Synthetic replay", {
      classification: "unrelated",
      stage: "rule",
      model: null,
    });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      {},
      ctx.actor,
    );
    const input = {
      evaluationId: evaluation.evaluationId,
      predictionId: item.observation.id,
      grade: "related" as const,
      reason: "Synthetic original reviewed",
      reviewedChecksum: item.email.checksum,
    };
    const first = await gradeEmailAccuracyItem(ctx.db, input, ctx.actor);
    expect(await gradeEmailAccuracyItem(ctx.db, input, ctx.actor)).toEqual(
      first,
    );
    await expect(
      gradeEmailAccuracyItem(
        ctx.db,
        { ...input, grade: "unrelated" },
        ctx.actor,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      gradeEmailAccuracyItem(
        ctx.db,
        { ...input, reason: "Different synthetic review" },
        ctx.actor,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      gradeEmailAccuracyItem(
        ctx.db,
        { ...input, predictionId: randomUUID() },
        ctx.actor,
      ),
    ).rejects.toThrow(/evaluation/);
    await expect(
      gradeEmailAccuracyItem(ctx.db, input, otherActor),
    ).rejects.toThrow(/member/);
    expect(await getDb(ctx.db).select().from(emailAccuracyGrade)).toHaveLength(
      1,
    );
    expect(
      await getDb(ctx.db).select().from(emailClassificationLabel),
    ).toHaveLength(1);
    const [email] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, item.email.id));
    expect(email?.classification).toBe("unrelated");
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toEqual([item.observation]);
  });

  it("hides transferred or deleted Email content but lets the evaluation owner record unavailable without a label", async () => {
    const party = await member();
    const foreign = await member(otherActor.userId);
    const transferred = await prediction(
      party.id,
      "PRIVATE transferred original",
      { classification: "related", stage: "rule", model: null },
    );
    const deleted = await prediction(party.id, "PRIVATE deleted original", {
      classification: "unrelated",
      stage: "rule",
      model: null,
    });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      {},
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(emailTable)
      .set({ ledgerPartyId: foreign.id })
      .where(eq(emailTable.id, transferred.email.id));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ deletedAt: new Date() })
      .where(eq(emailTable.id, deleted.email.id));
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(blind.items.map((i) => i.availability).sort()).toEqual([
      "missing",
      "ownership_changed",
    ]);
    expect(JSON.stringify(blind)).not.toContain("PRIVATE");
    expect(
      blind.items.every(
        (i) =>
          i.headers === null && i.mailboxId === null && i.messageId === null,
      ),
    ).toBe(true);
    await expect(
      gradeEmailAccuracyItem(
        ctx.db,
        {
          evaluationId: evaluation.evaluationId,
          predictionId: transferred.observation.id,
          grade: "related",
          reason: "Attempted private original review",
          reviewedChecksum: "a".repeat(64),
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/owned/);
    for (const item of blind.items)
      await gradeEmailAccuracyItem(
        ctx.db,
        {
          evaluationId: evaluation.evaluationId,
          predictionId: item.predictionId,
          grade: "unavailable",
          reason: "Original no longer available for this member",
          reviewedChecksum: null,
        },
        ctx.actor,
      );
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(report.counts).toMatchObject({
      unavailable: 2,
      missingEmail: 1,
      ownershipChanged: 1,
    });
    expect(
      await getDb(ctx.db).select().from(emailClassificationLabel),
    ).toHaveLength(0);
  });

  it("freezes member-wide unpredicted coverage without leaking predictions or changing it after later evidence and ownership", async () => {
    const party = await member();
    const foreign = await member(otherActor.userId);
    await prediction(party.id, "Synthetic known receipt", {
      classification: "related",
      stage: "decision",
      model: "typesafe/jev",
    });
    const unknown = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-accuracy-mailbox",
      messageId: "unknown-prediction",
      checksum: "b".repeat(64),
      classification: null,
      status: "pending",
    });
    await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: foreign.id,
      mailboxId: "synthetic-accuracy-mailbox",
      messageId: "foreign-unknown",
      checksum: "c".repeat(64),
      classification: null,
      status: "pending",
    });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 200 },
      ctx.actor,
    );
    expect(evaluation).toMatchObject({
      memberEmailCount: 2,
      unpredictedEmailCount: 1,
      populationCount: 1,
      sampleSize: 1,
    });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(emailAccuracyEvaluation)
      .where(eq(emailAccuracyEvaluation.id, evaluation.evaluationId));
    expect(stored?.roster).toMatchObject({
      memberEmailCount: 2,
      unpredictedEmailCount: 1,
    });
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(blind.items).toHaveLength(1);
    expect(blind.items[0]).not.toHaveProperty("classification");
    expect(blind.items[0]).not.toHaveProperty("stage");
    expect(blind.items[0]).not.toHaveProperty("model");
    await getDb(ctx.db).insert(emailClassificationObservation).values({
      emailId: unknown.id,
      checksum: unknown.checksum,
      classification: "unrelated",
      stage: "rule",
      reason: "Synthetic later evidence",
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ ledgerPartyId: foreign.id })
      .where(eq(emailTable.id, unknown.id));
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(report).toMatchObject({
      memberEmailCount: 2,
      unpredictedEmailCount: 1,
      populationCount: 1,
      sampleSize: 1,
    });
    expect(report.warnings.join(" ")).toMatch(
      /conditional.*classified prediction population/i,
    );
    expect(report.warnings.join(" ")).toMatch(/1.*2.*1.*without.*prediction/i);
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(emailAccuracyEvaluation)
      .where(eq(emailAccuracyEvaluation.id, evaluation.evaluationId));
    expect(unchanged).toEqual(stored);
  });

  it("includes known historical predictions with unknown stage and model without inventing attribution", async () => {
    const party = await member();
    const historical = await prediction(
      party.id,
      "Synthetic historical decision",
      { classification: "related", stage: "decision", model: null },
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "EmailClassificationObservation" SET "stage" = NULL, "reason" = NULL WHERE "id" = ${historical.observation.id}::uuid`,
    );
    await prediction(party.id, "Synthetic current decision", {
      classification: "unrelated",
      stage: "rule",
      model: null,
    });
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 200 },
      ctx.actor,
    );
    expect(evaluation.populationCount).toBe(2);
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(report.strata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: null,
          model: null,
          populationCount: 1,
          sampleCount: 1,
          inclusionProbability: 1,
        }),
      ]),
    );
    expect(report.byStage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: null,
          populationCount: 1,
          sampleCount: 1,
        }),
      ]),
    );
    expect(report.counts).toMatchObject({ unknownStage: 1, unknownModel: 2 });
    expect(report.modelOnly.binaryPairCount).toBe(0);
    const [observation] = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation)
      .where(eq(emailClassificationObservation.id, historical.observation.id));
    expect(observation).toMatchObject({
      stage: null,
      model: null,
      reason: null,
      classification: "related",
    });
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(blind.items).toHaveLength(2);
    for (const item of blind.items) {
      expect(item).not.toHaveProperty("classification");
      expect(item).not.toHaveProperty("stage");
      expect(item).not.toHaveProperty("model");
    }
  });

  it("refuses a sample too small to cover every stratum before storing an evaluation", async () => {
    const party = await member();
    await prediction(party.id, "Synthetic receipt", {
      classification: "related",
      stage: "rule",
      model: null,
    });
    await prediction(party.id, "Synthetic bulletin", {
      classification: "unrelated",
      stage: "decision",
      model: "typesafe/jev",
    });
    await expect(
      createEmailAccuracyEvaluation(ctx.db, { sampleSize: 1 }, ctx.actor),
    ).rejects.toThrow(/strat/i);
    expect(
      await getDb(ctx.db).select().from(emailAccuracyEvaluation),
    ).toHaveLength(0);
  });
  // 0041 widens and 0042 renames the stored `jev` stage; a frozen roster keeps
  // the stage in its strata, items and JSON-encoded stratum ids.
  it("carries jev predictions and frozen rosters through the decision stage contract", async () => {
    const migration = (tag: string) =>
      readFileSync(
        new URL(`../../../drizzle/${tag}.sql`, import.meta.url),
        "utf8",
      )
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim());
    for (const statement of migration("0041_decision_stage"))
      await getDb(ctx.db).execute(sql.raw(statement));
    const party = await member();
    const local = await prediction(party.id, "Synthetic newsletter", {
      classification: "unrelated",
      stage: "decision",
      model: "@cf/cloudflare/clef",
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classificationStage: "decision" })
      .where(eq(emailTable.id, local.email.id));
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 10 },
      ctx.actor,
    );
    // Recreate the deployed shape the contract migration meets.
    await getDb(ctx.db).execute(
      sql`UPDATE "Email" SET "classificationStage" = 'jev' WHERE id = ${local.email.id}::uuid`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "EmailClassificationObservation" SET stage = 'jev' WHERE id = ${local.observation.id}::uuid`,
    );
    await getDb(ctx.db).execute(
      sql.raw(
        `UPDATE "EmailAccuracyEvaluation" SET roster = replace(replace(roster::text, '"stage": "decision"', '"stage": "jev"'), '[\\"decision\\",', '[\\"jev\\",')::jsonb`,
      ),
    );
    const before = await getDb(ctx.db).execute(
      sql`SELECT roster::text AS roster FROM "EmailAccuracyEvaluation"`,
    );
    expect(String(before.rows[0]?.roster)).toContain('[\\"jev\\",');
    for (const statement of migration("0042_decision_stage_contract"))
      await getDb(ctx.db).execute(sql.raw(statement));
    const [stored] = await getDb(ctx.db)
      .select({ stage: emailTable.classificationStage })
      .from(emailTable)
      .where(eq(emailTable.id, local.email.id));
    expect(stored?.stage).toBe("decision");
    const report = await getEmailAccuracyReport(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    expect(JSON.stringify(report)).not.toContain('jev"');
    await expect(
      getDb(ctx.db).execute(
        sql`UPDATE "Email" SET "classificationStage" = 'jev' WHERE id = ${local.email.id}::uuid`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "Email_classification_stage_check" },
    });
  });
});
