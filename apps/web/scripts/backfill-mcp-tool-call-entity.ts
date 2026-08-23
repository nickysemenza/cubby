/**
 * One-shot backfill: populate `McpToolCall.entity` for existing rows.
 *
 * Run this ONLY after the `entity` column (see `mcpToolCall` in
 * `apps/web/src/server/db/schema.ts`) has been migrated onto the production
 * table — it is nullable, so deploy-before-backfill is safe, but this script
 * will fail fast (Postgres "column does not exist") if run first.
 *
 * ## Coverage is NOT near-total — read this before trusting the summary
 *
 * `entity` can only be recovered for a call whose TOOL NAME alone names one
 * entity. Two disjoint sources feed the map built below:
 *
 * 1. **Manifest inversion** — every `get_/list_/create_/update_/delete_`
 *    (singular and batch-plural) name the entity manifest generates via
 *    `mcpToolName`/`mcpEntityPlural`, including override spellings like
 *    `search_products` (product's `mcpNames.overrides.list`) and
 *    `delete_recipe` (recipe's override). Built once, not per row.
 * 2. **Hand-authored map** — ~20 non-CRUD tools whose entity is unambiguous
 *    from what the tool DOES, even though it isn't a manifest CRUD name
 *    (`verify_product_images` → product, `split_expense` → expense, …).
 *    Confirmed against production's real toolName/count distribution
 *    (20,590 rows / 115 distinct names, 2026-08-02..2026-08-23) before this
 *    map was written — see the table below.
 *
 * What is PERMANENTLY unattributable for historical rows, and why — these
 * are excluded from the map on principle, not omission:
 *
 * - **`delete_entity`, `merge_entity`, `attach_entity`, `detach_entity`** —
 *   the current generic tools. Each call DID carry an entity/parentId
 *   argument, but the MCP telemetry event never persisted tool arguments
 *   (this table is deliberately payload-free), so there is nothing left to
 *   invert. Only calls made AFTER the runtime `telemetryEntity` extractor
 *   hook (see `_shared.ts` / `server.ts`) ships will carry it. Note some of
 *   these names still match a naming regex like `delete_.*` at a glance, so
 *   do not assume "matches a CRUD-shaped prefix" implies "in the map below".
 * - **`attach_file` / `attach_files`** (3,789 + 53 calls in the sample
 *   window — `attach_file` ALONE is ~18% of all MCP traffic) — the target
 *   entity is derived from `entityId`'s shortcode prefix at call time, and
 *   that argument was never persisted either. Fixed going forward once
 *   `image.tools.ts` gets a `telemetryEntity` extractor (see the report this
 *   script's author sent the root agent — it is a third file, owned by
 *   neither this backfill's author nor the `_shared.ts` owner).
 * - **`global_search`** — spans every searchable entity in one call.
 * - **`preview_entity_operation`** — spans whatever `entity` its own
 *   argument named, same non-persistence problem as delete/merge/attach.
 * - **`set_data_exception` / `clear_data_exception`** — apply across
 *   multiple entity kinds.
 * - **`record_statement_rows`** — targets a `StatementRow`, which is not a
 *   manifest `Entity` at all.
 *
 * In the production sample this script was validated against, those seven
 * names alone account for ~4,300 of 20,590 rows (~21%) that no backfill can
 * ever attribute. Combined with a handful of stray `find_*` tools that match
 * a "CRUD-shaped" naming heuristic but aren't manifest CRUD (e.g.
 * `find_recipes_using_ingredient`, `find_similar_entities`), real historical
 * coverage lands somewhat BELOW a naive per-name-shape estimate. Trust the
 * `remaining_by_tool` breakdown this script prints over any estimate in a
 * comment, including this one.
 *
 * Batched (single UPDATE per chunk of the name→entity map, not per row) and
 * idempotent: every UPDATE is scoped to `entity IS NULL`, so re-running only
 * touches rows a previous run — or a version of this map — missed.
 */
import "dotenv/config";
import type { Entity } from "@cubby/schemas/entity-core";
import {
  allEntities,
  type EntityDescriptor,
  entityManifest,
  mcpEntityPlural,
  mcpToolName,
} from "@cubby/schemas/entity-manifest";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to backfill McpToolCall.entity.");
  process.exit(1);
}

