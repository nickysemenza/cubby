/**
 * Durable identity reads over `Entity` (ADR 0006): what an old code means
 * after a merge or delete, and which codes were merged into a live entity.
 *
 * Reads follow a merge redirect to the canonical entity. Mutations never do —
 * `describeUnresolvableCode` only explains why a code cannot be written
 * through, so a caller holding a merged-away code learns the survivor's code
 * instead of silently writing to it.
 */

import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { ENTITY_LABEL } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityIdentity } from "~/server/db/schema";

import { unwrapDb } from "./database-helpers";

export type EntityIdentityResolution =
  | { state: "live"; kind: ShortcodeEntity; id: string; shortcode: string }
  | {
      state: "redirected";
      kind: ShortcodeEntity;
      requested: string;
      /** The survivor; `canonicalDeletedAt` is set when it was deleted later. */
      canonicalId: string;
      canonicalShortcode: string;
      canonicalDeletedAt: Date | null;
    }
  | {
      state: "deleted";
      kind: ShortcodeEntity;
      id: string;
      shortcode: string;
      deletedAt: Date;
    }
  | { state: "missing" };

const shortcodeEntitySet: ReadonlySet<string> = new Set(shortcodeEntities);

export const isShortcodeEntity = (entity: string): entity is ShortcodeEntity =>
  shortcodeEntitySet.has(entity);

const canonical = alias(entityIdentity, "canonical");

/** Resolve a public code through `Entity`, following at most one redirect. */
export async function resolveEntityIdentity(
  db: Database | DrizzleTransaction,
  code: string,
): Promise<EntityIdentityResolution> {
  const parsed = parseShortcode(code);
  if (!parsed) return { state: "missing" };
  const [row] = await unwrapDb(db)
    .select({
      id: entityIdentity.id,
      kind: entityIdentity.kind,
      shortcode: entityIdentity.shortcode,
      deletedAt: entityIdentity.deletedAt,
      canonicalId: canonical.id,
      canonicalShortcode: canonical.shortcode,
      canonicalDeletedAt: canonical.deletedAt,
    })
    .from(entityIdentity)
    .leftJoin(canonical, eq(canonical.id, entityIdentity.mergedIntoId))
    .where(eq(entityIdentity.shortcode, parsed.shortcode))
    .limit(1);
  if (!row || row.shortcode === null) return { state: "missing" };
  const kind = row.kind;
  if (row.canonicalId !== null && row.canonicalShortcode !== null) {
    return {
      state: "redirected",
      kind,
      requested: row.shortcode,
      canonicalId: row.canonicalId,
      canonicalShortcode: row.canonicalShortcode,
      canonicalDeletedAt: row.canonicalDeletedAt,
    };
  }
  if (row.deletedAt !== null) {
    return {
      state: "deleted",
      kind,
      id: row.id,
      shortcode: row.shortcode,
      deletedAt: row.deletedAt,
    };
  }
  return { state: "live", kind, id: row.id, shortcode: row.shortcode };
}

/** Loser codes whose merge redirect points at each given live identity. */
export async function previousShortcodesFor(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (ids.length === 0) return result;
  const rows = await unwrapDb(db)
    .select({
      mergedIntoId: entityIdentity.mergedIntoId,
      shortcode: entityIdentity.shortcode,
    })
    .from(entityIdentity)
    .where(
      and(
        inArray(entityIdentity.mergedIntoId, [...ids]),
        isNotNull(entityIdentity.shortcode),
      ),
    )
    .orderBy(entityIdentity.deletedAt, entityIdentity.shortcode);
  for (const row of rows) {
    if (row.mergedIntoId === null || row.shortcode === null) continue;
    result.set(row.mergedIntoId, [
      ...(result.get(row.mergedIntoId) ?? []),
      row.shortcode,
    ]);
  }
  return result;
}

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Why a code does not name a live entity of `entity`, for a not-found error.
 * Returns null when `Entity` knows nothing more than "missing".
 */
export async function describeUnresolvableCode(
  db: Database | DrizzleTransaction,
  entity: ShortcodeEntity,
  code: string,
): Promise<string | null> {
  const resolved = await resolveEntityIdentity(db, code);
  if (resolved.state === "missing" || resolved.kind !== entity) return null;
  const notFound = `${ENTITY_LABEL[entity]} not found: ${code}`;
  switch (resolved.state) {
    case "redirected":
      return resolved.canonicalDeletedAt === null
        ? `${notFound} — it was merged into ${resolved.canonicalShortcode}; use ${resolved.canonicalShortcode}.`
        : `${notFound} — it was merged into ${resolved.canonicalShortcode}, which was deleted on ${formatDate(resolved.canonicalDeletedAt)}.`;
    case "deleted":
      return `${notFound} — it was deleted on ${formatDate(resolved.deletedAt)}.`;
    case "live":
      return null;
  }
}

/**
 * Point each loser identity at the survivor and path-compress any older
 * redirect that targeted a loser, so every redirect stays one hop. Runs after
 * the losers' payload removal, whose trigger has already set `deletedAt`.
 */
export async function recordMergeRedirects(
  tx: DrizzleTransaction,
  keepId: string,
  loserIds: readonly string[],
): Promise<void> {
  if (loserIds.length === 0) return;
  await tx
    .update(entityIdentity)
    .set({ mergedIntoId: keepId })
    .where(
      or(
        inArray(entityIdentity.id, [...loserIds]),
        inArray(entityIdentity.mergedIntoId, [...loserIds]),
      ),
    );
}
