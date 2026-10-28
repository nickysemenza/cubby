import type { Entity } from "./entity-core";
import type { CompiledEntityPresentation } from "./entity-definitions/definition";
import type { entitySummary } from "./generated/entity-summary.gen";
export type EntityNames = { singular: string; plural: string | null };
export type EntitySummary = EntityNames &
  CompiledEntityPresentation & {
    primarySearch: { key: string; placeholder: string } | null;
    bulkUpdate: { fields: readonly string[] } | null;
    /** The kernel serves `merge`, so the generic merge verb applies. */
    merge: boolean;
  };
type GeneratedDetailSection<E extends Entity> =
  (typeof entitySummary)[E]["detail"]["sections"][number];
type GeneratedListView<E extends Entity> =
  (typeof entitySummary)[E]["list"]["views"][number];
export type DetailSlotId<E extends Entity> = Extract<
  GeneratedDetailSection<E>,
  { kind: "slot" }
>["id"];
export type ListSlotId<E extends Entity> = Extract<
  GeneratedListView<E>,
  { kind: "slot" }
>["id"];
