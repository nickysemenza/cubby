import { recommendationSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import type { SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import {
  connectionActions,
  connectionImpact,
  connectionStrength,
  keyBase,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import { declareAffectedRecords } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

import { readStoredConnectionProposals } from "./entity-connections";

export const recommendationFamily: SuggestionFamilyDeclaration<"recommendation"> =
  {
    family: "recommendation",
    ...suggestionReviewFamilies.recommendation,
    keys: async (db, query) => {
      if (query.filters.status !== "pending" || query.filters.runId) return [];
      const rows = await readStoredConnectionProposals(db, {
        ids: query.suggestionIds,
        entity: query.filters.recordEntity,
        records: query.records,
        labels: false,
      });
      return rows.map((row) => ({
        family: "recommendation",
        suggestionId: row.review.suggestionId,
        status: "pending",
        fingerprint: row.fingerprint,
        strength: connectionStrength(row.evidence),
        clean: false,
        impact: connectionImpact[row.relation],
        createdAt: new Date(0),
        matchedRules: [],
        automaticRule: null,
        columns: {
          relation: row.relation,
          source: row.source.entityId,
          target: row.target.entityId,
          entityKind: [row.source.entityKind, row.target.entityKind],
        },
      }));
    },
    rows: async (db, keys) => {
      const rows = await readStoredConnectionProposals(db, {
        ids: keys.map((key) => key.suggestionId),
      });
      return new Map(
        rows.flatMap((row) => {
          const key = keys.find(
            (key) => key.suggestionId === row.review.suggestionId,
          );
          const source = {
              entity: row.source.entityKind,
              id: row.source.entityId,
            },
            target = { entity: row.target.entityKind, id: row.target.entityId };
          return key
            ? [
                [
                  key.suggestionId,
                  recommendationSuggestionRow.parse({
                    ...keyBase(key),
                    family: "recommendation",
                    record: source,
                    other: target,
                    summary: [
                      { kind: "record", ref: source },
                      { kind: "text", text: row.label },
                      { kind: "record", ref: target },
                    ],
                    actions: connectionActions(row),
                    evidence: row,
                  }),
                ],
              ]
            : [];
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
    ...declareAffectedRecords({
      roles: ["source", "target"],
      forward: () => sql`'[]'::jsonb`,
      references: [],
    }),
    actionable: sql`false`,
  };
