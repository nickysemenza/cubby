import { entityMutationItem } from "@cubby/schemas/entity-mutation";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { entityMutationOutputEntities } from "../generated/entity-read-keys.gen";
export type EntityMutationOutputEntity =
  (typeof entityMutationOutputEntities)[number];

export type EntityMutationOutputByEntity = {
  [E in EntityMutationOutputEntity]: z.output<typeof entityMutationItem>;
};

type UnparsedMutationOutput = Parameters<z.ZodType["parse"]>[0];
export function parseEntityMutationOutput<E extends EntityMutationOutputEntity>(
  entity: E,
  value: UnparsedMutationOutput,
): EntityMutationOutputByEntity[E] {
  const item = entityMutationItem.parse(value);
  shortcodeSchema(entity).parse(item.id);
  return item;
}
