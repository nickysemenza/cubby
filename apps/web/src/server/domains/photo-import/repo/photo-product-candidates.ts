import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  parseShortcodeFor,
  type ProductId,
} from "@cubby/schemas/identifiers";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import type {
  PhotoGroupProposal,
  PhotoProductCandidate,
  PhotoProductEvidence,
  PhotoRunImage,
  PhotoAcceptedSourceLine,
} from "@cubby/schemas/photo-import-run";
import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";
import { importExtractionOutcome } from "@cubby/schemas/purchase-import";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import type { AiRunContext } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { getDb, ilikeContains, notDeleted } from "~/server/db/helpers";
import {
  entityExternalId,
  expense,
  product,
  purchase,
  importSourceOrder,
  importSourceClaim,
  sourceOrderObservation,
  ledgerParty,
} from "~/server/db/schema";
import {
  getProductCoverImageUrlsByProductIds,
  getProductImagesByProductIds,
} from "~/server/domains/product/repo/crud";
import { loadProductInventoryEntries } from "~/server/domains/product/repo/lookup";
import { unknownProductVariantComparison } from "~/server/domains/product/repo/product-variant-comparison";
import { loadProductQuantitySummaries } from "~/server/domains/product/repo/quantity-ledger";
import { sourceObservationIdentitySql } from "~/server/domains/purchase-import/repo/reconciliation-observations";
import {
  ensureRun,
  aiCallRunInput,
} from "~/server/domains/run/repo/ensure-run";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { photoFieldCrossCheck } from "./photo-correctness";

const CANDIDATE_POOL_LIMIT = 240;
const SUGGESTION_LIMIT = 20;

type AssociationExpense = Pick<
  typeof expense.$inferSelect,
  "id" | "purchaseId" | "name" | "cost" | "lineKind"
>;

/** Read selectors only; the shared prepare/commit path rechecks ownership and the ledger. */
export async function loadPhotoAcceptedSourceLines(
  db: Database,
  lines: readonly AssociationExpense[],
  actor: Pick<ActorContext, "userId">,
): Promise<Map<AssociationExpense["id"], PhotoAcceptedSourceLine[]>> {
  const result = new Map<AssociationExpense["id"], PhotoAcceptedSourceLine[]>();
  const purchaseIds = [
    ...new Set(
      lines.flatMap((line) => (line.purchaseId ? [line.purchaseId] : [])),
    ),
  ];
  if (!purchaseIds.length) return result;
  const orders = await getDb(db)
    .select({
      id: importSourceOrder.id,
      purchaseId: importSourceOrder.purchaseId,
      extraction: sourceOrderObservation.extraction,
    })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, ledgerPartyKind.enum.member),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(
      purchase,
      and(eq(purchase.id, importSourceOrder.purchaseId), notDeleted(purchase)),
    )
    .innerJoin(
      sourceOrderObservation,
      and(
        eq(sourceOrderObservation.id, importSourceOrder.acceptedObservationId),
        eq(
          sourceOrderObservation.sourceClaimId,
          importSourceOrder.sourceClaimId,
        ),
        eq(sourceOrderObservation.orderKey, importSourceOrder.orderKey),
        sourceObservationIdentitySql(
          "purchase",
          sourceOrderObservation.purchaseId,
          importSourceOrder.purchaseId,
        ),
        sourceObservationIdentitySql(
          "vendor",
          sourceOrderObservation.vendorId,
          purchase.vendorId,
        ),
        eq(sourceOrderObservation.checksum, importSourceOrder.checksum),
      ),
    )
    .where(inArray(importSourceOrder.purchaseId, purchaseIds))
    .orderBy(importSourceOrder.id)
    .limit(1000);
  for (const order of orders) {
    const parsed = importExtractionOutcome.safeParse(order.extraction);
    if (!parsed.success || parsed.data.status !== "ready") continue;
    for (const [
      lineIndex,
      sourceLine,
    ] of parsed.data.candidate.lines.entries()) {
      for (const line of lines) {
        if (
          line.purchaseId !== order.purchaseId ||
          line.name !== sourceLine.title ||
          line.cost !== sourceLine.amount ||
          line.lineKind !== sourceLine.lineKind
        )
          continue;
        const selectors = result.get(line.id) ?? [];
        selectors.push({ sourceOrderId: order.id, lineIndex });
        result.set(line.id, selectors);
      }
    }
  }
  return result;
}

