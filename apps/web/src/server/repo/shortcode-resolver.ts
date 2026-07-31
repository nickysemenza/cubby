/**
 * Shortcode resolution — the read half of the public-id layer.
 *
 * The ONE place a public id becomes a private uuid, and back. Every surface that
 * speaks shortcodes (the detail routes, the `/<shortcode>` scan landing, every
 * MCP tool) resolves through here rather than growing its own
 * `findXByShortcode`; before the cutover there were three such helpers, one per
 * entity, each re-implementing the same uppercase-and-lookup.
 *
 * Both directions are batched, because both have a fan-out caller: `/labels`
 * prints a sheet of codes at once, and an MCP response has to stamp a shortcode
 * onto every id it returns.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { type ParsedShortcode, parseShortcode } from "@cubby/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";

import { notDeleted, unwrapDb } from "./database-helpers";
import { SHORTCODE_TABLE, type ShortcodeTable } from "./shortcode-utils";

/** `{ id, shortcode }` read off a `ShortcodeTable`, whose columns are structural. */
type IdAndCode = { id: string; shortcode: string };

/** An entity id paired with the entity it belongs to. */
export interface EntityRef {
  entity: ShortcodeEntity;
  id: string;
}

/**
 * Resolve one shortcode to its entity and uuid, or null when the code is
 * malformed or unknown.
 *
 * Accepts legacy single-letter codes (`P-4K7M`) as well as canonical ones —
 * `parseShortcode` normalizes to canonical first, which is exactly what the
 * column stores.
 */
export async function resolveShortcode(
  db: Database | DrizzleTransaction,
  code: string,
): Promise<EntityRef | null> {
  const parsed = parseShortcode(code);
  if (!parsed) return null;
  const [row] = await resolveParsed(db, parsed.type, [parsed.shortcode]);
  return row ? { entity: row.entity, id: row.id } : null;
}

/**
 * Resolve a shortcode to a LIVE row's id of a specific entity, or null.
 *
 * The counterpart to {@link resolveShortcode}, and the one nearly every caller
 * wants: a detail page or a label lookup should 404 on a soft-deleted row, not
 * render it. The split is deliberate — `resolveShortcode` answers "what does
 * this code name", which stays true after a delete, while this answers "can I
 * still open it".
 *
 * The `entity` argument is not redundant with the code's own prefix: it pins the
 * caller's expectation, so a `LOC-` code handed to a product lookup returns null
 * rather than silently resolving to a location's uuid.
 */
export async function resolveLiveShortcode<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  code: string,
  entity: E,
): Promise<string | null> {
  const parsed = parseShortcode(code);
  if (!parsed || parsed.type !== entity) return null;

  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const rows = (await unwrapDb(db)
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.shortcode, parsed.shortcode), notDeleted(table)))
    .limit(1)) as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * Resolve many shortcodes at once — one query per entity type present, not one
 * per code. Unknown or malformed codes are simply absent from the result.
 *
 * Keyed by the CANONICAL code, so a caller that passed a legacy code should look
 * its result up via `parseShortcode(code).shortcode`.
 */
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
        resolved.set(row.shortcode, { entity: row.entity, id: row.id });
      }
    }),
  );
  return resolved;
}

/**
 * The reverse direction: uuid → shortcode, batched per entity type.
 *
 * Needed wherever a payload assembled from internal ids has to be rendered
 * publicly — chiefly the MCP output projections, which carry FK ids the tRPC
 * layer never enriched with a code.
 *
 * Keyed `"<entity>:<uuid>"` so refs to different entities can't collide.
 */
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
      const rows = (await unwrapDb(db)
        .select({ id: table.id, shortcode: table.shortcode })
        .from(table)
        .where(inArray(table.id, [...ids]))) as IdAndCode[];
      for (const row of rows) {
        codes.set(refKey(entity, row.id), row.shortcode);
      }
    }),
  );
  return codes;
}

/** The key `lookupShortcodes` returns results under. */
export const refKey = (entity: Entity, id: string): string => `${entity}:${id}`;

/** One entity's codes → ids. Split out so both resolve paths share the query. */
async function resolveParsed(
  db: Database | DrizzleTransaction,
  entity: ParsedShortcode["type"],
  codes: readonly string[],
): Promise<(EntityRef & { shortcode: string })[]> {
  if (codes.length === 0) return [];
  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  // No `notDeleted` filter: resolution answers "what does this code name",
  // which stays true after a soft delete. Callers that need a LIVE row (every
  // detail route) get their 404 from the subsequent `getByID`, which does
  // filter — and that split is deliberate, so scanning the label on a bin you
  // deleted says "this location was deleted" rather than "no such code".
  const rows = (await unwrapDb(db)
    .select({ id: table.id, shortcode: table.shortcode })
    .from(table)
    .where(inArray(table.shortcode, [...codes]))) as IdAndCode[];
  return rows.map((row) => ({
    entity,
    id: row.id,
    shortcode: row.shortcode,
  }));
}
