import type {
  ConnectedPathNode,
  ConnectedRecordsOutput,
} from "@cubby/schemas/connected-records";
import type { Entity, EntityRef } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { entityGraph } from "~/integrations/tanstack-query/generated/entity-graph.gen";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";

import {
  useSectionCount,
  useSectionIndexPending,
  useSectionVisible,
} from "../../ui/data-table/detail-page";
import {
  relationshipMovementSource,
  RelationshipMovementBadges,
  RelationshipMovementProvider,
} from "./relationship-movement";

const PAGE_SIZE = 20;

type ConnectedItem = ConnectedRecordsOutput["items"][number];

/**
 * The records a page of paths passes through, for one batched cover request.
 * Targets are left to the owner: a relation table already batches its rows.
 */
export function connectionRefs(items: readonly ConnectedItem[]): EntityRef[] {
  return items.flatMap((item) =>
    item.paths.flatMap((path) => path.slice(1, -1)),
  );
}

const kindLabel = (kind: Entity) =>
  isBrowserRoutedEntity(kind) ? entities[kind].label : kind;

/**
 * One record as a cover-or-icon chip. A path often repeats a name (an Expense
 * is named after its Product), so a `repeated` node — the same label as the
 * node before it, or as the target it leads to — shows its kind instead of
 * the same long label twice; the full name stays in the title.
 */
function RecordChip({
  node,
  repeated = false,
}: {
  node: ConnectedPathNode;
  repeated?: boolean;
}) {
  if (!isBrowserRoutedEntity(node.entityKind))
    return (
      <span className="min-w-0 truncate" title={node.label}>
        {node.label}
      </span>
    );
  return (
    <EntityRefLink
      variant="chip"
      entity={node.entityKind}
      id={node.entityId}
      name={repeated ? entities[node.entityKind].label : node.label}
      // The batched provider supplies covers; a per-chip emoji lookup would
      // spend one request per path node.
      emoji={null}
    />
  );
}

export function HopRange({ range }: { range: { min: number; max: number } }) {
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {range.min === range.max ? range.min : `${range.min}–${range.max}`} record{" "}
      {range.max === 1 ? "hop" : "hops"}
    </span>
  );
}

