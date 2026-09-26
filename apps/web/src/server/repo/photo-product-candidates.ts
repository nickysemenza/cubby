import { parseShortcodeFor, type ProductId } from "@cubby/schemas/identifiers";
import type {
  PhotoGroupProposal,
  PhotoProductCandidate,
} from "@cubby/schemas/photo-import-run";
import { and, desc, ilike, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { compareProductTitles } from "~/server/repo/product-variant-comparison";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product/crud";

const CANDIDATE_POOL_LIMIT = 240;
const SUGGESTION_LIMIT = 5;

// Product is the only table in the outer query. Qualify the correlation by
// hand so an inner table cannot accidentally shadow its id.
const HAS_OWN_PHOTO = sql.raw(`EXISTS (
  SELECT 1 FROM "EntityAttachment" pc_ea
  JOIN "Image" pc_i ON pc_i."id" = pc_ea."imageId" AND pc_i."deletedAt" IS NULL
  WHERE pc_ea."subjectEntityId" = "Product"."id"
    AND pc_ea."deletedAt" IS NULL AND pc_i."source" = 'own'
)`);
const HAS_PHOTO_IMPORT = sql.raw(`EXISTS (
  SELECT 1 FROM "EntityAttachment" pc_ea
  JOIN "Image" pc_i ON pc_i."id" = pc_ea."imageId" AND pc_i."deletedAt" IS NULL
  JOIN "RunTarget" pc_t ON pc_t."imageId" = pc_i."id"
  JOIN "Run" pc_r ON pc_r."id" = pc_t."runId"
  WHERE pc_ea."subjectEntityId" = "Product"."id"
    AND pc_ea."deletedAt" IS NULL AND pc_r."deletedAt" IS NULL
    AND pc_r."purpose" = 'photo_inventory'
)`);
const HAS_PURCHASE = sql.raw(`EXISTS (
  SELECT 1 FROM "PurchaseProduct" pc_pp
  JOIN "Purchase" pc_p ON pc_p."id" = pc_pp."purchaseId" AND pc_p."deletedAt" IS NULL
  WHERE pc_pp."productId" = "Product"."id" AND pc_pp."deletedAt" IS NULL
) OR EXISTS (
  SELECT 1 FROM "Expense" pc_e
  JOIN "Purchase" pc_p ON pc_p."id" = pc_e."purchaseId" AND pc_p."deletedAt" IS NULL
  WHERE pc_e."productId" = "Product"."id" AND pc_e."deletedAt" IS NULL
)`);
const HAS_INVENTORY = sql.raw(`EXISTS (
  SELECT 1 FROM "InventoryEntry" pc_inv
  WHERE pc_inv."productId" = "Product"."id" AND pc_inv."deletedAt" IS NULL
)`);

type CandidateFact = {
  id: ProductId;
  shortcode: string;
  name: string;
  manufacturer: string | null;
  hasOwnPhoto: boolean;
  hasPhotoImport: boolean;
  hasPurchase: boolean;
  hasInventory: boolean;
};

type RankedCandidate = CandidateFact & {
  sharedNameTerms: string[];
  brandMatches: boolean;
  variant: ReturnType<typeof compareProductTitles>;
};

/** Splits compact vendor titles like `ForgeWearMenPocketShirtBlackSmall`. */
function productIdentityWords(value: string): Set<string> {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return new Set(
    spaced
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !/^[0-9]+$/.test(word))
      .filter(
        (word) => !["the", "and", "for", "size", "unconfirmed"].includes(word),
      ),
  );
}

