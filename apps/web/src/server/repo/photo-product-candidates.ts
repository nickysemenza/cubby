import { parseShortcodeFor, type ProductId } from "@cubby/schemas/identifiers";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import type {
  PhotoGroupProposal,
  PhotoProductCandidate,
  PhotoRunImage,
} from "@cubby/schemas/photo-import-run";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  product,
  productExternalId,
  purchase,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  compareProductTitles,
  extractVariantFacts,
} from "~/server/repo/product-variant-comparison";
import {
  getProductCoverImageUrlsByProductIds,
  getProductImagesByProductIds,
} from "~/server/repo/product/crud";
import { loadProductInventoryEntries } from "~/server/repo/product/lookup";
import { loadProductQuantitySummaries } from "~/server/repo/product/quantity-ledger";

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
  model?: string | null;
  aliases?: string[];
  exactIdentifier?: boolean;
  matchedIdentifiers?: string[];
  hasOwnPhoto: boolean;
  hasPhotoImport: boolean;
  hasPurchase: boolean;
  hasInventory: boolean;
};

type RankedCandidate = CandidateFact & {
  sharedNameTerms: string[];
  brandMatches: boolean;
  variant: ReturnType<typeof compareProductTitles>;
  score: number;
  factors: { label: string; points: number }[];
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
  evidenceTexts: readonly string[] = [],
): RankedCandidate[] {
  const wanted = productIdentityWords(name);
  const brand = manufacturer?.toLowerCase().trim() || null;
  const brandWords = manufacturer
    ? productIdentityWords(manufacturer)
    : new Set<string>();
  const scored = candidates.flatMap((candidate) => {
    const words = productIdentityWords(
      [candidate.name, candidate.model, ...(candidate.aliases ?? [])]
        .filter(Boolean)
        .join(" "),
    );
    const shared = [...wanted].filter((word) => words.has(word));
    const sharedIdentity = shared.filter((word) => !brandWords.has(word));
    const brandMatch =
      !!brand &&
      (candidate.manufacturer?.toLowerCase() === brand ||
        candidate.name.toLowerCase().includes(brand));
    if (
      !candidate.exactIdentifier &&
      sharedIdentity.length < (brandMatch ? 1 : 2)
    )
      return [];
    const variant = compareProductTitles(
      [name, ...evidenceTexts].join(" "),
      [candidate.name, candidate.model, ...(candidate.aliases ?? [])]
        .filter(Boolean)
        .join(" "),
    );
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
    const identifierScore = candidate.exactIdentifier ? 200 : 0;
    const score =
      identityScore + provenanceScore + identifierScore - variantPenalty;
    const factors = [
      {
        label: "Shared identity words",
        points: identityScore - (brandMatch ? 50 : 0),
      },
      { label: "Brand match", points: brandMatch ? 50 : 0 },
      { label: "Exact external identifier", points: identifierScore },
      { label: "Purchase and photo history", points: provenanceScore },
      { label: "Explicit variant conflict", points: -variantPenalty },
    ].filter((factor) => factor.points !== 0);
    return [{ candidate, score, factors, sharedIdentity, brandMatch, variant }];
  });
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.shortcode.localeCompare(b.candidate.shortcode),
    )
    .slice(0, SUGGESTION_LIMIT)
    .map(
      ({ candidate, score, factors, sharedIdentity, brandMatch, variant }) => ({
        ...candidate,
        sharedNameTerms: sharedIdentity,
        brandMatches: brandMatch,
        variant,
        score,
        factors,
      }),
    );
}

const searchPattern = (value: string) =>
  `%${value.replace(/[\\%_]/g, "\\$&")}%`;

/** Bounded, read-only suggestions for one review group; every choice stays human-approved. */
export async function photoProductCandidates(
  db: Database,
  proposal: PhotoGroupProposal,
  images: readonly PhotoRunImage[] = [],
): Promise<PhotoProductCandidate[]> {
  const name =
    proposal.product.kind === "create"
      ? proposal.product.create.name
      : (proposal.product.existing?.name ?? proposal.committedProduct?.name);
  if (!name) return [];
  const manufacturer =
    proposal.product.kind === "create"
      ? (proposal.product.create.manufacturer ?? null)
      : null;
  const imageIds = new Set(proposal.images.map((entry) => entry.id));
  const evidenceTexts = images
    .filter((image) => imageIds.has(image.id))
    .flatMap((image) => [
      ...(image.description
        ? [{ source: "photo_description" as const, text: image.description }]
        : []),
      ...(image.recognizedText
        ? [{ source: "label_ocr" as const, text: image.recognizedText }]
        : []),
    ]);
  return findPhotoProductCandidates(db, {
    name,
    manufacturer,
    excludeId: proposal.committedProduct?.id,
    evidenceTexts,
  });
}

