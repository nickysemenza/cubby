import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { importRun } from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import { getDb } from "./database-helpers";
import { getImportRunByShortcode } from "./import-run";

describe("getImportRunByShortcode", () => {
  const ctx = withTestDb();

  // Regression: an AI run has no member party, so its party name reads null.
  // The Run output once declared that name non-null, and the Run detail page
  // failed validation for exactly the runs it was built to show.
  it("reads an AI run that has no member party", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });
    const [row] = await getDb(ctx.db)
      .select({ shortcode: importRun.shortcode })
      .from(importRun)
      .where(eq(importRun.id, runId));

    const run = await getImportRunByShortcode(ctx.db, row!.shortcode);

    expect(run).toMatchObject({
      purpose: "ai_action",
      ledgerPartyId: null,
      ledgerPartyName: null,
    });
  });
});
