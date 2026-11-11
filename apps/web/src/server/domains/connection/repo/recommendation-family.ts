import { suggestionStatus } from "@cubby/schemas/ai";
import {
  connectionCandidate,
  type ConnectionProposal,
} from "@cubby/schemas/entity-connections";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import {
  recommendationSuggestionRow,
  type SuggestionListRow,
} from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import { unwrapDb } from "~/server/db/helpers";
import {
  connectionApplicationKey,
  connectionApplicationTerms,
  readStoredConnectionProposals,
} from "~/server/domains/connection/repo/entity-connections";
import {
  pendingRecommendationEligibility,
  recommendationScopes,
} from "~/server/generic/suggestions/repo/pending-admission";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { outcomes } from "~/server/generic/suggestions/repo/suggestion-outcomes";
import {
  suggestionIdScope,
  keyBase,
  shortcodeEntity,
  connectionImpact,
  RETRIEVED_REASON,
  connectionStrength,
  connectionActions,
  connectionImpactCount,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  one,
  endpoint,
  declareAffectedRecords,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";

export const recommendationFamily: SuggestionFamilyDeclaration<"recommendation"> & {
  scopes: typeof recommendationScopes;
} = {
  family: "recommendation",
  facts: (query, needs) => {
    if (query.filters.status !== "pending") return null;
    const has = (...names: string[]) => names.some((name) => needs.has(name));
    const target = (key: "entityKind" | "entityId") =>
      sql`s.data->'connectionTarget'->>${key}`;
    const { runId } = query.filters;
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
        ${runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runId})` : sql``}`,
    };
  },
  keys: async (db, query) => {
    const { filters } = query;
    if (filters.status !== "pending") return [];
    const run = query.filters.runId;
    // Mirrors readEntityConnectionsBatch's selection; hydration rechecks evidence.
    const rows = await unwrapDb(db).execute<{
      id: string;
      fingerprint: string | null;
      createdAt: Date | string;
      candidate: unknown;
    }>(
      sql`
      SELECT s.id, s.fingerprint, s."createdAt", s.evidence->'candidate' AS candidate
      FROM "Suggestion" s
      WHERE s.family = ${suggestionFamily.enum.recommendation} AND s.active
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        AND s.status = ${suggestionStatus.enum.pending}
        AND ${recommendationScopes.connection}
        AND ${pendingRecommendationEligibility()}
        ${run ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${run})` : sql``}
    `,
      "objects",
    );
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
    return connectionKeys;
  },
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    const found = new Map<string, SuggestionListRow>();
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
  outcomes: outcomes("recommendation"),
  acceptAsIs: () => null,
  ...suggestionReviewFamilies.recommendation,
  scopes: recommendationScopes,
  ...declareAffectedRecords({
    roles: ["subject", "source", "target", "retained"],
    forward: () => sql`${one} || CASE WHEN ${recommendationScopes.connection}
      THEN jsonb_build_array(${endpoint("source")}, ${endpoint("target")})
      ELSE COALESCE(s.evidence->'records', '[]'::jsonb) END`,
    references: [
      { kind: "primary" },
      ...(["source", "target"] as const).map((end) => ({
        kind: "value" as const,
        subject: true,
        at: {
          column: "evidence" as const,
          path: ["candidate", end, "entityId"],
        },
        entity: {
          column: "evidence" as const,
          path: ["candidate", end, "entityKind"],
        },
        guard: { scope: "connection" },
      })),
      {
        kind: "contains",
        at: { column: "evidence", path: ["records"] },
        guard: { scope: "connection", negate: true },
      },
    ],
  }),
  actionable: sql`(${sql.join(Object.values(recommendationScopes), sql` OR `)})`,
  transactionBound: false,
  isolationLevel: "serializable",
  applicationKey: connectionApplicationKey,
  applicationTerms: connectionApplicationTerms,
  apply: async (db, context, state, input) => {
    const { applyEntityConnection } =
      await import("~/server/domains/connection/repo/entity-connections");
    return applyEntityConnection(db, context, state, input);
  },
};
