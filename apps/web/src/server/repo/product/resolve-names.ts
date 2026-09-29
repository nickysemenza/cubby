import type {
  ProductPickerItemOut,
  ProductResolveCandidateOut,
  ProductResolveNamesOut,
} from "@cubby/schemas/product";

import type { Database } from "~/server/db";
import { resolveNames } from "~/server/entity-kernel/resolve";

import { getProductPickerItemsByIds } from "./crud";

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
 * Shim over the kernel `resolve` capability (Product declares
 * `createMissing: false`, `candidates: 3`) kept for the product contract and
 * MCP tools; remove once they call `resolveEntity`. One entry per distinct
 * name: its exact name/alias matches, or a miss's top contains-matches,
 * hydrated as picker candidates in one batched read. Never writes.
 */
export const resolveProductNames = async (
  db: Database,
  names: string[],
): Promise<ProductResolveNamesOut> => {
  const seen = new Set<string>();
  const requested = names.flatMap((raw) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (key.length === 0 || seen.has(key)) return [];
    seen.add(key);
    return [{ name }];
  });
  if (requested.length === 0) return [];
  const resolved = await resolveNames(db, "product", requested, {
    create: false,
  });
  const idsFor = ({ row, candidates }: (typeof resolved)[number]) => [
    ...(row ? [row.id] : []),
    ...candidates.map((candidate) => candidate.id),
  ];
  const items = await getProductPickerItemsByIds(db, resolved.flatMap(idsFor));
  const itemByShortcode = new Map<string, ProductPickerItemOut>(
    items.map((item) => [item.id, item]),
  );
  return resolved.map((entry) => ({
    name: entry.name,
    exact: entry.row !== null,
    candidates: [
      ...(entry.row ? [entry.row.shortcode] : []),
      ...entry.candidates.map((candidate) => candidate.shortcode),
    ]
      .map((shortcode) => itemByShortcode.get(shortcode))
      .filter((item): item is ProductPickerItemOut => item !== undefined)
      .map(toCandidate),
  }));
};