export async function findPhotoProductCandidates(
  db: Database,
  input: {
    name: string;
    manufacturer?: string | null;
    excludeId?: string;
    evidenceTexts?: readonly {
      source: "photo_description" | "label_ocr";
      text: string;
    }[];
  },
): Promise<PhotoProductCandidate[]> {
  const { name, manufacturer } = input;
  const words = [...productIdentityWords(name)];
  const brand = manufacturer?.trim();
  const descriptors = words
    .filter((word) => word.length > 3 && !brand?.toLowerCase().includes(word))
    .slice(0, 5);
  const terms = brand ? [brand] : words.slice(0, 2);
  const identifiers = [
    ...new Set(
      (input.evidenceTexts ?? [])
        .filter((evidence) => evidence.source === "label_ocr")
        .flatMap(
          (evidence) =>
            evidence.text.match(/\b[A-Z0-9][A-Z0-9-]{4,}\b/gi) ?? [],
        )
        .slice(0, 30),
    ),
  ];
  const exactRows = identifiers.length
    ? await getDb(db)
        .select({
          productId: productExternalId.productId,
          externalId: productExternalId.externalId,
        })
        .from(productExternalId)
        .where(
          and(
            notDeleted(productExternalId),
            inArray(productExternalId.externalId, identifiers),
          ),
        )
        .limit(50)
    : [];
  const exactIds = [...new Set(exactRows.map((row) => row.productId))];
  if (!terms.length && !exactIds.length) return [];
  const textMatch = (term: string) => {
    const pattern = searchPattern(term);
    return or(
      ilike(product.name, pattern),
      ilike(product.manufacturer, pattern),
      ilike(product.model, pattern),
      sql`EXISTS (SELECT 1 FROM unnest(${product.aliases}) AS alias WHERE alias ILIKE ${pattern})`,
    );
  };
  const lexical = or(...terms.map(textMatch));
  const descriptorMatch = or(...descriptors.map(textMatch));
  const rows = await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
      aliases: product.aliases,
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
          exactIds.length ? inArray(product.id, exactIds) : undefined,
          and(
            lexical,
            brand && descriptors.length ? descriptorMatch : undefined,
          ),
        ),
      ),
    )
    .orderBy(
      exactIds.length
        ? desc(
            sql<number>`CASE WHEN ${inArray(product.id, exactIds)} THEN 1 ELSE 0 END`,
          )
        : desc(sql<number>`similarity(${product.name}, ${name})`),
      desc(sql<number>`similarity(${product.name}, ${name})`),
    )
    .limit(CANDIDATE_POOL_LIMIT);
  const ranked = rankPhotoProductCandidates(
    name,
    manufacturer ?? null,
    rows
      .filter((row) => row.shortcode !== input.excludeId)
      .map((row) => ({
        ...row,
        exactIdentifier: exactIds.includes(row.id),
        matchedIdentifiers: exactRows
          .filter((entry) => entry.productId === row.id)
          .map((entry) => entry.externalId),
      })),
    (input.evidenceTexts ?? []).map((evidence) => evidence.text),
  );
  const ids = ranked.map((candidate) => candidate.id);
  const covers = await getProductCoverImageUrlsByProductIds(db, ids);
  const quantities = await loadProductQuantitySummaries(db, ids);
  const inventoryEntries = await loadProductInventoryEntries(db, ids);
  const galleries = await getProductImagesByProductIds(db, ids);
  const expenseRows = ids.length
    ? await getDb(db)
        .select({
          productId: expense.productId,
          expenseId: expense.shortcode,
          purchaseId: purchase.shortcode,
          purchaseLabel: purchase.displayLabel,
          name: expense.name,
          date: expense.date,
          cost: expense.cost,
          productQuantity: expense.productQuantity,
        })
        .from(expense)
        .leftJoin(
          purchase,
          and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
        )
        .where(and(notDeleted(expense), inArray(expense.productId, ids)))
        .orderBy(desc(expense.date))
        .limit(500)
    : [];
  const expenseCounts = ids.length
    ? await getDb(db)
        .select({
          productId: expense.productId,
          count: sql<number>`count(*)::int`,
        })
        .from(expense)
        .where(and(notDeleted(expense), inArray(expense.productId, ids)))
        .groupBy(expense.productId)
    : [];
  const expenseCountByProduct = new Map(
    expenseCounts.map((row) => [row.productId, row.count]),
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
      score: candidate.score,
      factors: candidate.factors,
      matchedIdentifiers: candidate.matchedIdentifiers,
    },
    hasOwnPhoto: candidate.hasOwnPhoto,
    hasPhotoImport: candidate.hasPhotoImport,
    hasPurchase: candidate.hasPurchase,
    hasInventory: candidate.hasInventory,
    purchaseLineCount: expenseCountByProduct.get(candidate.id) ?? 0,
    quantity: quantities.get(candidate.id),
    inventoryEntries: inventoryEntries.get(candidate.id) ?? [],
    ownPhotos: (galleries[candidate.id] ?? [])
      .filter((image) => image.source === "own")
      .slice(0, 4)
      .map((image) => ({ id: image.id, url: preferredImageUrl(image) })),
    variantEvidence: [
      { source: "proposal_name" as const, text: name },
      ...(input.evidenceTexts ?? []),
      { source: "product_name" as const, text: candidate.name },
      ...(candidate.model
        ? [{ source: "product_model" as const, text: candidate.model }]
        : []),
      ...(candidate.aliases ?? []).map((alias) => ({
        source: "product_alias" as const,
        text: alias,
      })),
      ...expenseRows
        .filter((row) => row.productId === candidate.id)
        .map((row) => ({ source: "purchase_line" as const, text: row.name })),
    ].flatMap(({ source, text }) => {
      const facts = extractVariantFacts(text);
      return (["color", "size"] as const).flatMap((dimension) => {
        const fact = facts[dimension];
        return fact
          ? [{ dimension, value: fact.value, raw: fact.raw, source }]
          : [];
      });
    }),
    purchaseLines: expenseRows
      .filter((row) => row.productId === candidate.id)
      .map((row) => ({
        expenseId: parseShortcodeFor("expense", row.expenseId),
        purchaseId: row.purchaseId
          ? parseShortcodeFor("purchase", row.purchaseId)
          : null,
        purchaseLabel: row.purchaseLabel,
        name: row.name,
        date: row.date,
        cost: row.cost,
        productQuantity: row.productQuantity,
        movement:
          row.productQuantity == null
            ? ("unknown" as const)
            : row.cost != null && row.cost < 0
              ? row.productQuantity === 0
                ? ("adjusted" as const)
                : ("exited" as const)
              : row.productQuantity < 0
                ? ("exited" as const)
                : ("acquired" as const),
      })),
  }));
}
