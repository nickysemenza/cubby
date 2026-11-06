import type { ConnectedRecordsOutput } from "@cubby/schemas/connected-records";
import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";

import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import {
  ConnectionPaths,
  ConnectionRecordLink,
  connectionRefs,
  ambiguousConnectionLabels,
} from "~/entity/relationships/connection-paths";
import { entityGraph } from "~/integrations/tanstack-query/generated/domains/entityGraph.gen";
import {
  RecordFold,
  RecordGroup,
  RecordList,
  type RecordListState,
  RecordMore,
  RecordRow,
} from "~/ui/records/record-list";

import {
  useSectionCount,
  useSectionEmpty,
} from "../../ui/data-table/detail-section-state";
import { RelationshipMovementBadges } from "./relationship-movement";

const PREVIEW_SIZE = 3;
type ConnectedItem = ConnectedRecordsOutput["items"][number];

/** One connected record with its shared identity and witnessed explanations. */
function ConnectedRow({
  item,
  movement,
  disambiguate = false,
}: {
  item: ConnectedItem;
  movement: boolean;
  disambiguate?: boolean;
}) {
  return (
    <RecordRow
      primary={
        <>
          <ConnectionRecordLink
            node={item.target}
            disambiguate={disambiguate}
          />
          {movement ? (
            <RelationshipMovementBadges id={item.target.entityId} />
          ) : null}
        </>
      }
      clip={false}
      facts={[
        {
          id: "via",
          label: "Via",
          value: <ConnectionPaths paths={item.paths} compact />,
        },
      ]}
    />
  );
}

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

/**
 * The detail page's one Connected records section: each declared target group with
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
  const views = query.data?.views ?? [];
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
        columns={[{ id: "via", label: "Via" }]}
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
                    search: {
                      source,
                      id: sourceId,
                      view: view.viewKey,
                      mode: "records",
                    },
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
                disambiguate={ambiguousConnectionLabels(
                  view.items.map((entry) => entry.target),
                ).has(item.target.label)}
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
