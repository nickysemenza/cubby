/** Central, batched boundary between public shortcodes and private UUIDs. */

import { entityRefKey } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
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
import { and, eq, inArray } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  expense,
  financialAccount,
  financialTransaction,
  image,
  ingredient,
  inventoryEntry,
  ledgerParty,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
  vendor,
  wish,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

import { notDeleted, unwrapDb } from "./database-helpers";
import { SHORTCODE_TABLE, type ShortcodeTable } from "./shortcode-utils";

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
 * `null` means the label is relational or the entity has no display column.
 *
 * Not a third copy of the entity *type* label (`ENTITY_LABEL` above,
 * `entityLabel()` in `apps/web/src/entities/entities.tsx`): those map an
 * entity to what to call its *kind* ("Financial transaction"); this maps an
 * entity to the DB column holding one *row's* own name (e.g.
 * `financialTransaction.merchant`), consumed only by `lookupEntityLabels`
 * below for audit-log display. Different semantics — don't fold it into the
 * type-label consolidation.
 */
const DISPLAY_NAME_COLUMN = {
  cookbook: cookbook.name,
  expense: expense.name,
  financialAccount: financialAccount.name,
  financialTransaction: financialTransaction.merchant,
  ingredient: ingredient.name,
  inventory: null,
  location: location.name,
  meal: meal.name,
  ledgerParty: ledgerParty.name,
  ledgerTransfer: null,
  image: image.filename,
  product: product.name,
  project: project.name,
  purchase: purchase.displayLabel,
  recipe: recipe.name,
  task: task.name,
  vendor: vendor.name,
  wish: wish.name,
} as const satisfies Record<ShortcodeEntity, PgColumn | null>;

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
