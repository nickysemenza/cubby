import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb, TEST_USER_ID } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { executeEntity } from "~/server/entity-kernel";
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
import { captureDerivedRefresh } from "./capture";
import { currentInputRevision, fenceDerivedInputsAtCommit } from "./freshness";

// An old wave cannot retire a current judgment or overwrite a subsequent review.
describe("assessment invalidation boundaries", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

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
    const [advice] = await getDb(ctx.db)
      .insert(assessmentState)
      .values({
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
      })
      .returning();
    if (!advice) throw new Error("Synthetic advice missing");
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
    const rows = await getDb(ctx.db)
      .insert(assessmentState)
      .values(
        [fingerprint, "synthetic-old-basis"].map((liveInputFingerprint) => ({
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
        })),
      )
      .returning();
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
