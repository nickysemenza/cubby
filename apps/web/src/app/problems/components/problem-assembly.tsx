import type { Entity } from "@cubby/schemas/entity";
import type { ProblemsCoverage } from "@cubby/schemas/problems";
import { ChevronDown, ListFilter } from "lucide-react";
import { Fragment } from "react";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { entities } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import { encodeFilters, humanize, sortToParam } from "~/entities/filters";
import type { ProblemQuery } from "~/entities/problem-query";
import { cn } from "~/lib/utils";

/**
 * A router-agnostic list continuation prepared by the Problem Query adapter.
 *
 * `href` is intentional: a Problem can point at any entity route and a dynamic
 * `to` would widen TanStack Router's route union past what a generic section
 * renderer can safely express. The URL is still assembled from the canonical
 * query source, never from card rows.
 */
export type ProblemListLocation = {
  href: string;
  entity: Entity;
};

/**
 * Exact list continuation for an entity-grain Problem. `worklist` is context
 * only; the encoded filters and sort remain the complete membership contract.
 */
export const problemListLocation = (
  query: ProblemQuery,
): ProblemListLocation | undefined => {
  if (
    query.source.kind !== "entity" ||
    query.continuation.kind !== "entity-list"
  ) {
    return undefined;
  }
  const params = new URLSearchParams({ worklist: query.key });
  const specs = getEntityFilters(query.source.entity);
  const values = new Map(
    query.source.filters.map(({ id, value }) => [id, value]),
  );
  const known = new Set(specs.map((spec) => spec.columnId));
  const unknown = query.source.filters.find(({ id }) => !known.has(id));
  if (unknown) {
    throw new Error(
      `Problem ${query.key} cannot link unknown ${query.source.entity} filter ${unknown.id}`,
    );
  }
  for (const [key, value] of Object.entries(
    encodeFilters(specs, (columnId) => values.get(columnId)),
  )) {
    if (value !== undefined) params.set(key, value);
  }
  const sort = query.source.sort && sortToParam([...query.source.sort]);
  if (sort) params.set("sort", sort);
  return {
    href: `${entities[query.source.entity].routes.list}?${params.toString()}`,
    entity: query.source.entity,
  };
};

type ProblemAssemblyProps = {
  queries: readonly ProblemQuery[];
  listLocations: readonly {
    query: ProblemQuery;
    count: number;
    location: ProblemListLocation;
  }[];
  projectionFreshness?: ProblemsCoverage["freshness"];
};

const optionLabel = (entity: Entity, id: string, value: string): string => {
  const spec = getEntityFilters(entity).find(
    (candidate) => candidate.columnId === id,
  );
  const option = spec?.options?.find((candidate) => candidate.value === value);
  if (option) return option.label;
  if (value === "none")
    return `No ${humanize(id.replace(/Presence$/, "")).toLowerCase()}`;
  if (value === "has")
    return `Has ${humanize(id.replace(/Presence$/, "")).toLowerCase()}`;
  return value;
};

const assemblyChips = (query: ProblemQuery): string[] => {
  const source = query.source;
  if (source.kind === "derived") {
    const inputs = source.inputs ?? [];
    const inputChips = inputs.flatMap((input) => [
      entities[input.entity].pluralLabel,
      ...input.filters.flatMap((filter) => {
        const values = Array.isArray(filter.value)
          ? filter.value
          : [filter.value];
        return values.map((value) =>
          optionLabel(input.entity, filter.id, value),
        );
      }),
    ]);
    return inputChips.length ? inputChips : ["All live records"];
  }

  return [
    entities[source.entity].pluralLabel,
    ...source.filters.flatMap((filter) => {
      const values = Array.isArray(filter.value)
        ? filter.value
        : [filter.value];
      return values.map((value) =>
        optionLabel(source.entity, filter.id, value),
      );
    }),
  ];
};

