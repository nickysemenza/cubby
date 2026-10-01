import {
  createFixtureWithContext,
  type CreatedEntity,
  type KernelContext,
} from "../scenarios/context";
import {
  type BuildOptions,
  buildEntity,
  type CreatableEntity,
  type EntityOverrides,
} from "./build";

/** Build, then create through the same entity-kernel path the browser uses. */
export function createEntity<E extends CreatableEntity>(
  context: KernelContext,
  entity: E,
  overrides: EntityOverrides<E> = {},
  opts: BuildOptions = {},
): Promise<CreatedEntity> {
  return createFixtureWithContext(
    context,
    entity,
    buildEntity(entity, overrides, opts),
  );
}
