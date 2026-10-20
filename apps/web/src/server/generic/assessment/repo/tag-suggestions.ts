import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { productId } from "@cubby/schemas/identifiers";
import { tagPropagationRecommendationOut } from "@cubby/schemas/recommendations";
import { recommendationSuggestionRow } from "@cubby/schemas/suggestion-list";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, unwrapDb } from "~/server/db/helpers";
import { assessment, assessmentState, product } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { executeEntity } from "~/server/entity-kernel/execute";

import {
  keyBase,
  type SuggestionFamilyQuery,
  type SuggestionKey,
} from "./suggestion-families";

const proposalSchema = tagPropagationRecommendationOut.shape.proposals.element;

async function tagRows(db: Database, ids?: readonly string[]) {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    evidence: unknown;
    fingerprint: string | null;
    createdAt: Date | string;
    shortcode: string;
    subject: unknown;
  }>(sql`
    SELECT a.id, a.evidence, a.subject, s.fingerprint, a."createdAt", p.shortcode
    FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id JOIN "Product" p ON p.id = s."recordId" AND p."deletedAt" IS NULL
    WHERE a.family = ${assessmentFamily.enum.recommendation} AND a.subject->>'scope' = 'product.tag-propagation' AND a.served AND s.active AND s.status = ${suggestionStatus.enum.pending}
      AND s.suppression IS NULL AND p."updatedAt" <= a."createdAt" AND NOT (a.evidence->>'tag' = ANY(p.tags))
      AND NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active AND suppressed.entity = s.entity AND suppressed."recordId" = s."recordId"
        AND suppressed.suppression->>'scope' = a.subject->>'scope' AND suppressed.suppression->>'candidateKey' = a.subject->>'candidateKey'
        AND (suppressed.suppression->>'fingerprint' IS NULL OR suppressed.suppression->>'fingerprint' = a.fingerprint))
      ${
        ids
          ? sql`AND a.id IN (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }`);
  return rows.flatMap((row) => {
    const parsed = proposalSchema.safeParse(row.evidence);
    return parsed.success && parsed.data.supportingProductCount >= 3
      ? [{ ...row, proposal: parsed.data }]
      : [];
  });
}
export async function tagSuggestionKeys(
  db: Database,
  query: SuggestionFamilyQuery,
): Promise<SuggestionKey[]> {
  if (query.filters.status !== "pending") return [];
  return (await tagRows(db)).map((row) => ({
    family: "recommendation",
    assessmentId: row.id,
    status: "pending",
    fingerprint: row.fingerprint,
    clean: false,
    strength: "medium",
    impact: [],
    createdAt: new Date(row.createdAt),
    columns: { entityKind: "product" },
    matchedRules: [],
    automaticRule: null,
  }));
}
export async function tagSuggestionRows(
  db: Database,
  keys: readonly SuggestionKey[],
) {
  if (!keys.length)
    return new Map<string, z.infer<typeof recommendationSuggestionRow>>();
  const rows = await tagRows(
    db,
    keys.map((key) => key.assessmentId),
  );
  const byId = new Map(keys.map((key) => [key.assessmentId, key]));
  return new Map(
    rows.flatMap((row) => {
      const key = byId.get(row.id);
      if (!key) return [];
      const subject = z
        .object({ scope: z.string(), candidateKey: z.string() })
        .parse(row.subject);
      return [
        [
          row.id,
          recommendationSuggestionRow.parse({
            ...keyBase(key),
            family: "recommendation",
            record: { entity: "product", id: row.shortcode },
            summary: [{ kind: "text", text: `Add tag ${row.proposal.tag}` }],
            actions: ["accept", "reject", "dismiss", "never_suggest"].map(
              (verb) => ({ verb, ownerOnly: false }),
            ),
            review: { suppression: { ...subject, fingerprint: null } },
            evidence: {
              kind: "declared",
              description: `Add tag ${row.proposal.tag}`,
              facts: [
                {
                  label: "Supporting Products",
                  value: row.proposal.supportingProductCount,
                },
              ],
            },
          }),
        ] as const,
      ];
    }),
  );
}

/** Re-resolve the same proposal before the normal Product update; preserve unrelated current tags. */
export async function applyTagSuggestion(
  db: Database,
  context: EntityKernelContext,
  state: typeof assessmentState.$inferSelect,
) {
  const [prediction] = await getDb(db)
    .select()
    .from(assessment)
    .where(eq(assessment.id, state.id))
    .limit(1);
  const proposal = proposalSchema.parse(prediction?.evidence);
  const [source] = await getDb(db)
    .select({
      shortcode: product.shortcode,
      tags: product.tags,
      updatedAt: product.updatedAt,
      deletedAt: product.deletedAt,
    })
    .from(product)
    .where(eq(product.id, productId.parse(state.recordId)))
    .limit(1);
  if (!source) throw new Error("Product no longer exists");
  if (
    !prediction ||
    source.deletedAt ||
    source.updatedAt > prediction.createdAt ||
    proposal.supportingProductCount < 3 ||
    source.tags.includes(proposal.tag)
  )
    throw new Error("Tag proposal evidence changed; find suggestions again");
  await executeEntity(
    { ...context, db },
    entityCommandSchema.parse({
      action: "update",
      entity: "product",
      id: source.shortcode,
      data: { tags: [...new Set([...source.tags, proposal.tag])] },
    }),
  );
}
