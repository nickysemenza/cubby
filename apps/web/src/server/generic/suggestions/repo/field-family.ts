import {
  suggestionJudgments,
  suggestionSubjects,
  suggestionProjectionTargets,
} from "@cubby/schemas/suggestion";
import {
  fieldSuggestionRow,
  type SuggestionSummaryPart,
} from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";

import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import {
  stamps,
  verbs,
  qualityImpact,
  keyBase,
  runCode,
  fieldChecks,
  fieldStrength,
  shortcodeEntity,
  fieldKind,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  fieldReferenceMatch,
  fieldRecords,
  declareAffectedRecords,
  primaryRecordMatch,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  fieldSuggestionKeys,
  readFieldSuggestions,
  suggestionCounts,
  acceptSuggestion,
  applyFieldCorrection,
} from "~/server/generic/suggestions/repo/suggestion-review";

export const fieldFamily: SuggestionFamilyDeclaration<"field"> = {
  family: "field",
  keys: async (db, query) => {
    const { filters, records } = query;
    // Pushed into SQL: the record roster, entity and Run. Column filters
    // apply to every family's keys in the generic list.
    const rows = await fieldSuggestionKeys(db, {
      status: filters.status,
      entities: filters.recordEntity ? [filters.recordEntity] : undefined,
      recordUuids: records?.map((record) => record.id),
      runId: runCode(query),
      suggestionIds: query.suggestionIds,
    });
    return rows.map((row) => {
      const entity = shortcodeEntity.parse(row.entity);
      const kind = fieldKind.parse(row.kind);
      const strength = fieldStrength(row.confidence);
      return {
        family: "field" as const,
        suggestionId: row.id,
        status: filters.status,
        matchedRules: stamps.parse(row.matchedRules),
        automaticRule: row.automaticRule,
        fingerprint: row.fingerprint,
        strength,
        clean: false,
        impact:
          kind === "addition"
            ? (fieldChecks.get(`${entity}.${row.field}`) ?? []).map(
                qualityImpact,
              )
            : [],
        createdAt: row.createdAt,
        columns: {
          entity,
          field: row.field,
          kind,
          confidence: row.confidence,
        },
      };
    });
  },
  rows: async (db, keys) => {
    const rows = await readFieldSuggestions(
      db,
      keys.map((key) => key.suggestionId),
    );
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.suggestionId);
        if (!key) return [];
        const summary: SuggestionSummaryPart[] = [
          { kind: "field", entity: row.entity, field: row.field },
          ...(row.kind === "correction"
            ? [{ kind: "value" as const, value: row.currentValue }]
            : []),
          { kind: "value", value: row.suggestedValue },
        ];
        return [
          [
            row.suggestionId,
            fieldSuggestionRow.parse({
              ...keyBase(key),
              family: "field",
              record: { entity: row.entity, id: row.recordId },
              summary,
              actions: verbs("accept", "correct", "reject", "dismiss"),
              evidence: row,
            }),
          ],
        ];
      }),
    );
  },
  outcomes: async (db, filters) => {
    const fields = await suggestionCounts(db, {
      runId: filters.runId,
      entity: filters.recordEntity,
    });
    const sum = (key: "applied" | "rejected" | "superseded" | "resolved") =>
      fields.reduce((total, row) => total + row[key], 0);
    return {
      applied: sum("applied"),
      rejected: sum("rejected"),
      superseded: sum("superseded"),
      resolved: sum("resolved"),
      fields,
    };
  },
  acceptAsIs: (row) => ({
    suggestionId: row.suggestionId,
    operationId: crypto.randomUUID(),
    verdict: "correct",
    correction: { present: false },
    intent: "apply",
    expectedFingerprint: row.fingerprint,
    reason: null,
    evidence: null,
  }),
  ...suggestionReviewFamilies.field,
  ...declareAffectedRecords({
    roles: ["subject", "current", "proposed"],
    forward: fieldRecords,
    reverse: (scope) => [primaryRecordMatch(scope), fieldReferenceMatch(scope)],
  }),
  actionable: sql`true`,
  summarize: (value: unknown) =>
    `Set field to ${JSON.stringify(suggestionJudgments.field.parse(value).value)}`,
  subject: suggestionSubjects.field,
  target: suggestionProjectionTargets.field,
  transactionBound: true,
  actions: ["correct", "wrong", "uncertain", "dismissed"],
  apply: async (db, context, state, input, automatic) => {
    // The automatic mode keeps acceptSuggestion's requiresSuggestionReview refusal.
    if (input.verdict === "correct" && !input.correction.present)
      await acceptSuggestion(
        db,
        context,
        { id: state.id },
        automatic
          ? { mode: "automatic", confidence: state.confidence }
          : undefined,
      );
    else if (input.correction.present)
      await applyFieldCorrection(db, context, {
        id: state.id,
        correctValue: input.correction.value,
      });
    else
      throw new Error(
        "Applying field Feedback requires acceptance or a correction",
      );
  },
};
