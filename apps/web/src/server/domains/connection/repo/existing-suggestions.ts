import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionProposal,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import { PRODUCT_PAIR_NOT_ACTIONABLE } from "@cubby/schemas/recommendations";
import {
  type SuggestionProducer,
  type EntityPairSuggestionFamily,
  entityPairSuggestionFamilies,
  isEntityPairSuggestionFamily,
} from "@cubby/schemas/suggestion";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { suggestionTable, entityIdentity } from "~/server/db/schema";
import {
  currentProductPairPolicy,
  productPairApplicationKey,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { readStoredProductPair } from "~/server/domains/product/repo/match/product-pair-signals";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readFieldSuggestions } from "~/server/generic/suggestions/repo/field-gaps";
import { memberRejectedSql } from "~/server/generic/suggestions/repo/suggestion-decisions";

import {
  connectionReadEvidence,
  connectionReadEvidenceSql,
  connectionBasisIsCurrent,
  forEachConnectionBasis,
} from "./connection-evidence";

const fieldRelations = new Map<string, ConnectionRelation>(
  Object.entries({
    "task.subjectProductId": "task-subject-product",
    "product.ingredientId": "product-ingredient",
    "product.growsPlantId": "product-grows-plant",
    "cookbook.productId": "cookbook-product",
    "device.productId": "device-product",
    "expense.productId": "product-expense",
    "expense.projectId": "expense-project",
    "inventory.locationId": "inventory-location",
  } satisfies Record<string, ConnectionRelation>),
);
/**
 * Review presentation per entity-pair family. A pair that is not actionable or
 * carries an identity conflict stays visible with its stored reason; the
 * family's review surface owns whether it can merge.
 */
const pairFamilies = {
  product_pair: {
    relation: "product-identity",
    integration: { kind: "product-pair-review" },
    current: currentProductPairPolicy,
    explain: (evidence: unknown) => {
      const stored = readStoredProductPair(evidence);
      return {
        reason: stored.evidence,
        conflicts: stored.conflictReasons,
        notActionable: PRODUCT_PAIR_NOT_ACTIONABLE,
      };
    },
  },
} satisfies Record<
  EntityPairSuggestionFamily,
  {
    relation: ConnectionRelation;
    integration: ConnectionProposal["integration"];
    current: (producer: SuggestionProducer | null) => boolean;
    explain: (evidence: unknown) => {
      reason: string | null;
      conflicts: string[];
      /** Unknown shown when the judgment is not actionable. */
      notActionable: string;
    };
  }
>;
const pairFamilyList = sql.join(
  entityPairSuggestionFamilies.map((family) => sql`${family}`),
  sql`, `,
);
const key = (source: EntityRef) => `${source.entityKind}:${source.entityId}`;
const canonicalPairTargetId = (
  value: SQL,
) => sql`CASE WHEN ${value} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (${value})::uuid END`;

/** Indexed potential membership, before mutable eligibility and evidence guards. */
function existingConnectionSuggestionIds(
  db: Database,
  sources: readonly EntityRef[],
) {
  const keys = sources.map(key);
  const codes = sql.join(
    [...new Set(sources.map((source) => source.entityId))].map(
      (code) => sql`${code}`,
    ),
    sql`, `,
  );
  const sourceIds = sql`SELECT source_entity."id" FROM "Entity" source_entity
    WHERE source_entity."shortcode" IN (${codes})
      AND ${inArray(sql`source_entity."kind" || ':' || source_entity."shortcode"`, keys)}`;
  // Literal boolean gates let generic plans prove the partial-index predicates.
  const pendingState = and(
    suggestionTable.active,
    eq(suggestionTable.status, "pending"),
  );
  const idsFor = (_families: "all" | "pair", match: SQL) =>
    getDb(db)
      .select({ id: suggestionTable.id })
      .from(suggestionTable)
      .where(
        and(
          pendingState,
          inArray(suggestionTable.family, entityPairSuggestionFamilies),
          match,
        ),
      );
  const requestedPairs = sql.identifier("existing_pair_requested");
  const pairMembership = sql.identifier("existing_pair_membership");
  const requestedPairId = sql`${requestedPairs}.${sql.identifier("id")}`;
  const pairPointQuery = idsFor(
    "pair",
    sql`${suggestionTable.subject}->>'otherId' IS NOT NULL
      AND md5(${suggestionTable.subject}->>'otherId') = md5(${requestedPairId}::text)
      AND ${suggestionTable.subject}->>'otherId' = ${requestedPairId}::text`,
  );
  // Each endpoint can match many publications. Keep its indexed identity probe
  // parameterized rather than hashing the pair population for a large roster.
  // The computed ID needs an alias when the union is exposed as a CTE.
  const pairIds = getDb(db)
    .select({
      id: sql<
        typeof suggestionTable.$inferSelect.id
      >`${pairMembership}.${sql.identifier("id")}`.as("id"),
    })
    .from(sql`(${sourceIds}) AS ${requestedPairs}`)
    .innerJoinLateral(
      sql`(${pairPointQuery.getSQL()} OFFSET 0) AS ${pairMembership}`,
      sql`true`,
    );
  return idsFor(
    "all",
    sql`
    ${inArray(suggestionTable.entity, [...new Set(sources.map((source) => source.entityKind))])}
    AND ${suggestionTable.recordId} IN (${sourceIds})`,
  ).union(pairIds);
}

