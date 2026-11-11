import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { expectStatementBudget } from "tooling/statement-budget";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { suggestionTable, auditLog, image } from "~/server/db/schema";
import { confirmImageDescription } from "~/server/domains/image/repo/image-description-confirmation";
import { readConfirmedDescription } from "~/server/domains/image/repo/image-description-read";
import { loadSelectedDescriptionEvidence } from "~/server/domains/image/repo/image-description-selection";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { recordFeedback } from "~/server/generic/suggestions/repo/suggestion";
import { publishExactSuggestion } from "~/server/generic/suggestions/repo/suggestion-publication";
import { assessRecommendation } from "~/server/generic/suggestions/repo/suggestion-recommendation";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

// Failure modes: retry publication mutates historical evidence; corrected null
// disappears; bare wrong becomes suppression; deleting active targets deletes
// history; evaluation feedback acquires operational authority.
describe("shared Suggestion history", () => {
  const ctx = withTestDb();
  const publication = () => ({
    publicationKey: "synthetic:suggestion:retry",
    family: "recommendation" as const,
    subject: {
      kind: "recommendation" as const,
      entity: "product",
      recordId: parseEntityId(
        "product",
        "00000000-0000-4000-8000-000000000001",
      ),
      candidateKey: "synthetic-key",
      scope: "related",
    },
    judgment: { candidateKey: "synthetic-key" },
    fingerprint: null,
    producer: null,
    evidence: null,
  });

  it("publishes once and refuses changed evidence under a retry identity", async () => {
    const first = await publishExactSuggestion(ctx.db, publication());
    expect((await publishExactSuggestion(ctx.db, publication())).id).toBe(
      first.id,
    );
    await expect(
      publishExactSuggestion(ctx.db, {
        ...publication(),
        evidence: { changed: true },
      }),
    ).rejects.toThrow(/publication/);
  });

  it("records draft acceptance separately and acknowledges only the matching saved field", async () => {
    const record = await productFixture(ctx, "Synthetic receipt item", {
      notes: "Saved synthetic note",
    });
    const prediction = await publishExactSuggestion(ctx.db, {
      publicationKey: "synthetic:draft-receipt",
      family: "field",
      subject: {
        kind: "field",
        entity: "product",
        recordId: null,
        field: "notes",
        draft: true,
      },
      judgment: { value: "Saved synthetic note" },
      producer: null,
      fingerprint: "synthetic-draft-evidence",
      evidence: null,
    });
    const context = kernelCtx(ctx);
    expect(
      (
        await reviewSuggestion(ctx.db, context, {
          suggestionId: prediction.id,
          operationId: "draft",
          verdict: "correct",
          intent: "draft",
        })
      ).applied,
    ).toBe(false);
    expect(
      (
        await reviewSuggestion(ctx.db, context, {
          suggestionId: prediction.id,
          operationId: "saved",
          verdict: "correct",
          intent: "apply",
          application: { kind: "saved_field", recordId: record.id },
        })
      ).applied,
    ).toBe(true);
    const rows = await readSuggestionDecisions(ctx.db, prediction.id);
    expect(rows.find((row) => row.operationId === "draft")?.receipt).toBeNull();
    expect(
      rows.find((row) => row.operationId === "receipt:saved")?.receipt,
    ).toEqual(
      expect.objectContaining({ mode: "member", reason: "member_acceptance" }),
    );
    const changed = await productFixture(ctx, "Synthetic changed receipt", {
      notes: "A different saved note",
    });
    await expect(
      reviewSuggestion(ctx.db, context, {
        suggestionId: prediction.id,
        operationId: "saved",
        verdict: "correct",
        intent: "apply",
        application: { kind: "saved_field", recordId: changed.id },
      }),
    ).rejects.toThrow(/already used for a different review/);
    await expect(
      reviewSuggestion(ctx.db, context, {
        suggestionId: prediction.id,
        operationId: "changed",
        verdict: "correct",
        intent: "apply",
        application: { kind: "saved_field", recordId: changed.id },
      }),
    ).rejects.toThrow(/saved field/);
  });

  // Command replay must outlive projection resolution; another command cannot inherit success.
  it.each([false, true])(
    "replays the exact field application once, correction=%s",
    async (corrected) => {
      const product = await productFixture(ctx, "Synthetic command replay", {
        notes: "Original note",
      });
      const target = await recordId(ctx.db, product.id, "product");
      const prediction = await publishExactSuggestion(
        ctx.db,
        {
          publicationKey: "synthetic:field-replay",
          family: "field",
          subject: {
            kind: "field",
            entity: "product",
            recordId: target,
            field: "notes",
          },
          judgment: { value: "Proposed note" },
          fingerprint: null,
          producer: null,
          evidence: null,
        },
        {
          suggestedValue: "Proposed note",
          currentValue: "Original note",
          confidence: 1,
          data: {
            liveInputFingerprint: await fieldInputFingerprint(
              ctx.db,
              "product",
              target,
              "notes",
            ),
          },
        },
      );
      const command = {
        suggestionId: prediction.id,
        operationId: "synthetic:apply-once",
        verdict: corrected ? ("wrong" as const) : ("correct" as const),
        intent: "apply" as const,
        // A row without a stored fingerprint is reviewed by its id.
        expectedFingerprint: prediction.id,
        correction: corrected
          ? { present: true as const, value: "Corrected note" }
          : { present: false as const },
      };
      // A retained command can have a PostgreSQL GUID outside RFC UUID
      // version/variant bits; its application receipt must replay unchanged.
      await recordFeedback(ctx.db, {
        ...command,
        authority: "member",
        actorUserId: ctx.actor.userId,
        metadata: {
          kind: "assessment_review",
          application: null,
          expectedFingerprint: prediction.id,
        },
      });
      await getDb(ctx.db)
        .update(suggestionTable)
        .set({
          decisions: sql`jsonb_set(${suggestionTable.decisions}, '{0,id}', '"e2401ffa-3eda-6673-6a93-95accfcf1320"')`,
        })
        .where(eq(suggestionTable.id, prediction.id));
      const first = await reviewSuggestion(ctx.db, kernelCtx(ctx), command);
      const history = await readSuggestionDecisions(ctx.db, prediction.id);
      const audit = await getDb(ctx.db).select().from(auditLog);
      expect(await reviewSuggestion(ctx.db, kernelCtx(ctx), command)).toEqual(
        first,
      );
      expect(await readSuggestionDecisions(ctx.db, prediction.id)).toEqual(
        history,
      );
      expect(await getDb(ctx.db).select().from(auditLog)).toEqual(audit);
      await expect(
        reviewSuggestion(ctx.db, kernelCtx(ctx), {
          ...command,
          correction: { present: true, value: "Conflicting reuse" },
        }),
      ).rejects.toThrow(/already used for a different review/);
      await expect(
        reviewSuggestion(ctx.db, kernelCtx(ctx), {
          ...command,
          operationId: "synthetic:another-command",
          correction: { present: true, value: "Another correction" },
        }),
      ).rejects.toThrow(/resolved/);
    },
  );
  it("fences confirmed descriptions to current image content in direct and batch readers", async () => {
    const picture = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic/content-fence.jpg",
      filename: "content-fence.jpg",
      size: 1,
      contentType: "image/jpeg",
      sha256: "a".repeat(64),
    });
    const first = {
      imageId: picture.id,
      contentHash: "a".repeat(64),
      description: "Superseded description",
      operationId: crypto.randomUUID(),
      expectedEffectId: null,
    };
    await confirmImageDescription(ctx.db, first, ctx.actor.userId);
    await confirmImageDescription(
      ctx.db,
      {
        ...first,
        description: "Confirmed description",
        operationId: crypto.randomUUID(),
        expectedEffectId: first.operationId,
      },
      ctx.actor.userId,
    );
    // A lost-response retry of the first confirmation must not overwrite the newer one.
    await expect(
      confirmImageDescription(ctx.db, first, ctx.actor.userId),
    ).rejects.toThrow(/description changed/);
    const readDirect = () =>
      readConfirmedDescription(ctx.db, parseEntityId("image", picture.id));
    const readBatch = async () =>
      (await loadSelectedDescriptionEvidence(ctx.db, [picture.shortcode])).get(
        picture.shortcode,
      );
    expect((await readDirect())?.description).toBe("Confirmed description");
    expect((await readBatch())?.description).toBe("Confirmed description");
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, picture.id));
    expect(await readDirect()).toBeNull();
    expect((await readBatch())?.description ?? null).toBeNull();
    expect(
      (
        await getDb(ctx.db).select().from(image).where(eq(image.id, picture.id))
      )[0]?.confirmedDescription,
    ).toBe("Confirmed description");
    await expect(
      confirmImageDescription(
        ctx.db,
        {
          imageId: picture.id,
          contentHash: "a".repeat(64),
          description: "Stale correction",
          operationId: crypto.randomUUID(),
          expectedEffectId: null,
        },
        ctx.actor.userId,
      ),
    ).rejects.toThrow(/evidence changed/);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "a".repeat(64), deletedAt: new Date() })
      .where(eq(image.id, picture.id));
    expect(await readDirect()).toBeNull();
    expect((await readBatch())?.description ?? null).toBeNull();
  });

  // Public history must never impersonate a private domain-application receipt.
  it("refuses public receipt namespace collisions and forged application receipts", async () => {
    const record = await productFixture(ctx, "Synthetic receipt collision", {
      notes: "Synthetic saved note",
    });
    const prediction = await publishExactSuggestion(ctx.db, {
      publicationKey: "synthetic:receipt-collision",
      family: "field",
      subject: {
        kind: "field",
        entity: "product",
        recordId: null,
        field: "notes",
        draft: true,
      },
      judgment: { value: "Synthetic saved note" },
      producer: null,
      fingerprint: "synthetic-receipt",
      evidence: null,
    });
    for (const operationId of [
      "command-application:synthetic-command",
      "receipt:synthetic-command",
      "application:synthetic-command",
      "merge:synthetic-command",
      "email-accuracy:synthetic-command",
      "automatic:synthetic-command",
      "decision",
      "resolution",
      "saved-application",
      "saved-correction",
    ]) {
      await expect(
        reviewSuggestion(ctx.db, kernelCtx(ctx), {
          suggestionId: prediction.id,
          operationId,
          verdict: "uncertain",
          intent: "history",
        }),
      ).rejects.toThrow(/reserved/);
    }
    // Also fail closed for a pre-existing collision written before public validation.
    await recordFeedback(ctx.db, {
      suggestionId: prediction.id,
      operationId: "command-application:synthetic-command",
      verdict: "uncertain",
      intent: "history",
      authority: "member",
      actorUserId: ctx.actor.userId,
    });
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        suggestionId: prediction.id,
        operationId: "synthetic-command",
        verdict: "correct",
        intent: "apply",
        application: { kind: "saved_field", recordId: record.id },
      }),
    ).rejects.toThrow(/receipt/);
    const applied = await expectStatementBudget(
      () =>
        reviewSuggestion(ctx.db, kernelCtx(ctx), {
          suggestionId: prediction.id,
          operationId: "synthetic-genuine-command",
          verdict: "correct",
          intent: "apply",
          application: { kind: "saved_field", recordId: record.id },
        }),
      { statements: 25, parameters: 7 },
    );
    expect(applied.applied).toBe(true);
  });

  it("retires a nonsearchable category projection while retaining immutable history", async () => {
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic retired category",
    });
    const prediction = await publishExactSuggestion(ctx.db, {
      ...publication(),
      publicationKey: "synthetic:category-lifecycle",
      subject: {
        ...publication().subject,
        entity: "productCategory",
        recordId: category.id,
      },
    });
    await executeEntity(kernelCtx(ctx), {
      action: "delete",
      entity: "productCategory",
      ids: [parseShortcodeFor("productCategory", category.shortcode)],
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(suggestionTable)
          .where(eq(suggestionTable.id, prediction.id))
      )[0],
    ).toMatchObject({ active: false, status: "superseded" });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(suggestionTable)
          .where(eq(suggestionTable.id, prediction.id))
      )[0]?.subject,
    ).toEqual(prediction.subject);
  });
  it("refuses invalid draft and saved intents before recording Feedback", async () => {
    const prediction = await publishExactSuggestion(ctx.db, publication());
    for (const command of [
      { intent: "draft" as const },
      {
        intent: "apply" as const,
        application: { kind: "saved_field" as const, recordId: "PRD-4K7M" },
      },
    ])
      await expect(
        reviewSuggestion(ctx.db, kernelCtx(ctx), {
          suggestionId: prediction.id,
          operationId: "synthetic:invalid",
          verdict: "wrong",
          correction: { present: true, value: "Synthetic invalid correction" },
          ...command,
        }),
      ).rejects.toThrow(/field Suggestion/);
    expect(await readSuggestionDecisions(ctx.db, prediction.id)).toEqual([]);
  });

  it("reuses a recommendation publication on unchanged repeated reads", async () => {
    const product = await productFixture(
      ctx,
      "Synthetic repeat recommendation",
    );
    const first = await assessRecommendation(
      ctx.db,
      product.id,
      "synthetic.related",
      ["same-candidate"],
      { evidence: "same" },
    );
    expect(
      await assessRecommendation(
        ctx.db,
        product.id,
        "synthetic.related",
        ["same-candidate"],
        { evidence: "same" },
      ),
    ).toEqual(first);
    expect(await getDb(ctx.db).select().from(suggestionTable)).toHaveLength(1);
  });

  it("retains corrected null and separates wrong from presentation suppression", async () => {
    const record = await productFixture(ctx, "Synthetic history subject");
    const subjectId = await recordId(ctx.db, record.id, "product");
    const original = publication();
    const first = await publishExactSuggestion(ctx.db, {
      ...original,
      subject: { ...original.subject, recordId: subjectId },
    });
    await recordFeedback(ctx.db, {
      suggestionId: first.id,
      operationId: "synthetic-review",
      verdict: "wrong",
      correction: { present: true, value: null },
      intent: "history",
      reason: null,
      evidence: null,
      authority: "member",
      actorUserId: null,
    });
    const [review] = await readSuggestionDecisions(ctx.db, first.id);
    expect(review?.correction).toEqual({ present: true, value: null });
    const [current] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.id, first.id));
    expect(current?.suppression).toBeNull();
    await executeEntity(kernelCtx(ctx), {
      action: "delete",
      entity: "product",
      ids: [record.id],
    });
    const [retired] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.id, first.id));
    expect(retired).toMatchObject({
      active: false,
      status: "superseded",
      suppression: null,
    });
    expect((await getDb(ctx.db).select().from(suggestionTable)).length).toBe(1);
    expect(
      (await getDb(ctx.db).select().from(suggestionTable))[0]?.subject,
    ).toMatchObject({ recordId: subjectId });
    expect(
      (await readSuggestionDecisions(ctx.db, first.id)).filter(
        (row) => row.authority === "member",
      ),
    ).toHaveLength(1);
  });
});
