import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityConnectionGroup } from "@cubby/schemas/entity-connections";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import {
  entities,
  EntityIcon,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityGraph } from "~/entities/entity-graph.functions";

/**
 * One-hop physical connections (the runtime edge source, ADR 0006)
 * for a single record — distinct from the derived manifest relationships the
 * Relations tab and /graph explorer show elsewhere. Shared by both surfaces
 * so they read the `connections` query the same way.
 */
export function PhysicalConnectionsPanel({
  subject,
  operations,
}: {
  subject: EntityRef;
  operations?: { connections?: typeof entityGraph.connections };
}) {
  const connectionsOp = operations?.connections ?? entityGraph.connections;
  const query = useQuery(connectionsOp.queryOptions({ id: subject.entityId }));
  if (query.isPending)
    return (
      <output className="text-xs text-muted-foreground">
        Loading physical connections…
      </output>
    );
  if (query.isError)
    return (
      <ErrorDisplay
        error={query.error}
        title="physical connections"
        onRetry={() => void query.refetch()}
      />
    );
  const groups = query.data.groups;
  if (groups.length === 0) return null;
  const incoming = groups.filter((group) => group.direction === "incoming");
  const outgoing = groups.filter((group) => group.direction === "outgoing");
  return (
    <Stack gap="sm" aria-label="Physical connections">
      <h3 className="text-sm font-semibold">Physical connections</h3>
      <ConnectionDirectionList title="Points here" groups={incoming} />
      <ConnectionDirectionList title="Points to" groups={outgoing} />
    </Stack>
  );
}

function ConnectionDirectionList({
  title,
  groups,
}: {
  title: string;
  groups: EntityConnectionGroup[];
}) {
  if (groups.length === 0) return null;
  return (
    <Stack gap="xs">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {groups.map((group) => (
        <section key={group.edgeKey} className="border-b border-border pb-2">
          <Row gap="sm" align="center">
            <h4 className="text-sm font-medium">{group.label}</h4>
            <span className="text-xs text-muted-foreground tabular-nums">
              {group.count}
            </span>
          </Row>
          <ul className="mt-1 divide-y divide-border">
            {group.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="py-1">
                <Row gap="sm" align="center">
                  <EntityIcon entity={item.kind} colored className="size-3.5" />
                  <ConnectionItemLink
                    kind={item.kind}
                    id={item.id}
                    name={item.name}
                  />
                </Row>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Stack>
  );
}

function ConnectionItemLink({
  kind,
  id,
  name,
}: {
  kind: EntityConnectionGroup["items"][number]["kind"];
  id: string;
  name: string | null;
}) {
  const router = useRouter();
  const label = name ?? id;
  const href =
    isBrowserRoutedEntity(kind) && kind !== "usda-food"
      ? router.buildLocation({
          to: entities[kind].routes.detail,
          params: entityDetailParams(id),
        }).href
      : undefined;
  return href ? (
    <a
      href={href}
      title={label}
      className="min-w-0 flex-1 truncate text-sm text-primary hover:underline"
    >
      {label}
    </a>
  ) : (
    <span title={label} className="min-w-0 flex-1 truncate text-sm">
      {label}
    </span>
  );
}
