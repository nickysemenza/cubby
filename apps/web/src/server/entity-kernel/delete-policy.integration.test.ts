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
import {
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import type {
  DeviceId,
  ExpenseId,
  FinancialAccountId,
  FinancialTransactionId,
  ImageId,
  IngredientId,
  LedgerPartyId,
  LedgerTransferId,
  LocationId,
  MealId,
  ProductCategoryId,
  ProductId,
  PurchaseId,
  RecipeId,
  RunId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { attachableImageEntityId } from "@cubby/schemas/image";
import { generateShortcode } from "@cubby/shared";
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
import {
  run as runTable,
  expenseAttribution,
  importHunt,
  importPreparedOrder,
  importSourceClaim,
  imageDerivative,
  imageProcessingJob,
  ledgerSourceClaim,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  orderMail,
  orderMailAttachment,
  photoGroupProposal,
  productMatchCandidate,
  runFinding,
  runTarget,
  statementImport,
  statementRow,
} from "~/server/db/schema";
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
import {
  databaseForTransaction,
  getDb,
  insertAndReturn,
} from "~/server/repo/database-helpers";
import { attachExistingImageToEntity } from "~/server/repo/image";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  insertWithShortcode,
  SHORTCODE_TABLE,
} from "~/server/repo/shortcode-utils";

/**
 * Edges the seeded universe leaves without a live referencing row. Each is a
 * disposition this matrix cannot see; shrinking the list is the goal.
 *
 * Empty: every declared incoming edge now has a live source row somewhere in
 * the universe (the base reference universe, `enrichUniverse`'s second pass,
 * or this file's direct staging-table seeds for the tables no kernel create
 * reaches), so this matrix currently sees every edge's real disposition.
 */
const UNCOVERED_EDGES: readonly string[] = [];

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
 * Measure one edge against one target inside a rolled-back savepoint.
 * `false` when this target cannot isolate the edge (no source row could be
 * pointed at it, or another edge's blocker could not be cleared).
 */
async function measureEdge(
  db: Database,
  {
    item,
    target,
    synthetic,
    blockEdges,
    failures,
  }: {
    item: Parameters<typeof checkDisposition>[1];
    target: Parameters<typeof checkDisposition>[2];
    synthetic: boolean;
    blockEdges: readonly IncomingEdge[];
    failures: string[];
  },
): Promise<boolean> {
  const edge = edgeOf(item.entity, item.edge);
  let measured = false;
  await getDb(db)
    .transaction(async (tx) => {
      const txDb = databaseForTransaction(tx);
      if (synthetic && !(await pointEdgeAt(txDb, edge, target.id)))
        throw new Rollback();
      // Every other guard is cleared, so a refusal is this edge's own.
      const others = blockEdges.filter((other) => other !== edge);
      if (!(await clearBlockers(txDb, others, edge, target.id)))
        throw new Rollback();
      measured = true;
      const problem = await checkDisposition(txDb, item, target);
      if (problem)
        failures.push(
          `${item.entity} ${item.edge} (${item.disposition.effect}): ${problem}`,
        );
      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return measured;
}

/**
 * Tombstone the live rows that reference `targetId` over the block edges, so
 * a non-block edge whose every target is also blocked can still be measured.
 * A blocker on a table with no `deletedAt` is removed (the savepoint rolls it
 * back); `false` when a constraint refuses that.
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
    const where = sql`WHERE ${sql.identifier(columnName)}::text = ${targetId} ${keep}`;
    if (softDeletable) {
      await getDb(db).execute(sql`
        UPDATE ${sql.identifier(tableName)} SET "deletedAt" = now() ${where}
      `);
      continue;
    }
    const removed = await getDb(db)
      .transaction(async (tx) => {
        await tx.execute(
          sql`DELETE FROM ${sql.identifier(tableName)} ${where}`,
        );
        return true;
      })
      .catch(() => false);
    if (!removed) return false;
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

/**
 * An import run, and a source claim on the seeded purchase: no kernel create
 * writes either, and the synthetic insert cannot satisfy the claim's `kind`
 * check. The run also lets synthetic rows of the run-owned tables insert.
 * Returns the run's id so other staging-table seeds (below) can reuse it.
 */
async function seedImportSourceClaim(
  db: Database,
  shortcodeByPrefix: ReadonlyMap<string, string>,
): Promise<RunId | null> {
  const purchaseCode = shortcodeByPrefix.get("PUR-");
  const partyCode = shortcodeByPrefix.get("LPY-");
  if (!purchaseCode || !partyCode) return null;
  const { actorContext } = buildKernelContext(db);
  const [run] = await getDb(db)
    .insert(runTable)
    .values({
      shortcode: generateShortcode("run"),
      actorUserId: actorContext.userId,
      actorName: "Delete policy",
      actorEmail: "delete-policy@example.test",
      purpose: "file_import",
      trigger: "manual",
      status: "completed",
    })
    .returning({ id: runTable.id });
  await getDb(db)
    .insert(importSourceClaim)
    .values({
      ledgerPartyId: await resolveOrThrow(db, "ledgerParty", partyCode),
      purchaseId: await resolveOrThrow(db, "purchase", purchaseCode),
      kind: "vendor_export",
      externalKey: "delete-policy-order-1",
      checksum: "delete-policy",
      firstRunId: run!.id,
      lastRunId: run!.id,
      outputFingerprint: "delete-policy",
    });
  return run!.id;
}

/** Every id `seedDeletePolicyStagingRows`'s helpers resolve and share. */
interface StagingIds {
  mealId: MealId | null;
  ledgerPartyId: LedgerPartyId | null;
  productId: ProductId | null;
  ingredientId: IngredientId | null;
  recipeId: RecipeId | null;
  purchaseId: PurchaseId | null;
  expenseId: ExpenseId | null;
  ledgerTransferId: LedgerTransferId | null;
  financialAccountId: FinancialAccountId | null;
  financialTransactionId: FinancialTransactionId | null;
  vendorId: VendorId | null;
  // Untyped uuid columns (no `.$type<VendorAccountId>()`/`<ImageId>()` on
  // these particular references) — a plain string, not a branded id.
  vendorAccountId: string | null;
  deviceId: DeviceId | null;
  imageId: ImageId | null;
  productCategoryId: ProductCategoryId | null;
  locationId: LocationId | null;
}

/**
 * MealFoodEntry (product- and ingredient-sourced) and MealRecipePortion:
 * child rows of a meal, not kernel-creatable entities. `amount` is a jsonb
 * `{ value, unit }` shape — there is no `grams` column.
 */
async function seedMealChildRows(db: Database, ids: StagingIds) {
  const { mealId, ledgerPartyId, productId, ingredientId, recipeId } = ids;
  if (!mealId || !ledgerPartyId) return;
  if (productId)
    await insertAndReturn(db, mealFoodEntry, {
      mealId,
      ledgerPartyId,
      productId,
      sourceKind: "product",
      amount: { value: 1, unit: "g" },
    }).catch(() => undefined);
  if (ingredientId)
    await insertAndReturn(db, mealFoodEntry, {
      mealId,
      ledgerPartyId,
      ingredientId,
      sourceKind: "ingredient",
      amount: { value: 1, unit: "g" },
    }).catch(() => undefined);
  if (!recipeId) return;
  const recipe = await insertAndReturn(db, mealRecipe, {
    mealId,
    recipeId,
  }).catch(() => undefined);
  if (recipe)
    await insertAndReturn(db, mealRecipePortion, {
      mealRecipeId: recipe.id,
      mealId,
      ledgerPartyId,
      amount: { value: 1, unit: "g" },
    }).catch(() => undefined);
}

/**
 * A second live product, ordered against the first, for
 * `ProductMatchCandidate`'s canonical-pair check (`productAId < productBId`).
 */
async function seedProductMatchCandidate(db: Database, ids: StagingIds) {
  if (!ids.productId) return;
  const other = await insertWithShortcode(db, "product", {
    name: "Delete policy fixture product",
    manufacturer: "Delete policy",
  }).catch(() => undefined);
  if (!other) return;
  const [productAId, productBId] = [ids.productId, other.id].sort();
  await insertAndReturn(db, productMatchCandidate, {
    productAId: productAId!,
    productBId: productBId!,
    source: "detector",
    state: "open",
  }).catch(() => undefined);
}

/** LedgerSourceClaim: exactly one of expenseId/ledgerTransferId, never both. */
async function seedLedgerSourceClaims(db: Database, ids: StagingIds) {
  const claimEvidence = {
    normalizedEvidence: {
      amount: 10,
      occurredOn: null,
      description: null,
      context: null,
      disambiguator: null,
    },
    targetAmountAtClaim: 10,
    reconciliationDecision: "amounts_match" as const,
    sourceKeyVersion: 1,
  };
  if (ids.expenseId)
    await insertAndReturn(db, ledgerSourceClaim, {
      ...claimEvidence,
      expenseId: ids.expenseId,
      source: "delete-policy",
      sourceKey: "delete-policy-expense-claim",
    }).catch(() => undefined);
  if (ids.ledgerTransferId)
    await insertAndReturn(db, ledgerSourceClaim, {
      ...claimEvidence,
      ledgerTransferId: ids.ledgerTransferId,
      source: "delete-policy",
      sourceKey: "delete-policy-transfer-claim",
    }).catch(() => undefined);
}

/** StatementRow.accountId. */
async function seedStatementRow(db: Database, ids: StagingIds) {
  if (!ids.financialAccountId) return;
  const batch = await insertAndReturn(db, statementImport, {
    source: "delete-policy",
    label: "Delete policy fixture",
    fingerprint: "delete-policy-1",
  }).catch(() => undefined);
  if (!batch) return;
  await insertAndReturn(db, statementRow, {
    batchId: batch.id,
    source: "delete-policy",
    // `externalId` must be `v1:<64 lowercase hex chars>` (a content hash).
    externalId: `v1:${"a".repeat(64)}`,
    accountDescriptor: "Delete policy card",
    statementDate: "2024-01-15",
    amount: 10,
    providerAmount: 10,
    rawDescription: "Delete policy fixture row",
    accountId: ids.financialAccountId,
  }).catch(() => undefined);
}

/**
 * Cookbook.productId (createInput is null — not kernel-creatable, see
 * SKIPPED_ENTITIES-style entities in reference-universe.fixtures.ts),
 * ExpenseAttribution (covers both `expense`'s and `ledgerParty`'s edge), and a
 * second, person-owned InventoryEntry (the base universe's single row uses
 * the default `ownershipMode: "inherit"`, with no owner).
 */
async function seedCookbookExpenseAttributionInventory(
  db: Database,
  ids: StagingIds,
) {
  const { productId, expenseId, ledgerPartyId, locationId } = ids;
  if (productId)
    await insertWithShortcode(db, "cookbook", {
      name: "Delete policy fixture cookbook",
      sourceLabel: "delete-policy",
      rawJson: {
        contract: "delete-policy",
        source: {
          label: "delete-policy",
          sha256: "delete-policy",
          title: "Delete policy fixture cookbook",
          authors: [],
          identifiers: [],
          subjects: [],
        },
        chapters: [],
        edges: [],
      },
      productId,
    }).catch(() => undefined);

  if (expenseId && ledgerPartyId)
    await insertAndReturn(db, expenseAttribution, {
      expenseId,
      role: "funder",
      ledgerPartyId,
      weight: 1,
    }).catch(() => undefined);

  if (productId && locationId && ledgerPartyId)
    await insertWithShortcode(db, "inventory", {
      productId,
      amount: { value: 1, unit: "each" },
      locationId,
      ownershipMode: "person",
      ownerLedgerPartyId: ledgerPartyId,
    }).catch(() => undefined);
}

/** ImportHunt, RunTarget and RunFinding: all owned by the seeded import run. */
async function seedRunOwnedRows(db: Database, ids: StagingIds, runId: RunId) {
  const {
    ledgerPartyId,
    financialTransactionId,
    vendorId,
    vendorAccountId,
    imageId,
    purchaseId,
    deviceId,
  } = ids;
  if (ledgerPartyId && financialTransactionId)
    await insertAndReturn(db, importHunt, {
      ledgerPartyId,
      financialTransactionId,
      vendorId: vendorId ?? undefined,
      vendorAccountId: vendorAccountId ?? undefined,
      receiptImageId: imageId ?? undefined,
      dateFrom: "2024-01-01",
      dateTo: "2024-01-31",
    }).catch(() => undefined);

  if (purchaseId)
    await insertAndReturn(db, runTarget, {
      runId,
      purchaseId,
      vendorAccountId: vendorAccountId ?? undefined,
      deviceWorkDeviceId: deviceId ?? undefined,
      targetFingerprint: "delete-policy-runtarget",
    }).catch(() => undefined);

  if (ledgerPartyId && purchaseId)
    await insertAndReturn(db, runFinding, {
      runId,
      ledgerPartyId,
      targetKind: "purchase",
      targetId: purchaseId,
      kind: "delete-policy-finding",
      summary: "Delete policy fixture finding",
      evidenceFingerprint: "delete-policy-finding-fp",
    }).catch(() => undefined);
}

/** ImportPreparedOrder and PhotoGroupProposal: also run-owned. */
async function seedRunEvidenceRows(
  db: Database,
  ids: StagingIds,
  runId: RunId,
) {
  const { imageId, productId, productCategoryId, locationId, ledgerPartyId } =
    ids;
  if (imageId)
    await insertAndReturn(db, importPreparedOrder, {
      runId,
      prepareOperationId: "delete-policy-prepare-1",
      itemOperationId: "delete-policy-item-1",
      stableOrderId: "delete-policy-order-1",
      sourceKind: "vendor_export",
      sourceExternalKey: "delete-policy-order-1",
      sourceChecksum: "delete-policy",
      evidenceChecksum: "delete-policy",
      extractionRevision: "1",
      extraction: {},
      primaryDocumentImageId: imageId,
      screenshotImageId: imageId,
      targetFingerprint: "delete-policy-prepared-order",
      evidenceFingerprint: "delete-policy-prepared-order",
    }).catch(() => undefined);

  if (productId && productCategoryId && locationId && ledgerPartyId)
    await insertAndReturn(db, photoGroupProposal, {
      runId,
      groupKey: "delete-policy-group-1",
      productKind: "existing",
      productId,
      productCreateCategoryId: productCategoryId,
      inventoryLocationId: locationId,
      inventoryOwnerPartyId: ledgerPartyId,
    }).catch(() => undefined);
}

/**
 * OrderMail and its attachment. A dedicated, disposable party — not the
 * shared `ledgerPartyId` every other edge above also uses — for
 * `OrderMail.ledgerPartyId`. `OrderMail` has no `deletedAt`, and this row's
 * own `OrderMailAttachment` FK makes it undeletable; sharing the target party
 * would make every OTHER ledgerParty block edge's cleanup step try (and
 * fail) to hard-delete this row whenever ITS target is measured, marking
 * that other edge uncovered as a side effect. A party nothing else
 * references isolates the failure to `OrderMail.ledgerPartyId` alone (still
 * covered: the block disposition only requires the delete be refused).
 */
async function seedOrderMailAttachment(db: Database, ids: StagingIds) {
  if (!ids.imageId) return;
  const orderMailParty = await insertWithShortcode(db, "ledgerParty", {
    name: "Delete policy order mail party",
    kind: "guest",
  }).catch(() => undefined);
  if (!orderMailParty) return;
  const mail = await insertAndReturn(db, orderMail, {
    ledgerPartyId: orderMailParty.id,
    messageId: "delete-policy-msg-1",
    sender: "vendor@example.test",
    subject: "Delete policy fixture",
    receivedAt: new Date(),
    rawChecksum: "delete-policy-checksum",
  }).catch(() => undefined);
  if (!mail) return;
  await insertAndReturn(db, orderMailAttachment, {
    orderMailId: mail.id,
    providerAttachmentId: "delete-policy-attachment-1",
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    checksum: "delete-policy-attachment-checksum",
    imageId: ids.imageId,
  }).catch(() => undefined);
}

/** ImageProcessingJob.imageId and ImageDerivative.imageId. */
async function seedImageProcessingRows(db: Database, ids: StagingIds) {
  if (!ids.imageId) return;
  await insertAndReturn(db, imageDerivative, {
    imageId: ids.imageId,
    purpose: "transparent",
    status: "pending",
    key: "delete-policy-derivative-key",
    sourceContentHash: "delete-policy-hash",
    processorRevision: 1,
  }).catch(() => undefined);
  await insertAndReturn(db, imageProcessingJob, {
    imageId: ids.imageId,
    kind: "describe_image",
    state: "pending",
    sourceContentHash: "delete-policy-hash",
    processorRevision: 1,
  }).catch(() => undefined);
}

/**
 * Direct inserts into staging/child tables the kernel never creates
 * (import/photo/statement/ledger-evidence rows), covering the remaining
 * incoming edges `UNCOVERED_EDGES` used to list: meal food entries and recipe
 * portions, the import-run staging tables (`ImportHunt`, `ImportPreparedOrder`,
 * `RunTarget`, `RunFinding`, `PhotoGroupProposal`, `OrderMailAttachment`),
 * review/settlement metadata (`ProductMatchCandidate`, `LedgerSourceClaim`,
 * `StatementRow`), `Cookbook`, `ExpenseAttribution`, a second `InventoryEntry`,
 * and image processing rows (`ImageProcessingJob`, `ImageDerivative`). Each
 * write targets real seeded rows resolved through `shortcodeByPrefix`, so a
 * subsequent delete of one of those rows exercises the edge's real
 * disposition.
 */
async function seedDeletePolicyStagingRows(
  db: Database,
  shortcodeByPrefix: ReadonlyMap<string, string>,
  runId: RunId | null,
) {
  const resolve = async <E extends ShortcodeEntity>(
    entity: E,
    prefix: string,
  ) => {
    const code = shortcodeByPrefix.get(prefix);
    return code ? resolveOrThrow(db, entity, code) : null;
  };

  const ids: StagingIds = {
    mealId: await resolve("meal", "MEL-"),
    ledgerPartyId: await resolve("ledgerParty", "LPY-"),
    productId: await resolve("product", "PRD-"),
    ingredientId: await resolve("ingredient", "ING-"),
    recipeId: await resolve("recipe", "RCP-"),
    purchaseId: await resolve("purchase", "PUR-"),
    expenseId: await resolve("expense", "EXP-"),
    ledgerTransferId: await resolve("ledgerTransfer", "LTR-"),
    financialAccountId: await resolve("financialAccount", "FAC-"),
    financialTransactionId: await resolve("financialTransaction", "FTX-"),
    vendorId: await resolve("vendor", "VEN-"),
    vendorAccountId: await resolve("vendorAccount", "VACCT-"),
    deviceId: await resolve("device", "DEV-"),
    imageId: await resolve("image", "IMG-"),
    productCategoryId: await resolve("productCategory", "CAT-"),
    // The last-seeded (non-home) location — see reference-universe.fixtures.ts.
    locationId: await resolve("location", "LOC-"),
  };

  await seedMealChildRows(db, ids);
  await seedProductMatchCandidate(db, ids);
  await seedLedgerSourceClaims(db, ids);
  await seedStatementRow(db, ids);
  await seedCookbookExpenseAttributionInventory(db, ids);

  // Everything below needs the import run seeded alongside the source claim.
  if (!runId) return;
  await seedRunOwnedRows(db, ids, runId);
  await seedRunEvidenceRows(db, ids, runId);
  await seedOrderMailAttachment(db, ids);
  await seedImageProcessingRows(db, ids);
}

describe("entity delete policy — declared dispositions at the DB boundary", () => {
  const ctx = withTestDb();

  it("applies every block, detach and cascade disposition", async () => {
    const universe = await seedReferenceUniverse(ctx.db);
    await enrichUniverse(ctx.db, universe.shortcodeByPrefix);
    const runId = await seedImportSourceClaim(
      ctx.db,
      universe.shortcodeByPrefix,
    );
    await seedDeletePolicyStagingRows(
      ctx.db,
      universe.shortcodeByPrefix,
      runId,
    );

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
        // Candidates come back in no particular order, and clearing another
        // edge's blockers can fail for one target (a non-soft-deletable row
        // that is itself undeletable) yet succeed for the next, so try each
        // candidate until one can be measured; otherwise the edge flickers
        // between covered and uncovered from run to run.
        const candidates =
          disposition.effect === "block"
            ? pool
            : [
                ...pool.filter((row) => !blocked.has(row.id)),
                ...pool.filter((row) => blocked.has(row.id)),
              ];
        let measured = false;
        for (const target of candidates) {
          measured = await measureEdge(ctx.db, {
            item,
            target,
            synthetic,
            blockEdges,
            failures,
          });
          if (measured) break;
        }
        if (measured) covered += 1;
        else uncovered.push(`${entity} ${edge}`);
      }
    }

    // Joined, not `toEqual`: vitest elides long arrays to `…(n)`.
    expect(
      failures.join("\n"),
      `${failures.length} of ${covered} delete disposition(s) disagree with the database`,
    ).toBe("");
    expect(uncovered).toEqual(UNCOVERED_EDGES);
  }, 300_000);
});
