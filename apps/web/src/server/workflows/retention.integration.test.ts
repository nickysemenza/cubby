import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { image, imageProcessingJob } from "~/server/db/schema";
import { createTransparentDerivativeAndJob } from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";

const runRetention = async (db: import("~/server/db").Database) => {
  const { createKernel, defineModule, startPass } =
    await import("~/server/kernel/api");
  const { retentionPass } = await import("./retention-pass");
  await startPass(db, retentionPass);
  const kernel = createKernel([
    defineModule({
      name: "synthetic.retention",
      entities: [],
      evidence: [],
      asks: [],
      reconcilers: [],
      passes: [retentionPass],
    }),
  ]);
  await kernel.run(db, { budgetMs: 100 });
};

describe("Execution retention", () => {
  const ctx = withTestDb();

  const subjectLift = async () => {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "e".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const scheduled = await createTransparentDerivativeAndJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      sourceContentHash: hash,
      key: `pending/${crypto.randomUUID()}.png`,
    });
    if (!scheduled) throw new Error("Expected persisted image work");
    return scheduled.jobId;
  };

  it("reopens an image row a pre-cutover writer left leased", async () => {
    const jobId = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: crypto.randomUUID() })
      .where(eq(imageProcessingJob.id, jobId));
    await runRetention(ctx.db);
    const [processing] = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(processing?.state).toBe("pending");
  });

  it("prunes terminal Passes while retaining unfinished work", async () => {
    const { seedPass, readPasses } =
      await import("~/server/kernel/pass.fixtures");
    const old = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    for (const key of ["completed", "cancelled", "unfinished"])
      await seedPass(ctx.db, {
        name: "synthetic.retention",
        key,
        updatedAt: old,
        doneAt: key === "completed" ? old : null,
        cancelledAt: key === "cancelled" ? old : null,
      });
    await runRetention(ctx.db);
    expect(
      (await readPasses(ctx.db, { name: "synthetic.retention" })).map(
        (row) => row.key,
      ),
    ).toEqual(["unfinished"]);
  });
});
