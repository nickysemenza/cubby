import type { z } from "zod";

import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import type {
  EntityEditCreateInput,
  EntityEditUpdateInput,
  TypedEditableEntity,
} from "./intent-types";

export type UnparsedEntityEditData = Parameters<z.ZodType["parse"]>[0];

export function parseEntityEditCreateInput<E extends TypedEditableEntity>(
  entity: E,
  value: UnparsedEntityEditData,
): EntityEditCreateInput<E>;
export function parseEntityEditCreateInput(
  entity: TypedEditableEntity,
  value: UnparsedEntityEditData,
): EntityEditCreateInput<TypedEditableEntity> {
  const schema = ENTITY_SCHEMA_BINDINGS[entity].createInput;
  if (!schema) throw new Error(`${entity} does not support create`);
  return schema.parse(value);
}

export function parseEntityEditUpdateInput<E extends TypedEditableEntity>(
  entity: E,
  value: UnparsedEntityEditData,
): EntityEditUpdateInput<E>;
export function parseEntityEditUpdateInput(
  entity: TypedEditableEntity,
  value: UnparsedEntityEditData,
): EntityEditUpdateInput<TypedEditableEntity> {
  const schema = ENTITY_SCHEMA_BINDINGS[entity].updateInput;
  if (!schema) throw new Error(`${entity} does not support update`);
  return schema.parse(value);
}

type SchemaOutput<S> = S extends {
  parse(value: UnparsedEntityEditData): infer Output;
}
  ? Output
  : never;
export type EntityEditBulkUpdateInput<E extends TypedEditableEntity> =
  SchemaOutput<(typeof ENTITY_SCHEMA_BINDINGS)[E]["bulkUpdateInput"]>;

export function parseEntityEditBulkUpdateInput<E extends TypedEditableEntity>(
  entity: E,
  value: UnparsedEntityEditData,
): EntityEditBulkUpdateInput<E>;
export function parseEntityEditBulkUpdateInput(
  entity: TypedEditableEntity,
  value: UnparsedEntityEditData,
): EntityEditBulkUpdateInput<TypedEditableEntity> {
  const schema = ENTITY_SCHEMA_BINDINGS[entity].bulkUpdateInput;
  if (!schema) throw new Error(`${entity} does not support bulk update`);
  return schema.parse(value);
}
