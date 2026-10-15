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
 * every client's list (web index, native browse, HTTP/MCP) and inline
 * relation tables: every routed entity with a contract has one, whether or
 * not the browser writes it or hand-writes its index.
 */
export const hasGenericListOperation = (entity: CompiledEntity): boolean =>
  hasBrowserListPage(entity) && entity.contract !== null;

/**
 * Only a generated index's columns make an inline relation table; a
 * hand-written index (image's gallery) keeps its rows to its own page.
 */
export const feedsRelationTables = (entity: CompiledEntity): boolean =>
  hasGenericListOperation(entity) && entity.route?.list === true;
