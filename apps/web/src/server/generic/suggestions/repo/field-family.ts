import {
  fieldSuggestionRow,
  type SuggestionListFilters,
} from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";

import {
  fieldFacts,
  readFieldSuggestions,
  readFieldDecisions,
  suggestionCounts,
} from "./field-gaps";
import type { SuggestionFamilyDeclaration } from "./suggestion-family-declaration";
import { keyBase, verbs } from "./suggestion-presentation";
import { declareAffectedRecords } from "./suggestion-record-discovery";

const readPage = (
  db: Database,
  ids: readonly string[],
  filters: SuggestionListFilters,
) =>
  filters.status === "pending"
    ? readFieldSuggestions(db, { ids, runId: filters.runId })
    : readFieldDecisions(db, filters.status, { ids });

/** Read presentation only: field actions are kernel Decisions. */
export const fieldFamily: SuggestionFamilyDeclaration<"field"> = {
  family: "field",
  ...suggestionReviewFamilies.field,
  facts: (query, needs) =>
    fieldFacts(
      {
        entity: query.filters.recordEntity,
        records: query.records,
        runId: query.filters.runId,
      },
      query.filters.status,
      needs,
    ),
  pageRows: async (db, ids, filters) => {
    const rows = await readPage(db, ids, filters);
    return new Map(
      rows.map((row) => [
        row.id,
        fieldSuggestionRow.parse({
          ...keyBase({
            family: "field",
            suggestionId: row.id,
            status: row.status,
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
          }),
          family: "field",
          record: { entity: row.entity, id: row.recordId },
          summary: [
            { kind: "field", entity: row.entity, field: row.field },
            { kind: "value", value: row.suggestedValue },
          ],
          actions: verbs("accept", "correct", "reject"),
          evidence: row,
        }),
      ]),
    );
  },
  outcomes: async (db, filters, records) => {
    const fields = await suggestionCounts(db, {
      runId: filters.runId,
      entity: filters.recordEntity,
      records,
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
