import { collectionSlug, type CollectionSlug } from "@cubby/schemas/collection";
import { collectionSlugsFromTags } from "@cubby/shared/collection-tag";

export interface MembershipLocation {
  id: string;
  parentId: string | null;
  productId: string | null;
  tags: string[];
}

export interface MembershipProduct {
  id: string;
  tags: string[];
}

export const directCollectionMembership = (
  tags: readonly string[],
): Set<CollectionSlug> =>
  new Set(
    collectionSlugsFromTags(tags).map((slug) => collectionSlug.parse(slug)),
  );

export function deriveCollectionMembership({
  products,
  locations,
  inventory,
}: {
  products: readonly MembershipProduct[];
  locations: readonly MembershipLocation[];
  inventory: ReadonlyArray<{ productId: string; locationId: string }>;
}) {
  const locationsById = new Map(locations.map((loc) => [loc.id, loc]));
  const locationInherited = new Map<string, Set<CollectionSlug>>();
  const locationEffective = new Map<string, Set<CollectionSlug>>();

  const resolveLocation = (
    loc: MembershipLocation,
    visiting = new Set<string>(),
  ): Set<CollectionSlug> => {
    const cached = locationEffective.get(loc.id);
    if (cached) return cached;
    if (visiting.has(loc.id)) return directCollectionMembership(loc.tags);
    visiting.add(loc.id);
    const parent = loc.parentId ? locationsById.get(loc.parentId) : undefined;
    const inherited = parent
      ? new Set(resolveLocation(parent, visiting))
      : new Set<CollectionSlug>();
    visiting.delete(loc.id);
    locationInherited.set(loc.id, inherited);
    const effective = new Set([
      ...inherited,
      ...directCollectionMembership(loc.tags),
    ]);
    locationEffective.set(loc.id, effective);
    return effective;
  };

  for (const loc of locations) resolveLocation(loc);

  const productInherited = new Map<string, Set<CollectionSlug>>();
  const addProductLocation = (productId: string, locationId: string) => {
    const memberships = locationEffective.get(locationId);
    if (!memberships) return;
    const current =
      productInherited.get(productId) ?? new Set<CollectionSlug>();
    for (const slug of memberships) current.add(slug);
    productInherited.set(productId, current);
  };
  for (const entry of inventory)
    addProductLocation(entry.productId, entry.locationId);

  // `Location.productId` identifies the physical container represented by the
  // Location; it does not place that Product inside itself. Only inventory
  // entries inherit Collection membership from a Location subtree.

  const collections = [
    ...new Set(
      [...products, ...locations].flatMap((item) => [
        ...directCollectionMembership(item.tags),
      ]),
    ),
  ].sort();

  return {
    collections,
    locationInherited,
    locationEffective,
    productInherited,
  };
}
