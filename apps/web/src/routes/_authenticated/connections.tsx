import { entitySchema } from "@cubby/schemas/entity";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { ConnectedRecordsTable } from "~/entity/entity-detail/connected-records-table";
import { ensureEntityMetadata, entityMetadata } from "~/entity/metadata";
import { Page } from "~/entity/page/page";
import { EntityConnectionContext } from "~/entity/relationships/entity-connection-context";
import { EntityGraphPicker } from "~/entity/relationships/entity-graph-picker";
import { GraphExplorer } from "~/entity/relationships/graph-explorer";
import { pageTitle } from "~/lib/page-title";
import { Stack, Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

// A partial or stale link still offers a starting-record picker.
const searchSchema = z.object({
  source: entitySchema.optional().catch(undefined),
  id: z.string().min(1).optional().catch(undefined),
  view: z.string().min(1).optional().catch(undefined),
  mode: z.enum(["map", "records"]).optional().catch(undefined),
  selected: z.string().optional().catch(undefined),
  destination: z.string().optional().catch(undefined),
  start: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/connections")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, search }) => {
    if (search.source)
      await ensureEntityMetadata(context.queryClient, search.source);
  },
  head: () => ({ meta: [{ title: pageTitle("Connections") }] }),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const {
    source,
    id,
    view,
    mode,
    selected,
    destination,
    start,
    nativeWorkspace,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const root = useMemo(
    () =>
      entityGraphRootSchema.safeParse({ entityKind: source, entityId: id })
        .data,
    [source, id],
  );
  const relation =
    source && view?.startsWith("relation:")
      ? entityMetadata(queryClient, source).descriptor.relationships.find(
          (item) => item.key === view.slice(9) && item.cardinality === "many",
        )
      : undefined;
  const curated = source
    ? view
      ? [
          ...entityMetadata(queryClient, source).connections.views,
          ...entityMetadata(queryClient, source).connections.context,
        ].find((candidate) => candidate.key === view)
      : undefined
    : undefined;
  const target = relation?.target ?? curated?.target;
  const showRecords =
    mode === "records" || (mode === undefined && Boolean(view));
  const title =
    curated?.title ??
    (target && isBrowserRoutedEntity(target)
      ? entities[target].pluralLabel
      : "Connected records");
  return (
    <Page variant="bare" layout="viewport">
      <Stack gap="md" className="h-full min-h-0 p-3 md:p-4">
        <Row gap="md" wrap>
          <h1
            className={
              nativeWorkspace === "connections"
                ? "sr-only"
                : "text-xl font-semibold"
            }
          >
            Connections
          </h1>
          <div className="min-w-0 flex-1">
            <EntityGraphPicker
              placeholder="Find a starting record…"
              onSelect={(value) =>
                void navigate({
                  search: { source: value.entity, id: value.id },
                })
              }
            />
          </div>
          {target ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  search: (old) => ({
                    ...old,
                    mode: showRecords ? "map" : "records",
                  }),
                })
              }
            >
              {showRecords ? "Show map" : title}
            </Button>
          ) : null}
        </Row>
        {root ? (
          <>
            <EntityConnectionContext
              showOpenLink={false}
              entity={root.entityKind}
              id={root.entityId}
            />
            {showRecords && target && view ? (
              <div className="min-h-0 overflow-auto">
                <h2 className="mb-3 text-base font-semibold">{title}</h2>
                <ConnectedRecordsTable
                  key={`${source}:${id}:${view}`}
                  source={root.entityKind}
                  sourceId={root.entityId}
                  viewKey={view}
                  target={target}
                />
              </div>
            ) : (
              <GraphExplorer
                fill
                initialDepth={1}
                key={`${root.entityKind}:${root.entityId}`}
                root={root}
                initialSelected={selected}
                initialDestination={destination}
                initialPathStart={start}
                onRootChange={(value) =>
                  void navigate({
                    search: { source: value.entityKind, id: value.entityId },
                  })
                }
                onNavigationChange={(state) =>
                  void navigate({
                    search: (old) => ({ ...old, ...state }),
                    replace: true,
                  })
                }
              />
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose a record to explore its purchases, placement, work, and
            source records. Select a connection to inspect its facts and
            evidence.
          </p>
        )}
      </Stack>
    </Page>
  );
}
