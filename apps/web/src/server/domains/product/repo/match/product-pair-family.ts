import { suggestionStatus } from "@cubby/schemas/ai";
import { productId } from "@cubby/schemas/identifiers";
import {
  suggestionFamily,
  suggestionJudgments,
} from "@cubby/schemas/suggestion";
import { productPairSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { product } from "~/server/db/schema";
import {
  currentProductPairPolicySql,
  productPairApplicationKey,
  productPairApplicationTerms,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { getProductMatchQueue } from "~/server/domains/product/repo/match/product-match-review";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { outcomes } from "~/server/generic/suggestions/repo/suggestion-outcomes";
import {
  keyBase,
  suggestionIdScope,
  type SuggestionFamilyQuery,
  type SuggestionKey,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  entities,
  ref,
  one,
  declareAffectedRecords,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";

const actionable = sql`s.judgment->'actionable' = 'true'::jsonb`;

async function storedKeys(
  db: Database,
  query: SuggestionFamilyQuery,
): Promise<SuggestionKey[]> {
  if (query.filters.status !== "pending") return [];
  const rows = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    createdAt: Date | string;
    conflict: boolean;
  }>(
    sql`
    SELECT s.id, s.fingerprint, s."createdAt", COALESCE((s.judgment->>${suggestionJudgments.product_pair.keyof().enum.conflict})::boolean, false) AS conflict
    FROM "Suggestion" s
    WHERE s.family = ${suggestionFamily.enum.product_pair} AND s.active AND s.status = ${suggestionStatus.enum.pending} AND s.suppression IS NULL AND ${actionable}
      AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
      ${query.filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${query.filters.runId})` : sql``}
      AND ${currentProductPairPolicySql(sql`s.producer`)} AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id = s."recordId" AND ${notDeleted("p")})
      AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id::text = s.data->>'otherId' AND ${notDeleted("p")})`,
    "objects",
  );
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
  outcomes: outcomes("product_pair"),
  acceptAsIs: () => null,
  ...suggestionReviewFamilies.product_pair,
  ...declareAffectedRecords({
    roles: ["subject", "other"],
    forward: () =>
      sql`${one} || jsonb_build_array(${ref(sql`${entities.product}`, sql`s.data->>'otherId'`)})`,
    references: [
      { kind: "primary" },
      {
        kind: "value",
        at: { column: "data", path: ["otherId"] },
        entity: entities.product,
      },
    ],
  }),
  actionable,
  transactionBound: false,
  // Lock both Products before the engine compares their identity terms.
  lockForApply: async (db, prediction) => {
    const subject = z
      .object({ recordId: productId, otherId: productId })
      .parse(prediction.subject);
    await getDb(db)
      .select({ id: product.id })
      .from(product)
      .where(inArray(product.id, [subject.recordId, subject.otherId]))
      .orderBy(product.id)
      .for("update");
  },
  applicationKey: productPairApplicationKey,
  applicationTerms: productPairApplicationTerms,
  apply: async (db, context, state, input) => {
    if (input.verdict !== "correct" || input.correction.present)
      throw new Error("Product merging requires an accepted pair");
    if (input.application?.kind !== "product_merge")
      throw new Error("Product merging requires a survivor");
    const { mergeReviewedProductPair } =
      await import("~/server/generic/suggestions/repo/suggestion-product");
    await mergeReviewedProductPair(
      { ...context, db },
      {
        keepId: input.application.keepId,
        mergeId: input.application.mergeId,
        suggestionId: state.id,
      },
    );
  },
};
