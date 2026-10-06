import { buildPaginatedResponse } from "@cubby/schemas/pagination";
import { z } from "zod";

import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import { listReadRowSchema } from "~/entity/list-read-fields";
import { listReadFields, projectListRows } from "~/entity/list-read-schema";
import { withListEntityMedia } from "~/server/repo/entity-display-image";
import { withRecordEmoji } from "~/server/repo/entity-emoji";
import { expandListGroups } from "~/server/repo/list-projection";
import { withListReadTracing } from "~/server/repo/list-read-tracing";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import { withTrace } from "~/server/tracing";

import type {
  EntityBindingSchemas,
  EntityKernelCoreBinding,
  EntityKernelContext,
} from "./adapter";
import { parseGroupBy, parseSorts, parseSchema } from "./list-input";

type ListReadFailure = Parameters<typeof normalizeStartOperationError>[0];
const inputSchema = z.object({
  filters: z.record(z.string(), z.unknown()),
  pagination: z
    .object({ pageIndex: z.number(), pageSize: z.number() })
    .optional(),
  sort: z
    .array(
      z.object({ orderBy: z.string(), direction: z.enum(["asc", "desc"]) }),
    )
    .optional(),
  groupBy: z.string().optional(),
});

export function defineProgressiveListOperations<
  E extends ListEntity,
  S extends EntityBindingSchemas,
>(binding: EntityKernelCoreBinding<E, S>) {
  const filtersFor = (input: z.output<typeof inputSchema>["filters"]) => {
    const { ids, ...rest } = z
      .object({ ids: z.array(z.string()).max(500).optional() })
      .passthrough()
      .parse(input);
    for (const id of ids ?? []) binding.schemas.id.parse(id);
    return Object.assign(
      {},
      parseSchema<S["filters"], unknown>(binding.schemas.filters, rest),
      ids === undefined ? {} : { ids },
    );
  };
  const reader = () => {
    if (!binding.repository.listRead)
      throw new Error(`Missing progressive list reader: ${binding.entity}`);
    return binding.repository.listRead;
  };
  return {
    async base(context: EntityKernelContext, value: unknown) {
      const input = inputSchema.parse(value);
      const filters = filtersFor(input.filters);
      const pagination = input.pagination ?? { pageIndex: 0, pageSize: 50 };
      const fields = listReadFields(binding.entity);
      const result = await withTrace(
        "entity.list.core",
        async () =>
          withListReadTracing(
            { entity: binding.entity, projection: "base" },
            () =>
              reader()(
                context,
                filters,
                parseSorts(
                  binding,
                  input.sort,
                  Boolean(input.filters.searchQuery),
                ),
                pagination,
                { kind: "base" },
                parseGroupBy(binding, input.groupBy),
              ),
          ),
        { "entity.kind": binding.entity },
      );
      return {
        entity: binding.entity,
        data: await withRecordEmoji(context.db, binding.entity, result.data),
        meta: buildPaginatedResponse(
          pagination,
          [],
          result.count,
          undefined,
          result.groups,
        ).meta,
        groups: (["media", "quality", "relations", "derived"] as const)
          .filter((group) => fields[group].length > 0)
          .map((id) => ({ id, fields: fields[id] })),
      };
    },
    async enrich(
      context: EntityKernelContext,
      value: {
        ids: string[];
        groups: ("media" | "quality" | "relations" | "derived")[];
      },
    ) {
      const ids = [...new Set(value.ids)];
      for (const id of ids) binding.schemas.id.parse(id);
      const groups = [...new Set(value.groups)];
      const fields = listReadFields(binding.entity);
      for (const group of groups)
        if (!fields[group].length)
          throw new Error(`Unsupported list group: ${binding.entity}.${group}`);
      if (!ids.length)
        return {
          entity: binding.entity,
          groups: groups.map((id) => ({
            id,
            state: "ready" as const,
            data: [],
          })),
          missingIds: [],
        };
      const readGroups = async (requested: typeof groups) => {
        let page = await withTrace(
          "entity.list.enrichment",
          () =>
            withListReadTracing(
              {
                entity: binding.entity,
                projection: "enrichment",
                rows: ids.length,
              },
              () =>
                reader()(
                  context,
                  filtersFor({ ids }),
                  [],
                  { pageIndex: 0, pageSize: 500 },
                  {
                    kind: "enrichment",
                    groups: expandListGroups(requested, fields.dependencies),
                  },
                ),
            ),
          {
            "entity.kind": binding.entity,
            "list.groups": requested.join(","),
            "list.rows": ids.length,
          },
        );
        if (requested.includes("media"))
          page = {
            ...page,
            data: z
              .array(listReadRowSchema)
              .parse(
                await withListEntityMedia(
                  context.db,
                  binding.entity,
                  page.data,
                ),
              ),
          };
        const found = new Set(page.data.map((row) => row.id));
        return {
          entity: binding.entity,
          groups: requested.map((id) => ({
            id,
            state: "ready" as const,
            data: projectListRows(binding.entity, page.data, {
              kind: "enrichment",
              groups: [id],
            }),
          })),
          missingIds: ids.filter((id) => !found.has(id)),
        };
      };
      const failedGroups = (
        requested: typeof groups,
        error: ListReadFailure,
      ) => {
        const normalized = normalizeStartOperationError(
          error,
          "run",
          undefined,
          {
            operation: "entity.listEnrichment",
            authenticated: true,
            entity: binding.entity,
          },
        );
        return {
          entity: binding.entity,
          groups: requested.map((id) => ({
            id,
            state: "error" as const,
            error: normalized.publicError,
          })),
          missingIds: new Array<string>(),
        };
      };
      try {
        return await readGroups(groups);
      } catch (error) {
        if (groups.length < 2) return failedGroups(groups, error);
        // Only a failed combined read retries independent groups; healthy reads select the page once.
        const results = await Promise.all(
          groups.map(async (group) => {
            try {
              return await readGroups([group]);
            } catch (groupError) {
              return failedGroups([group], groupError);
            }
          }),
        );
        return {
          entity: binding.entity,
          groups: results.map((result) => result.groups).flat(),
          missingIds: [
            ...new Set(results.flatMap((result) => result.missingIds)),
          ],
        };
      }
    },
    async summary(context: EntityKernelContext, value: unknown) {
      const input = inputSchema.parse(value);
      const filters = filtersFor(input.filters);
      const sums = await withTrace(
        "entity.list.summary",
        async () =>
          binding.repository.listSummary?.(context, filters) ??
          Promise.resolve({}),
        { "entity.kind": binding.entity },
      );
      return { entity: binding.entity, sums };
    },
  };
}
