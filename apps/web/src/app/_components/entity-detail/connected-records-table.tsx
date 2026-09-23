import type {
  ConnectedPathNode,
  ConnectedRecordsOutput,
} from "@cubby/schemas/connected-records";
import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  entityDetailParams,
  entities,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityGraph } from "~/entities/entity-graph.functions";

import { useSectionCount, useSectionVisible } from "../data-table/detail-page";

const PAGE_SIZE = 20;

function RecordPathLink({ node }: { node: ConnectedPathNode }) {
  if (!isBrowserRoutedEntity(node.entityType)) return <span>{node.label}</span>;
  return (
    <Link
      to={entities[node.entityType].routes.detail}
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
}: {
  paths: ConnectedRecordsOutput["items"][number]["paths"];
}) {
  const [first, ...other] = paths;
  if (!first) return null;
  const renderPath = (path: ConnectedPathNode[]) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      {path.slice(1).map((node, index) => (
        <span
          key={path
            .slice(0, index + 2)
            .map((part) => `${part.entityType}:${part.entityId}`)
            .join("|")}
        >
          {index > 0 ? (
            <span className="text-muted-foreground"> → </span>
          ) : null}
          <RecordPathLink node={node} />
        </span>
      ))}
    </span>
  );
  return (
    <div className="text-sm">
      <div>
        <span className="font-mono text-xs text-muted-foreground">
          {first.length - 1} {first.length === 2 ? "hop" : "hops"} ·{" "}
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
                  .map((node) => `${node.entityType}:${node.entityId}`)
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
  const [openAll, setOpenAll] = useState(initialOpenAll);
  const [page, setPage] = useState(0);
  const query = useQuery(
    entityGraph.connectedRecords.queryOptions({
      source: { entityType: source, entityId: sourceId },
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
    <div className="space-y-3">
      <HopRange range={routeHopRange} />
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">
                {isBrowserRoutedEntity(target)
                  ? entities[target].label
                  : "Record"}
              </th>
              <th className="p-3 font-medium">Connected through</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.target.entityId}
                className="border-b border-border last:border-0"
              >
                <td className="p-3 align-top font-medium">
                  <RecordPathLink node={item.target} />
                </td>
                <td className="p-3 align-top">
                  <RecordPaths paths={item.paths} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConnectionPager
        openAll={openAll}
        page={page}
        totalCount={totalCount}
        setOpenAll={setOpenAll}
        setPage={setPage}
      />
    </div>
  );
}
