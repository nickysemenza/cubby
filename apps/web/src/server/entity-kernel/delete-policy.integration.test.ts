import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
/**
 * Every declared delete disposition, checked at the database boundary.
 *
 * Each kernel entity's `lifecycle.delete` policy names what a delete does to
 * every incoming edge (`INCOMING_EDGES`). This matrix seeds a reference
 * universe, then for every (entity, edge) pair that has a live referencing
 * row, deletes one referenced target through the real kernel inside a
 * savepoint and asserts the edge's rows ended up exactly as the disposition
 * says:
 *
 * - `block` — the delete is refused and the target stays live;
 * - `soft-delete` — each referencing row is tombstoned (or gone, on a table
 *   with no `deletedAt`);
 * - `hard-delete` — each referencing row is gone;
 * - `detach` — each referencing row survives, live, with the FK cleared;
 * - `preserve` — each referencing row is untouched.
 *
 * Inside the savepoint, the target's rows on every other block edge are
 * tombstoned first, so each case measures its own edge rather than an
 * unrelated guard.
 * An edge the universe does not populate is reported as uncovered, and the
 * uncovered set is pinned: coverage can only grow by a test change.
 */
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { attachableImageEntityId } from "@cubby/schemas/image";
import { getTableColumns, type SQL, sql } from "drizzle-orm";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { withTestDb } from "tooling/test-setup";
import { seedEntity, TEST_HOME_SHORTCODE } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import {
  INCOMING_EDGES,
  type IncomingEdge,
} from "~/server/db/entity-incoming-edges";
import { executeEntity } from "~/server/entity-kernel";
import {
  ENTITY_KERNEL_ENTITIES,
  type EntityKernelEntity,
} from "~/server/entity-kernel/contracts";
import {
  buildKernelContext,
  collectShortcodePaths,
  describeError,
  type JsonPath,
  prefixOf,
  seedReferenceUniverse,
  setAtPath,
} from "~/server/entity-kernel/reference-universe.fixtures";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { databaseForTransaction, getDb } from "~/server/repo/database-helpers";
import { attachExistingImageToEntity } from "~/server/repo/image";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";

/**
 * Edges the seeded universe leaves without a live referencing row. Each is a
 * disposition this matrix cannot see; shrinking the list is the goal.
 */
const UNCOVERED_EDGES: readonly string[] = [
  "product ImportRunTarget.productId",
  "product MealFoodEntry.productId",
  "product Cookbook.productId",
  "product ProductMatchCandidate.productAId",
  "product ProductMatchCandidate.productBId",
  "product PhotoGroupProposal.productId",
  "recipe Recipe.forkedFromRecipeId",
  "ingredient MealFoodEntry.ingredientId",
  "location Location.parentId",
  "location PhotoGroupProposal.inventoryLocationId",
  "location Planting.locationId",
  "meal MealFoodEntry.mealId",
  "meal MealRecipePortion.mealId",
  "ledgerParty ImportRun.ledgerPartyId",
  "ledgerParty ImportSourceClaim.ledgerPartyId",
  "ledgerParty ImportFinding.ledgerPartyId",
  "ledgerParty ImportHunt.ledgerPartyId",
  "ledgerParty ExpenseAttribution.ledgerPartyId",
  "ledgerParty InventoryEntry.ownerLedgerPartyId",
  "ledgerParty MealRecipePortion.ledgerPartyId",
  "ledgerParty MealFoodEntry.ledgerPartyId",
  "ledgerParty PhotoGroupProposal.inventoryOwnerPartyId",
  "ledgerTransfer LedgerSourceClaim.ledgerTransferId",
  "vendor FinancialAccount.providerVendorId",
  "vendor ImportRun.vendorId",
  "vendor ImportHunt.vendorId",
  "purchase ImportRunTarget.purchaseId",
  "purchase ImportSourceClaim.purchaseId",
  "purchase PurchasePaymentEvidence.purchaseId",
  "financialAccount StatementRow.accountId",
  "financialTransaction ImportHunt.financialTransactionId",
  "expense ExpenseAttribution.expenseId",
  "expense LedgerSourceClaim.expenseId",
  "image ImportRunTarget.imageId",
  "image ImageProcessingJob.imageId",
  "image ImageDerivative.imageId",
  "image ImportPreparedOrder.primaryDocumentImageId",
  "image ImportPreparedOrder.screenshotImageId",
  "image ImportHunt.receiptImageId",
  "image OrderMailAttachment.imageId",
  "vendorAccount ImportRun.vendorAccountId",
  "vendorAccount ImportRunTarget.vendorAccountId",
  "vendorAccount ImportSourceClaim.vendorAccountId",
  "vendorAccount ImportHunt.vendorAccountId",
  "productCategory PhotoGroupProposal.productCreateCategoryId",
];

