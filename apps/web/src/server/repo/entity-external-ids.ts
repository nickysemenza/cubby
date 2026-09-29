/**
 * The one seam for `EntityExternalId` and its `ExternalSource` registry.
 *
 * Every identifier an outside system gives an entity is a row here: product
 * identifiers, settlement references, Notion pages, Drive folders. A row
 * names at most one live entity per `(source, kind, externalId)`; rows
 * soft-delete with their entity (the entity's delete policy disposes the
 * `EntityExternalId.entityId` edge), so an identifier can be re-recorded after
 * the entity that held it is deleted.
 *
 * Every source slug is registered before it is written: `ensureExternalSources`
 * is the only door, and the FKs on every `source` column hold it to that.
 */

import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntityExternalIdKind } from "@cubby/schemas/external-id";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityExternalId } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers/core";

type Db = Database | DrizzleTransaction;

/**
 * Register source slugs, naming the Vendor a slug is when one live Vendor's
 * name matches it case-insensitively. Idempotent; an existing row is left as
 * it is.
 */
export async function ensureExternalSources(
  db: Db,
  slugs: Iterable<string>,
): Promise<void> {
  const wanted = uniq([...slugs]);
  if (wanted.length === 0) return;
  await unwrapDb(db).execute(sql`
    INSERT INTO "ExternalSource" ("slug", "label", "vendorId")
    SELECT s.slug, s.slug,
      (SELECT (array_agg(v."id" ORDER BY v."id"))[1] FROM "Vendor" v
        WHERE lower(v."name") = s.slug AND v."deletedAt" IS NULL)
    FROM (VALUES ${sql.join(
      wanted.map((slug) => sql`(${slug}::text)`),
      sql`, `,
    )}) AS s(slug)
    ON CONFLICT ("slug") DO NOTHING
  `);
}

/** Live identifiers of one kind. */
export const liveExternalIds = (kind: EntityExternalIdKind): SQL =>
  sql`(${eq(entityExternalId.kind, kind)} AND ${isNull(entityExternalId.deletedAt)})`;

export type SettlementRef = { source: string; externalId: string };

/**
 * Each transaction's live settlement references. Ordered by source then
 * externalId: the rows carry no array position, so the order is canonical
 * rather than as-entered.
 */
export async function settlementRefsFor(
  db: Db,
  transactionIds: readonly string[],
): Promise<Map<string, SettlementRef[]>> {
  const out = new Map<string, SettlementRef[]>();
  if (transactionIds.length === 0) return out;
  const rows = await unwrapDb(db)
    .select({
      entityId: entityExternalId.entityId,
      source: entityExternalId.source,
      externalId: entityExternalId.externalId,
    })
    .from(entityExternalId)
    .where(
      and(
        liveExternalIds("settlement_ref"),
        inArray(entityExternalId.entityId, [...transactionIds]),
      ),
    )
    .orderBy(asc(entityExternalId.source), asc(entityExternalId.externalId));
  for (const row of rows) {
    out.set(row.entityId, [
      ...(out.get(row.entityId) ?? []),
      { source: row.source, externalId: row.externalId },
    ]);
  }
  return out;
}

/**
 * Refuse settlement references another live transaction already holds. The
 * live unique is the backstop (`db-errors.ts` maps its violation to the same
 * reason); this names the holder first.
 */
export async function assertSettlementRefsAvailable(
  db: Db,
  refs: readonly SettlementRef[],
  exceptTransactionId?: string,
): Promise<void> {
  if (refs.length === 0) return;
  const [held] = await unwrapDb(db)
    .select({
      source: entityExternalId.source,
      externalId: entityExternalId.externalId,
    })
    .from(entityExternalId)
    .where(
      and(
        liveExternalIds("settlement_ref"),
        or(
          ...refs.map((ref) =>
            and(
              eq(entityExternalId.source, ref.source),
              eq(entityExternalId.externalId, ref.externalId),
            ),
          ),
        ),
        exceptTransactionId
          ? ne(entityExternalId.entityId, exceptTransactionId)
          : undefined,
      ),
    )
    .limit(1);
  if (held)
    throw createAppError(
      "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
      `Source transaction ${held.source}/${held.externalId} is already recorded.`,
    );
}

/**
 * Make `refs` the transaction's full live settlement-reference set: refs no
 * longer named are soft-deleted, new ones inserted, kept ones untouched. The
 * caller holds the evidence locks and has checked availability.
 */
