import { entityRefKey } from "@cubby/schemas/entity";
import {
  type SearchComponentPlacement,
  type SearchDestination,
  type SearchHit,
  type SearchInventoryPlacement,
  type SearchQueryInput,
  type SearchResultGroup,
  searchableEntitySchema,
  searchInventoryPlacementSchema,
} from "@cubby/schemas/search";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { executeSearchDocumentSql } from "~/server/repo/search-document";
import {
  findLexicalSearchCandidates,
  findRelatedSearchCandidates,
  hydrateSearchHitRefs,
  type InternalSearchCandidate,
  type InternalSearchHit,
} from "~/server/services/search.service";

const MAX_GROUP_CANDIDATES = 200;
const ACTIVITY_TYPES = new Set(["expense", "purchase", "task"]);

const candidateRelationSchema = z.object({
  entityType: searchableEntitySchema,
  entityId: z.uuid(),
  ordinal: z.number().int(),
  productId: z.uuid().nullable(),
});

const placementRowSchema = searchInventoryPlacementSchema.extend({
  productId: z.uuid(),
});

const componentEdgeSchema = z.object({
  parentProductId: z.uuid(),
  componentProductId: z.uuid(),
  componentQuantity: z.number().int().positive(),
});

const candidateKey = (candidate: { entityType: string; entityId: string }) =>
  `${candidate.entityType}:${candidate.entityId}`;

const destinationFromHit = (hit: SearchHit): SearchDestination => ({
  id: hit.id,
  entityType: hit.entityType,
  title: hit.title,
  subtitle: hit.subtitle,
  typeHint: hit.typeHint,
  imageUrl: hit.imageUrl,
});

const destinationFromInternalHit = (
  hit: InternalSearchHit,
): SearchDestination => destinationFromHit(hit);

async function loadCandidateRelations(
  db: Database,
  candidates: InternalSearchCandidate[],
) {
  if (candidates.length === 0) return [];
  const values = sql.join(
    candidates.map(
      (candidate, ordinal) =>
        sql`(${candidate.entityType}::text, ${candidate.entityId}::uuid, ${ordinal}::integer)`,
    ),
    sql`, `,
  );
  return executeSearchDocumentSql(
    db,
    candidateRelationSchema,
    sql`
      WITH refs("entityType", "entityId", ordinal) AS (VALUES ${values})
      SELECT refs."entityType", refs."entityId"::text AS "entityId", refs.ordinal,
        CASE refs."entityType"
          WHEN 'product' THEN (
            SELECT p.id FROM "Product" p
            WHERE p.id = refs."entityId" AND p."deletedAt" IS NULL
          )
          WHEN 'inventory' THEN (
            SELECT ie."productId"
            FROM "InventoryEntry" ie
            JOIN "Product" p ON p.id = ie."productId" AND p."deletedAt" IS NULL
            WHERE ie.id = refs."entityId" AND ie."deletedAt" IS NULL
          )
          WHEN 'expense' THEN (
            SELECT e."productId"
            FROM "Expense" e
            JOIN "Product" p ON p.id = e."productId" AND p."deletedAt" IS NULL
            WHERE e.id = refs."entityId" AND e."deletedAt" IS NULL
          )
          WHEN 'task' THEN (
            SELECT t."subjectProductId"
            FROM "Task" t
            JOIN "Product" p ON p.id = t."subjectProductId" AND p."deletedAt" IS NULL
            WHERE t.id = refs."entityId" AND t."deletedAt" IS NULL
          )
          WHEN 'purchase' THEN (
            SELECT CASE
              WHEN count(pp.id) = 1 AND count(p.id) = 1
                THEN (array_agg(pp."productId"))[1]
            END
            FROM "Purchase" purchase
            LEFT JOIN "PurchaseProduct" pp
              ON pp."purchaseId" = purchase.id AND pp."deletedAt" IS NULL
            LEFT JOIN "Product" p
              ON p.id = pp."productId" AND p."deletedAt" IS NULL
            WHERE purchase.id = refs."entityId" AND purchase."deletedAt" IS NULL
          )
          ELSE NULL
        END::text AS "productId"
      FROM refs
      ORDER BY refs.ordinal
    `,
  );
}

