/** Central, batched boundary between public shortcodes and private UUIDs. */

import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
  type EntityRef,
  parseEntityId,
  parseEntityRef,
} from "@cubby/schemas/identifiers";
import {
  parseShortcode,
  parseShortcodeFor,
  type ShortcodeFor,
} from "@cubby/shared";
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  financialTransaction,
  gardenEntry,
  importRun,
  inventoryEntry,
  location,
  meal,
  planting,
  product,
  purchase,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

import { notDeleted, unwrapDb } from "./database-helpers";
import { SHORTCODE_TABLE } from "./generated/shortcode-tables.gen";
import type { ShortcodeTable } from "./shortcode-utils";

export type { EntityRef } from "@cubby/schemas/identifiers";

/** Accepts legacy codes; `parseShortcode` normalizes them before lookup. */
export async function resolveShortcode(
  db: Database | DrizzleTransaction,
  code: string,
): Promise<EntityRef | null> {
  const parsed = parseShortcode(code);
  if (!parsed) return null;
  const [row] = await resolveParsed(db, parsed.type, [parsed.shortcode]);
  return row ? parseEntityRef(row.entity, row.id) : null;
}

/** Resolves only live rows of the expected entity; a mismatched prefix is null. */
export async function resolveLiveShortcode<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  code: string,
  entity: E,
): Promise<EntityId<E> | null> {
  const parsed = parseShortcode(code);
  if (!parsed || parsed.type !== entity) return null;

  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const rows = await unwrapDb(db)
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.shortcode, parsed.shortcode), notDeleted(table)))
    .limit(1);
  const row = rows[0];
  return row ? parseEntityId(entity, row.id) : null;
}

/** Invalid, cross-entity, and soft-deleted codes are absent from the result. */
export async function resolveLiveShortcodes<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  codes: readonly string[],
  entity: E,
): Promise<Map<string, EntityId<E>>> {
  const originalsByCanonical = new Map<string, string[]>();
  for (const code of codes) {
    const parsed = parseShortcode(code);
    if (!parsed || parsed.type !== entity) continue;
    const originals = originalsByCanonical.get(parsed.shortcode);
    if (originals) originals.push(code);
    else originalsByCanonical.set(parsed.shortcode, [code]);
  }
  if (originalsByCanonical.size === 0) return new Map();

  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const rows = await unwrapDb(db)
    .select({ id: table.id, shortcode: table.shortcode })
    .from(table)
    .where(
      and(
        inArray(table.shortcode, [...originalsByCanonical.keys()]),
        notDeleted(table),
      ),
    );

  const resolved = new Map<string, EntityId<E>>();
  for (const row of rows) {
    const shortcode = parseShortcodeFor(entity, row.shortcode);
    for (const originalCode of originalsByCanonical.get(shortcode) ?? []) {
      resolved.set(originalCode, parseEntityId(entity, row.id));
    }
  }
  return resolved;
}

export async function resolveOrThrow<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  code: string,
): Promise<EntityId<E>> {
  const id = await resolveLiveShortcode(db, code, entity);
  if (id === null) {
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[entity],
      `${ENTITY_LABEL[entity]} not found: ${code}`,
    );
  }
  return id;
}

/** A missing just-created row is an invariant failure, not a client 404. */
export async function resolveCreatedOrInvariant<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  code: string,
): Promise<EntityId<E>> {
  const id = await resolveLiveShortcode(db, code, entity);
  if (!id) {
    throw new Error(
      `Created ${ENTITY_LABEL[entity].toLowerCase()} ${code} could not be resolved`,
    );
  }
  return id;
}

/** Throws with every missing code; returns IDs positionally with duplicates. */
export async function resolveAllOrThrow<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  codes: readonly string[],
): Promise<EntityId<E>[]> {
  if (codes.length === 0) return [];
  const resolved = await resolveLiveShortcodes(db, codes, entity);
  const missing = codes.filter((code) => !resolved.has(code));
  if (missing.length > 0) {
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[entity],
      `${ENTITY_LABEL[entity]} not found: ${uniq(missing).join(", ")}`,
    );
  }
  return codes.map((code) => resolved.get(code)!);
}

