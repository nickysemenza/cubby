import { and, eq, inArray } from "drizzle-orm";
import { TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { location } from "~/server/db/schema";
import {
  auditDateWhereConditions,
  getDb,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

describe("audit date filters", () => {
  const ctx = withTestDb();

  it("selects whole household days, not UTC days", async () => {
    // Timestamp columns hold UTC wall time. The household's Sep 1 runs from
    // 07:00Z Sep 1 to 07:00Z Sep 2 (PDT).
    const at = {
      "before household day": "2026-09-01T06:30:00Z",
      "household morning": "2026-09-01T15:00:00Z",
      "household evening": "2026-09-02T03:00:00Z",
      "after household day": "2026-09-02T07:30:00Z",
    };
    const ids = [];
    for (const [name, createdAt] of Object.entries(at)) {
      const row = await insertWithShortcode(ctx.db, "location", {
        name,
        type: "room",
        parentId: TEST_HOME_ID,
      });
      await getDb(ctx.db)
        .update(location)
        .set({ createdAt: new Date(createdAt) })
        .where(eq(location.id, row.id));
      ids.push(row.id);
    }

    const rows = await getDb(ctx.db)
      .select({ name: location.name })
      .from(location)
      .where(
        and(
          inArray(location.id, ids),
          ...auditDateWhereConditions(location, {
            createdFrom: "2026-09-01",
            createdTo: "2026-09-01",
          }),
        ),
      );
    expect(rows.map((row) => row.name).sort()).toEqual([
      "household evening",
      "household morning",
    ]);
  });
});
