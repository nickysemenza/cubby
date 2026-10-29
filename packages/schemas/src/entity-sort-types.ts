import type { generatedEntitySort } from "./generated/entity-sort.gen";
export type GeneratedEntitySortField<
  E extends keyof typeof generatedEntitySort,
> = (typeof generatedEntitySort)[E]["fields"][number];
