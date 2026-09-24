import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { appSettings } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { claimCatchUp } from "./catch-up-claim";

describe("catch-up cooldown claim", () => {
  const ctx = withTestDb();

  it("opens at the hour boundary without writing on a recent claim", async () => {
    const first = new Date("2026-09-23T00:00:00.000Z");
    expect(await claimCatchUp(ctx.db, first)).toBe(true);
    const [before] = await getDb(ctx.db)
      .select({ updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .where(sql`${appSettings.metadata} ? 'lastTriggeredAt'`);
    expect(
      await claimCatchUp(ctx.db, new Date(first.getTime() + 3_599_999)),
    ).toBe(false);
    const [after] = await getDb(ctx.db)
      .select({ updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .where(sql`${appSettings.metadata} ? 'lastTriggeredAt'`);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(
      await claimCatchUp(ctx.db, new Date(first.getTime() + 3_600_000)),
    ).toBe(true);
  });
});