const freshnessDetail = (query: ProblemQuery): string => {
  switch (query.freshness?.kind) {
    case "projection":
      return `Membership uses the ${query.freshness.label} projection; its freshness is shown by that projection.`;
    case "external":
      return `Membership uses ${query.freshness.provider}; unavailable or stale enrichment is not treated as a healthy empty result.`;
    default:
      return "Membership is evaluated from live household data.";
  }
};

/**
 * Read-only explanation of how a Problem is assembled. It deliberately looks
 * like ledger metadata, not a second filter bar: editing belongs on the list
 * that the exact continuation opens.
 */
export function ProblemAssembly({
  queries,
  listLocations,
  projectionFreshness,
}: ProblemAssemblyProps) {
  if (queries.length === 0) return null;

  const isBranching = queries.length > 1;
  const derived = queries.some((query) => query.source.kind === "derived");
  const onlyLocation =
    listLocations.length === 1 ? listLocations[0] : undefined;

  return (
    <Collapsible className="mt-2 border-border border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-2xs text-slate uppercase tracking-wider">
          {isBranching ? "Any branch" : "Assembly"}
        </span>
        {queries.map((query, queryIndex) => (
          <Fragment key={query.key}>
            {queryIndex > 0 && (
              <span className="font-mono text-2xs text-muted-foreground">
                OR
              </span>
            )}
            {assemblyChips(query).map((chip, chipIndex) => (
              <Fragment key={`${query.key}-${chip}`}>
                {chipIndex > 0 && (
                  <span className="text-muted-foreground text-xs">AND</span>
                )}
                <span className="border border-border bg-muted/40 px-2 py-1 text-foreground text-xs">
                  {chip}
                </span>
              </Fragment>
            ))}
          </Fragment>
        ))}
        {onlyLocation && !isBranching && !derived && (
          <a
            href={onlyLocation.location.href}
            className={cn(
              buttonVariants({ size: "xs", variant: "ghost" }),
              "ml-auto",
            )}
          >
            <ListFilter className="mr-1 size-3" />
            Open {onlyLocation.count}{" "}
            {entities[onlyLocation.location.entity].pluralLabel.toLowerCase()}
          </a>
        )}
        {queries.some((query) => query.freshness.kind === "projection") &&
          projectionFreshness?.state !== "fresh" && (
            <span className="border border-warning/40 bg-warning/10 px-2 py-1 text-warning-foreground text-xs">
              {projectionFreshness?.state === "unavailable"
                ? "Projection unavailable"
                : "Projection stale"}
            </span>
          )}
        <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
          How it works <ChevronDown className="ml-1 size-3" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-2 space-y-2 border-border border-l pl-2 text-muted-foreground text-xs">
          {queries.map((query) => (
            <div key={query.key}>
              {isBranching && (
                <span className="font-medium text-foreground">
                  {query.title}:{" "}
                </span>
              )}
              {query.source.kind === "entity" ? (
                <span>
                  Matches{" "}
                  {entities[query.source.entity].pluralLabel.toLowerCase()} with
                  the filters above
                  {query.source.sort?.length
                    ? `, sorted by ${query.source.sort.map((sort) => `${sort.desc ? "descending" : "ascending"} ${humanize(sort.id)}`).join(", ")}`
                    : ""}
                  .
                </span>
              ) : (
                <span>
                  {query.source.operations
                    .map((operation) => operation.label)
                    .join(" → ")}
                  {query.source.grain
                    ? `; one result per ${query.source.grain}.`
                    : "."}
                </span>
              )}
              <span>{freshnessDetail(query)}</span>
              {isBranching &&
                listLocations
                  .filter((entry) => entry.query.key === query.key)
                  .map((entry) => (
                    <a
                      key={entry.query.key}
                      href={entry.location.href}
                      className={cn(
                        buttonVariants({ size: "xs", variant: "ghost" }),
                        "ml-1",
                      )}
                    >
                      <ListFilter className="mr-1 size-3" />
                      Open {entry.count}{" "}
                      {entities[
                        entry.location.entity
                      ].pluralLabel.toLowerCase()}
                    </a>
                  ))}
            </div>
          ))}
          {derived && (
            <p>
              These results are derived from complete candidate sets, so there
              is no broader list link.
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
