import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";

import type {
  EntityBrowserMutationCommand,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

import type {
  EntityMutationData,
  EntityMutationVariables,
  StandardAction,
  StandardEntity,
} from "../entity-contracts";
import type {
  EntityEditDraft,
  EntityEditCreateInput,
  EntityEditRecordFor,
  EntityEditResultFor,
  EntityEditUpdateInput,
  TypedEditableEntity,
  EntityEditIntent as TypedEntityEditIntent,
  TypedEntityEditOperation,
} from "./intent-types";
import type { EntityEditValue, EntityEditValueBag } from "./value-schema";

/**
 * Entities with the standard create/update router contract. The editing
 * registry is deliberately narrower than `Entity`: images, cookbooks,
 * external USDA foods, and read-only purchase-agent import runs have
 * different lifecycles and must opt in explicitly if they ever gain this
 * editing surface.
 */
export type EditableEntity = Exclude<
  Entity,
  "image" | "usda-food" | "cookbook" | "importRun"
>;

type _EditableEntityMatchesTypedCatalog =
  EditableEntity extends TypedEditableEntity
    ? TypedEditableEntity extends EditableEntity
      ? true
      : never
    : never;
const _editableEntityCatalogIsExhaustive: _EditableEntityMatchesTypedCatalog = true;
void _editableEntityCatalogIsExhaustive;

/** The transport-level operation executed against the entity router. */
export type EntityEditOperation = "create" | "update" | "delete";

/**
 * Commands also carry the bulk forms, which act on `ids` rather than one
 * record and so have no semantic intent definition of their own.
 */
type EntityEditCommandOperation = EntityEditOperation;

/**
 * A semantic editing capability such as `full`, `capture`, `schedule`, or
 * `planned`. It selects defaults, fields, and command construction *within* an
 * operation; it is not the operation itself.
 */
type RuntimeEntityEditIntent = string;

/** Where an entity edit is being presented, not a permission level. */
type EntityEditSurface =
  | "detail"
  | "create-page"
  | "dialog"
  | "quick-create"
  | "cell"
  | "preview"
  | "calendar";

export type EntityEditAccess =
  | { mode: "editable" }
  | { mode: "read-only"; reason: string }
  | { mode: "unavailable"; reason: string };

export interface EntityEditIssue {
  /** Field fragment id when an error belongs beside one control. */
  field?: string;
  message: string;
  source: "client" | "server";
}

/** Concrete runtime values accepted by semantic editor fields. */
export type { EntityEditValue, EntityEditValueBag } from "./value-schema";
export type EntityEditDraftData<E extends EditableEntity> = Readonly<
  Partial<EntityEditDraft<E>>
>;
/** Internal normalized values or an owner-typed draft entering the kernel. */
export type EntityEditValueSource<E extends EditableEntity> =
  | EntityEditDraftData<E>
  | Readonly<EntityEditValueBag>;
export type EntityEditMutationData<
  E extends EditableEntity,
  O extends "create" | "update",
> = O extends "create" ? EntityEditCreateInput<E> : EntityEditUpdateInput<E>;
/**
 * The minimum identity every update adapter needs. The rest is the entity's
 * own read projection, which may carry shapes the value bag never accepts
 * (rows with nested `Date` audit stamps, relation objects) — a field reads
 * its own key through `projectEntityEditRecordValue` (`value-schema.ts`),
 * never by trusting the record to be bag-shaped.
 */
export interface EntityEditRecord {
  id: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the values are an entity's own already-parsed read projection; the kernel re-parses each key it reads (`projectEntityEditRecordValue`) rather than claiming a bag shape the record does not have.
  [field: string]: unknown;
}

/**
 * Context belongs to a caller's workflow: a calendar day, a project's quick
 * add button, or a picker. It deliberately does not become a persisted field.
 */
export interface EntityEditContext {
  disposition?: boolean;
  parentProjectId?: string | null;
}

interface EntityEditFieldInput<R extends EntityEditRecord> {
  operation: EntityEditOperation;
  intent: RuntimeEntityEditIntent;
  surface: EntityEditSurface;
  record?: R;
  context: EntityEditContext;
}

interface EntityEditFieldValidationInput<R extends EntityEditRecord, V> {
  value: V;
  /** Normalized values from every selected field. */
  values: Readonly<EntityEditValueBag>;
  record?: R;
  context: EntityEditContext;
}

/**
 * A semantic field owns one value's defaults, normalization, validation, and
 * patch contribution. It is intentionally data/callback-only: React renderers
 * are surface adapters, never registry entries.
 */
export interface EntityEditField<
  E extends EditableEntity,
  R extends EntityEditRecord,
  V,
  P extends object,
> {
  readonly entity: E;
  readonly id: string;
  access(input: EntityEditFieldInput<R>): EntityEditAccess;
  initial(input: EntityEditFieldInput<R>): V;
  normalize(value: V): V;
  validate(
    input: EntityEditFieldValidationInput<R, V>,
  ): readonly EntityEditIssue[];
  /**
   * Return undefined for an unchanged value, never an empty patch. Receives
   * the same operation/intent/surface as `initial` so a field can diff
   * against its own seeded baseline (a projected `initial` value) rather
   * than the raw record.
   */
  toPatch(input: EntityEditFieldInput<R> & { value: V }): P | undefined;
}

export type EntityEditCommand<
  E extends EditableEntity,
  O extends EntityEditCommandOperation = EntityEditCommandOperation,
> = O extends "create"
  ? {
      entity: E;
      operation: O;
      intent: RuntimeEntityEditIntent;
      data: EntityEditMutationData<E, "create">;
    }
  : O extends "update"
    ? {
        entity: E;
        operation: O;
        intent: RuntimeEntityEditIntent;
        id: string;
        data: EntityEditMutationData<E, "update">;
      }
    : {
        entity: E;
        operation: "delete";
        intent: RuntimeEntityEditIntent;
        /** Delete operations are atomic across this complete set. */
        ids: readonly string[];
      };

export type EntityEditCommandInput<
  E extends EditableEntity,
  O extends EntityEditOperation = EntityEditOperation,
> =
  EntityEditCommand<E, O> extends infer Command
    ? Command extends EntityEditCommand<E>
      ? Omit<Command, "entity">
      : never
    : never;

export type EntityEditBuildResult<
  E extends EditableEntity,
  O extends EntityEditOperation = EntityEditOperation,
> =
  | { ok: true; command: EntityEditCommand<E, O>; changed: boolean }
  | { ok: false; issues: readonly EntityEditIssue[] };

export interface EntityEditIntentDefinition<
  E extends EditableEntity,
  R extends EntityEditRecord,
> {
  /** Semantic capabilities choose their fields; surfaces only frame them. */
  fields: readonly string[];
  /** Applied after field defaults and before caller seed/contextual presets. */
  defaults?:
    | Readonly<EntityEditValueBag>
    | ((context: EntityEditContext) => Readonly<EntityEditValueBag>);
  access(input: {
    surface: EntityEditSurface;
    record?: R;
    context: EntityEditContext;
  }): EntityEditAccess;
  /** Validate rules that belong to the complete semantic capability, rather
   * than to a field everywhere it appears (for example Calendar-only dates). */
  validate?(input: {
    values: Readonly<EntityEditValueBag>;
    record?: R;
    context: EntityEditContext;
    surface: EntityEditSurface;
  }): readonly EntityEditIssue[];
  build(input: {
    record?: R;
    patch: EntityEditValueBag;
    context: EntityEditContext;
  }): EntityEditBuildResult<E>;
}

/** Intent variants available for one router operation. */
export interface EntityEditOperationDefinition<
  E extends EditableEntity,
  R extends EntityEditRecord,
> {
  /** Used when a caller or surface recipe does not select a semantic intent. */
  defaultIntent: RuntimeEntityEditIntent;
  intents: Readonly<
    Record<RuntimeEntityEditIntent, EntityEditIntentDefinition<E, R>>
  >;
}

export interface EntityEditDefinition<
  E extends EditableEntity,
  R extends EntityEditRecord = EntityEditRecord,
> {
  readonly entity: E;
  readonly fields: readonly EntityEditField<
    E,
    R,
    EntityEditValue,
    EntityEditValueBag
  >[];
  readonly operations: Partial<{
    [O in EntityEditOperation]: EntityEditOperationDefinition<E, R>;
  }>;
}

/**
 * The runtime side-effect seam. Production adapts Start + React Query here;
 * tests inject the in-memory fake without rendering a hook.
 */
export interface EntityMutationPort {
  execute<E extends EditableEntity>(
    command: EntityEditCommand<E>,
  ): Promise<EntityMutationExecution<E>>;
  executeBulk<E extends EditableEntity>(
    command: EntityBulkUpdateCommand<E>,
  ): Promise<EntityBulkUpdateResult>;
}

export interface EntityEditRequest<
  E extends EditableEntity,
  O extends EntityEditOperation = TypedEntityEditOperation<E>,
  I extends TypedEntityEditIntent<E, O> = TypedEntityEditIntent<E, O>,
  R extends { id: string } = EntityEditRecordFor<E>,
> {
  entity: E;
  operation: O;
  /** Omit to use the operation's configured default intent. */
  intent?: I;
  surface: EntityEditSurface;
  record?: R;
  context?: EntityEditContext;
  /** Explicit initial field values, merged over every operation's own defaults whenever the caller supplies one. */
  seed?: Readonly<Partial<EntityEditDraft<E>>>;
}

/** Runtime-correlated request after a generic UI boundary has selected an entity. */
export interface RuntimeEntityEditRequest<E extends EditableEntity> {
  entity: E;
  operation: EntityEditOperation;
  intent?: string;
  surface: EntityEditSurface;
  record?: EntityEditRecord;
  context?: EntityEditContext;
  seed?: Readonly<EntityEditValueBag>;
}

export type EntityEditResult<E extends EditableEntity> =
  | {
      ok: true;
      entity: E;
      id: string;
      changed: boolean;
      /** Schema-derived entity result consumed by success callbacks. */
      result?: EntityEditResultFor<E> & {
        sideEffects: MutationSideEffects;
      };
    }
  | { ok: false; issues: readonly EntityEditIssue[] };

/**
 * A bulk patch reports a count over N rows, so it has no single entity output
 * to recover through the entity's own schema. It gets its own outcome rather
 * than widening {@link EntityEditResult}: every other consumer of that type
 * reads an entity-shaped `result`.
 */
export type EntityMutationExecution<E extends EditableEntity> =
  | {
      operation: "create" | "update";
      id: string;
      result: EntityEditResultFor<E> & {
        sideEffects: MutationSideEffects;
      };
    }
  | {
      operation: "delete";
      result: Extract<EntityBrowserMutationResult, { action: "delete" }>;
    };

export interface EntityBulkUpdateCommand<E extends EditableEntity> {
  entity: E;
  operation: "bulkUpdate";
  intent: RuntimeEntityEditIntent;
  ids: readonly string[];
  data: Extract<
    EntityBrowserMutationCommand,
    { action: "bulkUpdate"; entity: E }
  >["data"];
}

type EntityBulkUpdateResult = Extract<
  EntityBrowserMutationResult,
  { action: "bulkUpdate" }
>;

export type EntityBulkUpdateOutcome =
  | {
      ok: true;
      entity: EditableEntity;
      result: EntityBulkUpdateResult;
    }
  | { ok: false; issues: readonly EntityEditIssue[] };

export type EntityActionVariables<
  E extends StandardEntity,
  A extends StandardAction,
> = EntityMutationVariables<E, A>;
export type EntityActionData<
  E extends StandardEntity,
  A extends StandardAction,
> = EntityMutationData<E, A>;
