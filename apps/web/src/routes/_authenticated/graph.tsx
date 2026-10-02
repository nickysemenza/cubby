import { entitySchema } from "@cubby/schemas/entity";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import { EntityGraphPicker } from "~/entity/relationships/entity-graph-picker";
import { GraphExplorer } from "~/entity/relationships/graph-explorer";
import { pageTitle } from "~/lib/page-title";
import { Stack } from "~/ui/layout";
import { Page } from "~/ui/page/Page";

export const Route = createFileRoute("/_authenticated/graph")({
  validateSearch: z.object({
    entity: entitySchema.optional().catch(undefined),
    root: z.string().optional().catch(undefined),
    selected: z.string().optional().catch(undefined),
    destination: z.string().optional().catch(undefined),
    start: z.string().optional().catch(undefined),
  }),
  head: () => ({ meta: [{ title: pageTitle("Graph") }] }),
  component: GraphPage,
});

function GraphPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const root = useMemo(
    () =>
      entityGraphRootSchema.safeParse({
        entityKind: search.entity,
        entityId: search.root,
      }).data,
    [search.entity, search.root],
  );
  return (
    <Page variant="bare" layout="viewport">
      <Stack gap="md" className="h-full min-h-0 p-2 md:p-4">
        <h1 className="sr-only text-2xl font-semibold md:not-sr-only">Graph</h1>
        <EntityGraphPicker
          placeholder="Find a starting record…"
          onSelect={(value) =>
            void navigate({ search: { entity: value.entity, root: value.id } })
          }
        />
        {root ? (
          <GraphExplorer
            fill
            key={`${root.entityKind}:${root.entityId}`}
            root={root}
            initialSelected={search.selected}
            initialDestination={search.destination}
            initialPathStart={search.start}
            onRootChange={(value) =>
              void navigate({
                search: { entity: value.entityKind, root: value.entityId },
              })
            }
            onNavigationChange={(state) =>
              void navigate({
                search: (old) => ({ ...old, ...state }),
                replace: true,
              })
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose a starting record, then expand its connections to build your
            map.
          </p>
        )}
      </Stack>
    </Page>
  );
}