/**
 * Cases where the hand-written delete disagrees with its declared policy.
 * Pinned exactly, so a fix has to remove its line here.
 */
const KNOWN_DIVERGENCES: readonly string[] = [
  "ledgerParty VendorAccount.ledgerPartyId (block): delete was not refused",
  "ledgerParty MerchantVendorRule.ledgerPartyId (block): delete was not refused",
  "ledgerParty MailboxCursor.ledgerPartyId (block): delete was not refused",
  "ledgerParty OrderMail.ledgerPartyId (block): delete was not refused",
  "vendor VendorAccount.vendorId (block): delete was not refused",
  "vendor MerchantVendorRule.vendorId (block): delete was not refused",
  "vendor OrderMail.vendorId (block): delete was not refused",
  "vendorAccount Purchase.vendorAccountId (block): delete was not refused",
  "device AuditLog.deviceId (detach): a row was not detached",
];

const rowSchema = z.record(z.string(), z.unknown());
type DbRow = z.infer<typeof rowSchema>;
const rowsSchema = z.array(z.object({ row: rowSchema }));
const idRowsSchema = z.array(
  z.object({ id: z.string(), shortcode: z.string() }),
);

class Rollback extends Error {}

type EdgeCase = {
  entity: EntityKernelEntity;
  edge: string;
  disposition: OperationDisposition;
};

const deletableEntities = ENTITY_KERNEL_ENTITIES.filter(
  (entity) => entityManifest[entity].lifecycle.delete !== null,
);

const edgeOf = (entity: EntityKernelEntity, edge: string): IncomingEdge =>
  // SAFETY: policy keys are exhaustively checked against INCOMING_EDGES by
  // each policy's `satisfies IncomingEdgePolicy<E, …>`.
  (INCOMING_EDGES[entity] as Record<string, IncomingEdge>)[edge]!;

const physical = (edge: IncomingEdge) => {
  // SAFETY: INCOMING_EDGES is built only from Postgres schema columns.
  const column = edge.column as PgColumn;
  // SAFETY: as above — a Postgres column's table is a PgTable.
  const table = column.table as PgTable;
  const config = getTableConfig(table);
  const primary =
    config.primaryKeys[0]?.columns.map((c) => c.name) ??
    config.columns.filter((c) => c.primary).map((c) => c.name);
  return {
    tableName: config.name,
    columnName: column.name,
    primary,
    softDeletable: "deletedAt" in getTableColumns(table),
  };
};

const liveRow = (softDeletable: boolean) =>
  softDeletable ? sql`AND s."deletedAt" IS NULL` : sql``;

/** Live targets of `entity` that `edge` references, excluding `avoid`. */
const referencedTargets = async (
  db: Database,
  entity: EntityKernelEntity,
  edge: IncomingEdge,
): Promise<{ id: string; shortcode: string }[]> => {
  const { tableName, columnName, softDeletable } = physical(edge);
  const target = getTableConfig(SHORTCODE_TABLE[entity]).name;
  return idRowsSchema.parse(
    (
      await getDb(db).execute(sql`
        SELECT DISTINCT t."id"::text AS id, t."shortcode" AS shortcode
        FROM ${sql.identifier(tableName)} s
        JOIN ${sql.identifier(target)} t ON t."id"::text = s.${sql.identifier(columnName)}::text
        WHERE t."deletedAt" IS NULL ${liveRow(softDeletable)}
        ORDER BY 2
      `)
    ).rows,
  );
};

const referencingRows = async (
  db: Database,
  edge: IncomingEdge,
  targetId: string,
) => {
  const { tableName, columnName } = physical(edge);
  return rowsSchema
    .parse(
      (
        await getDb(db).execute(sql`
          SELECT to_jsonb(s.*) AS row FROM ${sql.identifier(tableName)} s
          WHERE s.${sql.identifier(columnName)}::text = ${targetId}
        `)
      ).rows,
    )
    .map(({ row }) => row);
};

