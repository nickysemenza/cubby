import type {
  ConnectedPathNode,
  ConnectedRecordsOutput,
} from "@cubby/schemas/connected-records";
import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  entityDetailParams,
  entities,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Button } from "~/ui/primitives/button";
import { StaticTable } from "~/ui/primitives/static-table";

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

// Roomier than the primitive defaults, and wrapping: a path evidence cell is a
// multi-line list, not a single truncated value.
const HEAD_CLASS = "h-auto p-3 text-sm";
const CELL_CLASS = "p-3 align-top whitespace-normal";

function RecordPathLink({ node }: { node: ConnectedPathNode }) {
  if (!isBrowserRoutedEntity(node.entityKind)) return <span>{node.label}</span>;
  return (
    <Link
      to={entities[node.entityKind].routes.detail}
      params={entityDetailParams(node.entityId)}
      className="text-link hover:underline"
    >
      {node.label}
    </Link>
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

export function RecordPaths({
  paths,
  compact = false,
}: {
  paths: ConnectedRecordsOutput["items"][number]["paths"];
  compact?: boolean;
}) {
  const [first, ...other] = paths;
  if (!first) return null;
  const renderPath = (path: ConnectedPathNode[]) => {
    const middle = path.slice(1, -1);
    if (middle.length === 0)
      return <span className="text-muted-foreground">Direct connection</span>;
    if (compact)
      return (
        <ol className="min-w-0 space-y-0.5">
          {middle.map((node, index) => (
            <li
              key={path
                .slice(0, index + 2)
                .map((part) => `${part.entityKind}:${part.entityId}`)
                .join("|")}
              className="flex max-w-full min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap"
              title={`${node.entityKind}: ${node.label}`}
            >
              <span className="shrink-0 text-xs text-muted-foreground">
                {isBrowserRoutedEntity(node.entityKind)
                  ? entities[node.entityKind].label
                  : node.entityKind}
              </span>
              <span className="min-w-0 truncate">
                <RecordPathLink node={node} />
              </span>
            </li>
          ))}
        </ol>
      );
    return (
      <ol className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 align-middle">
        {middle.map((node, index) => (
          <li
            key={path
              .slice(0, index + 2)
              .map((part) => `${part.entityKind}:${part.entityId}`)
              .join("|")}
            className="inline-flex max-w-full min-w-0 items-center gap-1.5"
          >
            {index > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
            ) : null}
            <span className="max-w-full min-w-0 rounded border border-border bg-muted/30 px-1.5 py-0.5">
              <span className="me-1 text-xs text-muted-foreground">
                {isBrowserRoutedEntity(node.entityKind)
                  ? entities[node.entityKind].label
                  : node.entityKind}
              </span>
              <RecordPathLink node={node} />
            </span>
          </li>
        ))}
      </ol>
    );
  };
  return (
    <div className="max-w-full min-w-0 text-sm">
      <div
        className={compact ? "min-w-0" : "flex flex-wrap items-center gap-2"}
      >
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {first.length - 1} {first.length === 2 ? "hop" : "hops"}
        </span>
        {renderPath(first)}
      </div>
      {other.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {other.length} other {other.length === 1 ? "path" : "paths"}
          </summary>
          <ul className="mt-1 space-y-1 pl-3">
            {other.map((path) => (
              <li
                key={path
                  .map((node) => `${node.entityKind}:${node.entityId}`)
                  .join("|")}
              >
                {renderPath(path)}
              </li>
            ))}
          </ul>
        </details>
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
      <div className="space-y-3">
        <HopRange range={routeHopRange} />
        <StaticTable
          rows={items}
          rowKey={(item) => item.target.entityId}
          containerClassName="rounded-md border border-border"
          className="table-auto text-sm"
          headClassName={HEAD_CLASS}
          cellClassName={CELL_CLASS}
          columns={[
            {
              id: "record",
              header: isBrowserRoutedEntity(target)
                ? entities[target].label
                : "Record",
              cellClassName: "font-medium",
              cell: (item) => <RecordPathLink node={item.target} />,
            },
            ...(movementSource !== null
              ? [
                  {
                    id: "movement",
                    header: "Movement",
                    cell: (item: (typeof items)[number]) => (
                      <RelationshipMovementBadges id={item.target.entityId} />
                    ),
                  },
                ]
              : []),
            {
              id: "through",
              header: "Connected through",
              cell: (item) => <RecordPaths paths={item.paths} />,
            },
          ]}
        />
        <ConnectionPager
          openAll={openAll}
          page={page}
          totalCount={totalCount}
          setOpenAll={setOpenAll}
          setPage={setPage}
        />
      </div>
    </RelationshipMovementProvider>
  );
}
