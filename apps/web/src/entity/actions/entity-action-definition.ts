import type { Entity } from "@cubby/schemas/entity";

import type { ActionSurface } from "./action-items";
import type { ActionVerbId } from "./action-verbs";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
} from "./entity-actions";

export type EntityActionSurface =
  | "row"
  | "selection"
  | "inspector"
  | "detail"
  | ActionSurface;

export type EntityActionArity = "single" | "multi" | "both";
export type EntityActionGroup =
  | "primary"
  | "organize"
  | "lifecycle"
  | "destructive";
export type EntityActionPlacement = "primary" | "secondary" | "overflow";

const entityActionDefinitionBrand: unique symbol = Symbol(
  "EntityActionDefinition",
);

/**
 * The registry's deliberately erased shape. `use` receives `never` because a
 * heterogeneous list cannot safely expose one entity parameter; the catalog
 * builder preserves that correlation until the checked dispatcher below.
 */
export interface EntityActionDefinition {
  readonly [entityActionDefinitionBrand]: true;
  id?: string;
  verb: ActionVerbId;
  entities: readonly Entity[];
  arity: EntityActionArity;
  minSelection?: number;
  maxSelection?: number;
  surfaces?: readonly EntityActionSurface[];
  group?: EntityActionGroup;
  priority?: number;
  placement?: Partial<Record<EntityActionSurface, EntityActionPlacement>>;
  availability?: (
    context: EntityActionResolutionContext,
  ) => ReturnType<NonNullable<EntityActionHandles["availability"]>>;
  preserveSelection?: boolean;
  use: (entity: never) => EntityActionHandles;
}

type EntityActionDefinitionInput<
  TEntities extends readonly Entity[],
  TUse extends (...args: never[]) => EntityActionHandles,
> = Omit<
  EntityActionDefinition,
  "entities" | "use" | typeof entityActionDefinitionBrand
> & {
  entities: TEntities;
  use: TUse;
};

type TypedEntityActionDefinition<
  TEntities extends readonly Entity[],
  TUse extends (...args: never[]) => EntityActionHandles,
> = EntityActionDefinitionInput<TEntities, TUse> & {
  readonly [entityActionDefinitionBrand]: true;
};

/**
 * Preserve the literal entity roster through action construction. This makes a
 * tracker hook accept only its declared entities while keeping one honest
 * heterogeneous registry at the rendering boundary.
 */
export function defineEntityAction<
  const TEntities extends readonly Entity[],
  TUse extends () => EntityActionHandles,
>(
  definition: EntityActionDefinitionInput<TEntities, TUse>,
): TypedEntityActionDefinition<TEntities, TUse>;
export function defineEntityAction<
  const TEntities extends readonly Entity[],
  TUse extends (entity: TEntities[number]) => EntityActionHandles,
>(
  definition: EntityActionDefinitionInput<TEntities, TUse>,
): TypedEntityActionDefinition<TEntities, TUse>;
export function defineEntityAction(
  definition: Omit<
    EntityActionDefinition,
    "use" | typeof entityActionDefinitionBrand
  > & {
    use: (...args: never[]) => EntityActionHandles;
  },
): EntityActionDefinition {
  return { ...definition, [entityActionDefinitionBrand]: true };
}
