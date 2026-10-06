import type { CompiledEntity } from "./declarations.ts";

/**
 * The kernel serves `get` (and so the generic detail page) for every entity
 * with a contract and a repository; image's repository is bound specially.
 */
export const servesKernelGet = ({
  key,
  contract,
  ports,
}: Pick<CompiledEntity, "key" | "contract" | "ports">): boolean =>
  contract !== null && (ports.repository !== null || key === "image");

/** A routed list page may use either a generated or a hand-written index. */
export const hasBrowserListPage = (entity: CompiledEntity): boolean =>
  entity.route !== null && entity.descriptor.browserRoutes !== false;

/**
 * The generated entity-list operation over the kernel list read, consumed by
 * the generated index and inline relation tables. Every entity the browser
 * creates and edits has one; a read-only entity has one unless its route
 * declares its own rows (`route.listRows: "custom"`) or hand-writes its index.
 */
export const hasGenericListOperation = (entity: CompiledEntity): boolean =>
  hasBrowserListPage(entity) &&
  entity.contract !== null &&
  ((entity.contract.create !== null && entity.contract.update !== null) ||
    (entity.route?.list === true && entity.route.listRows === "kernel"));
