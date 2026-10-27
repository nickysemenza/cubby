import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { claimJob, failJob } from "~/server/generic/jobs/repo/external-claim";
import { retryJob } from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

// A delayed delete of an interrupted physical upload must never delete a retry.
// Retrying uses a new ID while keeping the old error and cleanup receipt intact.
describe("embedding execution identity", () => {
  const ctx = withTestDb();
  it("retries with a fresh physical ID after cleanup admission", async () => {
    const old = await enqueueJob(ctx.db, {
      key: "embedding:synthetic:source:hash",
      kind: "embedding.refresh",
      input: {},
      maxAttempts: 1,
    });
    const claim = await claimJob(ctx.db, old.id);
    if (!claim) throw new Error("Expected embedding claim");
    await failJob(ctx.db, claim, new Error("Synthetic upload interrupted"));
    const cleanup = await enqueueJob(ctx.db, {
      key: `embedding-cleanup:${old.id}`,
      kind: "embedding.cleanup",
      input: { artifactId: old.id },
    });
    const next = await retryJob(ctx.db, old.id);
    expect(next?.id).not.toBe(old.id);
    expect(next?.key).toBe(old.key);
    expect(next?.state).toBe("queued");
    const [retained] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, old.id));
    expect(retained?.state).toBe("failed");
    expect(retained?.error).toContain("Synthetic upload interrupted");
    expect(cleanup.input).toEqual({ artifactId: old.id });
  });
});
