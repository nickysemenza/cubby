import type { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import type { ExpenseCreateInput } from "@cubby/schemas/project";

import type { EntityEditValidationInputs } from "~/entity/generated/entity-edit-validation-types.gen";

import type { EntityMutationOutputByEntity } from "../generated/entity-mutation-results.gen";

type GeneratedIntents = typeof generatedEntityEditIntents;
/** Intent names per operation, from the entity declarations. */
type EntityEditIntentCatalog = {
  [E in keyof GeneratedIntents]: {
    create: GeneratedIntents[E]["create"][number];
    update: GeneratedIntents[E]["update"][number];
    delete: "delete";
  };
};

/** The canonical server parser and browser command types share these generated contracts. */
type EntityEditCreateInputMap = {
  [E in TypedEditableEntity]: EntityEditValidationInputs[E]["create"];
};
type EntityEditUpdateInputMap = {
  [E in TypedEditableEntity]: EntityEditValidationInputs[E]["update"];
};

/** Editor-only draft fields with no counterpart in the entity's schemas. */
type EntityEditDraftExtras = {
  expense: { lineKind?: ExpenseCreateInput["lineKind"] | "auto" };
};

/** Draft keys and values exposed to RHF callers. Intents select subsets at
 * runtime; callers can no longer invent field names or incompatible values. */
type EntityEditDraftMap = {
  [E in TypedEditableEntity]: Partial<
    ([EntityEditCreateInputMap[E]] extends [never]
      ? unknown
      : EntityEditCreateInputMap[E]) &
      ([EntityEditUpdateInputMap[E]] extends [never]
        ? unknown
        : EntityEditUpdateInputMap[E])
  > &
    (E extends keyof EntityEditDraftExtras
      ? EntityEditDraftExtras[E]
      : unknown);
};

type EntityEditSpecification<E extends keyof EntityEditIntentCatalog> = {
  record: { id: string } & EntityEditDraftMap[E];
  draft: EntityEditDraftMap[E];
  createInput: EntityEditCreateInputMap[E];
  updateInput: EntityEditUpdateInputMap[E];
  result: EntityMutationOutputByEntity[E];
  intents: EntityEditIntentCatalog[E];
};

export type TypedEditableEntity = keyof EntityEditIntentCatalog;
export type TypedEntityEditOperation<E extends TypedEditableEntity> = Extract<
  keyof EntityEditSpecification<E>["intents"],
  "create" | "update" | "delete"
>;
export type EntityEditIntent<
  E extends TypedEditableEntity,
  O extends "create" | "update" | "delete",
> = E extends TypedEditableEntity
  ? O extends keyof EntityEditSpecification<E>["intents"]
    ? EntityEditSpecification<E>["intents"][O]
    : never
  : never;
export type EntityEditDraft<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["draft"];
export type EntityEditCreateInput<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["createInput"];
export type EntityEditUpdateInput<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["updateInput"];
export type EntityEditRecordFor<E extends TypedEditableEntity> = {
  [
    K in keyof EntityEditSpecification<E>["record"]
  ]: EntityEditSpecification<E>["record"][K];
};
/** Canonical scalar receipt returned by this entity's generated mutation schema. */
export type EntityEditResultFor<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["result"];
