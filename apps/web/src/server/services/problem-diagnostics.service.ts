/**
 * Derived Problem execution adapters.
 *
 * The Problem registry deliberately names a diagnostic instead of carrying a
 * callback.  This module is the other half of that seam: it maps every
 * DiagnosticKey to the focused repo/service implementation which owns its
 * SQL, graph traversal, or provider call.  In particular, adapters receive
 * an explicit sample or count intent. SQL-heavy adapters may share their
 * canonical relation internally, but count callers never invoke sample.
 */

import type {
  ProductWithTitleDerivableSize,
  UpcEnrichmentFreshness,
} from "@cubby/schemas/problems";
import type { ProjectAttentionItem } from "@cubby/schemas/project";

import type { DiagnosticKey } from "~/entities/problem-query";
import { env } from "~/env";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { proposeSizeFromTitle } from "~/lib/title-unit-size";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import {
  countDependencyCycles,
  countEntitiesMissingEmbeddings,
  countReferentialLivenessViolations,
  findDependencyCycles,
  findDuplicateFinancialAccountSourceAliases,
  findDuplicateFinancialTransactionSourceRefs,
  findDuplicateProductIdentities,
  findDuplicateSpendCandidates,
  findDuplicateVendors,
  findEntitiesMissingEmbeddingsPage,
  findIncompleteStatementImports,
  findInvalidFinancialJson,
  findManufacturerSpellingVariants,
  findOpenImportFindings,
  findOrphanedProducts,
  findParentRecipesWithDeletedSubRecipes,
  findPartiallyImportedCookbooks,
  findProductsWithoutUnitMappings,
  findWeightSoldProducts,
  findProductsWithUpcGaps,
  findReferentialLivenessViolations,
  findToolsUsedOutsideOwnership,
} from "~/server/repo/problems";
import { computeAttentionItems } from "~/server/repo/project";
import { readCachedUpcLookups } from "~/server/repo/upc-lookup-cache";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";

type DiagnosticStatus =
  | { state: "healthy" }
  | { state: "stale"; message: string }
  | { state: "unavailable"; message: string };

type DiagnosticMetadata = {
  status: DiagnosticStatus;
  /** Present only for external adapters with a durable freshness contract. */
  freshness?: UpcEnrichmentFreshness;
};

export type DiagnosticSampleResult = DiagnosticMetadata & {
  items: readonly unknown[];
  count: number;
};

export type DiagnosticCountResult = DiagnosticMetadata & { count: number };
export type DiagnosticResult = DiagnosticSampleResult | DiagnosticCountResult;

export type UpcLookupBatchPort = Pick<UPCLookupClient, "lookupBatch">;

export type DiagnosticRunOptions = {
  upcLookupClient?: UpcLookupBatchPort;
  /** Reuse the tracker lane's complete attention relation; never a page. */
  attentionItems?: readonly ProjectAttentionItem[];
};

type DiagnosticAdapter = {
  sample: (
    db: Database,
    options: DiagnosticRunOptions,
    limit: number,
  ) => Promise<DiagnosticSampleResult>;
  count: (
    db: Database,
    options: DiagnosticRunOptions,
  ) => Promise<DiagnosticCountResult>;
};

const healthySample = async (
  rows: Promise<readonly unknown[]> | readonly unknown[],
  limit: number,
): Promise<DiagnosticSampleResult> => {
  const items = await rows;
  return {
    items: items.slice(0, limit),
    count: items.length,
    status: { state: "healthy" },
  };
};

/**
 * Products whose own title states a pack size they have no conversion for.
 *
 * The repo hands back a DB-narrowed shortlist and this applies the real test —
 * same split as the UPC adapter below, where the repo finds gappy products and
 * the service builds the proposal. `proposeSizeFromTitle` refuses anything
 * carrying a pack count, because those read 6-12x too small and always in the
 * cheaper-looking direction.
 */
const runTitleSizeProposals = async (
  db: Database,
): Promise<ProductWithTitleDerivableSize[]> => {
  const candidates = await findProductsWithoutUnitMappings(db);
  const proposals: ProductWithTitleDerivableSize[] = [];
  for (const row of candidates) {
    const proposal = proposeSizeFromTitle(row.name);
    if (!proposal) continue;
    proposals.push({
      id: row.shortcode,
      name: row.name,
      manufacturer: row.manufacturer,
      category: row.category?.path.map((node) => node.name).join(" > ") ?? null,
      proposed: proposal.amount,
      token: proposal.token,
    });
  }
  return proposals;
};

const healthyCount = (count: number): DiagnosticCountResult => ({
  count,
  status: { state: "healthy" },
});

