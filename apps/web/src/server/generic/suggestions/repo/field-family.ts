import { HIGH_CONFIDENCE_PROBABILITY } from "@cubby/schemas/ai-evaluation";
import { suggestApplyPolicy } from "@cubby/schemas/field-suggestion-policy";
import { suggestionJudgments } from "@cubby/schemas/suggestion";
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
  cleanAcceptance,
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
    const { filters } = query;
    const rows = await fieldSuggestionKeys(db, {
      status: filters.status,
      runId: query.filters.runId,
      suggestionIds: query.suggestionIds,
    });
    // Rows an Automatic rule will apply, and (by default) plain guesses, are
    // dropped before paging so totals count exactly what a page can return.
    const listed = rows.filter(
      (row) => filters.status !== "pending" || row.automaticRule === null,
    );
    return listed.flatMap((row) => {
      const entity = shortcodeEntity.parse(row.entity);
      const kind = fieldKind.parse(row.kind);
      const strength = fieldStrength(row.confidence);
      const confident = row.confidence >= HIGH_CONFIDENCE_PROBABILITY;
      // What needs a person: Cubby disagreeing with a person's value, or a
      // confident answer for a field only a member applies. Every other
      // pending answer is a guess the field's picker offers.
      const disposition =
        kind === "correction" && confident && !row.answered
          ? "disagreement"
          : confident && suggestApplyPolicy(entity, row.field) === "review"
            ? "needs_you"
            : "guess";
      const key = {
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
          disposition,
        },
      };
      if (
        filters.status === "pending" &&
        filters.disposition === undefined &&
        disposition === "guess"
      )
        return [];
      return [key];
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
  acceptAsIs: cleanAcceptance,
  ...suggestionReviewFamilies.field,
  ...declareAffectedRecords({
    roles: ["subject", "current", "proposed"],
    forward: fieldRecords,
    reverse: (scope) => [primaryRecordMatch(scope), fieldReferenceMatch(scope)],
  }),
  actionable: sql`true`,
  summarize: (value: unknown) =>
    `Set field to ${JSON.stringify(suggestionJudgments.field.parse(value).value)}`,
  apply: async (db, context, state, input, automatic) => {
    // The automatic mode keeps acceptSuggestion's apply-policy refusal.
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
