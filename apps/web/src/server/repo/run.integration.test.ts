import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run as runTable } from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import { getDb } from "./database-helpers";
import { getRunByShortcode, listRuns } from "./run";

describe("getRunByShortcode", () => {
  const ctx = withTestDb();

  // Regression: an AI run has no member party, so its party name reads null.
  // The Run output once declared that name non-null, and the Run detail page
  // failed validation for exactly the runs it was built to show.
  it("reads an AI run that has no member party", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });
    const [row] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));

    const run = await getRunByShortcode(ctx.db, row!.shortcode);

    expect(run).toMatchObject({
      purpose: "ai_action",
      ledgerPartyId: null,
      ledgerPartyName: null,
    });
  });
});

describe("listRuns", () => {
  const ctx = withTestDb();

  // Regression: the list once hid ephemeral runs unless a special flag was
  // set, so every Jev pass and AI action was missing from `/runs`.
  it("lists ephemeral AI runs unfiltered and by trigger", async () => {
    await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const page = { pageIndex: 0, pageSize: 50 };

    const all = await listRuns(ctx.db, {}, [], page);
    const ephemeral = await listRuns(
      ctx.db,
      { trigger: ["ephemeral"] },
      [],
      page,
    );
    const manual = await listRuns(ctx.db, { trigger: ["manual"] }, [], page);

    expect(all.data).toEqual([
      expect.objectContaining({ purpose: "ai_suggest", trigger: "ephemeral" }),
    ]);
    expect(ephemeral.data).toHaveLength(1);
    expect(manual.data).toHaveLength(0);
  });
});
