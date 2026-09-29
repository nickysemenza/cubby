/**
 * External verification for the 2026-09 consolidation migration (0002_cleanup).
 *
 *   # after maintenance mode starts, BEFORE migrating:
 *   pnpm --dir apps/web exec tsx scripts/verify-consolidation-cutover.ts snapshot \
 *     --database-url "$PRODUCTION_DIRECT_DATABASE_URL" --out ./cutover-pre.json
 *   # after the migration committed:
 *   pnpm --dir apps/web exec tsx scripts/verify-consolidation-cutover.ts verify \
 *     --database-url "$PRODUCTION_DIRECT_DATABASE_URL" --pre ./cutover-pre.json
 *
 * The migration's own checks are relative (they must also pass on empty test
 * databases). This script holds the absolute expectations: every metric the
 * pre-migration schema reports must reappear, reshaped, in the new schema. It
 * only runs aggregate SELECTs inside a READ ONLY transaction and prints counts,
 * never row contents. `verify` exits non-zero on any mismatch.
 *
 * `snapshot` queries the pre-migration schema (join tables, ProductExternalId,
 * sourceRefs, entityType, RunMutation, VendorMailSearchJob, ...); `verify`
 * queries the post-migration one. Neither mode works against the other schema.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { Client } from "pg";

export type Metrics = Record<string, number | string>;

interface Queryable {
  query<Row extends object>(text: string): Promise<{ rows: Row[] }>;
}

/** Tables whose row count the migration must not change. */
const UNCHANGED_TABLES = [
  "Expense",
  "Purchase",
  "Vendor",
  "FinancialAccount",
  "FinancialTransaction",
  "FinancialTransactionAllocation",
  "StatementRow",
  "StatementImport",
  "Product",
  "Ingredient",
  "Recipe",
  "RecipeSection",
  "RecipeSectionIngredient",
  "Location",
  "InventoryEntry",
  "Project",
  "Task",
  "Wish",
  "Planting",
  "GardenEntry",
  "Image",
  "ImageSighting",
  "EntityAttachment",
  "RunTarget",
  "AiUsage",
  "Meal",
  "MealFoodEntry",
  "MealRecipePortion",
] as const;

/** Pre-migration join table → EntityLink kind. */
const JOIN_TABLES = {
  WishCandidate: "wishCandidate",
  PurchaseProduct: "purchaseProduct",
  ProjectToolUsage: "projectTool",
  GardenEntryPlanting: "gardenEntryPlanting",
  ProductComponent: "productComponent",
  TaskDependency: "taskDependency",
  ProjectDependency: "projectDependency",
} as const;

/** Dependencies had no soft delete before; every row was live. */
const HARD_DELETE_JOIN_TABLES = new Set([
  "TaskDependency",
  "ProjectDependency",
]);

async function one(db: Queryable, sql: string): Promise<number> {
  const { rows } = await db.query<{ n: string | number }>(sql);
  return Number(rows[0]?.n ?? 0);
}

async function grouped(
  db: Queryable,
  prefix: string,
  sql: string,
  into: Metrics,
): Promise<void> {
  const { rows } = await db.query<{ k: string; n: string | number }>(sql);
  for (const row of rows) into[`${prefix}.${row.k}`] = String(row.n);
}

async function commonMetrics(db: Queryable, m: Metrics): Promise<void> {
  for (const table of UNCHANGED_TABLES)
    m[`rows.${table}`] = await one(db, `SELECT count(*) AS n FROM "${table}"`);
  // All money lives on Expense: spend per month, all and live, as exact text.
  await grouped(
    db,
    "spend",
    `SELECT coalesce(to_char(date_trunc('month', "date"), 'YYYY-MM'), 'undated') || (CASE WHEN "deletedAt" IS NULL THEN ':live' ELSE ':deleted' END) AS k,
            count(*) || '/' || coalesce(sum("cost"::numeric), 0)::text AS n
     FROM "Expense" GROUP BY 1`,
    m,
  );
  await grouped(
    db,
    "entity",
    `SELECT kind AS k, count(*) AS n FROM "Entity" WHERE kind NOT IN ('imageSighting', 'run') GROUP BY 1`,
    m,
  );
}

