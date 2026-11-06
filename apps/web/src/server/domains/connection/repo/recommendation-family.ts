import { suggestionStatus } from "@cubby/schemas/ai";
import {
  connectionCandidate,
  type ConnectionProposal,
} from "@cubby/schemas/entity-connections";
import {
  suggestionFamily,
  suggestionSubjects,
  suggestionProjectionTargets,
} from "@cubby/schemas/suggestion";
import { recommendationSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql, and, inArray, type SQL, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { unwrapDb, getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { readStoredConnectionProposals } from "~/server/domains/connection/repo/entity-connections";
import { recommendationScopes } from "~/server/generic/suggestions/repo/pending-admission";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  suggestionIdScope,
  keyBase,
  runCode,
  shortcodeEntity,
  connectionImpact,
  RETRIEVED_REASON,
  connectionStrength,
  connectionActions,
  connectionImpactCount,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  pendingRecommendationEligibility,
  reviewSuggestion,
  one,
  reviewQueryBuilder,
  relatedRecordMatch,
  endpoint,
  declareAffectedRecords,
  primaryRecordMatch,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  tagSuggestionKeys,
  tagSuggestionRows,
} from "~/server/generic/suggestions/repo/tag-suggestions";

export const recommendationFamily: SuggestionFamilyDeclaration<"recommendation"> =
  {
    family: "recommendation",
    facts: (query, needs) => {
      if (query.filters.status !== "pending") return null;
      const has = (...names: string[]) => names.some((name) => needs.has(name));
      const target = (key: "entityKind" | "entityId") =>
        sql`s.data->'connectionTarget'->>${key}`;
      const { recordEntity, runId } = query.filters;
      const reasons = sql`s.evidence#>'{candidate,evidence,reasons}'`;
      const retrieved = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${reasons}) = 'array' THEN ${reasons} ELSE '[]'::jsonb END) reason(value)
      WHERE starts_with(reason.value, ${RETRIEVED_REASON}))`;
      const contradicted = sql`coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(s.evidence#>'{candidate,evidence,contradictions}') = 'array' THEN s.evidence#>'{candidate,evidence,contradictions}' END), 0) > 0`;
      return {
        columns: {
          clean: sql`false`,
          // `connectionStrength` over the slim candidate; tag additions are medium.
          strength: sql`CASE WHEN s.evidence->'candidate' IS NULL THEN ${"medium"}
          WHEN ${retrieved} THEN CASE WHEN ${contradicted} THEN ${"weak"} ELSE ${"medium"} END
          WHEN ${contradicted} THEN ${"medium"} ELSE ${"strong"} END`,
          createdAt: sql`to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          impact: sql`CASE s.subject->>'scope' ${connectionImpactCount} ELSE 0 END`,
          relation: sql`substr(s.subject->>'scope', ${"connection.".length + 1})`,
          entityKind: sql`array_remove(ARRAY[s.entity, ${target("entityKind")}], NULL)`,
          source: sql`source_identity.shortcode`,
          target: target("entityId"),
        },
        from: sql.join(
          [
            sql`"Suggestion" s`,
            ...(has("source")
              ? [
                  sql`LEFT JOIN "Entity" source_identity ON source_identity.id = s."recordId"`,
                ]
              : []),
          ],
          sql` `,
        ),
        where: sql`s.family = ${suggestionFamily.enum.recommendation} AND s.active
        AND s.status = ${suggestionStatus.enum.pending}
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        ${recordEntity ? sql`AND (s.entity = ${recordEntity} OR ${target("entityKind")} = ${recordEntity})` : sql``}
        ${runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runId})` : sql``}`,
      };
    },
    keys: async (db, query) => {
      const { filters, records } = query;
      if (filters.status !== "pending") return [];
      if (records?.length === 0) return [];
      const side = (end: "source" | "target", key: "entityKind" | "entityId") =>
        sql`(s.evidence->'candidate'->${end}->>${key})`;
      const endpoint = (end: "source" | "target") =>
        sql`${side(end, "entityKind")} || ':' || ${side(end, "entityId")}`;
      const roster = records
        ? sql.join(
            records.map((record) => sql`${`${record.entity}:${record.code}`}`),
            sql`, `,
          )
        : null;
      const run = runCode(query);
      // Mirrors readEntityConnectionsBatch's selection; hydration rechecks evidence.
      const { rows } = await unwrapDb(db).execute<{
        id: string;
        fingerprint: string | null;
        createdAt: Date | string;
        candidate: unknown;
      }>(sql`
      SELECT s.id, s.fingerprint, s."createdAt", s.evidence->'candidate' AS candidate
      FROM "Suggestion" s
      WHERE s.family = ${suggestionFamily.enum.recommendation} AND s.active
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        AND s.status = ${suggestionStatus.enum.pending}
        AND ${reviewFamilyDeclarations.recommendation.scopes.connection}
        AND ${pendingRecommendationEligibility()}
        ${roster ? sql`AND (${endpoint("source")} IN (${roster}) OR ${endpoint("target")} IN (${roster}))` : sql``}
        ${filters.recordEntity ? sql`AND (${side("source", "entityKind")} = ${filters.recordEntity} OR ${side("target", "entityKind")} = ${filters.recordEntity})` : sql``}
        ${run ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${run})` : sql``}
    `);
      const connectionKeys = rows.flatMap((row) => {
        const parsed = connectionCandidate.safeParse(row.candidate);
        if (!parsed.success) return [];
        const candidate = parsed.data;
        return [
          {
            family: "recommendation" as const,
            suggestionId: row.id,
            status: filters.status,
            // Connections have no Automatic rule.
            matchedRules: [],
            automaticRule: null,
            fingerprint: row.fingerprint,
            // Connections stay individually reviewed (ADR 0016).
            clean: false,
            strength: connectionStrength(candidate.evidence),
            impact: connectionImpact[candidate.relation],
            createdAt: new Date(row.createdAt),
            columns: {
              relation: candidate.relation,
              entityKind: [
                ...new Set([
                  candidate.source.entityKind,
                  candidate.target.entityKind,
                ]),
              ],
              source: candidate.source.entityId,
              target: candidate.target.entityId,
            },
          },
        ];
      });
      return [...connectionKeys, ...(await tagSuggestionKeys(db, query))];
    },
    rows: async (db, keys) => {
      if (!keys.length) return new Map();
      const byId = new Map(keys.map((key) => [key.suggestionId, key]));
      const found = await tagSuggestionRows(db, keys);
      const addProposal = (proposal: ConnectionProposal) => {
        const key = byId.get(proposal.review.suggestionId);
        if (!key || found.has(key.suggestionId)) return;
        const source = {
          entity: shortcodeEntity.parse(proposal.source.entityKind),
          id: proposal.source.entityId,
        };
        const target = {
          entity: shortcodeEntity.parse(proposal.target.entityKind),
          id: proposal.target.entityId,
        };
        found.set(
          key.suggestionId,
          recommendationSuggestionRow.parse({
            ...keyBase(key),
            fingerprint: proposal.fingerprint,
            family: "recommendation",
            record: source,
            other: target,
            summary: [
              { kind: "record", ref: source },
              { kind: "text", text: proposal.label },
              { kind: "record", ref: target },
            ],
            actions: connectionActions(proposal),
            evidence: proposal,
          }),
        );
      };
      for (const proposal of await readStoredConnectionProposals(
        db,
        keys.map((key) => key.suggestionId),
      ))
        addProposal(proposal);
      return found;
    },
    outcomes: async (db, filters) => {
      const { rows } = await unwrapDb(db).execute<{
        status: string;
        count: number;
      }>(sql`
      SELECT s.status, count(*)::int AS count
      FROM "Suggestion" s
      WHERE s.family = ${suggestionFamily.enum.recommendation}
        ${filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})` : sql``}
      GROUP BY s.status
    `);
      const of = (status: string) =>
        rows.find((row) => row.status === status)?.count ?? 0;
      return {
        applied: of("applied"),
        rejected: of("rejected"),
        superseded: of("superseded"),
        resolved: of("resolved"),
        fields: [],
      };
    },
    acceptAsIs: () => null,
    ...suggestionReviewFamilies.recommendation,
    scopes: recommendationScopes,
    ...declareAffectedRecords({
      roles: ["subject", "source", "target", "retained"],
      forward: () => sql`${one} || CASE WHEN ${recommendationScopes.connection}
      THEN jsonb_build_array(${endpoint("source")}, ${endpoint("target")})
      ELSE COALESCE(s.evidence->'records', '[]'::jsonb) END`,
      reverse: (scope) => {
        let retained: SQL | undefined;
        if (scope.records?.length) {
          const indexed = alias(suggestionTable, "retained_indexed");
          const requestedName = sql.identifier("retained_requested");
          const valueName = sql.identifier("value");
          const membershipName = sql.identifier("retained_membership");
          const needles = scope.records.flatMap((record) =>
            [record.id, record.code].map(
              (id) =>
                sql`${JSON.stringify([{ entity: record.entity, id }])}::jsonb`,
            ),
          );
          const pointQuery = reviewQueryBuilder
            .select({ id: indexed.id })
            .from(indexed)
            .where(
              and(
                sql`${indexed.evidence}->'records' @> ${requestedName}.${valueName}`,
              ),
            );
          // One fenced GIN probe per reference avoids scanning every pending
          // recommendation's evidence when the combined OR is estimated broadly.
          const membershipIds = reviewQueryBuilder
            .select({
              id: sql<string>`${membershipName}.${sql.identifier("id")}`,
            })
            .from(
              sql`unnest(ARRAY[${sql.join(needles, sql`, `)}]::jsonb[]) AS ${requestedName}(${valueName})`,
            )
            .innerJoinLateral(
              sql`(${pointQuery.getSQL()} OFFSET 0) AS ${membershipName}`,
              sql`true`,
            );
          retained = inArray(reviewSuggestion.id, membershipIds);
        } else if (!scope.records) {
          retained = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.evidence->'records', '[]'::jsonb)) r
            WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
        }
        return [
          primaryRecordMatch(scope),
          ...[
            {
              entity: sql<string>`s.evidence #>> '{candidate,source,entityKind}'`,
              id: sql<string>`s.evidence #>> '{candidate,source,entityId}'`,
            },
            {
              entity: sql<string>`s.evidence #>> '{candidate,target,entityKind}'`,
              id: sql<string>`s.evidence #>> '{candidate,target,entityId}'`,
            },
          ].map(({ entity, id }) =>
            and(
              recommendationScopes.connection,
              relatedRecordMatch(scope, entity, id),
            ),
          ),
          retained
            ? and(
                sql`(${recommendationScopes.connection}) IS NOT TRUE`,
                retained,
              )
            : undefined,
        ];
      },
    }),
    actionable: sql`(${sql.join(Object.values(recommendationScopes), sql` OR `)})`,
    subject: suggestionSubjects.recommendation,
    target: suggestionProjectionTargets.recommendation,
    transactionBound: false,
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input) => {
      const [prediction] = await getDb(db)
        .select({ subject: suggestionTable.subject })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, state.id))
        .limit(1);
      const subject = suggestionSubjects.recommendation.parse(
        prediction?.subject,
      );
      if (subject.scope === "product.tag-propagation") {
        if (input.verdict !== "correct" || input.correction.present)
          throw new Error(
            "Tag additions require acceptance of the current proposal",
          );
        const { applyTagSuggestion } =
          await import("~/server/generic/suggestions/repo/tag-suggestions");
        await applyTagSuggestion(db, context, state);
        return;
      }
      const { applyEntityConnection } =
        await import("~/server/domains/connection/repo/entity-connections");
      return applyEntityConnection(db, context, state, input);
    },
  };
