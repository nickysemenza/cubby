import { z } from "zod";

import { type EntityFieldModel, entityFieldModels } from "./entity-fields";
import type { ShortcodeEntity } from "./entity-manifest";
import { basisValueOf, fieldSuggestionContextKeys } from "./field-suggestion";

/** Only declared per-field inputs enter identity; presentation metadata is not evidence. */
export function fieldSuggestionIdentityBasis(
  entity: ShortcodeEntity,
  field: string,
  raw: unknown,
) {
  const definition = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  );
  const policy = definition?.control?.suggest;
  const parsed = z.record(z.string(), z.json()).safeParse(raw);
  if (!policy || !parsed.success) return null;
  return Object.fromEntries(
    fieldSuggestionContextKeys(entity, [...policy.basis, field]).map((key) => [
      key,
      basisValueOf(parsed.data[key]),
    ]),
  );
}

/** Every automatic assignment path obeys the target's declared review policy. */
export function requiresSuggestionReview(
  entity: ShortcodeEntity,
  field: string,
): boolean {
  return Boolean(
    entityFieldModels[entity].fields.find((item) => item.key === field)?.control
      ?.suggest?.reviewRequired,
  );
}

type FieldModels = typeof entityFieldModels;

/** Every declared `control.suggest.financeReview`, read off the generated field models. */
type FinanceReviewDeclaration = {
  [E in keyof FieldModels]: FieldModels[E]["fields"][number] extends infer F
    ? F extends {
        key: infer K;
        control: { suggest: { financeReview: { context: infer C } } };
      }
      ? { entity: E; field: K; context: C }
      : never
    : never;
}[keyof FieldModels];
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
}[] = Object.entries(entityFieldModels).flatMap(([entity, model]) =>
  model.fields.flatMap((field: EntityFieldModel["fields"][number]) => {
    const review = field.control?.suggest?.financeReview;
    return review
      ? [{ entity, field: field.key, context: review.context }]
      : [];
  }),
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
