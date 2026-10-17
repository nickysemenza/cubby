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

import { UpcEnrichmentFreshness, ProblemItem } from "@cubby/schemas/problems";
import type { ProjectAttentionItem } from "@cubby/schemas/project";

import type { DiagnosticKey } from "~/entity/problems/problem-query";
import { completeProblemQueryDeclarations } from "~/entity/problems/problem-registry-validation";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { UpcLookupService } from "~/server/clients/upc";
import type { Database } from "~/server/db";
import type { loadProjectDateWindows } from "~/server/domains/project/repo/subtree";

// Selecting a diagnostic must not initialize every other detector or provider.
const loadUpcCache = () =>
  import("~/server/domains/product/repo/upc-lookup-cache");
const loadAttention = () => import("~/server/domains/project/repo/attention");
const loadEmbeddingConfig = () =>
  import("~/server/generic/embedding/service/semantic/config");
const loadEmbeddings = () =>
  import("~/server/generic/embedding/service/semantic/embeddings");
const loadEntityEdges = () =>
  import("~/server/generic/entity-links/repo/entity-edge-source");
const loadCookbookDetectors = () =>
  import("~/server/generic/problems/repo/detectors-cookbook");
const loadEmbeddingDetectors = () =>
  import("~/server/generic/problems/repo/detectors-embedding");
const loadFinancialDetectors = () =>
  import("~/server/generic/problems/repo/detectors-financial");
const loadImportDetectors = () =>
  import("~/server/generic/problems/repo/detectors-import");
const loadIntegrityDetectors = () =>
  import("~/server/generic/problems/repo/detectors-integrity");
const loadLabelDetectors = () =>
  import("~/server/generic/problems/repo/detectors-label-variants");
const loadProductDetectors = () =>
  import("~/server/generic/problems/repo/detectors-product");
const loadPurchaseDetectors = () =>
  import("~/server/generic/problems/repo/detectors-purchase");
const loadRecipeDetectors = () =>
  import("~/server/generic/problems/repo/detectors-recipe");
const loadTitleSize = () => import("~/server/lib/title-unit-size");

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

export type UpcLookupBatchPort = Pick<UpcLookupService, "lookupBatch">;