/** Exact current edge identities across families, before evidence admission. */
/** Keep the original family handle: its review handler owns evidence and writes. */
export async function readExistingConnectionSuggestions(
  db: Database,
  sources: readonly EntityRef[],
): Promise<ConnectionProposal[][]> {
  if (!sources.length) return [];
  const from = alias(entityIdentity, "connection_from");
  const to = alias(entityIdentity, "connection_to");
  const keys = sources.map(key);
  // Share discovery and hydration in one statement, including READ COMMITTED callers.
  // Both family reads reference this ID-only CTE, so PostgreSQL materializes it once.
  const matched = getDb(db)
    .$with("matched_existing_assessments")
    .as(existingConnectionSuggestionIds(db, sources));
  // The old text equality admitted only canonical lower-case UUID spellings.
  // Guard the native lookup so malformed or differently spelled history stays unmatched.
  const pairTargetId = canonicalPairTargetId(
    sql`${suggestionTable.subject}->>'otherId'`,
  );
  const rowsFor = () =>
    getDb(db)
      .select({
        prediction: {
          id: suggestionTable.id,
          family: suggestionTable.family,
          subject: suggestionTable.subject,
          judgment: suggestionTable.judgment,
          producer: suggestionTable.producer,
          fingerprint: suggestionTable.fingerprint,
          evidence:
            sql<unknown>`CASE WHEN ${suggestionTable.family} = ${"product_pair"} THEN ${suggestionTable.evidence} ELSE NULL END`.as(
              "evidence",
            ),
        },
        state: {
          entity: suggestionTable.entity,
          field: suggestionTable.field,
          recordId: suggestionTable.recordId,
          data: suggestionTable.data,
        },
        connectionEvidence: connectionReadEvidenceSql(
          sql`${suggestionTable.data}->'connectionEvidence'`,
        ).as("connectionEvidence"),
        sourceKind: sql`${from.kind}`.mapWith(from.kind).as("sourceKind"),
        sourceCode: sql`${from.shortcode}`
          .mapWith(from.shortcode)
          .as("sourceCode"),
        targetKind: sql`${to.kind}`.mapWith(to.kind).as("targetKind"),
        targetCode: sql`${to.shortcode}`.mapWith(to.shortcode).as("targetCode"),
        connectionOrderCreatedAt: sql`${suggestionTable.createdAt}`.as(
          "connectionOrderCreatedAt",
        ),
      })
      .from(suggestionTable)
      .innerJoin(
        from,
        and(
          eq(from.id, suggestionTable.recordId),
          eq(from.kind, suggestionTable.entity),
          notDeleted(from),
          sql`${from.mergedIntoId} IS NULL`,
        ),
      )
      .innerJoin(
        to,
        and(
          notDeleted(to),
          sql`${to.mergedIntoId} IS NULL`,
          eq(to.id, pairTargetId),
        ),
      )
      .where(
        and(
          eq(suggestionTable.active, true),
          eq(suggestionTable.status, "pending"),
          inArray(suggestionTable.family, entityPairSuggestionFamilies),
          sql`${suggestionTable.id} = ANY(ARRAY(${getDb(db).select({ id: matched.id }).from(matched)}))`,
          sql`(${inArray(sql`${from.kind} || ':' || ${from.shortcode}`, keys)} OR ${inArray(sql`${to.kind} || ':' || ${to.shortcode}`, keys)})`,
          sql`NOT ${memberRejectedSql(sql`${suggestionTable.decisions}`)}`,
          sql`NOT EXISTS (SELECT 1 FROM "Suggestion" suppressed WHERE suppressed.active AND suppressed.entity=${suggestionTable.entity} AND suppressed."recordId"=${suggestionTable.recordId} AND suppressed.suppression IS NOT NULL AND suppressed.suppression->>'candidateKey'=CASE WHEN ${suggestionTable.family} IN (${pairFamilyList}) THEN (${suggestionTable.subject}->>'recordId') || '|' || (${suggestionTable.subject}->>'otherId') ELSE '' END)`,
        ),
      );
  const candidates = rowsFor().as("existing_connections");
  const rows = await getDb(db)
    .with(matched)
    .select()
    .from(candidates)
    .orderBy(
      sql`${sql.identifier("connectionOrderCreatedAt")}`,
      sql`${sql.identifier("id")}`,
    );
  const proposals = (
    await Promise.all(
      rows.map(async (row) => {
        const { prediction, state } = row;
        let relation: ConnectionRelation | undefined;
        let integration: ConnectionProposal["integration"];
        let suppression: ConnectionProposal["review"]["suppression"] = null;
        let evidence: ConnectionProposal["evidence"] = {
          reasons: ["Existing domain Suggestion"],
          contradictions: [],
          unknowns: [
            "Review the original Suggestion evidence before accepting",
          ],
        };
        if (isEntityPairSuggestionFamily(prediction.family)) {
          const family = pairFamilies[prediction.family];
          const judgment = z
            .object({ actionable: z.boolean(), conflict: z.boolean() })
            .safeParse(prediction.judgment);
          if (!judgment.success || !family.current(prediction.producer))
            return [];
          relation = family.relation;
          integration = family.integration;
          const subject = z
            .object({ recordId: z.string(), otherId: z.string() })
            .parse(prediction.subject);
          suppression = {
            scope: prediction.family,
            candidateKey: `${subject.recordId}|${subject.otherId}`,
            fingerprint: null,
          };
          const { reason, conflicts, notActionable } = family.explain(
            prediction.evidence,
          );
          evidence = {
            reasons: [reason ?? "Existing domain Suggestion"],
            contradictions: judgment.data.conflict
              ? conflicts.length
                ? conflicts
                : [reason ?? "Identity conflict"]
              : [],
            unknowns: judgment.data.actionable ? [] : [notActionable],
          };
        } else {
          // email_link records are operational decisions, never pending suggestions.
          return [];
        }
        const fingerprint =
          prediction.family === "product_pair"
            ? await productPairApplicationKey(db, {
                ...state,
                fingerprint: prediction.fingerprint,
              })
            : prediction.fingerprint;
        if (!relation || !fingerprint) return [];
        const result = connectionProposal.safeParse({
          relation,
          source: { entityKind: row.sourceKind, entityId: row.sourceCode },
          target: { entityKind: row.targetKind, entityId: row.targetCode },
          label: `Review ${relation.replaceAll("-", " ")}`,
          evidence,
          fingerprint,
          review: {
            suggestionId: prediction.id,
            suppression,
            family: prediction.family,
          },
          integration,
        });
        return result.success ? [result.data] : [];
      }),
    )
  ).flat();
  const guards = new Map(
    proposals.map((proposal) => [
      proposal,
      connectionReadEvidence.safeParse(
        rows.find((row) => row.prediction.id === proposal.review.suggestionId)
          ?.connectionEvidence,
      ),
    ]),
  );
  const fresh = new Set<ConnectionProposal>();
  const guarded = proposals.flatMap((proposal) => {
    const guard = guards.get(proposal)!;
    if (guard.success) return [{ proposal, candidate: guard.data.candidate }];
    fresh.add(proposal);
    return [];
  });
  await forEachConnectionBasis(db, guarded, async ({ proposal }, basis) => {
    if (await connectionBasisIsCurrent(db, proposal.review.suggestionId, basis))
      fresh.add(proposal);
  });
  for (const row of await readFieldSuggestions(db)) {
    const relation = fieldRelations.get(`${row.entity}.${row.field}`);
    if (!relation || typeof row.suggestedValue !== "string") continue;
    const refs = await resolveShortcodes(db, [
      row.recordId,
      row.suggestedValue,
    ]);
    const target = refs.get(row.suggestedValue);
    if (!target) continue;
    const parsed = connectionProposal.safeParse({
      relation,
      source: { entityKind: row.entity, entityId: row.recordId },
      target: { entityKind: target.entity, entityId: row.suggestedValue },
      label: `Review ${row.field}`,
      evidence: { reasons: ["Field Answer"], contradictions: [], unknowns: [] },
      fingerprint: row.id,
      review: { suggestionId: row.id, suppression: null },
      integration: { kind: "field-review", field: row.field },
    });
    if (parsed.success) {
      proposals.push(parsed.data);
      fresh.add(parsed.data);
    }
  }

  return sources.map((source) =>
    proposals
      .filter(
        (p) => key(p.source) === key(source) || key(p.target) === key(source),
      )
      .filter((proposal) => fresh.has(proposal)),
  );
}
