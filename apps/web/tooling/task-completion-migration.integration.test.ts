import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves historical deadlines without inventing completion dates", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261107131347_0118_executor_evaluation_slots",
    });
    const id = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'task', 'TSK-SYNTHETIC')`,
      [id],
    );
    await client.query(
      `INSERT INTO "Task" (id, shortcode, name, status, trade, "dueDate") VALUES ($1, 'TSK-SYNTHETIC', 'Clean synthetic gutters', 'done', 'other', '2030-01-01')`,
      [id],
    );
    const before = await client.query(`SELECT * FROM "Task" WHERE id = $1`, [
      id,
    ]);
    await migrateDatabase(db, {
      through: "20261107171449_0119_task_completion_date",
    });
    const after = await client.query(`SELECT * FROM "Task" WHERE id = $1`, [
      id,
    ]);
    expect(after.rows).toEqual(
      before.rows.map((row) => ({ ...row, completedOn: null })),
    );
  });
});
