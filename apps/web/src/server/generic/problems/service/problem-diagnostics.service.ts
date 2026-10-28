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

import {
  UpcEnrichmentFreshness,
  ProblemItem,
} from "@cubby/schemas/problems-raw-read";
import type { ProjectAttentionReport } from "@cubby/schemas/project";

import type { DiagnosticKey } from "~/entity/problems/problem-query";
import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import { isUnknownBrandName } from "~/lib/brand-name-utils";
import type { UpcLookupService } from "~/server/clients/upc";
import type { Database } from "~/server/db";
import type { loadProjectDateWindows } from "~/server/domains/project/repo/subtree";

// Selecting a diagnostic must not initialize every other detector or provider.
const loadUpcCache = () =>
  import("~/server/domains/product/repo/upc-lookup-cache");
const loadAttention = () => import("~/server/domains/project/repo/attention");
const loadEntityEdges = () =>
  import("~/server/generic/entity-links/repo/entity-edge-source");
const loadCookbookDetectors = () =>
  import("~/server/generic/problems/repo/detectors-cookbook");
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
const loadImageRepo = () => import("~/server/domains/image/repo/image");
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
  attentionItems?: ProjectAttentionReport;
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
      brandName: row.brandName,
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
      brandName:
        isUnknownBrandName(candidate.brandName) &&
        !isUnknownBrandName(lookup.brand ?? lookup.manufacturer)
          ? (lookup.brand ?? lookup.manufacturer)
          : null,
      price:
        candidate.effectivePrice == null && lookup.priceDollars != null
          ? lookup.priceDollars
          : null,
      imageUrl: !candidate.hasImage && lookup.imageUrl ? lookup.imageUrl : null,
    };
    if (
      proposed.brandName == null &&
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
        brandName: candidate.brandName,
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
    count: async (db) => {
      const { countOpenRunFindings } = await loadImportDetectors();
      return healthyCount(await countOpenRunFindings(db));
    },
  },
  "product-identifiers-outside-issuer": {
    sample: async (db, _options, limit) => {
      const { findProductIdentifiersOutsideIssuer } =
        await loadProductDetectors();
      return healthySample(findProductIdentifiersOutsideIssuer(db), limit);
    },
    count: async (db) => {
      const { findProductIdentifiersOutsideIssuer } =
        await loadProductDetectors();
      return healthyCount(
        (await findProductIdentifiersOutsideIssuer(db)).length,
      );
    },
  },
  "duplicate-product-identities": {
    sample: async (db, _options, limit) => {
      const { findDuplicateProductIdentities } = await loadProductDetectors();
      return healthySample(findDuplicateProductIdentities(db), limit);
    },
    count: async (db) => {
      const { findDuplicateProductIdentities } = await loadProductDetectors();
      return healthyCount((await findDuplicateProductIdentities(db)).length);
    },
  },
  "orphaned-products": {
    sample: async (db, _options, limit) => {
      const { findOrphanedProducts } = await loadProductDetectors();
      return healthySample(findOrphanedProducts(db), limit);
    },
    count: async (db) => {
      const { findOrphanedProducts } = await loadProductDetectors();
      return healthyCount((await findOrphanedProducts(db)).length);
    },
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
    count: async (db) => {
      const { findOrphanEntities } = await loadEntityEdges();
      return healthyCount((await findOrphanEntities(db, { limit: 1 })).count);
    },
  },
  "partially-imported-cookbooks": {
    sample: async (db, _options, limit) => {
      const { findPartiallyImportedCookbooks } = await loadCookbookDetectors();
      return healthySample(findPartiallyImportedCookbooks(db), limit);
    },
    count: async (db) => {
      const { findPartiallyImportedCookbooks } = await loadCookbookDetectors();
      return healthyCount((await findPartiallyImportedCookbooks(db)).length);
    },
  },
  "tools-used-outside-ownership": {
    sample: async (db, options, limit) => {
      const { findToolsUsedOutsideOwnership } = await loadProductDetectors();
      return healthySample(findToolsUsedOutsideOwnership(db, options), limit);
    },
    count: async (db, options) => {
      const { findToolsUsedOutsideOwnership } = await loadProductDetectors();
      return healthyCount(
        (await findToolsUsedOutsideOwnership(db, options)).length,
      );
    },
  },
  "image-metadata-outcomes": {
    sample: async (db, _options, limit) => {
      const { listImageMetadataOutcomes } = await loadImageRepo();
      return healthySample(listImageMetadataOutcomes(db), limit);
    },
    count: async (db) => {
      const { countImageMetadataOutcomes } = await loadImageRepo();
      const counts = await countImageMetadataOutcomes(db);
      return healthyCount(counts.original_missing + counts.extraction_failed);
    },
  },
  "weight-sold-products": {
    sample: async (db, _options, limit) => {
      const { findWeightSoldProducts } = await loadProductDetectors();
      return healthySample(findWeightSoldProducts(db), limit);
    },
    count: async (db) => {
      const { findWeightSoldProducts } = await loadProductDetectors();
      return healthyCount((await findWeightSoldProducts(db)).length);
    },
  },
  "duplicate-vendors": {
    sample: async (db, _options, limit) => {
      const { findDuplicateVendors } = await loadLabelDetectors();
      return healthySample(findDuplicateVendors(db), limit);
    },
    count: async (db) => {
      const { findDuplicateVendors } = await loadLabelDetectors();
      return healthyCount((await findDuplicateVendors(db)).length);
    },
  },
  "referential-liveness-violations": {
    sample: async (db, _options, limit) => {
      const { findReferentialLivenessViolations } =
        await loadIntegrityDetectors();
      return healthySample(findReferentialLivenessViolations(db), limit);
    },
    count: async (db) => {
      const { countReferentialLivenessViolations } =
        await loadIntegrityDetectors();
      return healthyCount(await countReferentialLivenessViolations(db));
    },
  },
  "dependency-cycles": {
    sample: async (db, _options, limit) => {
      const { findDependencyCycles } = await loadIntegrityDetectors();
      return healthySample(findDependencyCycles(db), limit);
    },
    count: async (db) => {
      const { countDependencyCycles } = await loadIntegrityDetectors();
      return healthyCount(await countDependencyCycles(db));
    },
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
    sample: async (db, _options, limit) => {
      const { findDuplicateSpendCandidates } = await loadPurchaseDetectors();
      return healthySample(findDuplicateSpendCandidates(db), limit);
    },
    count: async (db) => {
      const { findDuplicateSpendCandidates } = await loadPurchaseDetectors();
      return healthyCount((await findDuplicateSpendCandidates(db)).length);
    },
  },
  "duplicate-financial-transaction-source-refs": {
    sample: async (db, _options, limit) => {
      const { findDuplicateFinancialTransactionSourceRefs } =
        await loadFinancialDetectors();
      return healthySample(
        findDuplicateFinancialTransactionSourceRefs(db),
        limit,
      );
    },
    count: async (db) => {
      const { findDuplicateFinancialTransactionSourceRefs } =
        await loadFinancialDetectors();
      return healthyCount(
        (await findDuplicateFinancialTransactionSourceRefs(db)).length,
      );
    },
  },
  "duplicate-financial-account-source-aliases": {
    sample: async (db, _options, limit) => {
      const { findDuplicateFinancialAccountSourceAliases } =
        await loadFinancialDetectors();
      return healthySample(
        findDuplicateFinancialAccountSourceAliases(db),
        limit,
      );
    },
    count: async (db) => {
      const { findDuplicateFinancialAccountSourceAliases } =
        await loadFinancialDetectors();
      return healthyCount(
        (await findDuplicateFinancialAccountSourceAliases(db)).length,
      );
    },
  },
  "invalid-financial-json": {
    sample: async (db, _options, limit) => {
      const { findInvalidFinancialJson } = await loadFinancialDetectors();
      return healthySample(findInvalidFinancialJson(db), limit);
    },
    count: async (db) => {
      const { findInvalidFinancialJson } = await loadFinancialDetectors();
      return healthyCount((await findInvalidFinancialJson(db)).length);
    },
  },
  "incomplete-transaction-imports": {
    sample: async (db, _options, limit) => {
      const { findIncompleteTransactionImports } =
        await loadFinancialDetectors();
      return healthySample(findIncompleteTransactionImports(db), limit);
    },
    count: async (db) => {
      const { findIncompleteTransactionImports } =
        await loadFinancialDetectors();
      return healthyCount((await findIncompleteTransactionImports(db)).length);
    },
  },
  "project-date-window-drift": {
    sample: async (db, options, limit) => {
      const report =
        options.attentionItems ??
        (await (await loadAttention()).computeAttentionItems(db));
      const items = report.items.filter(
        (item) => item.type === "date_window_drift",
      );
      return {
        items: items.slice(0, limit),
        count: items.length,
        status:
          report.incompleteProjectIds.length > 0
            ? {
                state: "stale" as const,
                message: `Attention inputs are unavailable for ${report.incompleteProjectIds.length} projects; this count includes known findings only.`,
              }
            : { state: "healthy" as const },
      };
    },
    count: async (db, options) => {
      const report =
        options.attentionItems ??
        (await (await loadAttention()).computeAttentionItems(db));
      return {
        count: report.items.filter((item) => item.type === "date_window_drift")
          .length,
        status:
          report.incompleteProjectIds.length > 0
            ? {
                state: "stale" as const,
                message: `Attention inputs are unavailable for ${report.incompleteProjectIds.length} projects; this count includes known findings only.`,
              }
            : { state: "healthy" as const },
      };
    },
  },
} as const satisfies Record<DiagnosticKey, DiagnosticAdapter>;

/** Membership, grain, freshness and remediation policy share one registered declaration. */
export const diagnosticModules = new Map(
  problemQueryDeclarations().flatMap((definition) =>
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
