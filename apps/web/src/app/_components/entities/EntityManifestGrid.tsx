import type { Entity } from "@cubby/schemas/entity";
import {
  allEntities,
  type EntityDescriptor,
  entityManifest,
  entityReferences,
} from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Stack } from "~/components/layout";
import { stickyRowHeaderPage } from "~/components/matrix/matrix-chrome";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  browserEntityDefinition,
  entities,
  getSortableFields,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { getEntityContract } from "~/entities/entity-contracts";
import { viewsForEntity } from "~/entities/view-manifest";
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { EntityReferenceGraph } from "./EntityReferenceGraph";

/** Inverse reference edges: who points AT `target`. */
function referencesInto(target: Entity): Entity[] {
  return allEntities.filter((e) => entityReferences(e).includes(target));
}

function Bool({ value }: { value: boolean }) {
  return value ? (
    <Check className="size-4 text-positive" aria-label="yes" />
  ) : (
    <Minus className="size-4 text-muted-foreground/40" aria-label="no" />
  );
}

function Chips({ items }: { items: readonly string[] }) {
  if (items.length === 0)
    return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="font-mono text-2xs">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export function SavedViewChips({ entity }: { entity: Entity }) {
  const views = viewsForEntity(entity);
  if (views.length === 0)
    return <span className="text-muted-foreground/40">—</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {views.map((view) => (
        <Badge
          key={view.id}
          variant="outline"
          className="font-sans normal-case tracking-normal"
        >
          {view.problem && (
            <AlertTriangle className="text-warning" aria-hidden="true" />
          )}
          {view.label}
          {view.problem && (
            <span className="sr-only">Also appears on the Problems page.</span>
          )}
        </Badge>
      ))}
    </div>
  );
}

const mono = "font-mono text-xs tabular-nums";
const dash = <span className="text-muted-foreground/40">—</span>;

/** One settings row: a label + a render fn per entity. */
type Row = {
  label: string;
  cell: (ctx: {
    entity: Entity;
    d: EntityDescriptor;
    count: number | undefined;
  }) => ReactNode;
};

type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Live",
    rows: [
      {
        label: "Row count",
        cell: ({ count }) =>
          count === undefined ? dash : <span className={mono}>{count}</span>,
      },
    ],
  },
  {
    title: "Storage",
    rows: [
      {
        label: "DB table",
        cell: ({ d }) =>
          d.dbTable ? <span className={mono}>{d.dbTable}</span> : dash,
      },
      {
        label: "ID brand",
        cell: ({ d }) =>
          d.idBrand ? <span className={mono}>{d.idBrand}</span> : dash,
      },
      {
        label: "Shortcode",
        cell: ({ d }) =>
          d.shortcodePrefix ? (
            <span className={mono}>{d.shortcodePrefix}…</span>
          ) : (
            dash
          ),
      },
      { label: "Soft delete", cell: ({ d }) => <Bool value={d.softDelete} /> },
      { label: "Auditable", cell: ({ d }) => <Bool value={d.auditable} /> },
    ],
  },
  {
    title: "Schema & UI",
    rows: [
      {
        label: "Default sort",
        cell: ({ entity }) => {
          if (!isBrowserRoutedEntity(entity)) return dash;
          const sort = browserEntityDefinition(entity).list?.defaultSort;
          return sort ? <span className={mono}>{sort}</span> : dash;
        },
      },
      {
        label: "Sortable fields",
        cell: ({ entity }) =>
          isBrowserRoutedEntity(entity) ? (
            <Chips items={getSortableFields(entity)} />
          ) : (
            dash
          ),
      },
      {
        label: "Standard columns",
        cell: ({ entity }) =>
          isBrowserRoutedEntity(entity) ? (
            <Chips
              items={
                browserEntityDefinition(entity).list?.standardColumns ?? []
              }
            />
          ) : (
            dash
          ),
      },
      {
        label: "Saved views",
        cell: ({ entity }) => <SavedViewChips entity={entity} />,
      },
      {
        label: "Common sections",
        cell: ({ entity }) =>
          isBrowserRoutedEntity(entity) ? (
            <Chips
              items={
                browserEntityDefinition(entity).detail?.commonSections ?? []
              }
            />
          ) : (
            dash
          ),
      },
      { label: "Has images", cell: ({ d }) => <Bool value={d.hasImages} /> },
      {
        label: "Can preview",
        cell: ({ entity }) =>
          isBrowserRoutedEntity(entity) ? (
            <Bool value={getEntityContract(entity).canPreview} />
          ) : (
            <Bool value={false} />
          ),
      },
    ],
  },
  {
    title: "API",
    rows: [
      { label: "MCP tools", cell: ({ d }) => <Chips items={d.mcp} /> },
      {
        label: "Invalidation keys",
        cell: ({ entity }) => (
          <span className={mono}>
            {isBrowserRoutedEntity(entity)
              ? getEntityContract(entity).invalidationKeys.length
              : "—"}
          </span>
        ),
      },
    ],
  },
  {
    title: "Relationships",
    rows: [
      {
        label: "References →",
        cell: ({ entity }) => <Chips items={entityReferences(entity)} />,
      },
      {
        label: "← Referenced by",
        cell: ({ entity }) => <Chips items={referencesInto(entity)} />,
      },
    ],
  },
  {
    title: "Lifecycle",
    rows: [
      {
        label: "Delete",
        cell: ({ d }) =>
          d.lifecycle.delete ? (
            <span className={mono}>
              {d.lifecycle.delete.mode}
              {d.lifecycle.delete.bulk ? " · bulk" : " · single"}
            </span>
          ) : (
            dash
          ),
      },
      {
        label: "Mergeable",
        cell: ({ d }) => <Bool value={d.lifecycle.merge} />,
      },
    ],
  },
];

