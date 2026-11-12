import { z } from "zod";

import { generatedFieldSuggestionPolicies } from "./generated/entity-field-suggestion-policy.gen";
import type { ShortcodeEntity } from "./entity-manifest";

export type SuggestApplyPolicy = "auto" | "review" | "offer";

/** Who decides a confident proposal: Cubby (`auto`), the queue, or the picker. */
export function suggestApplyPolicy(
  entity: ShortcodeEntity,
  field: string,
): SuggestApplyPolicy {
  return (
    generatedFieldSuggestionPolicies.find(
      (policy) => policy.entity === entity && policy.field === field,
    )?.apply ?? "auto"
  );
}

/** Each field's declared `suggest.undecided` placeholder, keyed `entity.field`. */
const undecidedPlaceholders = new Map<string, string>(
  generatedFieldSuggestionPolicies.flatMap((policy) =>
    policy.undecided
      ? [[`${policy.entity}.${policy.field}`, policy.undecided] as const]
      : [],
  ),
);
const blankValue = z.union([z.null(), z.undefined(), z.literal("")]);

/**
 * Whether a stored value records no decision: blank, or the field's declared
 * `suggest.undecided` placeholder. Every open-field check reads this.
 */
export function undecidedFieldValue(
  entity: string,
  field: string,
  value: unknown,
): boolean {
  const placeholder = undecidedPlaceholders.get(`${entity}.${field}`);
  return (
    placeholder === undefined
      ? blankValue
      : z.union([blankValue, z.literal(placeholder)])
  ).safeParse(value).success;
}

/** Entities with at least one field Cubby may evaluate after a write. */
const automatedEntities = new Set<string>(
  generatedFieldSuggestionPolicies.flatMap((policy) =>
    policy.mode !== "prune" && policy.apply !== "review" ? [policy.entity] : [],
  ),
);

/** Whether a create or update of `entity` owes field automation a look. */
export const fieldAutomationWatches = (entity: string) =>
  automatedEntities.has(entity);

/** Every declared spending review, preserving its entity/field/context correlation. */
type FinanceReviewDeclaration =
  (typeof generatedFieldSuggestionPolicies)[number] extends infer Policy
    ? Policy extends {
        entity: infer E;
        field: infer K;
        financeContext: infer C extends string;
      }
      ? { entity: E; field: K; context: C }
      : never
    : never;
export type FinanceReviewContext = FinanceReviewDeclaration["context"];
export type FinanceReviewEntity<
  C extends FinanceReviewContext = FinanceReviewContext,
> = Extract<FinanceReviewDeclaration, { context: C }>["entity"];
export type FinanceReviewField<
  C extends FinanceReviewContext = FinanceReviewContext,
> = Extract<FinanceReviewDeclaration, { context: C }>["field"];

const declaredFinanceReviews: readonly {
  entity: string;
  field: string;
  context: FinanceReviewContext;
}[] = generatedFieldSuggestionPolicies.flatMap((policy) =>
  policy.financeContext
    ? [
        {
          entity: policy.entity,
          field: policy.field,
          context: policy.financeContext,
        },
      ]
    : [],
);

/** A saved-record spending review field's declared context, or null. */
export function financeReviewContext(
  entity: string,
  field: string,
): FinanceReviewContext | null {
  return (
    declaredFinanceReviews.find(
      (review) => review.entity === entity && review.field === field,
    )?.context ?? null
  );
}

/** Whether `entity` declares spending review fields in `context`. */
export function isFinanceReviewEntity<C extends FinanceReviewContext>(
  entity: string,
  context: C,
): entity is FinanceReviewEntity<C> {
  return declaredFinanceReviews.some(
    (review) => review.entity === entity && review.context === context,
  );
}

/**
 * These questions read a saved record beyond their basis: a declared spending
 * review's finance/vendor context, or a FinancialTransaction's source evidence.
 */
export function usesSavedFieldSuggestionContext(entity: string): boolean {
  return (
    entity === "financialTransaction" ||
    declaredFinanceReviews.some((review) => review.entity === entity)
  );
}

/** Declared review fields in `context`, across the entities that declare it. */
export function financeReviewFields<C extends FinanceReviewContext>(
  context: C,
): readonly FinanceReviewField<C>[] {
  // SAFETY: rows come from the same generated declarations the type reads.
  return [
    ...new Set(
      declaredFinanceReviews
        .filter((review) => review.context === context)
        .map((review) => review.field),
    ),
  ] as FinanceReviewField<C>[];
}