const CHUNK_SIZE = 25;

/**
 * Hand-authored: non-CRUD tools whose entity is unambiguous from what they
 * DO, confirmed against production's real toolName distribution. Kept here
 * (script-local), not in the manifest — this is historical-name cleanup for
 * a one-shot backfill, not a runtime contract. Going forward, these tools
 * get their own `telemetryEntity` extractor at registration (see the report
 * accompanying this PR) rather than growing this list.
 */
const HAND_MAPPED_TOOLS: Record<string, Entity> = {
  verify_product_images: "product",
  verify_products_images: "product",
  patch_product_external_ids: "product",
  patch_products_external_ids: "product",
  find_product_external_id_collisions: "product",
  merge_products: "product",
  attach_product_components: "product",
  detach_product_components: "product",
  split_expense: "expense",
  match_expenses: "expense",
  link_expenses_to_purchase: "expense",
  merge_purchases: "purchase",
  reclassify_purchase_document: "purchase",
  attach_purchase_products: "purchase",
  attach_project_resources: "project",
  detach_project_resources: "project",
  repoint_project_uses: "project",
  bulk_move_inventory: "inventory",
  explain_recipe_costing: "recipe",
  preview_financial_statement_import: "financialTransaction",
};

/** Build the full toolName → entity map once. */
function buildToolNameEntityMap(): Map<string, Entity> {
  const map = new Map<string, Entity>(Object.entries(HAND_MAPPED_TOOLS));

  for (const entity of allEntities) {
    const descriptor: EntityDescriptor = entityManifest[entity];
    for (const op of descriptor.mcp) {
      map.set(mcpToolName(entity, op), entity);
    }
    // Batch create/update tools are plural wrappers registerEntityCrudToolset
    // adds by default (`create_${plural}` / `update_${plural}`) — not
    // produced by `mcpToolName`, which only derives the five singular/plural
    // CRUD names. A name that was never actually registered (batch disabled,
    // or the entity lacks that op) simply matches zero rows below.
    if (descriptor.mcp.includes("create")) {
      map.set(`create_${mcpEntityPlural(entity)}`, entity);
    }
    if (descriptor.mcp.includes("update")) {
      map.set(`update_${mcpEntityPlural(entity)}`, entity);
    }
  }

  return map;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  const map = buildToolNameEntityMap();
  console.log(`toolName -> entity map built: ${map.size} names`);

  let totalUpdated = 0;
  for (const batch of chunk([...map.entries()], CHUNK_SIZE)) {
    const values = batch
      .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`)
      .join(",");
    const params = batch.flat();
    const result = await pool.query(
      `UPDATE "McpToolCall" AS mtc
         SET entity = v.entity
        FROM (VALUES ${values}) AS v(toolName, entity)
       WHERE mtc."toolName" = v.toolName AND mtc.entity IS NULL`,
      params,
    );
    totalUpdated += result.rowCount ?? 0;
  }
  console.log(`updated=${totalUpdated}`);

  const { rows: remaining } = await pool.query<{
    toolName: string;
    remaining: number;
  }>(
    `SELECT "toolName", count(*)::int AS remaining
       FROM "McpToolCall"
      WHERE entity IS NULL
      GROUP BY "toolName"
      ORDER BY remaining DESC`,
  );
  const remainingTotal = remaining.reduce((sum, row) => sum + row.remaining, 0);
  const { rows: totalRows } = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM "McpToolCall"`,
  );
  const total = totalRows[0]?.total ?? 0;

  console.log(
    `\ndone. total_rows=${total} attributed=${total - remainingTotal} ` +
      `(${total > 0 ? (((total - remainingTotal) / total) * 100).toFixed(1) : "0.0"}%) ` +
      `remaining_null=${remainingTotal}`,
  );
  console.log(
    "\nremaining_by_tool (some of these are PERMANENTLY unattributable — " +
      "see the file header, not a bug in this script):",
  );
  for (const row of remaining) {
    console.log(`  ${row.toolName}: ${row.remaining}`);
  }
} finally {
  await pool.end();
}
