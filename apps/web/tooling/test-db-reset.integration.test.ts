import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "~/server/db/helpers";

import { withTestDb } from "./test-setup";

// The reset disables triggers with `session_replication_role = replica`. If
// that setting outlived its transaction, the pooled connection would silently
// stop enforcing foreign keys and running triggers for every later test.
describe("test database reset", () => {
  const ctx = withTestDb();

  it.each(["first", "second"])(
    "leaves the pooled session enforcing triggers after the %s reset",
    async () => {
      const { rows } = await getDb(ctx.db).execute<{ role: string }>(
        sql`SELECT current_setting('session_replication_role') AS role`,
      );
      expect(rows).toEqual([{ role: "origin" }]);
    },
  );
});