export type DiagnosticRunOptions = {
  upcLookupClient?: UpcLookupBatchPort;
  /** Reuse the tracker lane's complete attention relation; never a page. */
  attentionItems?: readonly ProjectAttentionItem[];
  /** Complete request-local tree dates shared with Project attention. */
  projectDateWindows?:
    | Awaited<ReturnType<typeof loadProjectDateWindows>>
    | ReturnType<typeof loadProjectDateWindows>;
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
): Promise<ProblemItem<"productsWithTitleDerivableSize">[]> => {
  const { proposeSizeFromTitle } = await loadTitleSize();
  const candidates = await (
    await loadProductDetectors()
  ).findProductsWithoutUnitMappings(db);
  const proposals: ProblemItem<"productsWithTitleDerivableSize">[] = [];
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
  const candidates = await (
    await loadProductDetectors()
  ).findProductsWithUpcGaps(db);
  const { lookups, freshness } = await (
    await loadUpcCache()
  ).readCachedUpcLookups(
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
      imageUrl: !candidate.hasImage && lookup.imageUrl ? lookup.imageUrl : null,
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
    sample: async (db, _options, limit) => {
      const page = await (
        await loadImportDetectors()
      ).findOpenRunFindingsPage(db, limit);
      return { items: page.items, ...healthyCount(page.count) };
    },
    count: async (db) =>
      healthyCount(
        await (await loadImportDetectors()).countOpenRunFindings(db),
      ),
  },
  "duplicate-product-identities": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadProductDetectors()).findDuplicateProductIdentities(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadProductDetectors()
          ).findDuplicateProductIdentities(db)
        ).length,
      ),
  },
  "orphaned-products": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadProductDetectors()).findOrphanedProducts(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (await (await loadProductDetectors()).findOrphanedProducts(db)).length,
      ),
  },
  "unconnected-entities": {
    sample: async (db, _options, limit) => {
      const { items, count } = await (
        await loadEntityEdges()
      ).findOrphanEntities(db, { limit });
      return { items, count, status: { state: "healthy" } };
    },
    // `findOrphanEntities` reports the true total via a window function
    // computed before its LIMIT is applied, so one row is enough to read it —
    // LIMIT 0 would return no rows at all, and with them the total.
    count: async (db) =>
      healthyCount(
        (await (await loadEntityEdges()).findOrphanEntities(db, { limit: 1 }))
          .count,
      ),
  },
  "partially-imported-cookbooks": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadCookbookDetectors()).findPartiallyImportedCookbooks(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadCookbookDetectors()
          ).findPartiallyImportedCookbooks(db)
        ).length,
      ),
  },
  "tools-used-outside-ownership": {
    sample: async (db, options, limit) =>
      healthySample(
        (await loadProductDetectors()).findToolsUsedOutsideOwnership(
          db,
          options,
        ),
        limit,
      ),
    count: async (db, options) =>
      healthyCount(
        (
          await (
            await loadProductDetectors()
          ).findToolsUsedOutsideOwnership(db, options)
        ).length,
      ),
  },
  "entities-missing-embeddings": {
    sample: async (db, _options, limit) => {
      if (!(await loadEmbeddings()).semanticEmbeddingsConfigured()) {
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
      const config = (await loadEmbeddingConfig()).getSemanticEmbeddingConfig();
      const { items, count } = await (
        await loadEmbeddingDetectors()
      ).findEntitiesMissingEmbeddingsPage(db, config, { limit });
      return { items, count, status: { state: "healthy" } };
    },
    count: async (db) => {
      if (!(await loadEmbeddings()).semanticEmbeddingsConfigured()) {
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
        await (
          await loadEmbeddingDetectors()
        ).countEntitiesMissingEmbeddings(
          db,
          (await loadEmbeddingConfig()).getSemanticEmbeddingConfig(),
        ),
      );
    },
  },
  "stale-parent-recipes": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadRecipeDetectors()).findParentRecipesWithDeletedSubRecipes(
          db,
        ),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadRecipeDetectors()
          ).findParentRecipesWithDeletedSubRecipes(db)
        ).length,
      ),
  },
  "weight-sold-products": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadProductDetectors()).findWeightSoldProducts(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (await (await loadProductDetectors()).findWeightSoldProducts(db))
          .length,
      ),
  },
  "manufacturer-spelling-variants": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadLabelDetectors()).findManufacturerSpellingVariants(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadLabelDetectors()
          ).findManufacturerSpellingVariants(db)
        ).length,
      ),
  },
  "duplicate-vendors": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadLabelDetectors()).findDuplicateVendors(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (await (await loadLabelDetectors()).findDuplicateVendors(db)).length,
      ),
  },
  "referential-liveness-violations": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadIntegrityDetectors()).findReferentialLivenessViolations(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        await (
          await loadIntegrityDetectors()
        ).countReferentialLivenessViolations(db),
      ),
  },
  "dependency-cycles": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadIntegrityDetectors()).findDependencyCycles(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        await (await loadIntegrityDetectors()).countDependencyCycles(db),
      ),
  },
  "products-with-better-upc-data": {
    sample: async (db, options, limit) =>
      runUpcProposals(db, options, "sample", limit),
    count: async (db, options) => runUpcProposals(db, options, "count"),
  },
  "title-derivable-unit-size": {
    sample: async (db, _options, limit) =>
      healthySample(runTitleSizeProposals(db), limit),
    count: async (db) => healthyCount((await runTitleSizeProposals(db)).length),
  },
  "duplicate-spend-candidates": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadPurchaseDetectors()).findDuplicateSpendCandidates(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (await (await loadPurchaseDetectors()).findDuplicateSpendCandidates(db))
          .length,
      ),
  },
  "duplicate-financial-transaction-source-refs": {
    sample: async (db, _options, limit) =>
      healthySample(
        (
          await loadFinancialDetectors()
        ).findDuplicateFinancialTransactionSourceRefs(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadFinancialDetectors()
          ).findDuplicateFinancialTransactionSourceRefs(db)
        ).length,
      ),
  },
  "duplicate-financial-account-source-aliases": {
    sample: async (db, _options, limit) =>
      healthySample(
        (
          await loadFinancialDetectors()
        ).findDuplicateFinancialAccountSourceAliases(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadFinancialDetectors()
          ).findDuplicateFinancialAccountSourceAliases(db)
        ).length,
      ),
  },
  "provisional-financial-accounts": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadFinancialDetectors()).findProvisionalFinancialAccounts(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadFinancialDetectors()
          ).findProvisionalFinancialAccounts(db)
        ).length,
      ),
  },
  "invalid-financial-json": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadFinancialDetectors()).findInvalidFinancialJson(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (await (await loadFinancialDetectors()).findInvalidFinancialJson(db))
          .length,
      ),
  },
  "incomplete-statement-imports": {
    sample: async (db, _options, limit) =>
      healthySample(
        (await loadFinancialDetectors()).findIncompleteStatementImports(db),
        limit,
      ),
    count: async (db) =>
      healthyCount(
        (
          await (
            await loadFinancialDetectors()
          ).findIncompleteStatementImports(db)
        ).length,
      ),
  },
  "project-date-window-drift": {
    sample: async (db, options, limit) =>
      healthySample(
        (
          options.attentionItems ??
          (await (await loadAttention()).computeAttentionItems(db))
        ).filter((item) => item.type === "date_window_drift"),
        limit,
      ),
    count: async (db, options) =>
      healthyCount(
        (
          options.attentionItems ??
          (await (await loadAttention()).computeAttentionItems(db))
        ).reduce(
          (count, item) => count + Number(item.type === "date_window_drift"),
          0,
        ),
      ),
  },
} as const satisfies Record<DiagnosticKey, DiagnosticAdapter>;

/** Membership, grain, freshness and remediation policy share one registered declaration. */
export const diagnosticModules = new Map(
  completeProblemQueryDeclarations().flatMap((definition) =>
    definition.source.kind === "derived"
      ? [
          [
            definition.source.diagnostic,
            {
              definition,
              adapter: diagnosticAdapters[definition.source.diagnostic],
            },
          ] as const,
        ]
      : [],
  ),
);

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
  const module = diagnosticModules.get(key);
  if (!module)
    throw new Error(`Diagnostic ${key} has no registered module check.`);
  return intent.kind === "count"
    ? module.adapter.count(db, options)
    : module.adapter.sample(db, options, intent.limit);
}
