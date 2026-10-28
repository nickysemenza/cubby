import type { Entity } from "./entity-core";
import type { generatedEntityListFields } from "./generated/entity-list-fields.gen";
type DerivedOf<E extends Entity> =
  (typeof generatedEntityListFields)[E]["derived"];
export type GeneratedDerivedValueKey<E extends Entity> = {
  [K in keyof DerivedOf<E>]: DerivedOf<E>[K] extends
    | { shape: "value"; rollup: object }
    | { shape: "value"; fromResult: object }
    ? never
    : DerivedOf<E>[K] extends { shape: "value" }
      ? K
      : never;
}[keyof DerivedOf<E>] &
  string;
export type GeneratedRepositoryRowSetKey<E extends Entity> = {
  [
    K in keyof (typeof generatedEntityListFields)[E]["rows"]
  ]: (typeof generatedEntityListFields)[E]["rows"][K] extends {
    storage: { kind: "repository" };
  }
    ? K
    : never;
}[keyof (typeof generatedEntityListFields)[E]["rows"]] &
  string;
export type GeneratedListScopeKey<E extends Entity> =
  keyof (typeof generatedEntityListFields)[E]["scopes"] & string;
export type GeneratedListScopeTarget<
  E extends Entity,
  K extends GeneratedListScopeKey<E>,
> = (typeof generatedEntityListFields)[E]["scopes"][K] extends {
  readonly filters: infer T extends Entity;
}
  ? T
  : never;
export type GeneratedDerivedPredicateKey<E extends Entity> = {
  [K in keyof DerivedOf<E>]: DerivedOf<E>[K] extends { shape: "predicate" }
    ? K
    : never;
}[keyof DerivedOf<E>] &
  string;