async function loadProductPlacements(db: Database, productIds: string[]) {
  if (productIds.length === 0)
    return new Map<string, SearchInventoryPlacement[]>();
  const values = sql.join(
    productIds.map((productId) => sql`(${productId}::uuid)`),
    sql`, `,
  );
  const rows = await executeSearchDocumentSql(
    db,
    placementRowSchema,
    sql`
      WITH RECURSIVE requested("productId") AS (VALUES ${values}),
      live_placements AS (
        SELECT ie.id, ie.shortcode, ie."productId", ie."locationId", ie.amount, ie.placement
        FROM "InventoryEntry" ie
        JOIN requested r ON r."productId" = ie."productId"
        JOIN "Product" p ON p.id = ie."productId" AND p."deletedAt" IS NULL
        WHERE ie."deletedAt" IS NULL
      ),
      location_path AS (
        SELECT lp.id AS "inventoryId", l.id, l."parentId", l.name, 0 AS depth
        FROM live_placements lp
        JOIN "Location" l ON l.id = lp."locationId" AND l."deletedAt" IS NULL
        UNION ALL
        SELECT child."inventoryId", parent.id, parent."parentId", parent.name, child.depth + 1
        FROM "Location" parent
        JOIN location_path child ON child."parentId" = parent.id
        WHERE parent."deletedAt" IS NULL
      )
      SELECT lp."productId"::text AS "productId", lp.shortcode AS id,
        l.shortcode AS "locationId",
        COALESCE((
          SELECT string_agg(path.name, ' › ' ORDER BY path.depth DESC)
          FROM location_path path
          WHERE path."inventoryId" = lp.id
        ), l.name) AS "locationPath",
        lp.amount, lp.placement
      FROM live_placements lp
      JOIN "Location" l ON l.id = lp."locationId" AND l."deletedAt" IS NULL
      ORDER BY "locationPath", lp.placement, lp.shortcode
    `,
  );
  const byProduct = new Map<string, SearchInventoryPlacement[]>();
  for (const { productId, ...placement } of rows) {
    const placements = byProduct.get(productId) ?? [];
    placements.push(placement);
    byProduct.set(productId, placements);
  }
  return byProduct;
}

async function loadComponentPlacements(
  db: Database,
  parentProductIds: string[],
) {
  if (parentProductIds.length === 0)
    return new Map<string, SearchComponentPlacement[]>();
  const values = sql.join(
    parentProductIds.map((productId) => sql`(${productId}::uuid)`),
    sql`, `,
  );
  const edges = await executeSearchDocumentSql(
    db,
    componentEdgeSchema,
    sql`
      WITH requested("productId") AS (VALUES ${values})
      SELECT pc."parentProductId"::text AS "parentProductId",
        pc."componentProductId"::text AS "componentProductId",
        pc.quantity AS "componentQuantity"
      FROM "ProductComponent" pc
      JOIN requested r ON r."productId" = pc."parentProductId"
      JOIN "Product" parent
        ON parent.id = pc."parentProductId" AND parent."deletedAt" IS NULL
      JOIN "Product" component
        ON component.id = pc."componentProductId" AND component."deletedAt" IS NULL
      WHERE pc."deletedAt" IS NULL
      ORDER BY pc."parentProductId", component.name, pc."componentProductId"
    `,
  );
  const componentProductIds = [
    ...new Set(edges.map((edge) => edge.componentProductId)),
  ];
  const [componentHits, placementsByProduct] = await Promise.all([
    hydrateSearchHitRefs(
      db,
      componentProductIds.map((entityId) => ({
        entityType: "product" as const,
        entityId,
      })),
    ),
    loadProductPlacements(db, componentProductIds),
  ]);
  const componentById = new Map(
    componentHits.map((hit) => [hit.entityId, destinationFromInternalHit(hit)]),
  );
  const byParent = new Map<string, SearchComponentPlacement[]>();
  for (const edge of edges) {
    const component = componentById.get(edge.componentProductId);
    if (!component) continue;
    const rows = byParent.get(edge.parentProductId) ?? [];
    for (const placement of placementsByProduct.get(edge.componentProductId) ??
      []) {
      rows.push({
        component,
        componentQuantity: edge.componentQuantity,
        placement,
      });
    }
    if (rows.length > 0) byParent.set(edge.parentProductId, rows);
  }
  return byParent;
}

async function addCandidateImages(
  db: Database,
  candidates: InternalSearchCandidate[],
) {
  const images = await resolveEntityDisplayImages(db, candidates);
  return new Map(
    candidates.map((candidate) => {
      const { entityId, ...hit } = candidate;
      return [
        candidateKey(candidate),
        {
          ...hit,
          imageUrl:
            images.get(entityRefKey(candidate.entityType, entityId))?.url ??
            null,
        } satisfies SearchHit,
      ];
    }),
  );
}

