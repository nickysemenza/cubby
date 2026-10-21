import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb, TEST_USER_ID } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  assessmentState,
  derivedRefreshFailure,
  searchDocument,
} from "~/server/db/schema";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { executeEntity } from "~/server/entity-kernel";
import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  prepareAssessmentRetirement,
  publishAssessmentRetirement,
} from "./assessment-retirement";
import * as retirement from "./assessment-retirement";
import { captureDerivedRefresh, foldDerivedRefreshCaptures } from "./capture";
import { currentInputRevision, fenceDerivedInputsAtCommit } from "./freshness";

// An old wave cannot retire a current judgment or overwrite a subsequent review.
describe("assessment invalidation boundaries", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
    vi.restoreAllMocks();
  });

  it("commits an ordinary edit before retiring its derived assessments", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic deferred assessment" }),
      ctx.actor,
    );
    const fingerprint = await fieldInputFingerprint(
      ctx.db,
      "product",
      subject.entityId,
      "tags",
    );
    const advice = await publishFieldAssessment(
      ctx.db,
      {
        entity: "product",
        recordId: subject.entityId,
        field: "tags",
        currentValue: [],
        suggestedValue: [],
        confidence: 0.5,
        model: "synthetic-model",
        kind: "correction",
        status: "pending",
        data: { liveInputFingerprint: fingerprint },
      },
      true,
    );
    await executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
      action: "update",
      entity: "product",
      id: subject.id,
      data: { aliases: ["Synthetic new assessment basis"] },
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, advice.id));
    expect(saved?.status).toBe("pending");
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      if (result.done) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    const [refreshed] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, advice.id));
    expect(refreshed?.status).toBe("superseded");
  });

  // An optional absence proof must never turn a retirement read failure into
  // a projection failure, and a full current page cannot hide a stale tail.
  it("publishes projection when the optional retirement proof fails and retains phase failure attribution", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic proof failure" }),
      ctx.actor,
    );
    await foldDerivedRefreshCaptures(ctx.db);
    vi.spyOn(retirement, "hasAssessmentRetirementCandidates").mockRejectedValue(
      new Error("Synthetic absence proof unavailable"),
    );
    vi.spyOn(retirement, "prepareAssessmentRetirement").mockRejectedValue(
      new Error("Synthetic retirement preparation unavailable"),
    );
    expect((await processDerivedRefreshPage(ctx.db)).errors).toEqual([]);
    const documents = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, subject.entityId));
    expect(documents.map((row) => row.title)).toEqual([
      "Synthetic proof failure",
    ]);
    expect(await getDb(ctx.db).select().from(derivedRefreshFailure)).toEqual(
      [],
    );
    expect((await processDerivedRefreshPage(ctx.db)).errors).toEqual([
      expect.stringContaining("Synthetic retirement preparation unavailable"),
    ]);
    const failures = await getDb(ctx.db).select().from(derivedRefreshFailure);
    expect(failures).toMatchObject([{ phase: "assessment", attempts: 1 }]);
  });

  it("reaches a stale retirement candidate beyond a full page of current judgments", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic retirement page boundary" }),
      ctx.actor,
    );
    const fingerprint = await fieldInputFingerprint(
      ctx.db,
      "product",
      subject.entityId,
      "tags",
    );
    const rows = await getDb(ctx.db)
      .insert(assessmentState)
      .values(
        Array.from({ length: 101 }, () => ({
          entity: "product",
          recordId: subject.entityId,
          field: "tags",
          currentValue: [],
          suggestedValue: [],
          confidence: 0.5,
          model: "synthetic-model",
          kind: "correction",
          status: "pending",
          data: { liveInputFingerprint: fingerprint },
        })),
      )
      .returning({ id: assessmentState.id });
    const stale = [...rows].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
    if (!stale) throw new Error("Synthetic tail judgment missing");
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ data: { liveInputFingerprint: "synthetic-old-basis" } })
      .where(eq(assessmentState.id, stale.id));
    for (let page = 0; page < 25; page++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      if (result.done) break;
    }
    const after = await getDb(ctx.db).select().from(assessmentState);
    expect(after.find((row) => row.id === stale.id)?.status).toBe("superseded");
    expect(
      after.filter((row) => row.id !== stale.id).map((row) => row.status),
    ).toEqual(Array.from({ length: 100 }, () => "pending"));
  });

  it("preserves current-basis judgments and rechecks review status on publication", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic current assessment" }),
      ctx.actor,
    );
    const fingerprint = await fieldInputFingerprint(
      ctx.db,
      "product",
      subject.entityId,
      "tags",
    );
    const rows = await Promise.all(
      [fingerprint, "synthetic-old-basis"].map((liveInputFingerprint) =>
        publishFieldAssessment(
          ctx.db,
          {
            entity: "product",
            recordId: subject.entityId,
            field: "tags",
            currentValue: ["Alpha"],
            suggestedValue: [],
            confidence: 0.5,
            model: "synthetic-model",
            kind: "correction",
            status: "pending",
            data: { liveInputFingerprint },
          },
          true,
        ),
      ),
    );
    const current = rows[0],
      stale = rows[1];
    if (!current || !stale) throw new Error("Synthetic judgments missing");
    const prepared = await prepareAssessmentRetirement(ctx.db, {
      entityKind: "product",
      entityId: subject.entityId,
      after: null,
    });
    expect(prepared.targets.map((row) => row.id)).toEqual([stale.id]);
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ status: "rejected" })
      .where(eq(assessmentState.id, stale.id));
    await withTransactionDatabase(ctx.db, (tx) =>
      publishAssessmentRetirement(tx, prepared),
    );
    const after = await getDb(ctx.db).select().from(assessmentState);
    expect(after.find((row) => row.id === current.id)?.status).toBe("pending");
    expect(after.find((row) => row.id === stale.id)?.status).toBe("rejected");
  });

  it("refuses publication invalidated later inside the same outer transaction", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic final-state fence" }),
      ctx.actor,
    );
    const revision = await currentInputRevision(ctx.db);
    await expect(
      withTransactionDatabase(ctx.db, async (outer) => {
        await withTransactionDatabase(outer, async (inner) => {
          await fenceDerivedInputsAtCommit(
            inner,
            revision,
            async () => "synthetic-semantic-basis",
          );
        });
        await captureDerivedRefresh(outer, [
          {
            entityKind: "product",
            entityId: subject.entityId,
            changedFields: ["name"],
          },
        ]);
      }),
    ).rejects.toThrow("Derived inputs changed later in the same transaction");
    expect(await currentInputRevision(ctx.db)).toBe(revision);
  });
});
