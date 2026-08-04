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
import {
  type BrandForEntity,
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  unsafeIdForEntity,
} from "@cubby/schemas/identifiers";
import { type ParsedShortcode, parseShortcode } from "@cubby/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";

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
 * Resolve many shortcodes of a SINGLE known entity to their LIVE uuids, in one
 * query — the batched counterpart to {@link resolveLiveShortcode}. Codes that
 * are malformed, belong to another entity, or name a soft-deleted row are
 * simply absent from the returned map (never thrown); callers that need every
 * input to resolve check the map's size against the input.
 */
export async function resolveLiveShortcodes<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  codes: readonly string[],
  entity: E,
): Promise<Map<string, string>> {
  const canonical = new Map<string, string>(); // canonical code -> original code
  for (const code of codes) {
    const parsed = parseShortcode(code);
    if (parsed && parsed.type === entity) canonical.set(parsed.shortcode, code);
  }
  if (canonical.size === 0) return new Map();

  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const rows = (await unwrapDb(db)
    .select({ id: table.id, shortcode: table.shortcode })
    .from(table)
    .where(
      and(inArray(table.shortcode, [...canonical.keys()]), notDeleted(table)),
    )) as IdAndCode[];

  const resolved = new Map<string, string>();
  for (const row of rows) {
    const originalCode = canonical.get(row.shortcode);
    if (originalCode !== undefined) resolved.set(originalCode, row.id);
  }
  return resolved;
}

/**
 * Resolve one shortcode to a LIVE branded id, or throw that entity's
 * not-found error.
 *
 * The throwing counterpart to {@link resolveLiveShortcode}, and what the large
 * majority of callers actually wanted: before this existed, ~37 sites spelled
 * out the same three steps by hand — resolve, `throw createAppError(<ENTITY>_
 * NOT_FOUND, …)`, then `unsafeXxxId(...)` the result. Both halves that made
 * those hand-rolled (the reason and the brand) are now derivable from the
 * entity, so the whole shape collapses to one call.
 *
 * Use {@link resolveLiveShortcode} directly where a miss is *not* a 404: a
 * nullable getter that returns `null`, a validation failure on caller-supplied
 * input (`REFERENCED_RECORD_MISSING`), or an invariant violation on a row the
 * same function just created (those throw a plain `Error` on purpose — turning
 * them into a client-facing 404 would be a regression).
 */
export async function resolveOrThrow<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  code: string,
): Promise<BrandForEntity<E>> {
  const id = await resolveLiveShortcode(db, code, entity);
  if (id === null) {
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[entity],
      `${ENTITY_LABEL[entity]} not found: ${code}`,
    );
  }
  return unsafeIdForEntity[entity](id);
}

/**
 * Resolve many shortcodes to LIVE branded ids, throwing if ANY is missing —
 * and naming every one that was, not just the first.
 *
 * This replaced two separate hand-rolled behaviors. The throw-listing-all shape
 * (which {@link resolveMergeTargets} already had) is kept; the throw-on-first
 * shape is deliberately *not*, because no caller benefited from learning only
 * the first bad code — a bulk delete of five codes with three typos took three
 * round trips to diagnose.
 *
 * Returns ids **positionally**, one per input code, with duplicates preserved,
 * so a caller can zip the result against its input. Callers for which repeats
 * are meaningless (`resolveMergeTargets`) dedupe on the way in.
 */
export async function resolveAllOrThrow<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  codes: readonly string[],
): Promise<BrandForEntity<E>[]> {
  if (codes.length === 0) return [];
  const resolved = await resolveLiveShortcodes(db, codes, entity);
  const missing = codes.filter((code) => !resolved.has(code));
  if (missing.length > 0) {
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[entity],
      `${ENTITY_LABEL[entity]} not found: ${[...new Set(missing)].join(", ")}`,
    );
  }
  // Non-null by construction: `missing` is empty, so every code is a key. The
  // `!` is the sanctioned form for an access right after a membership check
  // (see the `noUncheckedIndexedAccess` note in CLAUDE.md).
  return codes.map((code) => unsafeIdForEntity[entity](resolved.get(code)!));
}

/**
 * Resolve many shortcodes to LIVE branded ids, silently dropping any that
 * don't resolve.
 *
 * The third hand-rolled plural shape, and a genuine one: a filter built from
 * user-supplied codes narrows to what exists rather than 404-ing the whole
 * request. Named so the choice is visible at the call site — previously the
 * only way to tell "drops missing" from "throws" was to read the `.flatMap`
 * versus the `.filter` that followed.
 *
 * Order is preserved; the result is therefore shorter than the input when
 * something was dropped, so don't zip it against the input codes.
 */
export async function resolveAllPresent<E extends ShortcodeEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  codes: readonly string[],
): Promise<BrandForEntity<E>[]> {
  if (codes.length === 0) return [];
  const resolved = await resolveLiveShortcodes(db, codes, entity);
  return codes.flatMap((code) => {
    const id = resolved.get(code);
    return id === undefined ? [] : [unsafeIdForEntity[entity](id)];
  });
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
