import type { Entity } from "./entity-core";
import type {
  generatedEntityFieldModels,
  suggestFieldKeys,
} from "./generated/entity-field-model.gen";
type GeneratedEntityField<E extends Entity> =
  (typeof generatedEntityFieldModels)[E]["fields"][number];
type RendererValue<T> = T extends { renderer: infer R }
  ? Exclude<R, null>
  : never;
type ControlRendererIdFor<E extends Entity> = RendererValue<
  NonNullable<GeneratedEntityField<E>["control"]>
>;
type DisplayRendererIdFor<
  E extends Entity,
  K extends "list" | "detail",
> = GeneratedEntityField<E>["display"]["renderer"] extends infer R
  ? R extends Record<K, infer V>
    ? Exclude<V, null>
    : never
  : never;
export type ControlRendererId = {
  [E in Entity]: ControlRendererIdFor<E>;
}[Entity];
export type ListRendererId<E extends Entity> = DisplayRendererIdFor<E, "list">;
export type DetailRendererId<E extends Entity> = DisplayRendererIdFor<
  E,
  "detail"
>;
export type GeneratedSuggestFieldKey = (typeof suggestFieldKeys)[number];
