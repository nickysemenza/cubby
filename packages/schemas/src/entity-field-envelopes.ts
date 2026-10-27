import type { z } from "zod";

import type { Entity } from "./entity-core";
import { entityFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.gen";

export { entityFieldEnvelopeSchemas };
export { entityFieldEnvelopeFields } from "./generated/entity-field-envelopes.gen";
export { entityFieldEnvelopeNested } from "./generated/entity-field-envelope-nested.gen";

export type FieldEnvelopeEntity = keyof typeof entityFieldEnvelopeSchemas;
export type FieldEnvelopeProjection =
  | "output"
  | "list"
  | "detail"
  | "mcpOutput"
  | "mcpList"
  | "mcpDetail";

export type EntityFieldEnvelopeRead<
  E extends FieldEnvelopeEntity,
  P extends FieldEnvelopeProjection,
> = z.output<(typeof entityFieldEnvelopeSchemas)[E][P]>;

export function hasFieldEnvelopeRead(
  entity: Entity,
): entity is FieldEnvelopeEntity {
  return Object.hasOwn(entityFieldEnvelopeSchemas, entity);
}

export function fieldEnvelopeReadSchema<
  E extends FieldEnvelopeEntity,
  P extends FieldEnvelopeProjection,
>(entity: E, projection: P): z.ZodType<EntityFieldEnvelopeRead<E, P>>;
export function fieldEnvelopeReadSchema(
  entity: FieldEnvelopeEntity,
  projection: FieldEnvelopeProjection,
): z.ZodType {
  return entityFieldEnvelopeSchemas[entity][projection];
}
