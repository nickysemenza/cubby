import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  householdLocalDate,
  householdDateTime,
  shiftPlainDate,
} from "~/lib/household-date";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, expense } from "~/server/db/schema";
import { project } from "~/server/db/schema";
import * as evidenceReader from "~/server/domains/connection/repo/connection-evidence";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { prepareAssessmentRetirement } from "./assessment-retirement";
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
    const [original] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    if (!original) throw new Error("Synthetic legacy assessment missing");
    const legacyId = "11111111-1111-1111-1111-111111111111";
    await getDb(ctx.db)
      .insert(assessment)
      .values({
        ...original,
        id: legacyId,
        publicationKey: "synthetic-retained-guid",
      });
    await getDb(ctx.db)
      .insert(assessmentState)
      .values({
        id: legacyId,
        family: "recommendation",
        entity: "expense",
        recordId: source.entityId,
        field: "",
        status: "pending",
        data: { connection: true },
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
      processed: 3,
    });
    expect(await nextConnectionRetirementWake(ctx.db)).toBeNull();
    expect(
      (
        await prepareAssessmentRetirement(ctx.db, {
          entityKind: "expense",
          entityId: source.entityId,
          after: null,
        })
      ).targets.map((row) => row.id),
    ).not.toContain(field.id);
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
      processed: 3,
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
  it("retries without advancing when an endpoint disappears during preparation", async () => {
    const source = await createRepoEntity(ctx, "expense", {
      name: "Synthetic deletion source",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const target = await createRepoEntity(ctx, "project", {
      name: "Synthetic deletion target",
    });
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "expense-project",
      source: { entityKind: "expense", entityId: source.output.id },
      target: { entityKind: "project", entityId: target.output.id },
      label: "Synthetic deletion race",
      evidence: { reasons: [], contradictions: [], unknowns: [] },
    });
    const original = evidenceReader.forEachConnectionBasis;
    const capture = vi
      .spyOn(evidenceReader, "forEachConnectionBasis")
      .mockImplementationOnce(async (...args) => {
        await getDb(ctx.db)
          .update(project)
          .set({ deletedAt: new Date() })
          .where(eq(project.id, target.entityId));
        await captureDerivedRefresh(ctx.db, [
          { entityKind: "project", entityId: target.entityId },
        ]);
        await original(...args);
      });
    try {
      expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
        done: false,
        processed: 0,
      });
    } finally {
      capture.mockRestore();
    }
    expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
      done: true,
      processed: 1,
    });
    expect(
      (
        await getDb(ctx.db)
          .select({ status: assessmentState.status })
          .from(assessmentState)
          .where(eq(assessmentState.id, proposal.review.assessmentId))
      )[0]?.status,
    ).toBe("superseded");
  });

  it("wakes date-dependent evidence at the next household day without a write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(householdDateTime("2026-09-09", 12 * 60));
      const source = await createRepoEntity(ctx, "project", {
        name: "Synthetic timed project",
        startDate: "2026-09-10",
      });
      const target = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic timed tool" }),
        ctx.actor,
      );
      await publishEntityConnection(ctx.db, {
        relation: "project-tool",
        source: { entityKind: "project", entityId: source.output.id },
        target: { entityKind: "product", entityId: target.id },
        label: "Synthetic date-dependent tool",
        evidence: { reasons: [], contradictions: [], unknowns: [] },
      });
      expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
        done: true,
        processed: 1,
      });
      const nextDay = householdDateTime(
        shiftPlainDate(householdLocalDate(), 1),
      );
      expect(await nextConnectionRetirementWake(ctx.db)).toEqual(nextDay);
      vi.setSystemTime(nextDay);
      expect(await nextConnectionRetirementWake(ctx.db)).toEqual(nextDay);
      expect(await processConnectionRetirementPage(ctx.db)).toMatchObject({
        done: true,
        processed: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
