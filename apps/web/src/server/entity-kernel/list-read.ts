import {
  listGroupByDimensionsSchema,
  listResultMembership,
  sortDirection,
} from "@cubby/schemas/pagination";
import { buildPaginatedResponse } from "@cubby/schemas/pagination";
import { z } from "zod";

import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import { listReadRowSchema } from "~/entity/model/list-read-fields";
import { withListEntityMedia } from "~/server/entity-kernel/repo/entity-display-image";
import {
  publicFieldEnvelopeRows,
  selectedFieldEnvelopeSchema,
} from "~/server/generic/derived/repo/public-read";
import { ListPreparationScope } from "~/server/generic/list/repo/field-compiler";
import {
  listFacetCounter,
  withListGroupBy,
} from "~/server/generic/list/repo/list";
import { listTotalLabels } from "~/server/generic/list/repo/list-display-labels";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { validateListReadRows } from "~/server/generic/list/repo/list-read-schema";
import { withListReadTracing } from "~/server/observability/list-read-tracing";
import { withTrace } from "~/server/observability/tracing";

import type {
  EntityBindingSchemas,
  EntityKernelCoreBinding,
  EntityKernelContext,
} from "./adapter";
import { resolveFilterTokens } from "./filter-tokens";
import {
  parseGroupBy,
  parseNesting,
  parseSorts,
  parseSchema,
} from "./list-input";

const facetInputSchema = z.object({
  filters: z.record(z.string(), z.unknown()),
  facetIds: z.array(z.string()),
});
const viewCountsInputSchema = z.object({
  views: z.array(
    z.object({ id: z.string(), filters: z.record(z.string(), z.unknown()) }),
  ),
});
const inputSchema = z.object({
  filters: z.record(z.string(), z.unknown()),
  pagination: z
    .object({ pageIndex: z.number(), pageSize: z.number() })
    .optional(),
  sort: z
    .array(z.object({ orderBy: z.string(), direction: sortDirection }))
    .optional(),
  groupBy: listGroupByDimensionsSchema.optional(),
  nesting: z.unknown().optional(),
  resultMembership: listResultMembership.optional(),
});

export function defineListOperations<
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
    resolveFilterTokens(context, binding.schemas.filters, parseFilters(input));
  /**
   * The page's filters plus its nesting scope and `groupBy`, both carried
   * beside the filters; totals stay over the filters.
   */
  const scopedFilters = async (
    context: EntityKernelContext,
    input: z.output<typeof inputSchema>,
  ) =>
    withListGroupBy(
      Object.assign(await filtersFor(context, input.filters), {
        nesting: parseNesting(binding, input.nesting),
        resultMembership: input.resultMembership,
      }),
      parseGroupBy(binding, input.groupBy),
    );
  const reader = () => {
    if (!binding.repository.listRead)
      throw new Error(`Missing list reader: ${binding.entity}`);
    return binding.repository.listRead;
  };
  return {
    /** Narrow published projections share the canonical selector and full-population totals. */
    async listFields(
      context: EntityKernelContext,
      value: unknown,
      fields: readonly string[],
    ) {
      const projection = selectedListProjection(binding.entity, fields);
      const input = inputSchema.parse(value);
      const filters = Object.assign(await filtersFor(context, input.filters), {
        resultMembership: input.resultMembership,
      });
      const pagination = input.pagination ?? { pageIndex: 0, pageSize: 50 };
      const scoped = await scopedFilters(context, input);
      const [result, sums] = await Promise.all([
        withListReadTracing(
          { entity: binding.entity, projection: "selected" },
          () =>
            reader()(
              context,
              scoped,
              parseSorts(
                binding,
                input.sort,
                Boolean(input.filters.searchQuery),
              ),
              pagination,
              projection,
            ),
        ),
        binding.repository.listSummary?.(context, filters),
      ]);
      const rows = projection.fields.some(
        (field) => field === "displayImages" || field === "images",
      )
        ? z
            .array(listReadRowSchema)
            .parse(
              await withListEntityMedia(
                context.db,
                binding.entity,
                result.data,
              ),
            )
        : result.data;
      const selected = validateListReadRows(binding.entity, rows, fields);
      const enveloped = await publicFieldEnvelopeRows({
        db: context.db,
        entity: binding.entity,
        schema: selectedFieldEnvelopeSchema(binding.schemas.list, fields),
        rows: selected,
        contexts: result.fieldReads,
      });
      return {
        action: "list" as const,
        entity: binding.entity,
        ...buildPaginatedResponse(pagination, enveloped, result.count, {
          unresolvedCount: result.unresolvedCount,
          incompleteSums: result.incompleteSums,
          sums,
          totalLabels: listTotalLabels(
            binding.entity,
            sums,
            result.incompleteSums,
          ),
          groups: result.groups,
          memberships: result.memberships,
          membershipCount: result.membershipCount,
        }),
      };
    },
    /**
     * Facets for the requested declared filters under the request's other
     * filters (`listScaffold.countBy`); a filter without one is omitted.
     */
    async facets(context: EntityKernelContext, value: unknown) {
      const input = facetInputSchema.parse(value);
      const filters = await filtersFor(context, input.filters);
      const counter = listFacetCounter(binding.entity);
      const facets = counter
        ? await withTrace(
            "entity.list.facets",
            () =>
              Promise.all(
                [...new Set(input.facetIds)].map((id) =>
                  counter.countBy(context.db, filters, id),
                ),
              ),
            { "entity.kind": binding.entity },
          )
        : [];
      return {
        entity: binding.entity,
        facets: facets.filter((facet) => facet !== null),
      };
    },
    /**
     * Each saved view's row count, plus the unfiltered total, through the
     * same list read (and count) a page uses. The browser compiles the
     * filters: Problem semantics alone cover only Problem-backed views.
     */
    async viewCounts(context: EntityKernelContext, value: unknown) {
      const { views } = viewCountsInputSchema.parse(value);
      const preparation = new ListPreparationScope(context.db);
      const countOf = async (raw: z.output<typeof inputSchema>["filters"]) => {
        const result = await reader()(
          context,
          await filtersFor(context, raw),
          [],
          { pageIndex: 0, pageSize: 1 },
          { kind: "base" },
          "count",
          preparation,
        );
        return { count: result.count, unresolvedCount: result.unresolvedCount };
      };
      const [total, ...counts] = await withTrace(
        "entity.list.viewCounts",
        () =>
          Promise.all([
            countOf({}),
            ...views.map((view) => countOf(view.filters)),
          ]),
        { "entity.kind": binding.entity },
      );
      return {
        entity: binding.entity,
        total: total?.count ?? 0,
        views: views.map((view, index) => ({
          id: view.id,
          count: counts[index]?.count ?? 0,
          ...(counts[index]?.unresolvedCount === undefined
            ? {}
            : { unresolvedCount: counts[index]?.unresolvedCount }),
        })),
      };
    },
  };
}