/** Drops unresolved codes while preserving the order of resolved ones. */
export async function resolveAllPresent<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  codes: readonly string[],
): Promise<EntityId<E>[]> {
  if (codes.length === 0) return [];
  const resolved = await resolveLiveShortcodes(db, codes, entity);
  return codes.flatMap((code) => {
    const id = resolved.get(code);
    return id === undefined ? [] : [id];
  });
}

export const bindShortcodeResolver = <E extends ShortcodeEntity>(
  entity: E,
) => ({
  one: (db: Database | DrizzleTransaction, code: string) =>
    resolveOrThrow(db, entity, code),
  all: (db: Database | DrizzleTransaction, codes: readonly string[]) =>
    resolveAllOrThrow(db, entity, codes),
  present: (db: Database | DrizzleTransaction, codes: readonly string[]) =>
    resolveAllPresent(db, entity, codes),
});

/** Empty input is unrestricted; supplied-but-unresolved input returns `[]`. */
export async function resolveFilterIds<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  value: string | readonly string[] | undefined,
): Promise<EntityId<E>[] | undefined> {
  if (value === undefined) return undefined;
  const codes = Array.isArray(value) ? value : [value];
  if (codes.length === 0) return undefined;
  return resolveAllPresent(db, entity, codes);
}

/** Resolves in one query per entity and keys results by canonical code. */
export async function resolveShortcodes(
  db: Database | DrizzleTransaction,
  codes: readonly string[],
): Promise<Map<string, EntityRef>> {
  const byEntity = new Map<ShortcodeEntity, string[]>();
  for (const code of codes) {
    const parsed = parseShortcode(code);
    if (!parsed) continue;
    const bucket = byEntity.get(parsed.type);
    if (bucket) bucket.push(parsed.shortcode);
    else byEntity.set(parsed.type, [parsed.shortcode]);
  }

  const resolved = new Map<string, EntityRef>();
  await Promise.all(
    [...byEntity].map(async ([entity, entityCodes]) => {
      const rows = await resolveParsed(db, entity, entityCodes);
      for (const row of rows) {
        resolved.set(row.shortcode, parseEntityRef(row.entity, row.id));
      }
    }),
  );
  return resolved;
}

/** Reverse lookup, keyed by `entityRefKey` to prevent cross-entity collisions. */
export async function lookupShortcodes(
  db: Database | DrizzleTransaction,
  refs: readonly EntityRef[],
): Promise<Map<string, string>> {
  const byEntity = new Map<ShortcodeEntity, Set<string>>();
  for (const ref of refs) {
    const bucket = byEntity.get(ref.entity);
    if (bucket) bucket.add(ref.id);
    else byEntity.set(ref.entity, new Set([ref.id]));
  }

  const codes = new Map<string, string>();
  await Promise.all(
    [...byEntity].map(async ([entity, ids]) => {
      const table: ShortcodeTable = SHORTCODE_TABLE[entity];
      // Soft-deleted rows are included on purpose: a payload can legitimately
      // reference a row that was deleted after it was assembled, and rendering
      // its (tombstoned) code beats rendering a raw uuid.
      const rows = await unwrapDb(db)
        .select({ id: table.id, shortcode: table.shortcode })
        .from(table)
        .where(inArray(table.id, [...ids]));
      for (const row of rows) {
        const id = parseEntityId(entity, row.id);
        codes.set(
          entityRefKey(entity, id),
          parseShortcodeFor(entity, row.shortcode),
        );
      }
    }),
  );
  return codes;
}

/**
 * Entities where the display column deliberately differs from the storage
 * column behind the entity's `titleField` (`packages/schemas/src/
 * entity-definitions/*.entity.ts` `presentation.titleField`) — each with the
 * override column (or `null`, meaning no single column at all) and a
 * one-line reason. Every entry here is a considered choice, not drift — see
 * `shortcode-resolver-labels.unit.test.ts` for the parity check this backs.
 */
