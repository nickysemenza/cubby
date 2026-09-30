import { AsyncLocalStorage } from "node:async_hooks";

import type { Entity } from "@cubby/schemas/entity";

import { withTrace } from "~/server/tracing";

import type { ListEnrichmentGroup, ListProjection } from "./list-projection";

interface ListReadTraceContext {
  entity?: Entity;
  projection?: ListProjection["kind"];
  rows?: number;
  corePhase?: "page" | "count";
}
const listReadContext = new AsyncLocalStorage<ListReadTraceContext>();

/** Request-local dimensions contain no row identities or filter values. */
export function withListReadTracing<T>(
  context: Omit<ListReadTraceContext, "corePhase">,
  run: () => Promise<T>,
): Promise<T> {
  return listReadContext.run(
    { ...listReadContext.getStore(), ...context },
    run,
  );
}
const dimensions = () => {
  const context = listReadContext.getStore();
  const attributes: Record<string, string | number> = {};
  if (context?.entity) attributes["entity.kind"] = context.entity;
  if (context?.projection) attributes["list.projection"] = context.projection;
  if (context?.rows !== undefined) attributes["list.rows"] = context.rows;
  return attributes;
};

export async function traceListPage<T>(run: () => Promise<T[]>): Promise<T[]> {
  const context = listReadContext.getStore();
  if (context?.corePhase === "page") return run();
  return listReadContext.run({ ...context, corePhase: "page" }, () =>
    withTrace(
      "entity.list.core.page",
      async (span) => {
        const rows = await run();
        span.setAttributes({ "list.rows": rows.length });
        return rows;
      },
      dimensions(),
    ),
  );
}
export async function traceListCount(
  run: () => Promise<number>,
  table?: string,
): Promise<number> {
  const context = listReadContext.getStore();
  if (context?.corePhase === "count") return run();
  const attributes = dimensions();
  if (table) attributes["db.table"] = table;
  return listReadContext.run({ ...context, corePhase: "count" }, () =>
    withTrace(
      "entity.list.core.count",
      async (span) => {
        const count = await run();
        span.setAttributes({ "list.count": count });
        return count;
      },
      attributes,
    ),
  );
}
export function traceListGroup<T>(
  groups: ListEnrichmentGroup | readonly ListEnrichmentGroup[],
  run: () => Promise<T>,
): Promise<T> {
  return withTrace("entity.list.enrichment.group", run, {
    ...dimensions(),
    "list.groups": [groups].flat().join(","),
  });
}
