import "dotenv/config";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for the entity-integrity preflight.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

const count = async (query: string): Promise<number> => {
  const result = await pool.query<{ count: number }>(query);
  return result.rows[0]?.count ?? 0;
};

const dependencyCycleCount = (table: string, own: string, blockedBy: string) =>
  count(`
    WITH RECURSIVE walk(start_id, current_id, path, cycle) AS (
      SELECT d."${own}", d."${blockedBy}",
             ARRAY[d."${own}", d."${blockedBy}"]::uuid[],
             d."${own}" = d."${blockedBy}"
        FROM "${table}" d
      UNION ALL
      SELECT walk.start_id, d."${blockedBy}",
             walk.path || d."${blockedBy}",
             d."${blockedBy}" = ANY(walk.path)
        FROM walk
        JOIN "${table}" d ON d."${own}" = walk.current_id
       WHERE NOT walk.cycle
         AND cardinality(walk.path) <= (SELECT count(*) + 1 FROM "${table}")
    )
    SELECT count(DISTINCT start_id)::int AS count FROM walk WHERE cycle
  `);

const verifyConstraints = async () => {
  const expected = [
    "Location_parentId_Location_id_fk",
    "Location_productId_type_check",
    "ProjectDependency_no_self_check",
    "TaskDependency_no_self_check",
  ];
  const result = await pool.query<{
    conname: string;
    convalidated: boolean;
    definition: string;
  }>(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname`,
    [expected],
  );
  const found = new Map(result.rows.map((row) => [row.conname, row]));
  let failed = false;
  for (const name of expected) {
    const row = found.get(name);
    if (!row) {
      failed = true;
      console.error(`${name}: missing`);
      continue;
    }
    if (!row.convalidated) failed = true;
    console.log(
      `${name}: ${row.convalidated ? "validated" : "NOT VALIDATED"} — ${row.definition}`,
    );
  }
  if (failed) process.exitCode = 1;
};

try {
  if (process.argv.includes("--verify")) {
    await verifyConstraints();
  } else {
    const checks = [
      {
        name: "orphan Location parents",
        value: await count(`
          SELECT count(*)::int AS count
            FROM "Location" child
            LEFT JOIN "Location" parent ON parent.id = child."parentId"
           WHERE child."parentId" IS NOT NULL AND parent.id IS NULL
        `),
      },
      {
        name: "Locations with productId and type",
        value: await count(`
          SELECT count(*)::int AS count
            FROM "Location"
           WHERE "productId" IS NOT NULL AND type IS NOT NULL
        `),
      },
      {
        name: "Project dependency cycle members",
        value: await dependencyCycleCount(
          "ProjectDependency",
          "projectId",
          "blockedByProjectId",
        ),
      },
      {
        name: "Task dependency cycle members",
        value: await dependencyCycleCount(
          "TaskDependency",
          "taskId",
          "blockedByTaskId",
        ),
      },
    ];

    for (const check of checks) console.log(`${check.name}: ${check.value}`);
    if (checks.some((check) => check.value > 0)) {
      console.error(
        "Entity-integrity migration blocked. Repair every reported row explicitly and rerun the preflight.",
      );
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
