import { suggestionStatus } from "@cubby/schemas/ai";
import {
  suggestionSubjects,
  suggestionProjectionTargets,
} from "@cubby/schemas/suggestion";
import { imageDescriptionSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { hasTextSql } from "~/server/db/computed/text-whitespace";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { lockImageDescriptionSubject } from "~/server/domains/image/repo/image-correction-lock";
import { writeImageDescriptionConfirmation } from "~/server/domains/image/repo/image-description-confirmation";
import {
  actions,
  outcomes,
  storedKeys,
} from "~/server/generic/suggestions/repo/stored-suggestion-presentation";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { keyBase } from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  one,
  declareAffectedRecords,
  primaryRecordMatch,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import { readSuggestionRecordRefs } from "~/server/generic/suggestions/repo/suggestion-reference-resolution";

export const image_descriptionFamily: SuggestionFamilyDeclaration<"image_description"> =
  {
    family: "image_description",
    keys: (db, query) => storedKeys(db, query, "image_description"),
    rows: async (db, keys) => {
      if (!keys.length) return new Map();
      const { rows } = await unwrapDb(db).execute<{
        id: string;
        judgment: unknown;
      }>(sql`SELECT s.id, s.judgment FROM "Suggestion" s
      JOIN "Image" i ON i.id = s."recordId" AND ${notDeleted("i")}
      WHERE s.id IN (${sql.join(
        keys.map((key) => sql`${key.suggestionId}::uuid`),
        sql`, `,
      )}) AND s.active AND s.status = ${suggestionStatus.enum.pending}`);
      const refs = await readSuggestionRecordRefs(
        db,
        keys.map((key) => key.suggestionId),
      );
      const byId = new Map(keys.map((key) => [key.suggestionId, key]));
      return new Map(
        rows.flatMap((row) => {
          const key = byId.get(row.id),
            record = refs.get(row.id)?.[0];
          if (!key || !record) return [];
          const description = z.string().min(1).parse(row.judgment);
          return [
            [
              row.id,
              imageDescriptionSuggestionRow.parse({
                ...keyBase(key),
                family: "image_description",
                record,
                summary: [{ kind: "text", text: description }],
                actions: actions("accept", "correct", "reject", "dismiss"),
                review: {
                  correction: {
                    label: "Correct description",
                    value: description,
                  },
                },
                evidence: {
                  kind: "declared",
                  description,
                  facts: [],
                },
              }),
            ] as const,
          ];
        }),
      );
    },
    outcomes: outcomes("image_description"),
    acceptAsIs: () => null,
    ...suggestionReviewFamilies.image_description,
    ...declareAffectedRecords({
      roles: ["subject"],
      forward: () => one,
      reverse: (scope) => [primaryRecordMatch(scope)],
    }),
    actionable: sql`jsonb_typeof(s.judgment) = 'string' AND ${hasTextSql(sql`s.judgment #>> '{}'`)}`,
    subject: suggestionSubjects.image_description,
    target: suggestionProjectionTargets.image_description,
    transactionBound: true,
    isolationLevel: "serializable",
    lockForApply: async (db, prediction) => {
      await lockImageDescriptionSubject(
        db,
        suggestionSubjects.image_description.parse(prediction.subject),
      );
    },
    actions: ["correct", "wrong", "uncertain"],
    apply: async (db, context, state, input) => {
      const correction = input.correction.present
        ? input.correction
        : {
            present: true as const,
            value: z.json().parse(state.suggestedValue),
          };
      if (typeof correction.value !== "string")
        throw new Error("Confirmed image description must be text");
      await writeImageDescriptionConfirmation(db, state, correction.value, {
        kind: "member",
        effectId: crypto.randomUUID(),
        commandFeedbackId: context.reviewFeedbackId,
        actorUserId: context.actorContext.userId,
      });
    },
  };
