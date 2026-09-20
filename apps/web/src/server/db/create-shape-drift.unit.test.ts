/**
 * Create-input ↔ Drizzle-table drift guard.
 *
 * Deriving the create schemas FROM the Drizzle tables was considered and
 * rejected (the generated shapes cannot express the virtual inputs below, and
 * they would leak column-level nullability into the public contract). This test
 * buys the protection that derivation would have: a column added to a table, or
 * a field added to a create input, has to be reconciled against the other side
 * or explained here.
 *
 * Pure unit test — schema metadata only, never a database.
 */
import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as schema from "~/server/db/schema";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";

// SAFETY: Drizzle's runtime `is` predicate has identified every retained
// value as a PgTable; its generic predicate does not preserve that type here.
const ALL_TABLES = Object.values(schema).filter((value) =>
  is(value, PgTable),
) as PgTable[];

const isEntity = (value: string): value is Entity => value in entityManifest;

const tableFor = (entity: Entity): PgTable | undefined => {
  const dbTable = entityManifest[entity].dbTable;
  return dbTable
    ? ALL_TABLES.find((table) => getTableName(table) === dbTable)
    : undefined;
};

/**
 * Columns the server mints, never a caller. `id`/`createdAt`/`updatedAt` carry
 * DB defaults and drop out on their own; `shortcode` does not (it is assigned
 * in the repo write path from the entity's prefix), so it is named here.
 */
const SERVER_MINTED_COLUMNS = new Set(["id", "shortcode"]);

/**
 * Create-input fields that are deliberately NOT columns of the entity's own
 * table. Every one writes child/join rows or is resolved to a foreign key by
 * the repo — the shapes a Drizzle-derived schema could never have produced.
 * A new unexplained field fails assertion 1; a field that becomes a real
 * column fails assertion 3.
 */
type EntityFieldNotes = {
  [E in Entity]?: Readonly<Record<string, string>>;
};

const VIRTUAL_CREATE_INPUTS: EntityFieldNotes = {
  expense: {
    vendor: "free-text vendor name; the repo resolves it to Expense.vendorId",
    orderId: "attaches the expense to a Purchase rather than storing a column",
    beneficiaries: "writes ExpenseAttribution rows (household split)",
    funders: "writes ExpenseAttribution rows (who paid)",
    sourceClaims: "writes LedgerSourceClaim provenance rows",
  },
  financialTransaction: {
    purchaseId:
      "settlement link lives on FinancialTransactionAllocation, not the row",
    allocations: "writes FinancialTransactionAllocation rows",
  },
  ledgerTransfer: {
    sourceClaims: "writes LedgerSourceClaim provenance rows",
    evidenceTransactionIds:
      "records the FinancialTransactions that evidence the transfer",
  },
  location: { pendingImageIds: "writes LocationImage rows" },
  gardenEntry: {
    plantingIds: "writes GardenEntryPlanting rows",
    pendingImageIds: "writes GardenEntryImage rows",
  },
  meal: {
    recipes: "writes MealRecipe rows",
    pendingImageIds: "writes MealImage rows",
  },
  product: {
    upc: "barcode write slot; lands in ProductExternalId, not on Product",
    isbn: "book identifier; lands in ProductExternalId, not on Product",
    externalIds: "writes ProductExternalId rows",
    unitMappings: "writes ProductUnitMappings rows",
    pendingImageIds: "writes ProductImage rows",
  },
  purchase: { pendingImageIds: "writes PurchaseImage rows" },
  recipe: {
    sections: "writes RecipeSection + RecipeSectionIngredient rows",
    pendingImageIds: "writes RecipeImage rows",
  },
  task: { pendingImageIds: "writes TaskImage rows" },
  wish: { candidateProductIds: "writes WishCandidate rows" },
};

/**
 * Non-nullable, defaultless columns a create input deliberately does not
 * accept. Empty today, and that is the point: every such column is currently
 * required by its create schema, so a new one has to be either required or
 * justified here.
 */
const UNSUPPLIED_REQUIRED_COLUMNS: EntityFieldNotes = {};