function runUpcProposals(
  db: Database,
  options: DiagnosticRunOptions,
  mode: "sample",
  limit?: number,
): Promise<DiagnosticSampleResult>;
function runUpcProposals(
  db: Database,
  options: DiagnosticRunOptions,
  mode: "count",
  limit?: number,
): Promise<DiagnosticCountResult>;
async function runUpcProposals(
  db: Database,
  options: DiagnosticRunOptions,
  mode: "sample" | "count",
  limit = Number.POSITIVE_INFINITY,
): Promise<DiagnosticSampleResult | DiagnosticCountResult> {
  const candidates = await findProductsWithUpcGaps(db);
  const { lookups, freshness } = await readCachedUpcLookups(
    db,
    candidates.map((candidate) => candidate.upc),
    (upcs) =>
      options.upcLookupClient
        ? options.upcLookupClient.lookupBatch(upcs)
        : Promise.reject(new Error("UPC enrichment client is unavailable.")),
  );
  const items: unknown[] = [];
  let count = 0;
  for (const candidate of candidates) {
    const lookup = lookups.get(candidate.upc);
    if (!lookup) continue;
    const proposed = {
      manufacturer:
        isUnspecifiedManufacturer(candidate.manufacturer) &&
        !isUnspecifiedManufacturer(lookup.manufacturer ?? lookup.brand)
          ? (lookup.manufacturer ?? lookup.brand)
          : null,
      price:
        candidate.effectivePrice == null && lookup.priceDollars != null
          ? lookup.priceDollars
          : null,
      imageUrl:
        !candidate.hasImage && lookup.imageUrl
          ? new URL(lookup.imageUrl, env.UPC_LOOKUP_API_URL).toString()
          : null,
    };
    if (
      proposed.manufacturer == null &&
      proposed.price == null &&
      proposed.imageUrl == null
    ) {
      continue;
    }
    count += 1;
    if (mode === "sample" && items.length < limit) {
      items.push({
        id: candidate.shortcode,
        name: candidate.name,
        manufacturer: candidate.manufacturer,
        upc: candidate.upc,
        proposed,
      });
    }
  }
  const status: DiagnosticStatus =
    freshness.status === "fresh"
      ? { state: "healthy" }
      : freshness.status === "stale"
        ? {
            state: "stale",
            message: "UPC proposals include cached stale results.",
          }
        : {
            state: "unavailable",
            message: "UPC provider results are currently unavailable.",
          };
  return mode === "sample"
    ? { items, count, status, freshness }
    : { count, status, freshness };
}