export async function snapshot(db: Queryable): Promise<Metrics> {
  const m: Metrics = {};
  await commonMetrics(db, m);
  for (const [table, kind] of Object.entries(JOIN_TABLES)) {
    const total = await one(db, `SELECT count(*) AS n FROM "${table}"`);
    m[`link.${kind}.total`] = total;
    m[`link.${kind}.live`] = HARD_DELETE_JOIN_TABLES.has(table)
      ? total
      : await one(
          db,
          `SELECT count(*) AS n FROM "${table}" WHERE "deletedAt" IS NULL`,
        );
  }
  m["xid.product"] = await one(
    db,
    `SELECT count(*) AS n FROM "ProductExternalId"`,
  );
  m["xid.settlement_ref"] = await one(
    db,
    `SELECT coalesce(sum(jsonb_array_length("sourceRefs")), 0) AS n FROM "FinancialTransaction" WHERE jsonb_typeof("sourceRefs") = 'array'`,
  );
  m["xid.page.expense"] = await one(
    db,
    `SELECT count(*) AS n FROM "Expense" WHERE "notionPageId" IS NOT NULL`,
  );
  m["xid.page.task"] = await one(
    db,
    `SELECT count(*) AS n FROM "Task" WHERE "notionPageId" IS NOT NULL`,
  );
  m["xid.page.project"] = await one(
    db,
    `SELECT count(*) AS n FROM "Project" WHERE "notionPageId" IS NOT NULL`,
  );
  m["xid.page.recipe"] = await one(
    db,
    `SELECT count(*) AS n FROM "Recipe" WHERE "SourceType" = 'Notion'`,
  );
  m["xid.folder.project"] = await one(
    db,
    `SELECT count(*) AS n FROM "Project" WHERE "googleDriveFolderUrl" IS NOT NULL`,
  );
  m["recipe.sourceUrl"] = await one(
    db,
    `SELECT count(*) AS n FROM "Recipe" WHERE "SourceType" = 'Website'`,
  );
  m["recipe.sourceLabel"] = await one(
    db,
    `SELECT count(*) AS n FROM "Recipe" WHERE "SourceType" = 'Book' AND "cookbookId" IS NULL AND "SourceData" IS NOT NULL`,
  );
  m["audit.total"] = await one(db, `SELECT count(*) AS n FROM "AuditLog"`);
  m["audit.unmirroredRunMutation"] = await one(
    db,
    `SELECT count(*) AS n FROM "RunMutation" WHERE "auditLogId" IS NULL`,
  );
  m["audit.image"] = await one(
    db,
    `SELECT count(*) AS n FROM "AuditLog" WHERE "entityType" = 'image'`,
  );
  m["audit.imageSighting"] = await one(
    db,
    `SELECT count(*) AS n FROM "AuditLog" WHERE "entityType" = 'imageSighting'`,
  );
  m["locationDescription.live"] = await one(
    db,
    `SELECT count(*) AS n FROM "Location" WHERE btrim(coalesce("aiDescription", '')) <> ''`,
  );
  m["run.mailSearch"] = await one(
    db,
    `SELECT count(*) AS n FROM "VendorMailSearchJob"`,
  );
  m["run.total"] = await one(db, `SELECT count(*) AS n FROM "Run"`);
  m["run.aiAction"] = await one(
    db,
    `SELECT count(*) AS n FROM "Run" WHERE purpose = 'ai_action'`,
  );
  // One keeper per clientKey, exactly as 60-runs groups them.
  m["run.aiActionGroups"] = await one(
    db,
    `SELECT count(DISTINCT channel || ':' || CASE WHEN channel = 'system' THEN '' ELSE "actorUserId" || ':' END || to_char(date_trunc('hour', "startedAt"), 'YYYY-MM-DD"T"HH24')) AS n FROM "Run" WHERE purpose = 'ai_action'`,
  );
  m["orderMail.pendingBytes"] = await one(
    db,
    `SELECT count(*) AS n FROM "OrderMailAttachment" WHERE "pendingDataBase64Url" IS NOT NULL`,
  );
  return m;
}

export async function observe(db: Queryable): Promise<Metrics> {
  const m: Metrics = {};
  await commonMetrics(db, m);
  for (const kind of Object.values(JOIN_TABLES)) {
    m[`link.${kind}.total`] = await one(
      db,
      `SELECT count(*) AS n FROM "EntityLink" WHERE kind = '${kind}'`,
    );
    m[`link.${kind}.live`] = await one(
      db,
      `SELECT count(*) AS n FROM "EntityLink" WHERE kind = '${kind}' AND "deletedAt" IS NULL`,
    );
  }
  m["xid.product"] = await one(
    db,
    `SELECT count(*) AS n FROM "EntityExternalId" WHERE "entityKind" = 'product'`,
  );
  m["xid.settlement_ref"] = await one(
    db,
    `SELECT count(*) AS n FROM "EntityExternalId" WHERE kind = 'settlement_ref'`,
  );
  for (const entity of ["expense", "task", "project", "recipe"])
    m[`xid.page.${entity}`] = await one(
      db,
      `SELECT count(*) AS n FROM "EntityExternalId" WHERE kind = 'page' AND "entityKind" = '${entity}'`,
    );
  m["xid.folder.project"] = await one(
    db,
    `SELECT count(*) AS n FROM "EntityExternalId" WHERE kind = 'folder' AND "entityKind" = 'project'`,
  );
  m["recipe.sourceUrl"] = await one(
    db,
    `SELECT count(*) AS n FROM "Recipe" WHERE "sourceUrl" IS NOT NULL`,
  );
  m["recipe.sourceLabel"] = await one(
    db,
    `SELECT count(*) AS n FROM "Recipe" WHERE "sourceLabel" IS NOT NULL`,
  );
  m["audit.total"] = await one(db, `SELECT count(*) AS n FROM "AuditLog"`);
  m["audit.image"] = await one(
    db,
    `SELECT count(*) AS n FROM "AuditLog" WHERE "entityKind" = 'image'`,
  );
  m["audit.imageSighting"] = await one(
    db,
    `SELECT count(*) AS n FROM "AuditLog" WHERE "entityKind" = 'imageSighting'`,
  );
  m["locationDescription.live"] = await one(
    db,
    `SELECT count(DISTINCT "entityId") AS n FROM "AiAnalysis" WHERE "entityKind" = 'location' AND feature = 'location-description' AND "deletedAt" IS NULL`,
  );
  m["run.mailSearch"] = await one(
    db,
    `SELECT count(*) AS n FROM "Run" WHERE purpose = 'mail_search'`,
  );
  m["run.total"] = await one(db, `SELECT count(*) AS n FROM "Run"`);
  m["run.entityMismatch"] = await one(
    db,
    `SELECT abs((SELECT count(*) FROM "Run") - (SELECT count(*) FROM "Entity" WHERE kind = 'run')) AS n`,
  );
  m["aiUsage.orphanRun"] = await one(
    db,
    `SELECT count(*) AS n FROM "AiUsage" u WHERE u."runId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Run" r WHERE r.id = u."runId")`,
  );
  m["entity.imageSighting"] = await one(
    db,
    `SELECT count(*) AS n FROM "Entity" WHERE kind = 'imageSighting'`,
  );
  m["orderMail.pendingBytes"] = await one(
    db,
    `SELECT count(*) AS n FROM "OrderMailAttachment" WHERE "pendingObjectKey" IS NOT NULL`,
  );
  return m;
}

