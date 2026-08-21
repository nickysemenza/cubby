import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import type {
  EntityEditDraft,
  EntityEditRecordFor,
  EntityEditResultFor,
  TypedEditableEntity,
  EntityEditIntent as TypedEntityEditIntent,
  TypedEntityEditOperation,
} from "./intent-types";

/**
 * Entities with the standard create/update router contract. The editing
 * registry is deliberately narrower than `Entity`: images, cookbooks, and
 * external USDA foods have different lifecycles and must opt in explicitly if
 * they ever gain this editing surface.
 */
export type EditableEntity = Exclude<
  Entity,
  "image" | "usda-food" | "cookbook"
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

/** The minimum identity every update adapter needs. */
export interface EntityEditRecord {
  id: string;
}

/**
 * Context belongs to a caller's workflow: a calendar day, a project's quick
 * add button, or a picker. It deliberately does not become a persisted field.
 */
export type EntityEditContext = Readonly<Record<string, unknown>>;

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
  values: Readonly<Record<string, unknown>>;
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
  /** Return undefined for an unchanged value, never an empty patch. */
  toPatch(input: {
    value: V;
    record?: R;
    context: EntityEditContext;
  }): P | undefined;
}

export interface EntityEditCommand<E extends EditableEntity> {
  entity: E;
  operation: EntityEditOperation;
  intent: RuntimeEntityEditIntent;
  /** Present only for updates; server payload construction remains entity-owned. */
  id?: string;
  /** Delete operations are atomic across this complete set. */
  ids?: readonly string[];
  data: object;
}

export type EntityEditBuildResult<E extends EditableEntity> =
  | { ok: true; command: EntityEditCommand<E>; changed: boolean }
  | { ok: false; issues: readonly EntityEditIssue[] };

export interface EntityEditIntentDefinition<
  E extends EditableEntity,
  R extends EntityEditRecord,
> {
  /** Semantic capabilities choose their fields; surfaces only frame them. */
  fields: readonly string[];
  /** Create accepts seed by default; updates must opt in explicitly. */
  acceptsSeed?: boolean;
  /** Applied after field defaults and before caller seed/contextual presets. */
  defaults?:
    | Readonly<Record<string, unknown>>
    | ((context: EntityEditContext) => Readonly<Record<string, unknown>>);
  access(input: {
    surface: EntityEditSurface;
    record?: R;
    context: EntityEditContext;
  }): EntityEditAccess;
  /** Validate rules that belong to the complete semantic capability, rather
   * than to a field everywhere it appears (for example Calendar-only dates). */
  validate?(input: {
    values: Readonly<Record<string, unknown>>;
    record?: R;
    context: EntityEditContext;
    surface: EntityEditSurface;
  }): readonly EntityEditIssue[];
  build(input: {
    record?: R;
    patch: object;
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
  readonly fields: readonly EntityEditField<E, R, unknown, object>[];
  readonly operations: Partial<{
    [O in EntityEditOperation]: EntityEditOperationDefinition<E, R>;
  }>;
  readonly invalidationKeys: readonly QueryKey[];
}

/**
 * The runtime side-effect seam. Production adapts tRPC + React Query here;
 * tests inject the in-memory fake without rendering a hook.
 */
export interface EntityMutationPort {
  execute<E extends EditableEntity>(
    command: EntityEditCommand<E>,
  ): Promise<{ id: string; result: unknown }>;
  invalidate(keys: readonly QueryKey[]): Promise<void>;
  /** Re-invalidate after queued background work completes, when applicable. */
  watchBackgroundWork?(input: {
    result: unknown;
    invalidateKeys: readonly QueryKey[];
  }): void;
}

export interface EntityEditRequest<
  E extends EditableEntity,
  O extends EntityEditOperation = TypedEntityEditOperation<E>,
  I extends TypedEntityEditIntent<E, O> = TypedEntityEditIntent<E, O>,
  R extends EntityEditRecord = EntityEditRecordFor<E>,
> {
  entity: E;
  operation: O;
  /** Omit to use the operation's configured default intent. */
  intent?: I;
  surface: EntityEditSurface;
  record?: R;
  context?: EntityEditContext;
  /** Explicit initial field values. Creates accept them by default; updates opt in per intent. */
  seed?: Readonly<Partial<EntityEditDraft<E>>>;
}

export type EntityEditResult<E extends EditableEntity> =
  | {
      ok: true;
      entity: E;
      id: string;
      changed: boolean;
      /** Raw mutation result for compatibility adapters and success callbacks. */
      result?: EntityEditResultFor<E>;
    }
  | { ok: false; issues: readonly EntityEditIssue[] };
