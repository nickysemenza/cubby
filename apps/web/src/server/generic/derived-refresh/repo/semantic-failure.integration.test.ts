import { testUserId } from "@cubby/schemas/testing";
import { eq, ne } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { derivedRefreshWork } from "~/server/db/schema";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { executeEntity } from "~/server/entity-kernel";
import * as search from "~/server/generic/search/repo/search-document";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { captureDerivedRefresh, foldDerivedRefreshCaptures } from "./capture";

// Scheduling epochs can change without changing a failed materialization's inputs.
describe("semantic phase failure budget", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
    vi.restoreAllMocks();
  });

  it("keeps unchanged input failures stopped across unrelated same-kind writes", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic failed projection" }),
      ctx.actor,
    );
    await foldDerivedRefreshCaptures(ctx.db);
    const publication = vi
      .spyOn(search, "publishPreparedSearchDocuments")
      .mockRejectedValue(new Error("Synthetic projection failure"));
    for (let attempt = 0; attempt < 3; attempt++) {
      await getDb(ctx.db)
        .update(derivedRefreshWork)
        .set({ availableAt: new Date(0) })
        .where(eq(derivedRefreshWork.entityId, subject.entityId));
      expect((await processDerivedRefreshPage(ctx.db)).errors).toHaveLength(1);
    }
    expect(publication).toHaveBeenCalledTimes(3);
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unrelated product" }),
      ctx.actor,
    );
    await foldDerivedRefreshCaptures(ctx.db);
    await getDb(ctx.db)
      .update(derivedRefreshWork)
      .set({ availableAt: new Date(Date.now() + 60_000) })
      .where(ne(derivedRefreshWork.entityId, subject.entityId));
    await captureDerivedRefresh(
      ctx.db,
      [{ entityKind: "product", entityId: subject.entityId }],
      { invalidate: false },
    );
    await foldDerivedRefreshCaptures(ctx.db);
    expect((await processDerivedRefreshPage(ctx.db)).errors).toEqual([]);
    expect(publication).toHaveBeenCalledTimes(3);
    await executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
      action: "update",
      entity: "product",
      id: subject.id,
      data: { name: "Synthetic changed projection" },
    });
    await foldDerivedRefreshCaptures(ctx.db);
    expect((await processDerivedRefreshPage(ctx.db)).errors).toHaveLength(1);
    expect(publication).toHaveBeenCalledTimes(4);
  });
});
