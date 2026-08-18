/**
 * Derived Problem execution adapters.
 *
 * The Problem registry deliberately names a diagnostic instead of carrying a
 * callback.  This module is the other half of that seam: it maps every
 * DiagnosticKey to the focused repo/service implementation which owns its
 * SQL, graph traversal, or provider call.  In particular, adapters receive
 * the complete relation and return it before a caller applies a card sample.
 */

import type { ProjectAttentionItem } from "@cubby/schemas/project";
import type { DiagnosticKey } from "~/entities/problem-query";
import { env } from "~/env";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import {
  countEntitiesMissingEmbeddings,
  findDuplicateFinancialAccountSourceAliases,
  findDuplicateFinancialTransactionSourceRefs,
  findDuplicateProductIdentities,
  findDuplicateSpendCandidates,
  findDuplicateVendors,
  findEntitiesMissingEmbeddings,
  findIncompleteStatementImports,
  findInvalidFinancialJson,
  findManufacturerSpellingVariants,
  findOrphanedProducts,
  findParentRecipesWithDeletedSubRecipes,
  findProductsWithUpcGaps,
  findReferentialLivenessViolations,
  findToolsUsedOutsideOwnership,
} from "~/server/repo/problems";
import { computeAttentionItems } from "~/server/repo/project";
import {
  readCachedUpcLookups,
  type UpcEnrichmentFreshness,
} from "~/server/repo/upc-lookup-cache";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";

export type DiagnosticStatus =
  | { state: "healthy" }
  | { state: "stale"; message: string }
  | { state: "unavailable"; message: string };

export type DiagnosticResult = {
  /** Complete, ordered relation. Callers may sample only after this boundary. */
  items: readonly unknown[];
  count: number;
  status: DiagnosticStatus;
  /** Present only for external adapters with a durable freshness contract. */
  freshness?: UpcEnrichmentFreshness;
};

export type DiagnosticRunOptions = {
  upcLookupClient?: UPCLookupClient;
  /** Reuse the tracker lane's complete attention relation; never a page. */
  attentionItems?: readonly ProjectAttentionItem[];
};

type DiagnosticAdapter = {
  run: (
    db: Database,
    options: DiagnosticRunOptions,
  ) => Promise<DiagnosticResult>;
};

const healthy = async (
  rows: Promise<readonly unknown[]> | readonly unknown[],
): Promise<DiagnosticResult> => {
  const items = await rows;
  return { items, count: items.length, status: { state: "healthy" } };
};

const runUpcProposals = async (
  db: Database,
  options: DiagnosticRunOptions,
): Promise<DiagnosticResult> => {
  const candidates = await findProductsWithUpcGaps(db);
  const { lookups, freshness } = await readCachedUpcLookups(
    db,
    candidates.map((candidate) => candidate.upc),
    (upcs) =>
      options.upcLookupClient
        ? options.upcLookupClient.lookupBatch(upcs)
        : Promise.reject(new Error("UPC enrichment client is unavailable.")),
  );
  const items = candidates.flatMap((candidate) => {
    const lookup = lookups.get(candidate.upc);
    if (!lookup) return [];
    const proposed = {
      manufacturer:
        isUnspecifiedManufacturer(candidate.manufacturer) &&
        !isUnspecifiedManufacturer(lookup.manufacturer ?? lookup.brand)
          ? (lookup.manufacturer ?? lookup.brand)
          : null,
      price:
        candidate.price == null && lookup.priceDollars != null
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
      return [];
    }
    return [
      {
        id: candidate.shortcode,
        name: candidate.name,
        manufacturer: candidate.manufacturer,
        upc: candidate.upc,
        proposed,
      },
    ];
  });
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
  return { items, count: items.length, status, freshness };
};

/** Exhaustive adapter registry: a new DiagnosticKey cannot be silently raw. */
export const diagnosticAdapters = {
  "duplicate-product-identities": {
    run: (db) => healthy(findDuplicateProductIdentities(db)),
  },
  "orphaned-products": { run: (db) => healthy(findOrphanedProducts(db)) },
  "tools-used-outside-ownership": {
    run: (db) => healthy(findToolsUsedOutsideOwnership(db)),
  },
  "orphaned-entity-embeddings": {
    run: (db) => healthy(findOrphanedEntityEmbeddings(db)),
  },
  "entities-missing-embeddings": {
    run: async (db) => {
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
      // The repo returns a capped union sample. Its companion count runs over
      // the complete relation, before this adapter's card/page sample.
      const [items, count] = await Promise.all([
        findEntitiesMissingEmbeddings(db, config),
        countEntitiesMissingEmbeddings(db, config),
      ]);
      return { items, count, status: { state: "healthy" } };
    },
  },
  "stale-parent-recipes": {
    run: (db) => healthy(findParentRecipesWithDeletedSubRecipes(db)),
  },
  "manufacturer-spelling-variants": {
    run: (db) => healthy(findManufacturerSpellingVariants(db)),
  },
  "duplicate-vendors": { run: (db) => healthy(findDuplicateVendors(db)) },
  "referential-liveness-violations": {
    run: (db) => healthy(findReferentialLivenessViolations(db)),
  },
  "products-with-better-upc-data": { run: runUpcProposals },
  "duplicate-spend-candidates": {
    run: (db) => healthy(findDuplicateSpendCandidates(db)),
  },
  "duplicate-financial-transaction-source-refs": {
    run: (db) => healthy(findDuplicateFinancialTransactionSourceRefs(db)),
  },
  "duplicate-financial-account-source-aliases": {
    run: (db) => healthy(findDuplicateFinancialAccountSourceAliases(db)),
  },
  "invalid-financial-json": {
    run: (db) => healthy(findInvalidFinancialJson(db)),
  },
  "incomplete-statement-imports": {
    run: (db) => healthy(findIncompleteStatementImports(db)),
  },
  "project-date-window-drift": {
    run: async (db, options) =>
      healthy(
        (options.attentionItems ?? (await computeAttentionItems(db))).filter(
          (item) => item.type === "date_window_drift",
        ),
      ),
  },
} as const satisfies Record<DiagnosticKey, DiagnosticAdapter>;

export const runDiagnostic = (
  db: Database,
  key: DiagnosticKey,
  options: DiagnosticRunOptions = {},
): Promise<DiagnosticResult> => diagnosticAdapters[key].run(db, options);
