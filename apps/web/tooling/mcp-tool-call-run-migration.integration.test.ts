import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// The surface split relabels only the in-app agent's historical calls; their
// Run was never recorded, so runId stays null for every existing row.
it("relabels historical agent MCP calls and preserves every other call", async () => {
  await withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0091_sweeps_maintenance_automatic_rules",
    });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-mcp-migration','Example Member','member@example.invalid')`);
    await client.query(`INSERT INTO "McpToolCall"
      ("toolName",outcome,"registeredAtCall",surface,release,"occurredAt","userId","clientId")
      VALUES
        ('entity_read','success',true,'external_mcp','synthetic','2026-10-01','synthetic-mcp-migration','cubby-purchase-agent'),
        ('entity_read','success',true,'external_mcp','synthetic','2026-10-01','synthetic-mcp-migration','synthetic-client'),
        ('search','error',true,'external_mcp','synthetic','2026-10-01','synthetic-mcp-migration',NULL)`);
    const before = (
      await client.query(`SELECT * FROM "McpToolCall" ORDER BY id`)
    ).rows;

    await migrateDatabase(drizzle(client), {
      through: "0092_mcp_tool_call_run",
    });

    expect(
      (await client.query(`SELECT * FROM "McpToolCall" ORDER BY id`)).rows,
    ).toEqual(
      before.map((row) => ({
        ...row,
        surface:
          row.clientId === "cubby-purchase-agent"
            ? "in_app_agent"
            : row.surface,
        runId: null,
      })),
    );
  });
});