const rowsByKey = async (
  db: Database,
  edge: IncomingEdge,
  rows: readonly DbRow[],
) => {
  const { tableName, primary } = physical(edge);
  const keyOf = (row: DbRow) =>
    JSON.stringify(primary.map((name) => row[name]));
  const all = rowsSchema
    .parse(
      (
        await getDb(db).execute(
          sql`SELECT to_jsonb(s.*) AS row FROM ${sql.identifier(tableName)} s`,
        )
      ).rows,
    )
    .map(({ row }) => row);
  const byKey = new Map(all.map((row) => [keyOf(row), row]));
  return rows.map((row) => byKey.get(keyOf(row)) ?? null);
};

const checkDisposition = async (
  db: Database,
  item: EdgeCase,
  target: { id: string; shortcode: string },
): Promise<string | null> => {
  const edge = edgeOf(item.entity, item.edge);
  const { columnName, softDeletable } = physical(edge);
  const before = (await referencingRows(db, edge, target.id)).filter(
    (row) => !softDeletable || row.deletedAt === null,
  );
  let error: string | null = null;
  try {
    await executeEntity(buildKernelContext(db), {
      action: "delete",
      entity: item.entity,
      ids: [target.shortcode],
    });
  } catch (err) {
    error = describeError(err);
  }
  const { effect } = item.disposition;
  if (effect === "block")
    return error === null ? "delete was not refused" : null;
  if (error !== null) return `delete failed: ${error}`;

  const after = await rowsByKey(db, edge, before);
  const wrong = after.flatMap((row, index) => {
    const was = before[index]!;
    switch (effect) {
      case "soft-delete":
        return (
          softDeletable ? row !== null && row.deletedAt !== null : row === null
        )
          ? []
          : ["a row was not removed"];
      case "hard-delete":
        return row === null ? [] : ["a row survived"];
      case "detach":
        // Cleared, or promoted to a surviving row (`Location.parentId`).
        return row !== null &&
          row[columnName] !== target.id &&
          (!softDeletable || row.deletedAt === null)
          ? []
          : ["a row was not detached"];
      case "preserve":
        return row !== null && row[columnName] === was[columnName]
          ? []
          : ["a row changed"];
      default:
        return [`${effect} is not a delete effect`];
    }
  });
  return wrong.length > 0 ? [...new Set(wrong)].join("; ") : null;
};

const liveTargets = async (db: Database, entity: EntityKernelEntity) =>
  idRowsSchema.parse(
    (
      await getDb(db).execute(sql`
        SELECT t."id"::text AS id, t."shortcode" AS shortcode
        FROM ${sql.identifier(getTableConfig(SHORTCODE_TABLE[entity]).name)} t
        WHERE t."deletedAt" IS NULL ORDER BY 2
      `)
    ).rows,
  );

/** A literal for a required column no reference decides, by column type. */
const filler = (column: PgColumn): string | number | boolean | null => {
  const [first] = column.enumValues ?? [];
  if (first !== undefined) return first;
  switch (column.columnType) {
    case "PgUUID":
      return crypto.randomUUID();
    case "PgText":
    case "PgVarchar":
      return `delete-policy-${crypto.randomUUID()}`;
    case "PgInteger":
    case "PgSmallInt":
    case "PgBigInt53":
    case "PgNumeric":
    case "PgReal":
    case "PgDoublePrecision":
      return 1;
    case "PgBoolean":
      return false;
    case "PgTimestamp":
      return new Date().toISOString();
    case "PgDate":
      return "2024-01-15";
    case "PgJsonb":
    case "PgJson":
      return "{}";
    case "PgArray":
      return "{}";
    default:
      return null;
  }
};

/**
 * Make one live source row of `edge` name `targetId`, in its own savepoint:
 * re-point an existing row, or insert a minimal one (required columns only,
 * references onto live rows). `false` when a constraint refuses both.
 */
