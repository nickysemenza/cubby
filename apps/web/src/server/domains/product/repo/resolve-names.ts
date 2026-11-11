import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { productResolveCandidateOut } from "@cubby/schemas/product";
import type {
  ProductResolveCandidateOut,
  ProductResolveLineInput,
  ProductResolveNamesInput,
  ProductResolveNamesOut,
} from "@cubby/schemas/product";
import type {
  RawProductPickerItem,
  RawProductResolveCandidate,
} from "@cubby/schemas/product-raw-read";
import { and, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  productBrandNameSql,
  productBrandCodeSql,
} from "~/server/db/computed/product-brand-sql";
import { hasTextSql } from "~/server/db/computed/text-whitespace";
import { getDb, notDeleted, unwrapDb } from "~/server/db/helpers";
import { textArrayParam, uuidArrayParam } from "~/server/db/helpers/query";
import { product } from "~/server/db/schema";
import {
  externalIdKey,
  findProductsByExternalIds,
} from "~/server/domains/product/repo/find-by-external-ids";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { createAppError } from "~/server/errors/app-error";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";

import { getProductPickerItemsByIds } from "./crud";

const MAX_LINES = 200;

const toCandidate = (
  item: RawProductPickerItem,
): RawProductResolveCandidate => ({
  id: item.id,
  name: item.name,
  brandId: item.brandId,
  brandName: item.brandName,
  category: item.category,
  categoryFeature: item.categoryFeature,
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
  const candidates = await publicFieldEnvelopeRows({
    db,
    entity: "product",
    schema: productResolveCandidateOut,
    rows: items.map(toCandidate),
  });
  const itemByShortcode = new Map<string, ProductResolveCandidateOut>(
    candidates.map((item) => [item.id, item]),
  );
  const hydrate = (shortcodes: string[]) =>
    shortcodes
      .map((shortcode) => itemByShortcode.get(shortcode))
      .filter((item): item is ProductResolveCandidateOut => item !== undefined);
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
      brandCode: productBrandCodeSql(product.brandId),
      brandName: productBrandNameSql(product.brandId),
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

/**
 * Live Products whose name or an alias equals `name` apart from letter case and
 * surrounding spaces (terminology "Exact identity match"), oldest first.
 */
export const findExactProductNameMatches = async (
  db: Database | DrizzleTransaction,
  name: string,
) => (await findExactProductNameMatchesByName(db, [name])).get(name) ?? [];

/** `findExactProductNameMatches` for several names, keyed by each name as given. */
export const findExactProductNameMatchesByName = async (
  db: Database | DrizzleTransaction,
  names: readonly string[],
) => {
  const queried = [...new Set(names)].filter((name) => name.trim());
  // resolveNames answers each non-blank request in order.
  const resolved = queried.length
    ? await resolveNames(
        db,
        "product",
        queried.map((name) => ({ name })),
        { create: false },
      )
    : [];
  const idsByName = new Map(
    queried.map((name, index) => {
      const match = resolved[index];
      return [
        name,
        match?.row
          ? [match.row.id, ...match.candidates.map(({ id }) => id)]
          : [],
      ];
    }),
  );
  const ids = [...new Set([...idsByName.values()].flat())];
  const rows = ids.length
    ? await unwrapDb(db)
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          brandCode: productBrandCodeSql(product.brandId),
          brandName: productBrandNameSql(product.brandId),
        })
        .from(product)
        .where(
          and(
            notDeleted(product),
            sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
          ),
        )
    : [];
  return new Map(
    names.map((name) => [
      name,
      (idsByName.get(name) ?? []).flatMap((id) =>
        rows.filter((row) => row.id === id),
      ),
    ]),
  );
};

/** Live lexical review fence: independent of embeddings and background indexing.
 * Brand plus two substantive item words ranks a possible duplicate, never proves a variant. */
export async function findProductIdentityReviewCandidates(
  db: Database | DrizzleTransaction,
  name: string,
) {
  return (
    (await findProductIdentityReviewCandidatesByName(db, [name])).get(name) ??
    []
  );
}

/** `findProductIdentityReviewCandidates` for several names in one statement. */
export async function findProductIdentityReviewCandidatesByName(
  db: Database | DrizzleTransaction,
  names: readonly string[],
) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .trim();
  const titles = [...new Set(names.map(normalize))];
  const brandToken = sql<string>`trim(regexp_replace(lower(${productBrandNameSql(product.brandId)}), '[^a-z0-9]+', ' ', 'g'))`;
  const rows = titles.length
    ? await unwrapDb(db)
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          brandCode: productBrandCodeSql(product.brandId),
          brandName: productBrandNameSql(product.brandId),
          model: product.model,
          aliases: product.aliases,
          brandToken,
        })
        .from(product)
        .where(
          and(
            notDeleted(product),
            hasTextSql(productBrandNameSql(product.brandId)),
            sql`EXISTS (SELECT 1 FROM unnest(${textArrayParam(titles)}) AS review_title(title)
              WHERE strpos(' ' || review_title.title || ' ', ' ' || ${brandToken} || ' ') > 0)`,
          ),
        )
    : [];
  const candidatesFor = (name: string) => {
    const title = ` ${normalize(name)} `;
    return rows
      .filter((row) => {
        if (!title.includes(` ${row.brandToken} `)) return false;
        const brand = new Set(normalize(row.brandName ?? "").split(" "));
        const words = (value: string) =>
          new Set(
            normalize(value)
              .split(" ")
              .filter(
                (word) =>
                  word.length > 2 &&
                  !brand.has(word) &&
                  !["with", "the", "for", "size", "style"].includes(word),
              ),
          );
        const wanted = words(name);
        return [row.name, ...row.aliases].some((value) => {
          const candidate = words(value);
          const shared = [...candidate].filter((word) =>
            wanted.has(word),
          ).length;
          return (
            shared >= 2 && shared / Math.min(candidate.size, wanted.size) >= 0.6
          );
        });
      })
      .map(({ aliases: _aliases, brandToken: _brandToken, ...row }) => row);
  };
  return new Map(names.map((name) => [name, candidatesFor(name)]));
}

export const PRODUCT_IDENTITY_REVIEW_REASON =
  "Review similar brand/item identity before creating; compare photos, model, size and color.";