function PathTrail({
  path,
  compact,
}: {
  path: ConnectedPathNode[];
  compact: boolean;
}) {
  const middle = path.slice(1, -1);
  if (middle.length === 0)
    return <span className="text-muted-foreground">Direct</span>;
  return (
    <ol
      className={cn(
        "flex min-w-0 items-center gap-1",
        compact ? "flex-nowrap overflow-hidden" : "flex-wrap",
      )}
    >
      {middle.map((node, index) => (
        <li
          key={path
            .slice(0, index + 2)
            .map((part) => `${part.entityKind}:${part.entityId}`)
            .join("|")}
          className={cn(
            "flex min-w-0 items-center gap-1",
            compact ? "shrink" : "max-w-64",
          )}
          title={`${kindLabel(node.entityKind)}: ${node.label}`}
        >
          {index > 0 ? (
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
              →
            </span>
          ) : null}
          <RecordChip
            node={node}
            repeated={
              path[index]?.label === node.label ||
              (index === middle.length - 1 && path.at(-1)?.label === node.label)
            }
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * The records between a source and a target, as one line of chips. `compact`
 * holds a table cell to a single line; otherwise the trail wraps inline.
 */
export function RecordPaths({
  paths,
  compact = false,
}: {
  paths: ConnectedItem["paths"];
  compact?: boolean;
}) {
  const [showOthers, setShowOthers] = useState(false);
  const [first, ...other] = paths;
  if (!first) return null;
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
      {compact ? null : (
        <span className="text-xs text-muted-foreground">via</span>
      )}
      {/* A compact trail's zero basis keeps the toggle on its line. */}
      <div className={cn("min-w-0", compact && "flex-1")}>
        <PathTrail path={first} compact={compact} />
      </div>
      {other.length > 0 ? (
        <button
          type="button"
          aria-expanded={showOthers}
          className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowOthers(!showOthers)}
        >
          +{other.length} {other.length === 1 ? "path" : "paths"}
        </button>
      ) : null}
      {showOthers ? (
        <ul className="basis-full space-y-1 pl-3">
          {other.map((path) => (
            <li
              key={path
                .map((node) => `${node.entityKind}:${node.entityId}`)
                .join("|")}
            >
              <PathTrail path={path} compact={compact} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ConnectionPager({
  openAll,
  page,
  totalCount,
  setOpenAll,
  setPage,
}: {
  openAll: boolean;
  page: number;
  totalCount: number;
  setOpenAll: (value: boolean) => void;
  setPage: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        Showing {openAll ? page * PAGE_SIZE + 1 : 1}–
        {Math.min((openAll ? page + 1 : 1) * PAGE_SIZE, totalCount)} of{" "}
        {totalCount}
      </span>
      {!openAll && totalCount > PAGE_SIZE ? (
        <Button variant="ghost" size="sm" onClick={() => setOpenAll(true)}>
          Open all
        </Button>
      ) : null}
      {openAll && page > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setPage(page - 1)}>
          Previous
        </Button>
      ) : null}
      {openAll && (page + 1) * PAGE_SIZE < totalCount ? (
        <Button variant="ghost" size="sm" onClick={() => setPage(page + 1)}>
          Next
        </Button>
      ) : null}
    </div>
  );
}

/** A complete connection query; Overview previews the first page, then pages in the same scope. */
export function ConnectedRecordsTable({
  source,
  sourceId,
  viewKey,
  target,
  initialOpenAll = false,
  hideWhenEmpty = true,
}: {
  source: Entity;
  sourceId: string;
  viewKey: string;
  target: Entity;
  initialOpenAll?: boolean;
  hideWhenEmpty?: boolean;
}) {
  const movementSource = relationshipMovementSource(
    source,
    target,
    viewKey.startsWith("relation:") ? viewKey.slice("relation:".length) : "",
  );
  const [openAll, setOpenAll] = useState(initialOpenAll);
  const [page, setPage] = useState(0);
  const query = useQuery(
    entityGraph.connectedRecords.queryOptions({
      source: { entityKind: source, entityId: sourceId },
      viewKey,
      offset: openAll ? page * PAGE_SIZE : 0,
      limit: PAGE_SIZE,
    }),
  );
  useSectionCount(query.data?.totalCount);
  useSectionVisible(
    !hideWhenEmpty ||
      query.isPending ||
      query.isError ||
      (query.data?.totalCount ?? 0) > 0,
  );
  // An index entry that appears, then vanishes when empty, shifts the rest.
  useSectionIndexPending(hideWhenEmpty && query.isPending);
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground">Loading connections…</p>
    );
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {String(query.error)}
      </p>
    );
  const { items, totalCount, routeHopRange } = query.data;
  if (totalCount === 0)
    return hideWhenEmpty ? null : (
      <p className="text-sm text-muted-foreground">No connected records.</p>
    );
  return (
    <RelationshipMovementProvider
      source={movementSource}
      recordId={sourceId}
      operations={{}}
    >
      <EntityDisplayImagesProvider
        refs={[...items.map((item) => item.target), ...connectionRefs(items)]}
      >
        <ul
          // Named like the mobile card lists so record rows read the same.
          aria-label={`${isBrowserRoutedEntity(target) ? entities[target].pluralLabel : "Records"} list`}
          className="divide-y divide-border rounded-md border border-border"
        >
          {items.map((item) => (
            <li
              key={item.target.entityId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm"
            >
              <span className="max-w-full min-w-0 font-medium sm:max-w-80">
                <RecordChip node={item.target} />
              </span>
              {movementSource !== null ? (
                <RelationshipMovementBadges id={item.target.entityId} />
              ) : null}
              <RecordPaths paths={item.paths} />
            </li>
          ))}
        </ul>
      </EntityDisplayImagesProvider>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <HopRange range={routeHopRange} />
        {totalCount > PAGE_SIZE ? (
          <ConnectionPager
            openAll={openAll}
            page={page}
            totalCount={totalCount}
            setOpenAll={setOpenAll}
            setPage={setPage}
          />
        ) : null}
      </div>
    </RelationshipMovementProvider>
  );
}
