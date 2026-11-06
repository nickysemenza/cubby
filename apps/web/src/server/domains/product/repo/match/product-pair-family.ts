import {
  suggestionSubjects,
  suggestionProjectionTargets,
} from "@cubby/schemas/suggestion";
import { productPairSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import { getProductMatchQueue } from "~/server/domains/product/repo/match/product-match-review";
import {
  actions,
  outcomes,
  storedKeys,
} from "~/server/generic/suggestions/repo/stored-suggestion-presentation";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { keyBase } from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  entities,
  ref,
  one,
  relatedRecordMatch,
  declareAffectedRecords,
  primaryRecordMatch,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";

export const product_pairFamily: SuggestionFamilyDeclaration<"product_pair"> = {
  family: "product_pair",
  keys: (db, query) => storedKeys(db, query, "product_pair"),
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
              actions: actions(
                ...(canMerge ? ["review_merge" as const] : []),
                "reject",
                "dismiss",
                "never_suggest",
              ),
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
    reverse: (scope) => [
      primaryRecordMatch(scope),
      relatedRecordMatch(
        scope,
        entities.product,
        sql<string>`s.data->>'otherId'`,
      ),
    ],
  }),
  actionable: sql`s.judgment->'actionable' = 'true'::jsonb`,
  subject: suggestionSubjects.product_pair,
  target: suggestionProjectionTargets.product_pair,
  transactionBound: false,
  currentFingerprint: async (db, state) => {
    const { reviewedProductPairFingerprint } =
      await import("~/server/domains/product/repo/match/product-match-candidate");
    return reviewedProductPairFingerprint(db, state);
  },
  actions: ["correct", "wrong", "uncertain", "dismissed"],
  apply: async (db, context, state, input) => {
    if (input.verdict !== "correct" || input.correction.present)
      throw new Error("Product merging requires an accepted pair");
    if (
      input.application?.kind !== "product_merge" ||
      !input.expectedFingerprint
    )
      throw new Error(
        "Product merging requires a survivor and the current pair fingerprint",
      );
    const { mergeProductMatch } =
      await import("~/server/domains/product/repo/match/product-match-review");
    await mergeProductMatch(
      { ...context, db },
      {
        keepId: input.application.keepId,
        mergeId: input.application.mergeId,
        suggestionId: state.id,
        expectedFingerprint: input.expectedFingerprint,
      },
    );
  },
};
