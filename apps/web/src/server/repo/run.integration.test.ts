import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run as runTable, vendorMailSearchJob } from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import { getDb } from "./database-helpers";
import { getRunByShortcode, listRuns } from "./run";
import type { ShortcodeGeneratorPort } from "./shortcode-utils";

const collisionGenerator = (
  first: string,
  second: string,
): ShortcodeGeneratorPort => {
  const codes = [first, second];
  return {
    generate: (entity) => parseShortcodeFor(entity, codes.shift() ?? second),
  };
};

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

  it("shows a failed Gmail search job's saved error on its Run detail", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "manual",
    });
    const [row] = await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed", failureCode: "vendor_mail_search_failed" })
      .where(eq(runTable.id, runId))
      .returning({ shortcode: runTable.shortcode });
    if (!row) throw new Error("test setup: Run missing");
    await getDb(ctx.db).insert(vendorMailSearchJob).values({
      runId,
      after: "2025/09/27",
      status: "failed",
      error: "Synthetic Gmail search failed at review count",
    });

    expect(await getRunByShortcode(ctx.db, row.shortcode)).toMatchObject({
      status: "failed",
      dispatchError: "Synthetic Gmail search failed at review count",
    });
  });
});

describe("ensureRun shortcode collisions", () => {
  const ctx = withTestDb();

  it("retries a used code for an unkeyed AI run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_action",
    });
    const [existing] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, existingId));
    const next = "RUN-YYYY";
    const id = await ensureRun(
      ctx.db,
      ctx.actor,
      { purpose: "ai_suggest" },
      collisionGenerator(existing!.shortcode, next),
    );
    const [created] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, id));
    expect(created?.shortcode).toBe(next);
  });

  it("retries a used code and reuses the same client-keyed run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_action",
    });
    const [existing] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, existingId));
    const key = "test:shared-suggestion-run";
    const next = "RUN-ZZZZ";
    const createdId = await ensureRun(
      ctx.db,
      ctx.actor,
      { purpose: "ai_suggest", clientKey: key },
      collisionGenerator(existing!.shortcode, next),
    );
    expect(
      await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        clientKey: key,
      }),
    ).toBe(createdId);
    const [created] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, createdId));
    expect(created?.shortcode).toBe(next);
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
