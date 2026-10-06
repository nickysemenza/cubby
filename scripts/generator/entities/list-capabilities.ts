import type { CompiledEntity } from "./declarations.ts";

/** A routed list page may use either a generated or a hand-written index. */
export const hasBrowserListPage = (entity: CompiledEntity): boolean =>
  entity.route !== null && entity.descriptor.browserRoutes !== false;

/**
 * The generated entity-list operation over the kernel list read, consumed by
 * the generated index and inline relation tables. Every entity the browser
 * creates and edits has one; a read-only entity has one unless its route
 * names its own row source (`route.listColumns`) or hand-writes its index.
 */
export const hasGenericListOperation = (entity: CompiledEntity): boolean =>
  hasBrowserListPage(entity) &&
  entity.contract !== null &&
  ((entity.contract.create !== null && entity.contract.update !== null) ||
    (entity.route?.list === true && entity.route.listColumns === undefined));