export async function replaceSettlementRefs(
  tx: DrizzleTransaction,
  transactionId: string,
  refs: readonly SettlementRef[],
): Promise<void> {
  const key = (ref: SettlementRef) => `${ref.source}\0${ref.externalId}`;
  const current =
    (await settlementRefsFor(tx, [transactionId])).get(transactionId) ?? [];
  const wanted = new Set(refs.map(key));
  const have = new Set(current.map(key));
  const removed = current.filter((ref) => !wanted.has(key(ref)));
  const added = refs.filter((ref) => !have.has(key(ref)));
  if (removed.length > 0)
    await tx
      .update(entityExternalId)
      .set({ deletedAt: new Date() })
      .where(
        and(
          liveExternalIds("settlement_ref"),
          eq(entityExternalId.entityId, transactionId),
          or(
            ...removed.map((ref) =>
              and(
                eq(entityExternalId.source, ref.source),
                eq(entityExternalId.externalId, ref.externalId),
              ),
            ),
          ),
        ),
      );
  if (added.length === 0) return;
  await ensureExternalSources(
    tx,
    added.map((ref) => ref.source),
  );
  await tx.insert(entityExternalId).values(
    added.map((ref) => ({
      entityId: transactionId,
      entityKind: "financialTransaction" as const,
      source: ref.source,
      kind: "settlement_ref" as const,
      externalId: ref.externalId,
      isPrimary: null,
    })),
  );
}

/**
 * The one live identifier of a single-slot kind (a Notion page, a Drive
 * folder) on each entity.
 */
export async function singleExternalIds(
  db: Db,
  entityIds: readonly string[],
  slot: { source: string; kind: EntityExternalIdKind },
): Promise<Map<string, { externalId: string; url: string | null }>> {
  const out = new Map<string, { externalId: string; url: string | null }>();
  if (entityIds.length === 0) return out;
  const rows = await unwrapDb(db)
    .select({
      entityId: entityExternalId.entityId,
      externalId: entityExternalId.externalId,
      url: entityExternalId.url,
    })
    .from(entityExternalId)
    .where(
      and(
        liveExternalIds(slot.kind),
        eq(entityExternalId.source, slot.source),
        eq(entityExternalId.isPrimary, true),
        inArray(entityExternalId.entityId, [...entityIds]),
      ),
    );
  for (const row of rows)
    out.set(row.entityId, { externalId: row.externalId, url: row.url });
  return out;
}

/**
 * Set or clear an entity's single identifier in one slot. A different value
 * retires the old row (soft delete) and records the new one; the same value
 * only refreshes its url. An identifier another live entity holds is refused.
 */
export async function setSingleExternalId(
  tx: DrizzleTransaction,
  owner: { entityId: string; entityKind: ShortcodeEntity },
  slot: { source: string; kind: EntityExternalIdKind },
  value: { externalId: string; url: string | null } | null,
): Promise<void> {
  const current = (await singleExternalIds(tx, [owner.entityId], slot)).get(
    owner.entityId,
  );
  if (value && current?.externalId === value.externalId) {
    if (current.url !== value.url)
      await tx
        .update(entityExternalId)
        .set({ url: value.url })
        .where(
          and(
            liveExternalIds(slot.kind),
            eq(entityExternalId.entityId, owner.entityId),
            eq(entityExternalId.source, slot.source),
            eq(entityExternalId.externalId, value.externalId),
          ),
        );
    return;
  }
  if (current)
    await tx
      .update(entityExternalId)
      .set({ deletedAt: new Date() })
      .where(
        and(
          liveExternalIds(slot.kind),
          eq(entityExternalId.entityId, owner.entityId),
          eq(entityExternalId.source, slot.source),
        ),
      );
  if (!value) return;
  await assertExternalIdAvailable(tx, { ...slot, ...value }, owner.entityId);
  await ensureExternalSources(tx, [slot.source]);
  await tx.insert(entityExternalId).values({
    entityId: owner.entityId,
    entityKind: owner.entityKind,
    source: slot.source,
    kind: slot.kind,
    externalId: value.externalId,
    url: value.url,
    isPrimary: true,
  });
}

/**
 * Refuse an identifier another live entity already holds, naming the holder.
 * The live `(source, kind, externalId)` unique is the backstop.
 */
async function assertExternalIdAvailable(
  db: Db,
  id: { source: string; kind: EntityExternalIdKind; externalId: string },
  ownerEntityId: string,
): Promise<void> {
  const [held] = await unwrapDb(db)
    .execute<{ shortcode: string | null }>(sql`
    SELECT e."shortcode" FROM "EntityExternalId" x
    JOIN "Entity" e ON e."id" = x."entityId"
    WHERE x."deletedAt" IS NULL AND x."source" = ${id.source}
      AND x."kind" = ${id.kind} AND x."externalId" = ${id.externalId}
      AND x."entityId" <> ${ownerEntityId}
    LIMIT 1
  `)
    .then((result) => result.rows);
  if (held)
    throw createAppError(
      "EXTERNAL_ID_CONFLICT",
      `${id.source} ${id.kind} ${id.externalId} already belongs to ${held.shortcode ?? "another record"}.`,
    );
}