export const LABEL_COLUMN_OVERRIDES = {
  gardenEntry: {
    column: gardenEntry.kind,
    reason:
      "titleField (displayName) is a computed value with no single storage column; kind is a short, always-present label",
  },
  planting: {
    column: planting.status,
    reason:
      "titleField (displayName) is a computed value with no single storage column; status is always present",
  },
  inventory: {
    column: null,
    reason:
      "titleField (displayName) is a computed relational value; inventoryEntryLabels() below builds the same 'product · location' label instead",
  },
  meal: {
    column: meal.name,
    reason:
      "titleField (displayName) is computed as name || date with no single storage column; name is the best-effort audit-label fallback (blank when the meal was never named)",
  },
  financialTransaction: {
    column: financialTransaction.merchant,
    reason:
      "titleField (displayName) is computed as merchant || rawDescription || capitalized kind with no single storage column; merchant is the best-effort audit-label fallback (null for unmatched rows)",
  },
  purchase: {
    column: purchase.displayLabel,
    reason:
      "titleField (displayName) is computed via purchaseLabel(...) with no single storage column; displayLabel is the raw nullable label column purchaseLabel is itself built from, so it's the best-effort audit-label fallback",
  },
  ledgerTransfer: {
    column: null,
    reason:
      "titleField (fromPartyName) is a read-only value joined from LedgerParty, not a physical LedgerTransfer column",
  },
  importRun: {
    column: importRun.purpose,
    reason:
      'titleField (displayName) is computed as `${vendorName ?? "Purchase agent"} · ${purpose label}` with no single storage column; purpose is the always-present best-effort audit-label fallback',
  },
} satisfies Partial<
  Record<ShortcodeEntity, { column: PgColumn | null; reason: string }>
>;

/**
 * The drizzle column backing `presentation.titleField`, independent of
 * `LABEL_COLUMN_OVERRIDES`: `titleField` names a field's external `readKey`,
 * which the field model maps to an internal field `key`, which the field
 * model's `storage` array maps to a physical column name, which
 * `getTableColumns` resolves to the actual `PgColumn`. `null` means the
 * titleField has no physical storage column at all (a computed/relational
 * value) — every such entity must appear in `LABEL_COLUMN_OVERRIDES`, checked
 * by `DISPLAY_NAME_COLUMN`'s construction below.
 *
 * Exported only for `shortcode-resolver-labels.unit.test.ts`'s dead-override
 * check, which needs this override-independent value to tell "the override
 * restates what titleField would already give" apart from "the override
 * documents a value titleField cannot express at all".
 */
export const resolveTitleFieldColumn = (
  entity: ShortcodeEntity,
): PgColumn | null => {
  const titleField = entitySummary[entity].titleField;
  const model = entityFieldModels[entity];
  const field = model.fields.find((f) => f.readKey === titleField);
  const storageEntry = field
    ? model.storage.find((s) => s.key === field.key)
    : undefined;
  if (!storageEntry) return null;
  // SAFETY: `getTableColumns` types its result by the table's own literal
  // column keys, which can't be indexed by a runtime string; every generated
  // `storage[].column` name is one of those keys by construction (it comes
  // from the same drizzle schema this table is built from), so the lookup
  // below either hits or the `?? null` catches a genuine drift.
  const columns = getTableColumns(SHORTCODE_TABLE[entity]) as Record<
    string,
    PgColumn
  >;
  return columns[storageEntry.column] ?? null;
};

/**
 * `null` means the label is relational or the entity has no display column.
 *
 * Not a third copy of the entity *type* label (`ENTITY_LABEL` above,
 * `entityLabel()` in `apps/web/src/entities/entities.tsx`): those map an
 * entity to what to call its *kind* ("Financial transaction"); this maps an
 * entity to the DB column holding one *row's* own name (e.g.
 * `financialTransaction.merchant`), consumed only by `lookupEntityLabels`
 * below for audit-log display. Different semantics — don't fold it into the
 * type-label consolidation.
 *
 * `LABEL_COLUMN_OVERRIDES` wins for its 7 entities; every other entity is
 * derived from `titleField`, and a non-override entity whose titleField has
 * no physical storage column is a bug — declare it as an override instead of
 * letting the map silently go null.
 */
type DisplayNameColumns = Record<ShortcodeEntity, PgColumn | null>;

