import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";

import { ensureRun } from "./ensure-run";

describe("ephemeral AI runs", () => {
  const ctx = withTestDb("mcp");

  it("preserves an unfinished keyed Run when its asynchronous starter replays", async () => {
    const input = {
      purpose: "background" as const,
      trigger: "scheduled" as const,
      status: "running" as const,
      clientKey: "synthetic-unfinished-work",
    };
    const first = await ensureRun(ctx.db, ctx.actor, input);
    expect(await ensureRun(ctx.db, ctx.actor, input)).toBe(first);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, first));
    expect(saved).toMatchObject({ status: "running", endedAt: null });
  });
  it("records an explicit causal parent without treating it as a retry predecessor", async () => {
    const parent = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const child = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "discovery",
      status: "running",
      parentRunId: parent,
      cause: "source_discovered",
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, child));
    expect(saved).toMatchObject({
      parentRunId: parent,
      predecessorRunId: null,
      cause: "source_discovered",
      attempt: 1,
    });
  });
});
