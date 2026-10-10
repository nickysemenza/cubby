import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProductPickerItemOut,
  ProductResolveCandidateOut,
  ProductResolveLineInput,
  ProductResolveNamesInput,
  ProductResolveNamesOut,
} from "@cubby/schemas/product";
import { and, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { createAppError } from "~/server/errors/app-error";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { getProductPickerItemsByIds } from "./crud";
import {
  externalIdKey,
  findProductsByExternalIds,
} from "./find-by-external-ids";

const MAX_LINES = 200;

const toCandidate = (
  item: ProductPickerItemOut,
): ProductResolveCandidateOut => ({
  id: item.id,
  name: item.name,
  manufacturer: item.manufacturer,
  category: item.category,
  price: item.price,
  coverImageUrl: item.coverImageUrl,
});

/**
 * The product resolve contract (web `product.resolveNames`, MCP
 * `entity.resolve` on product), composed over the kernel `resolve`
 * capability (Product declares `createMissing: false`, `candidates: 3`). It
 * adds what the generic result does not carry: picker-hydrated candidates,
 * external-id hits, and ingredient hits. One entry per line: the
 * bare `names` first (deduplicated case-insensitively), then `lines` as sent.
 * Each carries its exact name/alias matches or a miss's top lexical matches,
 * the Products holding its `(source, id)` pairs, and the Ingredients whose
 * name or alias equals it, hydrated as picker candidates in one batched read.
 * Never writes.
 */
export const resolveProductNames = async (
  db: Database,
  input: ProductResolveNamesInput,
): Promise<ProductResolveNamesOut> => {
  const seen = new Set<string>();
  const fromNames = (input.names ?? []).flatMap(
    (raw): ProductResolveLineInput[] => {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (key.length === 0 || seen.has(key)) return [];
      seen.add(key);
      return [{ name }];
    },
  );
  const lines = [...fromNames, ...(input.lines ?? [])];
  if (lines.length === 0) return [];
  // The two arrays are each capped in the schema; the sum is capped here.
  if (lines.length > MAX_LINES)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Resolve takes at most ${MAX_LINES} names and lines together (got ${lines.length}).`,
    );
  // resolveNames answers every request in order (names here are non-blank).
  const requested = lines.map(({ name }) => ({ name }));
  const [resolved, ingredients, idHits] = await Promise.all([
    resolveNames(db, "product", requested, { create: false }),
    resolveNames(db, "ingredient", requested, { create: false }),
    findProductsByExternalIds(
      db,
      lines.flatMap((line) =>
        (line.externalIds ?? []).map(({ source, id }) => ({
          source,
          externalId: id,
        })),
      ),
    ),
  ]);
  const idHitsFor = (line: ProductResolveLineInput) => [
    ...new Map(
      (line.externalIds ?? [])
        .flatMap(
          ({ source, id }) =>
            idHits.get(externalIdKey({ source, externalId: id })) ?? [],
        )
        .map((hit) => [hit.shortcode, hit]),
    ).values(),
  ];
  const idsFor = ({ row, candidates }: (typeof resolved)[number]) => [
    ...(row ? [row.id] : []),
    ...candidates.map((candidate) => candidate.id),
  ];
  const items = await getProductPickerItemsByIds(db, [
    ...resolved.flatMap(idsFor),
    ...lines.flatMap((line) => idHitsFor(line).map((hit) => hit.id)),
  ]);
  const itemByShortcode = new Map<string, ProductPickerItemOut>(
    items.map((item) => [item.id, item]),
  );
  const hydrate = (shortcodes: string[]) =>
    shortcodes
      .map((shortcode) => itemByShortcode.get(shortcode))
      .filter((item): item is ProductPickerItemOut => item !== undefined)
      .map(toCandidate);
  return resolved.map((entry, index) => {
    const ingredient = ingredients[index];
    return {
      name: entry.name,
      exact: entry.row !== null,
      candidates: hydrate([
        ...(entry.row ? [entry.row.shortcode] : []),
        ...entry.candidates.map((candidate) => candidate.shortcode),
      ]),
      exactIdHits: hydrate(
        idHitsFor(lines[index]!).map((hit) => hit.shortcode),
      ),
      ingredientHits: [
        ...(ingredient?.row ? [ingredient.row] : []),
        ...(ingredient?.candidates ?? []),
      ].map(({ shortcode, name }) => ({
        id: parseShortcodeFor("ingredient", shortcode),
        name,
      })),
    };
  });
};

/** Ranked name/alias candidates only: semantic variant admission remains with the caller. */
export const findProductNameCandidates = async (db: Database, name: string) => {
  const [resolved] = await resolveNames(db, "product", [{ name }], {
    create: false,
  });
  const ids = [
    ...(resolved?.row ? [resolved.row.id] : []),
    ...(resolved?.candidates.map(({ id }) => id) ?? []),
  ];
  if (ids.length === 0) return [];
  const rows = await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
    })
    .from(product)
    .where(and(notDeleted(product), inArray(product.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
};
