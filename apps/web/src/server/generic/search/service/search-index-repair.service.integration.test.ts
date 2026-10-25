import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { getSearchDocumentEmbeddingText } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { productionJobHandlers } from "~/server/workflows/jobs";

import { repairSearchIndex } from "./search-index-repair.service";

// Explicit repair must commit ordinary Job intent, survive a disconnected
// reader, and publish through the same generation fence as stored derived recomputation.
describe("search repair admission", () => {
  const ctx = withTestDb();
  it("streams derived drain results while workers rebuild authoritative search text", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic repair subject" }),
      ctx.actor,
    );
    const stream = repairSearchIndex(ctx.db);
    const first = await stream.next();
    if (first.done) throw new Error("Expected repair progress");
    expect(first.value).toMatchObject({ type: "progress", phase: "sources" });
    for (let page = 0; page < 100; page++) {
      const executions = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "derived:drain"));
      if (executions.every((execution) => execution.state === "completed"))
        break;
      for (const execution of executions)
        await advanceJob(ctx.db, execution.id, productionJobHandlers);
    }
    let last = await stream.next();
    while (!last.done && last.value.type !== "done") last = await stream.next();
    if (last.done) throw new Error("Expected repair completion event");
    expect(last.value.type).toBe("done");
    expect(
      (
        await getSearchDocumentEmbeddingText(
          ctx.db,
          "product",
          subject.entityId,
        )
      )?.embeddingText,
    ).toContain("Synthetic repair subject");
    await stream.return();
  });

  it("leaves committed work queued after its status reader disconnects", async () => {
    const controller = new AbortController();
    const stream = repairSearchIndex(ctx.db, controller.signal);
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toThrow(/cancelled/i);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, "derived:drain"))
      )[0]?.state,
    ).toBe("queued");
  });
});
