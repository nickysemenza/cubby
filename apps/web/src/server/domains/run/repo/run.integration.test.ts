import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import type { ShortcodeGeneratorPort } from "~/server/generic/shortcode/repo/shortcode-utils";

import { readRunCatalogActivity } from "./catalog-activity";
import { getRunByShortcode, listRuns } from "./run";

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
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const [row] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));

    const run = await getRunByShortcode(ctx.db, row!.shortcode);

    expect(run).toMatchObject({
      purpose: "ai_suggest",
      ledgerPartyId: null,
      ledgerPartyName: null,
    });
  });
});

describe("ensureRun shortcode collisions", () => {
  const ctx = withTestDb();

  it("retries a used code for an unkeyed AI run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
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
      purpose: "ai_suggest",
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
  // set, so every decision pass and AI action was missing from `/runs`.
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

describe("Run catalog activity", () => {
  const ctx = withTestDb();

  it("separates latest starts from latest completions and excludes deleted runs", async () => {
    const first = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const later = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const running = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const deleted = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    for (const [id, startedAt, endedAt] of [
      [first, "2025-01-01T00:00:00Z", "2025-01-04T00:00:00Z"],
      [later, "2025-01-02T00:00:00Z", "2025-01-03T00:00:00Z"],
      [running, "2025-01-05T00:00:00Z", null],
      [deleted, "2025-01-06T00:00:00Z", "2025-01-07T00:00:00Z"],
    ] as const) {
      await getDb(ctx.db)
        .update(runTable)
        .set({
          startedAt: new Date(startedAt),
          endedAt: endedAt ? new Date(endedAt) : null,
        })
        .where(eq(runTable.id, id));
    }
    await getDb(ctx.db)
      .update(runTable)
      .set({ deletedAt: new Date("2025-01-08T00:00:00Z") })
      .where(eq(runTable.id, deleted));
    const activity = await readRunCatalogActivity(ctx.db);
    expect(
      activity.latest.find((row) => row.purpose === "ai_suggest"),
    ).toMatchObject({
      status: "running",
      startedAt: "2025-01-05T00:00:00.000Z",
    });
    expect(
      activity.completed.find((row) => row.purpose === "ai_suggest"),
    ).toMatchObject({
      startedAt: "2025-01-01T00:00:00.000Z",
      endedAt: "2025-01-04T00:00:00.000Z",
    });
    expect(
      activity.latest.find((row) => row.purpose === "background"),
    ).toMatchObject({ status: "completed" });
  });
});