// Product is the only table in the outer query. Qualify the correlation by
// hand so an inner table cannot accidentally shadow its id.
const HAS_OWN_PHOTO = sql.raw(`EXISTS (
  SELECT 1 FROM "EntityAttachment" pc_ea
  JOIN "Image" pc_i ON pc_i."id" = pc_ea."imageId" AND pc_i."deletedAt" IS NULL
  WHERE pc_ea."entityId" = "Product"."id"
    AND pc_ea."deletedAt" IS NULL AND pc_i."source" = 'own'
)`);
const HAS_PHOTO_IMPORT = sql.raw(`EXISTS (
  SELECT 1 FROM "EntityAttachment" pc_ea
  JOIN "Image" pc_i ON pc_i."id" = pc_ea."imageId" AND pc_i."deletedAt" IS NULL
  JOIN "PhotoRunImage" pc_t ON pc_t."imageId" = pc_i."id"
  JOIN "Run" pc_r ON pc_r."id" = pc_t."runId"
  WHERE pc_ea."entityId" = "Product"."id"
    AND pc_ea."deletedAt" IS NULL AND pc_r."deletedAt" IS NULL
    AND pc_r."purpose" = 'photo_inventory'
)`);
const HAS_PURCHASE = sql.raw(`EXISTS (
  SELECT 1 FROM "EntityLink" pc_pp
  JOIN "Purchase" pc_p ON pc_p."id" = pc_pp."fromEntityId" AND pc_p."deletedAt" IS NULL
  WHERE pc_pp."toEntityId" = "Product"."id" AND pc_pp."deletedAt" IS NULL AND pc_pp."kind" = 'purchaseProduct'
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
  variant: ProductVariantComparison;
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
  comparisons: ReadonlyMap<ProductId, ProductVariantComparison> = new Map(),
  limit = SUGGESTION_LIMIT,
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
    const firstTitle = [name, ...evidenceTexts].join("\n");
    const secondTitle = [
      candidate.name,
      candidate.model,
      ...(candidate.aliases ?? []),
    ]
      .filter(Boolean)
      .join("\n");
    const variant =
      comparisons.get(candidate.id) ??
      unknownProductVariantComparison(firstTitle, secondTitle);
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
    .slice(0, limit)
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

/**
 * The color/size variant Decision between a source title and a candidate's;
 * supplied by the caller (`decideProductVariantComparisons`) so this read never
 * calls a model itself.
 */
export type ProductVariantComparator = (args: {
  comparisons: readonly { firstTitle: string; secondTitle: string }[];
  usage: AiRunContext;
}) => Promise<ProductVariantComparison[]>;

/** Bounded, read-only suggestions for one review group; every choice stays human-approved. */
export async function photoProductCandidates(
  db: Database,
  proposal: PhotoGroupProposal,
  images: readonly PhotoRunImage[] = [],
  actor: ActorContext,
  compareVariants: ProductVariantComparator,
  excludedProductIds: readonly string[] = [],
): Promise<PhotoProductCandidate[]> {
  const name =
    proposal.review?.observedName ??
    (proposal.product.kind === "create"
      ? proposal.product.create.name
      : (proposal.product.existing?.name ?? proposal.committedProduct?.name));
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
  return findPhotoProductCandidates(
    db,
    {
      name,
      manufacturer,
      model:
        proposal.product.kind === "create"
          ? proposal.product.create.model
          : null,
      excludeId: proposal.committedProduct?.id,
      excludedProductIds,
      evidenceTexts,
    },
    actor,
    compareVariants,
  );
}

export function photoCandidateIdentifiers(
  evidenceTexts: readonly { source: string; text: string }[],
) {
  return [
    ...new Set(
      evidenceTexts
        .filter((item) => item.source === "label_ocr")
        .flatMap(
          (item) =>
            item.text.match(/\b(?:[A-Z]{1,8}-?\d[A-Z0-9-]{2,}|\d{6,14})\b/gi) ??
            [],
        )
        .filter((identifier) => identifier.length <= 100)
        .map((identifier) => identifier.toUpperCase()),
    ),
  ]
    .sort()
    .slice(0, 30);
}

export async function selectedPhotoProductComparison(
  db: Database,
  proposal: PhotoGroupProposal,
  images: readonly PhotoRunImage[],
  actor: ActorContext,
  compareVariants: ProductVariantComparator,
) {
  if (proposal.product.kind !== "existing" || !proposal.product.existing)
    return null;
  const id = await resolveOrThrow(db, "product", proposal.product.existing.id);
  const selected = (await loadPhotoProductEvidence(db, [id], actor)).get(id);
  if (!selected) return null;
  const groupImages = new Set(proposal.images.map((entry) => entry.id));
  const printed = images
    .filter((entry) => groupImages.has(entry.id))
    .flatMap((entry) =>
      entry.recognizedText
        ? [{ source: "label_ocr", text: entry.recognizedText }]
        : [],
    );
  const name = proposal.review?.observedName ?? proposal.product.existing.name;
  const runId = await ensureRun(db, actor, aiCallRunInput(actor));
  const [variant] = await compareVariants({
    comparisons: [
      {
        firstTitle: [name, ...photoCandidateIdentifiers(printed)].join("\n"),
        secondTitle: [selected.name, selected.model].filter(Boolean).join("\n"),
      },
    ],
    usage: { db, runId, operation: "photo-import.product-variant-comparison" },
  });
  if (!variant)
    throw new Error(
      "Variant comparison returned no result for the selected Product",
    );
  return {
    id: selected.id,
    variant,
    crossCheck: photoFieldCrossCheck(
      selected,
      printed.map((item) => item.text),
      variant,
    ),
  };
}

export async function findPhotoProductCandidates(
  db: Database,
  input: {
    name: string;
    manufacturer?: string | null;
    model?: string | null;
    excludeId?: string;
    excludedProductIds?: readonly string[];
    evidenceTexts?: readonly {
      source: "photo_description" | "label_ocr";
      text: string;
    }[];
  },
  actor: ActorContext,
  compareVariants: ProductVariantComparator,
): Promise<PhotoProductCandidate[]> {
  const { name, manufacturer } = input;
  const words = [...productIdentityWords(name)];
  const brand = manufacturer?.trim();
  const descriptors = words
    .filter((word) => word.length > 3 && !brand?.toLowerCase().includes(word))
    .slice(0, 5);
  const terms = brand ? [brand] : words.slice(0, 2);
  const identifiers = photoCandidateIdentifiers(input.evidenceTexts ?? []);
  const exactRows = identifiers.length
    ? await getDb(db)
        .select({
          productId: entityExternalId.entityId,
          externalId: entityExternalId.externalId,
        })
        .from(entityExternalId)
        .where(
          and(
            notDeleted(entityExternalId),
            eq(entityExternalId.entityKind, "product"),
            inArray(entityExternalId.externalId, identifiers),
          ),
        )
        .limit(50)
    : [];
  const exactIds = [
    ...new Set(exactRows.map((row) => parseEntityId("product", row.productId))),
  ];
  if (!terms.length && !exactIds.length) return [];
  const textMatch = (term: string) => {
    const pattern = ilikeContains(term);
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
  const candidateFacts = rows
    .filter(
      (row) =>
        row.shortcode !== input.excludeId &&
        !input.excludedProductIds?.includes(row.shortcode),
    )
    .map((row) => ({
      ...row,
      exactIdentifier: exactIds.includes(row.id),
      matchedIdentifiers: exactRows
        .filter((entry) => entry.productId === row.id)
        .map((entry) => entry.externalId),
    }));
  const sourceTitle = [name, ...identifiers.sort()].join("\n");
  const preliminary = rankPhotoProductCandidates(
    name,
    manufacturer ?? null,
    candidateFacts,
    (input.evidenceTexts ?? []).map((evidence) => evidence.text),
    new Map(),
    candidateFacts.length,
  );
  const variantComparisons = new Map<ProductId, ProductVariantComparison>();
  if (preliminary.length > 0) {
    const runId = await ensureRun(db, actor, aiCallRunInput(actor));
    const usage: AiRunContext = {
      db,
      runId,
      operation: "photo-import.product-variant-comparison",
    };
    const comparisons = await compareVariants({
      comparisons: preliminary.map((candidate) => ({
        firstTitle: sourceTitle,
        secondTitle: [candidate.name, candidate.model]
          .filter(Boolean)
          .join("\n"),
      })),
      usage,
    });
    preliminary.forEach((candidate, index) =>
      variantComparisons.set(candidate.id, comparisons[index]!),
    );
  }
  const ranked = rankPhotoProductCandidates(
    name,
    manufacturer ?? null,
    candidateFacts,
    (input.evidenceTexts ?? []).map((evidence) => evidence.text),
    variantComparisons,
  );
  const evidence = await loadPhotoProductEvidence(
    db,
    ranked.map((candidate) => candidate.id),
    actor,
  );
  return ranked.map((candidate) => ({
    ...evidence.get(candidate.id)!,
    id: parseShortcodeFor("product", candidate.shortcode),
    name: candidate.name,
    coverUrl: evidence.get(candidate.id)?.coverUrl ?? null,
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
    duplicateStrength:
      candidate.exactIdentifier ||
      (Boolean(manufacturer?.trim()) &&
        candidate.manufacturer?.trim().toLowerCase() ===
          manufacturer?.trim().toLowerCase() &&
        ((Boolean(input.model?.trim()) &&
          input.model?.trim().toLowerCase() ===
            candidate.model?.trim().toLowerCase()) ||
          (candidate.sharedNameTerms.length >= 2 &&
            candidate.sharedNameTerms.length /
              Math.max(
                1,
                productIdentityWords(name).size -
                  productIdentityWords(manufacturer ?? "").size,
              ) >=
              0.8)))
        ? ("strong" as const)
        : ("weak" as const),
    crossCheck: photoFieldCrossCheck(
      evidence.get(candidate.id)!,
      (input.evidenceTexts ?? [])
        .filter((item) => item.source === "label_ocr")
        .map((item) => item.text),
      candidate.variant,
    ),
    variantEvidence: [
      { source: "proposal_name" as const, text: name },
      ...(input.evidenceTexts ?? []),
      { source: "product_name" as const, text: candidate.name },
    ],
  }));
}

export async function loadPhotoProductEvidence(
  db: Database,
  ids: ProductId[],
  actor: Pick<ActorContext, "userId">,
): Promise<Map<ProductId, PhotoProductEvidence>> {
  const products = ids.length
    ? await getDb(db)
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          manufacturer: product.manufacturer,
          model: product.model,
        })
        .from(product)
        .where(and(inArray(product.id, ids), notDeleted(product)))
    : [];
  const externalIds = ids.length
    ? await getDb(db)
        .select({
          id: entityExternalId.entityId,
          value: entityExternalId.externalId,
        })
        .from(entityExternalId)
        .where(
          and(
            inArray(entityExternalId.entityId, ids),
            notDeleted(entityExternalId),
          ),
        )
    : [];
  const [covers, quantities, inventoryEntries, galleries] = await Promise.all([
    getProductCoverImageUrlsByProductIds(db, ids),
    loadProductQuantitySummaries(db, ids),
    loadProductInventoryEntries(db, ids),
    getProductImagesByProductIds(db, ids),
  ]);
  const expenseRows = ids.length
    ? await getDb(db)
        .select({
          id: expense.id,
          productId: expense.productId,
          expenseId: expense.shortcode,
          purchaseId: expense.purchaseId,
          purchaseCode: purchase.shortcode,
          purchaseLabel: purchase.displayLabel,
          name: expense.name,
          date: expense.date,
          orderedDate: purchase.date,
          vendor: sql<
            string | null
          >`(SELECT v.name FROM "Vendor" v WHERE v.id = ${purchase.vendorId} AND v."deletedAt" IS NULL)`,
          cost: expense.cost,
          productQuantity: expense.productQuantity,
          lineKind: expense.lineKind,
        })
        .from(expense)
        .leftJoin(
          purchase,
          and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
        )
        .where(and(notDeleted(expense), inArray(expense.productId, ids)))
        .orderBy(
          sql`coalesce(${purchase.date}, ${expense.date}) DESC NULLS LAST`,
          desc(expense.createdAt),
        )
        .limit(500)
    : [];
  const acceptedSourceLines = await loadPhotoAcceptedSourceLines(
    db,
    expenseRows,
    actor,
  );
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
  return new Map(
    products.map((item) => [
      item.id,
      {
        id: parseShortcodeFor("product", item.shortcode),
        name: item.name,
        coverUrl: covers.get(item.id) ?? null,
        manufacturer: item.manufacturer,
        model: item.model,
        identifiers: externalIds
          .filter((entry) => entry.id === item.id)
          .map((entry) => entry.value),
        purchaseLineCount: expenseCountByProduct.get(item.id) ?? 0,
        quantity: quantities.get(item.id),
        inventoryEntries: inventoryEntries.get(item.id) ?? [],
        ownPhotos: (galleries[item.id] ?? [])
          .filter((image) => image.source === "own")
          .slice(0, 4)
          .map((image) => ({
            id: image.id,
            url: preferredImageUrl(image),
            capturedAt: image.capturedAt?.toISOString() ?? null,
          })),
        purchaseLines: expenseRows
          .filter((row) => row.productId === item.id)
          .slice(0, 3)
          .map((row) => ({
            expenseId: parseShortcodeFor("expense", row.expenseId),
            purchaseId: row.purchaseCode
              ? parseShortcodeFor("purchase", row.purchaseCode)
              : null,
            acceptedSourceLines: acceptedSourceLines.get(row.id) ?? [],
            purchaseLabel: row.purchaseLabel,
            name: row.name,
            date: row.purchaseCode ? row.orderedDate : row.date,
            dateLabel: row.purchaseCode
              ? ("Ordered" as const)
              : ("Paid" as const),
            vendor: row.vendor,
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
      },
    ]),
  );
}
