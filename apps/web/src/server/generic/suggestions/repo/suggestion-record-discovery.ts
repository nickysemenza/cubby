import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import {
  mailDecisionFamily,
  type SuggestionFamily,
  type MailDecisionFamily,
} from "@cubby/schemas/suggestion";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { suggestionTable } from "~/server/db/schema";
import type { SuggestionRecordScope } from "~/server/generic/suggestions/repo/suggestion-touching";

export const reviewSuggestion = alias(suggestionTable, "s");

const referenceEntity = z.enum(shortcodeEntities);

export const entities = referenceEntity.enum;

export const ref = (entity: SQL, id: SQL) =>
  sql`jsonb_build_object('entity', (${entity})::text, 'id', (${id})::text)`;

const primary = ref(sql`s.entity`, sql`s."recordId"::text`);

export const one = sql`jsonb_build_array(${primary})`;

export const reviewQueryBuilder = new QueryBuilder();

export const leg = (end: "outflow" | "inflow") => sql`jsonb_build_array(
  ${ref(sql`${entities.financialAccount}`, sql`s.judgment->${end}->>'accountId'`)},
  ${ref(sql`${entities.financialTransaction}`, sql`s.judgment->${end}->>'transactionId'`)},
  ${ref(sql`${entities.ledgerParty}`, sql`s.judgment->${end}->'owner'->>'id'`)})`;

/**
 * Families reviewed as Suggestions. Problems findings, grading rosters and mail
 * decisions have their own owners.
 */
export type ReviewFamily = Exclude<
  keyof typeof suggestionReviewFamilies,
  MailDecisionFamily
>;

export const isReviewFamily = (
  family: SuggestionFamily,
): family is ReviewFamily =>
  Object.hasOwn(suggestionReviewFamilies, family) &&
  !mailDecisionFamily.safeParse(family).success;

export type JsonPath = {
  column:
    | "data"
    | "evidence"
    | "judgment"
    | "subject"
    | "suggestedValue"
    | "currentValue";
  path?: readonly string[];
};
type ReferenceGuard = {
  entity?: string;
  field?: string;
  scope?: string;
  negate?: boolean;
};
export type Reference = { subject?: boolean } & (
  | { kind: "primary"; guard?: ReferenceGuard }
  | {
      kind: "value";
      at: JsonPath;
      entity: string | JsonPath;
      resolve?: boolean;
      guard?: ReferenceGuard;
    }
  | {
      kind: "elements";
      at: JsonPath;
      entity: string | JsonPath;
      idPath?: readonly string[];
      scalar?: boolean;
      resolve?: boolean;
      guard?: ReferenceGuard;
    }
  | { kind: "contains"; at: JsonPath; guard?: ReferenceGuard }
);

export type AffectedRecordsSpec = {
  roles: readonly string[];
  forward: (requested?: readonly string[]) => SQL;
  references: readonly Reference[];
  graph?: (
    db: Database,
    scope: SuggestionRecordScope,
    admission: (alias?: string) => SQL | undefined,
  ) => { matches: readonly (SQL | undefined)[]; query?: SQL };
};

/** Families declare stored reference paths and forward presentation separately. */
export function declareAffectedRecords<const S extends AffectedRecordsSpec>(
  spec: S,
) {
  return { affectedRecords: spec };
}
