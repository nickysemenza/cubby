import { curatedConnectedViews } from "@cubby/schemas/connected-views";
import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section, Disclosure } from "~/ui/layout";

/** Only declared useful paths become headline context; generic graph reachability does not. */
export function EntityConnectionContext({
  entity,
  id,
  showOpenLink = true,
}: {
  entity: Entity;
  id: string;
  showOpenLink?: boolean;
}) {
  if (!curatedConnectedViews[entity].length) return null;
  return (
    <ResolvedContext entity={entity} id={id} showOpenLink={showOpenLink} />
  );
}

function ResolvedContext({
  entity,
  id,
  showOpenLink,
}: {
  entity: Entity;
  id: string;
  showOpenLink: boolean;
}) {
  const query = useQuery(
    entityGraph.connectedRecordsPreview.queryOptions({
      source: { entityKind: entity, entityId: id },
      limit: 3,
      scope: "context",
    }),
  );
  if (query.isPending)
    return (
      <output className="text-xs text-muted-foreground">
        Loading connection context…
      </output>
    );
  if (query.isError)
    return (
      <ErrorDisplay
        error={query.error}
        title="connection context"
        onRetry={() => void query.refetch()}
      />
    );
  const views = query.data.views
    .filter((view) => view.totalCount > 0)
    .slice(0, 4);
  if (!views.length) return null;
  const refs = views.flatMap((view) =>
    view.items.flatMap((item) => item.paths.flat()),
  );
  const recordLink = (node: (typeof refs)[number]) =>
    isBrowserRoutedEntity(node.entityKind) ? (
      <EntityRefLink
        entity={node.entityKind}
        id={node.entityId}
        name={node.label}
        emoji={null}
      />
    ) : (
      <span>{node.label}</span>
    );
  return (
    <EntityDisplayImagesProvider refs={refs}>
      <Section
        title="Connected context"
        headingAs="h2"
        compact
        aria-label="Connection context"
        actions={
          showOpenLink ? (
            <Link
              to="/connections"
              search={{ source: entity, id }}
              className="text-xs text-link hover:underline"
            >
              Open connections
            </Link>
          ) : null
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {views.map((view) => (
            <div key={view.viewKey} className="min-w-0 text-xs">
              <div className="mb-1 text-muted-foreground">
                {view.title} · {view.totalCount}
              </div>
              <div className="flex flex-wrap gap-1">
                {view.items.map((item) => (
                  <span key={item.target.entityId}>
                    {recordLink(item.target)}
                  </span>
                ))}
              </div>
              <Disclosure className="mt-2" summary="Show connection paths">
                <ol className="mt-2 space-y-2">
                  {view.items.map((item) => (
                    <li key={item.target.entityId}>
                      {item.paths.map((path) => (
                        <div
                          key={path
                            .map(
                              (node) => `${node.entityKind}:${node.entityId}`,
                            )
                            .join("/")}
                          className="flex flex-wrap items-center gap-1 py-1"
                        >
                          {path.map((node, index) => (
                            <span
                              key={`${node.entityKind}:${node.entityId}`}
                              className="inline-flex min-w-0 items-center gap-1"
                            >
                              {index ? (
                                <span
                                  aria-hidden
                                  className="text-muted-foreground"
                                >
                                  →
                                </span>
                              ) : null}
                              {recordLink(node)}
                            </span>
                          ))}
                        </div>
                      ))}
                    </li>
                  ))}
                </ol>
                <Link
                  to="/connections"
                  search={{
                    source: entity,
                    id,
                    view: view.viewKey,
                    mode: "records",
                  }}
                  className="mt-2 inline-block text-link hover:underline"
                >
                  All {view.title.toLowerCase()}
                </Link>
              </Disclosure>
            </div>
          ))}
        </div>
      </Section>
    </EntityDisplayImagesProvider>
  );
}
