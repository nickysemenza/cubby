import type { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import { z } from "zod";
export type EntityDetailByEntity = {
  [E in DetailEntity]: z.output<
    (typeof entityFieldEnvelopeSchemas)[E]["detail"]
  >;
};
import { detailEntities } from "../generated/entity-read-keys.gen";
export type DetailEntity = (typeof detailEntities)[number];
const detailVariant = (entity: DetailEntity) =>
  z.object({ entity: z.literal(entity), shortcode: shortcodeSchema(entity) });
const [firstDetailEntity, ...otherDetailEntities] = detailEntities;
const rawEntityDetailInputSchema = z.discriminatedUnion("entity", [
  detailVariant(firstDetailEntity),
  ...otherDetailEntities.map(detailVariant),
]);
export type EntityDetailInputByEntity = {
  [E in DetailEntity]: Omit<
    z.input<typeof rawEntityDetailInputSchema>,
    "entity"
  > & { entity: E };
};
export type ParsedEntityDetailInputByEntity = {
  [E in DetailEntity]: Omit<
    z.output<typeof rawEntityDetailInputSchema>,
    "entity"
  > & { entity: E };
};
export function entityDetailInputFor<E extends DetailEntity>(
  entity: E,
  shortcode: EntityDetailInputByEntity[E]["shortcode"],
): EntityDetailInputByEntity[E];
export function entityDetailInputFor(entity: DetailEntity, shortcode: string) {
  return { entity, shortcode };
}
export function parseEntityDetailInput<E extends DetailEntity>(
  entity: E,
  value: EntityDetailInputByEntity[E],
): ParsedEntityDetailInputByEntity[E];
export function parseEntityDetailInput(
  entity: DetailEntity,
  value: EntityDetailInputByEntity[DetailEntity],
) {
  const parsed = entityDetailInputSchema.parse(value);
  if (parsed.entity !== entity)
    throw new Error("Entity detail input discriminator mismatch");
  return parsed;
}

// SAFETY: the discriminator and its shortcode validation are built together
// from each tuple member; TypeScript's array map loses that correlation.
export const entityDetailInputSchema = rawEntityDetailInputSchema as z.ZodType<
  ParsedEntityDetailInputByEntity[DetailEntity],
  EntityDetailInputByEntity[DetailEntity]
>;
