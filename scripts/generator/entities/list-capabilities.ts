import type { CompiledEntity } from "./declarations.ts";

/** A routed list page may use either a generated or a hand-written index. */
export const hasBrowserListPage = (entity: CompiledEntity): boolean =>
  entity.route !== null && entity.descriptor.browserRoutes !== false;

/** The generated entity-list operation consumed by inline relation tables. */
export const hasGenericListOperation = (entity: CompiledEntity): boolean =>
  hasBrowserListPage(entity) &&
  entity.contract !== null &&
  entity.contract.create !== null &&
  entity.contract.update !== null;
