import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { emailClassificationObservation, feedback } from "~/server/db/schema";
import { ensureEmailAssessment } from "~/server/generic/assessment/repo/assessment-email";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { emailChecks } from "./checks/email";

// Current checksum, owner authority and immutable Assessment lineage decide
// whether member review satisfies the stored relevance check.
describe("Email review quality", () => {
  const ctx = withTestDb();

  it("requires valid current member evidence and honors member resolutions", async () => {
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
      const [result] = await emailChecks.evaluate(ctx.db, [message.id]);
      const gap = [
        "missing-correction",
        "foreign-reviewer",
        "evaluation",
        "stale",
      ].includes(scenario);
      expect({
        scenario,
        state: result?.checks.email_relevance_unreviewed,
      }).toEqual({
        scenario,
        state:
          scenario === "resolution" ? "not_applicable" : gap ? "gap" : "pass",
      });
    }
  });
});
