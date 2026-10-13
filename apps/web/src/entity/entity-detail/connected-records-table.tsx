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
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";
import { cn } from "~/lib/utils";
import {
  RecordFold,
  RecordGroup,
  RecordHops,
  RecordList,
  type RecordListState,
  RecordMore,
  RecordRow,
} from "~/ui/common/record-list";
import { Button } from "~/ui/primitives/button";

import {
  useSectionCount,
  useSectionEmpty,
} from "../../ui/data-table/detail-section-state";
import {
  relationshipMovementSource,
  RelationshipMovementBadges,
  RelationshipMovementProvider,
} from "./relationship-movement";

const PAGE_SIZE = 20;
const PREVIEW_SIZE = 3;

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
 * One record as a cover-or-icon chip. `kind` names an intermediate record by
 * its entity kind (paths repeat names: an Expense is named after its Product);
 * the full name stays in the trail's title.
 */
function RecordChip({
  node,
  kind = false,
}: {
  node: ConnectedPathNode;
  kind?: boolean;
}) {
  if (!isBrowserRoutedEntity(node.entityKind))
    return (
      <span className="min-w-0 truncate" title={node.label}>
        {kind ? node.entityKind : node.label}
      </span>
    );
  return (
    <EntityRefLink
      variant="chip"
      entity={node.entityKind}
      id={node.entityId}
      name={kind ? entities[node.entityKind].label : node.label}
      // The batched provider supplies covers; a per-chip emoji lookup would
      // spend one request per path node.
      emoji={null}
    />
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
          <RecordChip node={node} kind />
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
  page,
  totalCount,
  setPage,
}: {
  page: number;
  totalCount: number;
  setPage: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} of{" "}
        {totalCount}
      </span>
      {page > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setPage(page - 1)}>
          Previous
        </Button>
      ) : null}
      {(page + 1) * PAGE_SIZE < totalCount ? (
        <Button variant="ghost" size="sm" onClick={() => setPage(page + 1)}>
          Next
        </Button>
      ) : null}
    </div>
  );
}

/** One connected record: identity, the route that reached it, and its distance. */
function ConnectedRow({
  item,
  movement,
}: {
  item: ConnectedItem;
  movement: boolean;
}) {
  return (
    <RecordRow
      primary={
        <>
          <RecordChip node={item.target} />
          {movement ? (
            <RelationshipMovementBadges id={item.target.entityId} />
          ) : null}
        </>
      }
      clip={false}
      secondary={<RecordPaths paths={item.paths} compact />}
      trailing={<RecordHops count={item.shortestHops} />}
    />
  );
}

const pluralLabel = (target: Entity) =>
  isBrowserRoutedEntity(target) ? entities[target].pluralLabel : "Records";

const listState = (
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  },
  rows: number,
): RecordListState =>
  query.isPending
    ? { status: "pending", rows }
    : query.isError
      ? {
          status: "error",
          error: query.error,
          title: "connected records",
          onRetry: query.refetch,
        }
      : { status: "success" };

/** Every row of one connected view, paged; the `/connections` page. */
export function ConnectedRecordsTable({
  source,
  sourceId,
  viewKey,
  target,
}: {
  source: Entity;
  sourceId: string;
  viewKey: string;
  target: Entity;
}) {
  const movementSource = relationshipMovementSource(
    source,
    target,
    viewKey.startsWith("relation:") ? viewKey.slice("relation:".length) : "",
  );
  const [page, setPage] = useState(0);
  const query = useQuery(
    entityGraph.connectedRecords.queryOptions({
      source: { entityKind: source, entityId: sourceId },
      viewKey,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
  );
  const items = query.data?.items ?? [];
  const totalCount = query.data?.totalCount ?? 0;
  return (
    <RelationshipMovementProvider
      source={movementSource}
      recordId={sourceId}
      operations={{}}
    >
      <EntityDisplayImagesProvider
        refs={[...items.map((item) => item.target), ...connectionRefs(items)]}
      >
        <RecordList
          // Named like the mobile card lists so record rows read the same.
          aria-label={`${pluralLabel(target)} list`}
          state={listState(query, 6)}
          empty="No connected records."
          footer={
            totalCount > PAGE_SIZE ? (
              <ConnectionPager
                page={page}
                totalCount={totalCount}
                setPage={setPage}
              />
            ) : null
          }
        >
          {items.map((item) => (
            <ConnectedRow
              key={item.target.entityId}
              item={item}
              movement={movementSource !== null}
            />
          ))}
        </RecordList>
      </EntityDisplayImagesProvider>
    </RelationshipMovementProvider>
  );
}

/**
 * The detail page's one Connected records section: each curated view with
 * results is a group of its first rows, closing with a link to the complete
 * view; views with no results fold into one line.
 */
export function ConnectedRecordsSection({
  source,
  sourceId,
}: {
  source: Entity;
  sourceId: string;
}) {
  const query = useQuery(
    entityGraph.connectedRecordsPreview.queryOptions({
      source: { entityKind: source, entityId: sourceId },
      limit: PREVIEW_SIZE,
    }),
  );
  const views = query.data?.views.filter((view) => !view.evidence) ?? [];
  const found = views.filter((view) => view.totalCount > 0);
  const absent = views.filter((view) => view.totalCount === 0);
  useSectionCount(
    query.data
      ? views.reduce((total, view) => total + view.totalCount, 0)
      : undefined,
  );
  useSectionEmpty(query.isSuccess && found.length === 0);
  const items = found.flatMap((view) => view.items);
  return (
    <EntityDisplayImagesProvider
      refs={[...items.map((item) => item.target), ...connectionRefs(items)]}
    >
      <RecordList
        aria-label="Connected records"
        state={listState(query, 4)}
        empty="No connected records."
      >
        {found.map((view) => (
          <RecordGroup
            key={view.viewKey}
            label={view.title}
            count={view.totalCount}
            more={
              view.totalCount > view.items.length ? (
                <RecordMore
                  label={`${view.totalCount - view.items.length} more`}
                  link={{
                    to: "/connections",
                    search: { source, id: sourceId, view: view.viewKey },
                  }}
                />
              ) : null
            }
          >
            {view.items.map((item) => (
              <ConnectedRow
                key={item.target.entityId}
                item={item}
                movement={false}
              />
            ))}
          </RecordGroup>
        ))}
        {found.length > 0 && absent.length > 0 ? (
          <RecordFold>
            No connections: {absent.map((view) => view.title).join(", ")}
          </RecordFold>
        ) : null}
      </RecordList>
    </EntityDisplayImagesProvider>
  );
}
