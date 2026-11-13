import { productPairSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { listProductMatchRows } from "~/server/domains/product/repo/match/product-match-candidate";
import { getProductMatchQueue } from "~/server/domains/product/repo/match/product-match-review";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import {
  keyBase,
  type SuggestionFamilyQuery,
  type SuggestionKey,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import { declareAffectedRecords } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

async function storedKeys(
  db: Database,
  query: SuggestionFamilyQuery,
): Promise<SuggestionKey[]> {
  if (query.filters.status !== "pending") return [];
  const rows = await listProductMatchRows(db, undefined, {
    reviewableOnly: true,
    actionableOnly: true,
    suggestionIds: query.suggestionIds,
  });
  return rows.map((row) => ({
    family: "product_pair",
    suggestionId: row.id,
    status: "pending",
    fingerprint: row.fingerprint,
    clean: false,
    strength: row.conflict ? "weak" : "medium",
    impact: [],
    createdAt: new Date(row.createdAt),
    columns: { entityKind: "product" },
    matchedRules: [],
    automaticRule: null,
  }));
}

export const product_pairFamily: SuggestionFamilyDeclaration<"product_pair"> = {
  family: "product_pair",
  applicationKind: "product_merge",
  applicationError:
    "Product merge application requires a Product pair Suggestion",
  suppressionKey: (subject) => ({
    scope: "product_pair",
    candidateKey: `${subject.recordId}|${subject.otherId}`,
    error: "Suppression differs from the canonical Product pair",
  }),
  keys: storedKeys,
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const candidates = await getProductMatchQueue(db, {
      suggestionIds: keys.map((key) => key.suggestionId),
    });
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    return new Map(
      candidates.items.flatMap((candidate) => {
        const key = byId.get(candidate.suggestionId);
        if (!key || !candidate.actionable) return [];
        const record = { entity: "product", id: candidate.keeper.id };
        const other = { entity: "product", id: candidate.other.id };
        const canMerge =
          !candidate.identityConflict && candidate.fingerprint !== null;
        return [
          [
            key.suggestionId,
            productPairSuggestionRow.parse({
              ...keyBase(key),
              fingerprint: candidate.fingerprint,
              family: "product_pair",
              record,
              other,
              summary: [
                { kind: "text", text: "Merge possible duplicate" },
                { kind: "record", ref: other },
              ],
              actions: [
                ...(canMerge ? ["review_merge" as const] : []),
                "reject" as const,
                "dismiss" as const,
                "never_suggest" as const,
              ].map((verb) => ({ verb, ownerOnly: false })),
              review: {
                application: {
                  kind: "product_merge",
                  keepId: candidate.keeper.id,
                  mergeId: candidate.other.id,
                },
                suppression: candidate.review?.suppression,
                merge: {
                  entity: "product",
                  rows: [candidate.keeper, candidate.other],
                },
              },
              evidence: {
                kind: "declared",
                description:
                  candidate.evidence ??
                  "Review whether these Products identify the same item.",
                facts: [
                  ...candidate.conflictReasons.map((value) => ({
                    label: "Identity conflict",
                    value,
                  })),
                  ...candidate.warnings.map((value) => ({
                    label: "Caution",
                    value,
                  })),
                  { label: "Variant evidence", value: candidate.variant },
                  { label: "Sources", value: candidate.sourceUrls },
                ],
              },
            }),
          ] as const,
        ];
      }),
    );
  },
  outcomes: async () => ({
    applied: 0,
    rejected: 0,
    superseded: 0,
    resolved: 0,
    fields: [],
  }),
  acceptAsIs: () => null,
  ...suggestionReviewFamilies.product_pair,
  ...declareAffectedRecords({
    roles: ["subject", "other"],
    forward: () => sql`'[]'::jsonb`,
    references: [],
  }),
  actionable: sql`false`,
};
