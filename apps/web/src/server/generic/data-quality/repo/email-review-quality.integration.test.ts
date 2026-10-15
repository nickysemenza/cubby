import { mailboxClassification } from "@cubby/schemas/mailbox-research";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { emailClassificationObservation, feedback } from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";
import { ensureEmailAssessment } from "~/server/generic/assessment/repo/assessment-email";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { gapCondition, qualityFilterContext, qualityFilterSource } from "./sql";

// Resolving each Feedback's Assessment inside every Email check multiplies
// review history by mailbox size. The shared bulk relation must resolve each
// review's lineage before joining it to current, member-owned predictions.
describe("Email review quality planning", () => {
  const ctx = withTestDb();

  it("bounds Assessment work across a mailbox with repeated review history", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic review planner member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const messages = [];
    for (let index = 0; index < 120; index++) {
      messages.push(
        await insertWithShortcode(ctx.db, "email", {
          ledgerPartyId: party.id,
          mailboxId: "synthetic-review-planner",
          messageId: `synthetic-review-${index}`,
          checksum: "a".repeat(64),
          classification: "related",
          classificationStage: "decision",
          status: "pending",
        }),
      );
    }
    const [first] = messages;
    if (!first) throw new Error("Synthetic message missing");
    const predictions = await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values(
        messages.map(
          (message) =>
            ({
              emailId: message.id,
              checksum: message.checksum,
              classification: "related",
              stage: "decision",
              reason: "Synthetic prediction",
              classificationVersion: "synthetic-v1",
            }) satisfies typeof emailClassificationObservation.$inferInsert,
        ),
      )
      .returning();
    const prediction = predictions.find((row) => row.emailId === first.id);
    if (!prediction) throw new Error("Synthetic prediction missing");
    const assessment = await ensureEmailAssessment(ctx.db, prediction.id);
    await getDb(ctx.db)
      .insert(feedback)
      .values(
        Array.from(
          { length: 300 },
          (_, index) =>
            ({
              assessmentId: assessment.id,
              operationId: `synthetic-review-history-${index}`,
              verdict: "correct",
              correction: { present: false },
              intent: "history",
              authority: "member",
              actorUserId: ctx.actor.userId,
            }) satisfies typeof feedback.$inferInsert,
        ),
      );
    await getDb(ctx.db).execute(
      sql`ANALYZE "Email", "EmailClassificationObservation", "Feedback", "Assessment"`,
    );
    const statement = sql`SELECT "Email".id, ${gapCondition("email", "email_relevance_unreviewed", undefined, qualityFilterContext("email"))} AS gap FROM ${qualityFilterSource("email")}`;
    const rows = z
      .array(z.object({ gap: z.boolean() }))
      .parse((await getDb(ctx.db).execute(statement)).rows);
    expect(rows).toHaveLength(120);
    expect(rows.filter((row) => row.gap)).toHaveLength(119);
    const result = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    );
    const plans = z
      .array(
        z.object({ "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })) }),
      )
      .parse(result.rows);
    const nodeSchema = z.object({
      "Relation Name": z.string().optional(),
      "Actual Rows": z.number().default(0),
      "Actual Loops": z.number().default(0),
      "Rows Removed by Filter": z.number().default(0),
      Plans: z.array(z.unknown()).optional(),
    });
    let assessmentVisits = 0;
    const visit = (value: unknown) => {
      const node = nodeSchema.parse(value);
      if (node["Relation Name"] === "Assessment")
        assessmentVisits +=
          (node["Actual Rows"] + node["Rows Removed by Filter"]) *
          node["Actual Loops"];
      node.Plans?.forEach(visit);
    };
    for (const row of plans)
      row["QUERY PLAN"].forEach(({ Plan }) => visit(Plan));
    expect(assessmentVisits).toBeLessThan(2000);
  });
  // Shared bulk evidence must retain the owner's authority, current checksum,
  // valid-label policy and Assessment lineage, including judgment fallback.
  it("matches scalar review semantics for current member evidence", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic review semantics member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    for (const scenario of [
      "correct",
      "corrected",
      "uncertain-correction",
      "missing-correction",
      "foreign-reviewer",
      "evaluation",
      "stale",
      "older-valid",
      "metadata-mismatch",
      "resolution",
    ] as const) {
      const message = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-review-semantics",
        messageId: scenario,
        checksum: "a".repeat(64),
        classification: "related",
        status: "pending",
        classificationStage:
          scenario === "resolution" ? "resolution" : "decision",
      });
      const [prediction] = await getDb(ctx.db)
        .insert(emailClassificationObservation)
        .values({
          emailId: message.id,
          checksum: scenario === "stale" ? "b".repeat(64) : message.checksum,
          classification: "related",
          stage: "decision",
          reason: "Synthetic prediction",
          classificationVersion: "synthetic-v1",
        })
        .returning();
      if (!prediction) throw new Error("Synthetic prediction missing");
      const assessment = await ensureEmailAssessment(ctx.db, prediction.id);
      await getDb(ctx.db)
        .insert(feedback)
        .values({
          assessmentId: assessment.id,
          operationId: `synthetic-review-${scenario}`,
          verdict:
            scenario === "missing-correction" ||
            scenario === "corrected" ||
            scenario === "resolution"
              ? "wrong"
              : "correct",
          correction:
            scenario === "corrected" ||
            scenario === "uncertain-correction" ||
            scenario === "resolution"
              ? {
                  present: true,
                  value:
                    scenario === "corrected" || scenario === "resolution"
                      ? "unrelated"
                      : "uncertain",
                }
              : { present: false },
          intent: "history",
          authority: scenario === "evaluation" ? "evaluation" : "member",
          actorUserId:
            scenario === "foreign-reviewer"
              ? "synthetic-foreign-reviewer"
              : ctx.actor.userId,
          metadata:
            scenario === "metadata-mismatch"
              ? { predictionId: "synthetic-untrusted-metadata" }
              : null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        });
      if (scenario === "older-valid")
        await getDb(ctx.db)
          .insert(feedback)
          .values({
            assessmentId: assessment.id,
            operationId: "synthetic-newer-invalid",
            verdict: "wrong",
            correction: { present: false },
            intent: "history",
            authority: "member",
            actorUserId: ctx.actor.userId,
            createdAt: new Date("2026-01-02T00:00:00Z"),
          });
      const result = await getDb(ctx.db).execute(sql`SELECT
        ${gapCondition("email", "email_relevance_unreviewed")} AS scalar,
        ${gapCondition("email", "email_relevance_unreviewed", undefined, qualityFilterContext("email"))} AS bulk,
        ${emailMemberClassificationSql()} AS "scalarClassification",
        dq_filter."memberClassification" AS "bulkClassification"
        FROM ${qualityFilterSource("email")} WHERE "Email".id = ${message.id}`);
      const [row] = z
        .array(
          z.object({
            scalar: z.boolean(),
            bulk: z.boolean(),
            scalarClassification: mailboxClassification.nullable(),
            bulkClassification: mailboxClassification.nullable(),
          }),
        )
        .parse(result.rows);
      const gap = [
        "missing-correction",
        "foreign-reviewer",
        "evaluation",
        "stale",
      ].includes(scenario);
      const classification = gap
        ? null
        : scenario === "corrected"
          ? "unrelated"
          : scenario === "uncertain-correction"
            ? "uncertain"
            : "related";
      expect({ scenario, result: row }).toEqual({
        scenario,
        result: {
          scalar: gap,
          bulk: gap,
          scalarClassification: classification,
          bulkClassification: classification,
        },
      });
    }
  });
});
