import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { productShortcode } from "@cubby/schemas/identifiers";
import { tagPropagationRecommendationOut } from "@cubby/schemas/recommendations";
import { recommendationSuggestionRow } from "@cubby/schemas/suggestion-list";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { assessment, assessmentState, product } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { executeEntity } from "~/server/entity-kernel/execute";
import { assessRecommendation } from "~/server/generic/assessment/repo/assessment-recommendation";
import { reviewFamilyDeclarations } from "~/server/generic/assessment/repo/review-families";

import {
  keyBase,
  type SuggestionFamilyQuery,
  type SuggestionKey,
} from "./suggestion-families";

const candidateSchema = tagPropagationRecommendationOut.shape.proposals.element;
const proposalSchema = candidateSchema.extend({
  basis: z.object({
    sourceRevision: z.iso.datetime(),
    supportingProducts: z
      .array(z.object({ id: productShortcode, revision: z.iso.datetime() }))
      .min(3),
  }),
});

async function tagRecords(db: Database, codes: readonly string[]) {
  const unique = [...new Set(codes)];
  const rows = [];
  for (let start = 0; start < unique.length; start += 250) {
    rows.push(
      ...(await getDb(db)
        .select({
          shortcode: product.shortcode,
          tags: product.tags,
          updatedAt: product.updatedAt,
        })
        .from(product)
        .where(
          and(
            inArray(
              product.shortcode,
              unique
                .slice(start, start + 250)
                .map((id) => productShortcode.parse(id)),
            ),
            isNull(product.deletedAt),
          ),
        )),
    );
  }
  return new Map(rows.map((row) => [row.shortcode, row]));
}

function currentBasis(
  sourceId: string,
  proposal: z.infer<typeof proposalSchema>,
  records: Awaited<ReturnType<typeof tagRecords>>,
) {
  const source = records.get(productShortcode.parse(sourceId));
  const donors = proposal.basis.supportingProducts;
  return source &&
    source.updatedAt.toISOString() === proposal.basis.sourceRevision &&
    !source.tags.includes(proposal.tag) &&
    donors.length === proposal.supportingProductCount &&
    new Set(donors.map((donor) => donor.id)).size === donors.length &&
    donors.every((donor) => {
      const current = records.get(donor.id);
      return (
        donor.id !== sourceId &&
        current?.updatedAt.toISOString() === donor.revision &&
        current.tags.includes(proposal.tag)
      );
    })
    ? source
    : undefined;
}

export async function tagSourceRevision(db: Database, sourceId: string) {
  return (await tagRecords(db, [sourceId]))
    .get(productShortcode.parse(sourceId))
    ?.updatedAt.toISOString();
}

/** Persist the discovery basis so a later review cannot apply stale donor votes. */
export async function prepareTagSuggestionPublication(
  db: Database,
  sourceId: string,
  candidate: z.infer<typeof candidateSchema>,
  sourceRevision: string,
) {
  const records = await tagRecords(db, [
    sourceId,
    ...(candidate.supportingProductIds ?? []),
  ]);
  const parsed = proposalSchema.safeParse({
    ...candidate,
    basis: {
      sourceRevision,
      supportingProducts: (candidate.supportingProductIds ?? []).flatMap(
        (id) => {
          const record = records.get(id);
          return record
            ? [{ id, revision: record.updatedAt.toISOString() }]
            : [];
        },
      ),
    },
  });
  if (!parsed.success || !currentBasis(sourceId, parsed.data, records))
    return null;
  const proposal = parsed.data;
  return async (transactionDb: Database) => {
    if (
      !currentBasis(
        sourceId,
        proposal,
        await tagRecords(transactionDb, [
          sourceId,
          ...proposal.basis.supportingProducts.map((donor) => donor.id),
        ]),
      )
    )
      return null;
    return assessRecommendation(
      transactionDb,
      sourceId,
      "product.tag-propagation",
      [proposal.tag],
      proposal,
    );
  };
}

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
    FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id JOIN "Product" p ON p.id = s."recordId" AND ${notDeleted("p")}
    WHERE a.family = ${assessmentFamily.enum.recommendation} AND ${reviewFamilyDeclarations.recommendation.scopes.tagPropagation} AND a.served AND s.active AND s.status = ${suggestionStatus.enum.pending}
      AND s.suppression IS NULL AND p."updatedAt" <= a."createdAt" AND NOT (a.evidence->>'tag' = ANY(p.tags))
      AND NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active AND suppressed.entity = s.entity AND suppressed."recordId" = s."recordId"
        AND suppressed.suppression->>'scope' = a.subject->>'scope' AND suppressed.suppression->>'candidateKey' = a.subject->>'candidateKey'
        AND (suppressed.suppression->>'fingerprint' IS NULL OR suppressed.suppression->>'fingerprint' = a.fingerprint))
      ${ids ? sql`AND a.id = ANY(${uuidArrayParam(ids)})` : sql``}`);
  const parsedRows = rows.flatMap((row) => {
    const parsed = proposalSchema.safeParse(row.evidence);
    return parsed.success && parsed.data.supportingProductCount >= 3
      ? [{ ...row, proposal: parsed.data }]
      : [];
  });
  const records = await tagRecords(
    db,
    parsedRows.flatMap((row) => [
      row.shortcode,
      ...row.proposal.basis.supportingProducts.map((donor) => donor.id),
    ]),
  );
  return parsedRows.filter((row) =>
    currentBasis(row.shortcode, row.proposal, records),
  );
}
export async function tagSuggestionKeys(
  db: Database,
  query: SuggestionFamilyQuery,
): Promise<SuggestionKey[]> {
  if (query.filters.status !== "pending") return [];
  return (await tagRows(db, query.assessmentIds)).map((row) => ({
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
    .select({ evidence: assessment.evidence })
    .from(assessment)
    .where(eq(assessment.id, state.id))
    .limit(1);
  const proposal = proposalSchema.parse(prediction?.evidence);
  const [identity] = await getDb(db)
    .select({ shortcode: product.shortcode })
    .from(product)
    .where(sql`${product.id} = ${state.recordId}::uuid`)
    .limit(1);
  if (!identity) throw new Error("Product no longer exists");
  const source = currentBasis(
    identity.shortcode,
    proposal,
    await tagRecords(db, [
      identity.shortcode,
      ...proposal.basis.supportingProducts.map((donor) => donor.id),
    ]),
  );
  if (!source)
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
