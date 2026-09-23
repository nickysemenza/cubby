import { connectedViews } from "@cubby/schemas/connected-views";
import { entitySchema } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { ConnectedRecordsTable } from "~/app/_components/entity-detail/connected-records-table";
import {
  entityDetailParams,
  entities,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  source: entitySchema,
  id: z.string().min(1),
  view: z.string().min(1),
});

export const Route = createFileRoute("/_authenticated/connections")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: pageTitle("Connected records") }] }),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const { source, id, view } = Route.useSearch();
  const relation = view.startsWith("relation:")
    ? entityManifest[source].relationships.find(
        (item) => item.key === view.slice(9) && item.cardinality === "many",
      )
    : undefined;
  const curated = connectedViews[source].find((item) => item.key === view);
  const target = relation?.target ?? curated?.target;
  const title =
    curated?.title ??
    (target && isBrowserRoutedEntity(target)
      ? entities[target].pluralLabel
      : "Connected records");
  if (!target)
    return (
      <main className="p-6">
        <h1 className="text-2xl font-semibold">Unknown connection view</h1>
      </main>
    );
  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-8">
      {isBrowserRoutedEntity(source) ? (
        <Link
          to={entities[source].routes.detail}
          params={entityDetailParams(id)}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to record
        </Link>
      ) : null}
      <h1 className="text-3xl font-semibold">{title}</h1>
      <ConnectedRecordsTable
        key={`${source}:${id}:${view}`}
        source={source}
        sourceId={id}
        viewKey={view}
        target={target}
        initialOpenAll
        hideWhenEmpty={false}
      />
    </main>
  );
}
