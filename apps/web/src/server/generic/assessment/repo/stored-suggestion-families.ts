import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentJudgments } from "@cubby/schemas/assessment";
import {
  imageDescriptionSuggestionRow,
  productPairSuggestionRow,
} from "@cubby/schemas/suggestion-list";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { currentProductPairPolicySql } from "~/server/domains/product/repo/match/product-match-candidate";
import { getProductMatchQueue } from "~/server/domains/product/repo/match/product-match-review";
import { readCorrectionOutcomes } from "~/server/generic/assessment/repo/correction-outcomes";

import {
  pendingImageDescriptionEligibility,
  readAssessmentRecordRefs,
  reviewFamilyDeclarations,
} from "./review-families";
import {
  assessmentIdScope,
  keyBase,
  type SuggestionFamilyPresentation,
  type SuggestionFamilyQuery,
  type SuggestionKey,
} from "./suggestion-families";

const actions = (
  ...verbs: (
    | "accept"
    | "correct"
    | "reject"
    | "dismiss"
    | "never_suggest"
    | "review_merge"
  )[]
) => verbs.map((verb) => ({ verb, ownerOnly: false }));
const outcomes =
  (
    family: "product_pair" | "image_description",
  ): SuggestionFamilyPresentation<typeof family>["outcomes"] =>
  async (db, filters) => {
    const { rows } = await unwrapDb(db).execute<{
      status: string;
      count: number;
    }>(sql`SELECT s.status, count(*)::int AS count FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id WHERE a.family = ${family}
    ${filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})` : sql``} GROUP BY s.status`);
    const count = (status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return {
      applied: count(suggestionStatus.enum.applied),
      rejected: count(suggestionStatus.enum.rejected),
      resolved: count("resolved"),
      superseded: count(suggestionStatus.enum.superseded),
      fields: [],
    };
  };

async function storedKeys(
  db: Database,
  query: SuggestionFamilyQuery,
  family: "product_pair" | "image_description",
): Promise<SuggestionKey[]> {
  if (query.filters.status !== "pending") return [];
  const declaration = reviewFamilyDeclarations[family];
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    createdAt: Date | string;
    conflict: boolean;
  }>(sql`
    SELECT a.id, s.fingerprint, a."createdAt", COALESCE((a.judgment->>${assessmentJudgments.product_pair.keyof().enum.conflict})::boolean, false) AS conflict
    FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
    WHERE ${family === "image_description" ? pendingImageDescriptionEligibility() : sql`a.family = ${family} AND a.served AND s.active AND s.status = ${suggestionStatus.enum.pending} AND s.suppression IS NULL AND ${declaration.actionable}`}
      AND ${assessmentIdScope(query.assessmentIds, sql`a.id`)}
      ${query.filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${query.filters.runId})` : sql``}
      ${
        family === "product_pair"
          ? sql`AND ${currentProductPairPolicySql(sql`a.producer`)} AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id = s."recordId" AND p."deletedAt" IS NULL)
        AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id::text = s.data->>'otherId' AND p."deletedAt" IS NULL)`
          : sql``
      }`);
  return rows.map((row) => ({
    family,
    assessmentId: row.id,
    status: "pending",
    fingerprint: row.fingerprint,
    clean: false,
    strength: row.conflict ? "weak" : "medium",
    impact: [],
    createdAt: new Date(row.createdAt),
    columns: { entityKind: family === "product_pair" ? "product" : "image" },
    matchedRules: [],
    automaticRule: null,
  }));
}

export const productPairFamily: SuggestionFamilyPresentation<"product_pair"> = {
  keys: (db, query) => storedKeys(db, query, "product_pair"),
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const candidates = await getProductMatchQueue(db, {
      assessmentIds: keys.map((key) => key.assessmentId),
    });
    const byId = new Map(keys.map((key) => [key.assessmentId, key]));
    return new Map(
      candidates.items.flatMap((candidate) => {
        const key = byId.get(candidate.assessmentId);
        if (!key || !candidate.actionable) return [];
        const record = { entity: "product", id: candidate.keeper.id };
        const other = { entity: "product", id: candidate.other.id };
        const canMerge =
          !candidate.identityConflict && candidate.fingerprint !== null;
        return [
          [
            key.assessmentId,
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
};

export const imageDescriptionFamily: SuggestionFamilyPresentation<"image_description"> =
  {
    keys: (db, query) => storedKeys(db, query, "image_description"),
    rows: async (db, keys) => {
      if (!keys.length) return new Map();
      const corrections = await readCorrectionOutcomes(
        db,
        keys.map((key) => key.assessmentId),
      );
      const { rows } = await unwrapDb(db).execute<{
        id: string;
        judgment: unknown;
      }>(sql`SELECT a.id, a.judgment FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
      JOIN "Image" i ON i.id = s."recordId" AND i."deletedAt" IS NULL
      WHERE a.id IN (${sql.join(
        keys.map((key) => sql`${key.assessmentId}::uuid`),
        sql`, `,
      )}) AND s.active AND s.status = ${suggestionStatus.enum.pending}`);
      const refs = await readAssessmentRecordRefs(
        db,
        keys.map((key) => key.assessmentId),
      );
      const byId = new Map(keys.map((key) => [key.assessmentId, key]));
      return new Map(
        rows.flatMap((row) => {
          const key = byId.get(row.id),
            record = refs.get(row.id)?.[0];
          if (!key || !record) return [];
          const description = z.string().min(1).parse(row.judgment);
          const correction = corrections.get(row.id);
          const held =
            correction?.outcome.status === "held" ? correction.outcome : null;
          return [
            [
              row.id,
              imageDescriptionSuggestionRow.parse({
                ...keyBase(key),
                family: "image_description",
                record,
                summary: [
                  { kind: "text", text: description },
                  ...(held
                    ? [
                        {
                          kind: "text",
                          text: `Automatic correction held: ${held.reason}`,
                        },
                      ]
                    : []),
                ],
                actions: held
                  ? actions("correct", "dismiss")
                  : actions("accept", "correct", "reject", "dismiss"),
                review: {
                  correction: {
                    label: "Correct description",
                    value: description,
                  },
                },
                evidence: {
                  kind: "declared",
                  description,
                  facts: held
                    ? [
                        { label: "Automatic correction", value: held.reason },
                        {
                          label: "Confirmed description",
                          value:
                            typeof correction?.correctedValue === "string"
                              ? correction.correctedValue
                              : JSON.stringify(correction?.correctedValue),
                        },
                      ]
                    : [],
                },
              }),
            ] as const,
          ];
        }),
      );
    },
    outcomes: outcomes("image_description"),
    acceptAsIs: () => null,
  };
