import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer } from "~/server/mcp/server";
import { createTestRequestContext } from "~/server/testing/request-context";
import { productionJobHandlers } from "~/server/workflows/jobs";
import { enrollQueueMaintenance } from "~/server/workflows/queue-watchdog";

import { callMcpTool } from "../testing/mcp-test-utils";

// Review finding: before the watchdog's first publication job.health
// returned a bare null, which MCP structured success rejects (it requires
// an object), so the read failed until the first measurement.
describe("job.health over MCP", () => {
  const ctx = withTestDb("mcp");
  const health = () => {
    const request = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    return callMcpTool(
      createMcpServer(),
      "maintenance_read",
      { action: "health" },
      request,
      { entityKernel: entityKernelContextSchema.parse(request) },
    );
  };

  it("answers an object before and after the watchdog's first measurement", async () => {
    await enrollQueueMaintenance(ctx.db);
    const before = await health();
    expect(before.isError).not.toBe(true);
    expect(before.structuredContent).toEqual({ snapshot: null });
    const [watchdog] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "queue.watchdog"));
    if (!watchdog) throw new Error("Expected the watchdog Job");
    expect(await advanceJob(ctx.db, watchdog.id, productionJobHandlers)).toBe(
      "succeeded",
    );
    const after = await health();
    expect(after.isError).not.toBe(true);
    expect(after.structuredContent).toMatchObject({
      snapshot: { measuredAt: expect.any(String), alerts: expect.any(Array) },
    });
  });
});