function EntityHeader({ entity }: { entity: Entity }) {
  if (!isBrowserRoutedEntity(entity)) {
    return <span className="font-mono text-2xs">{entity}</span>;
  }
  const def = entities[entity];
  const Icon = def.lucideIcon;
  return (
    <Link
      to={def.routes.list}
      className="flex flex-col items-start gap-1 hover:underline"
    >
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded",
          def.color.bg,
          def.color.text,
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="font-mono text-2xs">{entity}</span>
    </Link>
  );
}

export function EntityManifestGrid() {
  const api = useTRPC();
  const session = authClient.useSession();
  const isAuthenticated = !!session.data?.user;
  const { data: counts } = useQuery({
    ...api.dashboard.counts.queryOptions(),
    enabled: isAuthenticated,
  });

  const countOf = (entity: Entity): number | undefined => {
    if (!counts) return undefined;
    // usda-food is the only key mismatch (counts.usdaFoods); every other
    // countable entity is keyed by its own name.
    if (entity === "usda-food") return counts.usdaFoods;
    return entityManifest[entity].countable
      ? counts[entity as keyof typeof counts]
      : undefined;
  };

  return (
    <Stack gap="lg">
      <Table containerClassName="overflow-x-auto" className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead className={cn(stickyRowHeaderPage, "text-left")}>
              setting
            </TableHead>
            {allEntities.map((entity) => (
              <TableHead key={entity} className="px-2">
                <EntityHeader entity={entity} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {GROUPS.flatMap((group) => [
            <TableRow key={`${group.title}-h`} className="bg-muted/40">
              <TableCell
                colSpan={allEntities.length + 1}
                className="sticky left-0 font-mono text-2xs text-muted-foreground uppercase tracking-wider"
              >
                {group.title}
              </TableCell>
            </TableRow>,
            ...group.rows.map((row) => (
              <TableRow key={`${group.title}-${row.label}`}>
                <TableCell
                  className={cn(
                    stickyRowHeaderPage,
                    "whitespace-nowrap font-medium text-xs",
                  )}
                >
                  {row.label}
                </TableCell>
                {allEntities.map((entity) => (
                  <TableCell key={entity} className="px-2 align-top">
                    {row.cell({
                      entity,
                      d: entityManifest[entity],
                      count: countOf(entity),
                    })}
                  </TableCell>
                ))}
              </TableRow>
            )),
          ])}
        </TableBody>
      </Table>

      <Stack gap="sm">
        <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          Reference graph
        </h2>
        <EntityReferenceGraph />
      </Stack>
    </Stack>
  );
}