/** Exhaustive adapter registry: a new DiagnosticKey cannot be silently raw. */
export const diagnosticAdapters = {
  "import-findings": {
    sample: (db, _options, limit) =>
      healthySample(findOpenImportFindings(db), limit),
    count: async (db) =>
      healthyCount((await findOpenImportFindings(db)).length),
  },
  "duplicate-product-identities": {
    sample: (db, _options, limit) =>
      healthySample(findDuplicateProductIdentities(db), limit),
    count: async (db) =>
      healthyCount((await findDuplicateProductIdentities(db)).length),
  },
  "orphaned-products": {
    sample: (db, _options, limit) =>
      healthySample(findOrphanedProducts(db), limit),
    count: async (db) => healthyCount((await findOrphanedProducts(db)).length),
  },
  "partially-imported-cookbooks": {
    sample: (db, _options, limit) =>
      healthySample(findPartiallyImportedCookbooks(db), limit),
    count: async (db) =>
      healthyCount((await findPartiallyImportedCookbooks(db)).length),
  },
  "tools-used-outside-ownership": {
    sample: (db, _options, limit) =>
      healthySample(findToolsUsedOutsideOwnership(db), limit),
    count: async (db) =>
      healthyCount((await findToolsUsedOutsideOwnership(db)).length),
  },
  "entities-missing-embeddings": {
    sample: async (db, _options, limit) => {
      if (!semanticEmbeddingsConfigured()) {
        return {
          items: [],
          count: 0,
          status: {
            state: "unavailable" as const,
            message:
              "Semantic embeddings are not configured for this household.",
          },
        };
      }
      const config = getSemanticEmbeddingConfig();
      const { items, count } = await findEntitiesMissingEmbeddingsPage(
        db,
        config,
        { limit },
      );
      return { items, count, status: { state: "healthy" } };
    },
    count: async (db) => {
      if (!semanticEmbeddingsConfigured()) {
        return {
          count: 0,
          status: {
            state: "unavailable" as const,
            message:
              "Semantic embeddings are not configured for this household.",
          },
        };
      }
      return healthyCount(
        await countEntitiesMissingEmbeddings(db, getSemanticEmbeddingConfig()),
      );
    },
  },
  "stale-parent-recipes": {
    sample: (db, _options, limit) =>
      healthySample(findParentRecipesWithDeletedSubRecipes(db), limit),
    count: async (db) =>
      healthyCount((await findParentRecipesWithDeletedSubRecipes(db)).length),
  },
  "weight-sold-products": {
    sample: (db, _options, limit) =>
      healthySample(findWeightSoldProducts(db), limit),
    count: async (db) =>
      healthyCount((await findWeightSoldProducts(db)).length),
  },
  "manufacturer-spelling-variants": {
    sample: (db, _options, limit) =>
      healthySample(findManufacturerSpellingVariants(db), limit),
    count: async (db) =>
      healthyCount((await findManufacturerSpellingVariants(db)).length),
  },
  "duplicate-vendors": {
    sample: (db, _options, limit) =>
      healthySample(findDuplicateVendors(db), limit),
    count: async (db) => healthyCount((await findDuplicateVendors(db)).length),
  },
  "referential-liveness-violations": {
    sample: (db, _options, limit) =>
      healthySample(findReferentialLivenessViolations(db), limit),
    count: async (db) =>
      healthyCount(await countReferentialLivenessViolations(db)),
  },
  "dependency-cycles": {
    sample: (db, _options, limit) =>
      healthySample(findDependencyCycles(db), limit),
    count: async (db) => healthyCount(await countDependencyCycles(db)),
  },
  "products-with-better-upc-data": {
    sample: (db, options, limit) =>
      runUpcProposals(db, options, "sample", limit),
    count: (db, options) => runUpcProposals(db, options, "count"),
  },
  "title-derivable-unit-size": {
    sample: (db, _options, limit) =>
      healthySample(runTitleSizeProposals(db), limit),
    count: async (db) => healthyCount((await runTitleSizeProposals(db)).length),
  },
  "duplicate-spend-candidates": {
    sample: (db, _options, limit) =>
      healthySample(findDuplicateSpendCandidates(db), limit),
    count: async (db) =>
      healthyCount((await findDuplicateSpendCandidates(db)).length),
  },
  "duplicate-financial-transaction-source-refs": {
    sample: (db, _options, limit) =>
      healthySample(findDuplicateFinancialTransactionSourceRefs(db), limit),
    count: async (db) =>
      healthyCount(
        (await findDuplicateFinancialTransactionSourceRefs(db)).length,
      ),
  },
  "duplicate-financial-account-source-aliases": {
    sample: (db, _options, limit) =>
      healthySample(findDuplicateFinancialAccountSourceAliases(db), limit),
    count: async (db) =>
      healthyCount(
        (await findDuplicateFinancialAccountSourceAliases(db)).length,
      ),
  },
  "invalid-financial-json": {
    sample: (db, _options, limit) =>
      healthySample(findInvalidFinancialJson(db), limit),
    count: async (db) =>
      healthyCount((await findInvalidFinancialJson(db)).length),
  },
  "incomplete-statement-imports": {
    sample: (db, _options, limit) =>
      healthySample(findIncompleteStatementImports(db), limit),
    count: async (db) =>
      healthyCount((await findIncompleteStatementImports(db)).length),
  },
  "project-date-window-drift": {
    sample: async (db, options, limit) =>
      healthySample(
        (options.attentionItems ?? (await computeAttentionItems(db))).filter(
          (item) => item.type === "date_window_drift",
        ),
        limit,
      ),
    count: async (db, options) =>
      healthyCount(
        (options.attentionItems ?? (await computeAttentionItems(db))).reduce(
          (count, item) => count + Number(item.type === "date_window_drift"),
          0,
        ),
      ),
  },
} as const satisfies Record<DiagnosticKey, DiagnosticAdapter>;

export function runDiagnostic(
  db: Database,
  key: DiagnosticKey,
  options?: DiagnosticRunOptions,
  intent?: { kind: "sample"; limit: number },
): Promise<DiagnosticSampleResult>;
export function runDiagnostic(
  db: Database,
  key: DiagnosticKey,
  options: DiagnosticRunOptions,
  intent: { kind: "count" },
): Promise<DiagnosticCountResult>;
export async function runDiagnostic(
  db: Database,
  key: DiagnosticKey,
  options: DiagnosticRunOptions = {},
  intent: { kind: "sample"; limit: number } | { kind: "count" } = {
    kind: "sample",
    limit: 12,
  },
): Promise<DiagnosticResult> {
  return intent.kind === "count"
    ? diagnosticAdapters[key].count(db, options)
    : diagnosticAdapters[key].sample(db, options, intent.limit);
}