export function rankPhotoProductCandidates(
  name: string,
  manufacturer: string | null,
  candidates: readonly CandidateFact[],
): RankedCandidate[] {
  const wanted = productIdentityWords(name);
  const brand = manufacturer?.toLowerCase().trim() || null;
  const brandWords = manufacturer
    ? productIdentityWords(manufacturer)
    : new Set<string>();
  const scored = candidates.flatMap((candidate) => {
    const words = productIdentityWords(candidate.name);
    const shared = [...wanted].filter((word) => words.has(word));
    const sharedIdentity = shared.filter((word) => !brandWords.has(word));
    const brandMatch =
      !!brand &&
      (candidate.manufacturer?.toLowerCase() === brand ||
        candidate.name.toLowerCase().includes(brand));
    if (sharedIdentity.length < (brandMatch ? 1 : 2)) return [];
    const variant = compareProductTitles(name, candidate.name);
    // One additional identity word (often the exact color or size) must outrank
    // every provenance preference combined. Provenance breaks ties between
    // plausible variants; it cannot turn a different variant into the match.
    const identityScore =
      shared.length * 30 +
      (shared.length / Math.max(1, wanted.size)) * 35 +
      (brandMatch ? 50 : 0);
    const provenanceScore =
      (!candidate.hasOwnPhoto ? 10 : 0) +
      (!candidate.hasPhotoImport ? 8 : 0) +
      (candidate.hasPurchase ? 3 : 0) -
      (candidate.hasInventory ? 6 : 0);
    const variantPenalty =
      (variant.color.relation === "different" ? 80 : 0) +
      (variant.size.relation === "different" ? 80 : 0);
    const score = identityScore + provenanceScore - variantPenalty;
    return [{ candidate, score, sharedIdentity, brandMatch, variant }];
  });
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.shortcode.localeCompare(b.candidate.shortcode),
    )
    .slice(0, SUGGESTION_LIMIT)
    .map(({ candidate, sharedIdentity, brandMatch, variant }) => ({
      ...candidate,
      sharedNameTerms: sharedIdentity,
      brandMatches: brandMatch,
      variant,
    }));
}

const searchPattern = (value: string) =>
  `%${value.replace(/[\\%_]/g, "\\$&")}%`;

/** Bounded, read-only suggestions for one review group; every choice stays human-approved. */
export async function photoProductCandidates(
  db: Database,
  proposal: PhotoGroupProposal,
): Promise<PhotoProductCandidate[]> {
  const name =
    proposal.product.kind === "create"
      ? proposal.product.create.name
      : proposal.committedProduct?.name;
  if (!name) return [];
  const manufacturer =
    proposal.product.kind === "create"
      ? (proposal.product.create.manufacturer ?? null)
      : null;
  return findPhotoProductCandidates(db, {
    name,
    manufacturer,
    excludeId: proposal.committedProduct?.id,
  });
}

export async function findPhotoProductCandidates(
  db: Database,
  input: { name: string; manufacturer?: string | null; excludeId?: string },
): Promise<PhotoProductCandidate[]> {
  const { name, manufacturer } = input;
  const words = [...productIdentityWords(name)];
  const brand = manufacturer?.trim();
  const descriptors = words
    .filter((word) => word.length > 3 && !brand?.toLowerCase().includes(word))
    .slice(0, 5);
  const terms = brand ? [brand] : words.slice(0, 2);
  if (!terms.length) return [];
  const rows = await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      hasOwnPhoto: sql<boolean>`${HAS_OWN_PHOTO}`,
      hasPhotoImport: sql<boolean>`${HAS_PHOTO_IMPORT}`,
      hasPurchase: sql<boolean>`(${HAS_PURCHASE})`,
      hasInventory: sql<boolean>`${HAS_INVENTORY}`,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        or(
          ...terms.flatMap((term) => [
            ilike(product.name, searchPattern(term)),
            ilike(product.manufacturer, searchPattern(term)),
          ]),
        ),
        brand && descriptors.length
          ? or(
              ...descriptors.map((term) =>
                ilike(product.name, searchPattern(term)),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(sql<number>`similarity(${product.name}, ${name})`))
    .limit(CANDIDATE_POOL_LIMIT);
  const ranked = rankPhotoProductCandidates(
    name,
    manufacturer ?? null,
    rows.filter((row) => row.shortcode !== input.excludeId),
  );
  const covers = await getProductCoverImageUrlsByProductIds(
    db,
    ranked.map((candidate) => candidate.id),
  );
  return ranked.map((candidate) => ({
    id: parseShortcodeFor("product", candidate.shortcode),
    name: candidate.name,
    coverUrl: covers.get(candidate.id) ?? null,
    match: {
      source: "catalog_name" as const,
      sharedNameTerms: candidate.sharedNameTerms,
      brandMatches: candidate.brandMatches,
      variant: candidate.variant,
    },
    hasOwnPhoto: candidate.hasOwnPhoto,
    hasPhotoImport: candidate.hasPhotoImport,
    hasPurchase: candidate.hasPurchase,
    hasInventory: candidate.hasInventory,
  }));
}
