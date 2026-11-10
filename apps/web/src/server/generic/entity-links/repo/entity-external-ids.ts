import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
/**
 * The one seam for `EntityExternalId` and its `ExternalSource` registry.
 *
 * Every identifier an outside system gives an entity is a row here: product
 * identifiers, Notion pages, Drive folders. A row
 * names at most one live entity per `(source, kind, externalId)`; rows
 * soft-delete with their entity (the entity's delete policy disposes the
 * `EntityExternalId.entityId` edge), so an identifier can be re-recorded after
 * the entity that held it is deleted.
 *
 * Every source slug is registered before it is written: `ensureExternalSources`
 * is the only door, and the FKs on every `source` column hold it to that.
 */
import type { EntityExternalIdKind } from "@cubby/schemas/external-id";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import { entityExternalId } from "~/server/db/external-identifier-tables";
import { product } from "~/server/db/generated/identity-storage-tables.gen";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requested, requestedRows } from "~/server/db/helpers/requested";
import {
  repositoryQueries,
  type RepositoryQueryInput,
  type RepositoryQueryTransaction,
} from "~/server/db/repository-access.boundary";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";

type Db = RepositoryQueryInput;

/** Payload, then identity parent, then children: replacement and new IDs share one fence. */
export async function lockExternalIdentifierParents(
  tx: RepositoryQueryTransaction,
  owners: readonly Pick<
    typeof entityExternalId.$inferInsert,
    "entityId" | "entityKind"
  >[],
): Promise<void> {
  const uniqueOwners = [
    ...new Map(owners.map((owner) => [owner.entityId, owner])).values(),
  ].sort((left, right) => left.entityId.localeCompare(right.entityId));
  if (!uniqueOwners.length) return;
  const productIds = uniqueOwners
    .filter((owner) => owner.entityKind === "product")
    .map((owner) => parseEntityId("product", owner.entityId));
  if (productIds.length) {
    const locked = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(inArray(product.id, productIds), notDeleted(product)))
      .orderBy(asc(product.id))
      .for("update");
    if (locked.length !== productIds.length)
      throw new Error("Product identifier owner is no longer live.");
  }
  const parents = await tx
    .select({ id: entityIdentity.id })
    .from(entityIdentity)
    .where(
      and(
        notDeleted(entityIdentity),
        requested(
          uniqueOwners.map((owner) => ({
            entity: owner.entityKind,
            id: owner.entityId,
          })),
        ).match({
          entity: sql`${entityIdentity.kind}`,
          id: sql`${entityIdentity.id}`,
        }),
      ),
    )
    .orderBy(asc(entityIdentity.id))
    .for("update");
  if (parents.length !== uniqueOwners.length)
    throw new Error("External identifier parent is no longer live.");
}

/**
 * Register source slugs without an owner. A slug's spelling never establishes
 * Vendor ownership: a name-matched owner once gave one Vendor two competing
 * Product identifier issuers. Idempotent; an existing row is left as it is.
 */
export async function ensureExternalSources(
  db: Db,
  slugs: Iterable<string>,
): Promise<void> {
  const wanted = uniq([...slugs]);
  if (wanted.length === 0) return;
  const rows = requestedRows(
    wanted.map((slug) => ({ slug })),
    { slug: "text" },
    "s",
  );
  await repositoryQueries(db).execute(sql`
    INSERT INTO "ExternalSource" ("slug", "label")
    SELECT s.slug, s.slug
    FROM ${rows.from}
    ON CONFLICT ("slug") DO NOTHING
  `);
}

/** Live identifiers of one kind. */
export const liveExternalIds = (kind: EntityExternalIdKind): SQL =>
  sql`(${eq(entityExternalId.kind, kind)} AND ${isNull(entityExternalId.deletedAt)})`;

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
  const rows = await repositoryQueries(db)
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
  tx: RepositoryQueryTransaction,
  owner: { entityId: string; entityKind: ShortcodeEntity },
  slot: { source: string; kind: EntityExternalIdKind },
  value: { externalId: string; url: string | null } | null,
): Promise<void> {
  await lockExternalIdentifierParents(tx, [owner]);
  const current = (await singleExternalIds(tx, [owner.entityId], slot)).get(
    owner.entityId,
  );
  if (value && current?.externalId === value.externalId) {
    if (current.url !== value.url) {
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
      await recordChange(tx, {
        kind: "source",
        categories: [owner.entityKind],
      });
    }
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
  if (!value) {
    if (current)
      await recordChange(tx, {
        kind: "source",
        categories: [owner.entityKind],
      });
    return;
  }
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
  await recordChange(tx, { kind: "source", categories: [owner.entityKind] });
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
  const [held] = await repositoryQueries(db)
    .execute<{ shortcode: string | null }>(sql`
    SELECT e."shortcode" FROM "EntityExternalId" x
    JOIN "Entity" e ON e."id" = x."entityId"
    WHERE ${notDeleted("x")} AND x."source" = ${id.source}
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