const pointEdgeAt = async (
  db: Database,
  edge: IncomingEdge,
  targetId: string,
): Promise<boolean> => {
  const { tableName, columnName, softDeletable, primary } = physical(edge);
  const table = sql.identifier(tableName);
  const column = sql.identifier(columnName);
  const attempt = (statement: SQL) =>
    getDb(db)
      .transaction(
        async (tx) => ((await tx.execute(statement)).rowCount ?? 0) > 0,
      )
      .catch(() => false);
  const repointed = await attempt(sql`
    UPDATE ${table} SET ${column} = ${targetId}
    WHERE ctid = (
      SELECT s.ctid FROM ${table} s
      WHERE s.${column} IS DISTINCT FROM ${targetId}
        ${primary.includes("id") ? sql`AND s."id"::text <> ${targetId}` : sql``}
        ${liveRow(softDeletable)}
      LIMIT 1
    )
  `);
  if (repointed) return true;

  // SAFETY: INCOMING_EDGES is built only from Postgres schema columns.
  const config = getTableConfig((edge.column as PgColumn).table as PgTable);
  const values = new Map<string, SQL>();
  for (const fk of config.foreignKeys) {
    const reference = fk.reference();
    const [local] = reference.columns;
    if (!local?.notNull || local.name === columnName) continue;
    const foreign = getTableConfig(reference.foreignTable).name;
    const [row] = z.array(z.object({ id: z.string() })).parse(
      (
        await getDb(db).execute(sql`
            SELECT f.${sql.identifier(reference.foreignColumns[0]!.name)}::text AS id
            FROM ${sql.identifier(foreign)} f
            WHERE f.${sql.identifier(reference.foreignColumns[0]!.name)}::text <> ${targetId}
            LIMIT 1
          `)
      ).rows,
    );
    if (!row) return false;
    values.set(local.name, sql`${row.id}`);
  }
  values.set(columnName, sql`${targetId}`);
  for (const col of config.columns) {
    if (values.has(col.name) || !col.notNull || col.hasDefault) continue;
    const value = filler(col);
    if (value === null) return false;
    values.set(col.name, sql`${value}`);
  }
  const names = [...values.keys()];
  return attempt(sql`
    INSERT INTO ${table} (${sql.join(
      names.map((name) => sql.identifier(name)),
      sql`, `,
    )})
    VALUES (${sql.join(
      names.map((name) => values.get(name)!),
      sql`, `,
    )})
  `);
};

/** Fields a create requires beyond its references (see list smoke). */
const ENRICH_EXTRAS = new Map<
  EntityKernelEntity,
  { trade: string; date?: string }
>([
  ["task", { trade: "drywall" }],
  ["expense", { trade: "drywall", date: "2024-01-15" }],
]);

/**
 * Tombstone the live rows that reference `targetId` over the block edges, so
 * a non-block edge whose every target is also blocked can still be measured.
 * `false` when a blocker lives on a table with no `deletedAt`.
 */
const clearBlockers = async (
  db: Database,
  blockEdges: readonly IncomingEdge[],
  measured: IncomingEdge,
  targetId: string,
): Promise<boolean> => {
  const own = physical(measured);
  for (const edge of blockEdges) {
    const { tableName, columnName, softDeletable } = physical(edge);
    // A row that also names the target over the measured edge stays.
    const keep =
      tableName === own.tableName
        ? sql`AND ${sql.identifier(own.columnName)}::text IS DISTINCT FROM ${targetId}`
        : sql``;
    const [row] = rowsSchema.parse(
      (
        await getDb(db).execute(sql`
          SELECT to_jsonb(s.*) AS row FROM ${sql.identifier(tableName)} s
          WHERE ${sql.identifier(columnName)}::text = ${targetId} ${keep}
          LIMIT 1
        `)
      ).rows,
    );
    if (!row) continue;
    if (!softDeletable) return false;
    await getDb(db).execute(sql`
      UPDATE ${sql.identifier(tableName)} SET "deletedAt" = now()
      WHERE ${sql.identifier(columnName)}::text = ${targetId} ${keep}
    `);
  }
  return true;
};

/**
 * A second row of every creatable entity with every optional shortcode
 * reference filled onto a seeded row, and an image on every gallery row —
 * the optional edges the base universe leaves empty.
 */
