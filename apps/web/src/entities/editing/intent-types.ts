import type { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import type { ExpenseCreateInput } from "@cubby/schemas/project";
import type { z } from "zod";

import type { EntitySchemaBindingMap } from "~/server/generated/entity-bindings.gen";

import type { EntityMutationOutputByEntity } from "../generated/entity-mutation-results.gen";

type FinancialAccountEditorFields = {
  kind: "credit_card" | "bank_account" | "stored_value" | "cash" | "other";
  issuer: string;
  network: "" | "visa" | "mastercard" | "amex" | "discover" | "other";
  institution: string;
  accountType: "checking" | "savings" | "money_market" | "other";
  provider: string;
  last4: string;
};

type GeneratedIntents = typeof generatedEntityEditIntents;
/** Intent names per operation, from the entity declarations. */
type EntityEditIntentCatalog = {
  [E in keyof GeneratedIntents]: {
    create: GeneratedIntents[E]["create"][number];
    update: GeneratedIntents[E]["update"][number];
    delete: "delete";
  };
};

type SchemaOutput<S> = S extends z.ZodType ? z.infer<S> : never;

/**
 * Create/update input types per editable entity, read off the generated
 * schema bindings — the same `createInput`/`updateInput` schemas
 * `mutation-data.ts` parses with at runtime, so the editor's types and its
 * validation cannot disagree. Type-only: nothing from `~/server` is loaded.
 */
type EntityEditCreateInputMap = {
  [E in TypedEditableEntity]: SchemaOutput<
    EntitySchemaBindingMap[E]["createInput"]
  >;
};

type EntityEditUpdateInputMap = {
  [E in TypedEditableEntity]: SchemaOutput<
    EntitySchemaBindingMap[E]["updateInput"]
  >;
};

/** Editor-only draft fields with no counterpart in the entity's schemas. */
type EntityEditDraftExtras = {
  expense: { lineKind?: ExpenseCreateInput["lineKind"] | "auto" };
  financialAccount: Partial<FinancialAccountEditorFields>;
};

/** Draft keys and values exposed to RHF callers. Intents select subsets at
 * runtime; callers can no longer invent field names or incompatible values. */
type EntityEditDraftMap = {
  [E in TypedEditableEntity]: Partial<
    EntityEditCreateInputMap[E] & EntityEditUpdateInputMap[E]
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
/** Exact public output returned by this entity's generated mutation schema. */
export type EntityEditResultFor<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["result"];