type BoundEntity = {
  entity: Entity;
  table: PgTable;
  /** `z.ZodRawShape` values are core `$ZodType` (no `safeParse`); narrow here. */
  createFields: Record<string, z.ZodType>;
};

const bound: BoundEntity[] = [];
for (const [key, binding] of Object.entries(ENTITY_BINDINGS)) {
  if (!binding.crud) continue;
  if (!isEntity(key)) continue;
  const entity = key;
  const table = tableFor(entity);
  const createInput = binding.crud.createInput;
  // A create input that stops being a plain object (a transform/pipe wrapper)
  // would silently skip this guard, so fail rather than skip.
  if (!table || !(createInput instanceof z.ZodObject)) {
    throw new Error(
      `${entity}: expected a pgTable (${entityManifest[entity].dbTable}) and an object create input`,
    );
  }
  bound.push({
    entity,
    table,
    // SAFETY: ZodObject guarantees each entry in this runtime shape is a
    // parseable ZodType; the public generic exposes only the core base type.
    createFields: createInput.shape as Record<string, z.ZodType>,
  });
}

const passesUndefinedThrough = (schema: z.ZodType): boolean => {
  const parsed = schema.safeParse(undefined);
  return parsed.success && parsed.data === undefined;
};

describe("create-input shapes track their Drizzle tables", () => {
  it("binds every entity with a crud contract", () => {
    // Guards the loop above against silently iterating nothing.
    expect(bound.length).toBe(
      Object.values(ENTITY_BINDINGS).filter((b) => b.crud).length,
    );
    expect(bound.length).toBeGreaterThan(10);
  });

  it.each(bound)(
    "$entity: every create field maps to a column or an explained virtual input",
    ({ entity, table, createFields }) => {
      const columns = new Set(Object.keys(getTableColumns(table)));
      const virtual = VIRTUAL_CREATE_INPUTS[entity] ?? {};
      const unexplained = Object.keys(createFields).filter(
        (field) => !columns.has(field) && !(field in virtual),
      );
      expect(unexplained).toEqual([]);
    },
  );

  it.each(bound)(
    "$entity: every required column is supplied by the create shape",
    ({ entity, table, createFields }) => {
      const exempt = UNSUPPLIED_REQUIRED_COLUMNS[entity] ?? {};
      const missing = Object.entries(getTableColumns(table))
        .filter(([, column]) => column.notNull && !column.hasDefault)
        .map(([field]) => field)
        .filter(
          (field) =>
            !SERVER_MINTED_COLUMNS.has(field) &&
            !(field in exempt) &&
            // Absent, or present but letting `undefined` THROUGH — both mean
            // a caller can omit a value the column has no way to fill. A
            // schema `.default()` fills it itself (`manufacturer`), so that
            // parses undefined into a value and is supplied.
            (createFields[field] === undefined ||
              passesUndefinedThrough(createFields[field])),
        );
      expect(missing).toEqual([]);
    },
  );

  it("keeps both rosters free of stale entries", () => {
    const stale: string[] = [];
    for (const { entity, table, createFields } of bound) {
      const columns = new Set(Object.keys(getTableColumns(table)));
      for (const [field, reason] of Object.entries(
        VIRTUAL_CREATE_INPUTS[entity] ?? {},
      )) {
        if (!reason) stale.push(`${entity}.${field}: empty reason`);
        if (!(field in createFields))
          stale.push(`${entity}.${field}: not a create field`);
        else if (columns.has(field))
          stale.push(`${entity}.${field}: is a real column now`);
      }
      for (const field of Object.keys(
        UNSUPPLIED_REQUIRED_COLUMNS[entity] ?? {},
      ))
        if (!columns.has(field)) stale.push(`${entity}.${field}: not a column`);
    }
    const boundEntities = new Set(bound.map((b) => b.entity));
    for (const roster of [VIRTUAL_CREATE_INPUTS, UNSUPPLIED_REQUIRED_COLUMNS])
      for (const entity of Object.keys(roster))
        if (isEntity(entity) && !boundEntities.has(entity))
          stale.push(`${entity}: rostered but has no create binding`);
    expect(stale).toEqual([]);
  });
});
