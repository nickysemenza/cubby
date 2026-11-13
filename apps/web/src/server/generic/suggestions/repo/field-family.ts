import { fieldSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import {
  readFieldSuggestions,
  readFieldDecisions,
  suggestionCounts,
} from "./field-gaps";
import type { SuggestionFamilyDeclaration } from "./suggestion-family-declaration";
import { keyBase, verbs } from "./suggestion-presentation";
import { declareAffectedRecords } from "./suggestion-record-discovery";

/** Read presentation only: field actions are kernel Decisions. */
export const fieldFamily: SuggestionFamilyDeclaration<"field"> = {
  family: "field",
  ...suggestionReviewFamilies.field,
  keys: async (db, query) => {
    const rows =
      query.filters.status === "pending"
        ? await readFieldSuggestions(
            db,
            query.suggestionIds,
            query.filters.runId,
          )
        : await readFieldDecisions(
            db,
            query.filters.status,
            query.suggestionIds,
          );
    return rows
      .filter(
        (row) =>
          (!query.filters.recordEntity ||
            row.entity === query.filters.recordEntity) &&
          (!query.records ||
            query.records.some((record) => record.code === row.recordId)),
      )
      .map((row) => ({
        family: "field",
        suggestionId: row.id,
        status: query.filters.status,
        fingerprint: row.id,
        strength: "weak",
        clean: false,
        impact: [],
        createdAt: new Date(row.createdAt),
        columns: {
          entity: row.entity,
          field: row.field,
          kind: row.kind,
          confidence: row.confidence,
          disposition: "needs_you",
        },
        matchedRules: [],
        automaticRule: null,
      }));
  },
  rows: async (db, keys) => {
    const rows = [
      ...(await readFieldSuggestions(
        db,
        keys.map((key) => key.suggestionId),
      )),
      ...(await readFieldDecisions(
        db,
        "applied",
        keys.map((key) => key.suggestionId),
      )),
      ...(await readFieldDecisions(
        db,
        "rejected",
        keys.map((key) => key.suggestionId),
      )),
    ];
    return new Map(
      rows.flatMap((row) => {
        const key = keys.find((key) => key.suggestionId === row.id);
        return key
          ? [
              [
                row.id,
                fieldSuggestionRow.parse({
                  ...keyBase(key),
                  family: "field",
                  record: { entity: row.entity, id: row.recordId },
                  summary: [
                    { kind: "field", entity: row.entity, field: row.field },
                    { kind: "value", value: row.suggestedValue },
                  ],
                  actions: verbs("accept", "correct", "reject"),
                  evidence: row,
                }),
              ],
            ]
          : [];
      }),
    );
  },
  outcomes: async (db, filters) => {
    const fields = await suggestionCounts(db, {
      runId: filters.runId,
      entity: filters.recordEntity,
    });
    return {
      applied: fields.reduce((sum, row) => sum + row.applied, 0),
      rejected: fields.reduce((sum, row) => sum + row.rejected, 0),
      superseded: 0,
      resolved: 0,
      fields,
    };
  },
  acceptAsIs: () => null,
  ...declareAffectedRecords({
    roles: ["subject"],
    forward: () => sql`'[]'::jsonb`,
    references: [],
  }),
  actionable: sql`false`,
};