const matchRank = (hit: Pick<SearchHit, "matchKind">) =>
  ({ exact: 0, prefix: 1, text: 2, fuzzy: 3, semantic: 4 })[hit.matchKind];

interface MutableProductGroup {
  kind: "product";
  key: string;
  productId: string;
  bestCandidate: InternalSearchCandidate;
  ordinal: number;
  activityCandidates: InternalSearchCandidate[];
}

interface MutableEntityGroup {
  kind: "entity";
  key: string;
  candidate: InternalSearchCandidate;
  ordinal: number;
  linkedProductId: string | null;
}

type MutableGroup = MutableProductGroup | MutableEntityGroup;

const isProductCandidate = (candidate: InternalSearchCandidate) =>
  candidate.entityType === "product" || candidate.entityType === "inventory";

function mergeProductCandidate(
  group: MutableProductGroup,
  candidate: InternalSearchCandidate,
  ordinal: number,
) {
  if (matchRank(candidate) < matchRank(group.bestCandidate))
    group.bestCandidate = candidate;
  group.ordinal = Math.min(group.ordinal, ordinal);
}

function mergeActivityCandidate(
  group: MutableProductGroup,
  candidate: InternalSearchCandidate,
  ordinal: number,
) {
  group.activityCandidates.push(candidate);
  if (
    matchRank(candidate) < matchRank(group.bestCandidate) ||
    (matchRank(candidate) === matchRank(group.bestCandidate) &&
      ordinal < group.ordinal)
  )
    group.bestCandidate = candidate;
  group.ordinal = Math.min(group.ordinal, ordinal);
}

function collectMutableGroups(
  candidates: InternalSearchCandidate[],
  relationByCandidate: Map<string, string | null>,
  groupingEnabled: boolean,
): MutableGroup[] {
  const groups: MutableGroup[] = [];
  const productGroups = new Map<string, MutableProductGroup>();
  if (groupingEnabled) {
    for (const [ordinal, candidate] of candidates.entries()) {
      if (!isProductCandidate(candidate)) continue;
      const productId = relationByCandidate.get(candidateKey(candidate));
      if (!productId) continue;
      const existing = productGroups.get(productId);
      if (existing) {
        mergeProductCandidate(existing, candidate, ordinal);
        continue;
      }
      const group: MutableProductGroup = {
        kind: "product",
        key: `product:${productId}`,
        productId,
        bestCandidate: candidate,
        ordinal,
        activityCandidates: [],
      };
      productGroups.set(productId, group);
      groups.push(group);
    }
  }

  for (const [ordinal, candidate] of candidates.entries()) {
    const productId = relationByCandidate.get(candidateKey(candidate)) ?? null;
    const productGroup = productId ? productGroups.get(productId) : undefined;
    if (groupingEnabled && productGroup && isProductCandidate(candidate))
      continue;
    if (
      groupingEnabled &&
      productGroup &&
      ACTIVITY_TYPES.has(candidate.entityType)
    ) {
      mergeActivityCandidate(productGroup, candidate, ordinal);
      continue;
    }
    groups.push({
      kind: "entity",
      key: candidateKey(candidate),
      candidate,
      ordinal,
      linkedProductId:
        ACTIVITY_TYPES.has(candidate.entityType) && productId
          ? productId
          : null,
    });
  }
  return groups;
}

const mutableGroupHit = (group: MutableGroup) =>
  group.kind === "product" ? group.bestCandidate : group.candidate;

function groupPriority(group: MutableGroup, placeIntent: boolean) {
  if (
    placeIntent &&
    group.kind === "entity" &&
    group.candidate.entityType === "location"
  )
    return 0;
  if (group.kind === "product") return placeIntent ? 1 : 0;
  if (group.kind === "entity" && group.candidate.entityType === "location")
    return 1;
  return 2;
}

function sortMutableGroups(
  groups: MutableGroup[],
  candidates: InternalSearchCandidate[],
) {
  const placeIntent = candidates.some(
    (candidate) =>
      candidate.entityType === "location" &&
      (candidate.matchKind === "exact" || candidate.matchKind === "prefix") &&
      (candidate.matchField === "title" || candidate.matchField === "alias"),
  );
  groups.sort((left, right) => {
    const byMatch =
      matchRank(mutableGroupHit(left)) - matchRank(mutableGroupHit(right));
    return (
      byMatch ||
      groupPriority(left, placeIntent) - groupPriority(right, placeIntent) ||
      left.ordinal - right.ordinal
    );
  });
}