export const DISPLAY_NAME_COLUMN = shortcodeEntities.reduce(
  (columns, entity) => {
    // SAFETY: `entity` ranges over every `ShortcodeEntity`, only 4 of which
    // are keys of `LABEL_COLUMN_OVERRIDES`; the `hasOwn` guard is what makes
    // this cast sound — everywhere it's false, `override` is never read.
    const override = Object.hasOwn(LABEL_COLUMN_OVERRIDES, entity)
      ? LABEL_COLUMN_OVERRIDES[entity as keyof typeof LABEL_COLUMN_OVERRIDES]
      : undefined;
    if (override) {
      columns[entity] = override.column;
      return columns;
    }

    const column = resolveTitleFieldColumn(entity);
    if (!column) {
      const titleField = entitySummary[entity].titleField;
      throw new Error(
        `DISPLAY_NAME_COLUMN: ${entity}'s titleField (${titleField}) has no derivable storage column and no LABEL_COLUMN_OVERRIDES entry to fall back on`,
      );
    }
    columns[entity] = column;
    return columns;
  },
  // SAFETY: `shortcodeEntities` enumerates the whole `ShortcodeEntity` union,
  // and the reducer above assigns every one of them before returning, so the
  // accumulator ends up fully populated despite starting empty.
  {} as DisplayNameColumns,
);

/** Batched UUID-to-label lookup; rows without a label are omitted. */
export async function lookupEntityLabels(
  db: Database | DrizzleTransaction,
  refs: readonly EntityRef[],
): Promise<Map<string, string>> {
  const byEntity = new Map<ShortcodeEntity, Set<string>>();
  for (const ref of refs) {
    const bucket = byEntity.get(ref.entity);
    if (bucket) bucket.add(ref.id);
    else byEntity.set(ref.entity, new Set([ref.id]));
  }

  const names = new Map<string, string>();
  await Promise.all(
    [...byEntity].map(async ([entity, ids]) => {
      if (entity === "inventory") {
        for (const [id, label] of await inventoryEntryLabels(db, ids)) {
          names.set(entityRefKey(entity, id), label);
        }
        return;
      }
      const nameColumn: PgColumn | null = DISPLAY_NAME_COLUMN[entity];
      if (!nameColumn) return;
      const table: ShortcodeTable = SHORTCODE_TABLE[entity];
      // includes-deleted: same reasoning as `lookupShortcodes` — an audit row
      // or other assembled payload can legitimately name a row deleted after
      // the fact, and its (past) name is what makes that entry readable.
      const rows = await unwrapDb(db)
        .select({ id: table.id, name: nameColumn })
        .from(table)
        .where(inArray(table.id, [...ids]));
      for (const row of rows) {
        const parsedName = z.string().safeParse(row.name);
        if (parsedName.success) {
          names.set(
            entityRefKey(entity, parseEntityId(entity, row.id)),
            parsedName.data,
          );
        }
      }
    }),
  );
  return names;
}

/** Inventory labels are relational: `product · location`. */
async function inventoryEntryLabels(
  db: Database | DrizzleTransaction,
  ids: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const rows = await unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      productName: product.name,
      locationName: location.name,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .innerJoin(location, eq(inventoryEntry.locationId, location.id))
    .where(
      inArray(
        inventoryEntry.id,
        [...ids].map((id) => parseEntityId("inventory", id)),
      ),
    );

  const labels = new Map<string, string>();
  for (const row of rows) {
    if (!row.productName) continue;
    labels.set(
      row.id,
      row.locationName
        ? `${row.productName} · ${row.locationName}`
        : row.productName,
    );
  }
  return labels;
}

interface ResolvedRow<E extends ShortcodeEntity> {
  entity: E;
  id: EntityId<E>;
  shortcode: ShortcodeFor<E>;
}

async function resolveParsed<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  codes: readonly string[],
): Promise<ResolvedRow<E>[]> {
  if (codes.length === 0) return [];
  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  // No `notDeleted` filter: resolution answers "what does this code name",
  // which stays true after a soft delete. Callers that need a LIVE row (every
  // detail route) get their 404 from the subsequent `getByID`, which does
  // filter — and that split is deliberate, so scanning the label on a bin you
  // deleted says "this location was deleted" rather than "no such code".
  const rows = await unwrapDb(db)
    .select({ id: table.id, shortcode: table.shortcode })
    .from(table)
    .where(inArray(table.shortcode, [...codes]));
  return rows.map((row) => ({
    entity,
    id: parseEntityId(entity, row.id),
    shortcode: parseShortcodeFor(entity, row.shortcode),
  }));
}
