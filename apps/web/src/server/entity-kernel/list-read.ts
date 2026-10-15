import { buildPaginatedResponse } from "@cubby/schemas/pagination";
import { z } from "zod";

import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import {
  type ListEnrichmentGroup,
  listEnrichmentGroups,
  listReadRowSchema,
} from "~/entity/model/list-read-fields";
import {
  listReadFields,
  projectListRows,
} from "~/entity/model/list-read-schema";
import { withListEntityMedia } from "~/server/entity-kernel/repo/entity-display-image";
import { withRecordEmoji } from "~/server/entity-kernel/repo/entity-emoji";
import { listTotalLabels } from "~/server/generic/list/repo/list-display-labels";
import { expandListGroups } from "~/server/generic/list/repo/list-projection";
import { withListReadTracing } from "~/server/generic/list/repo/list-read-tracing";
import { withTrace } from "~/server/observability/tracing";
import { normalizeStartOperationError } from "~/server/operation-runtime/start-operation.server";

import type {
  EntityBindingSchemas,
  EntityKernelCoreBinding,
  EntityKernelContext,
} from "./adapter";
import { resolveCurrentMemberFilters } from "./current-member-filter";
import {
  parseGroupBy,
  parseNesting,
  parseSorts,
  parseSchema,
} from "./list-input";

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
  nesting: z.unknown().optional(),
});

export function defineProgressiveListOperations<
  E extends ListEntity,
  S extends EntityBindingSchemas,
>(binding: EntityKernelCoreBinding<E, S>) {
  const parseFilters = (input: z.output<typeof inputSchema>["filters"]) => {
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
  const filtersFor = (
    context: EntityKernelContext,
    input: z.output<typeof inputSchema>["filters"],
  ) =>
    resolveCurrentMemberFilters(
      context,
      binding.schemas.filters,
      parseFilters(input),
    );
  /** The page's filters plus its nesting scope; totals stay over the filters. */
  const scopedFilters = async (
    context: EntityKernelContext,
    input: z.output<typeof inputSchema>,
  ) =>
    Object.assign(await filtersFor(context, input.filters), {
      nesting: parseNesting(binding, input.nesting),
    });
  const reader = () => {
    if (!binding.repository.listRead)
      throw new Error(`Missing progressive list reader: ${binding.entity}`);
    return binding.repository.listRead;
  };
  /** One enrichment read of `requested` (plus their loader dependencies) for `ids`. */
  const readEnrichment = async (
    context: EntityKernelContext,
    ids: string[],
    requested: readonly ListEnrichmentGroup[],
  ) => {
    const fields = listReadFields(binding.entity);
    const filters = await filtersFor(context, { ids });
    const page = await withTrace(
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
              filters,
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
    if (!requested.includes("media")) return page;
    return {
      ...page,
      data: z
        .array(listReadRowSchema)
        .parse(
          await withListEntityMedia(context.db, binding.entity, page.data),
        ),
    };
  };
  const readBase = async (
    context: EntityKernelContext,
    input: z.output<typeof inputSchema>,
    filters: ReturnType<typeof parseFilters>,
  ) => {
    const pagination = input.pagination ?? { pageIndex: 0, pageSize: 50 };
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
    return { pagination, result };
  };
  return {
    async base(context: EntityKernelContext, value: unknown) {
      const input = inputSchema.parse(value);
      const { pagination, result } = await readBase(
        context,
        input,
        await scopedFilters(context, input),
      );
      const fields = listReadFields(binding.entity);
      return {
        entity: binding.entity,
        data: await withRecordEmoji(context.db, binding.entity, result.data),
        meta: buildPaginatedResponse(pagination, [], result.count, {
          groups: result.groups,
        }).meta,
        groups: (["media", "quality", "relations", "derived"] as const)
          .filter((group) => fields[group].length > 0)
          .map((id) => ({ id, fields: fields[id] })),
      };
    },
    /**
     * A kernel `list` result whose rows carry only `fields`: the base page,
     * then one enrichment read of just the groups that own a requested field.
     * Callers that publish a narrow projection (MCP summary detail) skip the
     * quality, pricing, USDA, and media work a complete row needs.
     */
    async listFields(
      context: EntityKernelContext,
      value: unknown,
      fields: readonly string[],
    ) {
      const owners = listReadFields(binding.entity);
      const requested = listEnrichmentGroups.filter((group) =>
        owners[group].some((field) => fields.includes(field)),
      );
      const input = inputSchema.parse(value);
      const filters = await filtersFor(context, input.filters);
      const [{ pagination, result }, sums] = await Promise.all([
        readBase(context, input, await scopedFilters(context, input)),
        binding.repository.listSummary?.(context, filters),
      ]);
      const ids = result.data.map((row) => row.id);
      const enriched =
        requested.length > 0 && ids.length > 0
          ? new Map(
              projectListRows(
                binding.entity,
                (await readEnrichment(context, ids, requested)).data,
                { kind: "enrichment", groups: requested },
              ).map((row) => [row.id, row]),
            )
          : undefined;
      return {
        action: "list" as const,
        entity: binding.entity,
        ...buildPaginatedResponse(
          pagination,
          result.data.map((row) => ({ ...row, ...enriched?.get(row.id) })),
          result.count,
          {
            sums,
            totalLabels: listTotalLabels(binding.entity, sums),
            groups: result.groups,
          },
        ),
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
        const page = await readEnrichment(context, ids, requested);
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
      const filters = await filtersFor(context, input.filters);
      const sums = await withTrace(
        "entity.list.summary",
        async () =>
          binding.repository.listSummary?.(context, filters) ??
          Promise.resolve({}),
        { "entity.kind": binding.entity },
      );
      return {
        entity: binding.entity,
        sums,
        totalLabels: listTotalLabels(binding.entity, sums),
      };
    },
  };
}