/** Every mismatch between the pre snapshot and the post observation. */
export function compare(pre: Metrics, post: Metrics): string[] {
  const problems: string[] = [];
  const expect = (
    key: string,
    expected: number | string,
    actual: number | string | undefined,
  ) => {
    if (String(expected) !== String(actual))
      problems.push(`${key}: expected ${expected}, got ${actual ?? "missing"}`);
  };
  const derived = new Set([
    "audit.total",
    "audit.image",
    "audit.imageSighting",
    "audit.unmirroredRunMutation",
    "run.total",
    "run.aiAction",
    "run.aiActionGroups",
  ]);
  const keys = new Set([...Object.keys(pre), ...Object.keys(post)]);
  for (const key of keys) {
    if (
      derived.has(key) ||
      key.startsWith("run.entity") ||
      key.startsWith("aiUsage.") ||
      key === "entity.imageSighting"
    )
      continue;
    expect(key, pre[key] ?? "missing", post[key]);
  }
  expect(
    "audit.total",
    Number(pre["audit.total"]) + Number(pre["audit.unmirroredRunMutation"]),
    post["audit.total"],
  );
  // Sighting history moved onto images; unmirrored image attaches also land on image.
  if (
    Number(post["audit.image"]) <
    Number(pre["audit.image"]) + Number(pre["audit.imageSighting"])
  )
    problems.push(
      `audit.image: expected at least ${Number(pre["audit.image"]) + Number(pre["audit.imageSighting"])}, got ${post["audit.image"]}`,
    );
  expect("audit.imageSighting", 0, post["audit.imageSighting"]);
  expect("entity.imageSighting", 0, post["entity.imageSighting"]);
  expect("run.entityMismatch", 0, post["run.entityMismatch"]);
  expect("aiUsage.orphanRun", 0, post["aiUsage.orphanRun"]);
  // Throwaway ai_action runs collapse onto one keeper per group; mail-search
  // jobs already had their own Run, so they add none.
  expect(
    "run.total",
    Number(pre["run.total"]) -
      Number(pre["run.aiAction"]) +
      Number(pre["run.aiActionGroups"]),
    post["run.total"],
  );
  return problems;
}

async function withReadOnly<T>(
  url: string,
  run: (db: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await run(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "database-url": { type: "string" },
      out: { type: "string" },
      pre: { type: "string" },
    },
  });
  const mode = positionals[0];
  const url = values["database-url"];
  if (!url)
    throw new Error("--database-url is required (DATABASE_URL is ignored)");
  if (mode === "snapshot") {
    if (!values.out) throw new Error("snapshot needs --out <file>");
    const metrics = await withReadOnly(url, snapshot);
    writeFileSync(values.out, `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(
      `[verify] wrote ${Object.keys(metrics).length} metrics to ${values.out}`,
    );
    return;
  }
  if (mode === "verify") {
    if (!values.pre) throw new Error("verify needs --pre <file>");
    const pre: Metrics = JSON.parse(readFileSync(values.pre, "utf8"));
    const post = await withReadOnly(url, observe);
    const problems = compare(pre, post);
    for (const problem of problems)
      console.error(`[verify] MISMATCH ${problem}`);
    console.log(
      problems.length === 0
        ? `[verify] ok: ${Object.keys(post).length} metrics match`
        : `[verify] ${problems.length} mismatch(es)`,
    );
    if (problems.length > 0) process.exitCode = 1;
    return;
  }
  throw new Error("usage: verify-consolidation-cutover.ts snapshot|verify ...");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