async function composeSearchGroups(
  db: Database,
  candidates: InternalSearchCandidate[],
  input: SearchQueryInput,
): Promise<SearchResultGroup[]> {
  if (candidates.length === 0) return [];
  const relations = await loadCandidateRelations(db, candidates);
  const relationByCandidate = new Map(
    relations.map((relation) => [candidateKey(relation), relation.productId]),
  );
  const exactShortcode = candidates.find(
    (candidate) =>
      candidate.matchKind === "exact" && candidate.matchField === "shortcode",
  );
  const sourceCandidates = exactShortcode ? [exactShortcode] : candidates;
  const mutableGroups = collectMutableGroups(
    sourceCandidates,
    relationByCandidate,
    !input.entityTypes?.length && !exactShortcode,
  );
  sortMutableGroups(mutableGroups, candidates);

  const selectedGroups = mutableGroups.slice(0, input.limit);
  const selectedProductIds = selectedGroups.flatMap((group) =>
    group.kind === "product" ? [group.productId] : [],
  );
  const productRefs = [
    ...new Set([
      ...selectedProductIds,
      ...selectedGroups.flatMap((group) =>
        group.kind === "entity" && group.linkedProductId
          ? [group.linkedProductId]
          : [],
      ),
    ]),
  ];
  const [productHits, placementsByProduct, componentPlacementsByProduct] =
    await Promise.all([
      hydrateSearchHitRefs(
        db,
        productRefs.map((entityId) => ({ entityType: "product", entityId })),
      ),
      loadProductPlacements(db, selectedProductIds),
      loadComponentPlacements(db, selectedProductIds),
    ]);
  const productById = new Map(
    productHits.map((hit) => [hit.entityId, destinationFromInternalHit(hit)]),
  );
  const usedCandidates = selectedGroups.flatMap((group) =>
    group.kind === "entity"
      ? [group.candidate]
      : [group.bestCandidate, ...group.activityCandidates],
  );
  const hitByCandidate = await addCandidateImages(db, usedCandidates);

  const result: SearchResultGroup[] = [];
  for (const group of selectedGroups) {
    if (group.kind === "entity") {
      const primary = hitByCandidate.get(candidateKey(group.candidate));
      if (!primary) continue;
      result.push({
        kind: "entity",
        key: group.key,
        primary,
        linkedProduct: group.linkedProductId
          ? (productById.get(group.linkedProductId) ?? null)
          : null,
      });
      continue;
    }
    const primary = productById.get(group.productId);
    const bestMatch = hitByCandidate.get(candidateKey(group.bestCandidate));
    if (!primary || !bestMatch) {
      if (bestMatch)
        result.push({
          kind: "entity",
          key: candidateKey(group.bestCandidate),
          primary: bestMatch,
          linkedProduct: null,
        });
      continue;
    }
    result.push({
      kind: "product",
      key: group.key,
      primary,
      bestMatch,
      placements: placementsByProduct.get(group.productId) ?? [],
      componentPlacements:
        componentPlacementsByProduct.get(group.productId) ?? [],
      matchedActivity: group.activityCandidates.flatMap((candidate) => {
        const hit = hitByCandidate.get(candidateKey(candidate));
        return hit ? [hit] : [];
      }),
    });
  }
  return result;
}

export async function findGroupedSearchHits(
  db: Database,
  input: SearchQueryInput,
): Promise<SearchResultGroup[]> {
  let rawLimit = input.entityTypes?.length
    ? input.limit
    : Math.min(Math.max(input.limit * 4, 32), MAX_GROUP_CANDIDATES);
  while (true) {
    const candidates = await findLexicalSearchCandidates(
      db,
      { ...input, limit: rawLimit },
      MAX_GROUP_CANDIDATES,
    );
    const groups = await composeSearchGroups(db, candidates, input);
    if (
      groups.length >= input.limit ||
      candidates.length < rawLimit ||
      rawLimit === MAX_GROUP_CANDIDATES
    )
      return groups;
    rawLimit = Math.min(rawLimit * 2, MAX_GROUP_CANDIDATES);
  }
}

export async function findRelatedSearchGroups(
  db: Database,
  input: SearchQueryInput,
) {
  const related = await findRelatedSearchCandidates(
    db,
    { ...input, limit: Math.min(Math.max(input.limit * 4, 32), 50) },
    undefined,
    50,
  );
  if (related.status === "unavailable")
    return { status: "unavailable" as const, groups: [] };
  return {
    status: "ready" as const,
    groups: await composeSearchGroups(db, related.results, input),
  };
}
