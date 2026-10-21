import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { assessmentState, expense } from "~/server/db/schema";
import { project } from "~/server/db/schema";
import * as evidenceReader from "~/server/domains/connection/repo/connection-evidence";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";

import { captureDerivedRefresh } from "./capture";
import {
  nextConnectionRetirementWake,
  processConnectionRetirementPage,
} from "./connection-retirement";

// Queue reads may briefly retain old advice. Background retirement must preserve
// current evidence, resume across pages, and notice edits after a completed epoch.
describe("background connection retirement", () => {
  const ctx = withTestDb();
  it("preserves current advice and retires changed evidence after the write commits", async () => {
    const source = await createRepoEntity(ctx, "expense", {
      name: "Synthetic projection source",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const target = await createRepoEntity(ctx, "project", {
      name: "Synthetic projection project",
    });
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "expense-project",
      source: { entityKind: "expense", entityId: source.output.id },
      target: { entityKind: "project", entityId: target.output.id },
      label: "Synthetic project suggestion",
      evidence: { reasons: [], contradictions: [], unknowns: [] },
    });
    const field = await publishAssessment(
      ctx.db,
      {
        publicationKey: "synthetic-guarded-project-field",
        family: "field",
        subject: {
          kind: "field",
          entity: "expense",
          recordId: source.entityId,
          field: "projectId",
        },
        judgment: { value: target.output.id },
        fingerprint: "synthetic-field",
        producer: null,
        evidence: {},
      },
      {
        suggestedValue: target.output.id,
        data: {
          connectionEvidence: {
            version: 1,
            candidate: {
              relation: "expense-project",
              source: { entityKind: "expense", entityId: source.output.id },
              target: { entityKind: "project", entityId: target.output.id },
              label: "Synthetic field",
              evidence: { reasons: [], contradictions: [], unknowns: [] },
            },
            basis: await evidenceReader.captureConnectionBasis(ctx.db, {
              relation: "expense-project",
              source: { entityKind: "expense", entityId: source.output.id },
              target: { entityKind: "project", entityId: target.output.id },
              label: "Synthetic field",
              evidence: { reasons: [], contradictions: [], unknowns: [] },
            }),
          },
        },
      },
    );
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: true,
      processed: 2,
    });
    expect(await nextConnectionRetirementWake(ctx.db)).toBeNull();
    const status = async () =>
      (
        await getDb(ctx.db)
          .select({ status: assessmentState.status })
          .from(assessmentState)
          .where(eq(assessmentState.id, proposal.review.assessmentId))
      )[0]?.status;
    expect(await status()).toBe("pending");
    await getDb(ctx.db)
      .update(project)
      .set({ startDate: "2026-01-01" })
      .where(eq(project.id, target.entityId));
    await captureDerivedRefresh(ctx.db, [
      { entityKind: "project", entityId: target.entityId },
    ]);
    expect(await status()).toBe("pending");
    expect(await nextConnectionRetirementWake(ctx.db)).toBeInstanceOf(Date);
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: true,
      processed: 2,
    });
    expect(await status()).toBe("superseded");
    expect(
      (
        await getDb(ctx.db)
          .select({ status: assessmentState.status })
          .from(assessmentState)
          .where(eq(assessmentState.id, field.id))
      )[0]?.status,
    ).toBe("superseded");
    expect(await nextConnectionRetirementWake(ctx.db)).toBeNull();
  });
  it("finishes a bounded same-source epoch before restarting for intervening edits", async () => {
    const source = await createRepoEntity(ctx, "expense", {
      name: "Synthetic paged source",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const projects = [];
    for (let index = 0; index < 17; index++)
      projects.push(
        await createRepoEntity(ctx, "project", {
          name: `Synthetic paged target ${index}`,
        }),
      );
    const proposals = [];
    for (const target of projects)
      proposals.push(
        await publishEntityConnection(ctx.db, {
          relation: "expense-project",
          source: { entityKind: "expense", entityId: source.output.id },
          target: { entityKind: "project", entityId: target.output.id },
          label: "Synthetic paged connection",
          evidence: { reasons: [], contradictions: [], unknowns: [] },
        }),
      );
    const last = [...proposals]
      .sort((a, b) =>
        a.review.assessmentId.localeCompare(b.review.assessmentId),
      )
      .at(-1)!;
    await getDb(ctx.db)
      .update(expense)
      .set({ name: "Synthetic changed source" })
      .where(eq(expense.id, source.entityId));
    await captureDerivedRefresh(ctx.db, [
      { entityKind: "expense", entityId: source.entityId },
    ]);
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: false,
    });
    const status = async () =>
      (
        await getDb(ctx.db)
          .select({ status: assessmentState.status })
          .from(assessmentState)
          .where(eq(assessmentState.id, last.review.assessmentId))
      )[0]?.status;
    expect(await status()).toBe("pending");
    await captureDerivedRefresh(ctx.db, [
      { entityKind: "expense", entityId: source.entityId },
    ]);
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: false,
      processed: 1,
    });
    expect(await status()).toBe("superseded");
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: true,
    });
  });

  it("rolls back retirement when evidence changes again during preparation", async () => {
    const source = await createRepoEntity(ctx, "expense", {
      name: "Synthetic restored source",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const target = await createRepoEntity(ctx, "project", {
      name: "Synthetic race project",
    });
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "expense-project",
      source: { entityKind: "expense", entityId: source.output.id },
      target: { entityKind: "project", entityId: target.output.id },
      label: "Synthetic race",
      evidence: { reasons: [], contradictions: [], unknowns: [] },
    });
    await getDb(ctx.db)
      .update(expense)
      .set({ name: "Synthetic temporary change" })
      .where(eq(expense.id, source.entityId));
    await captureDerivedRefresh(ctx.db, [
      { entityKind: "expense", entityId: source.entityId },
    ]);
    const original = evidenceReader.forEachConnectionBasis;
    const capture = vi
      .spyOn(evidenceReader, "forEachConnectionBasis")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        await getDb(ctx.db)
          .update(expense)
          .set({ name: "Synthetic restored source" })
          .where(eq(expense.id, source.entityId));
        await captureDerivedRefresh(ctx.db, [
          { entityKind: "expense", entityId: source.entityId },
        ]);
      });
    try {
      expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
        done: false,
        processed: 0,
      });
    } finally {
      capture.mockRestore();
    }
    expect(
      (
        await getDb(ctx.db)
          .select({ status: assessmentState.status })
          .from(assessmentState)
          .where(eq(assessmentState.id, proposal.review.assessmentId))
      )[0]?.status,
    ).toBe("pending");
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: true,
      processed: 1,
    });
  });
});