async function enrichUniverse(
  db: Database,
  shortcodeByPrefix: ReadonlyMap<string, string>,
) {
  for (const entity of ENTITY_KERNEL_ENTITIES) {
    const schema = ENTITY_KERNEL_BINDINGS[entity].schemas.createInput;
    if (!schema) continue;
    try {
      const probe = mock(schema, { seed: 4242, fillOptionals: true });
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a sparse patch over the entity's own createInput shape
      const overrides: Record<string, unknown> = {};
      const found: Array<{ path: JsonPath; code: string }> = [];
      collectShortcodePaths(probe, [], found);
      for (const { path, code } of found) {
        const prefix = prefixOf(code);
        const real = prefix ? shortcodeByPrefix.get(prefix) : undefined;
        if (real) setAtPath(overrides, path, real);
      }
      Object.assign(overrides, ENRICH_EXTRAS.get(entity));
      // SAFETY: seedEntity re-validates the merged sample through the real
      // createInput schema before the kernel sees it.
      await seedEntity(db, entity, overrides as never);
    } catch {
      // A create that refuses this combination leaves its edges uncovered.
    }
  }
  const image = await createImageFixture(db, "delete-policy");
  for (const code of shortcodeByPrefix.values()) {
    if (!attachableImageEntityId.safeParse(code).success) continue;
    await attachExistingImageToEntity(
      db,
      { imageId: image.shortcode, targetId: code },
      buildKernelContext(db).actorContext,
    ).catch(() => undefined);
  }
}

describe("entity delete policy — declared dispositions at the DB boundary", () => {
  const ctx = withTestDb();

  it("applies every block, detach and cascade disposition", async () => {
    const universe = await seedReferenceUniverse(ctx.db);
    await enrichUniverse(ctx.db, universe.shortcodeByPrefix);

    const failures: string[] = [];
    const uncovered: string[] = [];
    let covered = 0;
    for (const entity of deletableEntities) {
      const policy = ENTITY_KERNEL_BINDINGS[entity].lifecycle.delete;
      const blockEdges = Object.entries(policy)
        .filter(([, disposition]) => disposition.effect === "block")
        .map(([edge]) => edgeOf(entity, edge));
      const blocked = new Set<string>();
      for (const edge of blockEdges)
        for (const target of await referencedTargets(ctx.db, entity, edge))
          blocked.add(target.id);

      for (const [edge, disposition] of Object.entries(policy)) {
        const item = { entity, edge, disposition };
        const referenced = await referencedTargets(
          ctx.db,
          entity,
          edgeOf(entity, edge),
        );
        // No live reference: point one existing source row at a live target
        // inside the savepoint instead.
        const synthetic = referenced.length === 0;
        const pool = (
          synthetic ? await liveTargets(ctx.db, entity) : referenced
        ).filter((row) => row.shortcode !== TEST_HOME_SHORTCODE);
        // The house root is undeletable by design, whatever references it.
        const target =
          disposition.effect === "block"
            ? pool[0]
            : (pool.find((row) => !blocked.has(row.id)) ?? pool[0]);
        if (!target) {
          uncovered.push(`${entity} ${edge}`);
          continue;
        }
        await getDb(ctx.db)
          .transaction(async (tx) => {
            const db = databaseForTransaction(tx);
            if (
              synthetic &&
              !(await pointEdgeAt(db, edgeOf(entity, edge), target.id))
            ) {
              uncovered.push(`${entity} ${edge}`);
              throw new Rollback();
            }
            // Every other guard is cleared, so a refusal is this edge's own.
            const others = blockEdges.filter(
              (other) => other !== edgeOf(entity, edge),
            );
            if (
              !(await clearBlockers(
                db,
                others,
                edgeOf(entity, edge),
                target.id,
              ))
            ) {
              uncovered.push(`${entity} ${edge}`);
              throw new Rollback();
            }
            covered += 1;
            const problem = await checkDisposition(db, item, target);
            if (problem)
              failures.push(
                `${entity} ${edge} (${disposition.effect}): ${problem}`,
              );
            throw new Rollback();
          })
          .catch((err) => {
            if (!(err instanceof Rollback)) throw err;
          });
      }
    }

    // Joined, not `toEqual`: vitest elides long arrays to `…(n)`.
    expect(
      failures.join("\n"),
      `${failures.length} of ${covered} delete disposition(s) disagree with the database`,
    ).toBe(KNOWN_DIVERGENCES.join("\n"));
    expect(uncovered).toEqual(UNCOVERED_EDGES);
  }, 300_000);
});
